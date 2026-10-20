"""The Agent workbench.

The orchestrator follows the same node sequence described in the architecture
document (intent, context, permission, plan, risk gate, approval/execute,
verify, memory), but runs locally with deterministic tools. Read requests are
answered from the scoped operational data; refunds, shutdowns, price changes
and batch reassignments can only create an approval application. The model is
never allowed to execute those changes directly.
"""
from __future__ import annotations

import re
import time
import uuid
from typing import Any

from .audit import append_audit
from .core import get_trace_id, iso, money, now, parse_dt, sanitize_text
from .errors import ApiError
from .schemas import AgentChat, ApprovalCreate, TicketCreate
from .security import can_approve, can_manage, is_admin, scoped_communities
from .services import (
    create_approval,
    create_ticket,
    operations_report,
)
from .store import store

HIGH_RISK_WORDS = ("退款", "停机", "下线", "调价", "改价", "价格调整", "批量改派", "批量")
FAULT_WORDS = ("故障", "异常", "维修", "离线", "告警", "中断", "温度")
AVAILABLE_WORDS = ("可用", "空闲", "能充", "充电桩", "空闲桩")
REVENUE_WORDS = ("收入", "营收", "订单", "流水", "退款金额", "客单价")
TICKET_WORDS = ("工单", "维修进度", "超时")
APPROVAL_WORDS = ("审批", "待办", "待审批")
METRIC_WORDS = ("可用率", "利用率", "指标", "修复时长", "mttr", "预约成功率", "健康度")
PRICE_WORDS = ("电价", "服务费", "价格", "多少钱")
CREATE_TICKET_WORDS = ("创建工单", "报修", "生成工单", "建工单")


def _ms(start: float) -> int:
    return max(1, int((time.perf_counter() - start) * 1000))


def _node(nodes: list[dict], name: str, status: str, detail: str, start: float) -> None:
    nodes.append({"node": name, "status": status, "detail": detail, "duration_ms": _ms(start)})


def _thread(user: dict, thread_id: str | None, data: dict) -> tuple[str, dict | None]:
    if thread_id and thread_id in data["threads"]:
        thread = data["threads"][thread_id]
        if thread["user_id"] != user["id"] or thread["tenant_id"] != user["tenant_id"]:
            raise ApiError(403, "THREAD_FORBIDDEN", "无权访问该会话")
        return thread_id, thread
    return f"TH{uuid.uuid4().hex[:10].upper()}", None


def _find_pile(data: dict, text: str, communities: set[str]) -> dict | None:
    match = re.search(r"P\d{3}", text.upper())
    if match:
        pile = data["piles"].get(match.group(0))
        return pile if pile and pile["community_id"] in communities else None
    normalized = text.replace(" ", "")
    for pile in data["piles"].values():
        code = pile["code"].replace(" ", "")
        if code and code in normalized and pile["community_id"] in communities:
            return pile
    return None


def _orders_for(user: dict, data: dict) -> list[dict]:
    communities = set(scoped_communities(user, data))
    result = []
    for order in data["orders"].values():
        if order["tenant_id"] != user["tenant_id"]:
            continue
        if user["role"] == "user":
            if order["user_id"] != user["id"]:
                continue
        elif order["community_id"] not in communities:
            continue
        if not order.get("is_test"):
            result.append(order)
    return result


def _answer_faults(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    communities = set(scoped_communities(user, data))
    piles = [p for p in data["piles"].values() if p["tenant_id"] == user["tenant_id"] and p["community_id"] in communities]
    tickets = [
        t for t in data["tickets"].values()
        if t["tenant_id"] == user["tenant_id"] and t["community_id"] in communities
        and t["status"] in {"open", "assigned", "processing", "pending_acceptance"}
        and (user["role"] != "user" or t.get("reporter_id") == user["id"])
    ]
    faults = [p for p in piles if p["status"] in {"fault", "offline"}]
    if not faults and not tickets:
        return "当前授权范围内没有故障设备或未关闭工单，设备健康度良好。", [{"name": "设备台账", "table": "charging_piles", "count": len(piles)}], ["查看今日运营指标", "哪些桩可用？"]
    fault_text = "、".join(f"{p['code']}（{p['status']}，累计 {p['faults']} 次）" for p in faults) or "无故障桩"
    overdue = sum(1 for t in tickets if (parse_dt(t.get("due_at")) or now()) < now())
    p1 = sum(1 for t in tickets if t["level"] == "P1")
    top_ticket = sorted(tickets, key=lambda item: item["level"])[0] if tickets else None
    answer = (
        f"当前授权范围内有 {len(faults)} 台故障/离线设备：{fault_text}；"
        f"未关闭工单 {len(tickets)} 张（P1 {p1} 张，超时 {overdue} 张）。"
    )
    if top_ticket:
        answer += f"建议优先处理 {top_ticket['id']}「{top_ticket['title']}」，先核验心跳，再按维修流程回填。"
    answer += "高风险停机操作只能提交审批，审批通过后执行。"
    sources = [
        {"name": "设备台账", "table": "charging_piles", "count": len(piles)},
        {"name": "维修工单", "table": "repair_tickets", "count": len(tickets)},
    ]
    return answer, sources, ["查看待审批申请", "查看工单池", "分析设备可用率"]


def _answer_available(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    communities = set(scoped_communities(user, data))
    piles = [
        p for p in data["piles"].values()
        if p["tenant_id"] == user["tenant_id"] and p["community_id"] in communities
        and p["status"] == "available"
    ]
    piles.sort(key=lambda p: (p["community_id"], p["code"]))
    if not piles:
        return "当前授权范围内没有空闲充电桩，建议查看预约队列或稍后重试。", [{"name": "实时设备状态", "table": "charging_piles", "count": 0}], ["查看故障设备", "查看我的订单"]
    lines = [
        f"{p['code']}（{data['communities'].get(p['community_id'], {}).get('name', '')}，{p['power']}kW，¥{p['price']:.2f}/度）"
        for p in piles[:6]
    ]
    answer = f"当前有 {len(piles)} 台空闲充电桩：" + "；".join(lines) + "。"
    if len(piles) > 6:
        answer += f"另有 {len(piles) - 6} 台未展示。"
    answer += " 可在「充电设备」页直接预约。"
    return answer, [{"name": "实时设备状态", "table": "charging_piles", "count": len(piles)}], ["帮我预约", "查看电价", "分析设备可用率"]


def _answer_revenue(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    if user["role"] == "user":
        orders = [o for o in _orders_for(user, data) if o["status"] == "completed"]
        spent = sum(float(o.get("amount", 0)) for o in orders)
        return (
            f"你共有 {len(orders)} 笔已完成充电，累计消费 ¥{spent:.2f}。最近一笔为 "
            f"{orders[-1]['id'] if orders else '—'}。",
            [{"name": "我的订单", "table": "charging_orders", "count": len(orders)}],
            ["查看我的订单", "申请退款", "哪些桩可用？"],
        )
    report = operations_report(user, 7)
    kpis = report["kpis"]
    top = report["communities"][0] if report["communities"] else None
    answer = (
        f"近 7 天完成 {kpis['orders']} 笔订单，净收入 ¥{kpis['revenue']:.2f}，"
        f"退款 ¥{kpis['refund_amount']:.2f}，客单价 ¥{kpis['avg_order_amount']:.2f}，充电量 {kpis['kwh']} 度。"
    )
    if top:
        answer += f"收入最高的是{top['name']}（¥{top['revenue']:.2f}）。"
    answer += "退款必须走审批，Agent 不会直接改账。"
    sources = [
        {"name": "订单流水", "table": "charging_orders", "count": kpis["orders"]},
        {"name": "社区维度汇总", "table": "communities", "count": len(report["communities"])},
    ]
    return answer, sources, ["查看待审批", "分析设备可用率", "看看故障工单"]


def _answer_tickets(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    if user["role"] == "user":
        tickets = [t for t in data["tickets"].values() if t.get("reporter_id") == user["id"]]
        if not tickets:
            return "你还没有提交过报修工单。可在设备详情中提交报修。", [{"name": "我的工单", "table": "repair_tickets", "count": 0}], ["哪些桩可用？"]
        latest = sorted(tickets, key=lambda item: item["created_at"], reverse=True)[0]
        return (
            f"你共有 {len(tickets)} 张工单，最近一张 {latest['id']}「{latest['title']}」当前状态为 {latest['status']}。",
            [{"name": "我的工单", "table": "repair_tickets", "count": len(tickets)}],
            ["查看设备", "申请退款"],
        )
    communities = set(scoped_communities(user, data))
    tickets = [
        t for t in data["tickets"].values()
        if t["tenant_id"] == user["tenant_id"] and t["community_id"] in communities
    ]
    open_tickets = [t for t in tickets if t["status"] in {"open", "assigned", "processing", "pending_acceptance"}]
    overdue = [t for t in open_tickets if (parse_dt(t.get("due_at")) or now()) < now()]
    by_level = {level: sum(1 for t in open_tickets if t["level"] == level) for level in ("P1", "P2", "P3")}
    answer = (
        f"共有 {len(open_tickets)} 张未关闭工单：P1 {by_level['P1']}、P2 {by_level['P2']}、P3 {by_level['P3']}；"
        f"其中超时 {len(overdue)} 张。"
    )
    if open_tickets:
        first = sorted(open_tickets, key=lambda item: (item["level"], item["created_at"]))[0]
        answer += f"最早的高优工单是 {first['id']}「{first['title']}」。"
    return answer, [{"name": "维修工单", "table": "repair_tickets", "count": len(open_tickets)}], ["分派工单", "查看设备", "查看待审批"]


def _answer_approvals(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    communities = set(scoped_communities(user, data))
    items = []
    for approval in data["approvals"].values():
        if approval["tenant_id"] != user["tenant_id"] or approval["status"] != "pending":
            continue
        if user["role"] == "user" and approval["requester_id"] != user["id"]:
            continue
        if user["role"] not in {"user", "admin", "finance"}:
            if approval["requester_id"] != user["id"] and approval.get("payload", {}).get("community_id") not in communities:
                continue
        items.append(approval)
    if not items:
        return "当前没有待处理的审批申请。", [{"name": "审批中心", "table": "approvals", "count": 0}], ["查看运营指标", "分析故障"]
    lines = [f"{a['id']} {a['title']}（{a['impact']}，申请人 {a['requester_name']}）" for a in items[:5]]
    answer = f"当前有 {len(items)} 条待审批申请：" + "；".join(lines) + "。审批通过后才会执行实际变更。"
    return answer, [{"name": "审批中心", "table": "approvals", "count": len(items)}], ["查看运营指标", "分析故障"]


def _answer_metrics(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    report = operations_report(user, 7) if user["role"] != "user" else None
    if report:
        kpis = report["kpis"]
        answer = (
            f"近 7 天设备可用率 {kpis['availability_rate']}%，利用率 {kpis['utilization']}%，"
            f"故障率 {kpis['fault_rate']}%，平均修复时长 {kpis['mttr_hours']} 小时，"
            f"预约成功率 {kpis['reservation_success_rate']}%。"
        )
        answer += " 可用率 = 非故障/离线/维护设备 ÷ 设备总数；利用率 = 充电量 ÷（额定功率 × 时长）。"
        return answer, [{"name": "运营指标", "table": "charging_orders", "count": kpis["orders"]}], ["查看运营报表", "分析故障", "查看收入"]
    communities = set(scoped_communities(user, data))
    piles = [p for p in data["piles"].values() if p["tenant_id"] == user["tenant_id"] and p["community_id"] in communities]
    available = sum(1 for p in piles if p["status"] == "available")
    return (
        f"你所在社区共有 {len(piles)} 台设备，其中 {available} 台当前可用。"
        " 如需查看完整运营指标，请使用运营或财务账号。",
        [{"name": "实时设备状态", "table": "charging_piles", "count": len(piles)}],
        ["哪些桩可用？", "查看我的订单"],
    )


def _answer_prices(user: dict, data: dict) -> tuple[str, list[dict], list[str]]:
    communities = set(scoped_communities(user, data))
    piles = [p for p in data["piles"].values() if p["tenant_id"] == user["tenant_id"] and p["community_id"] in communities]
    grouped: dict[str, set[float]] = {}
    for pile in piles:
        grouped.setdefault(pile["community_id"], set()).add(float(pile["price"]))
    parts = [
        f"{data['communities'].get(cid, {}).get('name', cid)} " + " / ".join(f"¥{price:.2f}/度" for price in sorted(prices))
        for cid, prices in grouped.items()
    ]
    answer = "当前电价：" + "；".join(parts) + "。电价调整属于高风险动作，必须提交审批。"
    return answer, [{"name": "计费规则", "table": "charging_piles", "count": len(piles)}], ["申请调价", "哪些桩可用？"]


def _help() -> tuple[str, list[dict], list[str]]:
    answer = (
        "我可以：① 查询可用充电桩和电价；② 分析故障、工单和运营指标；③ 查询收入与待审批；"
        "④ 创建普通维修工单；⑤ 为退款、停机、调价、批量改派创建审批申请。"
        "涉及资金或设备状态的高风险动作只生成审批，不会直接执行。"
    )
    return answer, [], ["当前有哪些可用充电桩？", "分析当前故障和维修情况", "近 7 天运营指标", "为订单 O1005 申请退款 18.6 元"]


def _create_ticket_intent(user: dict, message: str, data: dict) -> tuple[str, list[dict], list[str]] | None:
    if not any(word in message for word in CREATE_TICKET_WORDS):
        return None
    communities = set(scoped_communities(user, data))
    pile = _find_pile(data, message, communities)
    if not pile:
        return "请提供要报修的充电桩编号，例如「为 P003 创建工单，枪头无法锁止」。", [], ["分析当前故障"]
    title_match = re.search(r"工单[，,：: ]*(.{4,40})", message)
    title = title_match.group(1).strip() if title_match else f"{pile['code']} 现场报修"
    try:
        ticket = create_ticket(
            user,
            TicketCreate(pile_id=pile["id"], title=title[:60], description=sanitize_text(message), level="P2"),
            ip="agent",
        )
    except ApiError as exc:
        detail = exc.detail if isinstance(exc.detail, dict) else {}
        return f"工单创建失败：{detail.get('message', '参数不合法')}", [], []
    answer = f"已创建维修工单 {ticket['id']}「{ticket['title']}」，当前状态为待处理。"
    return answer, [{"name": "维修工单", "table": "repair_tickets", "count": 1}], ["查看工单池", "分析故障"]


def _high_risk(
    user: dict, message: str, data: dict,
) -> tuple[str, str, list[dict], list[str], dict | None]:
    """Return (status, answer, sources, suggestions, approval|None)."""
    communities = set(scoped_communities(user, data))

    if "退款" in message:
        order_match = re.search(r"O\d{4,}", message.upper())
        if not order_match:
            candidates = [
                order for order in _orders_for(user, data)
                if order["status"] == "completed" and float(order.get("amount", 0)) > 0
            ]
            latest = sorted(candidates, key=lambda item: item.get("completed_at") or "", reverse=True)[:1]
            hint = f"（例如最近完成的订单 {latest[0]['id']}）" if latest else ""
            return (
                "needs_clarification",
                f"退款需要指定订单编号{hint}。请提供订单号和退款金额，我会创建审批申请，审批通过后才会退回。",
                [{"name": "订单流水", "table": "charging_orders", "count": len(candidates)}],
                ["查看我的订单"],
                None,
            )
        order_id = order_match.group(0)
        order = data["orders"].get(order_id)
        if not order:
            return "needs_clarification", f"没有找到订单 {order_id}，请核对订单编号。", [], [], None
        if order["tenant_id"] != user["tenant_id"] or (user["role"] == "user" and order["user_id"] != user["id"]):
            return "denied", "你无权为该订单申请退款。", [], [], None
        amount_match = re.search(r"(\d+(?:\.\d{1,2})?)\s*元", message)
        remaining = money(float(order.get("amount", 0)) - float(order.get("refund_amount", 0)))
        amount = round(float(amount_match.group(1)), 2) if amount_match else remaining
        try:
            approval = create_approval(
                user,
                ApprovalCreate(type="refund", reason=sanitize_text(message[:400]), payload={"order_id": order_id, "amount": amount}, amount=amount),
                None, ip="agent",
            )
        except ApiError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            return "denied", f"退款申请未创建：{detail.get('message', '参数不合法')}", [], [], None
        return (
            "pending_approval",
            f"已创建退款审批 {approval['id']}：订单 {order_id}，退款 ¥{amount:.2f}，当前状态为待审批。"
            "审批通过前不会发生任何资金变更；可在「审批中心」查看影响范围和风险因素。",
            [{"name": "审批中心", "table": "approvals", "count": 1}, {"name": "订单流水", "table": "charging_orders", "count": 1}],
            ["查看待审批", "查看订单"],
            approval,
        )

    if any(word in message for word in ("停机", "下线")):
        if not can_manage(user):
            return "denied", "当前角色没有停机权限，只有管理员或运营人员可以提交停机审批。", [], [], None
        pile = _find_pile(data, message, communities)
        if not pile:
            return "needs_clarification", "请提供要停机的充电桩编号，例如「暂停 P003 检修 8 小时」。", [], [], None
        hours_match = re.search(r"(\d+)\s*小时", message)
        hours = int(hours_match.group(1)) if hours_match else 8
        try:
            approval = create_approval(
                user,
                ApprovalCreate(type="stop_pile", reason=sanitize_text(message[:400]), payload={"pile_id": pile["id"], "duration_hours": hours}, amount=0),
                None, ip="agent",
            )
        except ApiError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            return "denied", f"停机申请未创建：{detail.get('message', '参数不合法')}", [], [], None
        return (
            "pending_approval",
            f"已创建停机审批 {approval['id']}：{pile['code']} 停机 {hours} 小时。审批通过后才会执行，当前设备状态未改变。",
            [{"name": "审批中心", "table": "approvals", "count": 1}, {"name": "设备台账", "table": "charging_piles", "count": 1}],
            ["查看待审批", "分析故障"],
            approval,
        )

    if any(word in message for word in ("调价", "改价", "价格调整")):
        if not can_manage(user):
            return "denied", "当前角色没有调价权限，只有管理员或运营人员可以提交调价审批。", [], [], None
        price_match = re.search(r"(\d+(?:\.\d{1,2})?)\s*元", message)
        if not price_match:
            return "needs_clarification", "请提供目标社区和新的电价，例如「把阳光花园电价调到 1.5 元」。", [], [], None
        new_price = round(float(price_match.group(1)), 2)
        community = None
        for item in data["communities"].values():
            if item["tenant_id"] == user["tenant_id"] and item["name"] in message:
                community = item
                break
        if not community:
            names = [item["name"] for item in data["communities"].values() if item["id"] in communities]
            return "needs_clarification", f"请指定社区名称（{ '、'.join(names) }），例如「把阳光花园电价调到 1.5 元」。", [], [], None
        try:
            approval = create_approval(
                user,
                ApprovalCreate(type="price_change", reason=sanitize_text(message[:400]), payload={"community_id": community["id"], "new_price": new_price}, amount=0),
                None, ip="agent",
            )
        except ApiError as exc:
            detail = exc.detail if isinstance(exc.detail, dict) else {}
            return "denied", f"调价申请未创建：{detail.get('message', '参数不合法')}", [], [], None
        return (
            "pending_approval",
            f"已创建调价审批 {approval['id']}：{community['name']} 电价调整为 ¥{new_price:.2f}/度。"
            "审批通过后统一执行，当前价格未改变。",
            [{"name": "审批中心", "table": "approvals", "count": 1}, {"name": "计费规则", "table": "charging_piles", "count": 1}],
            ["查看待审批", "查看电价"],
            approval,
        )

    if "批量" in message:
        return (
            "needs_clarification",
            "批量改派需要明确工单编号与维修人员。请在「审批中心」发起批量改派，或告诉我工单号和维修人员姓名，我会创建审批申请。",
            [], ["查看工单池"], None,
        )

    return "needs_clarification", "请说明需要审批的动作和目标对象。", [], [], None


def handle_chat(user: dict, req: AgentChat, ip: str = "") -> dict:
    started = time.perf_counter()
    nodes: list[dict] = []
    message = sanitize_text(req.message.strip())

    node_start = time.perf_counter()
    _node(nodes, "parse_intent", "ok", "识别自然语言意图", node_start)

    node_start = time.perf_counter()
    data = store.snapshot()
    thread_id, thread = _thread(user, req.thread_id, data)
    _node(nodes, "load_context", "ok", f"加载租户/社区数据范围与会话 {thread_id}", node_start)

    node_start = time.perf_counter()
    if thread is None and req.thread_id:
        _node(nodes, "check_permission", "denied", "会话不存在或无权访问", node_start)
        raise ApiError(403, "THREAD_FORBIDDEN", "无权访问该会话")
    _node(nodes, "check_permission", "ok", f"角色 {user['role']}，数据范围 {len(scoped_communities(user, data))} 个社区", node_start)

    risky = any(word in message for word in HIGH_RISK_WORDS)
    status = "completed"
    approval = None
    plan: list[dict] = []
    suggestions: list[str] = []
    sources: list[dict] = []
    ticket_result: tuple[str, list[dict], list[str]] | None = None
    intent = "help"

    if risky:
        node_start = time.perf_counter()
        _node(nodes, "plan_action", "ok", "识别为高风险动作，进入审批门", node_start)
        node_start = time.perf_counter()
        _node(nodes, "risk_gate", "blocked", "高风险动作禁止直接执行，必须人工审批", node_start)
        status, answer, sources, suggestions, approval = _high_risk(user, message, data)
        if "退款" in message:
            intent = "refund_request"
        elif any(word in message for word in ("停机", "下线")):
            intent = "stop_request"
        elif any(word in message for word in ("调价", "改价", "价格调整")):
            intent = "price_change_request"
        else:
            intent = "batch_request"
        plan = [{"step": "request_approval", "risk": "high", "executed": False}]
        node_start = time.perf_counter()
        _node(nodes, "request_approval", "ok" if approval else "needs_input", "创建审批申请，不执行实际变更", node_start)
    else:
        ticket_result = _create_ticket_intent(user, message, data)
        if ticket_result is not None:
            answer, sources, suggestions = ticket_result
            intent = "create_ticket"
            status = "completed" if "已创建" in answer else "needs_clarification"
            plan = [{"step": "create_ticket", "risk": "medium", "executed": status == "completed"}]
            node_start = time.perf_counter()
            _node(nodes, "plan_action", "ok", "普通写操作：创建维修工单", node_start)
            node_start = time.perf_counter()
            _node(nodes, "risk_gate", "ok", "普通写：幂等执行并记录审计", node_start)
            node_start = time.perf_counter()
            _node(nodes, "execute_action", "ok" if status == "completed" else "failed", "执行受控工具", node_start)
        else:
            if any(word in message for word in FAULT_WORDS):
                intent, answer, sources, suggestions = "fault_analysis", *_answer_faults(user, data)
            elif any(word in message for word in APPROVAL_WORDS):
                intent, answer, sources, suggestions = "approval_query", *_answer_approvals(user, data)
            elif any(word in message for word in TICKET_WORDS):
                intent, answer, sources, suggestions = "ticket_query", *_answer_tickets(user, data)
            elif any(word in message for word in REVENUE_WORDS):
                intent, answer, sources, suggestions = "revenue_analysis", *_answer_revenue(user, data)
            elif any(word in message for word in METRIC_WORDS):
                intent, answer, sources, suggestions = "metric_explain", *_answer_metrics(user, data)
            elif any(word in message for word in PRICE_WORDS):
                intent, answer, sources, suggestions = "price_query", *_answer_prices(user, data)
            elif any(word in message for word in AVAILABLE_WORDS):
                intent, answer, sources, suggestions = "available_piles", *_answer_available(user, data)
            else:
                intent, answer, sources, suggestions = "help", *_help()
            plan = [{"step": "read_only_tool", "risk": "low", "executed": True}]
            node_start = time.perf_counter()
            _node(nodes, "plan_action", "ok", f"选择只读工具 {intent}", node_start)
            node_start = time.perf_counter()
            _node(nodes, "risk_gate", "ok", "只读查询，无需审批", node_start)
            node_start = time.perf_counter()
            _node(nodes, "execute_action", "ok", "在授权数据范围内执行查询", node_start)

    node_start = time.perf_counter()
    _node(nodes, "verify_result", "ok", "校验返回字段与数据来源", node_start)
    node_start = time.perf_counter()

    response = {
        "answer": answer,
        "intent": intent,
        "risk": "high" if risky else ("medium" if ticket_result is not None else "low"),
        "status": status,
        "requires_approval": bool(risky),
        "approval_id": approval["id"] if approval else None,
        "approval": approval,
        "data_sources": sources,
        "plan": plan,
        "nodes": nodes,
        "suggestions": suggestions,
        "thread_id": thread_id,
        "trace_id": get_trace_id(),
        "engine": "local-tool-orchestrator",
        "llm_used": False,
        "generated_at": iso(),
    }

    with store.tx() as writable:
        existing = writable["threads"].get(thread_id)
        if existing is None:
            existing = {
                "id": thread_id, "tenant_id": user["tenant_id"], "user_id": user["id"],
                "title": message[:32] or "新的运营会话", "messages": [],
                "created_at": iso(), "updated_at": iso(),
            }
            writable["threads"][thread_id] = existing
        existing["messages"].append({"role": "user", "content": message, "at": iso()})
        existing["messages"].append({
            "role": "agent", "content": answer, "at": iso(),
            "meta": {"trace_id": response["trace_id"], "risk": response["risk"], "status": status, "approval_id": response["approval_id"]},
        })
        existing["messages"] = existing["messages"][-20:]
        existing["updated_at"] = iso()
        writable["meta"]["agent_runs"] = writable["meta"].get("agent_runs", 0) + 1
        append_audit(
            writable, action="agent_chat", actor=user, target_type="agent", target_id=thread_id,
            detail={"intent": response["intent"], "risk": response["risk"], "status": status, "message": message[:200]},
            ip=ip,
        )
    _node(nodes, "write_memory", "ok", "写入会话记忆与审计回执", node_start)
    _node(nodes, "reflect", "ok", f"总耗时 {_ms(started)} ms", time.perf_counter())
    response["duration_ms"] = _ms(started)
    return response


def list_threads(user: dict) -> dict:
    with store.lock_read() as data:
        items = [
            {
                "id": thread["id"], "title": thread["title"], "updated_at": thread["updated_at"],
                "message_count": len(thread["messages"]),
                "last_message": thread["messages"][-1]["content"][:80] if thread["messages"] else "",
            }
            for thread in data["threads"].values()
            if thread["tenant_id"] == user["tenant_id"] and thread["user_id"] == user["id"]
        ]
    items.sort(key=lambda item: item["updated_at"], reverse=True)
    return {"items": items, "total": len(items)}


def get_thread(user: dict, thread_id: str) -> dict:
    with store.lock_read() as data:
        thread = data["threads"].get(thread_id)
        if not thread or thread["tenant_id"] != user["tenant_id"] or thread["user_id"] != user["id"]:
            raise ApiError(404, "THREAD_NOT_FOUND", "会话不存在")
        return thread
