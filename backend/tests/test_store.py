"""Core layer: the SQLite document store, the event bus, and the helpers every layer relies on."""
from __future__ import annotations

import asyncio
import threading

import pytest

from app import events
from app.events import EventBus
from app.store import SINGLETON, Store
from app.util import (apply_secret_patch, deep_merge, iso_add, is_masked, mask_secret, new_id, now_iso,
                      parse_iso, parse_json, public_connector, slugify, truncate)

# ---------------------------------------------------------------------------------- documents


def test_put_get_list_delete(store: Store):
    a = store.put("users", {"id": "usr_a", "name": "Alice", "created_at": ""})
    store.put("users", {"id": "usr_b", "name": "Bob"})
    assert a["version"] == 1 and a["updated_at"].endswith("Z")
    assert a["created_at"] == a["updated_at"]            # empty created_at filled on first save
    assert store.get("users", "usr_a")["name"] == "Alice"
    assert store.get("users", "missing") is None
    assert [u["id"] for u in store.list("users")] == ["usr_a", "usr_b"]
    assert store.list("teams") == []
    assert store.delete("users", "usr_a") is True
    assert store.delete("users", "usr_a") is False
    assert [u["id"] for u in store.list("users")] == ["usr_b"]


def test_put_bumps_version_and_keeps_creation_order(store: Store):
    store.put("rules", {"id": "r1", "title": "one"})
    store.put("rules", {"id": "r2", "title": "two"})
    updated = store.put("rules", {"id": "r1", "title": "one bis", "version": 99})   # caller's version ignored
    assert updated["version"] == 2
    assert store.get("rules", "r1") == updated
    assert [r["id"] for r in store.list("rules")] == ["r1", "r2"]


def test_put_requires_a_string_id(store: Store):
    with pytest.raises(ValueError):
        store.put("users", {"name": "nobody"})


def test_returned_documents_are_copies(store: Store):
    doc = {"id": "x", "tags": ["a"]}
    saved = store.put("things", doc)
    saved["tags"].append("mutated")
    assert store.get("things", "x")["tags"] == ["a"]
    assert "version" not in doc                           # the caller's dict is not modified


def test_singleton_default_is_not_persisted(store: Store):
    default = {"roles": []}
    got = store.get_singleton("roles", default)
    got["roles"].append("x")
    assert default == {"roles": []}
    assert store.get("roles", SINGLETON) is None
    saved = store.put_singleton("roles", {"roles": [{"key": "admin"}]})
    assert saved["id"] == SINGLETON and saved["version"] == 1
    assert store.get_singleton("roles", default)["roles"] == [{"key": "admin"}]


def test_count_filters_on_a_top_level_field(store: Store):
    for i, status in enumerate(["active", "done", "waiting", "active"]):
        store.put("projects", {"id": f"p{i}", "status": status})
    assert store.count("projects") == 4
    assert store.count("projects", field="status", values=["active", "waiting"]) == 3
    assert store.count("projects", field="status", values=[]) == 0
    with pytest.raises(ValueError):
        store.count("projects", field="status') OR 1=1 --", values=["x"])


def test_reopens_after_close(store: Store):
    store.put("users", {"id": "u"})
    store.close()
    assert store.get("users", "u") is not None


# ---------------------------------------------------------------------------------- events


def _chain(store: Store, n: int = 3) -> list[dict]:
    return [store.add_event({"kind": "step.completed" if i % 2 else "project.created", "message": f"m{i}",
                             "project_id": "prj_1" if i < 2 else "prj_2", "data": {"i": i}})
            for i in range(n)]


def test_events_are_hash_chained_and_verify(store: Store):
    evs = _chain(store)
    assert all(e["id"].startswith("evt_") and len(e["hash"]) == 64 for e in evs)
    assert evs[0]["actor"] == "system"
    assert store.verify_events() == {"ok": True, "count": 3, "broken_at": None}
    assert Store(store.path).verify_events()["ok"] is True      # verifiable from a fresh connection


def test_verify_detects_edited_content(store: Store):
    evs = _chain(store)
    with store.lock:
        store._conn().execute("UPDATE events SET data = replace(data, '\"m1\"', '\"edited\"') WHERE id = ?",
                              (evs[1]["id"],))
    assert store.verify_events() == {"ok": False, "count": 1, "broken_at": evs[1]["id"]}


def test_verify_detects_a_deleted_event(store: Store):
    evs = _chain(store)
    with store.lock:
        store._conn().execute("DELETE FROM events WHERE id = ?", (evs[1]["id"],))
    assert store.verify_events()["broken_at"] == evs[2]["id"]


def test_verify_detects_a_rewritten_index_column(store: Store):
    evs = _chain(store)
    with store.lock:
        store._conn().execute("UPDATE events SET actor = 'usr_mallory' WHERE id = ?", (evs[0]["id"],))
    assert store.verify_events()["broken_at"] == evs[0]["id"]


def test_list_events_filters(store: Store):
    evs = _chain(store, 5)
    assert [e["id"] for e in store.list_events()] == [e["id"] for e in reversed(evs)]   # newest first
    assert {e["project_id"] for e in store.list_events(project_id="prj_1")} == {"prj_1"}
    assert {e["kind"] for e in store.list_events(kinds=["step."])} == {"step.completed"}
    assert len(store.list_events(kinds=["project.created", "step.completed"])) == 5
    assert len(store.list_events(limit=2)) == 2
    assert [e["id"] for e in store.list_events(before=evs[2]["id"])] == [evs[1]["id"], evs[0]["id"]]
    assert store.list_events()[0]["hash"] == evs[-1]["hash"]


# ---------------------------------------------------------------------------------- llm calls, counters


def test_llm_calls_and_stats(store: Store):
    store.add_llm_call({"ts": "2026-01-01T00:00:00Z", "role": "writer", "model": "m", "tokens_in": 10,
                        "tokens_out": 5, "project_id": "prj_1"})
    store.add_llm_call({"ts": "2026-02-01T00:00:00Z", "role": "critic", "ok": False, "error": "boom",
                        "tokens_in": 3, "project_id": "prj_1"})
    store.add_llm_call({"ts": "2026-03-01T00:00:00Z", "role": "writer", "tokens_in": 100})
    assert store.llm_stats("prj_1") == {"calls": 2, "tokens_in": 13, "tokens_out": 5}
    assert store.llm_stats("none") == {"calls": 0, "tokens_in": 0, "tokens_out": 0}
    calls = store.list_llm_calls(since="2026-02-01T00:00:00Z")
    assert [c["role"] for c in calls] == ["critic", "writer"]
    assert calls[0]["ok"] is False and calls[0]["error"] == "boom" and calls[0]["id"]


def test_next_seq_is_monotonic_per_name_and_thread_safe(store: Store):
    assert [store.next_seq("UC") for _ in range(3)] == [1, 2, 3]
    assert store.next_seq("MCP") == 1
    seen: list[int] = []

    def worker() -> None:
        for _ in range(20):
            seen.append(store.next_seq("race"))

    threads = [threading.Thread(target=worker) for _ in range(5)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(seen) == list(range(1, 101))


# ---------------------------------------------------------------------------------- backup


def test_export_import_round_trip(store: Store, tmp_path):
    store.put("users", {"id": "usr_a", "name": "Alice"})
    store.put("users", {"id": "usr_a", "name": "Alice M."})
    store.put_singleton("settings", {"llm": {"model": "m"}})
    _chain(store)
    store.add_llm_call({"role": "writer", "tokens_in": 4})
    store.next_seq("UC")
    backup = store.export_all()

    target = Store(tmp_path / "restored.db")
    target.put("users", {"id": "usr_old", "name": "Replaced"})
    target.put("teams", {"id": "team_kept", "name": "Absent from the backup: kept"})
    counts = target.import_all(backup)
    assert counts["users"] == 1 and counts["events"] == 3 and counts["llm_calls"] == 1
    assert [u["id"] for u in target.list("users")] == ["usr_a"]
    assert target.get("users", "usr_a")["version"] == 2
    assert target.get("teams", "team_kept") is not None
    assert target.verify_events() == {"ok": True, "count": 3, "broken_at": None}
    assert target.next_seq("UC") == 2
    target.close()


def test_import_is_all_or_nothing(store: Store):
    store.put("users", {"id": "usr_a"})
    with pytest.raises(ValueError):
        store.import_all({"docs": {"users": [{"id": "usr_b"}, {"name": "no id"}]}})
    assert [u["id"] for u in store.list("users")] == ["usr_a"]
    with pytest.raises(ValueError):
        store.import_all({"not": "a backup"})


# ---------------------------------------------------------------------------------- event bus


def test_bus_fans_out_and_drops_oldest_for_a_slow_subscriber(monkeypatch):
    monkeypatch.setattr(events, "QUEUE_SIZE", 3)

    async def scenario() -> None:
        bus = EventBus()
        fast, slow = bus.subscribe(), bus.subscribe()
        bus.emit("hello", n=0)
        assert (await fast.get())["n"] == 0
        for n in range(1, 6):
            bus.emit("tick", n=n)
        drained = [slow.get_nowait()["n"] for _ in range(slow.qsize())]
        assert drained == [3, 4, 5]                          # newest kept, oldest dropped
        assert bus.dropped >= 3
        bus.unsubscribe(slow)
        bus.emit("after", n=6)
        assert slow.empty()
        event = (await fast.get())
        assert event["type"] == "tick" and event["ts"].endswith("Z")

    asyncio.run(scenario())


def test_bus_emit_from_a_worker_thread():
    async def scenario() -> None:
        bus = EventBus()
        q = bus.subscribe()
        await asyncio.to_thread(bus.emit, "from.thread", x=1)
        event = await asyncio.wait_for(q.get(), timeout=2)
        assert event["type"] == "from.thread" and event["x"] == 1

    asyncio.run(scenario())


# ---------------------------------------------------------------------------------- util


def test_ids_and_time():
    assert new_id("usr").startswith("usr_") and len(new_id("usr_")) == len("usr_") + 12
    stamp = now_iso()
    assert stamp.endswith("Z") and parse_iso(stamp) is not None
    assert parse_iso("2026-10-11T14:03:00") == parse_iso("2026-10-11T14:03:00Z")    # naive = UTC
    assert parse_iso("not a date") is None and parse_iso("") is None
    assert iso_add(2, "2026-10-11T14:03:00Z") == "2026-10-11T16:03:00Z"


@pytest.mark.parametrize("text,expected", [
    ('{"a": 1}', {"a": 1}),
    ('Sure!\n```json\n{"a": [1, 2]}\n```\nDone.', {"a": [1, 2]}),
    ('<think>hmm {"no": 1}</think>{"a": 2}', {"a": 2}),
    ('The answer is {"a": 3, "b": [1,],} as requested', {"a": 3, "b": [1]}),
    ('[{"k": "v"}] trailing', [{"k": "v"}]),
    ("no json at all", None),
    ("", None),
    ('{"unterminated": ', None),
])
def test_parse_json_is_tolerant_but_never_invents(text, expected):
    assert parse_json(text) == expected


def test_secrets_masking():
    assert mask_secret("") == ""
    assert mask_secret("sk-0123456789abcdef").endswith("cdef") and is_masked(mask_secret("sk-0123456789abcdef"))
    assert "short" not in mask_secret("short")
    patch = {"api_key": "", "model": "m"}
    assert apply_secret_patch(patch, "api_key") == {"model": "m"}                      # "" keeps stored
    assert apply_secret_patch({"api_key": mask_secret("x" * 20)}, "api_key") == {}     # masked keeps stored
    assert apply_secret_patch({"api_key": None}, "api_key") == {"api_key": ""}         # null clears
    assert apply_secret_patch({"api_key": "new"}, "api_key") == {"api_key": "new"}
    conn = public_connector({"env": {"JIRA_TOKEN": "abcdefghijklmnopqrst", "MODE": "sandbox"},
                             "headers": {"Authorization": "Bearer abcdefghijklmnop"},
                             "args": ["--url", "https://bob:hunter2@jira.local"], "url": ""})
    assert conn["env"]["MODE"] == "sandbox" and is_masked(conn["env"]["JIRA_TOKEN"])
    assert is_masked(conn["headers"]["Authorization"]) and "hunter2" not in conn["args"][1]


def test_text_and_dict_helpers():
    assert slugify("Chloé's MCP — v2") == "chloe_s_mcp_v2"
    assert truncate("abcdef", 4) == "abc…" and truncate(None, 3) == "" and truncate("ab", 4) == "ab"
    merged = deep_merge({"llm": {"model": "a", "temperature": 0.2}, "tags": [1]}, {"llm": {"model": "b"}, "tags": [2]})
    assert merged == {"llm": {"model": "b", "temperature": 0.2}, "tags": [2]}
