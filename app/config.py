"""Application configuration.

The demo build is deliberately self-contained: no database, cache or LLM
credentials are required to boot. Runtime state lives in a JSON document that
can be persisted locally and is stored under /tmp on serverless platforms.
"""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv() -> None:
    """Load a minimal .env without overriding real environment variables."""
    for candidate in (BASE_DIR / ".env", BASE_DIR / ".env.local"):
        if not candidate.is_file():
            continue
        try:
            lines = candidate.read_text(encoding="utf-8").splitlines()
        except OSError:
            continue
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = value


_load_dotenv()


def _bool(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def _default_data_file() -> Path:
    explicit = os.getenv("DATA_FILE", "").strip()
    if explicit:
        path = Path(explicit).expanduser()
        return path if path.is_absolute() else BASE_DIR / path
    if os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("NETLIFY") or os.getenv("VERCEL"):
        return Path(tempfile.gettempdir()) / "neighbor-charge-store.json"
    return BASE_DIR / ".data" / "store.json"


class Settings:
    app_name = "邻里充电运营平台"
    app_version = "1.0.0"
    api_prefix = "/api"
    demo_mode = _bool("DEMO_MODE", True)
    env_name = os.getenv("APP_ENV", "demo" if demo_mode else "production")
    jwt_secret = os.getenv("JWT_SECRET", "neighbor-charge-demo-secret-change-me")
    token_ttl_seconds = _int("TOKEN_TTL_SECONDS", 8 * 3600, 300, 7 * 24 * 3600)
    data_file = _default_data_file()
    persist = _bool("PERSIST", True)
    static_dir = Path(os.getenv("STATIC_DIR", str(BASE_DIR / "static"))).expanduser()
    cors_origins = [
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "*").split(",")
        if origin.strip()
    ]
    heartbeat_fresh_minutes = _int("HEARTBEAT_FRESH_MINUTES", 10, 1, 180)
    login_max_attempts = _int("LOGIN_MAX_ATTEMPTS", 6, 3, 20)
    login_window_seconds = _int("LOGIN_WINDOW_SECONDS", 300, 60, 3600)
    max_reservation_hours = _int("MAX_RESERVATION_HOURS", 4, 1, 12)
    serverless = bool(os.getenv("AWS_LAMBDA_FUNCTION_NAME") or os.getenv("NETLIFY") or os.getenv("VERCEL"))
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()
    demo_password = os.getenv("DEMO_PASSWORD", "admin123")
    device_api_key = os.getenv("DEVICE_API_KEY", "demo-device-key-change-me")

    @property
    def is_default_secret(self) -> bool:
        return self.jwt_secret == "neighbor-charge-demo-secret-change-me"

    def public_config(self) -> dict:
        return {
            "mode": "demo" if self.demo_mode else "production",
            "version": self.app_version,
            "serverless": self.serverless,
            "reservation_max_hours": self.max_reservation_hours,
            "heartbeat_fresh_minutes": self.heartbeat_fresh_minutes,
        }


settings = Settings()
