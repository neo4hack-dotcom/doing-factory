// Small session plumbing for the Studio: hand an AI-generated (unsaved) blueprint draft from the
// Blueprints list to the designer, and guard editors against losing unsaved changes.
import { useEffect, useRef } from 'react';
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
 * While `dirty`, asks before leaving: closing/reloading the tab (beforeunload) and clicking any
 * in-app link (capture-phase click on `a[href^="#"]`, which runs before the router's handler).
 * Programmatic `navigate()` calls are the caller's job (ask with useConfirm first).
 */
export function useUnsavedGuard(dirty: boolean, message = 'You have unsaved changes. Leave without saving?'): void {
  const ref = useRef({ dirty, message });
  ref.current = { dirty, message };
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!ref.current.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const click = (e: MouseEvent) => {
      if (!ref.current.dirty || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!anchor || anchor.getAttribute('href') === location.hash) return;
      if (!window.confirm(ref.current.message)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('click', click, true);
    };
  }, []);
}
