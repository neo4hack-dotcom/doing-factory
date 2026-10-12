// Formatting helpers. English only, en-GB dates ("11 Oct 2026"); timestamps arrive as ISO-8601 UTC.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Parses an ISO string (or epoch ms) into epoch ms; null for empty/invalid input. */
export function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** "just now", "3m ago", "3h ago", "2d ago", "in 4h" — falls back to a date past ~4 weeks. */
export function timeAgo(value: string | number | null | undefined, now: number = Date.now()): string {
  const ms = toMs(value);
  if (ms === null) return '—';
  const diff = now - ms;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  let label: string;
  if (abs < HOUR) label = `${Math.round(abs / MINUTE)}m`;
  else if (abs < DAY) label = `${Math.round(abs / HOUR)}h`;
  else if (abs < 28 * DAY) label = `${Math.round(abs / DAY)}d`;
  else return formatDate(ms);
  return diff >= 0 ? `${label} ago` : `in ${label}`;
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const DATE_SHORT_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const DATETIME_FMT = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
});
const TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** "11 Oct 2026" (or "11 Oct" when `short`). */
export function formatDate(value: string | number | null | undefined, short = false): string {
  const ms = toMs(value);
  if (ms === null) return '—';
  return (short ? DATE_SHORT_FMT : DATE_FMT).format(ms);
}

/** "11 Oct 2026, 14:03" in the viewer's local time. */
export function formatDateTime(value: string | number | null | undefined): string {
  const ms = toMs(value);
  return ms === null ? '—' : DATETIME_FMT.format(ms);
}

/** "14:03" in the viewer's local time. */
export function formatTime(value: string | number | null | undefined): string {
  const ms = toMs(value);
  return ms === null ? '—' : TIME_FMT.format(ms);
}

/** Duration in ms → "2d 4h", "3h 12m", "45m", "12s" (two most significant units). */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  const abs = Math.abs(ms);
  if (abs < 1000) return `${Math.round(abs)}ms`;
  if (abs < MINUTE) return `${Math.round(abs / 1000)}s`;
  const d = Math.floor(abs / DAY);
  const h = Math.floor((abs % DAY) / HOUR);
  const m = Math.floor((abs % HOUR) / MINUTE);
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

/** Hours (KPI unit) → "2d 4h" / "3h 30m"; null-safe. */
export function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return '—';
  return formatDuration(hours * HOUR);
}

/** Days (lead time) → "4.5 d"; null-safe. */
export function formatDays(days: number | null | undefined): string {
  if (days === null || days === undefined || !Number.isFinite(days)) return '—';
  return `${days < 10 ? Math.round(days * 10) / 10 : Math.round(days)} d`;
}

const INT_FMT = new Intl.NumberFormat('en-GB');

/** 1234 → "1,234"; fractional values keep one decimal. */
export function formatNumber(value: number | null | undefined, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return decimals > 0
    ? new Intl.NumberFormat('en-GB', { maximumFractionDigits: decimals }).format(value)
    : INT_FMT.format(Math.round(value));
}

/** Compact figure for tiles and axes: 1,284 / 12.9K / 4.2M. */
export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000)}K`;
  if (abs >= 1_000) return INT_FMT.format(Math.round(value));
  return `${Math.round(value * 10) / 10}`;
}

function trim(v: number): string {
  return (Math.round(v * 10) / 10).toString();
}

/** Ratio 0-1 → "42%" (pass `isRatio=false` when the value is already a percentage). */
export function formatPercent(value: number | null | undefined, isRatio = true, decimals = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const pct = isRatio ? value * 100 : value;
  const f = 10 ** decimals;
  return `${Math.round(pct * f) / f}%`;
}

/** Milliseconds as a latency: "840 ms" / "2.4 s". */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;
}

/** Due-date wording with urgency: {label: "due in 3d" | "overdue 2h" | "due today", overdue}. */
export function dueLabel(value: string | null | undefined, now: number = Date.now()): { label: string; overdue: boolean; soon: boolean } {
  const ms = toMs(value);
  if (ms === null) return { label: '', overdue: false, soon: false };
  const diff = ms - now;
  if (diff < 0) return { label: `overdue ${formatDuration(-diff).split(' ')[0]}`, overdue: true, soon: false };
  if (diff < HOUR) return { label: 'due within the hour', overdue: false, soon: true };
  return { label: `due in ${formatDuration(diff).split(' ')[0]}`, overdue: false, soon: diff < DAY };
}

/** "Alice Martin" → "AM"; single word → first two letters. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "1 project" / "3 projects" (pass an explicit plural for irregular words). */
export function plural(n: number, word: string, pluralWord?: string): string {
  return `${formatNumber(n)} ${n === 1 ? word : pluralWord ?? `${word}s`}`;
}

/** snake_case / dot.case key → "Sentence case" label ("waiting_approval" → "Waiting approval"). */
export function humanize(key: string): string {
  const s = key.replace(/[._]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** Bytes → "4.7 GB" (model sizes). */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : Math.round(v * 10) / 10} ${units[i]}`;
}

/** Truncates with an ellipsis at a word boundary when possible. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}…`;
}
