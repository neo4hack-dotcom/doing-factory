"""SQLite document store (docs/SPEC.md §2).

One generic `docs` table (a JSON document per row, keyed by collection + id) instead of a
table per concern: the shapes live in models.py and evolve without migrations. Two
append-only tables sit next to it — `events` (the activity/audit trail, hash-chained) and
`llm_calls` (metrics) — because they are queried by time and project, not by id.

Every method is synchronous and cheap; async callers use it directly. A single connection
guarded by an RLock serialises access (WAL lets readers in other processes, e.g. a backup
tool, proceed). Never hold `store.lock` across an LLM or MCP call: compute outside, commit
briefly.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import sqlite3
import threading
from pathlib import Path
from typing import Any

from app.util import new_id, now_iso

SINGLETON = "singleton"
GENESIS = "0" * 64
_EVENT_COLUMNS = ("id", "ts", "kind", "project_id", "actor")
_FIELD = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS docs (
    coll TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
    PRIMARY KEY (coll, id));
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, ts TEXT NOT NULL,
    kind TEXT NOT NULL, project_id TEXT NOT NULL DEFAULT '', actor TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL, hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS llm_calls (
    id TEXT PRIMARY KEY, ts TEXT NOT NULL, role TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 1, latency_ms INTEGER NOT NULL DEFAULT 0,
    tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
    project_id TEXT NOT NULL DEFAULT '', step_id TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS seq (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_events_project_ts ON events(project_id, ts);
CREATE INDEX IF NOT EXISTS ix_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_llm_calls_ts ON llm_calls(ts);
"""

_LLM_FIELDS = ("id", "ts", "role", "model", "ok", "latency_ms", "tokens_in", "tokens_out",
               "project_id", "step_id", "error")
_INSERT_LLM_CALL = (f"INSERT OR REPLACE INTO llm_calls ({', '.join(_LLM_FIELDS)}) "
                    f"VALUES ({', '.join('?' for _ in _LLM_FIELDS)})")


def _llm_row(call: dict) -> tuple:
    return (
        call.get("id") or new_id("llm"), call.get("ts") or now_iso(),
        call.get("role") or "", call.get("model") or "", 1 if call.get("ok", True) else 0,
        int(call.get("latency_ms") or 0), int(call.get("tokens_in") or 0), int(call.get("tokens_out") or 0),
        call.get("project_id") or "", call.get("step_id") or "", call.get("error") or "",
    )


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def _canonical(event: dict[str, Any]) -> str:
    """The bytes the audit hash covers: every field except the hash, keys sorted."""
    body = {k: v for k, v in event.items() if k != "hash"}
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _chain(prev_hash: str, event: dict[str, Any]) -> str:
    return hashlib.sha256(f"{prev_hash}\n{_canonical(event)}".encode()).hexdigest()


class Store:
    def __init__(self, path: str | Path) -> None:
        # Connecting is deferred to first use: building the container (at import time)
        # must not touch the disk, and a closed store reopens transparently.
        self.path = str(path)
        self.lock = threading.RLock()
        self._db: sqlite3.Connection | None = None

    # ------------------------------------------------------------------ lifecycle
    def open(self) -> None:
        self._conn()

    def close(self) -> None:
        with self.lock:
            if self._db is not None:
                self._db.close()
                self._db = None

    def _conn(self) -> sqlite3.Connection:
        with self.lock:
            if self._db is None:
                if self.path != ":memory:":
                    Path(self.path).parent.mkdir(parents=True, exist_ok=True)
                # Autocommit mode; multi-statement writes open an explicit transaction.
                db = sqlite3.connect(self.path, check_same_thread=False, isolation_level=None)
                db.row_factory = sqlite3.Row
                db.execute("PRAGMA journal_mode=WAL")
                db.execute("PRAGMA synchronous=NORMAL")
                db.execute("PRAGMA busy_timeout=5000")
                db.executescript(_SCHEMA)
                self._db = db
            return self._db

    # ------------------------------------------------------------------ documents
    def get(self, coll: str, id: str) -> dict | None:
        with self.lock:
            row = self._conn().execute("SELECT data FROM docs WHERE coll=? AND id=?", (coll, id)).fetchone()
        return json.loads(row["data"]) if row else None

    def list(self, coll: str) -> list[dict]:
        """All documents of a collection, in creation order (an update keeps a doc's place)."""
        with self.lock:
            rows = self._conn().execute("SELECT data FROM docs WHERE coll=? ORDER BY rowid", (coll,)).fetchall()
        return [json.loads(r["data"]) for r in rows]

    def put(self, coll: str, doc: dict) -> dict:
        """Upsert by `doc["id"]` and return the stored copy.

        The store owns `version` (1 on create, +1 per save) and `updated_at`; values sent by
        the caller for those are ignored. Blueprint.version deliberately rides on this
        counter: every save of a blueprint is a new revision that projects snapshot. An
        empty `created_at` present in the document is filled on first save."""
        doc_id = doc.get("id")
        if not doc_id or not isinstance(doc_id, str):
            raise ValueError(f"store.put({coll!r}): document has no string 'id'")
        out = dict(doc)
        ts = now_iso()
        with self.lock:
            db = self._conn()
            row = db.execute("SELECT version FROM docs WHERE coll=? AND id=?", (coll, doc_id)).fetchone()
            out["version"] = (row["version"] + 1) if row else 1
            out["updated_at"] = ts
            if "created_at" in out and not out["created_at"]:
                out["created_at"] = ts
            db.execute(
                "INSERT INTO docs (coll, id, data, version, updated_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(coll, id) DO UPDATE SET data=excluded.data, version=excluded.version, "
                "updated_at=excluded.updated_at",
                (coll, doc_id, _dumps(out), out["version"], ts),
            )
        return out

    def count(self, coll: str, *, field: str = "", values: list[Any] | None = None) -> int:
        """Number of documents, optionally those whose top-level `field` is one of `values` —
        computed in SQL so a frequently polled counter (health, badges) never loads and
        parses whole project documents."""
        sql, params = "SELECT COUNT(*) AS n FROM docs WHERE coll = ?", [coll]
        if field:
            if not _FIELD.fullmatch(field):
                raise ValueError(f"store.count: invalid field name {field!r}")
            values = list(values or [])
            if not values:
                return 0
            sql += f" AND json_extract(data, '$.{field}') IN ({', '.join('?' for _ in values)})"
            params.extend(values)
        with self.lock:
            return int(self._conn().execute(sql, params).fetchone()["n"])

    def delete(self, coll: str, id: str) -> bool:
        with self.lock:
            cur = self._conn().execute("DELETE FROM docs WHERE coll=? AND id=?", (coll, id))
        return cur.rowcount > 0

    def get_singleton(self, coll: str, default: dict) -> dict:
        """The collection's single document (id "singleton"), or a copy of `default` when
        none was saved yet — the default is not persisted."""
        doc = self.get(coll, SINGLETON)
        return doc if doc is not None else copy.deepcopy(default)

    def put_singleton(self, coll: str, doc: dict) -> dict:
        return self.put(coll, {**doc, "id": SINGLETON})

    # ------------------------------------------------------------------ events (audit chain)
    def add_event(self, ev: dict) -> dict:
        """Append an activity event. Each event's hash covers the previous event's hash, so
        editing, deleting or splicing any row breaks every hash after it (verify_events)."""
        event = {
            "id": ev.get("id") or new_id("evt"),
            "ts": ev.get("ts") or now_iso(),
            "kind": ev.get("kind") or "",
            "actor": ev.get("actor") or "system",
            "project_id": ev.get("project_id") or "",
            "step_id": ev.get("step_id") or "",
            "message": ev.get("message") or "",
            "data": ev.get("data") or {},
        }
        with self.lock:
            db = self._conn()
            row = db.execute("SELECT hash FROM events ORDER BY seq DESC LIMIT 1").fetchone()
            event["hash"] = _chain(row["hash"] if row else GENESIS, event)
            db.execute(
                "INSERT INTO events (id, ts, kind, project_id, actor, data, hash) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (event["id"], event["ts"], event["kind"], event["project_id"], event["actor"],
                 _canonical(event), event["hash"]),
            )
        return event

    def verify_events(self) -> dict:
        """Walk the chain from the first event. `broken_at` is the id of the first event whose
        stored hash (or indexed columns) no longer follow from its content and predecessor."""
        prev = GENESIS
        count = 0
        with self.lock:
            rows = self._conn().execute(
                "SELECT id, ts, kind, project_id, actor, data, hash FROM events ORDER BY seq").fetchall()
        for row in rows:
            try:
                event = json.loads(row["data"])
            except ValueError:
                return {"ok": False, "count": count, "broken_at": row["id"]}
            if not isinstance(event, dict):
                return {"ok": False, "count": count, "broken_at": row["id"]}
            columns_match = all(str(event.get(c, "")) == str(row[c]) for c in _EVENT_COLUMNS)
            if not columns_match or row["hash"] != _chain(prev, event):
                return {"ok": False, "count": count, "broken_at": row["id"]}
            prev = row["hash"]
            count += 1
        return {"ok": True, "count": count, "broken_at": None}

    def list_events(self, *, project_id: str | None = None, kinds: list[str] | None = None,
                    limit: int | None = 200, before: str | None = None) -> list[dict]:
        """Newest first. `kinds` entries ending in "." match a prefix ("step." → every step
        event). `before` pages backwards: an event id (strictly older than that event) or an
        ISO timestamp. `limit` None/0 = no limit."""
        where: list[str] = []
        params: list[Any] = []
        if project_id:
            where.append("project_id = ?")
            params.append(project_id)
        if kinds:
            ors = []
            for kind in kinds:
                if kind.endswith("."):
                    ors.append("substr(kind, 1, ?) = ?")
                    params.extend([len(kind), kind])
                else:
                    ors.append("kind = ?")
                    params.append(kind)
            where.append("(" + " OR ".join(ors) + ")")
        with self.lock:
            db = self._conn()
            if before:
                anchor = db.execute("SELECT seq FROM events WHERE id = ?", (before,)).fetchone()
                if anchor:
                    where.append("seq < ?")
                    params.append(anchor["seq"])
                else:
                    where.append("ts < ?")
                    params.append(before)
            sql = "SELECT data, hash FROM events"
            if where:
                sql += " WHERE " + " AND ".join(where)
            sql += " ORDER BY seq DESC"
            if limit:
                sql += " LIMIT ?"
                params.append(int(limit))
            rows = db.execute(sql, params).fetchall()
        return [{**json.loads(r["data"]), "hash": r["hash"]} for r in rows]

    # ------------------------------------------------------------------ LLM calls
    def add_llm_call(self, call: dict) -> None:
        with self.lock:
            self._conn().execute(_INSERT_LLM_CALL, _llm_row(call))

    def list_llm_calls(self, *, since: str | None = None) -> list[dict]:
        """Oldest first; `since` is an inclusive ISO lower bound."""
        sql = f"SELECT {', '.join(_LLM_FIELDS)} FROM llm_calls"
        params: tuple = ()
        if since:
            sql += " WHERE ts >= ?"
            params = (since,)
        with self.lock:
            rows = self._conn().execute(sql + " ORDER BY ts, rowid", params).fetchall()
        return [{**dict(r), "ok": bool(r["ok"])} for r in rows]

    def llm_stats(self, project_id: str) -> dict:
        with self.lock:
            row = self._conn().execute(
                "SELECT COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS tokens_in, "
                "COALESCE(SUM(tokens_out), 0) AS tokens_out FROM llm_calls WHERE project_id = ?",
                (project_id,)).fetchone()
        return {"calls": row["calls"], "tokens_in": row["tokens_in"], "tokens_out": row["tokens_out"]}

    # ------------------------------------------------------------------ counters
    def next_seq(self, name: str) -> int:
        """Monotonic per-name counter (project keys UC-0007…). Survives restarts."""
        with self.lock:
            row = self._conn().execute(
                "INSERT INTO seq (name, value) VALUES (?, 1) "
                "ON CONFLICT(name) DO UPDATE SET value = value + 1 RETURNING value", (name,)).fetchone()
        return int(row["value"])

    # ------------------------------------------------------------------ backup
    def export_all(self) -> dict:
        """Everything, as plain JSON: documents per collection, the event chain (with its
        hashes, so a restored chain still verifies), LLM calls and counters."""
        with self.lock:
            db = self._conn()
            docs: dict[str, list[dict]] = {}
            for r in db.execute("SELECT coll, data FROM docs ORDER BY coll, rowid"):
                docs.setdefault(r["coll"], []).append(json.loads(r["data"]))
            events = [{**json.loads(r["data"]), "hash": r["hash"]}
                      for r in db.execute("SELECT data, hash FROM events ORDER BY seq")]
            calls = [{**dict(r), "ok": bool(r["ok"])} for r in
                     db.execute(f"SELECT {', '.join(_LLM_FIELDS)} FROM llm_calls ORDER BY ts, rowid")]
            counters = {r["name"]: r["value"] for r in db.execute("SELECT name, value FROM seq")}
        return {"format": "doing-factory-backup", "format_version": 1, "exported_at": now_iso(),
                "docs": docs, "events": events, "llm_calls": calls, "seq": counters}

    def import_all(self, data: dict) -> dict:
        """Restore a backup made by export_all, in one transaction. Each collection present
        in the backup replaces the current one wholesale; collections absent from it are
        kept. Events / LLM calls / counters are replaced only when the backup has them.
        Document versions are preserved as exported. Returns counts per section."""
        if not isinstance(data, dict) or not isinstance(data.get("docs"), dict):
            raise ValueError("Not a DOINg.AI Factory backup: missing the 'docs' section.")
        counts: dict[str, int] = {}
        with self.lock:
            db = self._conn()
            db.execute("BEGIN IMMEDIATE")
            try:
                for coll, items in data["docs"].items():
                    if not isinstance(items, list):
                        raise ValueError(f"Backup section docs.{coll} is not a list.")
                    db.execute("DELETE FROM docs WHERE coll = ?", (coll,))
                    for doc in items:
                        if not isinstance(doc, dict) or not doc.get("id"):
                            raise ValueError(f"Backup section docs.{coll} has a document without an id.")
                        db.execute(
                            "INSERT INTO docs (coll, id, data, version, updated_at) VALUES (?, ?, ?, ?, ?)",
                            (coll, doc["id"], _dumps(doc), int(doc.get("version") or 1),
                             doc.get("updated_at") or now_iso()))
                    counts[coll] = len(items)
                if isinstance(data.get("events"), list):
                    db.execute("DELETE FROM events")
                    for ev in data["events"]:
                        # Restored verbatim (hash included): the chain re-verifies only if the
                        # backup was not edited — which is the point.
                        if not isinstance(ev, dict) or not ev.get("id"):
                            raise ValueError("Backup section events has an event without an id.")
                        body = {k: v for k, v in ev.items() if k != "hash"}
                        db.execute(
                            "INSERT INTO events (id, ts, kind, project_id, actor, data, hash) "
                            "VALUES (?, ?, ?, ?, ?, ?, ?)",
                            (ev["id"], ev.get("ts") or "", ev.get("kind") or "",
                             ev.get("project_id") or "", ev.get("actor") or "", _canonical(body),
                             ev.get("hash") or ""))
                    counts["events"] = len(data["events"])
                if isinstance(data.get("llm_calls"), list):
                    db.execute("DELETE FROM llm_calls")
                    for call in data["llm_calls"]:
                        db.execute(_INSERT_LLM_CALL, _llm_row(call))
                    counts["llm_calls"] = len(data["llm_calls"])
                if isinstance(data.get("seq"), dict):
                    db.execute("DELETE FROM seq")
                    for name, value in data["seq"].items():
                        db.execute("INSERT INTO seq (name, value) VALUES (?, ?)", (name, int(value)))
                db.execute("COMMIT")
            except BaseException:
                db.execute("ROLLBACK")
                raise
        return counts
