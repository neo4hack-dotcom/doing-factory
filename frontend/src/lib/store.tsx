// App-wide state (React Context, no state library): bootstrap reference data, the "acting as"
// persona, theme, the live WebSocket and the inbox counters that drive sidebar badges.
//
// Reference data (users, teams, blueprints…) is small and changes rarely, so it is loaded once from
// GET /api/bootstrap and reloaded on `settings.updated` or after a WebSocket reconnect (events sent
// while we were offline are lost — the bus is live-only). Views own their own heavy data (projects,
// inbox items) and refresh it through `useLive()`.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage, setActingUser } from '../api';
import type {
  AppSettings, Blueprint, Connector, InboxCounts, Onboarding, Operation, RoleDef, Team, User,
} from '../types';
import { connectWS } from '../ws';
import type { WsEvent, WsEventOf, WsEventType, WsStatus } from '../ws';
import { readStorage, STORAGE_KEYS, writeStorage } from './storage';

export type Theme = 'light' | 'dark';
export type LoadStatus = 'loading' | 'ready' | 'error';

const EMPTY_COUNTS: InboxCounts = { total: 0, approvals: 0, forms: 0, reviews: 0, failures: 0, intake: 0 };

/** Events after which the persona's inbox counters may have changed. */
const COUNT_EVENTS = new Set<WsEventType>(['project.updated', 'project.deleted', 'notification', 'intake.updated']);

export interface CopilotState {
  open: boolean;
  /** Question to send as soon as the drawer opens ('' = just open). */
  question: string;
  /** Project the conversation is about ('' = whole portfolio). */
  projectId: string;
}

export interface AppContextValue {
  status: LoadStatus;
  /** Bootstrap error message when status === 'error'. */
  error: string;
  settings: AppSettings | null;
  users: User[];
  teams: Team[];
  roles: RoleDef[];
  blueprints: Blueprint[];
  connectors: Connector[];
  operations: Operation[];
  onboarding: Onboarding | null;
  /** Re-fetches /api/bootstrap (reference data + settings). */
  reload: () => Promise<void>;

  /** Current persona id ('' when no user exists yet). Sent as `user_id` on every mutation. */
  userId: string;
  me: User | null;
  isAdmin: boolean;
  setUserId: (id: string) => void;

  theme: Theme;
  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;

  live: WsStatus;
  /** Low-level subscription to every WS event; prefer the `useLive()` hook. */
  subscribe: (listener: (event: WsEvent) => void) => () => void;

  counts: InboxCounts;
  refreshCounts: () => void;

  userById: (id: string | null | undefined) => User | undefined;
  teamById: (id: string | null | undefined) => Team | undefined;
  roleByKey: (key: string | null | undefined) => RoleDef | undefined;
  blueprintById: (id: string | null | undefined) => Blueprint | undefined;
  connectorById: (id: string | null | undefined) => Connector | undefined;

  copilot: CopilotState;
  openCopilot: (opts?: { question?: string; projectId?: string }) => void;
  closeCopilot: () => void;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Default persona: the first active admin, else the first active user, else anyone. */
export function defaultPersona(users: User[]): string {
  const active = users.filter((u) => u.active);
  return (active.find((u) => u.roles.includes('admin')) ?? active[0] ?? users[0])?.id ?? '';
}

function initialTheme(): Theme {
  const saved = readStorage(STORAGE_KEYS.theme);
  if (saved === 'dark' || saved === 'light') return saved;
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

function byId<T extends { id: string }>(items: T[]): Map<string, T> {
  return new Map(items.map((x) => [x.id, x]));
}

interface BootData {
  settings: AppSettings | null;
  users: User[];
  teams: Team[];
  roles: RoleDef[];
  blueprints: Blueprint[];
  connectors: Connector[];
  operations: Operation[];
  onboarding: Onboarding | null;
}

const EMPTY_BOOT: BootData = {
  settings: null, users: [], teams: [], roles: [], blueprints: [], connectors: [], operations: [], onboarding: null,
};

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<LoadStatus>('loading');
  const [error, setError] = useState('');
  const [data, setData] = useState<BootData>(EMPTY_BOOT);
  const [storedPersona, setStoredPersona] = useState(() => readStorage(STORAGE_KEYS.persona) ?? '');
  const [theme, setThemeState] = useState<Theme>(initialTheme);
  const [live, setLive] = useState<WsStatus>('connecting');
  const [counts, setCounts] = useState<InboxCounts>(EMPTY_COUNTS);
  const [copilot, setCopilot] = useState<CopilotState>({ open: false, question: '', projectId: '' });

  // ---- Bootstrap ------------------------------------------------------------------------------
  const reload = useCallback(async () => {
    try {
      const boot = await api.bootstrap();
      setData({
        settings: boot.settings,
        users: boot.users ?? [],
        teams: boot.teams ?? [],
        roles: boot.roles ?? [],
        blueprints: boot.blueprints ?? [],
        connectors: boot.connectors ?? [],
        operations: boot.operations ?? [],
        onboarding: boot.onboarding ?? null,
      });
      setError('');
      setStatus('ready');
    } catch (err) {
      setError(errorMessage(err));
      // Keep showing stale data after a transient failure; only a first load turns into an error page.
      setStatus((s) => (s === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // ---- Persona --------------------------------------------------------------------------------
  const userMap = useMemo(() => byId(data.users), [data.users]);
  // A stored id that no longer exists (user deleted, database reset) falls back to the default.
  const userId = userMap.has(storedPersona) ? storedPersona : defaultPersona(data.users);
  const me = userMap.get(userId) ?? null;

  const setUserId = useCallback((id: string) => {
    writeStorage(STORAGE_KEYS.persona, id);
    setStoredPersona(id);
  }, []);

  // Mutations are attributed to the persona without every call site passing it (see api.ts).
  useEffect(() => setActingUser(userId), [userId]);

  // ---- Theme ----------------------------------------------------------------------------------
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);
  const setTheme = useCallback((t: Theme) => {
    writeStorage(STORAGE_KEYS.theme, t);
    setThemeState(t);
  }, []);
  const toggleTheme = useCallback(() => setTheme(theme === 'dark' ? 'light' : 'dark'), [theme, setTheme]);

  // ---- Inbox counters -------------------------------------------------------------------------
  const userIdRef = useRef(userId);
  userIdRef.current = userId;
  const countsTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchCounts = useCallback(async () => {
    const uid = userIdRef.current;
    if (!uid) {
      setCounts(EMPTY_COUNTS);
      return;
    }
    try {
      const next = await api.inbox.counts(uid);
      if (uid === userIdRef.current) setCounts(next);
    } catch {
      /* badges are a convenience: a failed refresh keeps the previous numbers */
    }
  }, []);

  /** Debounced: a burst of project.updated events costs one request. */
  const refreshCounts = useCallback(() => {
    clearTimeout(countsTimer.current);
    countsTimer.current = setTimeout(() => void fetchCounts(), 350);
  }, [fetchCounts]);

  useEffect(() => {
    if (status === 'ready') void fetchCounts();
  }, [status, userId, fetchCounts]);

  useEffect(() => () => clearTimeout(countsTimer.current), []);

  // ---- Live events ----------------------------------------------------------------------------
  const listeners = useRef(new Set<(e: WsEvent) => void>());
  const subscribe = useCallback((listener: (e: WsEvent) => void) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    // Events are queued and flushed once per frame: a busy agent can emit dozens of trace events
    // per second, and one render per frame is all the eye can see anyway.
    let queue: WsEvent[] = [];
    let scheduled = false;
    let everOpen = false;
    const flush = () => {
      scheduled = false;
      const batch = queue;
      queue = [];
      for (const ev of batch) {
        if (ev.type === 'settings.updated' || ev.type === 'reference.updated') void reload();
        if (COUNT_EVENTS.has(ev.type)) refreshCounts();
        listeners.current.forEach((l) => {
          try {
            l(ev);
          } catch (err) {
            console.error('Live event handler failed', ev.type, err);
          }
        });
      }
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      // rAF does not fire in background tabs; a timer keeps the queue from growing unbounded there.
      if (document.visibilityState === 'visible') requestAnimationFrame(flush);
      else setTimeout(flush, 250);
    };
    return connectWS({
      onEvent: (ev) => {
        queue.push(ev);
        schedule();
      },
      onStatus: (s) => {
        setLive(s);
        if (s === 'open') {
          // Anything emitted while we were disconnected is gone: resync from REST.
          if (everOpen) {
            void reload();
            refreshCounts();
          }
          everOpen = true;
        }
      },
    });
  }, [reload, refreshCounts]);

  // ---- Lookups --------------------------------------------------------------------------------
  const teamMap = useMemo(() => byId(data.teams), [data.teams]);
  const blueprintMap = useMemo(() => byId(data.blueprints), [data.blueprints]);
  const connectorMap = useMemo(() => byId(data.connectors), [data.connectors]);
  const roleMap = useMemo(() => new Map(data.roles.map((r) => [r.key, r])), [data.roles]);

  const openCopilot = useCallback((opts: { question?: string; projectId?: string } = {}) => {
    setCopilot({ open: true, question: opts.question ?? '', projectId: opts.projectId ?? '' });
  }, []);
  const closeCopilot = useCallback(() => setCopilot((c) => ({ ...c, open: false, question: '' })), []);

  const value = useMemo<AppContextValue>(() => ({
    status, error, ...data, reload,
    userId, me, isAdmin: !!me?.roles.includes('admin'), setUserId,
    theme, setTheme, toggleTheme,
    live, subscribe,
    counts, refreshCounts,
    userById: (id) => (id ? userMap.get(id) : undefined),
    teamById: (id) => (id ? teamMap.get(id) : undefined),
    roleByKey: (key) => (key ? roleMap.get(key) : undefined),
    blueprintById: (id) => (id ? blueprintMap.get(id) : undefined),
    connectorById: (id) => (id ? connectorMap.get(id) : undefined),
    copilot, openCopilot, closeCopilot,
  }), [
    status, error, data, reload, userId, me, setUserId, theme, setTheme, toggleTheme, live, subscribe,
    counts, refreshCounts, userMap, teamMap, roleMap, blueprintMap, connectorMap, copilot, openCopilot,
    closeCopilot,
  ]);

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

/** The app context; throws outside <AppProvider> (a wiring bug, not a runtime condition). */
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp() must be used inside <AppProvider>');
  return ctx;
}

/**
 * Runs `handler` for every live event of `type` ('*' = all) while the component is mounted.
 * The handler may change every render (it is read from a ref), so inline closures are fine.
 *
 *   useLive('project.updated', (e) => { if (e.project_id === id) reload(); });
 */
export function useLive<T extends WsEventType>(type: T, handler: (event: WsEventOf<T>) => void): void;
export function useLive(type: '*', handler: (event: WsEvent) => void): void;
export function useLive(type: string, handler: (event: never) => void): void {
  const { subscribe } = useApp();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () => subscribe((ev) => {
      if (type === '*' || ev.type === type) (ref.current as (e: WsEvent) => void)(ev);
    }),
    [subscribe, type],
  );
}
