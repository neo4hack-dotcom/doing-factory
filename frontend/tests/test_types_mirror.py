"""frontend/src/types.ts must mirror backend/app/models.py field for field.

The two files are edited by hand (no codegen), so this test is what keeps them honest: every
pydantic model has a same-named TS interface with exactly the same fields, optional exactly where
the Python default is None, with a compatible base type; every Literal alias has the same values.

Run with the backend venv:
    cd backend && .venv/bin/python -m pytest ../frontend/tests/test_types_mirror.py -q
"""
from __future__ import annotations

import re
import sys
import types
import typing
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app import models  # noqa: E402

TS = (ROOT / "frontend" / "src" / "types.ts").read_text(encoding="utf-8")


def _strip_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


TS_CODE = _strip_comments(TS)


def ts_interfaces() -> dict[str, dict[str, tuple[bool, str]]]:
    """{interface: {field: (optional, type text)}} — top-level members only."""
    out: dict[str, dict[str, tuple[bool, str]]] = {}
    for m in re.finditer(r"export interface (\w+)\s*\{", TS_CODE):
        depth, i, start = 1, m.end(), m.end()
        while depth:
            depth += {"{": 1, "}": -1}.get(TS_CODE[i], 0)
            i += 1
        body = TS_CODE[start:i - 1]
        fields: dict[str, tuple[bool, str]] = {}
        level, member = 0, ""
        for ch in body:
            level += {"{": 1, "}": -1, "<": 1, ">": -1}.get(ch, 0)
            if ch == ";" and level == 0:
                fm = re.match(r"\s*(\w+)(\?)?\s*:\s*(.+)", member, flags=re.S)
                if fm:
                    fields[fm.group(1)] = (bool(fm.group(2)), " ".join(fm.group(3).split()))
                member = ""
            else:
                member += ch
        out[m.group(1)] = fields
    return out


def ts_unions() -> dict[str, set[str]]:
    out: dict[str, set[str]] = {}
    for m in re.finditer(r"export type (\w+)\s*=\s*([^;]+);", TS_CODE):
        values = re.findall(r"'([^']*)'", m.group(2))
        if values and re.fullmatch(r"[\s|'\w.-]*", m.group(2)):
            out[m.group(1)] = set(values)
    return out


INTERFACES = ts_interfaces()
UNIONS = ts_unions()

PY_MODELS = {
    name: cls for name, cls in vars(models).items()
    if isinstance(cls, type) and issubclass(cls, models.Model) and cls is not models.Model
}
PY_LITERALS = {
    name: set(typing.get_args(obj)) for name, obj in vars(models).items()
    if typing.get_origin(obj) is typing.Literal
}


def _unwrap_optional(ann):
    args = typing.get_args(ann)
    if typing.get_origin(ann) in (typing.Union, types.UnionType) and type(None) in args:
        rest = [a for a in args if a is not type(None)]
        return rest[0] if len(rest) == 1 else ann
    return ann


def _compatible(ann, ts_type: str) -> bool:
    ts = ts_type.replace(" | null", "").strip()
    ann = _unwrap_optional(ann)
    origin = typing.get_origin(ann)
    if ann is typing.Any:
        return ts == "unknown"
    if origin is typing.Literal:
        values = set(typing.get_args(ann))
        named = [n for n, v in PY_LITERALS.items() if v == values]
        inline = set(re.findall(r"'([^']*)'", ts))
        return ts in named or inline == values
    if ann is str:
        return ts == "string"
    if ann in (int, float):
        return ts == "number"
    if ann is bool:
        return ts == "boolean"
    if origin is list:
        return ts.endswith("[]")
    if origin is dict:
        return ts.startswith("Record<")
    if isinstance(ann, type) and issubclass(ann, models.Model):
        return ts == ann.__name__
    return True  # anything exotic: names and optionality are still checked


@pytest.mark.parametrize("name", sorted(PY_MODELS))
def test_model_has_matching_interface(name: str) -> None:
    assert name in INTERFACES, f"types.ts lacks `export interface {name}`"
    ts_fields = INTERFACES[name]
    py_fields = PY_MODELS[name].model_fields
    assert set(ts_fields) == set(py_fields), (
        f"{name}: only in Python {sorted(set(py_fields) - set(ts_fields))}, "
        f"only in TS {sorted(set(ts_fields) - set(py_fields))}"
    )
    for field_name, info in py_fields.items():
        optional_in_py = not info.is_required() and info.default is None
        optional_in_ts, ts_type = ts_fields[field_name]
        assert optional_in_ts == optional_in_py, (
            f"{name}.{field_name}: Python default None ⇔ TS `?:` (TS optional={optional_in_ts})"
        )
        assert _compatible(info.annotation, ts_type), f"{name}.{field_name}: TS type `{ts_type}` vs {info.annotation}"


@pytest.mark.parametrize("name", sorted(PY_LITERALS))
def test_literal_union_matches(name: str) -> None:
    assert name in UNIONS, f"types.ts lacks `export type {name} = …`"
    assert UNIONS[name] == PY_LITERALS[name]


def test_step_config_map_and_defaults() -> None:
    assert set(INTERFACES["StepConfigMap"]) == set(models.STEP_CONFIG_MODELS)
    for step_type, cls in models.STEP_CONFIG_MODELS.items():
        assert INTERFACES["StepConfigMap"][step_type][1] == cls.__name__
    block = re.search(r"DEFAULT_HOURS_SAVED[^{]*\{([^}]*)\}", TS_CODE)
    assert block, "DEFAULT_HOURS_SAVED missing from types.ts"
    ts_hours = {k: float(v) for k, v in re.findall(r"(\w+):\s*([\d.]+)", block.group(1))}
    assert ts_hours == models.DEFAULT_HOURS_SAVED


def test_step_type_metadata_covers_every_step_type() -> None:
    block = re.search(r"export const STEP_TYPES[^=]*=\s*\{(.*?)\n\};", TS_CODE, flags=re.S)
    assert block
    keys = set(re.findall(r"^\s{2}(\w+): \{", block.group(1), flags=re.M))
    assert keys == PY_LITERALS["StepType"]
