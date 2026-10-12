"""Test isolation: every test gets a fresh SQLite database, no background jobs run, and a
developer's backend/.env cannot leak an LLM or a UI build into the tests.

The environment is set before any `app` module is imported, because the container (and the
settings it reads) is built at import time.
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

import pytest

_TMP = Path(tempfile.mkdtemp(prefix="factory-tests-"))
os.environ.update({
    "FACTORY_DB_PATH": str(_TMP / "import-time.db"),   # replaced per test by the fixtures below
    "FACTORY_DATA_DIR": str(_TMP / "data"),
    "FACTORY_STATIC_DIR": str(_TMP / "no-ui"),          # API-only unless a test builds a UI
    "FACTORY_BACKGROUND_JOBS": "false",
    "FACTORY_LLM_PROVIDER": "",
    "FACTORY_LLM_BASE_URL": "",
    "FACTORY_LLM_MODEL": "",
    "FACTORY_LLM_API_KEY": "",
})
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))   # `app` importable from any cwd

from app.store import Store  # noqa: E402


@pytest.fixture
def store(tmp_path: Path):
    s = Store(tmp_path / "store.db")
    yield s
    s.close()


@pytest.fixture
def container(tmp_path: Path):
    """The app's container, pointed at a fresh database for the duration of one test.
    Subsystems reach the store through the container at call time, so swapping it is enough."""
    from app.deps import container as c

    saved_store, saved_llm = c.store, c._llm
    c.store, c._llm = Store(tmp_path / "factory.db"), None
    try:
        yield c
    finally:
        c.store.close()
        c.store, c._llm = saved_store, saved_llm


@pytest.fixture
def client(container):
    """A TestClient over the real app; entering it runs the lifespan (seed, recovery)."""
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as tc:
        yield tc
