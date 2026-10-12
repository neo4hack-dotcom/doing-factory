// Readable renderings of arbitrary step outputs and project vars: a syntax-highlighted JSON viewer
// (React elements only, no innerHTML) and `VarValue`, which picks the friendliest form for a value —
// Markdown for `{markdown}`, chips for string lists, a table for lists of records, key/value rows
// for objects — and falls back to JSON when the shape is deeper than a person wants to read.
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { CopyButton } from '../../components/ui';
import { cls } from '../../lib/cls';
import { humanize, truncate } from '../../lib/format';

/** JSON.stringify that never throws (undefined → "null", bigint → string). */
export function toJson(value: unknown, indent = 2): string {
  try {
    const out = JSON.stringify(value === undefined ? null : value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), indent);
    return out ?? 'null';
  } catch {
    return String(value);
  }
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** Splits pretty JSON into coloured spans. Exported for tests. */
export function highlightJson(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of text.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    let color = '';
    if (m[1] !== undefined) color = m[2] ? 'text-sky-700 dark:text-sky-300' : 'text-emerald-700 dark:text-emerald-300';
    else if (m[3] !== undefined) color = 'text-violet-600 dark:text-violet-300';
    else color = 'text-amber-700 dark:text-amber-300';
    out.push(<span key={i++} className={color}>{m[1] !== undefined ? m[1] : m[0]}</span>);
    if (m[2]) out.push(m[2]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function JsonView({ value, text, collapsedLines = 22, className, copy = true }: {
  value?: unknown;
  /** Already-serialised JSON (artifact content), pretty-printed when it parses. */
  text?: string;
  collapsedLines?: number;
  className?: string;
  copy?: boolean;
}) {
  const json = useMemo(() => {
    if (text === undefined) return toJson(value);
    try {
      return toJson(JSON.parse(text));
    } catch {
      return text;
    }
  }, [value, text]);
  const lines = json.split('\n');
  const [expanded, setExpanded] = useState(false);
  const long = lines.length > collapsedLines;
  const shown = long && !expanded ? lines.slice(0, collapsedLines).join('\n') : json;
  return (
    <div className={cls('group relative min-w-0 rounded-lg border surface-deep', className)}>
      {copy && (
        <div className="absolute right-1.5 top-1.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <CopyButton text={json} size="xs" variant="outline" className="bg-white dark:bg-ink-800" />
        </div>
      )}
      <pre className="scroll-thin overflow-x-auto px-3 py-2.5 font-mono text-[12px] leading-relaxed text-zinc-700 dark:text-zinc-300">
        {highlightJson(shown)}
        {long && !expanded && <span className="text-faint">{'\n'}…</span>}
      </pre>
      {long && (
        <button type="button" onClick={() => setExpanded((e) => !e)}
          className="flex w-full items-center justify-center gap-1 border-t hairline py-1.5 text-[11px] font-semibold text-brand-600 hover:bg-zinc-100 dark:text-brand-400 dark:hover:bg-ink-700">
          {expanded ? <><ChevronUp size={12} /> Collapse</> : <><ChevronDown size={12} /> Show all {lines.length} lines</>}
        </button>
      )}
    </div>
  );
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Plain text vs Markdown: headings, lists, emphasis, tables or several paragraphs. */
export function looksLikeMarkdown(s: string): boolean {
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.*\|)|\*\*[^*]+\*\*|```/.test(s) || /\n\s*\n/.test(s);
}

function Scalar({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-faint">—</span>;
  if (typeof value === 'boolean') return <span className={value ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-500'}>{value ? 'Yes' : 'No'}</span>;
  if (typeof value === 'number') return <span className="num">{value}</span>;
  const s = String(value);
  if (/^https?:\/\/\S+$/.test(s)) {
    return <a href={s} target="_blank" rel="noopener noreferrer" className="break-all font-medium text-brand-600 hover:underline dark:text-brand-400">{s}</a>;
  }
  return <span className="whitespace-pre-wrap break-words">{s}</span>;
}

/** Friendliest rendering of a var / output value (see file header). */
export function VarValue({ value, depth = 0, compact }: { value: unknown; depth?: number; compact?: boolean }) {
  if (isScalar(value) || value === undefined) {
    if (typeof value === 'string' && value.length > 80 && looksLikeMarkdown(value)) return <Markdown content={value} size="xs" />;
    return <div className="text-sm text-zinc-800 dark:text-zinc-200"><Scalar value={value} /></div>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-xs text-faint">Empty list</span>;
    if (value.every(isScalar)) {
      return (
        <div className="flex flex-wrap gap-1">
          {value.map((v, i) => (
            <span key={i} className="rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-ink-600 dark:text-zinc-200">{String(v)}</span>
          ))}
        </div>
      );
    }
    if (value.every(isRecord) && depth < 2) return <RecordTable rows={value as Record<string, unknown>[]} compact={compact} />;
    return <JsonView value={value} collapsedLines={14} />;
  }

  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (typeof value.markdown === 'string' && entries.length <= 2) return <Markdown content={value.markdown} size="xs" />;
    if (entries.length === 0) return <span className="text-xs text-faint">Empty</span>;
    if (depth >= 2) return <JsonView value={value} collapsedLines={12} />;
    return (
      <dl className={cls('grid gap-x-4', compact ? 'gap-y-1.5' : 'gap-y-2.5', 'sm:grid-cols-[minmax(110px,auto)_1fr]')}>
        {entries.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="label-xs pt-0.5">{humanize(k)}</dt>
            <dd className="min-w-0"><VarValue value={v} depth={depth + 1} compact /></dd>
          </div>
        ))}
      </dl>
    );
  }
  return <JsonView value={value} />;
}

function RecordTable({ rows, compact }: { rows: Record<string, unknown>[]; compact?: boolean }) {
  const columns: string[] = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!columns.includes(k)) columns.push(k);
  const shown = columns.slice(0, 6);
  const cell = (v: unknown) => {
    if (isScalar(v)) {
      if (typeof v === 'boolean') return v ? '✓' : '—';
      return v === null || v === '' ? '—' : truncate(String(v), 120);
    }
    return truncate(toJson(v, 0), 80);
  };
  return (
    <div className="scroll-thin overflow-x-auto rounded-lg border hairline">
      <table className="w-full text-xs">
        <thead className="bg-zinc-50 dark:bg-ink-900/50">
          <tr>{shown.map((c) => <th key={c} className="label-xs whitespace-nowrap px-2.5 py-1.5 text-left">{humanize(c)}</th>)}</tr>
        </thead>
        <tbody>
          {rows.slice(0, compact ? 12 : 50).map((r, i) => (
            <tr key={i} className="border-t hairline align-top">
              {shown.map((c) => <td key={c} className="px-2.5 py-1.5 text-zinc-700 dark:text-zinc-300">{cell(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {(columns.length > shown.length || rows.length > (compact ? 12 : 50)) && (
        <p className="border-t hairline px-2.5 py-1 text-[10px] text-faint">
          {rows.length} rows{columns.length > shown.length ? ` · ${columns.length - shown.length} more columns in the raw JSON` : ''}
        </p>
      )}
    </div>
  );
}
