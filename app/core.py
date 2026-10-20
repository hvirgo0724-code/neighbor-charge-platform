"""Small primitives shared by the API, services and seed data."""
from __future__ import annotations

import contextvars
import re
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

TZ = timezone.utc
CN_TZ = timezone(timedelta(hours=8))
_trace_id: contextvars.ContextVar[str] = contextvars.ContextVar("trace_id", default="-")


def set_trace_id(value: str | None = None) -> str:
    trace = value or uuid.uuid4().hex
    _trace_id.set(trace)
    return trace


def get_trace_id() -> str:
    return _trace_id.get()


def new_trace_id() -> str:
    return uuid.uuid4().hex


def now() -> datetime:
    return datetime.now(TZ)


def iso(value: datetime | None = None) -> str:
    return (value or now()).astimezone(TZ).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_dt(value: Any) -> datetime | None:
    if value is None or value == "":
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        try:
            dt = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    return dt.astimezone(TZ)


def minutes_since(value: Any) -> float | None:
    dt = parse_dt(value)
    if dt is None:
        return None
    return (now() - dt).total_seconds() / 60


def in_range(value: Any, start: Any, end: Any) -> bool:
    dt, left, right = parse_dt(value), parse_dt(start), parse_dt(end)
    if dt is None or left is None or right is None:
        return False
    return left <= dt <= right


def overlaps(a_start: Any, a_end: Any, b_start: Any, b_end: Any) -> bool:
    left_a, right_a = parse_dt(a_start), parse_dt(a_end)
    left_b, right_b = parse_dt(b_start), parse_dt(b_end)
    if not all((left_a, right_a, left_b, right_b)):
        return False
    return left_a < right_b and left_b < right_a


def human_duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds} 秒"
    if seconds < 3600:
        return f"{seconds // 60} 分钟"
    if seconds < 86400:
        return f"{seconds / 3600:.1f} 小时"
    return f"{seconds / 86400:.1f} 天"


def money(value: float | int | None) -> float:
    return round(float(value or 0), 2)


def pct(part: float, total: float, digits: int = 1) -> float:
    if not total:
        return 0.0
    return round(part / total * 100, digits)


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def mask_phone(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"(\d{3})\d{4}(\d{4})", r"\1****\2", value)


def mask_tail(value: str | None, keep: int = 4) -> str:
    if not value:
        return ""
    if len(value) <= keep:
        return "*" * len(value)
    return "*" * (len(value) - keep) + value[-keep:]


_EMAIL = re.compile(r"([\w.+-]{1,2})[\w.+-]*(@[\w.-]+)")
_ID_CARD = re.compile(r"\b(\d{3})\d{11}(\d{3}[\dXx])\b")


def sanitize_text(value: str) -> str:
    """Strip secrets that must never reach logs, audit entries or memory."""
    text = _EMAIL.sub(r"\1***\2", value)
    text = _ID_CARD.sub(r"\1***********\2", text)
    text = re.sub(r"(?i)(password|passwd|token|secret)\s*[=:]\s*\S+", r"\1=***", text)
    return text


def deep_get(data: dict, path: str, default: Any = None) -> Any:
    current: Any = data
    for part in path.split("."):
        if not isinstance(current, dict) or part not in current:
            return default
        current = current[part]
    return current


def sort_desc(items: list[dict], key: str = "created_at") -> list[dict]:
    return sorted(items, key=lambda item: parse_dt(item.get(key)) or datetime.min.replace(tzinfo=TZ), reverse=True)


def short_id(prefix: str, length: int = 6) -> str:
    return prefix + uuid.uuid4().hex[:length].upper()


def date_key(value: Any) -> str:
    dt = parse_dt(value)
    return dt.astimezone(CN_TZ).date().isoformat() if dt else ""


def date_range(days: int) -> list[str]:
    today = now().astimezone(CN_TZ).date()
    return [(today - timedelta(days=offset)).isoformat() for offset in range(days - 1, -1, -1)]


def start_of_day(days_ago: int = 0) -> datetime:
    current = now().astimezone(CN_TZ) - timedelta(days=days_ago)
    return current.replace(hour=0, minute=0, second=0, microsecond=0)
