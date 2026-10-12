// "Live AI workers" rail: a streaming ticker of LLM calls (role, model, latency, ok), agent trace
// entries (thoughts, tool calls, results) and audit activity. Seeded from the recent LLM-call log
// and audit events so it is never blank after a reload, then fed by the live socket.
import {
  Activity, AlertTriangle, Bot, Brain, Cpu, Info, Pause, Play, Sparkles, User as UserIcon, Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { IconButton, TONE } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatLatency, formatTime, humanize, truncate } from '../../lib/format';
import { navigate, paths } from '../../lib/router';
import type { Event, LLMCall, TraceEntry, TraceKind, Tone } from '../../types';

export type TickerKind = 'llm' | 'trace' | 'activity';

export interface TickerItem {
  id: string;
  ts: string;
  kind: TickerKind;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  detail: string;
  projectId: string;
  /** false = an error, shown in rose. */
  ok: boolean;
}

export const TICKER_MAX = 80;

const TRACE: Record<TraceKind, { icon: LucideIcon; tone: Tone; label: string }> = {
  thought: { icon: Brain, tone: 'violet', label: 'Thought' },
  tool: { icon: Wrench, tone: 'brand', label: 'Tool call' },
  result: { icon: Cpu, tone: 'teal', label: 'Result' },
  error: { icon: AlertTriangle, tone: 'rose', label: 'Error' },
  human: { icon: UserIcon, tone: 'sky', label: 'Human' },
  ai: { icon: Sparkles, tone: 'violet', label: 'AI' },
  info: { icon: Info, tone: 'zinc', label: 'Info' },
};

export function fromLlmCall(call: LLMCall): TickerItem {
  const tokens = call.tokens_in + call.tokens_out;
  return {
    id: `llm:${call.id}`, ts: call.ts, kind: 'llm', icon: Sparkles, tone: call.ok ? 'violet' : 'rose',
    title: humanize(call.role || 'llm'),
    detail: call.ok
      ? `${call.model} · ${formatLatency(call.latency_ms)}${tokens ? ` · ${tokens.toLocaleString()} tok` : ''}`
      : `${call.model} · ${truncate(call.error || 'failed', 90)}`,
    projectId: call.project_id, ok: call.ok,
  };
}

export function fromTrace(projectId: string, stepId: string, entry: TraceEntry, seq: number): TickerItem {
  const meta = TRACE[entry.kind] ?? TRACE.info;
  return {
    id: `trace:${projectId}:${stepId}:${entry.ts}:${seq}`, ts: entry.ts, kind: 'trace', icon: meta.icon, tone: meta.tone,
    title: `${entry.agent ? humanize(entry.agent) : meta.label}${entry.agent ? ` · ${meta.label.toLowerCase()}` : ''}`,
    detail: truncate(entry.text, 140), projectId, ok: entry.kind !== 'error',
  };
}

export function fromEvent(ev: Event): TickerItem {
  const failed = /fail|error|reject|block/i.test(ev.kind);
  const ai = ev.actor === 'ai';
  return {
    id: `ev:${ev.id}`, ts: ev.ts, kind: 'activity', icon: ai ? Bot : Activity,
    tone: failed ? 'rose' : ai ? 'violet' : ev.kind.startsWith('project.') ? 'brand' : 'sky',
    title: humanize(ev.kind.replace(/\./g, ' ')), detail: truncate(ev.message, 140), projectId: ev.project_id, ok: !failed,
  };
}

const FILTERS: { key: '' | TickerKind; label: string }[] = [
  { key: '', label: 'All' }, { key: 'llm', label: 'LLM' }, { key: 'trace', label: 'Agents' }, { key: 'activity', label: 'Activity' },
];

export function LiveTicker({ items, paused, onTogglePause, projectKey, live }: {
  items: TickerItem[];
  paused: boolean;
  onTogglePause: () => void;
  /** project id → key, for the chip on each line. */
  projectKey: (id: string) => string;
  live: boolean;
}) {
  const [filter, setFilter] = useState<'' | TickerKind>('');
  const shown = useMemo(() => (filter ? items.filter((i) => i.kind === filter) : items), [items, filter]);

  return (
    <aside className="card flex max-h-[calc(100vh-120px)] min-h-[320px] flex-col overflow-hidden xl:sticky xl:top-4">
      <div className="flex items-center justify-between gap-2 border-b hairline px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="relative flex h-2 w-2">
            {live && !paused && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-60" />}
            <span className={cls('relative inline-flex h-2 w-2 rounded-full', live ? 'bg-brand-500' : 'bg-zinc-400')} />
          </span>
          <h2 className="text-sm font-bold text-zinc-900 dark:text-white">Live AI workers</h2>
        </div>
        <IconButton icon={paused ? Play : Pause} label={paused ? 'Resume the feed' : 'Pause the feed'} size="xs" onClick={onTogglePause} active={paused} />
      </div>
      <div className="flex gap-1 border-b hairline px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={cls(
              'rounded-md px-2 py-0.5 text-[11px] font-semibold transition-colors',
              filter === f.key ? 'bg-brand-500 text-white' : 'text-muted hover:bg-zinc-100 dark:hover:bg-ink-600',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>
      <ol className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {shown.length === 0 && (
          <li className="flex flex-col items-center gap-1.5 px-4 py-10 text-center text-xs text-muted">
            <Cpu size={18} className="text-faint" />
            Quiet for now. LLM calls, agent steps and activity stream here as the engine works.
          </li>
        )}
        {shown.map((it) => {
          const key = it.projectId ? projectKey(it.projectId) : '';
          const Icon = it.icon;
          return (
            <li key={it.id} className="animate-slide-up">
              <button
                type="button"
                disabled={!it.projectId}
                onClick={() => it.projectId && navigate(paths.project(it.projectId))}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-zinc-100 disabled:cursor-default dark:enabled:hover:bg-ink-700"
              >
                <span className={cls('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md', TONE[it.tone].icon)}>
                  <Icon size={12} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className={cls('truncate text-[12px] font-semibold', it.ok ? 'text-zinc-800 dark:text-zinc-100' : 'text-rose-600 dark:text-rose-400')}>{it.title}</span>
                    {key && <span className="num shrink-0 rounded bg-zinc-100 px-1 text-[9.5px] font-bold text-zinc-500 dark:bg-ink-600 dark:text-zinc-400">{key}</span>}
                    <span className="num ml-auto shrink-0 text-[10px] text-faint">{formatTime(it.ts)}</span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block break-words text-[11px] leading-snug text-muted">{it.detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
