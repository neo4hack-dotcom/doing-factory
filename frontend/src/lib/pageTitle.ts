// The header's title slot. A view declares its title with `usePageTitle('UC-0007 · Payments MCP')`;
// the Header reads it with `usePageTitleValue()`. A module-level store (not context) because the
// writer (a view deep in the tree) and the reader (the shell header) share no parent but App.
import { useEffect, useSyncExternalStore } from 'react';

const APP_NAME = 'DOINg.AI Factory';

let current = '';
const listeners = new Set<() => void>();

function set(title: string): void {
  if (title === current) return;
  current = title;
  document.title = title ? `${title} · ${APP_NAME}` : APP_NAME;
  listeners.forEach((l) => l());
}

/** Sets the header title (and the tab title) while the calling view is mounted. */
export function usePageTitle(title: string): void {
  useEffect(() => {
    set(title);
  }, [title]);
  useEffect(() => () => set(''), []);
}

/** Current header title ('' when the view did not set one). */
export function usePageTitleValue(): string {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => '',
  );
}
