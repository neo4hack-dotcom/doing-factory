"""Templating semantics (SPEC §4, §14), blueprint validation and the flow-executor helpers."""
from __future__ import annotations

import copy

import pytest

from app.engine import executors_flow
from app.engine.blueprint import instantiate_stages, validate_blueprint
from app.engine.templating import condition, evaluate, render, render_obj
from app.errors import TemplateError
from app.seed.defaults import BUILTIN_BLUEPRINTS, seed_defaults

CTX = {"vars": {"issues": [{"key": "A-1"}], "n": 3}, "inputs": {"name": "Nostro MCP"}, "project": {"key": "MCP-0001"}}


def test_render_is_lenient_and_has_the_filters():
    assert render("Hi {{ inputs.name }}{{ vars.missing.deep }}", CTX) == "Hi Nostro MCP"
    assert render("{{ ['a', 'b'] | bullets }}", CTX) == "- a\n- b"
    assert render("{{ 'abcdef' | truncate_chars(3) }}", CTX).startswith("ab")
    assert render("{{ inputs.name | slug }}", CTX) == "nostro-mcp"
    assert render('{{ {"a": "é"} | tojson }}', CTX) == '{"a": "é"}'
    with pytest.raises(TemplateError, match="Template error"):
        render("{{ unclosed", CTX)


def test_render_obj_returns_native_values_and_is_strict_about_missing_ones():
    out = render_obj({"issues": "{{ vars.issues }}", "n": "{{ vars.n }}", "text": "Key {{ project.key }}",
                      "fallback": "{{ vars.nope or 'x' }}"}, CTX)
    assert out == {"issues": [{"key": "A-1"}], "n": 3, "text": "Key MCP-0001", "fallback": "x"}
    with pytest.raises(TemplateError, match="vars.epic|epic"):
        render_obj({"key": "{{ vars.epic.key }}"}, CTX)


def test_evaluate_and_condition():
    assert evaluate("vars.n", CTX) == 3 and evaluate("{{ vars.n }}", CTX) == 3
    assert evaluate("vars.nothing", CTX) is None
    with pytest.raises(TemplateError):
        evaluate("vars.nothing", CTX, strict=True)
    assert condition("", CTX) is True
    assert condition("vars.n > 2", CTX) is True and condition("{{ vars.n > 5 }}", CTX) is False
    assert condition("vars.score > 3", CTX) is False                     # undefined → False, no error
    with pytest.raises(TemplateError):
        condition("vars.n >", CTX)


def test_builtin_blueprints_validate_and_errors_are_reported(container):
    seed_defaults(container)
    for blueprint in BUILTIN_BLUEPRINTS:
        report = validate_blueprint(container, blueprint)
        assert report["ok"], report["errors"]
    broken = copy.deepcopy(next(b for b in BUILTIN_BLUEPRINTS if b["key"] == "mcp_delivery"))
    broken["id"] = "bp_other"
    signoff = next(s for st in broken["stages"] for s in st["steps"] if s["id"] == "spec_signoff")
    signoff["config"]["on_reject"]["goto_step"] = "nowhere"
    broken["stages"][0]["steps"][0]["when"] = "vars.x >"
    report = validate_blueprint(container, broken)
    assert not report["ok"]
    text = " ".join(report["errors"])
    assert "nowhere" in text and "when" in text and "already uses the key" in text


def test_instantiate_copies_configs():
    blueprint = copy.deepcopy(BUILTIN_BLUEPRINTS[0])
    stages = instantiate_stages(blueprint)
    first = stages[0]["steps"][0]
    assert first["status"] == "pending" and first["trace"] == []
    first["config"]["changed"] = True
    assert "changed" not in blueprint["stages"][0]["steps"][0]["config"]


def test_field_coercion(container):
    fields = [{"key": "n", "label": "Count", "type": "number", "required": True},
              {"key": "ok", "label": "OK", "type": "checkbox"},
              {"key": "items", "label": "Items", "type": "list"},
              {"key": "level", "label": "Level", "type": "select", "options": ["Low", "High"]}]
    values, problems = executors_flow.collect_values(container, fields, {"n": "4", "ok": "yes", "items": "- a\n- b",
                                                                         "level": "high"})
    assert problems == [] and values == {"n": 4, "ok": True, "items": ["a", "b"], "level": "High"}
    _, problems = executors_flow.collect_values(container, fields, {"n": "", "level": "Medium"})
    assert any("Count is required" in p for p in problems) and any("Level" in p for p in problems)
    lenient = executors_flow.coerce_field(container, fields[0], "about 12 days", strict=False)
    assert lenient == 12
