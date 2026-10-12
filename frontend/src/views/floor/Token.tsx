// A project "token" on the Factory Floor: key, short title, progress ring, state colour, risk dot
// and owner. Running work wears the animated AI gradient border, work waiting on a person pulses
// amber, blocked work turns rose — the floor reads at a glance from across the room.
import { Avatar, Tooltip } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatPercent, timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { ProjectSummary } from '../../types';
import { TOKEN_STATE_LABEL, tokenState, type TokenState } from './model';

const RING_STROKE: Record<TokenState, string> = {
  blocked: 'stroke-rose-500',
  waiting: 'stroke-amber-500',
  running: 'stroke-brand-500',
  external: 'stroke-teal-500',
  idle: 'stroke-zinc-400',
  done: 'stroke-emerald-500',
};

/** Circular 0-1 progress with the percentage inside. */
export function ProgressRing({ value, state, size = 30 }: { value: number; state: TokenState; size?: number }) {
  const r = (size - 4) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  return (
    <span className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} className="stroke-zinc-200 dark:stroke-ink-500" />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={3} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v)}
          className={cls('transition-[stroke-dashoffset] duration-700 ease-out', RING_STROKE[state])}
        />
      </svg>
      <span className="num absolute text-[9px] font-bold text-zinc-600 dark:text-zinc-300">{Math.round(v * 100)}</span>
    </span>
  );
}

const RISK_DOT = { low: 'bg-emerald-500', medium: 'bg-amber-500', high: 'bg-rose-500' } as const;

export function Token({ p, moved, compact }: { p: ProjectSummary; moved?: boolean; compact?: boolean }) {
  const { userById } = useApp();
  const state = tokenState(p);
  const owner = userById(p.owner_id) ?? userById(p.sponsor_id);
  const openStep = p.open_step_names[0];
  const risk = p.risk.level !== 'low' && state !== 'done'
    ? ` · ${p.risk.level === 'high' ? 'High' : 'Medium'} risk${p.risk.reasons[0] ? ` (${p.risk.reasons[0]})` : ''}` : '';
  const tip = `${TOKEN_STATE_LABEL[state]}${openStep ? ` · ${openStep}` : ''} · ${formatPercent(p.progress)} done${risk} · updated ${timeAgo(p.updated_at)}`;

  const body = (
    <div
      className={cls(
        'relative flex items-start gap-2 rounded-[10px] bg-white p-2 dark:bg-ink-800',
        state === 'blocked' && 'bg-rose-50 dark:bg-rose-500/[0.07]',
        state === 'done' && 'opacity-80',
      )}
    >
      <ProgressRing value={state === 'done' ? 1 : p.progress} state={state} size={compact ? 24 : 30} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="num truncate text-[10px] font-bold tracking-wide text-muted">{p.key}</span>
          {p.risk.level !== 'low' && state !== 'done' && (
            <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', RISK_DOT[p.risk.level])} aria-label={`${p.risk.level} risk`} />
          )}
          {p.parent_id && <span className="text-[9px] font-semibold uppercase tracking-wider text-indigo-500">child</span>}
        </div>
        <div className={cls('font-semibold leading-snug text-zinc-900 dark:text-zinc-100', compact ? 'truncate text-xs' : 'line-clamp-2 text-[12.5px]')}>
          {p.title}
        </div>
        {!compact && openStep && (
          <div className={cls(
            'mt-1 truncate text-[10.5px] font-medium',
            state === 'blocked' ? 'text-rose-600 dark:text-rose-400'
              : state === 'waiting' ? 'text-amber-600 dark:text-amber-400'
                : state === 'running' ? 'text-brand-600 dark:text-brand-400' : 'text-muted',
          )}>
            {state === 'running' && <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-brand-500 align-middle" />}
            {openStep}
            {p.open_step_names.length > 1 && <span className="text-faint"> +{p.open_step_names.length - 1}</span>}
          </div>
        )}
      </div>
      {owner && !compact && <Avatar user={owner} size={20} className="mt-0.5" />}
    </div>
  );

  return (
    <Tooltip content={tip} className="block w-full">
      <Link
        to={paths.project(p.id)}
        aria-label={`${p.key} ${p.title} — ${TOKEN_STATE_LABEL[state]}`}
        className={cls(
          'group relative block w-full rounded-xl p-[1.5px] transition-all duration-300 hover:-translate-y-0.5 hover:shadow-pop',
          moved ? 'animate-slide-up' : 'animate-fade-in',
          state === 'running' && 'animate-gradient-x bg-gradient-to-r from-brand-500 via-teal-400 to-amber-400 bg-[length:200%_200%] shadow-brand',
          state === 'waiting' && 'bg-amber-400/70 dark:bg-amber-500/60',
          state === 'blocked' && 'bg-rose-400/80 dark:bg-rose-500/70',
          (state === 'idle' || state === 'external' || state === 'done') && 'bg-zinc-200 dark:bg-ink-500',
          moved && 'ring-2 ring-brand-500/50 ring-offset-2 ring-offset-zinc-50 dark:ring-offset-ink-900',
        )}
      >
        {state === 'waiting' && (
          <span className="pointer-events-none absolute -inset-[3px] animate-pulse-slow rounded-[14px] ring-2 ring-amber-400/50" aria-hidden />
        )}
        {body}
        {state === 'running' && (
          <span className="pointer-events-none absolute inset-[1.5px] overflow-hidden rounded-[10px]" aria-hidden>
            <span className="shimmer absolute inset-0 bg-transparent opacity-40 dark:bg-transparent" />
          </span>
        )}
      </Link>
    </Tooltip>
  );
}
