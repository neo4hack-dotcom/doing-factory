"""Studio library: the prompt registry and the compliance rules (SPEC §9).

Prompts: the defaults ship in code (app.llm.prompts.DEFAULT_PROMPTS); the `prompts`
collection holds only the admin's overrides, keyed by prompt key. So an untouched prompt
follows improvements to its default, and Reset is simply "delete the override".
Mutations are audited as `settings.updated` with `data.section` = prompts | rules.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body

from app.api import actor, editable, found, shape, shape_all, validate
from app.deps import container as c
from app.errors import Conflict, FactoryError, NotFound
from app.llm.prompts import DEFAULT_PROMPTS
from app.models import PromptDef, Rule
from app.util import new_id

router = APIRouter(prefix="/api")


# ---------------------------------------------------------------------------------- prompts

def _prompt(key: str, override: dict[str, Any] | None) -> dict[str, Any]:
    default = DEFAULT_PROMPTS.get(key) or {}
    return PromptDef(
        key=key,
        name=default.get("name") or key,
        description=default.get("description") or "",
        content=override["content"] if override else default.get("content") or "",
        default_content=default.get("content") or "",
        updated_at=(override or {}).get("updated_at") or "",
    ).model_dump()


def _known(key: str) -> dict[str, Any] | None:
    """The stored override of a prompt (None when it uses its default). 404 for a key that is
    neither a default prompt nor a stored one."""
    override = c.store.get("prompts", key)
    if key not in DEFAULT_PROMPTS and override is None:
        raise NotFound(f"Unknown prompt '{key}'")
    return override


@router.get("/prompts")
async def list_prompts() -> list[dict[str, Any]]:
    overrides = {doc["id"]: doc for doc in c.store.list("prompts")}
    # A stored override whose default was since removed stays visible rather than vanishing.
    keys = list(DEFAULT_PROMPTS) + [k for k in overrides if k not in DEFAULT_PROMPTS]
    return [_prompt(k, overrides.get(k)) for k in keys]


@router.put("/prompts/{key}")
async def update_prompt(key: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    _known(key)
    content = body.get("content")
    if not isinstance(content, str) or not content.strip():
        raise FactoryError("A prompt cannot be empty — use Reset to restore the default.", 422)
    acting = actor(body.get("user_id") or user_id)
    default = (DEFAULT_PROMPTS.get(key) or {}).get("content")
    if content == default:
        c.store.delete("prompts", key)      # identical to the default: keep following it
        override = None
    else:
        override = c.store.put("prompts", {"id": key, "key": key, "content": content, "updated_by": acting})
    c.record_event("settings.updated", f"Prompt '{key}' edited", actor=acting,
                   data={"section": "prompts", "action": "prompt.updated", "key": key})
    return _prompt(key, override)


@router.post("/prompts/{key}/reset")
async def reset_prompt(key: str, body: dict[str, Any] | None = Body(default=None), user_id: str = "") -> dict[str, Any]:
    if key not in DEFAULT_PROMPTS:
        _known(key)   # 404 when unknown altogether
        raise FactoryError(f"Prompt '{key}' has no built-in default to reset to.", 409)
    if c.store.delete("prompts", key):
        c.record_event("settings.updated", f"Prompt '{key}' reset to default",
                       actor=actor((body or {}).get("user_id") or user_id),
                       data={"section": "prompts", "action": "prompt.reset", "key": key})
    return _prompt(key, None)


# ---------------------------------------------------------------------------------- rules

@router.get("/rules")
async def list_rules() -> list[dict[str, Any]]:
    return shape_all(Rule, c.store.list("rules"))


@router.post("/rules")
async def create_rule(body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    rule = _checked_rule({"id": new_id("rule"), **editable(Rule, body)})
    saved = c.store.put("rules", rule)
    _audit(f"Compliance rule {saved['code']} added", body.get("user_id") or user_id, "rule.created", saved)
    return shape(Rule, saved)


@router.put("/rules/{id}")
async def update_rule(id: str, body: dict[str, Any] = Body(...), user_id: str = "") -> dict[str, Any]:
    current = found(c.store.get("rules", id), "Rule", id)
    saved = c.store.put("rules", _checked_rule({**current, **editable(Rule, body)}))
    _audit(f"Compliance rule {saved['code']} updated", body.get("user_id") or user_id, "rule.updated", saved)
    return shape(Rule, saved)


@router.delete("/rules/{id}")
async def delete_rule(id: str, user_id: str = "") -> dict[str, Any]:
    rule = found(c.store.get("rules", id), "Rule", id)
    c.store.delete("rules", id)
    _audit(f"Compliance rule {rule.get('code') or id} deleted", user_id, "rule.deleted", rule)
    return {"ok": True, "id": id}


def _checked_rule(data: dict[str, Any]) -> dict[str, Any]:
    rule = validate(Rule, data, "rule").model_dump()
    rule["title"] = rule["title"].strip()
    if not rule["title"]:
        raise FactoryError("A rule needs a title.", 422)
    others = {(r.get("code") or "").upper(): r for r in c.store.list("rules") if r["id"] != rule["id"]}
    rule["code"] = rule["code"].strip().upper()
    if not rule["code"]:
        while not rule["code"] or rule["code"] in others:   # skip codes a seed or import already took
            rule["code"] = f"RULE-{c.store.next_seq('rule_code'):03d}"
    elif rule["code"] in others:
        clash = others[rule["code"]]
        raise Conflict(f"Rule code {rule['code']} is already used by '{clash.get('title') or clash['id']}'.")
    rule["tags"] = list(dict.fromkeys(t.strip() for t in rule["tags"] if t and t.strip()))
    return rule


def _audit(message: str, acting: str, action: str, rule: dict[str, Any]) -> None:
    c.record_event("settings.updated", message, actor=actor(acting),
                   data={"section": "rules", "action": action, "rule_id": rule.get("id"), "code": rule.get("code")})
