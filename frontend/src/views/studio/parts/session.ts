// Small session plumbing for the Studio: hand an AI-generated (unsaved) blueprint draft from the
// Blueprints list to the designer, and guard editors against losing unsaved changes.
import { useUnsavedChangesGuard } from '../../../lib/router';
import { readStorage, writeStorage } from '../../../lib/storage';
import type { Blueprint, ValidationReport } from '../../../types';

const DRAFT_KEY = 'factory.studio.generatedBlueprint';

export interface GeneratedDraft {
  blueprint: Blueprint;
  validation: ValidationReport | null;
  description: string;
}

let pending: GeneratedDraft | null = null;

/** Keeps the draft in memory and in sessionStorage (survives a reload of the designer). */
export function stashGeneratedDraft(draft: GeneratedDraft): void {
  pending = draft;
  writeStorage(DRAFT_KEY, JSON.stringify(draft), 'session');
}

/** Reads the draft (without clearing it: a React StrictMode double-mount must see it too). */
export function peekGeneratedDraft(): GeneratedDraft | null {
  if (pending) return pending;
  const raw = readStorage(DRAFT_KEY, 'session');
  if (!raw) return null;
  try {
    pending = JSON.parse(raw) as GeneratedDraft;
    return pending;
  } catch {
    return null;
  }
}

export function clearGeneratedDraft(): void {
  pending = null;
  writeStorage(DRAFT_KEY, null, 'session');
}

/**
 * While `dirty`, asks before leaving: closing/reloading the tab, in-app link clicks and programmatic
 * `navigate()` calls (⌘K, buttons) — see `useUnsavedChangesGuard` in lib/router. A caller that already
 * asked with useConfirm (or just saved) navigates with `{ force: true }`.
 */
export function useUnsavedGuard(dirty: boolean, message = 'You have unsaved changes. Leave without saving?'): void {
  useUnsavedChangesGuard(dirty, message);
}
