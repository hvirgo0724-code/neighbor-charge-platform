"""Structured JSON logging with trace correlation and secret redaction."""
from __future__ import annotations

import json
import logging
import sys

from .core import get_trace_id, sanitize_text


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "message": sanitize_text(record.getMessage()),
            "trace_id": getattr(record, "trace_id", None) or get_trace_id(),
        }
        for key in ("method", "path", "status", "duration_ms", "actor_id", "ip", "error_code"):
            value = getattr(record, key, None)
            if value is not None:
                payload[key] = value
        if record.exc_info:
            payload["exception"] = sanitize_text(self.formatException(record.exc_info))[:4000]
        return json.dumps(payload, ensure_ascii=False)


def configure_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    root.setLevel(level)
    for handler in list(root.handlers):
        root.removeHandler(handler)
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root.addHandler(handler)
    logging.getLogger("uvicorn.access").disabled = True
    logging.getLogger("uvicorn.error").setLevel(level)
