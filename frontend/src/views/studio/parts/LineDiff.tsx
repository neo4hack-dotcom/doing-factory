// Minimal line diff (longest common subsequence) for "what did I change vs the default prompt".
import { cls } from '../../../components/ui';

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string };

/** LCS line diff. Prompts are short (≤ a few hundred lines), so O(n·m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    // Pathologically long: show as a full replacement rather than freezing the tab.
    return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  }
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ kind: 'del', text: a[i++] });
    else out.push({ kind: 'add', text: b[j++] });
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}

export function LineDiff({ before, after, className }: { before: string; after: string; className?: string }) {
  const lines = diffLines(before, after);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <div className={cls('overflow-hidden rounded-lg border hairline', className)}>
      <div className="flex items-center gap-3 border-b hairline bg-zinc-50 px-3 py-1.5 text-[11px] dark:bg-ink-900">
        <span className="label-xs">Default → current</span>
        <span className="num font-semibold text-emerald-600 dark:text-emerald-400">+{added}</span>
        <span className="num font-semibold text-rose-600 dark:text-rose-400">−{removed}</span>
        {!added && !removed && <span className="text-muted">Identical to the default</span>}
      </div>
      <pre className="max-h-[60vh] overflow-auto py-1 font-mono text-xs leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className={cls('flex whitespace-pre-wrap break-words px-3',
            l.kind === 'add' && 'bg-emerald-500/10 text-emerald-800 dark:text-emerald-200',
            l.kind === 'del' && 'bg-rose-500/10 text-rose-800 line-through decoration-rose-400/60 dark:text-rose-200',
            l.kind === 'same' && 'text-zinc-600 dark:text-zinc-400')}>
            <span className="w-4 shrink-0 select-none opacity-60">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="min-w-0 flex-1">{l.text || ' '}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}
