// ⌘K palette: jump anywhere, find a project by key or title, run quick actions — or hand the query
// to the copilot. Everything is one keystroke list (↑ ↓ Enter, Esc closes).
import {
  Bot, CornerDownLeft, FolderKanban, Moon, Plug, Plus, Search, Sparkles, Sun, UserRound,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { cls } from '../lib/cls';
import { NAV_ITEMS, SETTINGS_NAV } from '../lib/nav';
import { navigate, paths } from '../lib/router';
import { useApp } from '../lib/store';
import type { ProjectSummary } from '../types';
import { Kbd, Spinner, StatusBadge, useEscapeLayer, useToast } from './ui';

interface PaletteItem {
  id: string;
  group: string;
  label: string;
  sub?: string;
  icon: LucideIcon;
  /** Extra words the filter matches on. */
  keywords?: string;
  run: () => void | Promise<void>;
  trailing?: ReactNode;
}

const MAX_RESULTS = 16;

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const app = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  useEscapeLayer(open, onClose);

  useEffect(() => {
    if (!open) return;
    setQ('');
    setSel(0);
    setProjects([]);
    setSearchError('');
  }, [open]);

  // Server-side project search, debounced; stale responses are ignored.
  useEffect(() => {
    if (!open) return;
    const term = q.trim();
    if (!term) {
      setProjects([]);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const t = setTimeout(() => {
      api.projects.list({ q: term })
        .then((res) => {
          if (cancelled) return;
          setProjects(res.slice(0, 8));
          setSearchError('');
        })
        .catch((err) => !cancelled && setSearchError(errorMessage(err)))
        .finally(() => !cancelled && setSearching(false));
    }, 180);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open]);

  const items = useMemo<PaletteItem[]>(() => {
    const term = q.trim();
    const actions: PaletteItem[] = [];
    actions.push(
      { id: 'new', group: 'Actions', label: 'New project', icon: Plus, keywords: 'create start', run: () => navigate(paths.newProject()) },
      ...app.blueprints.filter((b) => b.status === 'active').map((b) => ({
        id: `new-${b.id}`, group: 'Actions', label: `New project · ${b.name}`, sub: b.key_prefix, icon: Plus,
        keywords: `create start blueprint ${b.key}`, run: () => navigate(paths.newProject(b.id)),
      })),
      {
        id: 'theme', group: 'Actions', label: app.theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme',
        icon: app.theme === 'dark' ? Sun : Moon, keywords: 'theme dark light mode', run: app.toggleTheme,
      },
    );
    const connectorsPath = paths.settings('connectors');
    if (!app.onboarding?.has_portfolio) {
      actions.push({
        id: 'connect-doing', group: 'Actions', label: 'Connect your DOINg.AI', icon: Plug,
        keywords: 'setup connector portfolio doing.ai mcp', run: () => navigate(`${connectorsPath}?add=doing_ai`),
      });
    }
    if (!app.onboarding?.has_jira) {
      actions.push({
        id: 'connect-jira', group: 'Actions', label: 'Connect Jira', icon: Plug,
        keywords: 'setup connector jira atlassian mcp-atlassian', run: () => navigate(`${connectorsPath}?add=jira`),
      });
    }

    const nav: PaletteItem[] = [
      ...NAV_ITEMS.map((n) => ({ id: `nav-${n.path}`, group: 'Go to', label: n.label, icon: n.icon, keywords: n.keywords, run: () => navigate(n.path) })),
      ...SETTINGS_NAV.map((s) => ({ id: `set-${s.key}`, group: 'Settings', label: `Settings › ${s.label}`, icon: s.icon, keywords: 'settings configure', run: () => navigate(paths.settings(s.key)) })),
    ];

    const people: PaletteItem[] = term
      ? app.users.filter((u) => u.active && u.id !== app.userId).map((u) => ({
        id: `as-${u.id}`, group: 'Act as', label: `Act as ${u.name}`, sub: u.title, icon: UserRound,
        keywords: `persona switch ${u.email} ${u.roles.join(' ')}`,
        run: () => {
          app.setUserId(u.id);
          toast.info(`Now acting as ${u.name}`);
        },
      }))
      : [];

    const found: PaletteItem[] = projects.map((p) => ({
      id: `p-${p.id}`, group: 'Projects', label: `${p.key} · ${p.title}`, sub: p.current_stage_name, icon: FolderKanban,
      keywords: `${p.blueprint_name} ${p.tags.join(' ')}`,
      trailing: <StatusBadge kind="project" value={p.status} size="xs" />,
      run: () => navigate(paths.project(p.id)),
    }));

    if (!term) return [...actions.filter((a) => a.id === 'new' || a.id.startsWith('connect-')), ...nav.filter((n) => n.group === 'Go to')];
    const t = term.toLowerCase();
    const match = (i: PaletteItem) => `${i.label} ${i.sub ?? ''} ${i.keywords ?? ''}`.toLowerCase().includes(t);
    // Server results are already filtered (key, title, tags…); local items filter on their text.
    const hits = [...actions.filter(match), ...found, ...nav.filter(match), ...people.filter(match)];
    // "Ask" is always offered but comes last: Enter runs the best concrete match, and falls through
    // to the copilot only when nothing else matches.
    const ask: PaletteItem = {
      id: 'ask', group: 'Ask', label: `Ask Factory: “${term}”`, icon: Bot,
      run: () => app.openCopilot({ question: term }),
    };
    return [...hits.slice(0, MAX_RESULTS - 1), ask];
  }, [q, app, projects, toast]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${sel}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!open) return null;

  const runItem = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    void item.run();
  };

  const groups: Array<[string, Array<{ item: PaletteItem; idx: number }>]> = [];
  items.forEach((item, idx) => {
    const g = groups.find(([name]) => name === item.group);
    if (g) g[1].push({ item, idx });
    else groups.push([item.group, [{ item, idx }]]);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink-950/50 px-4 pt-[12vh] backdrop-blur-sm animate-fade-in" onMouseDown={onClose}>
      <div className="card w-full max-w-xl overflow-hidden shadow-pop animate-scale-in" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2.5 border-b hairline px-4">
          <Search size={17} className="shrink-0 text-brand-500" />
          {/* autoFocus (on mount, i.e. on open) rather than a deferred focus: keys typed right after ⌘K land here. */}
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects, jump to a view, or ask the Factory…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runItem(items[sel]);
              }
            }}
          />
          {searching ? <Spinner size={15} /> : <Kbd>esc</Kbd>}
        </div>
        <div ref={listRef} className="max-h-[56vh] overflow-y-auto p-2">
          {items.length === 0 && (
            <div className="px-3 py-8 text-center text-sm text-faint">{searching ? 'Searching…' : 'No results'}</div>
          )}
          {searchError && q.trim() && (
            <div className="mx-1 mb-1 rounded-md bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-600 dark:text-rose-400">Project search unavailable — {searchError}</div>
          )}
          {groups.map(([group, rows]) => (
            <div key={group} className="mb-1">
              <div className="label-xs px-2.5 pb-1 pt-2">{group}</div>
              {rows.map(({ item, idx }) => {
                const Icon = item.icon;
                const active = idx === sel;
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-idx={idx}
                    onMouseMove={() => setSel(idx)}
                    onClick={() => runItem(item)}
                    className={cls(
                      'flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition-colors',
                      active ? 'bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'text-zinc-700 dark:text-zinc-300',
                    )}
                  >
                    <Icon size={16} className={cls('shrink-0', item.id === 'ask' ? 'text-brand-500' : 'opacity-70')} />
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    {item.sub && <span className="max-w-[40%] shrink-0 truncate text-xs text-faint">{item.sub}</span>}
                    {item.trailing}
                    {active && <CornerDownLeft size={13} className="shrink-0 text-zinc-400" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="flex items-center gap-3 border-t hairline px-4 py-2 text-[11px] text-faint">
          <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> move</span>
          <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd> open</span>
          <span className="ml-auto inline-flex items-center gap-1"><Sparkles size={12} className="text-brand-500" /> Type a question to ask the copilot</span>
        </div>
      </div>
    </div>
  );
}
