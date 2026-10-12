// Tiny hash router (docs/SPEC.md §11). Hash URLs keep deep links working when the backend serves
// the SPA from any path, with no server-side rewrite rules and no router dependency.
import { createElement, useEffect, useRef, useSyncExternalStore } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

export type RouteName =
  | 'home' | 'inbox' | 'projects' | 'project-new' | 'project' | 'floor' | 'intake' | 'kpis'
  | 'blueprints' | 'blueprint' | 'operations' | 'prompts' | 'rules' | 'settings' | 'not-found';

export interface Route {
  name: RouteName;
  /** Decoded path parameters, e.g. {id: 'prj_…', stepId: 'spec'}. */
  params: Record<string, string>;
  /** Decoded query string after the path ("#/projects?status=active"). */
  query: Record<string, string>;
  /** Normalised path without the query, e.g. "/projects/prj_x". */
  path: string;
}

/** Order matters: literal segments ("new") must precede the `:id` pattern they would collide with. */
const ROUTE_TABLE: Array<[pattern: string, name: RouteName]> = [
  ['/', 'home'],
  ['/inbox', 'inbox'],
  ['/inbox/:itemId', 'inbox'],
  ['/projects', 'projects'],
  ['/projects/new', 'project-new'],
  ['/projects/:id', 'project'],
  ['/projects/:id/:stepId', 'project'],
  ['/floor', 'floor'],
  ['/intake', 'intake'],
  ['/kpis', 'kpis'],
  ['/studio/blueprints', 'blueprints'],
  ['/studio/blueprints/:id', 'blueprint'],
  ['/studio/operations', 'operations'],
  ['/studio/prompts', 'prompts'],
  ['/studio/rules', 'rules'],
  ['/settings', 'settings'],
  ['/settings/:tab', 'settings'],
];

/** Settings tabs (SPEC §11) — the `:tab` segment of `#/settings/:tab`. */
export const SETTINGS_TABS = [
  { key: 'ai', label: 'AI Model' },
  { key: 'connectors', label: 'Connectors' },
  { key: 'watchers', label: 'Watchers' },
  { key: 'people', label: 'People & Teams' },
  { key: 'notifications', label: 'Notifications' },
  { key: 'engine', label: 'Engine' },
  { key: 'general', label: 'General' },
  { key: 'audit', label: 'Audit Log' },
  { key: 'backup', label: 'Backup' },
] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number]['key'];

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Parses a location hash ("#/projects/prj_1?x=1") into a Route. Pure: unit-tested. */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, '') || '/';
  const qIndex = raw.indexOf('?');
  const pathPart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const query: Record<string, string> = {};
  if (qIndex >= 0) new URLSearchParams(raw.slice(qIndex + 1)).forEach((v, k) => { query[k] = v; });

  const segments = pathPart.split('/').filter(Boolean);
  const path = `/${segments.join('/')}`;
  for (const [pattern, name] of ROUTE_TABLE) {
    const parts = pattern.split('/').filter(Boolean);
    if (parts.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = parts.every((p, i) => {
      if (p.startsWith(':')) {
        params[p.slice(1)] = safeDecode(segments[i]);
        return true;
      }
      return p === segments[i];
    });
    if (ok) return { name, params, query, path };
  }
  return { name: 'not-found', params: {}, query, path };
}

/** Path builders — the only place that knows how ids are encoded into URLs. */
export const paths = {
  home: () => '/',
  inbox: (itemId?: string) => (itemId ? `/inbox/${encodeURIComponent(itemId)}` : '/inbox'),
  projects: (query?: Record<string, string>) => withQuery('/projects', query),
  newProject: (blueprintId?: string) => withQuery('/projects/new', blueprintId ? { blueprint: blueprintId } : undefined),
  project: (id: string, stepId?: string) =>
    `/projects/${encodeURIComponent(id)}${stepId ? `/${encodeURIComponent(stepId)}` : ''}`,
  floor: () => '/floor',
  intake: () => '/intake',
  kpis: () => '/kpis',
  blueprints: () => '/studio/blueprints',
  blueprint: (id: string) => `/studio/blueprints/${encodeURIComponent(id)}`,
  operations: () => '/studio/operations',
  prompts: () => '/studio/prompts',
  rules: () => '/studio/rules',
  settings: (tab: SettingsTab = 'ai') => `/settings/${tab}`,
};

function withQuery(path: string, query?: Record<string, string>): string {
  const entries = Object.entries(query ?? {}).filter(([, v]) => v !== '' && v !== undefined);
  return entries.length ? `${path}?${new URLSearchParams(entries).toString()}` : path;
}

// ---------------------------------------------------------------------------------- leave guards
/**
 * A navigation guard answers "may the user leave the current page for `to`?" (an app path such as
 * "/projects/prj_1"). It may ask — typically `window.confirm` while an editor has unsaved changes —
 * and returns false to cancel the navigation.
 */
export type NavigationGuard = (to: string) => boolean;

let guards: NavigationGuard[] = [];
/** Target approved by an anchor click a moment ago: the Link handler's navigate() must not ask twice. */
let approved: string | null = null;

const hashOf = (path: string) => `#${path.startsWith('/') ? path : `/${path}`}`;

/** Registers a guard consulted by navigate() and by in-app link clicks; returns its unregister. */
export function registerNavigationGuard(guard: NavigationGuard): () => void {
  guards = [...guards, guard];
  if (guards.length === 1 && typeof window !== 'undefined') window.addEventListener('click', guardLinkClick, true);
  return () => {
    const before = guards.length;
    guards = guards.filter((g) => g !== guard);
    if (before && !guards.length && typeof window !== 'undefined') window.removeEventListener('click', guardLinkClick, true);
  };
}

/** Runs the guards (newest first, stopping at the first refusal). True = the navigation may proceed. */
export function confirmNavigation(path: string): boolean {
  const to = hashOf(path).slice(1);
  for (const guard of [...guards].reverse()) {
    if (!guard(to)) return false;
  }
  return true;
}

/**
 * Capture-phase click on an in-app `<a href="#/…">` (Links and plain anchors alike): runs the guards
 * before the router's handler or the browser follows the link, and remembers the approval so the
 * Link's own navigate() call does not ask a second time.
 */
function guardLinkClick(e: globalThis.MouseEvent): void {
  if (!guards.length || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const anchor = (e.target as Element | null)?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
  const target = anchor?.getAttribute('href') ?? '';
  if (!anchor || anchor.target === '_blank' || target === location.hash) return;
  if (!confirmNavigation(target.slice(1))) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  approved = target;
  setTimeout(() => { approved = null; }, 0);
}

/**
 * While `dirty`, asks before leaving the page: closing or reloading the tab (beforeunload), in-app
 * link clicks and programmatic navigate() calls (⌘K, buttons). Used by the Studio editors and the
 * Settings forms.
 */
export function useUnsavedChangesGuard(dirty: boolean, message = 'You have unsaved changes. Leave without saving?'): void {
  const ref = useRef({ dirty, message });
  ref.current = { dirty, message };
  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!ref.current.dirty) return;
      e.preventDefault();
      e.returnValue = '';
    };
    const unregister = registerNavigationGuard(() => !ref.current.dirty || window.confirm(ref.current.message));
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);
}

/**
 * Navigates to an app path ("/projects/prj_1"). `replace` avoids a history entry (redirects, filters).
 * Registered guards are consulted first (an unsaved editor may cancel); `force` skips them — for a
 * caller that already confirmed, or that just saved and moves to the saved record.
 */
export function navigate(path: string, opts: { replace?: boolean; force?: boolean } = {}): void {
  const target = hashOf(path);
  if (target !== location.hash && !opts.force && approved !== target && !confirmNavigation(path)) return;
  approved = null;
  if (opts.replace) {
    history.replaceState(history.state, '', target);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (location.hash !== target) {
    location.hash = target;
  }
}

/** href for an app path, for real <a> elements (middle-click / open in new tab keep working). */
export function href(path: string): string {
  return `#${path}`;
}

function subscribe(cb: () => void): () => void {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

const getHash = () => location.hash;

/** Current route; re-renders on every hash change. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return parseRoute(hash);
}

/** True when `path` is the current route or one of its descendants (sidebar active state). */
export function isActivePath(current: string, path: string): boolean {
  if (path === '/') return current === '/';
  return current === path || current.startsWith(`${path}/`);
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

/** <a> to an app path. Plain clicks scroll the main pane to top; modified clicks behave natively. */
export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return createElement('a', { ...rest, href: href(to), onClick: handle });
}
