// Live step trace: the persisted `step.trace` plus `step.trace` WebSocket events streaming in while
// the step runs — agent thoughts, tool calls and results appear as they happen.
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TONE } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatTime, truncate } from '../../lib/format';
import { useLive } from '../../lib/store';
import type { StepRun, TraceEntry } from '../../types';
import { JsonBlock } from './common';
import { mergeTrace } from './logic';
import { TRACE_KIND } from './meta';

/** The step's trace, kept live: persisted entries + streamed ones not persisted yet. */
export function useLiveTrace(projectId: string, step: StepRun): TraceEntry[] {
  const [live, setLive] = useState<TraceEntry[]>([]);
  // A different step starts from its own persisted trace.
  useEffect(() => setLive([]), [projectId, step.id]);
  useLive('step.trace', (e) => {
    if (e.project_id !== projectId || e.step_id !== step.id || !e.entry) return;
    setLive((prev) => (prev.length >= 300 ? [...prev.slice(-299), e.entry] : [...prev, e.entry]));
  });
  return useMemo(() => mergeTrace(step.trace ?? [], live), [step.trace, live]);
}

export function TraceView({ entries, running, limit = 40, maxHeight = 'max-h-80', emptyLabel = 'No trace yet.' }: {
  entries: TraceEntry[];
  /** Shows the "working" pulse and follows new entries. */
  running?: boolean;
  /** Most recent entries shown before "Show all". */
  limit?: number;
  maxHeight?: string;
  emptyLabel?: string;
}) {
  const [all, setAll] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const shown = all ? entries : entries.slice(-limit);

  // Follow the stream like a terminal — unless the reader scrolled up to read something.
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length, running]);

  if (!entries.length && !running) return <p className="text-xs text-faint">{emptyLabel}</p>;

  return (
    <div
      ref={box}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
      className={cls('overflow-y-auto rounded-lg border hairline bg-zinc-50/70 p-1.5 dark:bg-ink-900/60', maxHeight)}
    >
      {entries.length > shown.length && (
        <button type="button" onClick={() => setAll(true)} className="mb-1 w-full rounded-md py-1 text-[11px] font-semibold text-brand-600 hover:bg-brand-500/5 dark:text-brand-400">
          Show {entries.length - shown.length} earlier entries
        </button>
      )}
      <ol className="space-y-0.5">
        {shown.map((e, i) => <TraceRow key={`${e.ts}-${i}`} entry={e} />)}
      </ol>
      {running && (
        <div className="flex items-center gap-2 px-2 py-1.5 text-[11px] font-medium text-sky-600 dark:text-sky-400">
          <span className="flex gap-0.5">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500 [animation-delay:150ms]" />
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-sky-500 [animation-delay:300ms]" />
          </span>
          Working…
        </div>
      )}
    </div>
  );
}

function TraceRow({ entry }: { entry: TraceEntry }) {
  const meta = TRACE_KIND[entry.kind] ?? TRACE_KIND.info;
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const hasData = entry.data !== undefined && entry.data !== null && !(typeof entry.data === 'object' && Object.keys(entry.data as object).length === 0);
  const text = entry.text ?? '';
  const long = text.length > 420;
  return (
    <li className="group rounded-md px-2 py-1 animate-fade-in hover:bg-white dark:hover:bg-ink-800">
      <div className="flex items-start gap-2">
        <Icon size={13} className={cls('mt-[3px] shrink-0', TONE[meta.tone].text)} aria-label={meta.label} />
        <div className="min-w-0 flex-1">
          <div className={cls(
            'whitespace-pre-wrap break-words text-xs leading-relaxed',
            entry.kind === 'thought' ? 'italic text-violet-800 dark:text-violet-200' : entry.kind === 'error' ? 'text-rose-700 dark:text-rose-300' : 'text-zinc-700 dark:text-zinc-300',
            entry.kind === 'tool' && 'font-mono text-[11.5px]',
          )}>
            {entry.agent && <span className="mr-1.5 rounded bg-zinc-200/70 px-1 py-px font-sans text-[10px] font-bold not-italic text-zinc-600 dark:bg-ink-600 dark:text-zinc-300">{entry.agent}</span>}
            {long && !full ? truncate(text, 420) : text}
            {long && (
              <button type="button" onClick={() => setFull((f) => !f)} className="ml-1 font-sans text-[11px] font-semibold not-italic text-brand-600 hover:underline dark:text-brand-400">
                {full ? 'less' : 'more'}
              </button>
            )}
          </div>
          {hasData && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 inline-flex items-center gap-0.5 text-[10.5px] font-semibold text-faint hover:text-zinc-600 dark:hover:text-zinc-300">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} details
            </button>
          )}
          {open && hasData && <JsonBlock value={entry.data} className="mt-1 max-h-56" />}
        </div>
        <time className="num mt-px shrink-0 text-[10px] text-faint opacity-0 transition-opacity group-hover:opacity-100" dateTime={entry.ts}>
          {formatTime(entry.ts)}
        </time>
      </div>
    </li>
  );
}
