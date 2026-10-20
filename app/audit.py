"""Append-only audit trail helpers.

Audit entries are written inside the same transaction as the business change,
so an operation can never succeed without leaving a receipt.
"""
from __future__ import annotations

import json
from typing import Any

from .core import get_trace_id, iso, now, sanitize_text
from .security import public_user

MAX_AUDIT_ENTRIES = 1200


def _scrub(value: Any) -> Any:
    if isinstance(value, str):
        return sanitize_text(value)
    if isinstance(value, dict):
        return {key: _scrub(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_scrub(item) for item in value[:50]]
    return value


def append_audit(
    data: dict,
    *,
    action: str,
    actor: dict | None = None,
    actor_id: str | None = None,
    actor_name: str | None = None,
    actor_role: str | None = None,
    target_type: str = "",
    target_id: str = "",
    detail: Any = "",
    ip: str = "",
    tenant_id: str | None = None,
) -> dict:
    if actor:
        actor_id = actor.get("id")
        actor_name = actor.get("display_name")
        actor_role = actor.get("role")
        tenant_id = tenant_id or actor.get("tenant_id")
    if isinstance(detail, (dict, list)):
        detail_text = json.dumps(_scrub(detail), ensure_ascii=False, separators=(",", ":"))
    else:
        detail_text = sanitize_text(str(detail))
    entry = {
        "id": f"AU{len(data['audit']) + 1:05d}",
        "tenant_id": tenant_id or "",
        "trace_id": get_trace_id(),
        "actor_id": actor_id or "system",
        "actor_name": actor_name or "系统",
        "actor_role": actor_role or "system",
        "action": action,
        "target_type": target_type,
        "target_id": target_id,
        "detail": detail_text[:2000],
        "ip": ip[:64],
        "at": iso(now()),
    }
    data["audit"].append(entry)
    if len(data["audit"]) > MAX_AUDIT_ENTRIES:
        del data["audit"][: len(data["audit"]) - MAX_AUDIT_ENTRIES]
    return entry


def actor_snapshot(user: dict) -> dict:
    return public_user(user)
