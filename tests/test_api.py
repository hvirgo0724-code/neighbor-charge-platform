"""Acceptance tests for the neighbourhood charging console.

Run with:
    pytest -q
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest


def _window(hours_from_now: int = 1, duration_minutes: int = 60) -> tuple[str, str]:
    start = datetime.now(timezone.utc) + timedelta(hours=hours_from_now)
    end = start + timedelta(minutes=duration_minutes)
    return start.isoformat(), end.isoformat()


def test_health_and_meta(client):
    health = client.get("/api/health")
    assert health.status_code == 200
    body = health.json()
    assert body["status"] == "ok"
    assert body["mode"] == "demo"
    assert body["checks"]["storage"]["status"] == "ok"
    meta = client.get("/api/meta").json()
    assert meta["app"]["version"]
    assert "admin" in meta["labels"]["roles"]


def test_login_and_me(client):
    response = client.post("/api/auth/login", json={"username": "operator", "password": "admin123"})
    assert response.status_code == 200
    data = response.json()
    assert data["user"]["role"] == "operator"
    assert data["token_type"] == "bearer"
    assert data["access_token"].count(".") == 2
    me = client.get("/api/auth/me", headers={"Authorization": f"Bearer {data['access_token']}"})
    assert me.status_code == 200
    assert me.json()["user"]["username"] == "operator"
    bad = client.post("/api/auth/login", json={"username": "operator", "password": "wrong"})
    assert bad.status_code == 401
    assert bad.json()["detail"]["code"] == "INVALID_CREDENTIALS"


def test_rbac_and_user_order_isolation(client, user_headers, admin_headers):
    forbidden = client.get("/api/users", headers=user_headers)
    assert forbidden.status_code == 403
    assert forbidden.json()["detail"]["code"] == "FORBIDDEN"
    report = client.get("/api/reports/operations", headers=user_headers)
    assert report.status_code == 403
    denied_audit = client.get("/api/audit?action=permission_denied", headers=admin_headers).json()
    assert any(entry["actor_id"] == "U004" for entry in denied_audit["items"])

    orders = client.get("/api/orders?page_size=100", headers=user_headers).json()
    assert orders["items"]
    assert all(item["user_id"] == "U004" for item in orders["items"])

    other = client.post("/api/auth/login", json={"username": "user2", "password": "admin123"}).json()
    other_headers = {"Authorization": f"Bearer {other['access_token']}"}
    other_orders = client.get("/api/orders?page_size=100", headers=other_headers).json()
    assert all(item["user_id"] == "U007" for item in other_orders["items"])
    foreign_id = orders["items"][0]["id"]
    assert client.get(f"/api/orders/{foreign_id}", headers=other_headers).status_code == 403


def test_tenant_isolation(client):
    data = client.post("/api/auth/login", json={"username": "cloudadmin", "password": "admin123"}).json()
    headers = {"Authorization": f"Bearer {data['access_token']}"}
    piles = client.get("/api/piles", headers=headers).json()
    assert piles["total"] == 1
    assert piles["items"][0]["id"] == "P901"
    communities = client.get("/api/communities", headers=headers).json()
    assert [item["id"] for item in communities["items"]] == ["C004"]
    assert client.get("/api/orders", headers=headers).json()["total"] == 0
    assert client.get("/api/orders/O1001", headers=headers).status_code == 403


def test_reservation_conflict_and_idempotency(client, user_headers):
    start, end = _window(2, 60)
    payload = {"pile_id": "P001", "starts_at": start, "ends_at": end, "note": "下班充电"}
    first = client.post("/api/reservations", json=payload, headers={**user_headers, "Idempotency-Key": "res-1"})
    assert first.status_code == 201, first.text
    order_id = first.json()["id"]
    retry = client.post("/api/reservations", json=payload, headers={**user_headers, "Idempotency-Key": "res-1"})
    assert retry.status_code == 201
    assert retry.json()["id"] == order_id

    other = client.post("/api/auth/login", json={"username": "user2", "password": "admin123"}).json()
    other_headers = {"Authorization": f"Bearer {other['access_token']}"}
    conflict = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": end},
        headers=other_headers,
    )
    assert conflict.status_code == 403  # user2 belongs to C002
    # A C001 resident cannot use a C002 pile either.
    assert client.post(
        "/api/reservations",
        json={"pile_id": "P006", "starts_at": start, "ends_at": end},
        headers=user_headers,
    ).status_code == 403


def test_reservation_conflict_between_users(client, admin_headers, user_headers):
    start, end = _window(3, 60)
    first = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": end},
        headers=user_headers,
    )
    assert first.status_code == 201
    conflict = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": end, "user_id": "U004"},
        headers=admin_headers,
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "RESERVATION_CONFLICT"
    assert conflict.json()["detail"]["conflicting_order"] == first.json()["id"]


def test_reservation_validation(client, user_headers):
    start, end = _window(1, 60)
    invalid = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": end, "ends_at": start},
        headers=user_headers,
    )
    assert invalid.status_code == 422
    too_long = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": (datetime.fromisoformat(start) + timedelta(hours=6)).isoformat()},
        headers=user_headers,
    )
    assert too_long.status_code == 400


def test_order_lifecycle(client, user_headers, admin_headers):
    start, end = _window(0, 60)
    created = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": end},
        headers=user_headers,
    )
    assert created.status_code == 201, created.text
    order_id = created.json()["id"]
    started = client.post(f"/api/orders/{order_id}/start", headers=user_headers)
    assert started.status_code == 200, started.text
    assert started.json()["status"] == "charging"
    completed = client.post(f"/api/orders/{order_id}/complete", json={"kwh": 4.5}, headers=user_headers)
    assert completed.status_code == 200, completed.text
    body = completed.json()
    assert body["status"] == "completed"
    assert body["amount"] == pytest.approx(round(4.5 * body["price"], 2))
    pile = client.get("/api/piles/P001", headers=admin_headers).json()
    assert pile["status"] == "available"


def test_device_event_idempotency_and_escalation(client, operator_headers):
    payload = {"event_id": "EVT-TEST-001", "pile_id": "P004", "event_type": "fault", "payload": {"code": "E-107"}}
    first = client.post("/api/device-events", json=payload, headers=operator_headers)
    assert first.status_code == 202
    body = first.json()
    assert body["duplicate"] is False
    assert body["ticket_id"]
    second = client.post("/api/device-events", json=payload, headers=operator_headers)
    assert second.status_code == 202
    assert second.json()["duplicate"] is True

    another = dict(payload, event_id="EVT-TEST-002", event_type="offline")
    third = client.post("/api/device-events", json=another, headers=operator_headers)
    assert third.status_code == 202
    assert third.json()["ticket_id"] == body["ticket_id"]
    ticket = client.get(f"/api/tickets/{body['ticket_id']}", headers=operator_headers).json()
    assert ticket["level"] == "P1"
    assert any(item["action"] == "escalated" for item in ticket["history"])


def test_ticket_close_requires_heartbeat_and_test_order(client, repairer_headers):
    detail = client.get("/api/tickets/T004", headers=repairer_headers).json()
    assert detail["status"] == "pending_acceptance"
    assert detail["verification"]["can_close"] is False
    blocked = client.post("/api/tickets/T004/close", headers=repairer_headers)
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "TICKET_VERIFICATION_FAILED"

    heartbeat = client.post("/api/tickets/T004/heartbeat", headers=repairer_headers)
    assert heartbeat.status_code == 200
    test_order = client.post("/api/tickets/T004/test-order", json={"kwh": 0.5}, headers=repairer_headers)
    assert test_order.status_code == 200, test_order.text
    ticket_after = test_order.json()["ticket"]
    assert ticket_after["verification"]["test_order_id"]
    assert ticket_after["verification"]["can_close"] is True

    closed = client.post("/api/tickets/T004/close", headers=repairer_headers)
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "closed"
    pile = client.get("/api/piles/P004", headers=repairer_headers).json()
    assert pile["status"] == "available"


def test_agent_read_query_has_sources_and_trace(client, operator_headers):
    response = client.post(
        "/api/agent/chat",
        json={"message": "分析当前充电桩故障和维修情况"},
        headers=operator_headers,
    )
    assert response.status_code == 200
    body = response.json()
    assert body["risk"] == "low"
    assert body["status"] == "completed"
    assert body["data_sources"]
    assert body["trace_id"]
    assert [node["node"] for node in body["nodes"]][:4] == [
        "parse_intent", "load_context", "check_permission", "plan_action",
    ]
    assert body["answer"]


def _completed_order(client, headers) -> dict:
    orders = client.get("/api/orders?status=completed&page_size=100", headers=headers).json()["items"]
    order = next(item for item in orders if item["community_id"] == "C001" and float(item["amount"]) > 0)
    return order


def test_agent_refund_creates_approval_not_execution(client, operator_headers, finance_headers):
    order = _completed_order(client, operator_headers)
    response = client.post(
        "/api/agent/chat",
        json={"message": f"为订单 {order['id']} 申请退款 {order['amount']} 元"},
        headers=operator_headers,
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["risk"] == "high"
    assert body["status"] == "pending_approval"
    assert body["approval_id"]
    assert body["requires_approval"] is True
    assert "未" in body["answer"] or "待审批" in body["answer"]
    unchanged = client.get(f"/api/orders/{order['id']}", headers=operator_headers).json()
    assert unchanged["status"] == "completed"

    decision = client.post(
        f"/api/approvals/{body['approval_id']}/decision",
        json={"approved": True, "comment": "同意退款，客服已确认。"},
        headers=finance_headers,
    )
    assert decision.status_code == 200, decision.text
    assert decision.json()["status"] == "executed"
    refunded = client.get(f"/api/orders/{order['id']}", headers=operator_headers).json()
    assert refunded["status"] == "refunded"
    duplicate = client.post(
        f"/api/approvals/{body['approval_id']}/decision",
        json={"approved": True, "comment": "重复审批"},
        headers=finance_headers,
    )
    assert duplicate.status_code == 409


def test_agent_stop_requires_approval_and_permission(client, operator_headers, finance_headers, user_headers):
    denied = client.post(
        "/api/agent/chat",
        json={"message": "暂停 P003 停机检修 8 小时"},
        headers=user_headers,
    )
    assert denied.status_code == 200
    assert denied.json()["status"] == "denied"

    response = client.post(
        "/api/agent/chat",
        json={"message": "暂停 P003 停机检修 8 小时"},
        headers=operator_headers,
    )
    body = response.json()
    assert body["status"] == "pending_approval"
    assert body["approval_id"]
    before = client.get("/api/piles/P003", headers=operator_headers).json()
    assert before["status"] == "fault"
    decision = client.post(
        f"/api/approvals/{body['approval_id']}/decision",
        json={"approved": True, "comment": "同意停机检修。"},
        headers=finance_headers,
    )
    assert decision.status_code == 200
    after = client.get("/api/piles/P003", headers=operator_headers).json()
    assert after["status"] == "offline"


def test_approval_self_review_forbidden(client, admin_headers):
    order = _completed_order(client, admin_headers)
    response = client.post(
        "/api/agent/chat",
        json={"message": f"为订单 {order['id']} 申请退款 1 元"},
        headers=admin_headers,
    )
    body = response.json()
    assert body["status"] == "pending_approval"
    decision = client.post(
        f"/api/approvals/{body['approval_id']}/decision",
        json={"approved": True, "comment": "自己批自己"},
        headers=admin_headers,
    )
    assert decision.status_code == 403


def test_validation_and_unauthenticated(client):
    assert client.get("/api/piles").status_code == 401
    invalid = client.post(
        "/api/device-events",
        json={"event_id": "EVT-X", "pile_id": "P001", "event_type": "not-a-type"},
        headers={"Authorization": "Bearer invalid"},
    )
    assert invalid.status_code == 401
    login = client.post("/api/auth/login", json={"username": "admin", "password": "admin123"}).json()
    headers = {"Authorization": f"Bearer {login['access_token']}"}
    bad = client.post(
        "/api/device-events",
        json={"event_id": "EVT-X", "pile_id": "P001", "event_type": "not-a-type"},
        headers=headers,
    )
    assert bad.status_code == 422
    assert bad.json()["detail"]["code"] == "VALIDATION_ERROR"
    unexpected = client.post(
        "/api/auth/login",
        json={"username": "admin", "password": "admin123", "role": "admin"},
    )
    assert unexpected.status_code == 422


def test_report_and_audit(client, admin_headers):
    report = client.get("/api/reports/operations?days=7", headers=admin_headers)
    assert report.status_code == 200
    body = report.json()
    assert len(body["trend"]) == 7
    assert body["communities"]
    assert body["kpis"]["revenue"] >= 0
    assert "mttr_hours" in body["kpis"]
    csv_response = client.get("/api/reports/operations.csv?days=7", headers=admin_headers)
    assert csv_response.status_code == 200
    assert "text/csv" in csv_response.headers["content-type"]
    assert "邻里充电运营报表" in csv_response.content.decode("utf-8-sig")
    audit = client.get("/api/audit?limit=50", headers=admin_headers).json()
    actions = {entry["action"] for entry in audit["items"]}
    assert "login" in actions
    assert "report_export" in actions


def test_storage_failure_is_identifiable(client, user_headers, monkeypatch):
    from app.store import StoreUnavailable, store

    def boom():
        raise StoreUnavailable("模拟数据文件写入失败")

    monkeypatch.setattr(store, "_save", boom)
    start, end = _window(2, 60)
    response = client.post(
        "/api/reservations",
        json={"pile_id": "P001", "starts_at": start, "ends_at": end},
        headers=user_headers,
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "STORE_UNAVAILABLE"
    assert response.json()["detail"]["trace_id"]
