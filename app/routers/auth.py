from __future__ import annotations

import time

from fastapi import APIRouter, Depends, Request

from ..audit import append_audit
from ..config import settings
from ..core import get_trace_id, iso, now
from ..errors import unauthorized
from ..passwords import verify_password
from ..schemas import LoginRequest
from ..security import (
    check_login_rate,
    clear_login_failures,
    client_ip,
    current_user,
    issue_token,
    login_key,
    public_user,
    record_login_failure,
    revoke_token,
)
from ..store import store

router = APIRouter(prefix="/api/auth", tags=["auth"])

DEMO_USERNAMES = ["admin", "operator", "repairer", "finance", "user"]
ROLE_LABELS = {
    "admin": "系统管理员",
    "operator": "运营人员",
    "repairer": "维修人员",
    "finance": "财务审批",
    "user": "居民用户",
}


@router.post("/login")
def login(req: LoginRequest, request: Request):
    ip = client_ip(request)
    key = login_key(req.username, ip)
    check_login_rate(key)
    with store.lock_read() as data:
        user = next(
            (
                record for record in data["users"].values()
                if record["username"].lower() == req.username.strip().lower()
                and record.get("status") == "active"
            ),
            None,
        )
    if not user or not verify_password(req.password, user.get("password_hash")):
        record_login_failure(key)
        if user:
            with store.tx() as data:
                append_audit(
                    data, action="login_failed", actor_id=user["id"], actor_name=user["display_name"],
                    actor_role=user["role"], target_type="auth", target_id=user["id"],
                    detail="用户名或密码错误", ip=ip, tenant_id=user["tenant_id"],
                )
        raise unauthorized("用户名或密码错误", "INVALID_CREDENTIALS")
    clear_login_failures(key)
    token, ttl, jti = issue_token(user)
    user_payload = public_user(user)
    user_payload["token_exp"] = int(time.time()) + ttl
    with store.tx() as data:
        record = data["users"].get(user["id"])
        if record:
            record["last_login_at"] = iso()
        data["meta"]["login_count"] = data["meta"].get("login_count", 0) + 1
        append_audit(
            data, action="login", actor={"id": user["id"], "display_name": user["display_name"], "role": user["role"], "tenant_id": user["tenant_id"]},
            target_type="auth", target_id=user["id"], detail="登录运营平台", ip=ip,
        )
    return {
        "access_token": token,
        "token_type": "bearer",
        "expires_in": ttl,
        "expires_at": int(time.time()) + ttl,
        "user": user_payload,
        "trace_id": get_trace_id(),
    }


@router.get("/me")
def me(user: dict = Depends(current_user)):
    return {"user": user, "trace_id": get_trace_id()}


@router.post("/refresh")
def refresh(user: dict = Depends(current_user)):
    record = {"id": user["id"], "tenant_id": user["tenant_id"], "role": user["role"], "display_name": user["display_name"]}
    token, ttl, _ = issue_token(record)
    revoke_token(user.get("jti"), user.get("token_exp"))
    return {"access_token": token, "token_type": "bearer", "expires_in": ttl, "trace_id": get_trace_id()}


@router.post("/logout")
def logout(user: dict = Depends(current_user)):
    revoke_token(user.get("jti"), user.get("token_exp"))
    with store.tx() as data:
        append_audit(data, action="logout", actor=user, target_type="auth", target_id=user["id"], detail="退出登录")
    return {"ok": True, "trace_id": get_trace_id()}


@router.get("/demo-accounts")
def demo_accounts():
    if not settings.demo_mode:
        return {"password": "", "items": [], "notice": "生产环境不提供演示账号列表。"}
    with store.lock_read() as data:
        items = []
        for username in DEMO_USERNAMES:
            record = next(
                (
                    item for item in data["users"].values()
                    if item["username"] == username and item["tenant_id"] == "T001"
                ),
                None,
            )
            if record:
                items.append({
                    "username": record["username"],
                    "display_name": record["display_name"],
                    "role": record["role"],
                    "role_label": ROLE_LABELS.get(record["role"], record["role"]),
                })
    return {
        "password": settings.demo_password,
        "items": items,
        "notice": "演示环境账号，仅用于本地与预览部署。",
    }
