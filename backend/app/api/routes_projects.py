"""Projects and step actions (SPEC §9): /projects (list, create, get, patch, cancel, delete,
events, comments, artifacts, links, dossier, report, explain-risk, summarize) and
/projects/{id}/steps/{step_id}/<action>.

Thin by design: the engine is the only writer of projects (it serialises work per project and
records every transition), so these routes check the request's shape, call the engine and
shape its answer. Permission checks (can_act) live in the engine and surface as a 403 with a
readable message. A project's LLM metrics are filled here from the LLM call log
(store.llm_stats) rather than written into the document, which would race the engine.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app import ai_utils, dossier
from app.api import shape, shape_all
from app.deps import container as c
from app.errors import Conflict, FactoryError, Forbidden, NotFound
from app.models import Artifact, Event, Priority, Project, ProjectSummary

router = APIRouter(prefix="/api")

PRIORITIES: tuple[str, ...] = Priority.__args__   # type: ignore[attr-defined]
PATCHABLE = ("title", "description", "priority", "sponsor_id", "owner_id", "team_id", "tags", "due_date",
             "stakeholder_ids")
GATE_ACTIONS = ("override", "rerun", "send_back")
DECISIONS = ("approved", "rejected")


def project_out(project: dict[str, Any]) -> dict[str, Any]:
    """A Project as the API returns it, with live LLM metrics from the call log."""
    out = shape(Project, project)
    stats = c.store.llm_stats(out.get("id") or "")
    out["metrics"] = {**(out.get("metrics") or {}), "llm_calls": int(stats.get("calls") or 0),
                      "tokens_in": int(stats.get("tokens_in") or 0), "tokens_out": int(stats.get("tokens_out") or 0)}
    return out


def _acting(body: dict[str, Any] | None, user_id: str = "") -> str:
    """The persona of a mutation: required, because the engine checks who may act."""
    uid = str((body or {}).get("user_id") or user_id or "").strip()
    if not uid:
        raise FactoryError("Choose who you are acting as — this action needs a user_id.", 422)
    return uid


def _priority(value: Any) -> str:
    if value not in PRIORITIES:
        raise FactoryError(f"Unknown priority '{value}'. Use one of: {', '.join(PRIORITIES)}.", 422)
    return value


def _str_list(value: Any, what: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        raise FactoryError(f"{what} must be a list of strings.", 422)
    return value


def _dict(value: Any, what: str) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise FactoryError(f"{what} must be a JSON object.", 422)
    return value


# ---------------------------------------------------------------------------------- projects

@router.get("/projects")
async def list_projects(status: str = "", blueprint_id: str = "", q: str = "", parent_id: str = "",
                        user_id: str = "") -> list[dict[str, Any]]:
    summaries = c.engine.list_summaries(status=status or None, blueprint_id=blueprint_id or None, q=q or None,
                                        parent_id=parent_id or None, user_id=user_id or None)
    return shape_all(ProjectSummary, summaries)


@router.post("/projects")
async def create_project(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    blueprint_id = str(body.get("blueprint_id") or "")
    blueprint = c.get_blueprint(blueprint_id)
    if blueprint is None:
        raise NotFound(f"Blueprint {blueprint_id or '(none)'} not found — pick a blueprint to start from.")
    if blueprint.get("status") == "archived":
        raise Conflict(f"The blueprint '{blueprint.get('name')}' is archived — reactivate it or pick another one.")
    title = str(body.get("title") or "").strip()
    if not title:
        raise FactoryError("A project needs a title.", 422)
    project = await c.engine.create_project(
        blueprint_id, title=title, description=str(body.get("description") or ""),
        inputs=_dict(body.get("inputs"), "inputs"), priority=_priority(body.get("priority") or "medium"),
        sponsor_id=str(body.get("sponsor_id") or ""), owner_id=str(body.get("owner_id") or ""),
        team_id=str(body.get("team_id") or ""),
        tags=_str_list(body.get("tags") or [], "tags"), due_date=body.get("due_date") or None,
        source={"type": "manual"}, created_by=str(body.get("created_by") or body.get("user_id") or user_id or ""))
    return project_out(project)


@router.get("/projects/{id}")
async def get_project(id: str) -> dict[str, Any]:
    return project_out(c.engine.get(id))


@router.patch("/projects/{id}")
async def patch_project(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    acting = _acting(body, user_id)
    patch = {k: body[k] for k in PATCHABLE if k in body}
    unknown = sorted(set(body) - set(PATCHABLE) - {"user_id"})
    if unknown:
        raise FactoryError(f"These fields cannot be changed here: {', '.join(unknown)}.", 422)
    if not patch:
        raise FactoryError("Nothing to update.", 422)
    if "priority" in patch:
        _priority(patch["priority"])
    if "title" in patch and not str(patch["title"] or "").strip():
        raise FactoryError("A project needs a title.", 422)
    for key in ("tags", "stakeholder_ids"):
        if key in patch:
            _str_list(patch[key], key)
    return project_out(await c.engine.update_project(id, acting, patch))


@router.post("/projects/{id}/cancel")
async def cancel_project(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    return project_out(await c.engine.cancel_project(id, _acting(body, user_id), str(body.get("reason") or "")))


@router.delete("/projects/{id}")
async def delete_project(id: str, user_id: str = "") -> dict[str, Any]:
    """When a persona is named, only an admin or the project's owner, sponsor or creator may
    delete it (cancelling keeps the history; deleting removes it)."""
    project = c.engine.get(id)
    if user_id:
        user = c.get_user(user_id)
        allowed = user is not None and ("admin" in (user.get("roles") or []) or user_id in (
            project.get("owner_id"), project.get("sponsor_id"), project.get("created_by")))
        if not allowed:
            raise Forbidden("Only an admin or the project's owner, sponsor or creator can delete it — cancel it instead.")
    await c.engine.delete_project(id)
    return {"ok": True, "id": id}


@router.get("/projects/{id}/events")
async def project_events(id: str, limit: int = 500) -> list[dict[str, Any]]:
    c.engine.get(id)   # 404 for an unknown project
    return shape_all(Event, c.store.list_events(project_id=id, limit=max(1, min(limit, 2000))))


@router.post("/projects/{id}/comments")
async def add_comment(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    text = str(body.get("text") or "").strip()
    if not text:
        raise FactoryError("A comment cannot be empty.", 422)
    return shape(Event, await c.engine.add_comment(id, _acting(body, user_id), text))


@router.put("/projects/{id}/artifacts/{artifact_id}")
async def update_artifact(id: str, artifact_id: str, body: dict[str, Any] = Body(...),
                          user_id: str = "") -> dict[str, Any]:
    content = body.get("content")
    if not isinstance(content, str):
        raise FactoryError("The artifact content must be text.", 422)
    result = await c.engine.update_artifact(id, artifact_id, _acting(body, user_id), content)
    if "stages" in result or "artifacts" in result:   # the engine answered with the whole project
        artifact = next((a for a in result.get("artifacts") or [] if a.get("id") == artifact_id), None)
        if artifact is None:
            raise NotFound(f"Artifact {artifact_id} not found")
        return shape(Artifact, artifact)
    return shape(Artifact, result)


@router.post("/projects/{id}/links")
async def add_link(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    kind = body.get("kind") or "url"
    if kind not in ("jira", "mcp", "url", "doc"):
        raise FactoryError(f"Unknown link kind '{kind}'.", 422)
    label, url = str(body.get("label") or "").strip(), str(body.get("url") or "").strip()
    if not label and not url:
        raise FactoryError("A link needs a label or a URL.", 422)
    if url and not url.startswith(("http://", "https://")):
        raise FactoryError("A link URL must start with http:// or https://.", 422)
    link = {"kind": kind, "label": label or url, "url": url, "external_id": str(body.get("external_id") or "")}
    return project_out(await c.engine.add_link(id, _acting(body, user_id), link))


@router.get("/projects/{id}/dossier")
async def project_dossier(id: str) -> dict[str, Any]:
    """The audit / compliance pack of a project as Markdown (deterministic, no LLM)."""
    project = project_out(c.engine.get(id))
    return {"filename": dossier.dossier_filename(project), "markdown": dossier.build_dossier(c, project)}


@router.post("/projects/{id}/report")
async def project_report(id: str, body: dict[str, Any] | None = Body(default=None)) -> dict[str, Any]:
    c.engine.get(id)
    return {"markdown": await ai_utils.project_report(c, id, str((body or {}).get("audience") or "sponsor"))}


@router.post("/projects/{id}/explain-risk")
async def explain_risk(id: str) -> dict[str, Any]:
    c.engine.get(id)
    return {"markdown": await ai_utils.explain_risk(c, id)}


@router.post("/projects/{id}/summarize")
async def summarize(id: str) -> dict[str, Any]:
    c.engine.get(id)
    return {"summary": await ai_utils.summarize_project(c, id)}


# ---------------------------------------------------------------------------------- steps

@router.post("/projects/{id}/steps/{step_id}/start")
async def step_start(id: str, step_id: str, body: dict[str, Any] | None = Body(default=None),
                     user_id: str = "") -> dict[str, Any]:
    return project_out(await c.engine.start_step(id, step_id, _acting(body, user_id)))


@router.post("/projects/{id}/steps/{step_id}/save")
async def step_save(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    form = _dict(body.get("form"), "form")
    return project_out(await c.engine.save_form(id, step_id, _acting(body, user_id), form))


@router.post("/projects/{id}/steps/{step_id}/complete")
async def step_complete(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    form = _dict(body.get("form"), "form") if body.get("form") is not None else None
    return project_out(await c.engine.complete_step(id, step_id, _acting(body, user_id), form=form,
                                                    output=body.get("output")))


@router.post("/projects/{id}/steps/{step_id}/ai-draft")
async def step_ai_draft(id: str, step_id: str, body: dict[str, Any] | None = Body(default=None),
                        user_id: str = "") -> dict[str, Any]:
    """Starts the draft in the background; the result arrives as `project.updated`."""
    acting = _acting(body, user_id)
    await c.engine.request_ai_draft(id, step_id, acting, str((body or {}).get("instructions") or ""))
    return {"accepted": True}


@router.post("/projects/{id}/steps/{step_id}/decide")
async def step_decide(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    decision = body.get("decision")
    if decision not in DECISIONS:
        raise FactoryError("decision must be 'approved' or 'rejected'.", 422)
    comment = str(body.get("comment") or "")
    if decision == "rejected" and not comment.strip():
        raise FactoryError("Say why you reject — the comment goes back to the people who must rework it.", 422)
    return project_out(await c.engine.decide(id, step_id, _acting(body, user_id), decision, comment))


@router.post("/projects/{id}/steps/{step_id}/estimate")
async def step_estimate(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    estimate = _dict(body.get("estimate"), "estimate")
    if not estimate:
        raise FactoryError("Give an estimate.", 422)
    return project_out(await c.engine.submit_estimate(id, step_id, _acting(body, user_id), estimate))


@router.post("/projects/{id}/steps/{step_id}/confirm")
async def step_confirm(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    if not isinstance(body.get("approve"), bool):
        raise FactoryError("approve must be true or false.", 422)
    payload = _dict(body.get("payload"), "payload") if body.get("payload") is not None else None
    return project_out(await c.engine.confirm(id, step_id, _acting(body, user_id), body["approve"], payload))


@router.post("/projects/{id}/steps/{step_id}/gate")
async def step_gate(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    action = body.get("action")
    if action not in GATE_ACTIONS:
        raise FactoryError(f"action must be one of: {', '.join(GATE_ACTIONS)}.", 422)
    comment = str(body.get("comment") or "")
    if action == "override" and not comment.strip():
        raise FactoryError("An override needs a justification comment (it is audited).", 422)
    rule_ids = _str_list(body["rule_ids"], "rule_ids") if body.get("rule_ids") is not None else None
    return project_out(await c.engine.gate_action(id, step_id, _acting(body, user_id), action, comment=comment,
                                                  rule_ids=rule_ids, goto_step=str(body.get("goto_step") or "")))


@router.post("/projects/{id}/steps/{step_id}/retry")
async def step_retry(id: str, step_id: str, body: dict[str, Any] | None = Body(default=None),
                     user_id: str = "") -> dict[str, Any]:
    return project_out(await c.engine.retry_step(id, step_id, _acting(body, user_id)))


@router.post("/projects/{id}/steps/{step_id}/skip")
async def step_skip(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    reason = str(body.get("reason") or "").strip()
    if not reason:
        raise FactoryError("Say why this step is skipped (it is audited).", 422)
    return project_out(await c.engine.skip_step(id, step_id, _acting(body, user_id), reason))


@router.post("/projects/{id}/steps/{step_id}/reopen")
async def step_reopen(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    return project_out(await c.engine.reopen_step(id, step_id, _acting(body, user_id), str(body.get("reason") or "")))


@router.post("/projects/{id}/steps/{step_id}/reassign")
async def step_reassign(id: str, step_id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    user_ids = _str_list(body.get("user_ids") if body.get("user_ids") is not None else [], "user_ids")
    unknown = [u for u in user_ids if c.get_user(u) is None]
    if unknown:
        raise FactoryError(f"Unknown user(s): {', '.join(unknown)}", 422)
    return project_out(await c.engine.reassign_step(id, step_id, _acting(body, user_id), user_ids))
