"""WatcherService: polls an external system through an Operation, turns each new item into an
intake item (or an auto-started project), and handles the intake decisions (SPEC §3.6, §12, §14).

A run: operation → `items_expr` → a stable key per item → `filter` → unseen? → act. "Seen"
is a bounded list of keys kept on the watcher, so a restart never re-detects the backlog.
A key is marked seen only once its action succeeded: a failing item is retried on the next
run instead of being silently lost, and one bad item never aborts the others.

Intake triage (`analyze_intake`) asks the local LLM for a suggestion (blueprint, priority,
team, sponsor, owner). Every id it returns is checked against the real lists and dropped
when unknown — the UI shows an honest blank rather than a made-up reference.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from jinja2 import Undefined

from app.engine import templating
from app.errors import (Conflict, EngineError, FactoryError, LLMError, LLMNotConfigured, MCPError, NotConfigured,
                        NotFound)
from app.models import IntakeItem, IntakeSuggestion, Watcher
from app.util import new_id, now_iso, parse_iso, to_iso, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.watchers")

SEEN_CAP = 5000            # keys remembered per watcher (oldest forgotten first)
PREVIEW_MAX = 10           # items echoed back by a run, for the "Run now" panel
NOTIFY_EACH_MAX = 3        # beyond this many new items in one run, one summary notification
RAW_PROMPT_CHARS = 6000    # use case record shown to the intake analyst
PRIORITIES = ("low", "medium", "high", "critical")
TRIAGE_ROLES = frozenset({"product_manager", "admin"})
SUGGESTION_PEOPLE_ROLES = frozenset({"sponsor", "product_manager", "business_user"})
LIVE_PROJECT = frozenset({"active", "waiting", "blocked", "done"})

_PRIORITY_WORDS = {
    "critical": "critical", "urgent": "critical", "blocker": "critical", "highest": "critical", "p0": "critical",
    "high": "high", "important": "high", "major": "high", "p1": "high",
    "medium": "medium", "normal": "medium", "moderate": "medium", "p2": "medium",
    "low": "low", "lowest": "low", "minor": "low", "trivial": "low", "p3": "low", "p4": "low",
}

SUGGESTION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "blueprint_id": {"type": "string"},
        "priority": {"type": "string", "enum": list(PRIORITIES)},
        "team_id": {"type": "string"},
        "sponsor_id": {"type": "string"},
        "owner_id": {"type": "string"},
        "required_capabilities": {"type": "array", "items": {"type": "string"}},
        "rationale": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
    },
    "required": ["summary", "blueprint_id", "priority", "team_id", "sponsor_id", "required_capabilities",
                 "rationale"],
}


class WatcherService:
    def __init__(self, container: "Container") -> None:
        self.c = container
        # In-flight work, per process. asyncio is single-threaded: a check-then-add with no
        # await in between is atomic, so plain sets are enough to serialise.
        self._running: set[str] = set()      # watcher ids
        self._analyzing: set[str] = set()    # intake ids
        self._deciding: set[str] = set()     # intake ids being accepted / dismissed
        self._bad_tz: str = ""

    def is_running(self, watcher_id: str) -> bool:
        return watcher_id in self._running

    def is_analyzing(self, intake_id: str) -> bool:
        return intake_id in self._analyzing

    # ================================================================== scheduling
    def due(self, now: datetime) -> list[dict]:
        """Enabled watchers whose next run is due, inside their active days/hours (evaluated in
        Settings › Scheduler timezone). A watcher that never ran is due at once."""
        now = _aware(now)
        local = now.astimezone(self._tz())
        due = []
        for watcher in self.c.store.list("watchers"):
            if not watcher.get("enabled", True):
                continue
            next_run = parse_iso((watcher.get("state") or {}).get("next_run_at"))
            if next_run is not None and next_run > now:
                continue
            if in_window(watcher.get("schedule") or {}, local):
                due.append(watcher)
        due.sort(key=lambda w: (w.get("state") or {}).get("next_run_at") or "")
        return due

    def schedule_next(self, watcher_id: str, now: datetime) -> dict | None:
        """Push next_run_at one interval ahead — the scheduler calls this *before* a run, so a
        run that crashes or hangs can never make the watcher fire on every tick."""
        watcher = self.c.store.get("watchers", watcher_id)
        if watcher is None:
            return None
        state = dict(watcher.get("state") or {})
        state["next_run_at"] = to_iso(_aware(now) + _interval(watcher))
        return self.c.store.put("watchers", {**watcher, "state": state})

    def _tz(self) -> ZoneInfo | timezone:
        name = self.c.app_settings().scheduler.timezone or "UTC"
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            if self._bad_tz != name:
                self._bad_tz = name
                log.warning("Unknown scheduler timezone %r — using UTC (fix it in Settings › Engine)", name)
            return timezone.utc

    # ================================================================== runs
    async def run(self, watcher_id: str, *, actor: str = "system") -> dict:
        """Run one watcher now → {ok, total, new, error, items_preview}. A run already in
        progress for the same watcher is a 409, never a second concurrent run."""
        watcher = self.c.store.get("watchers", watcher_id)
        if watcher is None:
            raise NotFound(f"Watcher {watcher_id} not found")
        if watcher_id in self._running:
            raise Conflict(f"Watcher '{watcher.get('name') or watcher_id}' is already running — "
                           f"wait for this run to finish.")
        self._running.add(watcher_id)
        try:
            return await self._run(watcher, actor)
        finally:
            self._running.discard(watcher_id)

    async def _run(self, watcher: dict, actor: str) -> dict:
        started = datetime.now(timezone.utc)
        try:
            items, operation, blueprint = await self._fetch(watcher)
        except Exception as exc:  # noqa: BLE001 — the run fails as a whole, with the reason on the watcher
            message = _message(exc)
            if not isinstance(exc, FactoryError):
                log.exception("Watcher %s failed", watcher.get("id"))
            return self._finish(watcher, started, actor, error=message, total=0, new=0, seen=None, preview=[],
                                notes=[])

        state = watcher.get("state") or {}
        seen: list[str] = list(state.get("seen_keys") or [])
        seen_set = set(seen)
        baseline = bool(watcher.get("baseline_on_first_run")) and not state.get("runs") and not seen
        open_intake = {i.get("external_id") for i in self.c.store.list("intake")
                       if i.get("watcher_id") == watcher["id"] and i.get("status") == "new"}
        live_projects = {(p.get("source") or {}).get("external_id") for p in self.c.store.list("projects")
                         if (p.get("source") or {}).get("watcher_id") == watcher["id"]
                         and p.get("status") in LIVE_PROJECT}

        entries: list[dict] = []
        detected: list[dict] = []
        notes: list[str] = []
        failures: list[str] = []
        for index, raw in enumerate(items):
            entry: dict[str, Any] = {"key": "", "title": "", "outcome": ""}
            entries.append(entry)
            try:
                if not isinstance(raw, dict):
                    raise FactoryError(f"item #{index + 1} is not an object ({_describe(raw)})", 422)
                key = _key(raw, watcher.get("key_field") or "id")
                entry["key"], entry["title"] = key, _title(raw, watcher.get("title_field") or "title", key)
                entry["item"] = _preview(raw)
                if key in seen_set:
                    entry["outcome"] = "seen"
                    continue
                if watcher.get("filter") and not templating.condition(_bare(watcher["filter"]), {"item": raw}):
                    entry["outcome"] = "filtered"   # not remembered: it may match a later run
                    continue
                if baseline:
                    entry["outcome"] = "baseline"
                elif watcher.get("action") == "auto_start":
                    if key in live_projects:
                        entry["outcome"] = "duplicate"
                    else:
                        project, item_notes = await self._auto_start(watcher, operation, blueprint, key, raw)
                        entry.update(outcome="started", project_id=project.get("id"), project_key=project.get("key"))
                        notes.extend(f"{key}: {n}" for n in item_notes)
                        detected.append({"title": entry["title"], "project": project})
                else:
                    if key in open_intake:
                        entry["outcome"] = "duplicate"   # already waiting in Intake (e.g. after a reset)
                    else:
                        intake = self._detect(watcher, key, entry["title"], raw)
                        entry.update(outcome="new", intake_id=intake["id"])
                        detected.append({"title": entry["title"], "intake": intake})
                seen.append(key)
                seen_set.add(key)
            except Exception as exc:  # noqa: BLE001 — one bad item never aborts the run
                message = _message(exc)
                if not isinstance(exc, FactoryError):
                    log.exception("Watcher %s: item %s failed", watcher.get("id"), entry["key"] or index)
                entry.update(outcome="error", error=message)
                failures.append(f"{entry['key'] or f'item #{index + 1}'}: {message}")

        if detected and watcher.get("action") != "auto_start":
            await self._notify_triage(watcher, detected)
        error = ""
        if failures:
            error = truncate(f"{len(failures)} item{'s' if len(failures) != 1 else ''} failed — "
                             + "; ".join(failures[:3]), 500)
        preview = sorted(entries, key=lambda e: {"error": 0, "new": 1, "started": 1}.get(e["outcome"], 2))[:PREVIEW_MAX]
        return self._finish(watcher, started, actor, error=error, total=len(items), new=len(detected), seen=seen,
                            preview=preview, notes=notes, all_failed=bool(failures) and not detected)

    async def _fetch(self, watcher: dict) -> tuple[list, dict, dict | None]:
        """Run the operation and evaluate items_expr. Raises with a message naming the fix."""
        key = (watcher.get("operation_key") or "").strip()
        if not key:
            raise NotConfigured("This watcher has no operation — pick one in Settings › Watchers.")
        operation = self.c.get_operation_by_key(key)
        if operation is None:
            raise NotConfigured(f"Operation '{key}' does not exist — create it in Studio › Operations "
                                f"or pick another one in Settings › Watchers.")
        blueprint = None
        if watcher.get("action") == "auto_start":
            blueprint = self.c.get_blueprint(watcher.get("blueprint_id") or "")
            if blueprint is None:
                raise NotConfigured("This watcher starts projects automatically but has no valid blueprint — "
                                    "pick one in Settings › Watchers.")
        result = _as_dict(await self.c.ops.run(operation, dict(watcher.get("input") or {})))
        if not result.get("ok"):
            raise MCPError(f"Operation '{key}' failed: {result.get('error') or 'no detail returned'}")
        items = templating.evaluate(_bare(watcher.get("items_expr") or "result"), {"result": result.get("output")})
        if not isinstance(items, list):
            raise FactoryError(f"items_expr did not return a list: got {_describe(items)}", 422)
        return items, operation, blueprint

    def _finish(self, watcher: dict, started: datetime, actor: str, *, error: str, total: int, new: int,
                seen: list[str] | None, preview: list[dict], notes: list[str], all_failed: bool = False) -> dict:
        """Persist the run's state on the latest copy of the watcher (it may have been edited
        meanwhile), push it live and audit it."""
        failed = seen is None or all_failed
        latest = self.c.store.get("watchers", watcher["id"]) or watcher
        state = dict(latest.get("state") or {})
        finished = datetime.now(timezone.utc)
        state.update(last_run_at=to_iso(finished), next_run_at=to_iso(finished + _interval(latest)),
                     last_status="error" if failed else "ok", last_error=error, last_count=total, last_new=new,
                     runs=int(state.get("runs") or 0) + 1, new_total=int(state.get("new_total") or 0) + new)
        if seen is not None:
            state["seen_keys"] = seen[-SEEN_CAP:]
        doc = self.c.store.put("watchers", {**latest, "state": state})
        shaped = Watcher.model_validate(doc).model_dump()
        self.c.bus.emit("watcher.updated", watcher=shaped)

        name = latest.get("name") or latest["id"]
        if seen is None:
            message = f"Watcher '{name}' failed: {error}"
        else:
            message = f"Watcher '{name}' ran: {total} item{'s' if total != 1 else ''}, {new} new"
            if error:
                message += f" ({error})"
        data = {"watcher_id": latest["id"], "ok": not failed, "total": total, "new": new, "error": error,
                "duration_ms": int((finished - started).total_seconds() * 1000)}
        if notes:
            data["notes"] = notes[:20]
        self.c.record_event("watcher.run", truncate(message, 600), actor=actor, data=data)
        return {"ok": not failed, "total": total, "new": new, "error": error, "items_preview": preview}

    def _detect(self, watcher: dict, key: str, title: str, raw: dict) -> dict:
        doc = IntakeItem(id=new_id("int"), watcher_id=watcher["id"], watcher_name=watcher.get("name") or "",
                         external_id=key, title=title, raw=_jsonable(raw), status="new",
                         detected_at=now_iso()).model_dump()
        self.c.store.put("intake", doc)
        self.c.bus.emit("intake.updated", item=doc)
        self.c.record_event("intake.detected", f"New item detected by '{watcher.get('name') or watcher['id']}': "
                                               f"{truncate(title, 160)}",
                            data={"intake_id": doc["id"], "watcher_id": watcher["id"], "external_id": key})
        return doc

    async def _auto_start(self, watcher: dict, operation: dict, blueprint: dict | None, key: str,
                          raw: dict) -> tuple[dict, list[str]]:
        assert blueprint is not None   # checked by _fetch
        fields, notes = self._mapped(watcher, raw, key)
        project = await self.c.engine.create_project(
            blueprint["id"], title=fields["title"], description=fields["description"], inputs=fields["inputs"],
            priority=fields["priority"], sponsor_id=fields["sponsor_id"], owner_id=fields["owner_id"],
            team_id=fields["team_id"], tags=fields["tags"], due_date=fields["due_date"],
            source=_source(watcher, operation, key, raw), created_by="system")
        if notes:
            self.c.record_event("project.updated", "Started by watcher "
                                f"'{watcher.get('name') or watcher['id']}' — " + " ".join(notes),
                                project_id=project.get("id") or "", data={"watcher_id": watcher["id"],
                                                                          "notes": notes})
        return project, notes

    async def _notify_triage(self, watcher: dict, detected: list[dict]) -> None:
        """Tell product managers and admins that Intake has something new — one notification
        per item for a few, one summary for a batch (a first run can find dozens)."""
        users = [u["id"] for u in self.c.users() if u.get("active", True) and TRIAGE_ROLES & set(u.get("roles") or [])]
        if not users:
            return
        name = watcher.get("name") or "a watcher"
        try:
            if len(detected) <= NOTIFY_EACH_MAX:
                for item in detected:
                    await self.c.notifier.notify(users, "task", f"New use case to triage: {truncate(item['title'], 120)}",
                                                 f"Detected by {name}. Open Intake to review the AI triage and start it.")
            else:
                await self.c.notifier.notify(users, "task", f"{len(detected)} new use cases to triage",
                                             f"Detected by {name}. Open Intake to review and start them.")
        except Exception:  # noqa: BLE001 — the items are in Intake whether or not the bell rang
            log.exception("Could not notify triage users about watcher %s", watcher.get("id"))

    # ================================================================== field mapping
    def _mapped(self, watcher: dict, raw: dict, key: str) -> tuple[dict, list[str]]:
        """Project fields from the watcher mapping rendered over {item} (SPEC §3.6). Returns the
        fields plus notes about values that could not be used (unknown sponsor email…)."""
        title = _title(raw, watcher.get("title_field") or "title", key)
        fields: dict[str, Any] = {"title": title, "description": _text(raw.get("description")), "priority": "medium",
                                  "sponsor_id": "", "owner_id": "", "team_id": "", "due_date": None, "tags": [],
                                  "inputs": {}}
        notes: list[str] = []
        mapping = watcher.get("mapping") or {}
        if not mapping:
            return fields, notes
        rendered = _clean(templating.render_obj(dict(mapping), {"item": raw}))
        for name, value in (rendered or {}).items():
            if name.startswith("inputs."):
                if name[len("inputs."):].strip():
                    fields["inputs"][name[len("inputs."):].strip()] = value
            elif name == "title":
                fields["title"] = truncate(_text(value), 200) or title
            elif name == "description":
                fields["description"] = _text(value)
            elif name == "priority":
                fields["priority"] = normalize_priority(value)
            elif name == "tags":
                fields["tags"] = _tags(value)
            elif name in ("sponsor_email", "owner_email"):
                email = _text(value)
                if email:
                    user = self.c.user_by_email(email)
                    role = name.split("_")[0]
                    if user is not None:
                        fields[f"{role}_id"] = user["id"]
                    else:
                        notes.append(f"{role.capitalize()} email {email} does not match any Factory user — "
                                     f"add them in Settings › People & Teams.")
            elif name in ("sponsor_id", "owner_id", "team_id"):
                ref = _text(value)
                exists = self.c.get_team(ref) if name == "team_id" else self.c.get_user(ref)
                if ref and exists:
                    fields[name] = ref
                elif ref:
                    notes.append(f"{name} {ref} does not exist and was ignored.")
            elif name == "due_date":
                text = _text(value)
                if text and parse_iso(text):
                    fields["due_date"] = text
                elif text:
                    notes.append(f"Due date '{truncate(text, 40)}' is not a date and was ignored.")
            else:
                notes.append(f"Mapping key '{name}' is not a project field and was ignored.")
        return fields, notes

    # ================================================================== intake decisions
    async def analyze_intake(self, intake_id: str, *, raise_on_failure: bool = True) -> dict:
        """AI triage of one new intake item → its `suggestion`. An AI failure — no LLM
        configured, a model error — is recorded on the item as `ai_error` (ai_busy false,
        `intake.updated` pushed, the previous suggestion kept) and then raised, or, with
        `raise_on_failure=False`, the updated item is returned. A later success clears it.
        Unknown ids (NotFound) and items not analysable now (Conflict) always raise."""
        item = self._intake(intake_id)
        if item.get("status") != "new":
            raise Conflict(f"This item was already {item.get('status')} — only new items are analysed.")
        if intake_id in self._analyzing:
            raise Conflict("The AI is already analysing this item.")
        if not self.c.ai.configured:
            missing = LLMNotConfigured()
            doc = self._save_intake(intake_id, ai_busy=False, ai_error=missing.message)
            if raise_on_failure:
                raise missing
            return doc
        self._analyzing.add(intake_id)
        try:
            item = self._save_intake(intake_id, ai_busy=True, ai_error="")
            try:
                prompt, catalog = self._triage_prompt(item)
                answer = await self.c.ai.ask("intake_analyst", prompt, prompt_key="intake_analyst",
                                             json_schema=SUGGESTION_SCHEMA)
                suggestion = clean_suggestion(answer, catalog)
            except Exception as exc:
                doc = self._save_intake(intake_id, ai_busy=False, ai_error=_message(exc))
                if raise_on_failure:
                    raise
                return doc
            except BaseException:   # cancelled (shutdown): just clear the spinner
                self._save_intake(intake_id, ai_busy=False)
                raise
            return self._save_intake(intake_id, ai_busy=False, ai_error="", suggestion=suggestion)
        finally:
            self._analyzing.discard(intake_id)

    def release_llm_waits(self) -> int:
        """Clear the "no LLM configured" `ai_error` of new, unsuggested items once an LLM is
        configured, so the scheduler's enrichment triages them (it skips items with an
        ai_error — and does not run at all without an LLM — so nothing loops meanwhile).
        Other AI failures stay until an explicit Analyze. Returns how many were released."""
        if not self.c.ai.configured:
            return 0
        missing = LLMNotConfigured().message
        released = 0
        for item in self.c.store.list("intake"):
            if (item.get("status") == "new" and item.get("ai_error") == missing and not item.get("suggestion")
                    and item.get("id") not in self._analyzing):
                self._save_intake(item["id"], ai_error="")
                released += 1
        return released

    async def accept_intake(self, intake_id: str, user_id: str, overrides: dict) -> dict:
        """Start a project from an intake item → the Project. Blueprint precedence: explicit
        override → AI suggestion → watcher default; field values: override → suggestion →
        watcher mapping. With no owner named anywhere, a product manager accepting the item
        becomes its owner."""
        self._intake(intake_id)
        self._check_user(user_id)
        if intake_id in self._deciding:
            raise Conflict("This intake item is already being processed.")
        self._deciding.add(intake_id)
        try:
            item = self._intake(intake_id)
            if item.get("status") != "new":
                raise Conflict(f"This item was already {item.get('status')}.")
            overrides = {k: v for k, v in (overrides or {}).items() if v not in (None, "", [], {})}
            suggestion = item.get("suggestion") or {}
            watcher = self.c.store.get("watchers", item.get("watcher_id") or "") or {}
            blueprint = self._pick_blueprint(overrides, suggestion, watcher)
            raw = item.get("raw") or {}
            notes: list[str] = []
            try:
                fields, notes = self._mapped(watcher, raw, item.get("external_id") or "")
            except FactoryError as exc:   # a broken mapping must not block a human decision
                fields, _ = self._mapped({}, raw, item.get("external_id") or "")
                notes.append(f"The watcher mapping failed ({exc.message}); defaults were used.")
            for ref in ("sponsor_id", "owner_id"):
                if overrides.get(ref) and self.c.get_user(overrides[ref]) is None:
                    raise NotFound(f"User {overrides[ref]} not found")
            if overrides.get("team_id") and self.c.get_team(overrides["team_id"]) is None:
                raise NotFound(f"Team {overrides['team_id']} not found")

            def pick(name: str) -> str:
                return _text(overrides.get(name)) or _text(suggestion.get(name)) or fields.get(name) or ""

            priority = normalize_priority(overrides.get("priority")) if overrides.get("priority") else (
                suggestion.get("priority") if suggestion.get("priority") in PRIORITIES else fields["priority"])
            owner_id = pick("owner_id")
            accepter = self.c.get_user(user_id) if user_id else None
            if not owner_id and accepter and "product_manager" in (accepter.get("roles") or []):
                owner_id = user_id   # the product manager who starts it owns it unless someone else was named
            inputs = {**fields["inputs"], **(overrides["inputs"] if isinstance(overrides.get("inputs"), dict) else {})}
            title = _text(overrides.get("title")) or (fields["title"] if watcher.get("mapping") else "") \
                or item.get("title") or fields["title"]
            project = await self.c.engine.create_project(
                blueprint["id"], title=truncate(title, 200),
                description=_text(overrides.get("description")) or fields["description"]
                or _text(suggestion.get("summary")),
                inputs=inputs, priority=priority, sponsor_id=pick("sponsor_id"), owner_id=owner_id,
                team_id=pick("team_id"), tags=_tags(overrides["tags"]) if "tags" in overrides else fields["tags"],
                due_date=_text(overrides.get("due_date")) or fields["due_date"],
                source={**_source(watcher, self._watcher_operation(watcher), item.get("external_id") or "", raw),
                        "intake_id": intake_id},
                created_by=user_id or "")
            self._save_intake(intake_id, status="accepted", project_id=project.get("id") or "",
                              decided_by=user_id or "", decided_at=now_iso())
            message = f"Intake item '{truncate(item.get('title') or '', 120)}' accepted as {project.get('key') or 'a project'}"
            self.c.record_event("intake.accepted", message, actor=user_id or "system",
                                project_id=project.get("id") or "",
                                data={"intake_id": intake_id, "blueprint_id": blueprint["id"],
                                      **({"notes": notes} if notes else {})})
            return project
        finally:
            self._deciding.discard(intake_id)

    async def dismiss_intake(self, intake_id: str, user_id: str, reason: str) -> dict:
        reason = (reason or "").strip()
        if not reason:
            raise FactoryError("Say why this item is dismissed — a reason is required.", 422)
        self._intake(intake_id)
        self._check_user(user_id)
        if intake_id in self._deciding:
            raise Conflict("This intake item is already being processed.")
        item = self._intake(intake_id)
        if item.get("status") != "new":
            raise Conflict(f"This item was already {item.get('status')}.")
        doc = self._save_intake(intake_id, status="dismissed", dismiss_reason=truncate(reason, 1000),
                                decided_by=user_id or "", decided_at=now_iso())
        self.c.record_event("intake.dismissed", f"Intake item '{truncate(item.get('title') or '', 120)}' dismissed: "
                                                f"{truncate(reason, 200)}", actor=user_id or "system",
                            data={"intake_id": intake_id, "reason": reason})
        return doc

    def reset_stale_busy(self) -> int:
        """Startup clean-up (called once by the scheduler): clear `ai_busy` left behind by a
        process that stopped mid-analysis (nothing in this process is analysing those items),
        and release the items that waited for an LLM if one is configured now (e.g. through
        the environment). Returns how many busy flags were cleared."""
        cleared = 0
        for item in self.c.store.list("intake"):
            if item.get("ai_busy") and item.get("id") not in self._analyzing:
                self._save_intake(item["id"], ai_busy=False)
                cleared += 1
        self.release_llm_waits()
        return cleared

    # ------------------------------------------------------------------ intake helpers
    def _intake(self, intake_id: str) -> dict:
        item = self.c.store.get("intake", intake_id)
        if item is None:
            raise NotFound(f"Intake item {intake_id} not found")
        return item

    def _save_intake(self, intake_id: str, **changes: Any) -> dict:
        """Apply `changes` to the latest copy, persist, push `intake.updated`."""
        latest = self.c.store.get("intake", intake_id)
        if latest is None:   # deleted meanwhile (backup import): nothing left to update
            return IntakeItem.model_validate({"id": intake_id, **changes}).model_dump()
        doc = IntakeItem.model_validate({**latest, **changes}).model_dump()
        self.c.store.put("intake", doc)
        self.c.bus.emit("intake.updated", item=doc)
        return doc

    def _check_user(self, user_id: str) -> None:
        if user_id and self.c.get_user(user_id) is None:
            raise NotFound(f"User {user_id} not found")

    def _pick_blueprint(self, overrides: dict, suggestion: dict, watcher: dict) -> dict:
        for origin, bp_id in (("override", overrides.get("blueprint_id")), ("suggestion", suggestion.get("blueprint_id")),
                              ("watcher", watcher.get("blueprint_id"))):
            if not bp_id:
                continue
            blueprint = self.c.get_blueprint(bp_id)
            if blueprint is not None:
                return blueprint
            if origin == "override":
                raise NotFound(f"Blueprint {bp_id} not found")
        raise EngineError("Pick a blueprint to start this use case: the AI suggested none and the watcher "
                          "has no default blueprint.")

    def _watcher_operation(self, watcher: dict) -> dict:
        return self.c.get_operation_by_key(watcher.get("operation_key") or "") or {}

    def _triage_prompt(self, item: dict) -> tuple[str, dict]:
        blueprints = [{"id": b.get("id"), "key": b.get("key"), "name": b.get("name"), "kind": b.get("kind"),
                       "description": truncate(b.get("description") or "", 300)}
                      for b in self.c.store.list("blueprints") if b.get("status", "active") == "active"]
        teams = [{"id": t.get("id"), "name": t.get("name"), "skills": t.get("skills") or [],
                  "description": truncate(t.get("description") or "", 200)} for t in self.c.teams()]
        people = [{"id": u.get("id"), "name": u.get("name"), "email": u.get("email"), "roles": u.get("roles") or []}
                  for u in self.c.users()
                  if u.get("active", True) and SUGGESTION_PEOPLE_ROLES & set(u.get("roles") or [])]
        record = truncate(json.dumps(item.get("raw") or {}, ensure_ascii=False, default=str), RAW_PROMPT_CHARS)
        prompt = (f"Use case record (detected by {item.get('watcher_name') or 'a watcher'}):\n{record}\n\n"
                  f"Blueprints:\n{json.dumps(blueprints, ensure_ascii=False)}\n\n"
                  f"Teams:\n{json.dumps(teams, ensure_ascii=False)}\n\n"
                  f"Users (possible sponsors and product managers):\n{json.dumps(people, ensure_ascii=False)}\n\n"
                  "Also set \"owner_id\" to the product manager best placed to own the delivery (an id from the user "
                  "list, or \"\") and \"confidence\" to \"low\", \"medium\" or \"high\".")
        return prompt, {"blueprints": blueprints, "teams": teams, "people": people,
                        "users": [{"id": u.get("id"), "name": u.get("name"), "email": u.get("email"),
                                   "roles": u.get("roles") or []} for u in self.c.users()]}


# ====================================================================== pure helpers

def in_window(schedule: dict, local: datetime) -> bool:
    """Whether `local` (already in the scheduler timezone) is inside the watcher's active
    days and hours. Hours are [start, end); start > end is an overnight window (22 → 6)."""
    days = [int(d) for d in schedule.get("days") or [] if str(d).strip().isdigit()]
    if days and local.isoweekday() not in days:
        return False
    start, end = schedule.get("active_hours_start"), schedule.get("active_hours_end")
    hour = local.hour
    if start is None and end is None:
        return True
    if start is None:
        return hour < int(end)
    if end is None:
        return hour >= int(start)
    start, end = int(start), int(end)
    if start == end:
        return True
    return start <= hour < end if start < end else (hour >= start or hour < end)


def normalize_priority(value: Any) -> str:
    """Any source wording ("Urgent", "P1", "normal") → low | medium | high | critical."""
    word = _text(value).lower()
    return _PRIORITY_WORDS.get(word, "medium")


def clean_suggestion(answer: Any, catalog: dict) -> dict:
    """Validate the analyst's JSON against the real catalog. Small models sometimes answer a
    key or a name where an id was asked; those are resolved, anything else unknown is dropped."""
    if not isinstance(answer, dict):
        raise LLMError("The intake analyst did not return a JSON object.")

    def resolve(value: Any, rows: list[dict], *fields: str) -> str:
        text = _text(value)
        if not text:
            return ""
        for row in rows:
            if row.get("id") == text:
                return text
        lowered = text.lower()
        for row in rows:
            if any(_text(row.get(f)).lower() == lowered for f in fields):
                return row.get("id") or ""
        return ""

    caps: list[str] = []
    for cap in answer.get("required_capabilities") or []:
        text = truncate(_text(cap), 80)
        if text and text.lower() not in {c.lower() for c in caps}:
            caps.append(text)
    priority = _text(answer.get("priority")).lower()
    confidence = _text(answer.get("confidence")).lower()
    return IntakeSuggestion(
        blueprint_id=resolve(answer.get("blueprint_id"), catalog["blueprints"], "key", "name"),
        priority=priority if priority in PRIORITIES else "",
        team_id=resolve(answer.get("team_id"), catalog["teams"], "name"),
        sponsor_id=resolve(answer.get("sponsor_id"), catalog["users"], "email", "name"),
        owner_id=resolve(answer.get("owner_id"), catalog["users"], "email", "name"),
        rationale=truncate(_text(answer.get("rationale")), 1500),
        summary=truncate(_text(answer.get("summary")), 1200),
        required_capabilities=caps[:12],
        confidence=confidence if confidence in ("low", "medium", "high") else "",
    ).model_dump()


def _source(watcher: dict, operation: dict, key: str, raw: dict) -> dict:
    return {"type": "watcher", "watcher_id": watcher.get("id") or "", "connector_id": operation.get("connector_id") or "",
            "external_id": key, "raw": _jsonable(raw)}


def _interval(watcher: dict) -> timedelta:
    minutes = ((watcher.get("schedule") or {}).get("every_minutes")) or 15
    return timedelta(minutes=max(1, int(minutes)))


def _bare(expr: str) -> str:
    """SPEC §14: an expression may be written bare or as one `{{ … }}`."""
    text = (expr or "").strip()
    if text.startswith("{{") and text.endswith("}}") and text.count("{{") == 1:
        return text[2:-2].strip()
    return text


def _path(raw: dict, path: str) -> Any:
    value: Any = raw
    for part in path.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def _key(raw: dict, key_field: str) -> str:
    value = raw.get(key_field) if key_field in raw else _path(raw, key_field)
    if value is None or (isinstance(value, str) and not value.strip()):
        raise FactoryError(f"item has no '{key_field}' value (key field) — fix the key field in Settings › Watchers",
                           422)
    return str(value).strip()


def _title(raw: dict, title_field: str, key: str) -> str:
    value = raw.get(title_field) if title_field in raw else _path(raw, title_field)
    return truncate(_text(value), 200) or key


def _text(value: Any) -> str:
    if value is None or isinstance(value, Undefined):
        return ""
    return value.strip() if isinstance(value, str) else str(value).strip()


def _tags(value: Any) -> list[str]:
    value = _clean(value)
    if isinstance(value, str):
        value = value.split(",")
    if not isinstance(value, (list, tuple)):
        return []
    out: list[str] = []
    for tag in value:
        text = truncate(_text(tag), 60)
        if text and text not in out:
            out.append(text)
    return out


def _clean(value: Any) -> Any:
    """Jinja's undefined values → None, recursively (a mapping referencing a field the item
    does not have must yield an empty value, not an Undefined object stored in a project)."""
    if isinstance(value, Undefined):
        return None
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_clean(v) for v in value]
    return value


def _jsonable(raw: Any) -> Any:
    return json.loads(json.dumps(_clean(raw), ensure_ascii=False, default=str))


def _preview(raw: dict) -> dict:
    """A short copy of an item for the "Run now" panel: long values cut, at most 20 fields."""
    out: dict[str, Any] = {}
    for name, value in list(raw.items())[:20]:
        if isinstance(value, (dict, list)):
            out[name] = truncate(json.dumps(value, ensure_ascii=False, default=str), 160)
        elif isinstance(value, str):
            out[name] = truncate(value, 160)
        else:
            out[name] = value if isinstance(value, (int, float, bool)) or value is None else str(value)
    return out


def _describe(value: Any) -> str:
    kind = {dict: "an object", list: "a list", str: "a string", bool: "a boolean", int: "a number",
            float: "a number", type(None): "null"}.get(type(value), type(value).__name__)
    if value is None:
        return kind
    sample = json.dumps(_clean(value), ensure_ascii=False, default=str)
    return f"{kind}: {truncate(sample, 120)}"


def _as_dict(result: Any) -> dict:
    if hasattr(result, "model_dump"):
        return result.model_dump()
    return dict(result or {})


def _message(exc: BaseException) -> str:
    return exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"


def _aware(now: datetime) -> datetime:
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)
