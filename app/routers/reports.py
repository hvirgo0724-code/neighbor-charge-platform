from __future__ import annotations

import csv
import io
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request, Response

from ..audit import append_audit
from ..core import get_trace_id
from ..security import client_ip, current_user, require_roles
from ..services import dashboard, operations_report
from ..store import store

router = APIRouter(prefix="/api", tags=["reports"])


@router.get("/dashboard")
def overview(user: dict = Depends(current_user)):
    result = dashboard(user)
    result["trace_id"] = get_trace_id()
    return result


@router.get("/reports/operations")
def report(
    days: int = Query(default=7, ge=1, le=30),
    user: dict = Depends(require_roles("admin", "operator", "repairer", "finance")),
):
    result = operations_report(user, days)
    result["trace_id"] = get_trace_id()
    return result


@router.get("/reports/operations.csv")
def export_report(
    request: Request,
    days: int = Query(default=7, ge=1, le=30),
    user: dict = Depends(require_roles("admin", "operator", "finance")),
):
    report_data = operations_report(user, days)
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(["邻里充电运营报表", report_data["period"]["label"]])
    writer.writerow(["生成时间", report_data["generated_at"]])
    writer.writerow([])
    writer.writerow(["核心指标", "数值"])
    labels = {
        "total_piles": "设备总数", "availability_rate": "设备可用率(%)",
        "utilization": "设备利用率(%)", "fault_rate": "故障率(%)",
        "mttr_hours": "平均修复时长(小时)", "reservation_success_rate": "预约成功率(%)",
        "revenue": "净收入(元)", "refund_amount": "退款金额(元)",
        "orders": "完成订单", "kwh": "充电量(度)", "avg_order_amount": "客单价(元)",
        "open_tickets": "未关闭工单", "pending_approvals": "待审批",
    }
    for key, label in labels.items():
        writer.writerow([label, report_data["kpis"].get(key)])
    writer.writerow([])
    writer.writerow(["日期", "收入(元)", "订单数", "充电量(度)"])
    for row in report_data["trend"]:
        writer.writerow([row["date"], row["revenue"], row["orders"], row["kwh"]])
    writer.writerow([])
    writer.writerow(["社区", "设备数", "可用率(%)", "利用率(%)", "收入(元)", "订单数", "未关闭工单"])
    for row in report_data["communities"]:
        writer.writerow([row["name"], row["piles"], row["availability_rate"], row["utilization"], row["revenue"], row["orders"], row["open_tickets"]])
    with store.tx() as data:
        append_audit(
            data, action="report_export", actor=user, target_type="report", target_id=f"operations:{days}",
            detail=f"导出近 {days} 天运营报表", ip=client_ip(request),
        )
    filename = f"neighbor-charge-report-{datetime.now().strftime('%Y%m%d')}.csv"
    return Response(
        content="\ufeff" + buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"', "X-Trace-Id": get_trace_id()},
    )
