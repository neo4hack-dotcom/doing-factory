"""DOINg.BA know-how in the default prompts: Gherkin test design, Agile estimation per line,
Given/When/Then + WSJF in Jira stories — with every JSON shape the code parses unchanged."""
from __future__ import annotations

from app.engine.executors_ai import normalise_estimate
from app.llm.prompts import DEFAULT_PROMPTS
from app.models import Estimate
from app.seed.defaults import BUILTIN_BLUEPRINTS, TEST_PLAN_PROMPT

BLUEPRINTS = {bp["key"]: bp for bp in BUILTIN_BLUEPRINTS}


def test_test_designer_asks_for_uat_table_and_gherkin() -> None:
    text = DEFAULT_PROMPTS["test_designer"]["content"]
    assert "ID | Scenario | Steps | Expected result | Priority | Type" in text
    for word in ("functional", "security", "performance", "edge", "```gherkin", "Feature:", "Background:",
                 "Scenario:", "Scenario Outline:", "Examples:", "Given", "When", "Then"):
        assert word in text, word


def test_jira_writer_keeps_its_shape_and_adds_gherkin_and_wsjf() -> None:
    text = DEFAULT_PROMPTS["jira_writer"]["content"]
    assert '{"issues": [{"summary"' in text and '"story_points": 1 | 2 | 3 | 5 | 8 | 13' in text
    assert "Given" in text and "When" in text and "Then" in text and "WSJF" in text


def test_estimator_keeps_the_estimate_shape() -> None:
    text = DEFAULT_PROMPTS["estimator"]["content"]
    for key in ('"value"', '"unit"', '"confidence"', '"breakdown"', '"item"', '"rationale"', '"tshirt"', '"complexity"'):
        assert key in text, key
    assert "1, 2, 3, 5, 8, 13" in text


def test_per_line_sizing_folds_into_estimate_lines() -> None:
    out = normalise_estimate({"value": 8, "confidence": "Medium", "rationale": "Two tools.", "breakdown": [
        {"item": "Implement get_balance tool", "value": 5, "tshirt": "m", "complexity": "High", "confidence": "low",
         "rationale": "New API."},
        {"item": "Tests", "value": 3, "tshirt": "huge", "complexity": "??"},
        {"item": "", "value": 2}]}, "points")
    Estimate.model_validate(out)
    assert [set(line) for line in out["breakdown"]] == [{"item", "value"}] * 2
    assert out["breakdown"][0]["item"] == "Implement get_balance tool (M · high complexity · low confidence) — New API."
    assert out["breakdown"][1]["item"] == "Tests"           # off-vocabulary values are dropped, not invented
    assert out["value"] == 8 and out["confidence"] == "medium"


def test_mcp_delivery_test_plan_step_asks_for_gherkin() -> None:
    step = next(st for stage in BLUEPRINTS["mcp_delivery"]["stages"] for st in stage["steps"] if st["id"] == "test_plan")
    assert step["config"]["artifact_title"] == "Test plan & acceptance (Gherkin)"
    assert step["config"]["system_prompt"] == "test_designer"
    assert "```gherkin" in TEST_PLAN_PROMPT and "Scenario Outline" in TEST_PLAN_PROMPT
