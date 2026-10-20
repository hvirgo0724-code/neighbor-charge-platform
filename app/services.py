"""Domain services: reservations, orders, tickets, approvals and reports.

Every mutation runs inside ``store.tx()``; every read builds a scoped,
serialisable projection so routers stay thin and the frontend never receives
password hashes or cross-tenant records.
"""
from __future__ import annotations

import math
from datetime import datetime, timedelta
from typing import Any, Iterable

from .audit import append_audit
from .config import settings
from .core import (
    date_key,
    date_range,
    get_trace_id,
    iso,
    minutes_since,
    money,
    now,
    overlaps,
    parse_dt,
    pct,
    sanitize_text,
    sort_desc,
    start_of_day,
)
from .errors import bad_request, conflict, forbidden, not_found, unprocessable
from .schemas import (
    ApprovalCreate,
    ApprovalDecision,
    CommunityCreate,
    DeviceEventIn,
    OrderCancel,
    OrderComplete,
    RefundCreate,
    ReservationCreate,
    TicketAssign,
    TicketCreate,
    TicketResolve,
    TicketTestOrder,
    UserCreate,
)
from .security import (
    can_approve,
    can_manage,
    ensure_community,
    ensure_tenant_record,
    is_admin,
    is_staff,
    scoped_communities,
)
from .store import store

ORDER_ACTIVE = {"reserved", "charging"}
PILE_BLOCKED = {"fault", "offline", "maintenance"}
TICKET_OPEN = {"open", "assigned", "processing", "pending_acceptance"}
LEVEL_HOURS = {"P1": 2, "P2": 8, "P3": 24}


# --------------------------------------------------------------- projections
def public_user(user: dict) -> dict:
    from .security import public_user as _public

    return _public(user)


def community_public(data: dict, community: dict, viewer: dict | None = None) -> dict:
    piles = [p for p in data["piles"].values() if p["community_id"] == community["id"]]
    org = data["orgs"].get(community.get("org_id", ""), {})
    active = [p for p in piles if p["status"] not in PILE_BLOCKED]
    charging = [p for p in piles if p["status"] == "charging"]
    open_tickets = [
        ticket for ticket in data["tickets"].values()
        if ticket["community_id"] == community["id"] and ticket["status"] in TICKET_OPEN
        and (viewer is None or viewer.get("role") != "user" or ticket.get("reporter_id") == viewer.get("id"))
    ]
    return {
        **community,
        "org_name": org.get("name", ""),
        "pile_count": len(piles),
        "available_count": sum(1 for p in piles if p["status"] == "available"),
        "charging_count": len(charging),
        "fault_count": sum(1 for p in piles if p["status"] in {"fault", "offline"}),
        "availability_rate": pct(len(active), len(piles)),
        "total_power": round(sum(float(p["power"]) for p in piles), 1),
        "open_tickets": len(open_tickets),
    }


def pile_public(data: dict, pile: dict) -> dict:
    community = data["communities"].get(pile["community_id"], {})
    active = next(
        (
            order for order in data["orders"].values()
            if order["pile_id"] == pile["id"] and order["status"] in ORDER_ACTIVE
        ),
        None,
    )
    return {
        **pile,
        "community_name": community.get("name", ""),
        "last_seen_minutes": round(minutes_since(pile.get("last_seen")) or 999, 1),
        "available_now": pile["status"] == "available",
        "active_order": (
            {
                "id": active["id"],
                "status": active["status"],
                "user_id": active["user_id"],
                "ends_at": active.get("reserved_end"),
            }
            if active else None
        ),
    }


def order_public(data: dict, order: dict, viewer: dict | None = None) -> dict:
    pile = data["piles"].get(order["pile_id"], {})
    community = data["communities"].get(order["community_id"], {})
    owner = data["users"].get(order["user_id"], {})
    can_operate = bool(viewer and (is_staff(viewer) or viewer["id"] == order["user_id"]))
    remaining = money(float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
    result = {
        **order,
        "pile_code": pile.get("code", ""),
        "pile_power": pile.get("power", 0),
        "community_name": community.get("name", ""),
        "user_name": owner.get("display_name", ""),
        "remaining_refundable": max(0.0, remaining),
        "actions": {
            "start": order["status"] == "reserved" and can_operate,
            "complete": order["status"] == "charging" and can_operate,
            "cancel": order["status"] == "reserved" and can_operate,
            "refund": order["status"] == "completed" and remaining > 0 and can_operate,
        },
    }
    return result


def ticket_verification(data: dict, ticket: dict) -> dict:
    pile = data["piles"].get(ticket["pile_id"], {})
    last_seen = parse_dt(pile.get("last_seen"))
    fresh_minutes = settings.heartbeat_fresh_minutes
    heartbeat_fresh = bool(last_seen and (now() - last_seen).total_seconds() <= fresh_minutes * 60)
    created_at = parse_dt(ticket.get("created_at"))
    test_orders = []
    for order in data["orders"].values():
        if order.get("ticket_id") != ticket["id"] or not order.get("is_test") or order["status"] != "completed":
            continue
        completed_at = parse_dt(order.get("completed_at"))
        if completed_at and (created_at is None or completed_at >= created_at):
            test_orders.append(order)
    test_order = max(test_orders, key=lambda item: item.get("completed_at") or "") if test_orders else None
    reasons: list[str] = []
    if ticket["status"] != "pending_acceptance":
        reasons.append("工单尚未进入待验收状态")
    if not ticket.get("resolution"):
        reasons.append("缺少维修回填说明")
    if not heartbeat_fresh:
        reasons.append(f"设备心跳超过 {fresh_minutes} 分钟未更新")
    if not test_order:
        reasons.append("缺少完整的测试订单")
    return {
        "heartbeat_fresh": heartbeat_fresh,
        "heartbeat_at": iso(last_seen) if last_seen else None,
        "heartbeat_age_minutes": round(minutes_since(last_seen) or 0, 1) if last_seen else None,
        "test_order_id": test_order["id"] if test_order else None,
        "test_order_completed_at": test_order.get("completed_at") if test_order else None,
        "can_close": not reasons,
        "reasons": reasons,
        "policy": {
            "heartbeat_fresh_minutes": fresh_minutes,
            "requires_test_order": True,
            "requires_resolution": True,
        },
    }


def ticket_public(data: dict, ticket: dict) -> dict:
    pile = data["piles"].get(ticket["pile_id"], {})
    community = data["communities"].get(ticket["community_id"], {})
    assignee = data["users"].get(ticket.get("assignee_id") or "", {})
    due = parse_dt(ticket.get("due_at"))
    return {
        **ticket,
        "pile_code": pile.get("code", ""),
        "community_name": community.get("name", ""),
        "assignee_name": assignee.get("display_name") if assignee else None,
        "overdue": bool(due and due < now() and ticket["status"] != "closed"),
        "age_minutes": round(minutes_since(ticket.get("created_at")) or 0, 1),
        "verification": ticket_verification(data, ticket),
    }


def approval_public(data: dict, approval: dict) -> dict:
    requester = data["users"].get(approval.get("requester_id") or "", {})
    return {
        **approval,
        "requester_name": requester.get("display_name", approval.get("requester_name", "")),
        "requester_role": requester.get("role", ""),
    }


def audit_public(entry: dict) -> dict:
    return entry


# -------------------------------------------------------------------- scoping
def _orders_for(user: dict, data: dict, *, include_all_for_staff: bool = True) -> Iterable[dict]:
    communities = set(scoped_communities(user, data))
    for order in data["orders"].values():
        if order.get("tenant_id") != user.get("tenant_id"):
            continue
        if user.get("role") == "user":
            if order["user_id"] != user["id"]:
                continue
        elif order["community_id"] not in communities:
            continue
        yield order


def _piles_for(user: dict, data: dict) -> Iterable[dict]:
    communities = set(scoped_communities(user, data))
    for pile in data["piles"].values():
        if pile.get("tenant_id") != user.get("tenant_id"):
            continue
        if pile["community_id"] in communities:
            yield pile


def _tickets_for(user: dict, data: dict) -> Iterable[dict]:
    communities = set(scoped_communities(user, data))
    for ticket in data["tickets"].values():
        if ticket.get("tenant_id") != user.get("tenant_id"):
            continue
        if user.get("role") == "user":
            if ticket.get("reporter_id") != user["id"]:
                continue
        elif ticket["community_id"] not in communities:
            continue
        yield ticket


def _approvals_for(user: dict, data: dict) -> Iterable[dict]:
    communities = set(scoped_communities(user, data))
    for approval in data["approvals"].values():
        if approval.get("tenant_id") != user.get("tenant_id"):
            continue
        if user.get("role") == "user" and approval.get("requester_id") != user["id"]:
            continue
        if user.get("role") == "operator":
            payload_community = approval.get("payload", {}).get("community_id")
            pile_id = approval.get("payload", {}).get("pile_id")
            order_id = approval.get("payload", {}).get("order_id")
            belongs = approval.get("requester_id") == user["id"]
            if payload_community in communities:
                belongs = True
            if pile_id and data["piles"].get(pile_id, {}).get("community_id") in communities:
                belongs = True
            if order_id and data["orders"].get(order_id, {}).get("community_id") in communities:
                belongs = True
            if not belongs:
                continue
        yield approval


def _get_order(data: dict, order_id: str) -> dict:
    order = data["orders"].get(order_id)
    if not order:
        raise not_found("订单不存在")
    return order


def _get_pile(data: dict, pile_id: str) -> dict:
    pile = data["piles"].get(pile_id)
    if not pile:
        raise not_found("充电桩不存在")
    return pile


def _get_ticket(data: dict, ticket_id: str) -> dict:
    ticket = data["tickets"].get(ticket_id)
    if not ticket:
        raise not_found("工单不存在")
    return ticket


def _get_user(data: dict, user_id: str) -> dict:
    record = data["users"].get(user_id)
    if not record:
        raise not_found("用户不存在")
    return record


def _ensure_pile_scope(user: dict, data: dict, pile: dict) -> None:
    ensure_tenant_record(user, pile, "充电桩")
    if pile["community_id"] not in scoped_communities(user, data):
        raise forbidden("该设备不在你的数据授权范围内")


def _ensure_order_scope(user: dict, data: dict, order: dict) -> None:
    ensure_tenant_record(user, order, "订单")
    if user.get("role") == "user" and order["user_id"] != user["id"]:
        raise forbidden("只能访问本人的订单")
    if user.get("role") not in {"user", "admin", "finance"}:
        if order["community_id"] not in scoped_communities(user, data):
            raise forbidden("该订单不在你的数据授权范围内")


def _ensure_ticket_scope(user: dict, data: dict, ticket: dict) -> None:
    ensure_tenant_record(user, ticket, "工单")
    if user.get("role") == "user":
        if ticket.get("reporter_id") != user["id"]:
            raise forbidden("只能访问本人提交的工单")
    elif ticket["community_id"] not in scoped_communities(user, data):
        raise forbidden("该工单不在你的数据授权范围内")


def _ensure_approval_scope(user: dict, data: dict, approval: dict) -> None:
    ensure_tenant_record(user, approval, "审批")
    if user.get("role") == "user" and approval.get("requester_id") != user["id"]:
        raise forbidden("只能查看本人的申请")
    if not can_approve(user) and user.get("role") != "admin":
        payload = approval.get("payload", {})
        community_id = payload.get("community_id")
        pile_id = payload.get("pile_id")
        order_id = payload.get("order_id")
        communities = set(scoped_communities(user, data))
        if community_id and community_id not in communities:
            raise forbidden("该审批不在你的数据授权范围内")
        if pile_id and data["piles"].get(pile_id, {}).get("community_id") not in communities:
            raise forbidden("该审批不在你的数据授权范围内")
        if order_id and data["orders"].get(order_id, {}).get("community_id") not in communities:
            raise forbidden("该审批不在你的数据授权范围内")


# --------------------------------------------------------------- reservations
def _has_active_reservation(data: dict, pile_id: str, start: datetime, end: datetime, ignore: str = "") -> dict | None:
    for order in data["orders"].values():
        if order["id"] == ignore or order["pile_id"] != pile_id or order["status"] not in ORDER_ACTIVE:
            continue
        if overlaps(start, end, order.get("reserved_start"), order.get("reserved_end")):
            return order
    return None


def expire_stale_reservations() -> None:
    stale = False
    with store.lock_read() as data:
        for order in data["orders"].values():
            if order["status"] == "reserved" and (parse_dt(order.get("reserved_end")) or now()) < now():
                stale = True
                break
    if not stale:
        return
    with store.tx() as data:
        for order in data["orders"].values():
            if order["status"] != "reserved":
                continue
            if (parse_dt(order.get("reserved_end")) or now()) >= now():
                continue
            order["status"] = "cancelled"
            order["cancelled_at"] = iso()
            order["cancel_reason"] = "预约超时未开始，系统自动释放"
            pile = data["piles"].get(order["pile_id"])
            if pile and pile["status"] == "reserved":
                pile["status"] = "available"
            append_audit(
                data, action="reservation_expired", actor_id="system", actor_name="预约引擎",
                actor_role="system", target_type="order", target_id=order["id"],
                detail="预约结束时间已过，自动释放充电桩", tenant_id=order["tenant_id"],
            )


def create_reservation(user: dict, req: ReservationCreate, idempotency_key: str | None, ip: str) -> dict:
    start = req.starts_at.astimezone(now().tzinfo)
    end = req.ends_at.astimezone(now().tzinfo)
    current = now()
    if end <= start:
        raise bad_request("结束时间必须晚于开始时间")
    if start < current - timedelta(minutes=5):
        raise bad_request("不能预约已经过去的时间段")
    if start > current + timedelta(days=7):
        raise bad_request("最多支持提前 7 天预约")
    duration = end - start
    if duration < timedelta(minutes=30):
        raise bad_request("预约时长不能少于 30 分钟")
    if duration > timedelta(hours=settings.max_reservation_hours):
        raise bad_request(f"单次预约不能超过 {settings.max_reservation_hours} 小时")

    with store.tx() as data:
        if idempotency_key:
            existing = next(
                (
                    order for order in data["orders"].values()
                    if order.get("tenant_id") == user.get("tenant_id")
                    and order.get("idempotency_key") == idempotency_key
                ),
                None,
            )
            if existing:
                return order_public(data, existing, user)
        expire_stale_reservations()
        pile = _get_pile(data, req.pile_id)
        _ensure_pile_scope(user, data, pile)
        if pile["status"] in PILE_BLOCKED:
            raise conflict("该充电桩当前不可用，请选择其他设备", "PILE_UNAVAILABLE")
        if pile["status"] == "charging":
            raise conflict("该充电桩正在充电，请选择其他设备", "PILE_CHARGING")
        if pile["status"] == "reserved":
            existing = _has_active_reservation(data, pile["id"], start, end)
            if existing:
                raise conflict("该时段已被预约，请选择其他时间", "RESERVATION_CONFLICT", conflicting_order=existing["id"])
            pile["status"] = "available"

        target_user_id = user["id"]
        if req.user_id and is_staff(user):
            target_user_id = req.user_id
            target = _get_user(data, target_user_id)
            ensure_tenant_record(user, target, "用户")
            if target["role"] != "user":
                raise bad_request("只能为居民用户创建预约")
            if pile["community_id"] not in target.get("community_ids", []):
                raise bad_request("目标用户不属于该社区")
        elif req.user_id and req.user_id != user["id"]:
            raise forbidden("居民用户只能为本人预约")
        if user.get("role") == "user" and pile["community_id"] not in user.get("community_ids", []):
            raise forbidden("只能预约本人所在社区的充电桩")

        conflicting = _has_active_reservation(data, pile["id"], start, end)
        if conflicting:
            data["meta"]["reservation_conflicts"] = data["meta"].get("reservation_conflicts", 0) + 1
            raise conflict("该时段已被预约，请选择其他时间", "RESERVATION_CONFLICT", conflicting_order=conflicting["id"])

        order_id = store.next_id("orders", "O", 4)
        order = {
            "id": order_id,
            "tenant_id": user["tenant_id"],
            "user_id": target_user_id,
            "pile_id": pile["id"],
            "community_id": pile["community_id"],
            "status": "reserved",
            "amount": 0.0,
            "kwh": 0.0,
            "price": pile["price"],
            "created_at": iso(),
            "reserved_start": iso(start),
            "reserved_end": iso(end),
            "started_at": None,
            "completed_at": None,
            "idempotency_key": idempotency_key,
            "is_test": False,
            "ticket_id": None,
            "refund_amount": 0.0,
            "refunded_at": None,
            "cancelled_at": None,
            "cancel_reason": None,
            "trace_id": None,
            "note": sanitize_text(req.note or ""),
        }
        data["orders"][order_id] = order
        pile["status"] = "reserved"
        data["meta"]["reservation_attempts"] = data["meta"].get("reservation_attempts", 0) + 1
        data["meta"]["reservation_success"] = data["meta"].get("reservation_success", 0) + 1
        append_audit(
            data, action="create_reservation", actor=user, target_type="order", target_id=order_id,
            detail=f"{pile['code']} 预约 {iso(start)} 至 {iso(end)}", ip=ip,
        )
        return order_public(data, order, user)


def list_reservations(user: dict) -> dict:
    expire_stale_reservations()
    with store.lock_read() as data:
        items = [
            order_public(data, order, user)
            for order in _orders_for(user, data)
            if order["status"] == "reserved"
        ]
    items = sort_desc(items, "reserved_start")
    return {"items": items, "total": len(items)}


def cancel_reservation(user: dict, order_id: str, reason: str = "用户取消", ip: str = "") -> dict:
    with store.tx() as data:
        order = _get_order(data, order_id)
        _ensure_order_scope(user, data, order)
        if order["status"] != "reserved":
            raise conflict("只有已预约且未开始的订单可以取消", "ORDER_STATE_INVALID")
        order["status"] = "cancelled"
        order["cancelled_at"] = iso()
        order["cancel_reason"] = sanitize_text(reason or "用户取消")
        pile = data["piles"].get(order["pile_id"])
        if pile and pile["status"] == "reserved":
            pile["status"] = "available"
        append_audit(data, action="cancel_reservation", actor=user, target_type="order", target_id=order_id, detail=order["cancel_reason"], ip=ip)
        return order_public(data, order, user)


# --------------------------------------------------------------------- orders
def list_orders(
    user: dict,
    *,
    status: str | None = None,
    community_id: str | None = None,
    search: str = "",
    page: int = 1,
    page_size: int = 20,
) -> dict:
    expire_stale_reservations()
    with store.lock_read() as data:
        items = []
        for order in _orders_for(user, data):
            if status and order["status"] != status:
                continue
            if community_id and order["community_id"] != community_id:
                continue
            if search:
                pile = data["piles"].get(order["pile_id"], {})
                owner = data["users"].get(order["user_id"], {})
                haystack = f"{order['id']} {pile.get('code', '')} {owner.get('display_name', '')}".lower()
                if search.lower() not in haystack:
                    continue
            items.append(order_public(data, order, user))
    items = sort_desc(items, "created_at")
    total = len(items)
    start = max(0, (page - 1) * page_size)
    return {
        "items": items[start:start + page_size],
        "total": total,
        "page": page,
        "page_size": page_size,
        "pages": max(1, math.ceil(total / page_size)),
    }


def get_order(user: dict, order_id: str) -> dict:
    with store.lock_read() as data:
        order = _get_order(data, order_id)
        _ensure_order_scope(user, data, order)
        return order_public(data, order, user)


def start_order(user: dict, order_id: str, ip: str = "") -> dict:
    with store.tx() as data:
        order = _get_order(data, order_id)
        _ensure_order_scope(user, data, order)
        if order["status"] != "reserved":
            raise conflict("订单当前状态不能开始充电", "ORDER_STATE_INVALID")
        start = parse_dt(order.get("reserved_start"))
        end = parse_dt(order.get("reserved_end"))
        current = now()
        if start and current < start - timedelta(minutes=15):
            raise conflict("还未到预约开始时间，请稍后再试", "TOO_EARLY")
        if end and current > end + timedelta(minutes=10):
            raise conflict("预约已过期，请重新预约", "RESERVATION_EXPIRED")
        pile = _get_pile(data, order["pile_id"])
        if pile["status"] in PILE_BLOCKED:
            raise conflict("充电桩故障或离线，无法开始充电", "PILE_UNAVAILABLE")
        if pile["status"] == "charging":
            raise conflict("充电桩已被其他会话占用", "PILE_BUSY")
        order["status"] = "charging"
        order["started_at"] = iso()
        pile["status"] = "charging"
        pile["last_seen"] = iso()
        append_audit(data, action="start_charging", actor=user, target_type="order", target_id=order_id, detail=f"{pile['code']} 开始充电", ip=ip)
        return order_public(data, order, user)


def complete_order(user: dict, order_id: str, req: OrderComplete, ip: str = "") -> dict:
    with store.tx() as data:
        order = _get_order(data, order_id)
        _ensure_order_scope(user, data, order)
        if order["status"] != "charging":
            raise conflict("只有充电中的订单可以完成", "ORDER_STATE_INVALID")
        pile = _get_pile(data, order["pile_id"])
        kwh = round(float(req.kwh), 2)
        amount = round(kwh * float(order.get("price") or pile.get("price", 0)), 2)
        order["status"] = "completed"
        order["kwh"] = kwh
        order["amount"] = amount
        order["completed_at"] = iso()
        order["note"] = sanitize_text(req.note or order.get("note") or "")
        pile["status"] = "available"
        pile["last_seen"] = iso()
        pile["today_kwh"] = round(float(pile.get("today_kwh", 0)) + kwh, 2)
        pile["total_kwh"] = round(float(pile.get("total_kwh", 0)) + kwh, 2)
        append_audit(data, action="complete_charging", actor=user, target_type="order", target_id=order_id, detail=f"{pile['code']} 充电 {kwh} 度，结算 ¥{amount:.2f}", ip=ip)
        return order_public(data, order, user)


def request_refund(user: dict, req: RefundCreate, ip: str = "") -> dict:
    with store.tx() as data:
        order = _get_order(data, req.order_id)
        _ensure_order_scope(user, data, order)
        if order["status"] not in {"completed", "refunded"}:
            raise conflict("只有已完成的订单可以申请退款", "ORDER_STATE_INVALID")
        remaining = money(float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
        amount = money(req.amount)
        if amount > remaining + 0.001:
            raise bad_request(f"退款金额不能超过可退金额 ¥{remaining:.2f}", "REFUND_EXCEEDS_REMAINING")
        if order.get("refund_pending_approval"):
            raise conflict("该订单已有待处理的退款申请", "REFUND_PENDING")
        approval = _create_approval_locked(
            data,
            user,
            type_="refund",
            reason=req.reason,
            payload={"order_id": order["id"], "amount": amount},
            amount=amount,
            impact=f"订单 {order['id']} · {data['communities'].get(order['community_id'], {}).get('name', '')} · 退款 ¥{amount:.2f}",
            title="订单退款审批",
            idempotency_key=None,
        )
        order["refund_pending_approval"] = approval["id"]
        append_audit(data, action="refund_requested", actor=user, target_type="approval", target_id=approval["id"], detail=f"订单 {order['id']} 申请退款 ¥{amount:.2f}", ip=ip)
        return approval_public(data, approval)


def cancel_order(user: dict, order_id: str, req: OrderCancel, ip: str = "") -> dict:
    return cancel_reservation(user, order_id, req.reason, ip)


# --------------------------------------------------------------- device events
def ingest_device_event(actor: dict, req: DeviceEventIn, ip: str = "") -> dict:
    with store.tx() as data:
        if req.event_id in data["events"]:
            existing = data["events"][req.event_id]
            return {
                "accepted": True, "duplicate": True, "event_id": req.event_id,
                "pile_id": existing["pile_id"], "ticket_id": existing.get("ticket_id"),
                "trace_id": existing.get("trace_id"),
            }
        pile = _get_pile(data, req.pile_id)
        ensure_tenant_record(actor, pile, "充电桩")
        if pile["community_id"] not in scoped_communities(actor, data):
            raise forbidden("该设备不在你的数据授权范围内")
        occurred = req.occurred_at.astimezone(now().tzinfo) if req.occurred_at else now()
        payload = {key: value for key, value in req.payload.items() if key not in {"password", "token", "secret"}}
        event = {
            "id": req.event_id,
            "tenant_id": pile["tenant_id"],
            "pile_id": pile["id"],
            "event_type": req.event_type,
            "payload": payload,
            "occurred_at": iso(occurred),
            "processed_at": iso(),
            "trace_id": get_trace_id(),
            "ticket_id": None,
        }
        data["events"][req.event_id] = event
        pile["last_seen"] = iso(occurred)
        ticket_id = None
        if req.event_type in {"heartbeat", "restored"}:
            if req.event_type == "restored" and pile["status"] in {"fault", "offline"}:
                pile["status"] = "available"
                pile["faults"] = max(0, int(pile.get("faults", 0)) - 1)
            if "temperature" in payload:
                try:
                    pile["temperature"] = round(float(payload["temperature"]), 1)
                except (TypeError, ValueError):
                    pass
        elif req.event_type in {"power", "current"}:
            if "temperature" in payload:
                try:
                    pile["temperature"] = round(float(payload["temperature"]), 1)
                except (TypeError, ValueError):
                    pass
            if "power" in payload:
                try:
                    pile["last_power"] = round(max(0.0, float(payload["power"])), 2)
                except (TypeError, ValueError):
                    pass
        elif req.event_type == "temperature":
            try:
                temperature = float(payload.get("temperature", 0))
            except (TypeError, ValueError):
                temperature = 0
            pile["temperature"] = round(temperature, 1)
            if temperature >= 65 and pile["status"] not in {"fault", "offline"}:
                pile["status"] = "fault"
                pile["faults"] = int(pile.get("faults", 0)) + 1
                ticket_id = _open_or_escalate_ticket(
                    data, pile, "P1",
                    f"{pile['code']} 温度过高（{temperature:.1f}°C）",
                    f"温度传感器上报 {temperature:.1f}°C，超过 65°C 阈值，已自动停机并创建 P1 工单。",
                    event_type=req.event_type, actor=actor,
                )
        elif req.event_type in {"offline", "fault", "charge_interrupted"}:
            pile["status"] = "offline" if req.event_type == "offline" else "fault"
            pile["faults"] = int(pile.get("faults", 0)) + 1
            level = "P1" if req.event_type in {"offline", "fault"} or pile["faults"] >= 3 else "P2"
            label = {"offline": "设备离线", "fault": "设备故障", "charge_interrupted": "充电中断"}[req.event_type]
            detail = payload.get("code") or payload.get("reason") or "设备上报异常事件"
            ticket_id = _open_or_escalate_ticket(
                data, pile, level,
                f"{pile['code']} {label}",
                f"{label}：{detail}。事件编号 {req.event_id}，设备累计故障 {pile['faults']} 次。",
                event_type=req.event_type, actor=actor,
            )
        event["ticket_id"] = ticket_id
        event["trace_id"] = get_trace_id()
        append_audit(
            data, action="device_event", actor={"id": actor["id"], "display_name": actor.get("display_name", "设备网关"), "role": actor.get("role", "system"), "tenant_id": actor.get("tenant_id")},
            target_type="pile", target_id=pile["id"], detail=f"接收 {req.event_type} 事件 {req.event_id}", ip=ip,
        )
        return {
            "accepted": True, "duplicate": False, "event_id": req.event_id,
            "pile_id": pile["id"], "pile_status": pile["status"], "ticket_id": ticket_id,
        }


def _open_or_escalate_ticket(
    data: dict, pile: dict, level: str, title: str, description: str,
    event_type: str, actor: dict,
) -> str:
    existing = next(
        (
            ticket for ticket in data["tickets"].values()
            if ticket["pile_id"] == pile["id"] and ticket["status"] in TICKET_OPEN
        ),
        None,
    )
    if existing:
        ranks = {"P3": 1, "P2": 2, "P1": 3}
        if ranks.get(level, 0) > ranks.get(existing["level"], 0):
            existing["level"] = level
        existing["updated_at"] = iso()
        existing["history"].append({
            "at": iso(), "action": "escalated", "actor_id": "system",
            "actor_name": "设备规则引擎", "note": f"重复异常事件：{description}",
        })
        return existing["id"]
    ticket_id = store.next_id("tickets", "T", 4)
    created = now()
    data["tickets"][ticket_id] = {
        "id": ticket_id, "tenant_id": pile["tenant_id"], "pile_id": pile["id"],
        "community_id": pile["community_id"], "level": level, "title": title,
        "description": description, "status": "open", "assignee_id": None,
        "created_at": iso(created), "updated_at": iso(created),
        "due_at": iso(created + timedelta(hours=LEVEL_HOURS.get(level, 24))),
        "closed_at": None, "resolution": None,
        "verification": {"heartbeat_at": None, "test_order_id": None, "verified_at": None},
        "history": [{
            "at": iso(created), "action": "created", "actor_id": "system",
            "actor_name": "设备规则引擎", "note": f"{event_type} 事件自动生成 {level} 工单",
        }],
        "source": "device_rule", "reporter_id": None,
    }
    return ticket_id


def list_events(user: dict, limit: int = 50) -> dict:
    with store.lock_read() as data:
        communities = set(scoped_communities(user, data))
        items = [
            event for event in data["events"].values()
            if event.get("tenant_id") == user.get("tenant_id")
            and data["piles"].get(event["pile_id"], {}).get("community_id") in communities
        ]
    items = sort_desc(items, "occurred_at")[:limit]
    return {"items": items, "total": len(items)}


# -------------------------------------------------------------------- tickets
def list_tickets(user: dict, *, status: str | None = None, level: str | None = None, community_id: str | None = None) -> dict:
    with store.lock_read() as data:
        items = []
        for ticket in _tickets_for(user, data):
            if status and ticket["status"] != status:
                continue
            if level and ticket["level"] != level:
                continue
            if community_id and ticket["community_id"] != community_id:
                continue
            items.append(ticket_public(data, ticket))
    items = sort_desc(items, "created_at")
    return {"items": items, "total": len(items)}


def get_ticket(user: dict, ticket_id: str) -> dict:
    with store.lock_read() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        return ticket_public(data, ticket)


def create_ticket(user: dict, req: TicketCreate, ip: str = "") -> dict:
    with store.tx() as data:
        pile = _get_pile(data, req.pile_id)
        _ensure_pile_scope(user, data, pile)
        if user.get("role") == "user" and pile["community_id"] not in user.get("community_ids", []):
            raise forbidden("只能为本人所在社区提交报修")
        level = req.level if is_staff(user) else "P3"
        ticket_id = store.next_id("tickets", "T", 4)
        created = now()
        data["tickets"][ticket_id] = {
            "id": ticket_id, "tenant_id": pile["tenant_id"], "pile_id": pile["id"],
            "community_id": pile["community_id"], "level": level,
            "title": sanitize_text(req.title), "description": sanitize_text(req.description),
            "status": "open", "assignee_id": None, "created_at": iso(created),
            "updated_at": iso(created), "due_at": iso(created + timedelta(hours=LEVEL_HOURS[level])),
            "closed_at": None, "resolution": None,
            "verification": {"heartbeat_at": None, "test_order_id": None, "verified_at": None},
            "history": [{
                "at": iso(created), "action": "created", "actor_id": user["id"],
                "actor_name": user["display_name"], "note": "手动创建工单",
            }],
            "source": "user_report" if user.get("role") == "user" else "manual",
            "reporter_id": user["id"],
        }
        append_audit(data, action="create_ticket", actor=user, target_type="ticket", target_id=ticket_id, detail=f"{pile['code']} {req.title}", ip=ip)
        return ticket_public(data, data["tickets"][ticket_id])


def assign_ticket(user: dict, ticket_id: str, req: TicketAssign, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        if not (can_manage(user) or is_admin(user)):
            raise forbidden("只有运营人员可以分派工单")
        assignee = _get_user(data, req.assignee_id)
        ensure_tenant_record(user, assignee, "维修人员")
        if assignee["role"] != "repairer":
            raise bad_request("只能分派给维修人员")
        if ticket["community_id"] not in assignee.get("community_ids", []):
            raise bad_request("该维修人员未获得此社区授权")
        if ticket["status"] == "closed":
            raise conflict("已关闭的工单不能再分派", "TICKET_CLOSED")
        if ticket["status"] == "pending_acceptance":
            raise conflict("待验收工单不能再分派，请先完成验收", "TICKET_STATE_INVALID")
        ticket["assignee_id"] = assignee["id"]
        ticket["status"] = "assigned"
        ticket["updated_at"] = iso()
        ticket["history"].append({
            "at": iso(), "action": "assigned", "actor_id": user["id"],
            "actor_name": user["display_name"], "note": f"分派给 {assignee['display_name']}",
        })
        append_audit(data, action="assign_ticket", actor=user, target_type="ticket", target_id=ticket_id, detail=f"分派给 {assignee['display_name']}", ip=ip)
        return ticket_public(data, ticket)


def accept_ticket(user: dict, ticket_id: str, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        if ticket["status"] != "assigned":
            raise conflict("只有已分派的工单可以接单", "TICKET_STATE_INVALID")
        if user.get("role") != "admin" and ticket.get("assignee_id") != user["id"]:
            raise forbidden("只能接本人工单")
        ticket["status"] = "processing"
        ticket["updated_at"] = iso()
        ticket["history"].append({"at": iso(), "action": "accepted", "actor_id": user["id"], "actor_name": user["display_name"], "note": "维修人员已接单"})
        append_audit(data, action="accept_ticket", actor=user, target_type="ticket", target_id=ticket_id, detail="接单", ip=ip)
        return ticket_public(data, ticket)


def resolve_ticket(user: dict, ticket_id: str, req: TicketResolve, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        if ticket["status"] not in {"assigned", "processing"}:
            raise conflict("当前工单状态不能回填维修结果", "TICKET_STATE_INVALID")
        if user.get("role") == "repairer" and ticket.get("assignee_id") != user["id"]:
            raise forbidden("只能处理分配给本人的工单")
        ticket["status"] = "pending_acceptance"
        ticket["resolution"] = sanitize_text(req.resolution)
        ticket["updated_at"] = iso()
        ticket["history"].append({"at": iso(), "action": "resolved", "actor_id": user["id"], "actor_name": user["display_name"], "note": ticket["resolution"]})
        append_audit(data, action="resolve_ticket", actor=user, target_type="ticket", target_id=ticket_id, detail=ticket["resolution"], ip=ip)
        return ticket_public(data, ticket)


def create_test_order(user: dict, ticket_id: str, req: TicketTestOrder, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        if ticket["status"] != "pending_acceptance":
            raise conflict("只有待验收工单可以创建测试订单", "TICKET_STATE_INVALID")
        pile = _get_pile(data, ticket["pile_id"])
        if pile["status"] in {"offline", "maintenance", "fault"}:
            raise conflict("设备仍处于故障/离线/维护状态，无法完成测试订单", "PILE_UNAVAILABLE")
        order_id = store.next_id("orders", "O", 4)
        current = now()
        order = {
            "id": order_id, "tenant_id": ticket["tenant_id"], "user_id": user["id"],
            "pile_id": pile["id"], "community_id": ticket["community_id"],
            "status": "completed", "amount": 0.0, "kwh": round(float(req.kwh), 2),
            "price": 0.0, "created_at": iso(current), "reserved_start": iso(current - timedelta(minutes=2)),
            "reserved_end": iso(current + timedelta(minutes=18)), "started_at": iso(current - timedelta(minutes=2)),
            "completed_at": iso(current), "idempotency_key": None, "is_test": True,
            "ticket_id": ticket["id"], "refund_amount": 0.0, "refunded_at": None,
            "cancelled_at": None, "cancel_reason": None, "trace_id": None,
            "note": "工单验收测试订单",
        }
        data["orders"][order_id] = order
        ticket["verification"]["test_order_id"] = order_id
        ticket["updated_at"] = iso()
        ticket["history"].append({"at": iso(), "action": "test_order", "actor_id": user["id"], "actor_name": user["display_name"], "note": f"创建测试订单 {order_id}"})
        append_audit(data, action="create_test_order", actor=user, target_type="ticket", target_id=ticket_id, detail=f"测试订单 {order_id}", ip=ip)
        return {"ticket": ticket_public(data, ticket), "order": order_public(data, order, user)}


def simulate_heartbeat(user: dict, ticket_id: str, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        pile = _get_pile(data, ticket["pile_id"])
        pile["last_seen"] = iso()
        pile["temperature"] = round(min(float(pile.get("temperature", 35)), 42), 1)
        event_id = f"HB-{ticket_id}-{int(now().timestamp())}"
        data["events"][event_id] = {
            "id": event_id, "tenant_id": ticket["tenant_id"], "pile_id": pile["id"],
            "event_type": "heartbeat", "payload": {"source": "verification", "temperature": pile["temperature"]},
            "occurred_at": iso(), "processed_at": iso(), "trace_id": "", "ticket_id": ticket_id,
        }
        append_audit(data, action="heartbeat_check", actor=user, target_type="ticket", target_id=ticket_id, detail="验收心跳检查", ip=ip)
        return {"ticket": ticket_public(data, ticket), "heartbeat_at": pile["last_seen"]}


def close_ticket(user: dict, ticket_id: str, ip: str = "") -> dict:
    with store.tx() as data:
        ticket = _get_ticket(data, ticket_id)
        _ensure_ticket_scope(user, data, ticket)
        if ticket["status"] == "closed":
            raise conflict("工单已关闭，不能重复关闭", "TICKET_CLOSED")
        check = ticket_verification(data, ticket)
        if not check["can_close"]:
            raise conflict("工单验收未通过：" + "；".join(check["reasons"]), "TICKET_VERIFICATION_FAILED", checks=check)
        pile = _get_pile(data, ticket["pile_id"])
        ticket["status"] = "closed"
        ticket["closed_at"] = iso()
        ticket["updated_at"] = iso()
        ticket["verification"]["heartbeat_at"] = check["heartbeat_at"]
        ticket["verification"]["verified_at"] = iso()
        ticket["history"].append({"at": iso(), "action": "closed", "actor_id": user["id"], "actor_name": user["display_name"], "note": "验收通过并关闭工单"})
        pile["status"] = "available"
        pile["last_seen"] = iso()
        append_audit(data, action="close_ticket", actor=user, target_type="ticket", target_id=ticket_id, detail="心跳 + 测试订单验收通过", ip=ip)
        return ticket_public(data, ticket)


# ------------------------------------------------------------------ approvals
def _create_approval_locked(
    data: dict, user: dict, *, type_: str, reason: str, payload: dict,
    amount: float, impact: str, title: str, idempotency_key: str | None,
) -> dict:
    if idempotency_key:
        existing = next(
            (
                approval for approval in data["approvals"].values()
                if approval.get("tenant_id") == user.get("tenant_id")
                and approval.get("idempotency_key") == idempotency_key
            ),
            None,
        )
        if existing:
            return existing
    approval_id = store.next_id("approvals", "AP", 4)
    risk_factors = ["涉及资金或设备状态变更", "执行前必须人工复核"]
    if type_ == "refund":
        risk_factors.append("将改变订单结算状态")
    if type_ == "price_change":
        risk_factors.append("影响居民账单")
    if type_ == "stop_pile":
        risk_factors.append("设备将停止服务")
    if type_ == "batch_reassign":
        risk_factors.append("批量修改工单责任人")
    approval = {
        "id": approval_id, "tenant_id": user["tenant_id"], "type": type_,
        "title": title, "reason": sanitize_text(reason), "payload": payload,
        "impact": impact, "amount": money(amount), "risk": "high",
        "risk_factors": risk_factors, "status": "pending",
        "requester_id": user["id"], "requester_name": user["display_name"],
        "created_at": iso(), "decided_by": None, "decided_at": None,
        "decision_comment": None, "executed_at": None, "execution_result": None,
        "trace_id": "", "idempotency_key": idempotency_key,
    }
    data["approvals"][approval_id] = approval
    return approval


def create_approval(user: dict, req: ApprovalCreate, idempotency_key: str | None, ip: str = "") -> dict:
    with store.tx() as data:
        payload = dict(req.payload or {})
        amount = money(req.amount)
        title = {
            "refund": "订单退款审批",
            "stop_pile": "停机检修审批",
            "price_change": "电价调整审批",
            "batch_reassign": "批量改派审批",
        }[req.type]
        impact = ""
        if req.type == "refund":
            order_id = str(payload.get("order_id", ""))
            order = _get_order(data, order_id)
            _ensure_order_scope(user, data, order)
            if order["status"] not in {"completed", "refunded"}:
                raise conflict("订单当前状态不可退款", "ORDER_STATE_INVALID")
            if order.get("refund_pending_approval"):
                raise conflict("该订单已有待处理的退款申请", "REFUND_PENDING")
            remaining = money(float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
            amount = amount or remaining
            if amount <= 0 or amount > remaining + 0.001:
                raise bad_request(f"退款金额需大于 0 且不超过可退金额 ¥{remaining:.2f}", "REFUND_EXCEEDS_REMAINING")
            payload = {"order_id": order_id, "amount": amount}
            impact = f"订单 {order_id} · {data['communities'].get(order['community_id'], {}).get('name', '')} · 退款 ¥{amount:.2f}"
        elif req.type == "stop_pile":
            pile = _get_pile(data, str(payload.get("pile_id", "")))
            _ensure_pile_scope(user, data, pile)
            if not can_manage(user):
                raise forbidden("只有运营人员可以申请停机")
            payload = {"pile_id": pile["id"], "duration_hours": int(payload.get("duration_hours", 8))}
            impact = f"{data['communities'].get(pile['community_id'], {}).get('name', '')} · {pile['code']} · 停机 {payload['duration_hours']} 小时"
        elif req.type == "price_change":
            community_id = str(payload.get("community_id", ""))
            ensure_community(user, community_id)
            if not can_manage(user):
                raise forbidden("只有运营人员可以申请调价")
            try:
                new_price = round(float(payload.get("new_price")), 2)
            except (TypeError, ValueError):
                raise unprocessable("新的电价必须是数字")
            if not 0.2 <= new_price <= 5.0:
                raise unprocessable("电价需在 0.20 至 5.00 元/度之间")
            pile_ids = payload.get("pile_ids") or [
                pile["id"] for pile in data["piles"].values()
                if pile["community_id"] == community_id and pile["tenant_id"] == user["tenant_id"]
            ]
            old_prices = sorted({float(data["piles"][pid]["price"]) for pid in pile_ids if pid in data["piles"]})
            old_price = old_prices[0] if old_prices else 0
            payload = {"community_id": community_id, "pile_ids": pile_ids, "old_price": old_price, "new_price": new_price}
            change = (new_price - old_price) / old_price * 100 if old_price else 0
            impact = f"{data['communities'].get(community_id, {}).get('name', '')} · {len(pile_ids)} 台设备 · 电价 {change:+.1f}%"
        elif req.type == "batch_reassign":
            if not can_manage(user):
                raise forbidden("只有运营人员可以批量改派")
            ticket_ids = payload.get("ticket_ids") or []
            assignee_id = str(payload.get("assignee_id", ""))
            assignee = _get_user(data, assignee_id)
            if assignee["role"] != "repairer":
                raise bad_request("只能改派给维修人员")
            tickets = []
            for ticket_id in ticket_ids:
                ticket = _get_ticket(data, str(ticket_id))
                _ensure_ticket_scope(user, data, ticket)
                tickets.append(ticket["id"])
            if not tickets:
                raise bad_request("至少选择一张工单")
            payload = {"ticket_ids": tickets, "assignee_id": assignee_id}
            impact = f"批量改派 {len(tickets)} 张工单给 {assignee['display_name']}"
        approval = _create_approval_locked(
            data, user, type_=req.type, reason=req.reason, payload=payload,
            amount=amount, impact=impact, title=title, idempotency_key=idempotency_key,
        )
        if req.type == "refund" and payload.get("order_id") in data["orders"]:
            data["orders"][payload["order_id"]]["refund_pending_approval"] = approval["id"]
        append_audit(data, action="approval_created", actor=user, target_type="approval", target_id=approval["id"], detail=f"{title}：{impact}", ip=ip)
        return approval_public(data, approval)


def list_approvals(user: dict, *, status: str | None = None, type_: str | None = None) -> dict:
    with store.lock_read() as data:
        items = []
        for approval in _approvals_for(user, data):
            if status and approval["status"] != status:
                continue
            if type_ and approval["type"] != type_:
                continue
            items.append(approval_public(data, approval))
    items = sort_desc(items, "created_at")
    return {"items": items, "total": len(items)}


def get_approval(user: dict, approval_id: str) -> dict:
    with store.lock_read() as data:
        approval = data["approvals"].get(approval_id)
        if not approval:
            raise not_found("审批不存在")
        _ensure_approval_scope(user, data, approval)
        return approval_public(data, approval)


def decide_approval(user: dict, approval_id: str, req: ApprovalDecision, ip: str = "") -> dict:
    with store.tx() as data:
        approval = data["approvals"].get(approval_id)
        if not approval:
            raise not_found("审批不存在")
        ensure_tenant_record(user, approval, "审批")
        if not can_approve(user):
            raise forbidden("只有管理员或财务审批人可以处理审批")
        if approval["status"] != "pending":
            raise conflict("该审批已处理，不能重复审批", "APPROVAL_ALREADY_DECIDED")
        if approval["requester_id"] == user["id"]:
            raise forbidden("申请人与审批人不能为同一人")
        if not req.approved and len(req.comment.strip()) < 2:
            raise bad_request("驳回时必须填写审批意见")
        approval["decided_by"] = user["id"]
        approval["decided_at"] = iso()
        approval["decision_comment"] = sanitize_text(req.comment)
        if not req.approved:
            approval["status"] = "rejected"
            if approval["type"] == "refund":
                order = data["orders"].get(str(approval.get("payload", {}).get("order_id", "")))
                if order and order.get("refund_pending_approval") == approval_id:
                    order.pop("refund_pending_approval", None)
            append_audit(data, action="approval_rejected", actor=user, target_type="approval", target_id=approval_id, detail=req.comment, ip=ip)
            return approval_public(data, approval)

        try:
            result = _execute_approval(data, approval, user)
            approval["status"] = "executed"
            approval["executed_at"] = iso()
            approval["execution_result"] = result
            append_audit(data, action="approval_executed", actor=user, target_type="approval", target_id=approval_id, detail=result, ip=ip)
        except Exception as exc:  # execution failures must be visible, not silent
            approval["status"] = "failed"
            approval["executed_at"] = iso()
            approval["execution_result"] = f"执行失败：{exc}"
            if approval["type"] == "refund":
                order = data["orders"].get(str(approval.get("payload", {}).get("order_id", "")))
                if order and order.get("refund_pending_approval") == approval_id:
                    order.pop("refund_pending_approval", None)
            append_audit(data, action="approval_failed", actor=user, target_type="approval", target_id=approval_id, detail=approval["execution_result"], ip=ip)
        return approval_public(data, approval)


def _execute_approval(data: dict, approval: dict, user: dict) -> str:
    payload = approval.get("payload", {})
    kind = approval["type"]
    if kind == "refund":
        order = _get_order(data, str(payload.get("order_id", "")))
        if order["status"] == "refunded" and order.get("refund_amount", 0) >= approval["amount"]:
            raise conflict("订单已退款，不能重复执行", "REFUND_ALREADY_EXECUTED")
        remaining = money(float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
        amount = min(money(approval["amount"]), remaining)
        if amount <= 0:
            raise conflict("订单没有可退金额", "REFUND_EXCEEDS_REMAINING")
        order["refund_amount"] = money(float(order.get("refund_amount", 0)) + amount)
        order["refunded_at"] = iso()
        order["status"] = "refunded"
        order.pop("refund_pending_approval", None)
        return f"订单 {order['id']} 已退款 ¥{amount:.2f}"
    if kind == "stop_pile":
        pile = _get_pile(data, str(payload.get("pile_id", "")))
        pile["status"] = "offline"
        pile["last_seen"] = iso()
        ticket_id = _open_or_escalate_ticket(
            data, pile, "P1", f"{pile['code']} 停机检修",
            f"按审批 {approval['id']} 执行停机检修，预计 {payload.get('duration_hours', 8)} 小时。",
            event_type="stop_pile", actor=user,
        )
        return f"{pile['code']} 已停机，工单 {ticket_id}"
    if kind == "price_change":
        pile_ids = payload.get("pile_ids") or []
        new_price = float(payload.get("new_price", 0))
        for pile_id in pile_ids:
            pile = data["piles"].get(pile_id)
            if pile:
                pile["price"] = new_price
        return f"{len(pile_ids)} 台设备电价已调整为 ¥{new_price:.2f}/度"
    if kind == "batch_reassign":
        assignee = _get_user(data, str(payload.get("assignee_id", "")))
        changed = 0
        for ticket_id in payload.get("ticket_ids") or []:
            ticket = data["tickets"].get(ticket_id)
            if ticket and ticket["status"] != "closed":
                ticket["assignee_id"] = assignee["id"]
                ticket["status"] = "assigned"
                ticket["updated_at"] = iso()
                ticket["history"].append({"at": iso(), "action": "reassigned", "actor_id": user["id"], "actor_name": user["display_name"], "note": f"审批 {approval['id']} 批量改派给 {assignee['display_name']}"})
                changed += 1
        return f"{changed} 张工单已改派给 {assignee['display_name']}"
    raise bad_request("未知的审批类型")


# --------------------------------------------------------------------- users
def list_users(user: dict, *, role: str | None = None, search: str = "") -> dict:
    if not is_admin(user):
        raise forbidden("只有系统管理员可以查看用户列表")
    with store.lock_read() as data:
        items = []
        for record in data["users"].values():
            if record.get("tenant_id") != user.get("tenant_id"):
                continue
            if role and record["role"] != role:
                continue
            if search and search.lower() not in f"{record['username']} {record['display_name']}".lower():
                continue
            items.append(public_user(record))
    items.sort(key=lambda item: (item["role"], item["username"]))
    return {"items": items, "total": len(items)}


def create_user(admin: dict, req: UserCreate, ip: str = "") -> dict:
    if not is_admin(admin):
        raise forbidden("只有系统管理员可以创建用户")
    with store.tx() as data:
        if any(
            record["username"].lower() == req.username.lower() and record.get("tenant_id") == admin["tenant_id"]
            for record in data["users"].values()
        ):
            raise conflict("用户名已存在", "USERNAME_TAKEN")
        community_ids = list(dict.fromkeys(req.community_ids))
        for community_id in community_ids:
            ensure_community(admin, community_id)
        from .passwords import hash_password

        user_id = store.next_id("users", "U", 3)
        record = {
            "id": user_id, "tenant_id": admin["tenant_id"], "username": req.username,
            "display_name": req.display_name, "role": req.role,
            "community_ids": community_ids, "phone": req.phone, "email": req.email,
            "status": "active", "password_hash": hash_password(req.password),
            "created_at": iso(), "last_login_at": None,
        }
        data["users"][user_id] = record
        append_audit(data, action="create_user", actor=admin, target_type="user", target_id=user_id, detail=f"创建 {req.username}（{req.role}）", ip=ip)
        return public_user(record)


def update_user_status(admin: dict, user_id: str, status: str, ip: str = "") -> dict:
    if not is_admin(admin):
        raise forbidden("只有系统管理员可以修改用户状态")
    if admin["id"] == user_id:
        raise bad_request("不能停用当前登录账号")
    with store.tx() as data:
        record = _get_user(data, user_id)
        ensure_tenant_record(admin, record, "用户")
        record["status"] = status
        append_audit(data, action="update_user_status", actor=admin, target_type="user", target_id=user_id, detail=f"状态改为 {status}", ip=ip)
        return public_user(record)


# --------------------------------------------------------------- communities
def list_communities(user: dict) -> dict:
    with store.lock_read() as data:
        allowed = set(scoped_communities(user, data))
        items = [
            community_public(data, community, user)
            for community in data["communities"].values()
            if community.get("tenant_id") == user.get("tenant_id") and community["id"] in allowed
        ]
    items.sort(key=lambda item: item["name"])
    return {"items": items, "total": len(items)}


def create_community(admin: dict, req: CommunityCreate, ip: str = "") -> dict:
    if not is_admin(admin):
        raise forbidden("只有系统管理员可以创建社区")
    with store.tx() as data:
        community_id = store.next_id("communities", "C", 3)
        record = {
            "id": community_id, "tenant_id": admin["tenant_id"], "org_id": "ORG001",
            "name": req.name, "address": req.address, "city": req.city,
            "district": req.district, "contact": req.contact, "phone": req.phone,
            "created_at": iso(),
        }
        data["communities"][community_id] = record
        append_audit(data, action="create_community", actor=admin, target_type="community", target_id=community_id, detail=req.name, ip=ip)
        return community_public(data, record)


def list_piles(user: dict, *, status: str | None = None, community_id: str | None = None, search: str = "") -> dict:
    expire_stale_reservations()
    with store.lock_read() as data:
        items = []
        for pile in _piles_for(user, data):
            if status and pile["status"] != status:
                continue
            if community_id and pile["community_id"] != community_id:
                continue
            if search and search.lower() not in f"{pile['code']} {pile['model']} {pile['connector']}".lower():
                continue
            items.append(pile_public(data, pile))
    items.sort(key=lambda item: (item["community_name"], item["code"]))
    return {"items": items, "total": len(items)}


def get_pile(user: dict, pile_id: str) -> dict:
    with store.lock_read() as data:
        pile = _get_pile(data, pile_id)
        _ensure_pile_scope(user, data, pile)
        result = pile_public(data, pile)
        result["recent_events"] = sort_desc(
            [event for event in data["events"].values() if event["pile_id"] == pile_id], "occurred_at"
        )[:8]
        result["open_tickets"] = [
            ticket_public(data, ticket) for ticket in data["tickets"].values()
            if ticket["pile_id"] == pile_id and ticket["status"] in TICKET_OPEN
            and (user.get("role") != "user" or ticket.get("reporter_id") == user["id"])
        ]
        return result


def create_pile(user: dict, req, ip: str = "") -> dict:
    if not can_manage(user):
        raise forbidden("只有管理员或运营人员可以新增设备")
    ensure_community(user, req.community_id)
    with store.tx() as data:
        if any(
            pile["code"] == req.code and pile["community_id"] == req.community_id
            for pile in data["piles"].values()
        ):
            raise conflict("该社区内已存在相同设备编号", "PILE_CODE_TAKEN")
        pile_id = store.next_id("piles", "P", 3)
        current = now()
        pile = {
            "id": pile_id, "tenant_id": user["tenant_id"], "community_id": req.community_id,
            "code": req.code, "model": req.model, "connector": req.connector,
            "power": float(req.power), "price": float(req.price), "status": "available",
            "faults": 0, "last_seen": iso(current), "temperature": 28.0, "last_power": 0.0,
            "today_kwh": 0.0, "total_kwh": 0.0, "firmware": "v2.4.1",
            "installed_at": iso(current), "created_at": iso(current),
        }
        data["piles"][pile_id] = pile
        append_audit(data, action="create_pile", actor=user, target_type="pile", target_id=pile_id, detail=f"{req.community_id} / {req.code}", ip=ip)
        return pile_public(data, pile)


def list_assignees(user: dict) -> dict:
    with store.lock_read() as data:
        communities = set(scoped_communities(user, data))
        items = [
            {
                "id": record["id"], "display_name": record["display_name"],
                "role": record["role"], "phone": record.get("phone", ""),
                "community_ids": list(record.get("community_ids", [])),
            }
            for record in data["users"].values()
            if record["tenant_id"] == user["tenant_id"]
            and record["role"] == "repairer"
            and record.get("status") == "active"
            and (is_admin(user) or communities.intersection(record.get("community_ids", [])))
        ]
    return {"items": items, "total": len(items)}


# --------------------------------------------------------------------- audit
def list_audit(user: dict, *, limit: int = 100, action: str | None = None, search: str = "") -> dict:
    if user.get("role") not in {"admin", "operator"}:
        raise forbidden("只有管理员和运营人员可以查看审计日志")
    with store.lock_read() as data:
        items = []
        for entry in data["audit"]:
            if entry.get("tenant_id") != user.get("tenant_id"):
                continue
            if user.get("role") == "operator" and entry.get("actor_id") not in {user["id"], "system", "device-gateway"}:
                # Operators still need to see operational changes; restrict
                # only login/security entries to their own account.
                if entry.get("target_type") == "auth":
                    continue
            if action and entry.get("action") != action:
                continue
            if search and search.lower() not in f"{entry.get('actor_name')} {entry.get('action')} {entry.get('detail')} {entry.get('target_id')}".lower():
                continue
            items.append(audit_public(entry))
    items = sort_desc(items, "at")[:limit]
    return {"items": items, "total": len(items)}


# ------------------------------------------------------------------- reports
def _trend(user: dict, data: dict, days: int) -> list[dict]:
    keys = date_range(days)
    buckets = {key: {"date": key, "revenue": 0.0, "orders": 0, "kwh": 0.0} for key in keys}
    for order in _orders_for(user, data):
        if order.get("is_test"):
            continue
        if order["status"] not in {"completed", "refunded"}:
            continue
        key = date_key(order.get("completed_at") or order.get("created_at"))
        if key in buckets:
            net = max(0.0, float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
            buckets[key]["revenue"] += net
            buckets[key]["orders"] += 1
            buckets[key]["kwh"] += float(order.get("kwh", 0))
    return [
        {**bucket, "revenue": money(bucket["revenue"]), "kwh": round(bucket["kwh"], 1)}
        for bucket in buckets.values()
    ]


def dashboard(user: dict) -> dict:
    expire_stale_reservations()
    with store.lock_read() as data:
        piles = [pile_public(data, pile) for pile in _piles_for(user, data)]
        orders = list(_orders_for(user, data))
        tickets = list(_tickets_for(user, data))
        approvals = list(_approvals_for(user, data))
        my_orders = [order for order in orders if order["user_id"] == user["id"]]
        today = start_of_day(0)
        today_orders = [
            order for order in my_orders
            if (parse_dt(order.get("created_at")) or today) >= today
        ]
        today_revenue = sum(
            max(0.0, float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
            for order in orders
            if order["status"] == "completed" and (parse_dt(order.get("completed_at")) or today) >= today and not order.get("is_test")
        )
        active_sessions = [order for order in my_orders if order["status"] == "charging"]
        upcoming = [
            order for order in my_orders
            if order["status"] == "reserved" and (parse_dt(order.get("reserved_end")) or now()) >= now()
        ]
        personal = user.get("role") == "user"
        kpis = {
            "piles": len(piles),
            "available": sum(1 for pile in piles if pile["status"] == "available"),
            "charging": sum(1 for pile in piles if pile["status"] == "charging"),
            "faults": sum(1 for pile in piles if pile["status"] in {"fault", "offline"}),
            "availability_rate": pct(sum(1 for pile in piles if pile["status"] not in PILE_BLOCKED), len(piles)),
            "orders_today": len(today_orders) if personal else sum(
                1 for order in orders
                if (parse_dt(order.get("created_at")) or today) >= today and not order.get("is_test")
            ),
            "revenue_today": money(today_revenue),
            "my_spend": money(sum(float(order.get("amount", 0)) for order in my_orders if order["status"] == "completed")),
            "open_tickets": sum(1 for ticket in tickets if ticket["status"] in TICKET_OPEN),
            "pending_approvals": sum(1 for approval in approvals if approval["status"] == "pending"),
            "active_sessions": len(active_sessions),
            "upcoming_reservations": len(upcoming),
        }
        alerts = []
        for pile in piles:
            if pile["status"] == "fault":
                alerts.append({"level": "P1", "type": "device", "title": f"{pile['code']} 设备故障", "detail": f"已累计 {pile['faults']} 次故障，最后心跳 {pile['last_seen_minutes']:.0f} 分钟前", "target": pile["id"]})
            elif pile["status"] == "offline":
                alerts.append({"level": "P1", "type": "device", "title": f"{pile['code']} 设备离线", "detail": f"最后心跳 {pile['last_seen_minutes']:.0f} 分钟前", "target": pile["id"]})
        for ticket in tickets:
            if ticket["status"] in TICKET_OPEN and (parse_dt(ticket.get("due_at")) or now()) < now():
                alerts.append({"level": ticket["level"], "type": "ticket", "title": f"{ticket['id']} 工单超时", "detail": ticket["title"], "target": ticket["id"]})
        for approval in approvals:
            if approval["status"] == "pending":
                alerts.append({"level": "审批", "type": "approval", "title": f"{approval['id']} 待审批", "detail": approval["impact"], "target": approval["id"]})
        alerts = sorted(alerts, key=lambda item: {"P1": 0, "P2": 1, "P3": 2, "审批": 3}.get(item["level"], 9))[:6]
        recent_audit = [
            entry for entry in data["audit"]
            if entry.get("tenant_id") == user.get("tenant_id")
            and (not personal or entry.get("actor_id") == user["id"])
        ]
        recent_audit = list(reversed(recent_audit))[:6]
        community_items = [
            community_public(data, community, user)
            for community in data["communities"].values()
            if community["tenant_id"] == user.get("tenant_id")
            and community["id"] in scoped_communities(user, data)
        ]
        return {
            "personal": personal,
            "kpis": kpis,
            "trend": _trend(user, data, 7),
            "community_health": community_items,
            "alerts": alerts,
            "recent_activity": recent_audit,
            "status_distribution": {
                "available": kpis["available"],
                "charging": kpis["charging"],
                "fault": sum(1 for pile in piles if pile["status"] == "fault"),
                "offline": sum(1 for pile in piles if pile["status"] == "offline"),
                "maintenance": sum(1 for pile in piles if pile["status"] == "maintenance"),
                "reserved": sum(1 for pile in piles if pile["status"] == "reserved"),
            },
            "next_reservation": upcoming[0] if upcoming else None,
            "active_session": active_sessions[0] if active_sessions else None,
            "generated_at": iso(),
        }


def operations_report(user: dict, days: int = 7) -> dict:
    days = max(1, min(30, days))
    if user.get("role") == "user":
        raise forbidden("居民用户无权查看运营报表")
    expire_stale_reservations()
    with store.lock_read() as data:
        orders = [order for order in _orders_for(user, data) if not order.get("is_test")]
        piles = list(_piles_for(user, data))
        tickets = list(_tickets_for(user, data))
        communities = [
            community for community in data["communities"].values()
            if community["tenant_id"] == user.get("tenant_id")
            and community["id"] in scoped_communities(user, data)
        ]
        since = start_of_day(days - 1)
        period_orders = [
            order for order in orders
            if (parse_dt(order.get("completed_at") or order.get("created_at")) or since) >= since
        ]
        completed = [order for order in period_orders if order["status"] in {"completed", "refunded"}]
        revenue = sum(max(0.0, float(order.get("amount", 0)) - float(order.get("refund_amount", 0))) for order in completed)
        refunds = sum(float(order.get("refund_amount", 0)) for order in period_orders)
        kwh = sum(float(order.get("kwh", 0)) for order in completed)
        closed = [ticket for ticket in tickets if ticket["status"] == "closed" and ticket.get("closed_at")]
        mttr_seconds = [
            (parse_dt(ticket["closed_at"]) - parse_dt(ticket["created_at"])).total_seconds()
            for ticket in closed
            if parse_dt(ticket["closed_at"]) and parse_dt(ticket["created_at"])
        ]
        available = [pile for pile in piles if pile["status"] not in PILE_BLOCKED]
        total_power = sum(float(pile["power"]) for pile in piles) or 1
        utilization = pct(kwh, total_power * 24 * days)
        attempts = data["meta"].get("reservation_attempts") or 0
        successes = data["meta"].get("reservation_success") or 0
        reservation_rate = pct(successes, attempts) if attempts else 0
        community_rows = []
        for community in communities:
            community_orders = [order for order in completed if order["community_id"] == community["id"]]
            community_piles = [pile for pile in piles if pile["community_id"] == community["id"]]
            community_tickets = [ticket for ticket in tickets if ticket["community_id"] == community["id"] and ticket["status"] in TICKET_OPEN]
            community_rows.append({
                "id": community["id"], "name": community["name"],
                "piles": len(community_piles),
                "availability_rate": pct(sum(1 for pile in community_piles if pile["status"] not in PILE_BLOCKED), len(community_piles)),
                "utilization": pct(sum(float(order.get("kwh", 0)) for order in community_orders), (sum(float(pile["power"]) for pile in community_piles) or 1) * 24 * days),
                "revenue": money(sum(max(0.0, float(order.get("amount", 0)) - float(order.get("refund_amount", 0))) for order in community_orders)),
                "orders": len(community_orders),
                "open_tickets": len(community_tickets),
                "faults": sum(1 for pile in community_piles if pile["status"] in {"fault", "offline"}),
            })
        community_rows.sort(key=lambda item: item["revenue"], reverse=True)
        level_counts = {level: 0 for level in ("P1", "P2", "P3")}
        for ticket in tickets:
            if ticket["status"] in TICKET_OPEN:
                level_counts[ticket["level"]] = level_counts.get(ticket["level"], 0) + 1
        top_faults = sorted(
            [
                {
                    "id": pile["id"], "code": pile["code"], "community_name": data["communities"].get(pile["community_id"], {}).get("name", ""),
                    "faults": pile["faults"], "status": pile["status"],
                }
                for pile in piles if pile["faults"] > 0
            ],
            key=lambda item: item["faults"], reverse=True,
        )[:6]
        return {
            "period": {"days": days, "from": iso(since), "to": iso(), "label": f"近 {days} 天"},
            "kpis": {
                "total_piles": len(piles),
                "availability_rate": pct(len(available), len(piles)),
                "utilization": utilization,
                "fault_rate": pct(sum(1 for pile in piles if pile["faults"] > 0), len(piles)),
                "mttr_hours": round(sum(mttr_seconds) / len(mttr_seconds) / 3600, 1) if mttr_seconds else 0,
                "reservation_success_rate": reservation_rate,
                "revenue": money(revenue),
                "refund_amount": money(refunds),
                "orders": len(completed),
                "kwh": round(kwh, 1),
                "avg_order_amount": money(revenue / len(completed)) if completed else 0,
                "open_tickets": sum(1 for ticket in tickets if ticket["status"] in TICKET_OPEN),
                "pending_approvals": sum(
                    1 for approval in data["approvals"].values()
                    if approval.get("tenant_id") == user.get("tenant_id") and approval["status"] == "pending"
                    and (can_approve(user) or approval.get("requester_id") == user["id"])
                ),
            },
            "trend": _trend(user, data, days),
            "communities": community_rows,
            "ticket_levels": level_counts,
            "top_faults": top_faults,
            "generated_at": iso(),
        }
