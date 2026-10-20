"""Deterministic demo data for the neighbourhood charging console.

The seed intentionally covers every state the console can display: healthy and
faulty piles, a live charging session, a future reservation, tickets at each
workflow step, pending approvals and two weeks of order history so the report
charts have something meaningful to draw.
"""
from __future__ import annotations

import random
from datetime import timedelta

from .config import settings
from .core import iso, now, start_of_day
from .passwords import hash_password

SEED_VERSION = 1

COMMUNITIES = [
    {
        "id": "C001",
        "tenant_id": "T001",
        "org_id": "ORG001",
        "name": "阳光花园社区",
        "address": "北京市朝阳区望京街道阜安西路 8 号",
        "city": "北京市",
        "district": "朝阳区",
        "contact": "张敏",
        "phone": "138****6621",
        "created_at": None,
    },
    {
        "id": "C002",
        "tenant_id": "T001",
        "org_id": "ORG001",
        "name": "枫林雅苑",
        "address": "北京市海淀区上地十街 2 号",
        "city": "北京市",
        "district": "海淀区",
        "contact": "周航",
        "phone": "139****3087",
        "created_at": None,
    },
    {
        "id": "C003",
        "tenant_id": "T001",
        "org_id": "ORG002",
        "name": "星河湾",
        "address": "北京市丰台区科技园 18 号",
        "city": "北京市",
        "district": "丰台区",
        "contact": "刘洋",
        "phone": "137****5512",
        "created_at": None,
    },
    {
        "id": "C004",
        "tenant_id": "T002",
        "org_id": "ORG003",
        "name": "云栖公寓",
        "address": "杭州市余杭区文一西路 969 号",
        "city": "杭州市",
        "district": "余杭区",
        "contact": "沈宁",
        "phone": "136****0108",
        "created_at": None,
    },
]

PILES = [
    ("P001", "C001", "A 区-01", "邻里 AC7", "国标交流", 7.0, 1.20, "available", 0, 4, 26.4, 1820.5),
    ("P002", "C001", "A 区-02", "邻里 AC7", "国标交流", 7.0, 1.20, "charging", 0, 0, 18.2, 1744.8),
    ("P003", "C001", "A 区-03", "邻里 AC7", "国标交流", 7.0, 1.20, "fault", 3, 25, 3.6, 1422.1),
    ("P004", "C001", "B 区-01", "邻里 AC11", "国标交流", 11.0, 1.50, "available", 1, 2, 21.8, 2210.7),
    ("P005", "C001", "B 区-02", "邻里 AC11", "国标交流", 11.0, 1.50, "reserved", 0, 1, 12.4, 1688.3),
    ("P006", "C002", "1 号楼-01", "邻里 AC7", "国标交流", 7.0, 1.10, "available", 0, 3, 19.5, 1510.2),
    ("P007", "C002", "1 号楼-02", "邻里 AC7", "国标交流", 7.0, 1.10, "charging", 1, 0, 16.7, 1432.6),
    ("P008", "C002", "2 号楼-01", "邻里 AC7", "国标交流", 7.0, 1.10, "offline", 2, 45, 8.1, 1367.0),
    ("P009", "C002", "2 号楼-02", "邻里 AC11", "国标交流", 11.0, 1.35, "available", 0, 5, 24.9, 1902.4),
    ("P010", "C003", "地库 A-01", "星速 DC60", "国标直流", 60.0, 1.80, "available", 0, 1, 48.2, 3021.9),
    ("P011", "C003", "地库 A-02", "星速 DC60", "国标直流", 60.0, 1.80, "maintenance", 1, 130, 6.3, 2544.2),
    ("P012", "C003", "地库 B-01", "邻里 AC11", "国标交流", 11.0, 1.35, "available", 0, 6, 22.1, 1833.6),
    ("P901", "C004", "云栖-01", "云栖 AC7", "国标交流", 7.0, 1.00, "available", 0, 2, 11.2, 421.7),
]


def _stamp(days_ago: int = 0, hours: int = 0, minutes: int = 0) -> str:
    base = start_of_day(days_ago) + timedelta(hours=hours, minutes=minutes)
    return iso(base)


def build_seed() -> dict:
    current = now()
    today = start_of_day(0)
    demo_hash = hash_password(settings.demo_password)
    rng = random.Random(20261020)

    communities = []
    for item in COMMUNITIES:
        record = dict(item)
        record["created_at"] = _stamp(180, 9, 0)
        communities.append(record)

    orgs = [
        {"id": "ORG001", "tenant_id": "T001", "name": "邻里充电自营", "created_at": _stamp(365, 9, 0)},
        {"id": "ORG002", "tenant_id": "T001", "name": "星河湾物业", "created_at": _stamp(300, 9, 0)},
        {"id": "ORG003", "tenant_id": "T002", "name": "云栖物业服务", "created_at": _stamp(120, 9, 0)},
    ]

    tenants = [
        {"id": "T001", "name": "邻里充电运营中心", "plan": "enterprise", "status": "active", "created_at": _stamp(365, 9, 0)},
        {"id": "T002", "name": "云栖智充", "plan": "standard", "status": "active", "created_at": _stamp(120, 9, 0)},
    ]

    users = [
        {
            "id": "U001", "tenant_id": "T001", "username": "admin", "display_name": "系统管理员",
            "role": "admin", "community_ids": ["C001", "C002", "C003"], "phone": "138****0001",
            "email": "admin@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(300, 9, 0), "last_login_at": _stamp(0, 8, 42),
        },
        {
            "id": "U002", "tenant_id": "T001", "username": "operator", "display_name": "李静",
            "role": "operator", "community_ids": ["C001", "C002"], "phone": "139****2218",
            "email": "lijing@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(280, 10, 0), "last_login_at": _stamp(0, 9, 5),
        },
        {
            "id": "U003", "tenant_id": "T001", "username": "repairer", "display_name": "王强",
            "role": "repairer", "community_ids": ["C001", "C002"], "phone": "137****9043",
            "email": "wangqiang@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(270, 11, 0), "last_login_at": _stamp(0, 8, 12),
        },
        {
            "id": "U004", "tenant_id": "T001", "username": "user", "display_name": "陈晨",
            "role": "user", "community_ids": ["C001"], "phone": "136****7758",
            "email": "chenchen@example.com", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(150, 19, 0), "last_login_at": _stamp(0, 7, 48),
        },
        {
            "id": "U005", "tenant_id": "T001", "username": "finance", "display_name": "赵敏",
            "role": "finance", "community_ids": ["C001", "C002", "C003"], "phone": "135****3388",
            "email": "zhaomin@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(260, 9, 30), "last_login_at": _stamp(0, 9, 20),
        },
        {
            "id": "U006", "tenant_id": "T001", "username": "operator3", "display_name": "刘洋",
            "role": "operator", "community_ids": ["C003"], "phone": "134****1176",
            "email": "liuyang@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(200, 14, 0), "last_login_at": _stamp(1, 17, 5),
        },
        {
            "id": "U007", "tenant_id": "T001", "username": "user2", "display_name": "林小雨",
            "role": "user", "community_ids": ["C002"], "phone": "133****4419",
            "email": "linxiaoyu@example.com", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(120, 20, 0), "last_login_at": _stamp(2, 19, 30),
        },
        {
            "id": "U008", "tenant_id": "T001", "username": "repairer3", "display_name": "周凯",
            "role": "repairer", "community_ids": ["C003"], "phone": "132****0921",
            "email": "zhoukai@neighbor-charge.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(180, 10, 0), "last_login_at": _stamp(1, 10, 20),
        },
        {
            "id": "U901", "tenant_id": "T002", "username": "cloudadmin", "display_name": "沈宁",
            "role": "admin", "community_ids": ["C004"], "phone": "131****5560",
            "email": "shenning@yunqi.example", "status": "active", "password_hash": demo_hash,
            "created_at": _stamp(90, 9, 0), "last_login_at": None,
        },
    ]

    piles = []
    for index, (pid, cid, code, model, connector, power, price, status, faults, seen_minutes, today_kwh, total_kwh) in enumerate(PILES):
        last_seen = current - timedelta(minutes=seen_minutes) if seen_minutes else current - timedelta(minutes=rng.randint(1, 4))
        piles.append({
            "id": pid,
            "tenant_id": "T002" if pid == "P901" else "T001",
            "community_id": cid,
            "code": code,
            "model": model,
            "connector": connector,
            "power": power,
            "price": price,
            "status": status,
            "faults": faults,
            "last_seen": iso(last_seen),
            "temperature": round(28 + rng.random() * 12 + (18 if status in {"fault", "offline"} else 0), 1),
            "last_power": round(power * (0.82 if status == "charging" else 0), 2),
            "today_kwh": today_kwh,
            "total_kwh": total_kwh,
            "firmware": "v2.4.1" if index % 3 else "v2.3.8",
            "installed_at": _stamp(150 - index * 3, 10, 0),
            "created_at": _stamp(150 - index * 3, 10, 0),
        })

    users_by_community = {
        "C001": ["U004", "U001", "U002"],
        "C002": ["U007", "U001", "U002"],
        "C003": ["U001", "U006"],
        "C004": ["U901"],
    }
    piles_by_community: dict[str, list[dict]] = {}
    for pile in piles:
        piles_by_community.setdefault(pile["community_id"], []).append(pile)

    orders: list[dict] = []
    order_seq = 1001
    for day in range(13, -1, -1):
        session_count = rng.randint(3, 7)
        for _ in range(session_count):
            community = rng.choice(["C001", "C001", "C002", "C002", "C003"])
            candidates = [p for p in piles_by_community[community] if p["status"] != "maintenance"]
            pile = rng.choice(candidates)
            user_id = rng.choice(users_by_community[community])
            hour = rng.choice([7, 8, 9, 12, 13, 18, 19, 20, 21, 22])
            minute = rng.randint(0, 59)
            created = today - timedelta(days=day) + timedelta(hours=hour, minutes=minute)
            if created > current - timedelta(minutes=15):
                continue
            duration = rng.randint(40, 220)
            kwh = round(pile["power"] * duration / 60 * rng.uniform(0.55, 0.92), 2)
            amount = round(kwh * pile["price"], 2)
            status = "completed"
            roll = rng.random()
            if roll < 0.04:
                status = "refunded"
            elif roll < 0.06:
                status = "cancelled"
            record = {
                "id": f"O{order_seq}",
                "tenant_id": "T001",
                "user_id": user_id,
                "pile_id": pile["id"],
                "community_id": community,
                "status": status,
                "amount": amount,
                "kwh": kwh,
                "price": pile["price"],
                "created_at": iso(created),
                "reserved_start": iso(created - timedelta(minutes=5)),
                "reserved_end": iso(created + timedelta(minutes=duration + 15)),
                "started_at": iso(created + timedelta(minutes=rng.randint(0, 4))),
                "completed_at": iso(created + timedelta(minutes=duration)) if status in {"completed", "refunded"} else None,
                "idempotency_key": None,
                "is_test": False,
                "ticket_id": None,
                "refund_amount": 0.0,
                "refunded_at": None,
                "cancelled_at": None,
                "cancel_reason": None,
                "trace_id": None,
                "note": None,
            }
            if status == "refunded":
                record["refund_amount"] = amount
                record["refunded_at"] = iso(created + timedelta(hours=2))
            if status == "cancelled":
                record["cancelled_at"] = iso(created + timedelta(minutes=12))
                record["cancel_reason"] = "用户临时取消"
            orders.append(record)
            order_seq += 1

    # Active sessions and a future reservation keep the console alive.
    active_pile = next(p for p in piles if p["id"] == "P002")
    reserved_pile = next(p for p in piles if p["id"] == "P005")
    charging_started = current - timedelta(minutes=46)
    reservation_start = current + timedelta(hours=2)
    future = {
        "id": "O2001", "tenant_id": "T001", "user_id": "U004", "pile_id": "P005",
        "community_id": "C001", "status": "reserved", "amount": 0.0, "kwh": 0.0,
        "price": reserved_pile["price"], "created_at": iso(current - timedelta(minutes=18)),
        "reserved_start": iso(reservation_start), "reserved_end": iso(reservation_start + timedelta(hours=2)),
        "started_at": None, "completed_at": None, "idempotency_key": "seed-reservation-1",
        "is_test": False, "ticket_id": None, "refund_amount": 0.0, "refunded_at": None,
        "cancelled_at": None, "cancel_reason": None, "trace_id": None, "note": "下班后充电",
    }
    charging_one = {
        "id": "O2002", "tenant_id": "T001", "user_id": "U004", "pile_id": "P002",
        "community_id": "C001", "status": "charging", "amount": 0.0, "kwh": 4.6,
        "price": active_pile["price"], "created_at": iso(charging_started - timedelta(minutes=4)),
        "reserved_start": iso(charging_started - timedelta(minutes=10)),
        "reserved_end": iso(charging_started + timedelta(hours=3)),
        "started_at": iso(charging_started), "completed_at": None, "idempotency_key": None,
        "is_test": False, "ticket_id": None, "refund_amount": 0.0, "refunded_at": None,
        "cancelled_at": None, "cancel_reason": None, "trace_id": None, "note": None,
    }
    charging_two = {
        "id": "O2003", "tenant_id": "T001", "user_id": "U007", "pile_id": "P007",
        "community_id": "C002", "status": "charging", "amount": 0.0, "kwh": 3.1,
        "price": 1.10, "created_at": iso(current - timedelta(minutes=38)),
        "reserved_start": iso(current - timedelta(minutes=45)),
        "reserved_end": iso(current + timedelta(hours=2)),
        "started_at": iso(current - timedelta(minutes=32)), "completed_at": None,
        "idempotency_key": None, "is_test": False, "ticket_id": None, "refund_amount": 0.0,
        "refunded_at": None, "cancelled_at": None, "cancel_reason": None, "trace_id": None, "note": None,
    }
    test_order = {
        "id": "O2004", "tenant_id": "T001", "user_id": "U003", "pile_id": "P006",
        "community_id": "C002", "status": "completed", "amount": 0.0, "kwh": 0.4,
        "price": 0.0, "created_at": iso(current - timedelta(days=3, hours=1)),
        "reserved_start": iso(current - timedelta(days=3, hours=1)),
        "reserved_end": iso(current - timedelta(days=3, hours=1) + timedelta(minutes=20)),
        "started_at": iso(current - timedelta(days=3, hours=1)),
        "completed_at": iso(current - timedelta(days=3, hours=1) + timedelta(minutes=12)),
        "idempotency_key": None, "is_test": True, "ticket_id": "T005",
        "refund_amount": 0.0, "refunded_at": None, "cancelled_at": None,
        "cancel_reason": None, "trace_id": None, "note": "工单验收测试订单",
    }
    recent_user_orders = []
    for index, (days_ago, hours_ago, kwh) in enumerate(((1, 3, 6.4), (2, 5, 9.2), (4, 2, 4.8))):
        completed_at = current - timedelta(days=days_ago, hours=hours_ago)
        recent_user_orders.append({
            "id": f"O200{5 + index}", "tenant_id": "T001", "user_id": "U004", "pile_id": "P004",
            "community_id": "C001", "status": "completed", "amount": round(kwh * 1.50, 2),
            "kwh": kwh, "price": 1.50, "created_at": iso(completed_at - timedelta(minutes=55)),
            "reserved_start": iso(completed_at - timedelta(minutes=65)),
            "reserved_end": iso(completed_at - timedelta(minutes=5)),
            "started_at": iso(completed_at - timedelta(minutes=52)),
            "completed_at": iso(completed_at), "idempotency_key": None, "is_test": False,
            "ticket_id": None, "refund_amount": 0.0, "refunded_at": None,
            "cancelled_at": None, "cancel_reason": None, "trace_id": None, "note": None,
        })
    orders.extend([future, charging_one, charging_two, test_order, *recent_user_orders])

    refund_order = next(
        (
            order for order in orders
            if order["user_id"] == "U004" and order["status"] == "completed"
            and float(order.get("amount", 0)) >= 10
        ),
        next((order for order in orders if order["status"] == "completed" and float(order.get("amount", 0)) > 0), None),
    )
    refund_order_id = refund_order["id"] if refund_order else "O1005"
    refund_amount = round(float(refund_order.get("amount", 18.6)) if refund_order else 18.6, 2)

    ticket_specs = [
        {
            "id": "T001", "pile_id": "P003", "level": "P1", "status": "open",
            "title": "A 区-03 连续充电中断", "description": "设备连续 3 次在充电 10 分钟内中断，最近一次心跳已超过 25 分钟。",
            "assignee_id": None, "created_at": iso(current - timedelta(hours=3, minutes=10)),
            "due_at": iso(current - timedelta(hours=1, minutes=10)), "closed_at": None,
            "resolution": None, "history": [],
        },
        {
            "id": "T002", "pile_id": "P008", "level": "P1", "status": "assigned",
            "title": "2 号楼-01 设备离线", "description": "设备离线超过 30 分钟，影响晚高峰预约。",
            "assignee_id": "U003", "created_at": iso(current - timedelta(minutes=48)),
            "due_at": iso(current + timedelta(hours=1, minutes=12)), "closed_at": None,
            "resolution": None, "history": [],
        },
        {
            "id": "T003", "pile_id": "P011", "level": "P2", "status": "processing",
            "title": "地库 A-02 功率模块告警", "description": "直流桩输出功率持续低于额定值 40%，已安排现场检测。",
            "assignee_id": "U008", "created_at": iso(current - timedelta(days=1, hours=2)),
            "due_at": iso(current - timedelta(hours=16)), "closed_at": None,
            "resolution": None, "history": [],
        },
        {
            "id": "T004", "pile_id": "P004", "level": "P3", "status": "pending_acceptance",
            "title": "B 区-01 充电枪锁止异常", "description": "用户反馈枪头拔出困难，现场检查为锁止机构磨损。",
            "assignee_id": "U003", "created_at": iso(current - timedelta(days=2, hours=4)),
            "due_at": iso(current + timedelta(hours=18)), "closed_at": None,
            "resolution": "已更换充电枪锁止机构并完成上电自检，待验收。",
            "history": [],
        },
        {
            "id": "T005", "pile_id": "P006", "level": "P2", "status": "closed",
            "title": "1 号楼-01 刷卡模块无响应", "description": "刷卡模块偶发无响应，重启后恢复。",
            "assignee_id": "U003", "created_at": iso(current - timedelta(days=4, hours=5)),
            "due_at": iso(current - timedelta(days=3, hours=21)), "closed_at": iso(current - timedelta(days=3, minutes=40)),
            "resolution": "更换刷卡模块并完成测试订单验收。",
            "history": [],
        },
        {
            "id": "T006", "pile_id": "P007", "level": "P3", "status": "open",
            "title": "1 号楼-02 充电功率波动", "description": "近 2 小时功率在 4.1kW 至 6.8kW 之间波动，需远程排查。",
            "assignee_id": None, "created_at": iso(current - timedelta(minutes=22)),
            "due_at": iso(current + timedelta(hours=23, minutes=38)), "closed_at": None,
            "resolution": None, "history": [],
        },
    ]
    tickets = []
    for spec in ticket_specs:
        pile = next(p for p in piles if p["id"] == spec["pile_id"])
        created = spec["created_at"]
        history = [
            {"at": created, "action": "created", "actor_id": "system", "actor_name": "设备监控", "note": "故障规则自动生成工单"},
        ]
        if spec["assignee_id"]:
            history.append({"at": iso(current - timedelta(hours=1)), "action": "assigned", "actor_id": "U002", "actor_name": "李静", "note": "按区域分派"})
        if spec["status"] in {"processing", "pending_acceptance", "closed"}:
            history.append({"at": iso(current - timedelta(hours=5)), "action": "accepted", "actor_id": spec["assignee_id"] or "U003", "actor_name": "维修工程师", "note": "已接单，前往现场"})
        if spec["status"] in {"pending_acceptance", "closed"}:
            history.append({"at": iso(current - timedelta(hours=1)), "action": "resolved", "actor_id": spec["assignee_id"] or "U003", "actor_name": "维修工程师", "note": spec["resolution"] or "处理完成"})
        record = {
            "id": spec["id"], "tenant_id": "T001", "pile_id": spec["pile_id"],
            "community_id": pile["community_id"], "level": spec["level"], "title": spec["title"],
            "description": spec["description"], "status": spec["status"],
            "assignee_id": spec["assignee_id"], "created_at": created,
            "updated_at": history[-1]["at"], "due_at": spec["due_at"],
            "closed_at": spec["closed_at"], "resolution": spec["resolution"],
            "verification": {"heartbeat_at": None, "test_order_id": "O2004" if spec["id"] == "T005" else None, "verified_at": spec["closed_at"]},
            "history": history, "source": "device_rule" if spec["id"] != "T004" else "user_report",
        }
        tickets.append(record)

    approvals = [
        {
            "id": "AP1001", "tenant_id": "T001", "type": "refund",
            "title": "订单退款审批", "reason": "充电 18 分钟后设备中断，用户申请退还本次费用。",
            "payload": {"order_id": refund_order_id, "amount": refund_amount},
            "impact": f"订单 {refund_order_id} · 阳光花园社区 · 退款 ¥{refund_amount:.2f}",
            "amount": refund_amount, "risk": "high",
            "risk_factors": ["涉及资金退回", "将改变订单状态", "需要财务复核"],
            "status": "pending", "requester_id": "U004", "requester_name": "陈晨",
            "created_at": iso(current - timedelta(hours=1, minutes=5)),
            "decided_by": None, "decided_at": None, "decision_comment": None,
            "executed_at": None, "execution_result": None, "trace_id": None, "idempotency_key": None,
        },
        {
            "id": "AP1002", "tenant_id": "T001", "type": "price_change",
            "title": "社区电价调整审批", "reason": "晚高峰供需紧张，建议将阳光花园服务费从 1.20 元/度调整为 1.50 元/度。",
            "payload": {"community_id": "C001", "pile_ids": ["P001", "P002", "P003", "P004", "P005"], "old_price": 1.20, "new_price": 1.50},
            "impact": "阳光花园社区 · 5 台设备 · 电价 +25.0%",
            "amount": 0.0, "risk": "high",
            "risk_factors": ["影响全部在网设备", "价格变动超过 20%", "涉及居民账单"],
            "status": "pending", "requester_id": "U002", "requester_name": "李静",
            "created_at": iso(current - timedelta(minutes=34)),
            "decided_by": None, "decided_at": None, "decision_comment": None,
            "executed_at": None, "execution_result": None, "trace_id": None, "idempotency_key": None,
        },
        {
            "id": "AP1003", "tenant_id": "T001", "type": "stop_pile",
            "title": "停机检修审批", "reason": "2 号楼-01 离线且温度偏高，需停机检修。",
            "payload": {"pile_id": "P008", "duration_hours": 8},
            "impact": "枫林雅苑 · 2 号楼-01 · 停机 8 小时",
            "amount": 0.0, "risk": "high",
            "risk_factors": ["设备将停止服务", "影响已预约用户"],
            "status": "executed", "requester_id": "U002", "requester_name": "李静",
            "created_at": iso(current - timedelta(days=2, hours=3)),
            "decided_by": "U005", "decided_at": iso(current - timedelta(days=2, hours=2)),
            "decision_comment": "同意停机，已通知物业。",
            "executed_at": iso(current - timedelta(days=2, hours=2)), "execution_result": "P008 已置为离线并创建 P1 工单 T002",
            "trace_id": None, "idempotency_key": None,
        },
        {
            "id": "AP1004", "tenant_id": "T001", "type": "refund",
            "title": "订单退款审批", "reason": "用户主张未充电但产生费用。",
            "payload": {"order_id": "O2003", "amount": 12.0},
            "impact": "订单 O2003 · 枫林雅苑 · 退款 ¥12.00",
            "amount": 12.0, "risk": "high",
            "risk_factors": ["涉及资金退回"],
            "status": "rejected", "requester_id": "U007", "requester_name": "林小雨",
            "created_at": iso(current - timedelta(days=1, hours=6)),
            "decided_by": "U005", "decided_at": iso(current - timedelta(days=1, hours=5)),
            "decision_comment": "订单仍在充电中，不符合退款条件，已驳回。",
            "executed_at": None, "execution_result": None, "trace_id": None, "idempotency_key": None,
        },
    ]

    events = [
        {"id": "EVT-SEED-001", "tenant_id": "T001", "pile_id": "P003", "event_type": "charge_interrupted", "payload": {"reason": "gun_lock", "session_kwh": 0.8}, "occurred_at": iso(current - timedelta(hours=3, minutes=10)), "processed_at": iso(current - timedelta(hours=3, minutes=10)), "trace_id": None},
        {"id": "EVT-SEED-002", "tenant_id": "T001", "pile_id": "P003", "event_type": "fault", "payload": {"code": "E-107", "temperature": 71.5}, "occurred_at": iso(current - timedelta(minutes=25)), "processed_at": iso(current - timedelta(minutes=25)), "trace_id": None},
        {"id": "EVT-SEED-003", "tenant_id": "T001", "pile_id": "P008", "event_type": "offline", "payload": {"last_rssi": -87}, "occurred_at": iso(current - timedelta(minutes=45)), "processed_at": iso(current - timedelta(minutes=45)), "trace_id": None},
        {"id": "EVT-SEED-004", "tenant_id": "T001", "pile_id": "P002", "event_type": "power", "payload": {"power": 6.8, "current": 30.4}, "occurred_at": iso(current - timedelta(minutes=3)), "processed_at": iso(current - timedelta(minutes=3)), "trace_id": None},
        {"id": "EVT-SEED-005", "tenant_id": "T001", "pile_id": "P007", "event_type": "temperature", "payload": {"temperature": 46.2}, "occurred_at": iso(current - timedelta(minutes=6)), "processed_at": iso(current - timedelta(minutes=6)), "trace_id": None},
    ]

    audit = []
    for index, entry in enumerate([
        ("login", "U001", "系统管理员", "admin", "auth", "U001", "登录运营平台", 0, 8, 42),
        ("create_reservation", "U004", "陈晨", "user", "order", "O2001", "预约 B 区-02，18:00-20:00", 0, 14, 5),
        ("agent_chat", "U002", "李静", "operator", "agent", "thread-1", "分析故障并生成维修建议", 0, 9, 6),
        ("approval_created", "U002", "李静", "operator", "approval", "AP1002", "提交社区电价调整审批", 0, 13, 48),
        ("device_event", "device-gateway", "设备网关", "service", "pile", "P003", "接收故障事件 EVT-SEED-002", 0, 14, 12),
        ("ticket_assigned", "U002", "李静", "operator", "ticket", "T002", "分派给王强", 0, 13, 30),
        ("approval_executed", "U005", "赵敏", "finance", "approval", "AP1003", "批准并执行停机审批", 2, 12, 0),
        ("order_completed", "U007", "林小雨", "user", "order", "O2003", "充电完成，结算 ¥12.00", 1, 20, 10),
        ("permission_denied", "U004", "陈晨", "user", "approval", "AP1004", "尝试审批非本人权限范围申请", 1, 11, 0),
        ("report_export", "U001", "系统管理员", "admin", "report", "operations", "导出近 7 日运营报表", 3, 9, 15),
    ]):
        action, actor_id, actor_name, role, target_type, target_id, detail, days_ago, hour, minute = entry
        audit.append({
            "id": f"AU{index + 1:04d}", "tenant_id": "T001", "trace_id": f"seed-{index + 1:04d}",
            "actor_id": actor_id, "actor_name": actor_name, "actor_role": role,
            "action": action, "target_type": target_type, "target_id": target_id,
            "detail": detail, "ip": "127.0.0.1", "at": _stamp(days_ago, hour, minute),
        })

    threads = {        "thread-demo": {
            "id": "thread-demo", "tenant_id": "T001", "user_id": "U002",
            "title": "晚高峰设备健康检查",
            "messages": [
                {"role": "user", "content": "分析当前充电桩故障和维修情况", "at": iso(current - timedelta(minutes=35))},
                {"role": "agent", "content": "当前 2 台设备处于故障/离线状态，P1 工单 2 个。建议优先处理 A 区-03 的充电中断。", "at": iso(current - timedelta(minutes=35))},
            ],
            "created_at": iso(current - timedelta(minutes=35)), "updated_at": iso(current - timedelta(minutes=35)),
        }
    }

    if refund_order is not None:
        refund_order["refund_pending_approval"] = "AP1001"

    return {
        "meta": {
            "schema_version": SEED_VERSION,
            "seeded_at": iso(current),
            "reservation_attempts": 186,
            "reservation_success": 171,
            "agent_runs": 37,
            "login_count": 428,
        },
        "tenants": {item["id"]: item for item in tenants},
        "orgs": {item["id"]: item for item in orgs},
        "communities": {item["id"]: item for item in communities},
        "users": {item["id"]: item for item in users},
        "piles": {item["id"]: item for item in piles},
        "orders": {item["id"]: item for item in orders},
        "events": {item["id"]: item for item in events},
        "tickets": {item["id"]: item for item in tickets},
        "approvals": {item["id"]: item for item in approvals},
        "audit": audit,
        "threads": threads,
        "memories": [
            {"id": "M001", "tenant_id": "T001", "user_id": "U002", "summary": "阳光花园 A 区北侧信号较弱，离线事件多发生在雨天。", "created_at": iso(current - timedelta(days=12))},
            {"id": "M002", "tenant_id": "T001", "user_id": "U002", "summary": "晚高峰 18:00-21:00 预约冲突率最高，建议预留 10% 机动桩。", "created_at": iso(current - timedelta(days=5))},
        ],
    }
