"""LoopGuard: bounded, self-terminating autonomous execution (SPEC §5 retries, §6 agent loop).

An agent that decides its own next action fails in two distinct ways: it repeats the same
action that already failed (often reworded), or it keeps taking different-looking actions
forever. LoopGuard catches both:

- a per-signature failure streak catches the first — the signature is built from the
  structural target of an action (what it does, with which tool, with which argument
  *names*), never from its free text or argument values, so a reworded retry of the same
  idea still counts as a repeat;
- hard ceilings on the number of actions and on wall-clock time catch the second, whether
  or not any single action repeats.

Ported from DOINg.Agents (`orchestrator/guardrails.py`), plus `to_state`/`from_state`: the
Factory's agent pauses for human confirmations that can take hours and survives restarts,
so the guard travels inside the JSON agent state — and time spent waiting for a human is
not charged to the agent's time budget.
"""
from __future__ import annotations

import hashlib
import json
import time
from typing import Any


def signature(step: dict[str, Any]) -> str:
    """Canonical signature of an action's structural target. Same action + tool + purpose +
    argument names = "the same idea", however the description or the argument values are
    worded: a retry nearly always rewords, so free text must not be part of the key or the
    repeats this exists to catch would never match."""
    args = step.get("args") if isinstance(step.get("args"), dict) else {}
    key = {
        "action": step.get("action"),
        "purpose": step.get("purpose"),
        "tool": step.get("tool") or args.get("tool_name"),
        "arg_names": sorted(str(k) for k in args),
    }
    raw = json.dumps(key, sort_keys=True, ensure_ascii=False, default=str)
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


class LoopGuard:
    def __init__(self, max_total_steps: int, timeout_s: float, stagnation_limit: int = 2) -> None:
        self.max_total_steps = max(0, int(max_total_steps or 0))   # 0 = no step ceiling
        self.timeout_s = max(0.0, float(timeout_s or 0))           # 0 = no time ceiling
        self.stagnation_limit = max(1, int(stagnation_limit))
        self.started_at = time.monotonic()
        self.total_attempts = 0
        self._fail_streak: dict[str, int] = {}

    # ------------------------------------------------------------------ recording
    def record(self, step: dict[str, Any], ok: bool) -> None:
        """One attempted action (successful or not) — it consumes budget either way."""
        self.total_attempts += 1
        sig = signature(step)
        self._fail_streak[sig] = 0 if ok else self._fail_streak.get(sig, 0) + 1

    # ------------------------------------------------------------------ verdicts
    def is_stagnant(self, step: dict[str, Any]) -> bool:
        """This structural action failed `stagnation_limit` times in a row: another blind
        attempt would be wasted — change approach or stop."""
        return self._fail_streak.get(signature(step), 0) >= self.stagnation_limit

    def repeats_failed(self, step: dict[str, Any]) -> bool:
        """For a not-yet-attempted action: does it re-propose, under new wording, an approach
        already known not to work?"""
        return self.is_stagnant(step)

    def over_step_budget(self) -> bool:
        return self.max_total_steps > 0 and self.total_attempts >= self.max_total_steps

    def over_time_budget(self) -> bool:
        return self.timeout_s > 0 and self.elapsed_s() >= self.timeout_s

    def elapsed_s(self) -> float:
        return time.monotonic() - self.started_at

    def steps_left(self) -> int:
        return max(0, self.max_total_steps - self.total_attempts) if self.max_total_steps else 1 << 30

    def snapshot(self) -> dict[str, Any]:
        """Live status for the UI ("5/8 actions, 40 s/600 s"), so a runaway is visible as it
        approaches its ceiling rather than only after it is stopped."""
        return {"steps_used": self.total_attempts, "max_steps": self.max_total_steps,
                "elapsed_s": round(self.elapsed_s(), 1), "timeout_s": self.timeout_s}

    # ------------------------------------------------------------------ persistence
    def to_state(self) -> dict[str, Any]:
        """JSON-serialisable state (stored inside an agent's resumable state)."""
        return {"max_total_steps": self.max_total_steps, "timeout_s": self.timeout_s,
                "stagnation_limit": self.stagnation_limit, "total_attempts": self.total_attempts,
                "elapsed_s": round(self.elapsed_s(), 3), "fail_streak": dict(self._fail_streak)}

    @classmethod
    def from_state(cls, state: dict[str, Any] | None, *, max_total_steps: int, timeout_s: float,
                   stagnation_limit: int = 2) -> "LoopGuard":
        """Resume a guard: counts and streaks are kept, the clock restarts where it stopped
        (time spent waiting for a human is not the agent's). Budgets come from the caller —
        the current settings — so an admin raising them mid-run takes effect."""
        guard = cls(max_total_steps, timeout_s, stagnation_limit)
        if state:
            guard.total_attempts = int(state.get("total_attempts") or 0)
            guard._fail_streak = {str(k): int(v) for k, v in (state.get("fail_streak") or {}).items()}
            guard.started_at = time.monotonic() - float(state.get("elapsed_s") or 0)
        return guard
