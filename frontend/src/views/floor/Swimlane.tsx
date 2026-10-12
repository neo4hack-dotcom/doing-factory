// One blueprint's swimlane: stage columns (WIP count, average time from the KPIs) holding project
// tokens, joined by animated dashed flow lines while work is moving, and a "Shipped" column for
// what completed recently. Tokens are keyed by project id, so a token that changes stage mounts in
// its new column with a slide-in.
import { CheckCircle2, ChevronRight, Clock, Hourglass } from 'lucide-react';
import { iconByName } from '../../components/StepIcon';
import { Badge, TONE, Tooltip, toneOf } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatHours, plural } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import type { Tone } from '../../types';
import { SHIPPED_WINDOW_DAYS, tokenState, type Lane, type LaneColumn } from './model';
import { Token } from './Token';

const MAX_SHIPPED = 6;

export function Swimlane({ lane, moved }: { lane: Lane; moved: ReadonlySet<string> }) {
  const bp = lane.blueprint;
  const Icon = iconByName(bp?.icon);
  const tone: Tone = bp ? toneOf(bp.color) : 'zinc';
  const flowing = lane.columns.some((c) => c.tokens.some((t) => tokenState(t) === 'running'));
  const waiting = lane.columns.reduce((n, c) => n + c.tokens.filter((t) => tokenState(t) === 'waiting').length, 0);
  const blocked = lane.columns.reduce((n, c) => n + c.tokens.filter((t) => tokenState(t) === 'blocked').length, 0);

  return (
    <section className="card overflow-hidden animate-fade-in">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b hairline px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={cls('grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE[tone].icon)}><Icon size={15} /></span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-bold text-zinc-900 dark:text-white">{lane.name}</h2>
            <p className="text-[11px] text-muted">
              <span className="num">{plural(lane.inFlight, 'project')}</span> in flight
              {lane.shipped.length > 0 && <> · <span className="num">{lane.shipped.length}</span> shipped this week</>}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {flowing && <Badge tone="brand" dot>AI working</Badge>}
          {waiting > 0 && <Badge tone="amber" dot><span className="num">{waiting}</span> waiting on people</Badge>}
          {blocked > 0 && <Badge tone="rose" dot><span className="num">{blocked}</span> blocked</Badge>}
          {bp && (
            <Link to={paths.projects({ blueprint_id: bp.id })} className="ml-1 inline-flex items-center gap-0.5 text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
              List <ChevronRight size={12} />
            </Link>
          )}
        </div>
      </header>

      <div className="grid-bg overflow-x-auto">
        <div className="flex min-w-max items-stretch p-3">
          {lane.columns.map((col, i) => (
            <div key={col.id} className="flex items-stretch">
              {i > 0 && <FlowLine active={flowing && (col.tokens.length > 0 || lane.columns[i - 1].tokens.length > 0)} />}
              <StageColumn col={col} moved={moved} />
            </div>
          ))}
          <FlowLine active={flowing} done />
          <ShippedColumn lane={lane} moved={moved} />
        </div>
      </div>
    </section>
  );
}

function StageColumn({ col, moved }: { col: LaneColumn; moved: ReadonlySet<string> }) {
  const tone = toneOf(col.color);
  const busy = col.tokens.length > 0;
  return (
    <div className={cls(
      'flex w-[228px] shrink-0 flex-col rounded-xl border transition-colors duration-500',
      busy ? 'surface-deep' : 'border-dashed border-zinc-200 bg-white/40 dark:border-ink-600 dark:bg-ink-900/40',
    )}>
      <div className="flex items-center justify-between gap-2 px-2.5 pb-1.5 pt-2">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={cls('h-2 w-2 shrink-0 rounded-full', col.color ? TONE[tone].dot : 'bg-brand-500')} />
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.1em] text-zinc-700 dark:text-zinc-200" title={col.name}>{col.name}</span>
        </span>
        <span className={cls(
          'num grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-[10px] font-bold transition-colors',
          busy ? 'bg-brand-500 text-white' : 'bg-zinc-200 text-zinc-500 dark:bg-ink-600 dark:text-zinc-400',
        )}>
          {col.tokens.length}
        </span>
      </div>
      <Tooltip
        content={col.avgHours === null ? 'No stage run finished in the last 30 days yet'
          : `Average time in this stage over the last 30 days${col.waitHours ? `, of which ${formatHours(col.waitHours)} waiting on people` : ''}`}
        className="px-2.5 pb-2"
      >
        <span className="flex items-center gap-2.5 text-[10.5px] text-muted">
          <span className="flex items-center gap-1"><Clock size={10} /> avg <span className="num font-semibold">{formatHours(col.avgHours)}</span></span>
          {!!col.waitHours && (
            <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400"><Hourglass size={10} /><span className="num">{formatHours(col.waitHours)}</span></span>
          )}
        </span>
      </Tooltip>
      <div className="flex max-h-[420px] min-h-[84px] flex-col gap-2 overflow-y-auto px-2 pb-2">
        {col.tokens.map((p) => <Token key={p.id} p={p} moved={moved.has(p.id)} />)}
        {!busy && <div className="flex flex-1 items-center justify-center text-[11px] text-faint">Clear</div>}
      </div>
    </div>
  );
}

function ShippedColumn({ lane, moved }: { lane: Lane; moved: ReadonlySet<string> }) {
  const shown = lane.shipped.slice(0, MAX_SHIPPED);
  const extra = lane.shipped.length - shown.length;
  return (
    <div className="flex w-[200px] shrink-0 flex-col rounded-xl border border-emerald-500/25 bg-emerald-50/60 dark:border-emerald-500/20 dark:bg-emerald-500/[0.04]">
      <div className="flex items-center justify-between gap-2 px-2.5 pb-2 pt-2">
        <Tooltip content={`Completed in the last ${SHIPPED_WINDOW_DAYS} days`}>
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 size={12} /> Shipped
          </span>
        </Tooltip>
        <span className="num grid h-5 min-w-5 place-items-center rounded-full bg-emerald-500 px-1.5 text-[10px] font-bold text-white">{lane.shipped.length}</span>
      </div>
      <div className="flex min-h-[84px] flex-col gap-1.5 px-2 pb-2">
        {shown.map((p) => <Token key={p.id} p={p} moved={moved.has(p.id)} compact />)}
        {extra > 0 && lane.blueprint && (
          <Link to={paths.projects({ blueprint_id: lane.blueprint.id, status: 'done' })} className="text-center text-[11px] font-semibold text-emerald-700 hover:underline dark:text-emerald-300">
            +{extra} more
          </Link>
        )}
        {shown.length === 0 && <div className="flex flex-1 items-center justify-center text-[11px] text-faint">Nothing this week</div>}
      </div>
    </div>
  );
}

/** Dashed connector between two columns; the dashes travel while the lane has running work. */
function FlowLine({ active, done }: { active: boolean; done?: boolean }) {
  return (
    <div className="flex w-7 shrink-0 items-center justify-center" aria-hidden>
      <svg width="28" height="12" viewBox="0 0 28 12" className="overflow-visible">
        <line
          x1="0" y1="6" x2="22" y2="6" strokeWidth="2" strokeDasharray="4 4" strokeLinecap="round"
          className={cls(
            active ? 'animate-flow' : '',
            done ? 'stroke-emerald-400/70' : active ? 'stroke-brand-500' : 'stroke-zinc-300 dark:stroke-ink-400',
          )}
        />
        <path d="M21 2 L26 6 L21 10" fill="none" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className={done ? 'stroke-emerald-400/70' : active ? 'stroke-brand-500' : 'stroke-zinc-300 dark:stroke-ink-400'} />
      </svg>
    </div>
  );
}
