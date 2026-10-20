from __future__ import annotations

import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Receive, Scope, Send

from .config import settings
from .core import get_trace_id, iso, set_trace_id
from .errors import ApiError, unavailable
from .logging_config import configure_logging
from .audit import append_audit
from .routers import agent as agent_router
from .routers import auth as auth_router
from .routers import console as console_router
from .routers import operations as operations_router
from .routers import reports as reports_router
from .security import client_ip
from .store import StoreUnavailable, store

configure_logging(settings.log_level)
log = logging.getLogger("neighbor.api")


@asynccontextmanager
async def lifespan(application: FastAPI):
    if settings.env_name != "demo" and settings.is_default_secret:
        log.warning("production mode is using the default JWT secret")
    storage = store.health()
    log.info(
        "application started",
        extra={"status": "ok", "actor_id": "system"},
    )
    log.info("storage backend: %s writable=%s", storage["backend"], storage["writable"])
    yield
    log.info("application stopped")


app = FastAPI(
    title="邻里充电运营平台 API",
    description="社区充电设备、预约订单、维修工单、审批与 Agent 工作台。",
    version=settings.app_version,
    lifespan=lifespan,
    docs_url="/docs" if settings.demo_mode else None,
    redoc_url=None,
)


# ---------------------------------------------------------------- middleware
class PathRewriteMiddleware:
    """Normalise paths when the ASGI app runs inside a Netlify Function."""

    PREFIXES = ("/.netlify/functions/api", "/.netlify/functions/neighbor-charge")

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            path = scope.get("path", "/")
            original = path
            for prefix in self.PREFIXES:
                if path == prefix or path.startswith(prefix + "/"):
                    path = path[len(prefix):] or "/"
                    break
            if settings.serverless and not path.startswith("/api") and path not in {
                "/", "/openapi.json", "/docs", "/favicon.ico", "/favicon.svg",
            } and not path.startswith("/assets"):
                if not path.startswith("/.netlify"):
                    path = "/api" + path
            if path != original:
                scope = dict(scope)
                scope["path"] = path
                scope["raw_path"] = path.encode("utf-8")
        await self.app(scope, receive, send)


app.add_middleware(PathRewriteMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins or ["*"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "Idempotency-Key", "X-Device-Key", "X-Trace-Id"],
    expose_headers=["X-Trace-Id", "X-Response-Time"],
)


@app.middleware("http")
async def observability(request: Request, call_next):
    trace_id = request.headers.get("x-trace-id") or uuid.uuid4().hex
    set_trace_id(trace_id)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        duration = round((time.perf_counter() - started) * 1000, 1)
        log.exception(
            "unhandled request failure",
            extra={"method": request.method, "path": request.url.path, "duration_ms": duration, "status": 500},
        )
        raise
    duration = round((time.perf_counter() - started) * 1000, 1)
    response.headers["X-Trace-Id"] = trace_id
    response.headers["X-Response-Time"] = f"{duration}ms"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    if response.headers.get("content-type", "").startswith("text/html"):
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'"
        )
    if request.url.path.startswith("/api"):
        log.info(
            "request completed",
            extra={
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration,
                "actor_id": getattr(getattr(request, "state", None), "identity", {}).get("id", "anonymous")
                if getattr(request.state, "identity", None) else "anonymous",
            },
        )
    return response


# ----------------------------------------------------------- error handling
def _error_body(code: str, message: str, status_code: int, **extra) -> dict:
    body = {"detail": {"code": code, "message": message, "trace_id": get_trace_id()}}
    if extra:
        body["detail"].update(extra)
    return body


def _audit_denial(request: Request, status_code: int, message: str) -> None:
    if status_code != 403:
        return
    identity = getattr(request.state, "identity", None)
    try:
        with store.tx() as data:
            append_audit(
                data,
                action="permission_denied",
                actor=identity,
                actor_id=None if identity else "anonymous",
                actor_name=None if identity else "匿名访问",
                actor_role=None if identity else "anonymous",
                target_type="endpoint",
                target_id=f"{request.method} {request.url.path}",
                detail=message,
                ip=client_ip(request),
                tenant_id=identity.get("tenant_id") if identity else None,
            )
    except Exception:
        log.exception("failed to write permission audit entry")


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    message = exc.detail.get("message", "") if isinstance(exc.detail, dict) else str(exc.detail)
    _audit_denial(request, exc.status_code, message)
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail}, headers=exc.headers)


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException):
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        body = {"detail": detail}
    else:
        code = {
            401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND",
            405: "METHOD_NOT_ALLOWED", 409: "CONFLICT", 429: "RATE_LIMITED",
        }.get(exc.status_code, "HTTP_ERROR")
        body = {"detail": {"code": code, "message": str(detail), "trace_id": get_trace_id()}}
    _audit_denial(request, exc.status_code, str(detail))
    return JSONResponse(status_code=exc.status_code, content=body, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    fields = []
    for error in exc.errors():
        fields.append({
            "field": ".".join(str(part) for part in error.get("loc", []) if part != "body"),
            "message": error.get("msg", "参数不合法"),
            "type": error.get("type", "value_error"),
        })
    log.info("request validation failed", extra={"method": request.method, "path": request.url.path, "status": 422, "error_code": "VALIDATION_ERROR"})
    return JSONResponse(
        status_code=422,
        content={"detail": {"code": "VALIDATION_ERROR", "message": "请求参数校验失败", "fields": fields, "trace_id": get_trace_id()}},
    )


@app.exception_handler(StoreUnavailable)
async def store_error_handler(request: Request, exc: StoreUnavailable):
    log.error("storage failure", extra={"method": request.method, "path": request.url.path, "status": 503, "error_code": "STORE_UNAVAILABLE"})
    error = unavailable()
    return JSONResponse(status_code=503, content={"detail": error.detail})


@app.exception_handler(Exception)
async def unhandled_error_handler(request: Request, exc: Exception):
    log.exception("unhandled server error", extra={"method": request.method, "path": request.url.path, "status": 500})
    return JSONResponse(
        status_code=500,
        content={"detail": {"code": "INTERNAL_ERROR", "message": "服务内部错误，请稍后重试", "trace_id": get_trace_id()}},
    )


# -------------------------------------------------------------------- routes
app.include_router(auth_router.router)
app.include_router(console_router.router)
app.include_router(operations_router.router)
app.include_router(reports_router.router)
app.include_router(agent_router.router)


# -------------------------------------------------------------------- static
STATIC = Path(settings.static_dir)
ASSETS = STATIC / "assets"
if ASSETS.is_dir():
    app.mount("/assets", StaticFiles(directory=ASSETS), name="assets")


@app.get("/", include_in_schema=False)
def index():
    target = STATIC / "index.html"
    if target.is_file():
        return FileResponse(target, headers={"Cache-Control": "no-cache"})
    return JSONResponse({
        "service": "neighbor-charge-agent",
        "version": settings.app_version,
        "message": "前端静态资源未随函数打包，请通过站点根路径访问工作台。",
    })


@app.get("/favicon.ico", include_in_schema=False)
@app.get("/favicon.svg", include_in_schema=False)
def favicon():
    target = ASSETS / "favicon.svg"
    if target.is_file():
        return FileResponse(target, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/api/version", include_in_schema=False)
def version():
    return {"version": settings.app_version, "mode": "demo" if settings.demo_mode else "production", "time": iso()}
