"""JSON-backed operational store with transactions and demo seed data.

The store is intentionally small and dependency-free. Every write happens in a
critical section, is snapshotted first, and is flushed atomically, which gives
the demo the same "all or nothing" behaviour expected from a database
transaction. On serverless platforms the file lives in /tmp and is recreated
from the deterministic seed after a cold start.
"""
from __future__ import annotations

import copy
import json
import logging
import os
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from .config import settings
from .core import iso, now
from .seed import build_seed

log = logging.getLogger("neighbor.store")


class StoreUnavailable(RuntimeError):
    """Raised when the durable store cannot be read or written."""


class Store:
    def __init__(self, path: Path | None = None, persist: bool | None = None) -> None:
        self.path = Path(path or settings.data_file)
        self.persist = settings.persist if persist is None else persist
        self.lock = threading.RLock()
        self.data: dict[str, Any] = {}
        self.last_error: str | None = None
        self.last_saved_at: str | None = None
        self._load()

    # ------------------------------------------------------------------ load
    def _load(self) -> None:
        with self.lock:
            if self.persist and self.path.exists():
                try:
                    payload = json.loads(self.path.read_text(encoding="utf-8"))
                    if self._valid(payload):
                        self.data = payload
                        self.last_saved_at = iso()
                        return
                    log.warning("store file has an unknown schema, reseeding")
                except (OSError, ValueError, TypeError) as exc:
                    self.last_error = f"读取数据文件失败: {exc}"
                    log.exception("failed to read store file")
            self.data = build_seed()
            self.last_saved_at = iso()
            if self.persist:
                try:
                    self._save()
                except StoreUnavailable:
                    # A read-only filesystem should not stop the demo from
                    # starting; writes will surface a clear error later.
                    log.warning("store is not writable, continuing in memory")

    @staticmethod
    def _valid(payload: Any) -> bool:
        return (
            isinstance(payload, dict)
            and isinstance(payload.get("meta"), dict)
            and payload["meta"].get("schema_version") == 1
            and all(isinstance(payload.get(key), dict) for key in ("users", "piles", "orders", "tickets"))
        )

    # ------------------------------------------------------------------ read
    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return copy.deepcopy(self.data)

    @contextmanager
    def lock_read(self) -> Iterator[dict[str, Any]]:
        with self.lock:
            yield self.data

    # ----------------------------------------------------------------- write
    @contextmanager
    def tx(self) -> Iterator[dict[str, Any]]:
        """Run a mutation atomically; roll back memory if persistence fails."""
        with self.lock:
            backup = copy.deepcopy(self.data)
            try:
                yield self.data
                self._save()
            except Exception:
                self.data = backup
                raise

    def _save(self) -> None:
        if not self.persist:
            self.last_saved_at = iso()
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            payload = json.dumps(self.data, ensure_ascii=False, separators=(",", ":"), default=str)
            fd, temporary = tempfile.mkstemp(prefix=".store-", suffix=".json", dir=str(self.path.parent))
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as handle:
                    handle.write(payload)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, self.path)
            except Exception:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
            self.last_saved_at = iso()
            self.last_error = None
        except OSError as exc:
            self.last_error = f"写入数据文件失败: {exc}"
            log.exception("failed to persist store")
            raise StoreUnavailable(self.last_error) from exc

    # --------------------------------------------------------------- helpers
    def reset(self, seed: bool = True) -> None:
        with self.lock:
            self.data = build_seed() if seed else {
                "meta": {"schema_version": 1, "seeded_at": iso()},
                "tenants": {}, "orgs": {}, "communities": {}, "users": {}, "piles": {},
                "orders": {}, "events": {}, "tickets": {}, "approvals": {}, "audit": [],
                "threads": {}, "memories": [],
            }
            self._save()

    def health(self) -> dict[str, Any]:
        with self.lock:
            writable = False
            if not self.persist:
                writable = True
            else:
                try:
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    writable = os.access(self.path.parent, os.W_OK)
                except OSError:
                    writable = False
            return {
                "backend": "json-file" if self.persist else "memory",
                "path": str(self.path) if self.persist else None,
                "writable": writable,
                "last_saved_at": self.last_saved_at,
                "last_error": self.last_error,
                "records": {
                    "users": len(self.data.get("users", {})),
                    "piles": len(self.data.get("piles", {})),
                    "orders": len(self.data.get("orders", {})),
                    "tickets": len(self.data.get("tickets", {})),
                },
            }

    def next_id(self, collection: str, prefix: str, width: int = 4) -> str:
        """Allocate a readable sequential id inside an open transaction."""
        collection_data = self.data.get(collection, {})
        highest = 0
        for key in collection_data:
            digits = "".join(ch for ch in key if ch.isdigit())
            if digits:
                highest = max(highest, int(digits))
        return f"{prefix}{highest + 1:0{width}d}"


store = Store()
