from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from ..config import settings
from ..core import get_trace_id, iso, now
from ..errors import forbidden
from ..schemas import CommunityCreate, PileCreate, UserCreate, UserStatusUpdate
from ..security import can_manage, current_user, is_admin, require_roles
from ..services import (
    create_community,
    create_pile,
    create_user,
    get_pile,
    list_assignees,
    list_audit,
    list_communities,
    list_events,
    list_piles,
    list_users,
    update_user_status,
)
from ..store import store

router = APIRouter(prefix="/api", tags=["console"])
STARTED_AT = time.time()

ROLE_LABELS = {
    "admin": "系统管理员",
    "operator": "运营人员",
    "repairer": "维修人员",
    "finance": "财务审批",
    "user": "居民用户",
}
PILE_STATUS_LABELS = {
    "available": "可用",
    "charging": "充电中",
    "reserved": "已预约",
    "fault": "故障",
    "offline": "离线",
    "maintenance": "维护中",
}
TICKET_STATUS_LABELS = {
    "open": "待处理",
    "assigned": "已分派",
    "processing": "处理中",
    "pending_acceptance": "待验收",
    "closed": "已关闭",
}
ORDER_STATUS_LABELS = {
    "reserved": "已预约",
    "charging": "充电中",
    "completed": "已完成",
    "cancelled": "已取消",
    "refunded": "已退款",
    "pending_payment": "待支付",
    "exception": "异常",
}


@router.get("/health", tags=["system"])
def health():
    storage = store.health()
    healthy = bool(storage["writable"]) or not settings.persist
    body = {
        "status": "ok" if healthy else "degraded",
        "service": "neighbor-charge-agent",
        "version": settings.app_version,
        "mode": "demo" if settings.demo_mode else "production",
        "uptime_seconds": int(time.time() - STARTED_AT),
        "checks": {
            "api": {"status": "ok"},
            "storage": {
                "status": "ok" if storage["writable"] else "error",
                "backend": storage["backend"],
                "writable": storage["writable"],
                "last_saved_at": storage["last_saved_at"],
                "last_error": storage["last_error"],
            },
        },
        "records": storage["records"],
        "generated_at": iso(),
        "trace_id": get_trace_id(),
    }
    if not healthy:
        body["error_code"] = "STORE_UNAVAILABLE"
        return JSONResponse(status_code=503, content=body)
    return body


@router.get("/meta", tags=["system"])
def meta():
    return {
        "app": {
            "name": settings.app_name,
            "version": settings.app_version,
            "mode": "demo" if settings.demo_mode else "production",
            "serverless": settings.serverless,
        },
        "labels": {
            "roles": ROLE_LABELS,
            "pile_status": PILE_STATUS_LABELS,
            "ticket_status": TICKET_STATUS_LABELS,
            "order_status": ORDER_STATUS_LABELS,
        },
        "limits": {
            "max_reservation_hours": settings.max_reservation_hours,
            "heartbeat_fresh_minutes": settings.heartbeat_fresh_minutes,
        },
        "server_time": iso(),
    }


@router.get("/users")
def users(
    role: str | None = Query(default=None, max_length=20),
    search: str = Query(default="", max_length=60),
    user: dict = Depends(current_user),
):
    return list_users(user, role=role, search=search)


@router.post("/users", status_code=201)
def add_user(req: UserCreate, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return create_user(user, req, client_ip(request))


@router.patch("/users/{user_id}/status")
def change_user_status(user_id: str, req: UserStatusUpdate, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return update_user_status(user, user_id, req.status, client_ip(request))


@router.get("/assignees")
def assignees(user: dict = Depends(current_user)):
    if not (is_admin(user) or can_manage(user)):
        raise forbidden("只有运营人员可以查看维修人员列表")
    return list_assignees(user)


@router.get("/communities")
def communities(user: dict = Depends(current_user)):
    return list_communities(user)


@router.post("/communities", status_code=201)
def add_community(req: CommunityCreate, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return create_community(user, req, client_ip(request))


@router.get("/piles")
def piles(
    status: str | None = Query(default=None, max_length=20),
    community_id: str | None = Query(default=None, max_length=36),
    search: str = Query(default="", max_length=60),
    user: dict = Depends(current_user),
):
    return list_piles(user, status=status, community_id=community_id, search=search)


@router.get("/piles/{pile_id}")
def pile_detail(pile_id: str, user: dict = Depends(current_user)):
    return get_pile(user, pile_id)


@router.post("/piles", status_code=201)
def add_pile(req: PileCreate, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return create_pile(user, req, client_ip(request))


@router.get("/events")
def events(
    limit: int = Query(default=50, ge=1, le=200),
    user: dict = Depends(require_roles("admin", "operator", "repairer")),
):
    return list_events(user, limit=limit)


@router.get("/audit")
def audit(
    limit: int = Query(default=100, ge=1, le=300),
    action: str | None = Query(default=None, max_length=60),
    search: str = Query(default="", max_length=80),
    user: dict = Depends(require_roles("admin", "operator")),
):
    return list_audit(user, limit=limit, action=action, search=search)
