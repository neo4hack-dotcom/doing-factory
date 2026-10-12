"""Project dossier: the audit / compliance pack of one project, as a Markdown document.

`build_dossier(container, project_id)` assembles it from stored data only — no LLM, nothing
inferred: the header (people, dates, risk), the description and inputs, the stage-by-stage
step log, every artifact (latest version), the approvals trail, the quality-gate checks, the
links, the child projects and the project's audit events with the result of the hash-chain
verification (store.verify_events). Given the same data and `generated_at`, the output is
byte-for-byte the same. Sections without data say so instead of being left out, so a reader
can tell "none" from "not exported".
"""
from __future__ import annotations

import json
import re
from typing import TYPE_CHECKING, Any

from app.util import now_iso

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

ACTORS = {"ai": "AI", "system": "System", "scheduler": "Scheduler", "": "—"}
VALUE_MAX = 600
CELL_MAX = 300
_HEADING = re.compile(r"^(#{1,6})(\s)")


class _People:
    """User / team names, read once each."""

    def __init__(self, container: "Container") -> None:
        self.c = container
        self._users: dict[str, str] = {}

    def user(self, uid: str | None) -> str:
        uid = uid or ""
        if uid in ACTORS:
            return ACTORS[uid]
        if uid not in self._users:
            user = self.c.get_user(uid)
            self._users[uid] = f"{user.get('name') or uid}" if user else f"{uid} (unknown user)"
        return self._users[uid]

    def users(self, uids: list[str] | None) -> str:
        return ", ".join(self.user(u) for u in uids or []) or "—"

    def team(self, tid: str | None) -> str:
        if not tid:
            return "—"
        team = self.c.get_team(tid)
        return (team.get("name") or tid) if team else f"{tid} (unknown team)"


# ---------------------------------------------------------------------------------- formatting

def _cell(value: Any, limit: int = CELL_MAX) -> str:
    """One Markdown table cell: single line, pipes escaped, bounded."""
    text = _plain(value)
    text = " ".join(text.split())
    if len(text) > limit:
        text = text[: limit - 1].rstrip() + "…"
    return text.replace("|", "\\|") or "—"


def _plain(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return str(value)
    return json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)


def _value(value: Any) -> str:
    text = " ".join(_plain(value).split())
    return (text[: VALUE_MAX - 1].rstrip() + "…") if len(text) > VALUE_MAX else (text or "—")


def _table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(_cell(v) for v in row) + " |" for row in rows]
    return out


def _fence(content: str, info: str = "") -> list[str]:
    longest = max((len(m) for m in re.findall(r"`+", content)), default=0)
    fence = "`" * max(3, longest + 1)
    return [fence + info, content.rstrip("\n"), fence]


def _demote(markdown: str, top: int = 4) -> str:
    """Shifts the headings of embedded Markdown so its highest one becomes level `top` (below
    the dossier's own ## / ### headings), leaving fenced code untouched."""
    lines, fenced, fence = markdown.splitlines(), [], ""
    for line in lines:
        stripped = line.lstrip()
        marker = re.match(r"(`{3,}|~{3,})", stripped)
        if marker:
            if not fence:
                fence = marker.group(1)
            elif stripped.startswith(fence):
                fence = ""
            fenced.append(True)
        else:
            fenced.append(bool(fence))
    levels = [len(m.group(1)) for line, f in zip(lines, fenced) if not f and (m := _HEADING.match(line))]
    shift = max(0, top - min(levels)) if levels else 0
    out = []
    for line, f in zip(lines, fenced):
        m = None if f or not shift else _HEADING.match(line)
        out.append("#" * min(6, len(m.group(1)) + shift) + line[len(m.group(1)):] if m else line)
    return "\n".join(out)


def _when(value: Any) -> str:
    return str(value) if value else "—"


# ---------------------------------------------------------------------------------- builder

def dossier_filename(project: dict) -> str:
    key = re.sub(r"[^A-Za-z0-9._-]+", "-", str(project.get("key") or project.get("id") or "project")).strip("-")
    return f"{key or 'project'}-dossier.md"


def build_dossier(container: "Container", project: dict, *, generated_at: str | None = None) -> str:
    people = _People(container)
    p = project
    stages = p.get("stages") or []
    steps = [(stage, step) for stage in stages for step in stage.get("steps") or []]
    title = " · ".join(x for x in (p.get("key"), p.get("title")) if x) or p.get("id") or "Project"
    risk = p.get("risk") or {}
    source = p.get("source") or {}

    lines: list[str] = [f"# Project dossier — {title}", ""]
    lines += [f"Generated {generated_at or now_iso()} by DOINg.AI Factory from the stored project record "
              f"and its audit trail. Step outputs and artifacts are reproduced as stored; nothing was "
              f"written for this document.", ""]

    # ---- header
    lines += ["## Summary", ""]
    lines += _table(["Field", "Value"], [
        ["Key", p.get("key") or "—"],
        ["Title", p.get("title") or "—"],
        ["Blueprint", f"{p.get('blueprint_name') or p.get('blueprint_id') or '—'} (v{p.get('blueprint_version') or 1})"],
        ["Status", p.get("status") or "—"],
        ["Priority", p.get("priority") or "—"],
        ["Sponsor", people.user(p.get("sponsor_id")) if p.get("sponsor_id") else "—"],
        ["Owner", people.user(p.get("owner_id")) if p.get("owner_id") else "—"],
        ["Team", people.team(p.get("team_id"))],
        ["Stakeholders", people.users(p.get("stakeholder_ids"))],
        ["Created by", people.user(p.get("created_by")) if p.get("created_by") else "—"],
        ["Created", _when(p.get("created_at"))],
        ["Started", _when(p.get("started_at"))],
        ["Completed", _when(p.get("completed_at"))],
        ["Due date", _when(p.get("due_date"))],
        ["Risk", f"{risk.get('level') or 'low'} (score {risk.get('score') or 0})"
                 + (f", computed {risk['computed_at']}" if risk.get("computed_at") else "")],
        ["Risk reasons", "; ".join(str(r) for r in risk.get("reasons") or []) or "—"],
        ["Source", " · ".join(str(x) for x in (source.get("type"), source.get("external_id"), source.get("url")) if x)
                   or "—"],
        ["Tags", ", ".join(p.get("tags") or []) or "—"],
        ["Parent project", p.get("parent_id") or "—"],
    ])
    lines.append("")

    # ---- description & inputs
    lines += ["## Description and inputs", ""]
    lines += [_demote(p["description"], 3) if (p.get("description") or "").strip() else "_No description._", ""]
    inputs = p.get("inputs") or {}
    if inputs:
        lines += _table(["Input", "Value"], [[k, _value(v)] for k, v in inputs.items()])
    else:
        lines.append("_No inputs._")
    lines.append("")

    # ---- step log
    lines += ["## Step log", ""]
    if not stages:
        lines += ["_The project has no stages._", ""]
    for n, stage in enumerate(stages, start=1):
        span = " → ".join(_when(x) for x in (stage.get("started_at"), stage.get("completed_at")))
        lines += [f"### Stage {n} — {stage.get('name') or stage.get('id')} ({stage.get('status') or 'pending'})", "",
                  f"Started → completed: {span}", ""]
        for step in stage.get("steps") or []:
            lines += _step_lines(step, people)
        if not stage.get("steps"):
            lines.append("_No steps._")
        lines.append("")

    # ---- artifacts
    artifacts = p.get("artifacts") or []
    lines += ["## Artifacts", ""]
    if not artifacts:
        lines += ["_No artifacts._", ""]
    step_names = {s.get("id"): s.get("name") or s.get("id") for _, s in steps}
    for art in artifacts:
        version = int(art.get("version") or 1)
        lines += [f"### {art.get('title') or art.get('id') or 'Artifact'}", ""]
        lines += [f"Version {version} ({version} version{'s' if version != 1 else ''} in total"
                  + (f", {len(art.get('history') or [])} earlier kept" if art.get("history") else "") + ")"
                  + f" · {art.get('kind') or 'markdown'}"
                  + (f" · step {step_names.get(art.get('step_id'), art.get('step_id'))}" if art.get("step_id") else "")
                  + f" · last updated {_when(art.get('updated_at') or art.get('created_at'))}"
                  + (f" by {people.user(art.get('updated_by'))}" if art.get("updated_by") else ""), ""]
        content = art.get("content") or ""
        if not content.strip() and (art.get("kind") != "json" or art.get("data") is None):
            lines.append("_Empty._")
        elif art.get("kind") == "json":
            data = art.get("data")
            lines += _fence(json.dumps(data, ensure_ascii=False, indent=2, default=str) if data is not None else content,
                            "json")
        else:
            lines.append(_demote(content))
        lines.append("")

    # ---- approvals
    lines += ["## Approvals trail", ""]
    approvals = [(stage, step, a) for stage, step in steps for a in step.get("approvals") or []]
    if approvals:
        lines += _table(["Stage", "Step", "Role", "User", "Decision", "Comment", "At"], [
            [stage.get("name") or stage.get("id"), step.get("name") or step.get("id"), a.get("role") or "—",
             people.user(a.get("user_id")), a.get("decision") or "—", a.get("comment") or "—", _when(a.get("at"))]
            for stage, step, a in approvals])
    else:
        lines.append("_No approval decisions recorded._")
    lines.append("")

    # ---- quality gates
    lines += ["## Quality-gate checks", ""]
    gates = [(stage, step) for stage, step in steps if step.get("checks")]
    if not gates:
        lines += ["_No quality-gate checks recorded._", ""]
    for stage, step in gates:
        lines += [f"### {step.get('name') or step.get('id')} ({step.get('status')}) — stage {stage.get('name') or stage.get('id')}", ""]
        lines += _table(["Rule", "Title", "Severity", "Status", "Evidence", "Recommendation", "Override"], [
            [c.get("code") or c.get("rule_id"), c.get("title"), c.get("severity"), c.get("status"), c.get("evidence"),
             c.get("recommendation"),
             (f"{people.user(c['overridden_by'])}: {c.get('override_comment') or 'no comment'}"
              if c.get("overridden_by") else "—")]
            for c in step.get("checks") or []])
        lines.append("")

    # ---- links
    lines += ["## Links", ""]
    links = p.get("links") or []
    if links:
        lines += _table(["Kind", "Label", "External id", "Status", "URL", "Step", "Added"], [
            [l.get("kind"), l.get("label"), l.get("external_id"), l.get("status"), l.get("url"),
             step_names.get(l.get("step_id"), l.get("step_id")) if l.get("step_id") else "—", _when(l.get("created_at"))]
            for l in links])
    else:
        lines.append("_No links._")
    lines.append("")

    # ---- children
    lines += ["## Child projects", ""]
    child_ids = p.get("child_ids") or []
    if child_ids:
        rows = []
        for cid in child_ids:
            child = container.store.get("projects", cid)
            if child is None:
                rows.append([cid, "(deleted)", "—", "—", "—"])
            else:
                rows.append([child.get("key") or cid, child.get("title"), child.get("status"),
                             people.user(child.get("owner_id")) if child.get("owner_id") else "—",
                             _when(child.get("completed_at"))])
        lines += _table(["Key", "Title", "Status", "Owner", "Completed"], rows)
    else:
        lines.append("_No child projects._")
    lines.append("")

    # ---- audit events
    events = list(reversed(container.store.list_events(project_id=p.get("id") or "", limit=None)))
    chain = container.store.verify_events()
    lines += ["## Audit trail", ""]
    if chain.get("ok"):
        lines.append(f"Hash-chain verification: **intact** — all {chain.get('count', 0)} events of the Factory's "
                     f"audit log verify against their predecessors.")
    else:
        broken = chain.get("broken_at") or ""
        mine = any(e.get("id") == broken for e in events)
        lines.append(f"Hash-chain verification: **BROKEN** at event `{broken}` after {chain.get('count', 0)} verified "
                     f"events — the audit log was altered"
                     + (" (the broken event belongs to this project)." if mine else "."))
    lines += ["", f"{len(events)} event{'s' if len(events) != 1 else ''} for this project, oldest first.", ""]
    if events:
        lines += _table(["Time", "Event", "Actor", "Step", "Message", "Hash"], [
            [e.get("ts"), e.get("kind"), people.user(e.get("actor")), e.get("step_id") or "—", e.get("message"),
             (e.get("hash") or "")[:16]]
            for e in events])
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


def _step_lines(step: dict, people: _People) -> list[str]:
    name = step.get("name") or step.get("id")
    status = step.get("status") or "pending"
    head = f"- **{name}** (`{step.get('type')}`) — {status}"
    if step.get("completed_at") or step.get("completed_by"):
        head += f" · completed by {people.user(step.get('completed_by'))} at {_when(step.get('completed_at'))}"
    elif step.get("started_at"):
        head += f" · started {step['started_at']}"
    if int(step.get("attempts") or 0) > 1:
        head += f" · {step['attempts']} attempts"
    if step.get("sla_breached"):
        head += " · SLA breached"
    out = [head]
    if step.get("assignee_user_ids"):
        out.append(f"  - Assignees: {people.users(step['assignee_user_ids'])}")
    if (step.get("output_summary") or "").strip():
        out.append(f"  - Output: {_value(step['output_summary'])}")
    if step.get("error"):
        out.append(f"  - Error: {_value(step['error'])}")
    for key, value in (step.get("form") or {}).items():
        out.append(f"  - Form · {key}: {_value(value)}")
    estimate = step.get("estimate") or {}
    if estimate.get("value") is not None:
        out.append(f"  - Estimate: {estimate['value']} {estimate.get('unit') or 'days'} "
                   f"({estimate.get('confidence') or 'medium'} confidence)"
                   + (f" by {people.user(estimate['submitted_by'])}" if estimate.get("submitted_by") else ""))
    if step.get("child_ids"):
        out.append(f"  - Child projects: {', '.join(step['child_ids'])}")
    return out
