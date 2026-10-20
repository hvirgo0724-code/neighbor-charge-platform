from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request

from ..agent import get_thread, handle_chat, list_threads
from ..core import get_trace_id
from ..errors import not_found
from ..schemas import AgentChat
from ..security import client_ip, current_user

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.post("/chat")
def chat(req: AgentChat, request: Request, user: dict = Depends(current_user)):
    result = handle_chat(user, req, client_ip(request))
    result["trace_id"] = get_trace_id()
    return result


@router.get("/threads")
def threads(user: dict = Depends(current_user)):
    return list_threads(user)


@router.get("/threads/{thread_id}")
def thread_detail(thread_id: str, user: dict = Depends(current_user)):
    try:
        thread = get_thread(user, thread_id)
    except HTTPException:
        raise not_found("会话不存在")
    return thread


@router.get("/policy")
def policy(user: dict = Depends(current_user)):
    return {
        "engine": "local-tool-orchestrator",
        "llm_used": False,
        "tools": [
            {"name": "query_available_piles", "risk": "low", "scope": "授权社区"},
            {"name": "analyze_faults", "risk": "low", "scope": "授权社区"},
            {"name": "query_orders", "risk": "low", "scope": "本人/授权社区"},
            {"name": "query_tickets", "risk": "low", "scope": "本人/授权社区"},
            {"name": "create_ticket", "risk": "medium", "scope": "授权设备"},
            {"name": "request_refund", "risk": "high", "mode": "approval_only"},
            {"name": "request_stop_pile", "risk": "high", "mode": "approval_only"},
            {"name": "request_price_change", "risk": "high", "mode": "approval_only"},
            {"name": "request_batch_reassign", "risk": "high", "mode": "approval_only"},
        ],
        "rules": [
            "高风险动作只创建审批申请，不执行实际变更",
            "工具参数由服务端校验，模型不能生成 SQL 或系统命令",
            "所有回答附带数据来源、执行节点和 trace_id",
            "居民用户只能查询本人订单和社区设备",
        ],
        "trace_id": get_trace_id(),
    }
