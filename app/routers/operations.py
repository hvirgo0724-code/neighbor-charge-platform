from __future__ import annotations

import hmac

from fastapi import APIRouter, Depends, Header, Query, Request, status

from ..config import settings
from ..core import get_trace_id, iso, now
from ..errors import unauthorized
from ..schemas import (
    ApprovalCreate,
    ApprovalDecision,
    DeviceEventIn,
    OrderCancel,
    OrderComplete,
    RefundCreate,
    ReservationCreate,
    TicketAssign,
    TicketCreate,
    TicketResolve,
    TicketTestOrder,
)
from ..security import current_user, require_roles
from ..services import (
    accept_ticket,
    assign_ticket,
    cancel_order,
    cancel_reservation,
    close_ticket,
    complete_order,
    create_approval,
    create_reservation,
    create_test_order,
    create_ticket,
    decide_approval,
    get_approval,
    get_order,
    get_ticket,
    ingest_device_event,
    list_approvals,
    list_orders,
    list_reservations,
    list_tickets,
    request_refund,
    resolve_ticket,
    simulate_heartbeat,
    start_order,
)

router = APIRouter(prefix="/api", tags=["operations"])


def traced(payload: dict) -> dict:
    if isinstance(payload, dict):
        payload.setdefault("trace_id", get_trace_id())
    return payload


def idempotency_key(value: str | None) -> str | None:
    if not value:
        return None
    value = value.strip()
    if len(value) > 100:
        raise unauthorized("幂等键过长")
    return value


def device_actor(
    request: Request,
    authorization: str | None = Header(default=None, alias="Authorization"),
    x_device_key: str | None = Header(default=None, alias="X-Device-Key"),
):
    if x_device_key:
        if hmac.compare_digest(x_device_key, settings.device_api_key):
            return {
                "id": "device-gateway", "tenant_id": "T001", "role": "system",
                "display_name": "设备网关", "community_ids": ["C001", "C002", "C003"],
            }
        raise unauthorized("设备接入密钥无效", "DEVICE_KEY_INVALID")
    return current_user(request, authorization)


@router.get("/reservations")
def reservations(user: dict = Depends(current_user)):
    return traced(list_reservations(user))


@router.post("/reservations", status_code=201)
def add_reservation(
    req: ReservationCreate,
    request: Request,
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict = Depends(require_roles("admin", "operator", "user")),
):
    from ..security import client_ip

    return traced(create_reservation(user, req, idempotency_key(idem), client_ip(request)))


@router.delete("/reservations/{order_id}")
def remove_reservation(order_id: str, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return traced(cancel_reservation(user, order_id, "用户取消预约", client_ip(request)))


@router.get("/orders")
def orders(
    status_filter: str | None = Query(default=None, alias="status", max_length=24),
    community_id: str | None = Query(default=None, max_length=36),
    search: str = Query(default="", max_length=60),
    page: int = Query(default=1, ge=1, le=1000),
    page_size: int = Query(default=20, ge=5, le=100),
    user: dict = Depends(current_user),
):
    return traced(list_orders(user, status=status_filter, community_id=community_id, search=search, page=page, page_size=page_size))


@router.get("/orders/{order_id}")
def order_detail(order_id: str, user: dict = Depends(current_user)):
    return traced(get_order(user, order_id))


@router.post("/orders/{order_id}/start")
def order_start(order_id: str, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return traced(start_order(user, order_id, client_ip(request)))


@router.post("/orders/{order_id}/complete")
def order_complete(order_id: str, req: OrderComplete, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return traced(complete_order(user, order_id, req, client_ip(request)))


@router.post("/orders/{order_id}/cancel")
def order_cancel(order_id: str, req: OrderCancel, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return traced(cancel_order(user, order_id, req, client_ip(request)))


@router.post("/refunds", status_code=202)
def refund(
    req: RefundCreate,
    request: Request,
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict = Depends(current_user),
):
    from ..security import client_ip

    return traced(request_refund(user, req, client_ip(request)))


@router.post("/device-events", status_code=202)
def device_events(
    req: DeviceEventIn,
    request: Request,
    actor: dict = Depends(device_actor),
):
    from ..security import client_ip

    return traced(ingest_device_event(actor, req, client_ip(request)))


@router.get("/tickets")
def tickets(
    status_filter: str | None = Query(default=None, alias="status", max_length=24),
    level: str | None = Query(default=None, max_length=4),
    community_id: str | None = Query(default=None, max_length=36),
    user: dict = Depends(require_roles("admin", "operator", "repairer", "user")),
):
    return traced(list_tickets(user, status=status_filter, level=level, community_id=community_id))


@router.get("/tickets/{ticket_id}")
def ticket_detail(ticket_id: str, user: dict = Depends(current_user)):
    return traced(get_ticket(user, ticket_id))


@router.post("/tickets", status_code=201)
def add_ticket(req: TicketCreate, request: Request, user: dict = Depends(current_user)):
    from ..security import client_ip

    return traced(create_ticket(user, req, client_ip(request)))


@router.post("/tickets/{ticket_id}/assign")
def ticket_assign(ticket_id: str, req: TicketAssign, request: Request, user: dict = Depends(require_roles("admin", "operator"))):
    from ..security import client_ip

    return traced(assign_ticket(user, ticket_id, req, client_ip(request)))


@router.post("/tickets/{ticket_id}/accept")
def ticket_accept(ticket_id: str, request: Request, user: dict = Depends(require_roles("admin", "repairer"))):
    from ..security import client_ip

    return traced(accept_ticket(user, ticket_id, client_ip(request)))


@router.post("/tickets/{ticket_id}/resolve")
def ticket_resolve(ticket_id: str, req: TicketResolve, request: Request, user: dict = Depends(require_roles("admin", "operator", "repairer"))):
    from ..security import client_ip

    return traced(resolve_ticket(user, ticket_id, req, client_ip(request)))


@router.post("/tickets/{ticket_id}/test-order")
def ticket_test_order(ticket_id: str, req: TicketTestOrder, request: Request, user: dict = Depends(require_roles("admin", "operator", "repairer"))):
    from ..security import client_ip

    return traced(create_test_order(user, ticket_id, req, client_ip(request)))


@router.post("/tickets/{ticket_id}/heartbeat")
def ticket_heartbeat(ticket_id: str, request: Request, user: dict = Depends(require_roles("admin", "operator", "repairer"))):
    from ..security import client_ip

    return traced(simulate_heartbeat(user, ticket_id, client_ip(request)))


@router.post("/tickets/{ticket_id}/close")
def ticket_close(ticket_id: str, request: Request, user: dict = Depends(require_roles("admin", "operator", "repairer"))):
    from ..security import client_ip

    return traced(close_ticket(user, ticket_id, client_ip(request)))


@router.get("/approvals")
def approvals(
    status_filter: str | None = Query(default=None, alias="status", max_length=24),
    type_filter: str | None = Query(default=None, alias="type", max_length=30),
    user: dict = Depends(current_user),
):
    return traced(list_approvals(user, status=status_filter, type_=type_filter))


@router.get("/approvals/{approval_id}")
def approval_detail(approval_id: str, user: dict = Depends(current_user)):
    return traced(get_approval(user, approval_id))


@router.post("/approvals", status_code=201)
def add_approval(
    req: ApprovalCreate,
    request: Request,
    idem: str | None = Header(default=None, alias="Idempotency-Key"),
    user: dict = Depends(current_user),
):
    from ..security import client_ip

    return traced(create_approval(user, req, idempotency_key(idem), client_ip(request)))


@router.post("/approvals/{approval_id}/decision")
def approval_decision(
    approval_id: str,
    req: ApprovalDecision,
    request: Request,
    user: dict = Depends(current_user),
):
    from ..security import client_ip

    return traced(decide_approval(user, approval_id, req, client_ip(request)))
