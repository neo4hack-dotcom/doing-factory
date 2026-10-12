// Dependency graph (SPEC "wow" #6): a project and what it needs, as pure SVG.
//
// Left: required capabilities the DOINg.AI MCP catalog already serves (emerald, matched server and
// deploy status). Centre: the project. Right: the missing capabilities, each with the child project
// (fan_out) that delivers it — status colour, progress, key, click to open; edges of in-flight
// children flow. Without a `vars.dependencies` analysis it degrades to a parent → project →
// children tree. Theme-aware through Tailwind classes on the SVG elements (no inline colours).
import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { cls } from '../lib/cls';
import { formatPercent } from '../lib/format';
import { navigate, paths } from '../lib/router';
import type { Project, ProjectStatus, ProjectSummary, StepStatus } from '../types';

export interface DependencyGraphProps {
  project: Project;
  /** Child project summaries (fan_out), already fetched by the caller. */
  children: ProjectSummary[];
  height?: number;
  /** Parent project, when known: drawn on the left of the fallback tree. */
  parent?: Pick<ProjectSummary, 'id' | 'key' | 'title' | 'status'> | null;
  className?: string;
}

// ---------------------------------------------------------------------------------------------
// Model (pure, unit-tested)
// ---------------------------------------------------------------------------------------------

export type NodeState =
  | 'existing' | 'delivered' | 'in_flight' | 'people' | 'blocked' | 'cancelled' | 'not_started' | 'parent';

export interface GraphNode {
  id: string;
  title: string;
  subtitle: string;
  /** Native tooltip text (purpose, data source, team…). */
  detail: string;
  state: NodeState;
  /** Small chip on the node: deploy status or project key. */
  chip: string;
  /** 0-1, shown as a bar on child projects. */
  progress?: number;
  /** Click target. */
  projectId?: string;
}

export interface DependencyModel {
  mode: 'dependencies' | 'family' | 'empty';
  left: GraphNode[];
  right: GraphNode[];
  leftLabel: string;
  rightLabel: string;
}

interface DepItem {
  name?: unknown; capability?: unknown; purpose?: unknown; exists?: unknown; matched_id?: unknown;
  matched_name?: unknown; deploy_status?: unknown; data_source?: unknown; suggested_team?: unknown;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function asItems(v: unknown): DepItem[] {
  return Array.isArray(v) ? v.filter((x): x is DepItem => !!x && typeof x === 'object') : [];
}

/** Node state of a child project from its summary: failure > needs a person > in flight. */
export function childState(s: Pick<ProjectSummary, 'status' | 'open_step_statuses'>): NodeState {
  const st: ProjectStatus = s.status;
  if (st === 'done') return 'delivered';
  if (st === 'cancelled') return 'cancelled';
  const open: StepStatus[] = s.open_step_statuses ?? [];
  if (st === 'blocked' || st === 'failed' || open.includes('failed') || open.includes('rejected')) return 'blocked';
  if (open.includes('waiting_human') || open.includes('waiting_approval')) return 'people';
  return 'in_flight';
}

function childNode(c: ProjectSummary, title?: string, detail = ''): GraphNode {
  const stage = c.status === 'done' ? 'Delivered' : c.status === 'cancelled' ? 'Cancelled' : c.current_stage_name || 'Starting';
  return {
    id: `child:${c.id}`,
    title: title || c.title,
    subtitle: title && norm(title) !== norm(c.title) ? `${c.title} · ${stage}` : stage,
    detail: [`${c.key} · ${c.title}`, `Stage: ${stage}`, `Progress: ${formatPercent(c.progress)}`, detail].filter(Boolean).join('\n'),
    state: childState(c),
    chip: c.key,
    progress: c.progress,
    projectId: c.id,
  };
}

/** Finds the child delivering a missing capability: the fan_out titles children `item.name or item.capability`. */
function matchChild(item: DepItem, children: ProjectSummary[], used: Set<string>): ProjectSummary | undefined {
  const names = [str(item.name), str(item.capability)].filter(Boolean).map(norm);
  if (names.length === 0) return undefined;
  const free = children.filter((c) => !used.has(c.id));
  return free.find((c) => names.includes(norm(c.title)))
    ?? free.find((c) => names.some((n) => n.length > 3 && (norm(c.title).includes(n) || n.includes(norm(c.title)))));
}

export function dependencyModel(
  project: Pick<Project, 'vars' | 'parent_id'>,
  children: ProjectSummary[],
  parent?: Pick<ProjectSummary, 'id' | 'key' | 'title' | 'status'> | null,
): DependencyModel {
  const deps = project.vars?.dependencies as { required?: unknown; missing?: unknown } | undefined;
  const required = asItems(deps?.required);
  const missing = asItems(deps?.missing);

  if (deps && typeof deps === 'object' && (required.length > 0 || missing.length > 0)) {
    const missingNames = new Set(missing.map((m) => norm(str(m.name) || str(m.capability))));
    const isMissing = (r: DepItem) => r.exists === false || missingNames.has(norm(str(r.name) || str(r.capability)));

    const left: GraphNode[] = required.filter((r) => !isMissing(r)).map((r, i) => {
      const server = str(r.matched_name) || str(r.name);
      const status = str(r.deploy_status);
      return {
        id: `cap:${i}`,
        title: str(r.capability) || server || 'Capability',
        subtitle: server ? `✓ ${server}` : '✓ In the catalog',
        detail: [server && `MCP server: ${server}`, status && `Deploy status: ${status}`, str(r.purpose)].filter(Boolean).join('\n'),
        state: 'existing',
        chip: status,
      };
    });

    // Missing ones come from `missing`; a `required` entry flagged exists=false but absent from
    // `missing` (a sloppy analysis) still shows up.
    const toDeliver: DepItem[] = [...missing];
    for (const r of required) {
      if (r.exists === false && !missingNames.has(norm(str(r.name) || str(r.capability)))) toDeliver.push(r);
    }
    const used = new Set<string>();
    const right: GraphNode[] = toDeliver.map((m, i) => {
      const title = str(m.name) || str(m.capability) || 'Missing capability';
      const detail = [str(m.capability) && `Capability: ${str(m.capability)}`, str(m.data_source) && `Source: ${str(m.data_source)}`,
        str(m.suggested_team) && `Suggested team: ${str(m.suggested_team)}`, str(m.purpose)].filter(Boolean).join('\n');
      const child = matchChild(m, children, used);
      if (child) {
        used.add(child.id);
        return { ...childNode(child, title, detail), id: `miss:${i}` };
      }
      return {
        id: `miss:${i}`, title, subtitle: str(m.capability) && norm(str(m.capability)) !== norm(title) ? str(m.capability) : 'Delivery not started yet',
        detail, state: 'not_started', chip: 'to build',
      };
    });
    // Children the analysis does not name (added by hand, renamed…) are still part of the picture.
    for (const c of children) if (!used.has(c.id)) right.push(childNode(c));

    return { mode: 'dependencies', left, right, leftLabel: 'In the catalog', rightLabel: 'To deliver' };
  }

  const left: GraphNode[] = [];
  if (parent) {
    left.push({ id: `parent:${parent.id}`, title: parent.title, subtitle: 'Parent project', detail: `${parent.key} · ${parent.title}`, state: 'parent', chip: parent.key, projectId: parent.id });
  } else if (project.parent_id) {
    left.push({ id: `parent:${project.parent_id}`, title: 'Parent project', subtitle: 'Open the parent', detail: '', state: 'parent', chip: '', projectId: project.parent_id });
  }
  const right = children.map((c) => childNode(c));
  if (left.length === 0 && right.length === 0) return { mode: 'empty', left, right, leftLabel: '', rightLabel: '' };
  return { mode: 'family', left, right, leftLabel: 'Parent', rightLabel: 'Child projects' };
}

/** "3 in the catalog · 2 to deliver (1 delivered)" for card subtitles. */
export function dependencySummary(model: DependencyModel): string {
  if (model.mode === 'empty') return 'No dependencies recorded';
  const delivered = model.right.filter((n) => n.state === 'delivered').length;
  if (model.mode === 'family') {
    return model.right.length ? `${model.right.length} child project${model.right.length === 1 ? '' : 's'} · ${delivered} delivered` : 'Child of another project';
  }
  return `${model.left.length} in the catalog · ${model.right.length} to deliver${model.right.length ? ` (${delivered} delivered)` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------

/** Static class strings per state (Tailwind only ships classes written in full). */
const STATE_STYLE: Record<NodeState, { bar: string; edge: string; dot: string; label: string; dashed: boolean; flow: boolean }> = {
  existing: { bar: 'fill-emerald-500', edge: 'stroke-emerald-500/70', dot: 'fill-emerald-500', label: 'In the catalog', dashed: false, flow: false },
  delivered: { bar: 'fill-emerald-500', edge: 'stroke-emerald-500', dot: 'fill-emerald-500', label: 'Delivered', dashed: false, flow: false },
  in_flight: { bar: 'fill-sky-500', edge: 'stroke-sky-500', dot: 'fill-sky-500', label: 'In delivery', dashed: true, flow: true },
  people: { bar: 'fill-amber-500', edge: 'stroke-amber-500', dot: 'fill-amber-500', label: 'Waiting on people', dashed: true, flow: true },
  blocked: { bar: 'fill-rose-500', edge: 'stroke-rose-500', dot: 'fill-rose-500', label: 'Blocked', dashed: true, flow: false },
  cancelled: { bar: 'fill-zinc-400', edge: 'stroke-zinc-400 dark:stroke-zinc-600', dot: 'fill-zinc-400', label: 'Cancelled', dashed: true, flow: false },
  not_started: { bar: 'fill-zinc-300 dark:fill-zinc-600', edge: 'stroke-zinc-300 dark:stroke-zinc-600', dot: 'fill-zinc-400', label: 'Not started', dashed: true, flow: false },
  parent: { bar: 'fill-indigo-500', edge: 'stroke-indigo-500/70', dot: 'fill-indigo-500', label: 'Parent', dashed: false, flow: false },
};

const CHIP_STYLE: Record<string, string> = {
  production: 'fill-emerald-600 dark:fill-emerald-400',
  prod: 'fill-emerald-600 dark:fill-emerald-400',
  uat: 'fill-amber-600 dark:fill-amber-400',
  dev: 'fill-sky-600 dark:fill-sky-400',
};

const NODE_H = 54;
const CHILD_H = 64;
const ROW_GAP = 12;
const CENTRE_W = 230;
const CENTRE_H = 108;
const HEADER = 30;
const PAD = 12;
const CHAR_W = 6.3;   // average Inter glyph width at 12px: good enough to truncate without measuring

function clip(text: string, width: number, charW = CHAR_W): string {
  const max = Math.max(4, Math.floor(width / charW));
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function useWidth<T extends HTMLElement>(initial: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => setWidth(Math.round(el.getBoundingClientRect().width) || initial);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [initial]);
  return [ref, width] as const;
}

interface Placed extends GraphNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

function column(nodes: GraphNode[], x: number, w: number, h: number, centreY: number): Placed[] {
  const total = nodes.length * h + Math.max(0, nodes.length - 1) * ROW_GAP;
  const top = centreY - total / 2;
  return nodes.map((n, i) => ({ ...n, x, y: top + i * (h + ROW_GAP), w, h }));
}

function edgePath(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(30, Math.abs(x2 - x1) * 0.45);
  const c1 = x1 < x2 ? x1 + dx : x1 - dx;
  const c2 = x1 < x2 ? x2 - dx : x2 + dx;
  return `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}`;
}

export function DependencyGraph({ project, children, height, parent, className }: DependencyGraphProps) {
  const model = dependencyModel(project, children, parent);
  const [ref, measured] = useWidth<HTMLDivElement>(880);

  if (model.mode === 'empty') {
    return (
      <div className={cls('rounded-xl border border-dashed border-zinc-300 px-4 py-8 text-center text-sm text-muted dark:border-ink-500', className)}>
        No dependency analysis yet — it appears once the analysis step stores <code className="font-mono text-xs">vars.dependencies</code>, or when child projects start.
      </div>
    );
  }

  const W = Math.max(640, measured);
  const sideW = Math.min(300, Math.max(180, (W - CENTRE_W - 2 * 70) / 2));
  const gap = (W - 2 * sideW - CENTRE_W) / 2;
  const leftX = 0;
  const centreX = sideW + gap;
  const rightX = centreX + CENTRE_W + gap;
  const leftH = model.left.length * NODE_H + Math.max(0, model.left.length - 1) * ROW_GAP;
  const rightH = model.right.length * CHILD_H + Math.max(0, model.right.length - 1) * ROW_GAP;
  const bodyH = Math.max(leftH, rightH, CENTRE_H);
  const H = Math.max(height ?? 0, HEADER + bodyH + PAD * 2);
  const centreY = HEADER + PAD + (H - HEADER - PAD * 2) / 2;
  const left = column(model.left, leftX, sideW, NODE_H, centreY);
  const right = column(model.right, rightX, sideW, CHILD_H, centreY);
  const centreTop = centreY - CENTRE_H / 2;

  // Edge endpoints spread along the centre node's side, so many edges do not meet in one point.
  const anchor = (i: number, n: number) => centreTop + 18 + ((CENTRE_H - 36) * (i + 1)) / (n + 1);

  const projectProgress = (() => {
    const steps = project.stages.flatMap((s) => s.steps);
    return steps.length ? steps.filter((s) => s.status === 'done' || s.status === 'skipped').length / steps.length : 0;
  })();

  const open = (n: Placed) => {
    if (n.projectId) navigate(paths.project(n.projectId));
  };
  const onKey = (n: Placed) => (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open(n);
    }
  };

  const usedStates = Array.from(new Set([...model.left, ...model.right].map((n) => n.state)));

  return (
    <div className={cls('min-w-0', className)}>
      <div ref={ref} className="no-scrollbar overflow-x-auto">
        <svg
          width={W}
          height={H}
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Dependency graph of ${project.key}: ${dependencySummary(model)}`}
          className="block select-none font-sans"
        >
          {/* Column headers */}
          {model.left.length > 0 && (
            <text x={leftX} y={14} className="fill-zinc-500 text-[10px] font-bold uppercase tracking-[0.16em] dark:fill-zinc-400">
              {model.leftLabel} · {model.left.length}
            </text>
          )}
          <text x={centreX + CENTRE_W / 2} y={14} textAnchor="middle" className="fill-zinc-500 text-[10px] font-bold uppercase tracking-[0.16em] dark:fill-zinc-400">
            This project
          </text>
          {model.right.length > 0 && (
            <text x={rightX + sideW} y={14} textAnchor="end" className="fill-zinc-500 text-[10px] font-bold uppercase tracking-[0.16em] dark:fill-zinc-400">
              {model.rightLabel} · {model.right.length}
            </text>
          )}

          {/* Edges first, under the nodes */}
          {left.map((n, i) => {
            const s = STATE_STYLE[n.state];
            const y2 = anchor(i, left.length);
            return (
              <g key={`e-${n.id}`}>
                <path d={edgePath(n.x + n.w, n.y + n.h / 2, centreX, y2)} fill="none" strokeWidth={1.75}
                  strokeDasharray={s.dashed ? '6 6' : undefined} className={cls(s.edge, s.flow && 'animate-flow')} />
                <circle cx={centreX} cy={y2} r={3} className={s.dot} />
              </g>
            );
          })}
          {right.map((n, i) => {
            const s = STATE_STYLE[n.state];
            const y2 = anchor(i, right.length);
            // Delivery flows from the child into the project: the dash moves right → left.
            return (
              <g key={`e-${n.id}`}>
                <path d={edgePath(n.x, n.y + n.h / 2, centreX + CENTRE_W, y2)} fill="none" strokeWidth={1.75}
                  strokeDasharray={s.dashed ? '6 6' : undefined} className={cls(s.edge, s.flow && 'animate-flow')} />
                <circle cx={centreX + CENTRE_W} cy={y2} r={3} className={s.dot} />
              </g>
            );
          })}

          {/* Centre: the project */}
          <g>
            <title>{`${project.key} · ${project.title}`}</title>
            <rect x={centreX} y={centreTop} width={CENTRE_W} height={CENTRE_H} rx={14}
              className="fill-brand-50 stroke-brand-500 dark:fill-brand-500/10" strokeWidth={1.5} />
            {(project.status === 'active' || project.status === 'waiting') && (
              <rect x={centreX - 4} y={centreTop - 4} width={CENTRE_W + 8} height={CENTRE_H + 8} rx={17}
                fill="none" strokeWidth={1.5} className="stroke-brand-500/40 animate-pulse-slow" />
            )}
            <text x={centreX + 16} y={centreTop + 24} className="fill-brand-600 text-[11px] font-bold tracking-wide dark:fill-brand-400">
              {project.key}
            </text>
            <text x={centreX + CENTRE_W - 16} y={centreTop + 24} textAnchor="end" className="fill-zinc-500 text-[10px] font-semibold uppercase tracking-wider dark:fill-zinc-400">
              {project.status}
            </text>
            <text x={centreX + 16} y={centreTop + 46} className="fill-zinc-900 text-[13px] font-bold dark:fill-white">
              {clip(project.title, CENTRE_W - 32, 7.2)}
            </text>
            <text x={centreX + 16} y={centreTop + 64} className="fill-zinc-500 text-[11px] dark:fill-zinc-400">
              {clip(project.blueprint_name || project.kind, CENTRE_W - 32)}
            </text>
            <rect x={centreX + 16} y={centreTop + 80} width={CENTRE_W - 32} height={5} rx={2.5} className="fill-zinc-200 dark:fill-ink-500" />
            <rect x={centreX + 16} y={centreTop + 80} width={(CENTRE_W - 32) * projectProgress} height={5} rx={2.5} className="fill-brand-500" />
            <text x={centreX + CENTRE_W - 16} y={centreTop + 99} textAnchor="end" className="fill-zinc-500 text-[10px] font-semibold dark:fill-zinc-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {formatPercent(projectProgress)} done
            </text>
          </g>

          {[...left, ...right].map((n) => (
            <Node key={n.id} node={n} onOpen={() => open(n)} onKey={onKey(n)} />
          ))}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted">
        {usedStates.map((st) => (
          <span key={st} className="inline-flex items-center gap-1.5">
            <svg width={18} height={6} aria-hidden>
              <line x1={1} y1={3} x2={17} y2={3} strokeWidth={2} strokeDasharray={STATE_STYLE[st].dashed ? '4 3' : undefined} className={STATE_STYLE[st].edge} />
            </svg>
            {STATE_STYLE[st].label}
          </span>
        ))}
        {model.right.some((n) => n.projectId) && <span className="ml-auto text-faint">Click a project to open it</span>}
      </div>
    </div>
  );
}

function Node({ node: n, onOpen, onKey }: { node: Placed; onOpen: () => void; onKey: (e: KeyboardEvent<SVGGElement>) => void }) {
  const s = STATE_STYLE[n.state];
  const clickable = !!n.projectId;
  const chipW = n.chip ? Math.min(n.w * 0.42, n.chip.length * 6 + 12) : 0;
  const textW = n.w - 24 - (chipW ? chipW + 8 : 0);
  return (
    <g
      className={cls('group outline-none', clickable && 'cursor-pointer')}
      role={clickable ? 'link' : undefined}
      tabIndex={clickable ? 0 : undefined}
      aria-label={clickable ? `Open ${n.chip || n.title}` : undefined}
      onClick={clickable ? onOpen : undefined}
      onKeyDown={clickable ? onKey : undefined}
    >
      <title>{[n.title, n.detail].filter(Boolean).join('\n')}</title>
      <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={10} strokeWidth={1}
        strokeDasharray={n.state === 'not_started' ? '4 3' : undefined}
        className={cls('fill-white stroke-zinc-200 transition-colors dark:fill-ink-800 dark:stroke-ink-500',
          clickable && 'group-hover:stroke-brand-500 group-focus-visible:stroke-brand-500 dark:group-hover:stroke-brand-500')} />
      <rect x={n.x} y={n.y + 8} width={3} height={n.h - 16} rx={1.5} className={s.bar} />
      <text x={n.x + 14} y={n.y + 21} className="fill-zinc-900 text-[12px] font-semibold dark:fill-zinc-100">
        {clip(n.title, textW)}
      </text>
      <text x={n.x + 14} y={n.y + 38} className="fill-zinc-500 text-[11px] dark:fill-zinc-400">
        {clip(n.subtitle, n.w - 26, 5.9)}
      </text>
      {n.chip && (
        <text x={n.x + n.w - 10} y={n.y + 21} textAnchor="end"
          className={cls('text-[10px] font-bold uppercase tracking-wide', CHIP_STYLE[n.chip.toLowerCase()] ?? 'fill-zinc-500 dark:fill-zinc-400')}>
          {clip(n.chip, chipW, 6)}
        </text>
      )}
      {n.progress !== undefined && (
        <>
          <rect x={n.x + 14} y={n.y + n.h - 15} width={n.w - 60} height={4} rx={2} className="fill-zinc-200 dark:fill-ink-500" />
          <rect x={n.x + 14} y={n.y + n.h - 15} width={(n.w - 60) * Math.max(0, Math.min(1, n.progress))} height={4} rx={2} className={s.bar} />
          <text x={n.x + n.w - 10} y={n.y + n.h - 10} textAnchor="end" className="fill-zinc-500 text-[10px] font-semibold dark:fill-zinc-400" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {formatPercent(n.progress)}
          </text>
        </>
      )}
    </g>
  );
}
