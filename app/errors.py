"""Typed API errors with stable machine-readable codes and trace ids."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException

from .core import get_trace_id


class ApiError(HTTPException):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        fields: list[dict[str, Any]] | None = None,
        headers: dict[str, str] | None = None,
        **extra: Any,
    ) -> None:
        detail: dict[str, Any] = {
            "code": code,
            "message": message,
            "trace_id": get_trace_id(),
        }
        if fields:
            detail["fields"] = fields
        detail.update(extra)
        super().__init__(status_code=status_code, detail=detail, headers=headers)


def bad_request(message: str, code: str = "BAD_REQUEST", **extra: Any) -> ApiError:
    return ApiError(400, code, message, **extra)


def unauthorized(message: str = "请先登录", code: str = "UNAUTHORIZED") -> ApiError:
    return ApiError(401, code, message, headers={"WWW-Authenticate": "Bearer"})


def forbidden(message: str = "当前角色无权执行该操作", code: str = "FORBIDDEN") -> ApiError:
    return ApiError(403, code, message)


def not_found(message: str = "资源不存在", code: str = "NOT_FOUND") -> ApiError:
    return ApiError(404, code, message)


def conflict(message: str, code: str = "CONFLICT", **extra: Any) -> ApiError:
    return ApiError(409, code, message, **extra)


def unprocessable(message: str, code: str = "VALIDATION_ERROR", fields: list[dict[str, Any]] | None = None) -> ApiError:
    return ApiError(422, code, message, fields=fields)


def too_many(message: str = "操作过于频繁，请稍后再试", retry_after: int = 60) -> ApiError:
    return ApiError(429, "RATE_LIMITED", message, headers={"Retry-After": str(retry_after)}, retry_after=retry_after)


def unavailable(message: str = "数据存储暂时不可用，请稍后重试", code: str = "STORE_UNAVAILABLE") -> ApiError:
    return ApiError(503, code, message)
