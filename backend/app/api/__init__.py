"""HTTP layer: one router per concern, all under /api, plus the WebSocket (`ws.py`).

The helpers below are shared by every router. They take explicit arguments and never import
the container, so importing `app.api` has no side effect.
"""
from __future__ import annotations

import logging
from typing import Any

from pydantic import BaseModel, ValidationError

from app.errors import FactoryError, NotFound
from app.models import AppSettings
from app.util import validation_message

log = logging.getLogger("factory.api")


def shape(model: type[BaseModel], doc: dict[str, Any]) -> dict[str, Any]:
    """A stored document as the API returns it: normalised through its model, so an older
    document gains the defaults of newer fields and store bookkeeping the model does not
    declare is dropped. A document that no longer validates is returned as stored (and
    logged) — one bad row must not blank a whole screen."""
    try:
        return model.model_validate(doc).model_dump()
    except ValidationError as exc:
        log.warning("%s %s does not match its model (%s) — returned as stored",
                    model.__name__, doc.get("id", "?"), validation_message(exc))
        return doc


def shape_all(model: type[BaseModel], docs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [shape(model, d) for d in docs]


def validate(model: type[BaseModel], data: dict[str, Any], what: str) -> BaseModel:
    """Validate user input, turning pydantic's error list into one readable 422."""
    try:
        return model.model_validate(data)
    except ValidationError as exc:
        raise FactoryError(f"Invalid {what} — {validation_message(exc)}", 422) from exc


_SERVER_OWNED = frozenset({"id", "created_at", "updated_at", "version"})


def editable(model: type[BaseModel], body: dict[str, Any]) -> dict[str, Any]:
    """The part of a create/update body that a client may set on a `model` document: its
    declared fields, minus server-owned ones, minus nulls (a partial update leaves a field
    it sends as null unchanged). The merged result is validated through the model after."""
    return {k: v for k, v in (body or {}).items()
            if k in model.model_fields and k not in _SERVER_OWNED and v is not None}


def found(doc: dict[str, Any] | None, what: str, id: str) -> dict[str, Any]:
    if doc is None:
        raise NotFound(f"{what} {id} not found")
    return doc


def actor(user_id: str | None) -> str:
    """The audit actor of a mutation: the "acting as" persona, or "system" when none is sent."""
    return (user_id or "").strip() or "system"


def public_settings(settings: AppSettings) -> dict[str, Any]:
    """AppSettings as the browser sees it: the API key never leaves the server — the UI only
    learns whether one is set (SPEC §3.1)."""
    out = settings.model_dump()
    out["has_api_key"] = bool(settings.llm.api_key)
    out["llm"]["api_key"] = ""
    return out
