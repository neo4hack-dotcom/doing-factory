// Keyboard shortcuts. Single keys ("j", "a") and sequences ("g h") are ignored while the user types
// in a field, so list navigation and approve/reject shortcuts never fire into a textarea; combos
// with the platform modifier ("mod+k") work everywhere.
import { useEffect, useRef } from 'react';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
/** Label of the platform modifier for <Kbd>: "⌘" on macOS, "Ctrl" elsewhere. */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

/** How long the first key of a sequence ("g" in "g h") stays armed. */
export const SEQUENCE_TIMEOUT_MS = 1200;

/** True when the event comes from somewhere the user is typing (inputs, textareas, contenteditable). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(type);
  }
  return false;
}

/** Normalises a key event to a combo string: "mod+k", "shift+arrowup", "escape", "j", "?". */
export function comboOf(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): string {
  const key = e.key.toLowerCase();
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  // Shift is implied by printable characters ("?" is shift+/), so it is only spelled for named keys.
  if (e.shiftKey && key.length > 1) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

/**
 * Resolves key presses against a set of bindings that may contain two-key sequences ("g h").
 * Pure state machine (no DOM), so the timing rules are unit-tested.
 */
export class SequenceMatcher {
  private pending: { prefix: string; at: number } | null = null;

  constructor(private readonly timeoutMs = SEQUENCE_TIMEOUT_MS) {}

  /** Returns the binding that fires, 'pending' when the key armed a sequence, or null. */
  press(combo: string, bindings: readonly string[], now: number): string | 'pending' | null {
    if (this.pending && now - this.pending.at <= this.timeoutMs) {
      const seq = `${this.pending.prefix} ${combo}`;
      this.pending = null;
      if (bindings.includes(seq)) return seq;
    } else {
      this.pending = null;
    }
    if (bindings.some((b) => b.startsWith(`${combo} `))) {
      this.pending = { prefix: combo, at: now };
      return 'pending';
    }
    return bindings.includes(combo) ? combo : null;
  }
}

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Binds shortcuts on window while mounted. Keys: "j", "?", "mod+k", "escape", "mod+enter", "g h".
 * Handlers are read from a ref, so passing a fresh object each render does not rebind listeners.
 * Combos with "mod" fire even inside fields; bare keys and sequences do not.
 */
export function useHotkeys(map: HotkeyMap, enabled = true): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const matcher = new SequenceMatcher();
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat) return;
      const combo = comboOf(e);
      const isMod = combo.startsWith('mod+');
      if (!isMod && isTypingTarget(e.target)) return;
      const hit = matcher.press(combo, Object.keys(ref.current), Date.now());
      if (hit === null) return;
      e.preventDefault();
      if (hit !== 'pending') ref.current[hit]?.(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
