"""`python -m app` (from backend/): run the API — and the built UI, when frontend/dist exists —
on FACTORY_HOST:FACTORY_PORT (127.0.0.1:3071 by default)."""
from __future__ import annotations

import logging

import uvicorn

from app.config import settings


def main() -> None:
    # uvicorn configures only its own loggers; this makes the app's "factory.*" warnings
    # (missing seed, failed boot-time connector test…) visible in the same console.
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
