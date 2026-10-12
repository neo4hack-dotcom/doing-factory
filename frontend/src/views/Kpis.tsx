// KPIs (#/kpis): delivery analytics over a 7/30/90-day window — every figure comes from GET /kpis,
// which derives it from real projects, audit events, the LLM-call log and the intake queue. A null
// figure (no data behind it) shows "—": nothing here is estimated or padded. The "AI insights"
// buttons hand a crafted question to the copilot, which answers from the same KPIs.
import {
  AlarmClock, Bot, Brain, CheckCheck, ChartColumn, Download, FileText, Gauge as GaugeIcon, Hourglass, Inbox,
  Layers, Printer, RefreshCw, ShieldCheck, Sparkles, Stamp, Ticket, Timer, TrendingUp, Users, Zap,
  type LucideIcon,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { BarChart, Donut, Funnel, Heatmap, LineChart, StackedBar, seriesColor } from '../components/Charts';
import {
  Avatar, Badge, Button, Card, CardHeader, EmptyState, ProgressBar, Skeleton, Stat, Tabs, Tooltip,
} from '../components/ui';
import { cls } from '../lib/cls';
import {
  formatCompact, formatDate, formatDateTime, formatDays, formatHours, formatLatency, formatNumber, formatPercent, plural,
} from '../lib/format';
import { usePageTitle } from '../lib/pageTitle';
import { navigate, paths } from '../lib/router';
import { useApp } from '../lib/store';
import { STEP_TYPES, type Kpis as KpiData, type StepType } from '../types';

const PERIODS = [
  { key: '7', label: '7 days' },
  { key: '30', label: '30 days' },
  { key: '90', label: '90 days' },
];

type HeatMetric = 'total' | 'wait';

export default function Kpis() {
  usePageTitle('KPIs');
  const { openCopilot, userById, roleByKey, blueprints, settings } = useApp();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<KpiData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [heat, setHeat] = useState<HeatMetric>('total');

  const load = useCallback(async (d: number) => {
    setLoading(true);
    try {
      setData(await api.kpis(d));
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(days); }, [days, load]);

  const ask = (question: string) => openCopilot({ question });
  const period = `the last ${days} days`;
  const insights: { label: string; icon: LucideIcon; question: string }[] = [
    {
      label: 'Bottlenecks', icon: Hourglass,
      question: `Where are the bottlenecks in the factory over ${period}? Use the KPIs (stage durations, time waiting on people, approvals, SLA breaches) and the projects in flight: name the slowest stages and the projects stuck in them, and give one concrete action for each.`,
    },
    {
      label: 'Approval latency', icon: Stamp,
      question: `Analyse approval latency over ${period}: which roles take longest to decide, how many rejections and why, which approvals are pending right now, and what would shorten the wait?`,
    },
    {
      label: 'Automation opportunities', icon: Zap,
      question: `Based on the automation KPIs by step type over ${period}, which human steps could be automated or better AI-assisted? Estimate the hours that could be saved and name the blueprints concerned.`,
    },
    {
      label: 'Executive summary', icon: FileText,
      question: `Write an executive summary of the factory's delivery performance over ${period}: throughput, lead time, SLA, quality gates, AI share and hours saved, the top risks, and three recommendations.`,
    },
  ];

  const exportJson = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `factory-kpis-${days}d-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Heatmap: blueprints × stages (stage order from the blueprint definition when it still exists).
  const heatmap = useMemo(() => {
    const stages = data?.stages ?? [];
    const rows = [...new Set(stages.map((s) => s.blueprint))];
    const cols: string[] = [];
    for (const row of rows) {
      const bp = blueprints.find((b) => b.name === row);
      const order = bp ? bp.stages.map((s) => s.name) : [];
      const names = stages.filter((s) => s.blueprint === row).map((s) => s.stage)
        .sort((a, b) => (order.indexOf(a) + 1 || 999) - (order.indexOf(b) + 1 || 999));
      names.forEach((n) => { if (!cols.includes(n)) cols.push(n); });
    }
    const values = rows.map((r) => cols.map((c) => {
      const cell = stages.find((s) => s.blueprint === r && s.stage === c);
      return cell ? (heat === 'total' ? cell.avg_hours : cell.avg_wait_hours) : null;
    }));
    return { rows, cols, values };
  }, [data, blueprints, heat]);

  const header = (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <div className="label-xs mb-1.5 flex items-center gap-1.5"><ChartColumn size={12} className="text-brand-500" /> Insights</div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] sm:leading-tight dark:text-white">KPIs</h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">
          Lead time, throughput, bottlenecks, SLA, approvals, automation and LLM usage — computed from what really happened.
        </p>
      </div>
      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border hairline bg-white p-0.5 dark:bg-ink-800" role="radiogroup" aria-label="Period">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={String(days) === p.key}
              onClick={() => setDays(Number(p.key))}
              className={cls(
                'rounded-md px-3 py-1 text-xs font-semibold transition-colors',
                String(days) === p.key ? 'bg-brand-500 text-white' : 'text-muted hover:text-zinc-900 dark:hover:text-white',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="sm" icon={RefreshCw} busy={loading && !!data} onClick={() => void load(days)}>Refresh</Button>
        <Button variant="outline" size="sm" icon={Download} disabled={!data} onClick={exportJson}>Export</Button>
        <Button variant="outline" size="sm" icon={Printer} disabled={!data} onClick={() => window.print()}>Print</Button>
      </div>
    </div>
  );

  if (error && !data) {
    return (
      <>
        {header}
        <EmptyState icon={ChartColumn} title="KPIs could not be computed" description={error} action={<Button onClick={() => void load(days)}>Retry</Button>} />
      </>
    );
  }

  const k = data;
  const weeks = k?.throughput ?? [];
  const llmConfigured = !!settings?.llm.base_url;

  return (
    <div className={cls('transition-opacity', loading && data && 'opacity-60')}>
      <div className="print-only mb-4">
        <div className="text-xl font-bold">{settings?.general.app_name || 'DOINg.AI Factory'} — KPI report</div>
        <div className="text-sm">
          {settings?.general.company ? `${settings.general.company} · ` : ''}Last {days} days · generated {formatDateTime(k?.generated_at)}
        </div>
      </div>
      {header}

      {/* AI insights */}
      <Card tone="ai" padding="none" className="no-print mb-5 overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span className="btn-ai grid h-8 w-8 shrink-0 place-items-center rounded-lg shadow-none"><Sparkles size={15} /></span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-zinc-900 dark:text-white">AI insights</div>
            <div className="text-xs text-muted">
              {llmConfigured ? 'Ask the copilot to read these numbers for you — it answers from the same KPIs and the live portfolio.'
                : 'Configure a local model in Settings › AI Model to get AI readings of these numbers.'}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {insights.map((i) => (
              <Button key={i.label} variant="ai" size="sm" icon={i.icon} disabled={!llmConfigured} onClick={() => ask(i.question)}>{i.label}</Button>
            ))}
          </div>
        </div>
      </Card>

      {/* Tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat loading={!k} label="Lead time" icon={Timer} tone="brand" value={formatDays(k?.lead_time.avg_days)}
          sub={k ? `median ${formatDays(k.lead_time.median_days)} · p90 ${formatDays(k.lead_time.p90_days)}` : undefined} />
        <Stat loading={!k} label="Throughput" icon={TrendingUp} tone="emerald" value={formatNumber(k?.totals.done_period)}
          sub={`completed in ${days} d`} trend={weeks.length > 1 ? weeks.map((w) => w.completed) : undefined}
          onClick={() => navigate(paths.projects({ status: 'done' }))} />
        <Stat loading={!k} label="AI share" icon={Bot} tone="violet" value={formatPercent(k?.automation.ai_share)}
          sub={k ? `${formatNumber(k.automation.ai_steps)} AI · ${formatNumber(k.automation.human_steps)} human steps` : undefined} />
        <Stat loading={!k} label="Hours saved" icon={Zap} tone="amber"
          value={k ? `${formatNumber(k.automation.hours_saved, k.automation.hours_saved < 10 ? 1 : 0)} h` : '—'}
          sub="AI work vs. manual baselines" />
        <Stat loading={!k} label="SLA on time" icon={AlarmClock} tone="sky" value={formatPercent(k?.sla.on_time_pct, false)}
          sub={k ? `${plural(k.sla.breached_open, 'open breach', 'open breaches')}` : undefined} />
        <Stat loading={!k} label="First-pass quality" icon={ShieldCheck} tone="emerald" value={formatPercent(k?.quality.first_pass_rate)}
          sub={k ? `${plural(k.quality.gates_run, 'gate')} run` : undefined} />
        <Stat loading={!k} label="Avg approval time" icon={Stamp} tone="amber" value={formatHours(k?.approvals.avg_hours)}
          sub={k ? `rejection rate ${formatPercent(k.approvals.rejection_rate)}` : undefined} />
        <Stat loading={!k} label="Jira issues created" icon={Ticket} tone="sky" value={formatNumber(k?.jira.issues_created)} sub={`in ${days} d`} />
        <Stat loading={!k} label="LLM calls" icon={Brain} tone="violet" value={formatCompact(k?.llm.calls)}
          sub={k ? `avg ${formatLatency(k.llm.avg_latency_ms)} · errors ${formatPercent(k.llm.error_rate, true, 1)}` : undefined}
          trend={k && k.llm.by_day.length > 1 ? k.llm.by_day.map((d) => d.calls) : undefined} />
        <Stat loading={!k} label="Open tasks" icon={Inbox} tone="brand" value={formatNumber(k?.totals.open_tasks)}
          sub={k ? `${plural(k.totals.pending_approvals, 'approval')} pending` : undefined} onClick={() => navigate(paths.inbox())} />
      </div>

      {/* Current state strip */}
      {k && (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="label-xs mr-1">Right now</span>
          <NowChip tone="sky" label="active" value={k.totals.active} to={paths.projects({ status: 'active' })} />
          <NowChip tone="amber" label="waiting" value={k.totals.waiting} to={paths.projects({ status: 'waiting' })} />
          <NowChip tone="rose" label="blocked" value={k.totals.blocked} to={paths.projects({ status: 'blocked' })} />
          <NowChip tone="rose" label="high risk" value={k.totals.at_risk} to={paths.projects({ risk: 'high' })} />
          <NowChip tone="brand" label="new in intake" value={k.totals.intake_new} to={paths.intake()} />
          <NowChip tone="indigo" label="child projects in flight" value={k.totals.children_in_flight} />
          <NowChip tone="zinc" label="cancelled in period" value={k.totals.cancelled} />
        </div>
      )}

      {!k ? (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
        </div>
      ) : (
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <ChartCard icon={TrendingUp} title="Weekly throughput" subtitle="Projects created vs. completed, last 12 weeks">
            <LineChart
              title="Weekly throughput"
              labels={weeks.map((w) => w.week.replace(/^\d{4}-/, ''))}
              series={[
                { name: 'Created', values: weeks.map((w) => w.created), color: seriesColor(1) },
                { name: 'Completed', values: weeks.map((w) => w.completed), color: seriesColor(0) },
              ]}
              area
              height={210}
            />
          </ChartCard>

          <ChartCard icon={Timer} title="Lead time by blueprint" subtitle={`Created → done, projects completed in ${days} d`}>
            <BarChart
              title="Lead time by blueprint"
              orientation="horizontal"
              data={k.lead_time.by_blueprint.map((b) => ({ label: b.blueprint, value: b.avg_days, hint: plural(b.count, 'project') }))}
              valueFormat={(v) => formatDays(v)}
            />
          </ChartCard>

          <ChartCard
            icon={Hourglass}
            title="Stage bottlenecks"
            subtitle={heat === 'total' ? 'Average hours per finished stage run (blueprint × stage)' : 'Average hours human steps took inside each stage'}
            className="lg:col-span-2"
            actions={(
              <Tabs
                size="sm"
                value={heat}
                onChange={(v) => setHeat(v as HeatMetric)}
                tabs={[{ key: 'total', label: 'Time in stage' }, { key: 'wait', label: 'Waiting on people' }]}
              />
            )}
          >
            {heatmap.rows.length === 0
              ? <NoData text={`No stage finished in the last ${days} days.`} />
              : <Heatmap title="Stage bottlenecks" rows={heatmap.rows} cols={heatmap.cols} values={heatmap.values} valueFormat={(v) => formatHours(v)} />}
          </ChartCard>

          <ChartCard icon={Stamp} title="Approvals by role" subtitle="Average time to decide, and decisions approved vs. rejected">
            {k.approvals.by_role.length === 0 ? <NoData text={`No approval decided in the last ${days} days.`} /> : (
              <div className="grid gap-4 sm:grid-cols-2">
                <BarChart
                  title="Average approval time by role"
                  orientation="horizontal"
                  data={k.approvals.by_role.map((r) => ({ label: roleByKey(r.role)?.label || r.role || 'Unassigned', value: r.avg_hours, hint: plural(r.count, 'decision') }))}
                  valueFormat={(v) => formatHours(v)}
                  color={seriesColor(3)}
                />
                <StackedBar
                  title="Approval decisions by role"
                  orientation="horizontal"
                  categories={k.approvals.by_role.map((r) => roleByKey(r.role)?.label || r.role || 'Unassigned')}
                  series={[
                    { name: 'Approved', values: k.approvals.by_role.map((r) => Math.max(0, r.count - r.rejected)), color: seriesColor(0) },
                    { name: 'Rejected', values: k.approvals.by_role.map((r) => r.rejected), color: seriesColor(7) },
                  ]}
                />
              </div>
            )}
          </ChartCard>

          <ChartCard icon={Bot} title="Automation by step type" subtitle={`Steps completed in ${days} d — AI / automated vs. human`}>
            {k.automation.by_type.length === 0 ? <NoData text={`No step completed in the last ${days} days.`} /> : (
              <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,1fr)_150px]">
                <StackedBar
                  title="Automation by step type"
                  orientation="horizontal"
                  categories={k.automation.by_type.map((t) => STEP_TYPES[t.type as StepType]?.label ?? t.type)}
                  series={[
                    { name: 'AI / automated', values: k.automation.by_type.map((t) => t.ai), color: seriesColor(5) },
                    { name: 'Human', values: k.automation.by_type.map((t) => Math.max(0, t.count - t.ai)), color: seriesColor(1) },
                  ]}
                />
                <Donut
                  title="AI share of completed steps"
                  size={130}
                  legend={false}
                  data={[
                    { label: 'AI / automated', value: k.automation.ai_steps, color: seriesColor(5) },
                    { label: 'Human', value: k.automation.human_steps, color: seriesColor(1) },
                  ]}
                  centerValue={formatPercent(k.automation.ai_share)}
                  centerLabel="AI"
                />
              </div>
            )}
          </ChartCard>

          <ChartCard icon={Brain} title="LLM usage" subtitle={`Calls per day · average latency by role — ${formatCompact(k.llm.tokens_in + k.llm.tokens_out)} tokens`}>
            {k.llm.calls === 0 ? <NoData text={`No LLM call in the last ${days} days.`} /> : (
              <div className="space-y-4">
                <LineChart
                  title="LLM calls per day"
                  labels={k.llm.by_day.map((d) => formatDate(d.day, true))}
                  series={[{ name: 'Calls', values: k.llm.by_day.map((d) => d.calls), color: seriesColor(5) }]}
                  area
                  height={150}
                />
                <BarChart
                  title="Average LLM latency by role"
                  orientation="horizontal"
                  data={[...k.llm.by_role].sort((a, b) => b.calls - a.calls).slice(0, 8)
                    .map((r) => ({ label: r.role || 'other', value: r.avg_latency_ms, hint: plural(r.calls, 'call') }))}
                  valueFormat={(v) => formatLatency(v)}
                  color={seriesColor(6)}
                />
              </div>
            )}
          </ChartCard>

          <ChartCard icon={Layers} title="Intake funnel" subtitle={`Use cases detected in ${days} d and how far they went`}>
            <Funnel
              title="Intake funnel"
              stages={[
                { label: 'Detected', value: k.funnel.detected },
                { label: 'Accepted', value: k.funnel.accepted },
                { label: 'Active', value: k.funnel.active },
                { label: 'Done', value: k.funnel.done },
              ]}
              onSelect={(s) => navigate(s.label === 'Detected' || s.label === 'Accepted' ? paths.intake() : paths.projects({ status: s.label === 'Done' ? 'done' : 'open' }))}
            />
            {k.funnel.detected > 0 && (
              <p className="mt-3 text-xs text-muted">
                Conversion detected → done: <span className="num font-semibold text-zinc-700 dark:text-zinc-200">{formatPercent(k.funnel.done / k.funnel.detected)}</span>
              </p>
            )}
          </ChartCard>

          <ChartCard icon={Users} title="Workload by person" subtitle="Open tasks right now (forms, estimates, approvals, reviews)">
            {k.workload.length === 0 ? <NoData text="Nobody has an open task." /> : (
              <ul className="space-y-2.5">
                {(() => {
                  const max = Math.max(...k.workload.map((w) => w.open_tasks), 1);
                  return [...k.workload].sort((a, b) => b.open_tasks - a.open_tasks).slice(0, 10).map((w) => {
                    const u = userById(w.user_id);
                    return (
                      <li key={w.user_id} className="flex items-center gap-3">
                        <Avatar user={u} name={u ? undefined : w.user_id} size={26} />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                              {u?.name ?? w.user_id}
                              {u?.title && <span className="ml-1.5 text-xs font-normal text-muted">{u.title}</span>}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              {w.overdue > 0 && <Badge tone="rose" size="xs">{w.overdue} overdue</Badge>}
                              <span className="num text-sm font-semibold text-zinc-700 dark:text-zinc-200">{w.open_tasks}</span>
                            </span>
                          </div>
                          <ProgressBar value={w.open_tasks / max} tone={w.overdue > 0 ? 'rose' : 'brand'} size="xs" className="mt-1" />
                        </div>
                      </li>
                    );
                  });
                })()}
              </ul>
            )}
          </ChartCard>

          <ChartCard icon={ShieldCheck} title="Top failing compliance rules" subtitle={`Quality-gate findings in ${days} d · first-pass rate ${formatPercent(k.quality.first_pass_rate)}`}>
            {k.quality.top_failing_rules.length === 0 ? (
              <NoData text={k.quality.gates_run ? 'No rule failed — every gate passed.' : `No quality gate ran in the last ${days} days.`} icon={CheckCheck} />
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="label-xs text-left">
                    <th className="pb-2 font-bold">Rule</th>
                    <th className="pb-2 font-bold">Title</th>
                    <th className="pb-2 text-right font-bold">Fails</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
                  {k.quality.top_failing_rules.map((r) => (
                    <tr key={r.code}>
                      <td className="py-2 pr-3"><Badge tone="rose" size="xs">{r.code}</Badge></td>
                      <td className="py-2 pr-3 text-zinc-700 dark:text-zinc-200">{r.title}</td>
                      <td className="num py-2 text-right font-semibold">{r.fails}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </ChartCard>

          <ChartCard icon={GaugeIcon} title="SLA" subtitle="Steps finished within their SLA, and breaches">
            <div className="grid grid-cols-3 gap-3 text-center">
              <MiniFigure label="On time" value={formatPercent(k.sla.on_time_pct, false)} tone={k.sla.on_time_pct === null || k.sla.on_time_pct === undefined ? 'zinc' : k.sla.on_time_pct >= 90 ? 'emerald' : k.sla.on_time_pct >= 70 ? 'amber' : 'rose'} />
              <MiniFigure label="Breached (open)" value={formatNumber(k.sla.breached_open)} tone={k.sla.breached_open ? 'rose' : 'zinc'} />
              <MiniFigure label="Breached (period)" value={formatNumber(k.sla.breached_total)} tone={k.sla.breached_total ? 'amber' : 'zinc'} />
            </div>
          </ChartCard>
        </div>
      )}
      {k && <p className="mt-4 text-[11px] text-faint">Generated {formatDateTime(k.generated_at)} · window {k.days} days. “—” = no data in the period (never estimated).</p>}
    </div>
  );
}

function ChartCard({ icon, title, subtitle, actions, className, children }: {
  icon: LucideIcon; title: string; subtitle?: string; actions?: ReactNode; className?: string; children: ReactNode;
}) {
  return (
    <Card padding="none" className={cls('print-section min-w-0', className)}>
      <CardHeader icon={icon} title={title} subtitle={subtitle} actions={actions} />
      <div className="p-4">{children}</div>
    </Card>
  );
}

function NoData({ text, icon: Icon = ChartColumn }: { text: string; icon?: LucideIcon }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 py-10 text-center text-xs text-muted">
      <Icon size={18} className="text-faint" />
      {text}
    </div>
  );
}

const MINI_TONE = {
  emerald: 'text-emerald-600 dark:text-emerald-400',
  amber: 'text-amber-600 dark:text-amber-400',
  rose: 'text-rose-600 dark:text-rose-400',
  zinc: 'text-zinc-800 dark:text-zinc-100',
} as const;

function MiniFigure({ label, value, tone }: { label: string; value: string; tone: keyof typeof MINI_TONE }) {
  return (
    <div className="rounded-lg border surface-deep px-2 py-4">
      <div className={cls('num text-2xl font-bold', MINI_TONE[tone])}>{value}</div>
      <div className="label-xs mt-1">{label}</div>
    </div>
  );
}

const CHIP_TONE = {
  sky: 'bg-sky-500', amber: 'bg-amber-500', rose: 'bg-rose-500', brand: 'bg-brand-500', indigo: 'bg-indigo-500', zinc: 'bg-zinc-400',
} as const;

function NowChip({ tone, label, value, to }: { tone: keyof typeof CHIP_TONE; label: string; value: number; to?: string }) {
  const inner = (
    <>
      <span className={cls('h-1.5 w-1.5 rounded-full', CHIP_TONE[tone])} />
      <span className="num font-semibold text-zinc-800 dark:text-zinc-100">{value}</span>
      <span className="text-muted">{label}</span>
    </>
  );
  const base = 'inline-flex items-center gap-1.5 rounded-full border hairline bg-white px-2.5 py-0.5 dark:bg-ink-800';
  return to ? (
    <Tooltip content="Open the list">
      <button type="button" onClick={() => navigate(to)} className={cls(base, 'transition-colors hover:border-brand-500/60')}>{inner}</button>
    </Tooltip>
  ) : <span className={base}>{inner}</span>;
}
