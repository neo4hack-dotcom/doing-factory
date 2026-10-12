"""Small, dependency-free helpers shared by every layer (ids, time, tolerant JSON, secrets)."""
from __future__ import annotations

import json
import re
import unicodedata
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

# ---------------------------------------------------------------------------
# Ids & time
# ---------------------------------------------------------------------------

def new_id(prefix: str) -> str:
    """`new_id("usr")` → "usr_3f9a0c1b2d4e" (SPEC §0). A trailing "_" in the prefix is tolerated."""
    return f"{prefix.rstrip('_')}_{uuid.uuid4().hex[:12]}"


def now_iso() -> str:
    """UTC, second precision, `Z` suffix — the one timestamp format stored and sent everywhere."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def to_iso(dt: datetime) -> str:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(value: str | datetime | None) -> datetime | None:
    """Aware UTC datetime, or None for empty/invalid input. Naive values are taken as UTC
    (everything we write is UTC; an LLM- or user-supplied date without offset is too)."""
    if isinstance(value, datetime):
        dt = value
    elif not value or not isinstance(value, str):
        return None
    else:
        try:
            dt = datetime.fromisoformat(value.strip().replace("z", "Z"))
        except ValueError:
            return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def iso_add(hours: float, base: str | datetime | None = None) -> str:
    """`base` (default: now) plus `hours`, as an ISO string — due dates, next polls, SLAs."""
    start = parse_iso(base) if base is not None else None
    return to_iso((start or datetime.now(timezone.utc)) + timedelta(hours=hours))


# ---------------------------------------------------------------------------
# Tolerant JSON (local models wrap, fence, think-tag and trail-comma their JSON)
# ---------------------------------------------------------------------------

_THINK = re.compile(r"<think>.*?(?:</think>|$)", re.DOTALL | re.IGNORECASE)
_FENCE = re.compile(r"```[ \t]*(?:json|JSON)?[ \t]*\n?(.*?)(?:```|$)", re.DOTALL)
_TRAILING_COMMA = re.compile(r",\s*([}\]])")
_MAX_SCAN_STARTS = 25   # bounded: a long prose reply full of braces must not go quadratic


def parse_json(text: Any) -> Any:
    """Best-effort JSON extraction from an LLM reply: raw → fenced block → first {...}/[...]
    (with trailing commas repaired). Returns None when nothing parses — the caller decides
    whether that is a repair round-trip or an error; nothing here invents an empty `{}`.
    Note a literal JSON `null` also yields None."""
    if isinstance(text, (dict, list)):
        return text
    if not isinstance(text, str) or not text.strip():
        return None
    cleaned = _THINK.sub("", text).strip()
    candidates = []
    fence = _FENCE.search(cleaned)
    if fence:
        candidates.append(fence.group(1).strip())
    candidates.append(cleaned)
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    decoder = json.JSONDecoder()
    for candidate in candidates:
        starts = [i for i, ch in enumerate(candidate) if ch in "{["][:_MAX_SCAN_STARTS]
        for start in starts:
            chunk = candidate[start:]
            for attempt in (chunk, _TRAILING_COMMA.sub(r"\1", chunk)):
                try:
                    return decoder.raw_decode(attempt)[0]
                except ValueError:
                    continue
    return None


# ---------------------------------------------------------------------------
# Text
# ---------------------------------------------------------------------------

def truncate(text: Any, n: int) -> str:
    """At most `n` characters, with an ellipsis when cut. None → ""."""
    s = "" if text is None else str(text)
    if n <= 0:
        return ""
    return s if len(s) <= n else s[: max(0, n - 1)].rstrip() + "…"


def slugify(text: Any, sep: str = "_", max_len: int = 64) -> str:
    """ASCII slug: "Chloé's MCP — v2" → "chloe_s_mcp_v2". Accents are folded rather than
    dropped so names stay recognisable in tool namespaces and keys. "" when nothing is left."""
    folded = unicodedata.normalize("NFKD", str(text or "")).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", sep, folded.lower()).strip(sep)
    return slug[:max_len].rstrip(sep)


# ---------------------------------------------------------------------------
# Secrets (masked on every read; a masked value sent back means "unchanged")
# ---------------------------------------------------------------------------

MASK = "••••"
_SECRET_KEY = re.compile(r"token|key|secret|password|passwd|credential|dsn|auth|cookie|session",
                         re.IGNORECASE)


def mask_secret(value: Any) -> str:
    """"" stays "" (nothing set); long values keep their last 4 chars so an admin can tell
    which key is configured; short ones are fully masked."""
    s = "" if value is None else str(value)
    if not s:
        return ""
    return f"{MASK}{s[-4:]}" if len(s) >= 16 else MASK * 2


def is_masked(value: Any) -> bool:
    return isinstance(value, str) and "•" in value


def apply_secret_patch(patch: dict[str, Any], field: str) -> dict[str, Any]:
    """In place, for a partial update of a secret the browser never sees: "" or a masked
    value means "keep the stored one" (the field is dropped from the patch); None means
    "clear it" (becomes ""). Returns `patch`."""
    if field in patch:
        value = patch[field]
        if value is None:
            patch[field] = ""
        elif not value or is_masked(value):
            del patch[field]
    return patch


def is_secret_key(name: str) -> bool:
    return bool(_SECRET_KEY.search(name or ""))


def mask_mapping(values: dict[str, Any] | None) -> dict[str, str]:
    """env / headers dict safe for the browser: secret-looking keys get their value masked."""
    return {k: (mask_secret(v) if is_secret_key(k) else str(v)) for k, v in (values or {}).items()}


def unmask_mapping(incoming: dict[str, Any] | None, stored: dict[str, Any] | None) -> dict[str, str]:
    """Inverse of mask_mapping on update: a still-masked value keeps the stored secret, so
    opening an edit form and saving never replaces a token with bullets."""
    stored = stored or {}
    return {k: (str(stored.get(k, "")) if is_masked(v) else str(v)) for k, v in (incoming or {}).items()}


def public_connector(doc: dict[str, Any]) -> dict[str, Any]:
    """A Connector document as the API returns it: env/header secrets masked, and URLs with
    embedded credentials (`https://user:pass@host`) in args/url masked too."""
    out = dict(doc)
    out["env"] = mask_mapping(doc.get("env"))
    out["headers"] = mask_mapping(doc.get("headers"))
    out["args"] = [_mask_url_credentials(a) for a in doc.get("args") or []]
    out["url"] = _mask_url_credentials(doc.get("url") or "")
    return out


def _mask_url_credentials(value: str) -> str:
    return re.sub(r"(://[^/@\s:]+:)[^/@\s]+@", lambda m: f"{m.group(1)}{MASK}@", str(value))


# ---------------------------------------------------------------------------
# Dicts & validation
# ---------------------------------------------------------------------------

def validation_message(exc: Any, limit: int = 3) -> str:
    """A pydantic ValidationError as one readable line: "llm.provider: Input should be …"."""
    parts = []
    for err in exc.errors()[:limit]:
        loc = ".".join(str(p) for p in err.get("loc", ()) if p != "body")
        parts.append(f"{loc}: {err.get('msg', 'invalid value')}" if loc else str(err.get("msg", "invalid value")))
    more = len(exc.errors()) - limit
    return "; ".join(parts) + (f" (+{more} more)" if more > 0 else "")


def deep_merge(base: dict[str, Any], patch: dict[str, Any]) -> dict[str, Any]:
    """New dict: `patch` over `base`, recursing into nested dicts; lists and scalars are
    replaced, not merged (a list sent by the UI is the whole new list)."""
    out = dict(base)
    for key, value in (patch or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out
