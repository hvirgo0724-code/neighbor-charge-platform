"""Request models. Unknown fields are rejected to keep the API surface tight."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class LoginRequest(StrictModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class UserCreate(StrictModel):
    username: str = Field(min_length=3, max_length=40, pattern=r"^[A-Za-z][A-Za-z0-9_.-]+$")
    display_name: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=6, max_length=128)
    role: Literal["admin", "operator", "repairer", "finance", "user"] = "user"
    community_ids: list[str] = Field(default_factory=list, max_length=20)
    phone: str = Field(default="", max_length=20)
    email: str = Field(default="", max_length=120)


class UserStatusUpdate(StrictModel):
    status: Literal["active", "disabled"]


class CommunityCreate(StrictModel):
    name: str = Field(min_length=2, max_length=60)
    address: str = Field(min_length=4, max_length=160)
    city: str = Field(default="北京市", max_length=40)
    district: str = Field(default="", max_length=40)
    contact: str = Field(default="", max_length=40)
    phone: str = Field(default="", max_length=20)


class PileCreate(StrictModel):
    community_id: str = Field(min_length=1, max_length=36)
    code: str = Field(min_length=2, max_length=50)
    model: str = Field(default="邻里 AC7", max_length=60)
    connector: Literal["国标交流", "国标直流"] = "国标交流"
    power: float = Field(gt=0, le=480)
    price: float = Field(gt=0, le=10)


class ReservationCreate(StrictModel):
    pile_id: str = Field(min_length=1, max_length=36)
    starts_at: datetime
    ends_at: datetime
    user_id: str | None = Field(default=None, max_length=36)
    note: str = Field(default="", max_length=200)

    @field_validator("ends_at")
    @classmethod
    def validate_window(cls, value: datetime, info):
        start = info.data.get("starts_at")
        if start and value <= start:
            raise ValueError("结束时间必须晚于开始时间")
        return value


class OrderComplete(StrictModel):
    kwh: float = Field(gt=0, le=300)
    note: str = Field(default="", max_length=200)


class OrderCancel(StrictModel):
    reason: str = Field(default="用户取消", max_length=200)


class RefundCreate(StrictModel):
    order_id: str = Field(min_length=1, max_length=36)
    amount: float = Field(gt=0, le=100000)
    reason: str = Field(min_length=4, max_length=500)


class DeviceEventIn(StrictModel):
    event_id: str = Field(min_length=4, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")
    pile_id: str = Field(min_length=1, max_length=36)
    event_type: Literal[
        "heartbeat", "power", "current", "temperature", "offline", "fault",
        "charge_interrupted", "restored",
    ]
    payload: dict[str, Any] = Field(default_factory=dict)
    occurred_at: datetime | None = None


class TicketCreate(StrictModel):
    pile_id: str = Field(min_length=1, max_length=36)
    title: str = Field(min_length=3, max_length=120)
    description: str = Field(default="", max_length=1000)
    level: Literal["P1", "P2", "P3"] = "P3"


class TicketAssign(StrictModel):
    assignee_id: str = Field(min_length=1, max_length=36)


class TicketResolve(StrictModel):
    resolution: str = Field(min_length=5, max_length=1000)


class TicketTestOrder(StrictModel):
    kwh: float = Field(default=0.4, gt=0, le=5)


class ApprovalCreate(StrictModel):
    type: Literal["refund", "stop_pile", "price_change", "batch_reassign"]
    reason: str = Field(min_length=4, max_length=500)
    payload: dict[str, Any] = Field(default_factory=dict)
    amount: float = Field(default=0, ge=0, le=100000)


class ApprovalDecision(StrictModel):
    approved: bool
    comment: str = Field(default="", max_length=500)


class AgentChat(StrictModel):
    message: str = Field(min_length=1, max_length=1000)
    thread_id: str | None = Field(default=None, max_length=64)


class AgentFeedback(StrictModel):
    helpful: bool
    comment: str = Field(default="", max_length=300)
