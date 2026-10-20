"""Authentication, signed tokens, role checks and data-scope helpers."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
import uuid
from typing import Any

from fastapi import Depends, Header, Request

from .config import settings
from .core import iso, mask_phone, now
from .errors import forbidden, too_many, unauthorized
from .store import store

_ALLOWED_ROLES = {"admin", "operator", "repairer", "finance", "user"}
_STAFF_ROLES = {"admin", "operator", "repairer"}
_MANAGEMENT_ROLES = {"admin", "operator"}
_REVOKED: dict[str, int] = {}
_REVOKE_LOCK = threading.Lock()
_ATTEMPTS: dict[str, list[float]] = {}
_ATTEMPT_LOCK = threading.Lock()


# --------------------------------------------------------------------- token
def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _b64decode(raw: str) -> bytes:
    return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))


def _sign(payload_segment: str) -> str:
    return hmac.new(settings.jwt_secret.encode("utf-8"), payload_segment.encode("ascii"), hashlib.sha256).hexdigest()


def issue_token(user: dict, *, ttl_seconds: int | None = None) -> tuple[str, int, str]:
    ttl = ttl_seconds or settings.token_ttl_seconds
    jti = uuid.uuid4().hex
    payload = {
        "sub": user["id"],
        "tenant_id": user["tenant_id"],
        "role": user["role"],
        "name": user["display_name"],
        "jti": jti,
        "iat": int(time.time()),
        "exp": int(time.time()) + ttl,
    }
    header = _b64encode(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    body = _b64encode(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    segment = f"{header}.{body}"
    return f"{segment}.{_sign(segment)}", ttl, jti


def decode_token(token: str) -> dict:
    try:
        header, body, signature = token.split(".")
        segment = f"{header}.{body}"
        if not hmac.compare_digest(signature, _sign(segment)):
            raise ValueError("signature")
        payload = json.loads(_b64decode(body))
        if not isinstance(payload, dict) or "sub" not in payload or "exp" not in payload:
            raise ValueError("payload")
        if int(payload["exp"]) < int(time.time()):
            raise ValueError("expired")
        with _REVOKE_LOCK:
            if payload.get("jti") in _REVOKED:
                raise ValueError("revoked")
        return payload
    except (ValueError, TypeError, KeyError, json.JSONDecodeError):
        raise unauthorized("登录已失效，请重新登录", "TOKEN_INVALID")


def revoke_token(jti: str | None, exp: int | None) -> None:
    if not jti:
        return
    with _REVOKE_LOCK:
        _REVOKED[jti] = int(exp or (time.time() + 60))
        expired = [key for key, deadline in _REVOKED.items() if deadline < time.time()]
        for key in expired:
            _REVOKED.pop(key, None)


# --------------------------------------------------------------------- users
def public_user(user: dict) -> dict:
    return {
        "id": user["id"],
        "tenant_id": user["tenant_id"],
        "username": user["username"],
        "display_name": user["display_name"],
        "role": user["role"],
        "community_ids": list(user.get("community_ids", [])),
        "phone": mask_phone(user.get("phone", "")),
        "email": user.get("email", ""),
        "status": user.get("status", "active"),
        "created_at": user.get("created_at"),
        "last_login_at": user.get("last_login_at"),
    }


def identity_from_token(payload: dict) -> dict:
    user_id = payload.get("sub", "")
    with store.lock_read() as data:
        user = data["users"].get(user_id)
        if not user:
            raise unauthorized("账号不存在或已被删除", "USER_NOT_FOUND")
        if user.get("status") != "active":
            raise unauthorized("账号已被停用，请联系管理员", "USER_DISABLED")
        identity = public_user(user)
    identity["jti"] = payload.get("jti")
    identity["token_exp"] = payload.get("exp")
    return identity


def current_user(
    request: Request,
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> dict:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise unauthorized()
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_token(token)
    identity = identity_from_token(payload)
    request.state.identity = identity
    return identity


def require_roles(*roles: str):
    allowed = set(roles)

    def dependency(user: dict = Depends(current_user)) -> dict:
        if user.get("role") not in allowed:
            raise forbidden("当前角色无权执行该操作")
        return user

    return dependency


# --------------------------------------------------------------- rate limit
def client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()[:64]
    if request.client:
        return request.client.host
    return "unknown"


def login_key(username: str, ip: str) -> str:
    return f"{username.strip().lower()}|{ip}"


def check_login_rate(key: str) -> None:
    window = settings.login_window_seconds
    cutoff = time.time() - window
    with _ATTEMPT_LOCK:
        attempts = [value for value in _ATTEMPTS.get(key, []) if value > cutoff]
        _ATTEMPTS[key] = attempts
        if len(attempts) >= settings.login_max_attempts:
            retry = max(1, int(window - (time.time() - attempts[0])))
            raise too_many(f"登录尝试过多，请在 {retry} 秒后重试", retry_after=retry)


def record_login_failure(key: str) -> None:
    with _ATTEMPT_LOCK:
        _ATTEMPTS.setdefault(key, []).append(time.time())


def clear_login_failures(key: str) -> None:
    with _ATTEMPT_LOCK:
        _ATTEMPTS.pop(key, None)


# ------------------------------------------------------------------- scopes
def is_admin(user: dict) -> bool:
    return user.get("role") == "admin"


def is_staff(user: dict) -> bool:
    return user.get("role") in _STAFF_ROLES


def can_manage(user: dict) -> bool:
    return user.get("role") in _MANAGEMENT_ROLES


def can_approve(user: dict) -> bool:
    return user.get("role") in {"admin", "finance"}


def scoped_communities(user: dict, data: dict) -> list[str]:
    if is_admin(user) or user.get("role") == "finance":
        return [
            cid for cid, community in data["communities"].items()
            if community.get("tenant_id") == user.get("tenant_id")
        ]
    return list(user.get("community_ids", []))


def ensure_community(user: dict, community_id: str) -> None:
    with store.lock_read() as data:
        community = data["communities"].get(community_id)
        if not community or community.get("tenant_id") != user.get("tenant_id"):
            raise forbidden("无权访问该社区的数据")
        if community_id not in scoped_communities(user, data):
            raise forbidden("该社区不在你的数据授权范围内")


def ensure_tenant_record(user: dict, record: dict, label: str = "资源") -> None:
    if record.get("tenant_id") != user.get("tenant_id"):
        raise forbidden(f"无权访问该{label}")


def ensure_own_or_staff(user: dict, record: dict, owner_field: str = "user_id") -> None:
    if is_staff(user) or user.get("role") == "finance":
        return
    if record.get(owner_field) != user.get("id"):
        raise forbidden("只能访问本人的数据")


def masked_contact(user: dict) -> dict:
    return {
        "display_name": user.get("display_name"),
        "phone": mask_phone(user.get("phone", "")),
        "email": user.get("email", ""),
    }


def issue_login_audit(user: dict, ip: str) -> None:
    with store.tx() as data:
        data["audit"].append({
            "id": f"AU{len(data['audit']) + 1:04d}",
            "tenant_id": user["tenant_id"],
            "trace_id": "",
            "actor_id": user["id"],
            "actor_name": user["display_name"],
            "actor_role": user["role"],
            "action": "login",
            "target_type": "auth",
            "target_id": user["id"],
            "detail": "登录运营平台",
            "ip": ip,
            "at": iso(now()),
        })
