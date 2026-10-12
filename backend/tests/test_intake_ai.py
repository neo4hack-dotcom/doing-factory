"""Intake AI triage degrades honestly: a failure (no LLM, model error) is recorded on the item
as `ai_error` — persisted, pushed on the bus, returned by POST /intake/{id}/analyze with 200 —
cleared by a later success, and items that only waited for an LLM become triage candidates
again once one is configured (never retried in a loop meanwhile)."""
from __future__ import annotations

import asyncio

import pytest

from app.errors import LLMError, LLMNotConfigured
from app.models import IntakeItem
from tests.test_api_fakes import ScriptedLLM, record_bus

MISSING = LLMNotConfigured().message


def _item(container, iid: str = "int_1", **extra) -> dict:
    doc = IntakeItem.model_validate({"id": iid, "watcher_name": "Planning", "title": "Payments analytics",
                                     "raw": {"name": "Payments analytics"}, "status": "new",
                                     "detected_at": "2026-10-01T09:00:00Z", **extra}).model_dump()
    container.store.put("intake", doc)
    return doc


def _raise(exc: Exception):
    def reply(messages, kwargs):
        raise exc
    return reply


def test_analyze_without_llm_records_the_error_and_returns_the_item(client, container, monkeypatch):
    _item(container)
    bus = record_bus(monkeypatch, container)
    assert not container.ai.configured

    r = client.post("/api/intake/int_1/analyze")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["id"] == "int_1" and body["ai_error"] == MISSING and body["ai_busy"] is False
    assert body["suggestion"] is None
    stored = container.store.get("intake", "int_1")
    assert stored["ai_error"] == MISSING and stored["ai_busy"] is False
    assert [e["item"]["ai_error"] for e in bus.of("intake.updated")] == [MISSING]

    assert client.post("/api/intake/nope/analyze").status_code == 404


def test_model_failure_is_recorded_then_cleared_by_a_success(client, container, monkeypatch):
    _item(container)
    container.llm = ScriptedLLM([_raise(LLMError("The model server returned 500."))])
    r = client.post("/api/intake/int_1/analyze")
    assert r.status_code == 200, r.text
    assert r.json()["ai_error"] == "The model server returned 500." and r.json()["ai_busy"] is False

    bus = record_bus(monkeypatch, container)
    container.llm = ScriptedLLM([{"summary": "Treasury wants analytics.", "priority": "high", "blueprint_id": "",
                                  "team_id": "", "sponsor_id": "", "owner_id": "", "required_capabilities": [],
                                  "rationale": "Dated commitment.", "confidence": "medium"}])
    r = client.post("/api/intake/int_1/analyze")
    assert r.status_code == 200, r.text
    item = r.json()
    assert item["ai_error"] == "" and item["ai_busy"] is False
    assert item["suggestion"]["priority"] == "high" and item["suggestion"]["summary"] == "Treasury wants analytics."
    updates = [e["item"] for e in bus.of("intake.updated")]
    assert updates[0]["ai_busy"] is True and updates[-1]["ai_error"] == "" and updates[-1]["suggestion"]


def test_failure_keeps_the_previous_suggestion(client, container):
    _item(container, suggestion={"summary": "Earlier triage", "priority": "medium"})
    container.llm = ScriptedLLM([_raise(LLMError("timeout"))])
    item = client.post("/api/intake/int_1/analyze").json()
    assert item["ai_error"] == "timeout" and item["suggestion"]["summary"] == "Earlier triage"


def test_conflicts_are_still_http_errors(client, container):
    _item(container, status="dismissed")
    assert client.post("/api/intake/int_1/analyze").status_code == 409
    assert container.store.get("intake", "int_1")["ai_error"] == ""


def test_service_call_still_raises_for_the_scheduler(container):
    _item(container)
    with pytest.raises(LLMNotConfigured):
        asyncio.run(container.watchers.analyze_intake("int_1"))
    assert container.store.get("intake", "int_1")["ai_error"] == MISSING


def test_llm_waits_are_released_only_once_an_llm_is_configured(client, container):
    _item(container, "int_wait", ai_error=MISSING)
    _item(container, "int_failed", ai_error="The model server returned 500.")
    _item(container, "int_done", ai_error=MISSING, status="dismissed")

    assert container.watchers.release_llm_waits() == 0          # still no LLM: nothing to retry
    assert container.store.get("intake", "int_wait")["ai_error"] == MISSING

    # Connecting a model in Settings releases the items that only waited for it.
    r = client.put("/api/settings", json={"llm": {"provider": "ollama", "base_url": "http://127.0.0.1:9",
                                                  "model": "qwen3.5:4b"}})
    assert r.status_code == 200, r.text
    assert container.ai.configured
    assert container.store.get("intake", "int_wait")["ai_error"] == ""
    assert container.store.get("intake", "int_failed")["ai_error"] == "The model server returned 500."  # explicit Analyze only
    assert container.store.get("intake", "int_done")["ai_error"] == MISSING


def test_startup_cleanup_releases_llm_waits_when_configured(container):
    _item(container, "int_wait", ai_error=MISSING, ai_busy=True)
    container.llm = ScriptedLLM([])
    assert container.watchers.reset_stale_busy() == 1
    item = container.store.get("intake", "int_wait")
    assert item["ai_busy"] is False and item["ai_error"] == ""
