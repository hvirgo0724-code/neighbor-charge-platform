"""Local development entry point.

    python run.py

For production use ``uvicorn app.main:app --host 0.0.0.0 --port 8000`` (the
Dockerfile already does this). Set ``RELOAD=0`` to disable the reloader.
"""
from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=os.getenv("RELOAD", "1") not in {"0", "false", "False"},
    )
