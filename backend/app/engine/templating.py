"""Jinja2 sandboxed templating for blueprints, operations and watchers (SPEC §4, §14).

Three ways to use a template, with different tolerance for missing data, because a missing
value means something different in each:

- `render()` — prompts and messages. Lenient (ChainableUndefined): a prompt written for the
  full flow must still render when a step is retried or run out of order, and an absent
  optional fact simply disappears from the text.
- `render_obj()` — structured arguments (operation inputs, fan-out child inputs). A string that
  is exactly one `{{ expr }}` returns the native value (a list of Jira issues, not its text).
  Missing values are *strict when used*: `{{ vars.epic.key }}` without an epic raises a
  TemplateError naming the missing value, because sending "" to a write tool is worse than
  failing. Tests stay lenient (`x or ''`, `if x`, `| default`), so optional arguments keep
  their explicit fallbacks.
- `evaluate()` / `condition()` — bare expressions or a single `{{ … }}` (`when`, `items`,
  `until`, watcher filters). Undefined is falsy: a condition over data that does not exist
  yet is False, never an error.

A template that does not compile, or fails while rendering, always raises TemplateError with
the offending excerpt — nothing here ever quietly yields "".
"""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from jinja2 import ChainableUndefined, TemplateError as JinjaTemplateError, Undefined
from jinja2.exceptions import UndefinedError
from jinja2.sandbox import SandboxedEnvironment

from app.errors import TemplateError
from app.util import slugify, truncate

# "{{ expr }}" and nothing else (no second expression, no surrounding text).
_ONE_EXPR = re.compile(r"^\{\{(?P<expr>(?:(?!\{\{|\}\}).)*)\}\}$", re.S)
_EXCERPT_CHARS = 160


# ---------------------------------------------------------------------------
# Undefined flavours
# ---------------------------------------------------------------------------

class _LenientUndefined(ChainableUndefined):
    """Renders as "", chains (`a.b.c`), is falsy, and compares False — so a condition such as
    `vars.score > 3` over a score that does not exist yet is simply False."""
    __slots__ = ()

    def _false(self, other: Any) -> bool:   # noqa: ARG002 — operator signature
        return False

    __lt__ = __le__ = __gt__ = __ge__ = _false


class _ArgUndefined(_LenientUndefined):
    """For structured arguments: still chainable, falsy and testable (`x or ''`, `if x`,
    `x | default(…)`), but refuses to be *used* as a value — rendered, iterated, measured."""
    __slots__ = ()

    @property
    def _undefined_message(self) -> str:
        if self._undefined_hint:
            return self._undefined_hint
        return f"missing value '{self._undefined_name}'"

    __str__ = __iter__ = __len__ = Undefined._fail_with_undefined_error   # type: ignore[assignment]


# ---------------------------------------------------------------------------
# Filters (the builtin blueprints rely on them — see tests/test_blueprints.py)
# ---------------------------------------------------------------------------

def _tojson(value: Any) -> str:
    # Plain JSON (Jinja's builtin tojson HTML-escapes quotes and angle brackets for <script>).
    return json.dumps(value, ensure_ascii=False, default=str)


def _bullets(value: Any) -> str:
    """List → "- a\\n- b"; a string is already text and stays as is; nothing → ""."""
    if value is None or (isinstance(value, Undefined) and not isinstance(value, _ArgUndefined)):
        return ""
    if isinstance(value, str):
        return value
    return "\n".join(f"- {item}" for item in value)


def _truncate_chars(value: Any, n: int = 200) -> str:
    return "" if value is None else truncate(str(value), int(n))


def _slug(value: Any) -> str:
    return slugify("" if value is None else str(value), sep="-", max_len=255)


def _make_env(undefined: type[Undefined]) -> SandboxedEnvironment:
    env = SandboxedEnvironment(undefined=undefined, autoescape=False)
    env.filters.update(tojson=_tojson, bullets=_bullets, truncate_chars=_truncate_chars, slug=_slug)
    return env


_LENIENT = _make_env(_LenientUndefined)
_ARGS = _make_env(_ArgUndefined)
_ENVS = {"lenient": _LENIENT, "args": _ARGS}


# ---------------------------------------------------------------------------
# Compilation (cached: the same blueprint strings are rendered for every project)
# ---------------------------------------------------------------------------

def _excerpt(text: str) -> str:
    return truncate(" ".join(str(text).split()), _EXCERPT_CHARS)


def _error(text: str, exc: BaseException) -> TemplateError:
    if isinstance(exc, TemplateError):
        return exc
    if isinstance(exc, JinjaTemplateError):
        reason = getattr(exc, "message", None) or str(exc) or type(exc).__name__
        line = getattr(exc, "lineno", None)
        if line and "\n" in text:
            reason = f"{reason} (line {line})"
    else:
        reason = f"{type(exc).__name__}: {exc}"
    return TemplateError(f"Template error: {reason} — in `{_excerpt(text)}`")


@lru_cache(maxsize=1024)
def _template(mode: str, source: str):
    try:
        return _ENVS[mode].from_string(source)
    except Exception as exc:   # TemplateSyntaxError, SecurityError…
        raise _error(source, exc) from exc


@lru_cache(maxsize=1024)
def _expression(mode: str, source: str):
    try:
        return _ENVS[mode].compile_expression(source, undefined_to_none=False)
    except Exception as exc:
        raise _error(source, exc) from exc


def bare_expression(expr: str) -> str:
    """`{{ vars.x }}` → `vars.x`; a bare expression is returned stripped. Whitespace-control
    markers (`{{- x -}}`) are dropped too."""
    text = (expr or "").strip()
    match = _ONE_EXPR.match(text)
    if match:
        text = match["expr"].strip().strip("-+").strip()
    return text


def check_template(template: str) -> None:
    """Raise TemplateError when `template` does not compile (blueprint validation)."""
    if template:
        _template("lenient", template)


def check_expression(expr: str) -> None:
    """Raise TemplateError when the expression (bare or `{{ … }}`) does not compile."""
    source = bare_expression(expr)
    if source:
        _expression("lenient", source)


# ---------------------------------------------------------------------------
# Public API (SPEC §12)
# ---------------------------------------------------------------------------

def render(template: str, ctx: dict) -> str:
    """Render a prompt / message template. Missing values render as ""."""
    if not template:
        return ""
    compiled = _template("lenient", template)
    try:
        return compiled.render(**(ctx or {}))
    except Exception as exc:
        raise _error(template, exc) from exc


def render_obj(obj: Any, ctx: dict, *, strict: bool = True) -> Any:
    """Recursively render the strings of a dict/list. A string that is exactly one
    `{{ expr }}` returns the expression's native value. With `strict` (the default, for
    arguments), using a missing value raises TemplateError instead of sending ""."""
    mode = "args" if strict else "lenient"
    if isinstance(obj, str):
        text = obj.strip()
        if _ONE_EXPR.match(text):
            return _evaluate(bare_expression(text), ctx, mode, strict=strict, original=obj)
        if "{{" not in obj and "{%" not in obj and "{#" not in obj:
            return obj
        compiled = _template(mode, obj)
        try:
            return compiled.render(**(ctx or {}))
        except Exception as exc:
            raise _error(obj, exc) from exc
    if isinstance(obj, dict):
        return {k: render_obj(v, ctx, strict=strict) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [render_obj(v, ctx, strict=strict) for v in obj]
    return obj


def evaluate(expr: str, ctx: dict, *, strict: bool = False) -> Any:
    """Evaluate a bare expression (or a single `{{ … }}`). Undefined → None; with `strict`,
    an undefined result raises TemplateError naming it (e.g. fan-out items whose producing
    step has not run)."""
    source = bare_expression(expr)
    if not source:
        if strict:
            raise TemplateError("Template error: the expression is empty")
        return None
    return _evaluate(source, ctx, "args" if strict else "lenient", strict=strict, original=expr)


def condition(expr: str, ctx: dict) -> bool:
    """Truth of a `when` / `until` / filter expression. '' → True. Anything undefined → False."""
    source = bare_expression(expr)
    if not source:
        return True
    compiled = _expression("lenient", source)
    try:
        value = compiled(**(ctx or {}))
    except UndefinedError:
        return False   # arithmetic or a call on data that does not exist yet
    except Exception as exc:
        raise _error(expr, exc) from exc
    return bool(value)


def _evaluate(source: str, ctx: dict, mode: str, *, strict: bool, original: str) -> Any:
    compiled = _expression(mode, source)
    try:
        value = compiled(**(ctx or {}))
    except Exception as exc:
        raise _error(original, exc) from exc
    if isinstance(value, Undefined):
        if strict:
            name = getattr(value, "_undefined_name", None) or source
            raise TemplateError(f"Template error: missing value '{name}' — in `{_excerpt(original)}` "
                                "(the step that provides it has not run, or returned no such field)")
        return None
    return value
