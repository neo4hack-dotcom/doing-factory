"""Notifier: in-app notifications, plus an optional external channel (SPEC §3.1, §3.6, §12).

In-app: one Notification document per recipient, pushed live on the bus (`notification`)
and audited once per call (`notification.sent`). The same unread notification (same user,
kind, title, project and step) is not repeated within DEDUPE_WINDOW: a scheduler tick or a
step retry must not stack identical bells.

External: when the caller asks for it and Settings › Notifications names an Operation
(e.g. an email or Teams MCP tool), that Operation receives `{to: [emails], subject, body}`.
Delivery problems are recorded in the audit event and logged — never raised: a mail server
being down must not fail the workflow step that wanted to tell someone.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, get_args

from app.errors import FactoryError
from app.models import Notification, NotificationKind
from app.util import new_id, now_iso, parse_iso, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.notify")

KINDS = frozenset(get_args(NotificationKind))
DEDUPE_WINDOW = timedelta(minutes=10)
PER_USER_CAP = 500        # oldest (read first) notifications beyond this are pruned
TITLE_MAX = 200
BODY_MAX = 4000


class Notifier:
    def __init__(self, container: "Container") -> None:
        self.c = container

    async def notify(self, user_ids: list[str], kind: str, title: str, body: str = "", *, project_id: str = "",
                     step_id: str = "", external: bool = False) -> list[dict]:
        """Notify `user_ids` (unknown or inactive users are skipped). Returns the in-app
        notifications actually created — deduplicated ones are not repeated."""
        title = truncate((title or "").strip(), TITLE_MAX)
        if not title:
            raise FactoryError("A notification needs a title.", 422)
        body = truncate(body or "", BODY_MAX)
        if kind not in KINDS:
            log.warning("Unknown notification kind %r — sent as 'info'", kind)
            kind = "info"
        recipients = self._recipients(user_ids)
        settings = self.c.app_settings().notifications

        created: list[dict] = []
        deduped: list[str] = []
        if settings.in_app and recipients:
            existing = self.c.store.list("notifications")
            for user in recipients:
                if _is_duplicate(existing, user["id"], kind, title, project_id, step_id):
                    deduped.append(user["id"])
                    continue
                doc = Notification(id=new_id("ntf"), user_id=user["id"], kind=kind, title=title, body=body,
                                   project_id=project_id, step_id=step_id, read=False,
                                   created_at=now_iso()).model_dump()
                self.c.store.put("notifications", doc)
                self.c.bus.emit("notification", notification=doc)
                created.append(doc)
            if created:
                self._prune({d["user_id"] for d in created}, existing)

        delivery = await self._external(recipients, title, body, project_id, step_id) if external else None
        if created or delivery is not None:
            self._audit(created, deduped, delivery, kind, title, project_id, step_id)
        return created

    def list(self, user_id: str, unread_only: bool = False, limit: int = 100) -> list[dict]:
        """The user's notifications, newest first."""
        docs = [d for d in self.c.store.list("notifications") if d.get("user_id") == user_id
                and not (unread_only and d.get("read"))]
        docs.reverse()   # store order is creation order; newest first, stable for equal timestamps
        docs.sort(key=lambda d: d.get("created_at") or "", reverse=True)
        limit = max(1, min(int(limit or 100), PER_USER_CAP))
        return [Notification.model_validate(d).model_dump() for d in docs[:limit]]

    def mark_read(self, user_id: str, ids: list[str] | None = None, all: bool = False) -> int:
        """Mark the given notifications (or all of them) read; returns how many changed.
        Ids that belong to another user are ignored, never an error."""
        wanted = set(ids or [])
        if not all and not wanted:
            return 0
        changed = 0
        for doc in self.c.store.list("notifications"):
            if doc.get("user_id") != user_id or doc.get("read"):
                continue
            if all or doc.get("id") in wanted:
                self.c.store.put("notifications", {**doc, "read": True})
                changed += 1
        return changed

    # ------------------------------------------------------------------ internals
    def _recipients(self, user_ids: list[str]) -> list[dict]:
        out: list[dict] = []
        seen: set[str] = set()
        for uid in user_ids or []:
            if not uid or uid in seen:
                continue
            seen.add(uid)
            user = self.c.get_user(uid)
            if user is None:
                log.info("Notification for unknown user %s skipped", uid)
            elif user.get("active", True):
                out.append(user)
        return out

    async def _external(self, recipients: list[dict], subject: str, body: str, project_id: str,
                        step_id: str) -> dict[str, Any]:
        key = self.c.app_settings().notifications.channel_operation_key.strip()
        if not key:
            return {"ok": False, "skipped": True,
                    "error": "No external channel configured — set one in Settings › Notifications."}
        emails = [u["email"].strip() for u in recipients if (u.get("email") or "").strip()]
        if not emails:
            return {"ok": False, "skipped": True, "operation_key": key,
                    "error": "None of the recipients has an email address."}
        try:
            result = await self.c.ops.run(key, {"to": emails, "subject": subject, "body": body},
                                          project_id=project_id, step_id=step_id)
            result = result.model_dump() if hasattr(result, "model_dump") else dict(result or {})
        except Exception as exc:  # noqa: BLE001 — delivery problems are reported, never raised
            message = exc.message if isinstance(exc, FactoryError) else f"{type(exc).__name__}: {exc}"
            log.warning("External notification via %s failed: %s", key, message)
            return {"ok": False, "operation_key": key, "to": emails, "error": message}
        ok = bool(result.get("ok"))
        error = "" if ok else (result.get("error") or "The channel operation reported a failure.")
        if not ok:
            log.warning("External notification via %s failed: %s", key, error)
        return {"ok": ok, "operation_key": key, "to": emails, "error": error}

    def _audit(self, created: list[dict], deduped: list[str], delivery: dict | None, kind: str, title: str,
               project_id: str, step_id: str) -> None:
        parts = [f"Notified {len(created)} user{'s' if len(created) != 1 else ''}: {title}"] if created \
            else [f"External notification: {title}"]
        if delivery is not None:
            if delivery.get("ok"):
                parts.append(f"sent to {len(delivery.get('to') or [])} address(es) via {delivery['operation_key']}")
            elif delivery.get("skipped"):
                parts.append(f"external channel skipped ({delivery['error']})")
            else:
                parts.append(f"external channel failed ({truncate(delivery['error'], 200)})")
        data: dict[str, Any] = {"kind": kind, "user_ids": [d["user_id"] for d in created]}
        if deduped:
            data["deduplicated"] = deduped
        if delivery is not None:
            data["external"] = delivery
        try:
            self.c.record_event("notification.sent", " — ".join(parts), project_id=project_id, step_id=step_id,
                                data=data)
        except Exception:  # noqa: BLE001 — the notification itself was delivered
            log.exception("Could not audit a notification")

    def _prune(self, user_ids: set[str], existing: list[dict]) -> None:
        """Keep at most PER_USER_CAP notifications per user, dropping the oldest read ones
        first. `existing` is the collection before this call, which added one per user —
        so the collection is read again only when a user actually went over the cap."""
        for uid in user_ids:
            if sum(1 for d in existing if d.get("user_id") == uid) + 1 <= PER_USER_CAP:
                continue
            docs = [d for d in self.c.store.list("notifications") if d.get("user_id") == uid]
            excess = len(docs) - PER_USER_CAP
            if excess <= 0:
                continue
            docs.sort(key=lambda d: (bool(not d.get("read")), d.get("created_at") or ""))
            for doc in docs[:excess]:
                self.c.store.delete("notifications", doc["id"])


def _is_duplicate(existing: list[dict], user_id: str, kind: str, title: str, project_id: str, step_id: str) -> bool:
    cutoff = datetime.now(timezone.utc) - DEDUPE_WINDOW
    for doc in existing:
        if (doc.get("user_id") == user_id and not doc.get("read") and doc.get("kind") == kind
                and doc.get("title") == title and (doc.get("step_id") or "") == step_id
                and (doc.get("project_id") or "") == project_id):
            created = parse_iso(doc.get("created_at"))
            if created is not None and created >= cutoff:
                return True
    return False
