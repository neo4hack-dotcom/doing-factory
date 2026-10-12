"""The FastAPI app: lifespan, error mapping, routers, then the built SPA behind them.

Development: Vite serves the UI on :3070 and proxies /api (and /mcp) here. Production: no
second process — this app serves frontend/dist from the same origin. Either way the browser
only ever talks to one origin; the CORS policy below just lets a page opened straight on the
Vite port during development reach the API.
"""
from __future__ import annotations

import asyncio
import contextlib
import importlib
import inspect
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import factory_mcp
from app.api import (routes_activity, routes_admin, routes_ai, routes_blueprints, routes_connectors,
                     routes_inbox, routes_intake, routes_library, routes_notifications, routes_operations,
                     routes_people, routes_projects, routes_settings, routes_system, routes_watchers, ws)
from app.config import VERSION
from app.deps import container as c
from app.errors import FactoryError
from app.util import validation_message

log = logging.getLogger("factory.main")

SEED_MODULE = "app.seed.defaults"


async def _seed_defaults() -> None:
    """Builtin roles, prompts, rules and blueprints (inserted only when missing). A missing
    seed module is a warning, not a crash: the app still boots and says what is absent."""
    try:
        seed = importlib.import_module(SEED_MODULE)
    except ModuleNotFoundError as exc:
        if exc.name not in (SEED_MODULE, "app.seed"):
            raise   # the seed module exists but one of *its* imports is broken: a real bug
        log.warning("%s is missing — no builtin roles, rules or blueprints were seeded", SEED_MODULE)
        return
    result = seed.seed_defaults(c)
    if inspect.isawaitable(result):
        await result


async def _autotest_connectors() -> None:
    """Refresh every enabled connector's status and tool list after boot, concurrently and in
    the background: one slow or dead MCP server must never delay the first page load."""
    ids = [conn["id"] for conn in c.store.list("connectors") if conn.get("enabled", True)]
    results = await asyncio.gather(*(c.mcp.test(cid) for cid in ids), return_exceptions=True)
    for cid, result in zip(ids, results):
        if isinstance(result, BaseException):
            log.warning("Connector %s: boot-time test failed — %s", cid, result)


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    c.store.open()
    try:
        c.seed_settings_from_env()
    except FactoryError as exc:
        log.error("FACTORY_LLM_* could not seed Settings › AI Model: %s", exc.message)
    try:
        await _seed_defaults()
    except Exception:
        log.exception("Seeding the builtin defaults failed — continuing without them")
    try:
        await c.engine.recover()
    except Exception:
        log.exception("Recovering interrupted projects failed — affected steps may need a manual Retry")
    autotest: asyncio.Task | None = None
    if c.settings.background_jobs:
        c.scheduler.start()
        autotest = asyncio.create_task(_autotest_connectors())
    try:
        yield
    finally:
        if autotest is not None and not autotest.done():
            autotest.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await autotest
        await c.scheduler.stop()
        await c.mcp.close_all()
        c.store.close()   # checkpoints the WAL; a later call would transparently reopen


app = FastAPI(title="DOINg.AI Factory API", version=VERSION, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://127.0.0.1:3070", "http://localhost:3070"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(FactoryError)
async def factory_error(_: Request, exc: FactoryError) -> JSONResponse:
    # Domain errors carry their own status (NotFound 404, NotConfigured 424, LLMError 502…)
    # and a message already written for the person reading the toast.
    return JSONResponse({"detail": exc.message}, status_code=exc.status_code)


@app.exception_handler(RequestValidationError)
async def request_invalid(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse({"detail": f"Invalid request — {validation_message(exc)}"}, status_code=422)


for module in (routes_system, routes_settings, routes_people, routes_connectors, routes_operations,
               routes_blueprints, routes_projects, routes_inbox, routes_intake, routes_watchers,
               routes_library, routes_ai, routes_admin, routes_notifications, routes_activity, ws):
    app.include_router(module.router)
app.include_router(factory_mcp.router)


@app.api_route("/api/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"], include_in_schema=False)
async def api_not_found(path: str) -> JSONResponse:
    """A mistyped endpoint is a JSON 404 in every mode — never the SPA's HTML, which would
    fail to parse as JSON three layers up in the UI."""
    return JSONResponse({"detail": f"Unknown API endpoint: /api/{path}"}, status_code=404)


def _not_spa(path: str) -> bool:
    """Paths the SPA fallback must never answer: the API and the Factory's MCP endpoint."""
    head = path.split("/", 1)[0]
    return head in ("api", "mcp")


STATIC_DIR = c.settings.static_path.resolve()


def _inside(root: Path, candidate: Path) -> bool:
    """commonpath, not startswith: "dist2/…" must not pass for "dist/…". On Windows a path on
    another drive ("/D:/secret") makes commonpath raise instead of answering — that is "outside"."""
    try:
        return os.path.commonpath([root, candidate]) == str(root)
    except ValueError:
        return False

if (STATIC_DIR / "index.html").is_file():
    if (STATIC_DIR / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/", include_in_schema=False)
    async def spa_index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get("/{path:path}", include_in_schema=False)
    async def spa_fallback(path: str):
        if _not_spa(path):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = (STATIC_DIR / path).resolve()
        if candidate.is_file() and _inside(STATIC_DIR, candidate):
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")   # a client-side route: the SPA decides
else:
    log.info("No built UI at %s — API only (run the Vite dev server on :3070, or `npm run build`)", STATIC_DIR)
