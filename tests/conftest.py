from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
DEPS = ROOT / ".deps"
if DEPS.is_dir():
    sys.path.insert(0, str(DEPS))

os.environ.setdefault("PERSIST", "0")
os.environ.setdefault("DATA_FILE", str(ROOT / ".data" / "test-store.json"))
os.environ.setdefault("JWT_SECRET", "test-secret-for-neighbor-charge")
os.environ.setdefault("LOG_LEVEL", "CRITICAL")
os.environ.setdefault("DEMO_PASSWORD", "admin123")

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.store import store


@pytest.fixture(autouse=True)
def fresh_store():
    store.reset()
    yield
    store.reset()


@pytest.fixture()
def client():
    with TestClient(app) as test_client:
        yield test_client


def login(client: TestClient, username: str = "admin", password: str = "admin123") -> dict:
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return response.json()


def auth(client: TestClient, username: str = "admin") -> dict:
    data = login(client, username)
    return {"Authorization": f"Bearer {data['access_token']}"}


@pytest.fixture()
def admin_headers(client):
    return auth(client, "admin")


@pytest.fixture()
def operator_headers(client):
    return auth(client, "operator")


@pytest.fixture()
def finance_headers(client):
    return auth(client, "finance")


@pytest.fixture()
def repairer_headers(client):
    return auth(client, "repairer")


@pytest.fixture()
def user_headers(client):
    return auth(client, "user")

