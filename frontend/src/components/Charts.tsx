// Pure SVG/HTML charts — no chart library, so the Factory renders the same offline / air-gapped.
//
// Conventions (dataviz method): categorical colours are CSS variables `--series-1…8` (index.css,
// validated for light and dark surfaces, assigned in fixed order — never cycled past 8), 2px lines,
// bars ≤ 24px thick with a 4px rounded data end, a 2px surface gap between touching marks, hairline
// recessive grid, a legend for ≥ 2 series, a hover/focus tooltip on every mark, and a screen-reader
// table carrying every value. Charts measure their container and draw at real pixel width, so text
// is never scaled.
import { useCallback, useRef, useState } from 'react';
import type { ReactNode, RefCallback, RefObject } from 'react';
import { cls } from '../lib/cls';
import { formatCompact, formatPercent } from '../lib/format';

// ---------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------

export const SERIES_COUNT = 8;
/** Categorical colour for slot i (0-based). Slots past 8 fold into the last slot: group them as "Other". */
export function seriesColor(i: number): string {
  return `var(--series-${Math.min(Math.max(0, i), SERIES_COUNT - 1) + 1})`;
}

const SAFE_COLOR = /^(#[0-9a-f]{3,8}|var\(--[a-z0-9-]+\))$/i;
/** Colour from data (LLM chart blocks, configs) only if it is a plain hex or a theme variable. */
export function safeColor(color: string | undefined, fallback: string): string {
  return color && SAFE_COLOR.test(color.trim()) ? color.trim() : fallback;
}

export type ValueFormat = (value: number) => string;
const defaultFormat: ValueFormat = (v) => formatCompact(v);

/** Clean axis ticks covering [min, max] ("0, 5, 10, 15"); `integer` forbids fractional steps (counts). */
export function niceTicks(min: number, max: number, count = 4, integer = false): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0];
  if (min === max) max = min + (integer ? 1 : Math.abs(min) || 1);
  const rough = (max - min) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  let step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  if (integer) step = Math.max(1, Math.round(step));
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Number(v.toFixed(10)));
  return ticks;
}

/**
 * Container width via ResizeObserver (0 until measured — and in non-DOM environments).
 * A callback ref, not a mount effect: a chart usually mounts in its "No data" state (no container
 * attached) and only gets a container once data arrives — a mount-only effect would never measure it.
 */
function useWidth<T extends HTMLElement>(): [RefCallback<T>, number, RefObject<T | null>] {
  const node = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  const ref = useCallback((el: T | null) => {
    node.current = el;
    if (!el) return;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => {
      ro.disconnect();
      node.current = null;
    };
  }, []);
  return [ref, width, node];
}

interface TipRow {
  label: string;
  value: string;
  color?: string;
  shape?: 'line' | 'rect';
}

interface Tip {
  x: number;
  y: number;
  title?: string;
  rows: TipRow[];
}

/** One tooltip per chart, positioned inside the (relative) chart container and kept within it. */
function useTooltip() {
  const [tip, setTip] = useState<Tip | null>(null);
  const hide = useCallback(() => setTip(null), []);
  return { tip, show: setTip, hide };
}

function TooltipBox({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const flip = tip.x > width * 0.62;
  return (
    <div
      className="pointer-events-none absolute z-10 min-w-[120px] max-w-[260px] rounded-lg border bg-white/95 px-2.5 py-2 text-[11px] shadow-pop backdrop-blur dark:border-ink-500 dark:bg-ink-700/95"
      style={{
        left: tip.x,
        top: tip.y,
        transform: `translate(${flip ? 'calc(-100% - 12px)' : '12px'}, -50%)`,
      }}
    >
      {tip.title && <div className="mb-1 font-semibold text-zinc-500 dark:text-zinc-400">{tip.title}</div>}
      <div className="space-y-0.5">
        {tip.rows.map((r, i) => (
          <div key={i} className="flex items-center gap-2">
            {r.color && (
              <span
                className="shrink-0"
                style={r.shape === 'rect'
                  ? { width: 8, height: 8, borderRadius: 2, background: r.color }
                  : { width: 10, height: 2, borderRadius: 1, background: r.color }}
              />
            )}
            <span className="num font-bold text-zinc-900 dark:text-white">{r.value}</span>
            <span className="truncate text-zinc-500 dark:text-zinc-400">{r.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export interface LegendItem {
  label: string;
  color: string;
  shape?: 'line' | 'rect';
  value?: string;
}

export function Legend({ items, className }: { items: LegendItem[]; className?: string }) {
  return (
    <div className={cls('flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-600 dark:text-zinc-400', className)}>
      {items.map((it) => (
        <span key={it.label} className="inline-flex min-w-0 items-center gap-1.5">
          <span
            className="shrink-0"
            style={it.shape === 'line'
              ? { width: 12, height: 2, borderRadius: 1, background: it.color }
              : { width: 9, height: 9, borderRadius: 2, background: it.color }}
          />
          <span className="truncate">{it.label}</span>
          {it.value && <span className="num font-semibold text-zinc-800 dark:text-zinc-200">{it.value}</span>}
        </span>
      ))}
    </div>
  );
}

/** Hidden table with every value, for screen readers (the visual chart is aria-hidden). */
function SrTable({ caption, head, rows }: { caption?: string; head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <table className="sr-only">
      {caption && <caption>{caption}</caption>}
      <thead><tr>{head.map((h) => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table>
  );
}

function NoData({ height, label }: { height: number; label?: string }) {
  return (
    <div className="grid place-items-center rounded-lg border border-dashed border-zinc-200 text-xs text-faint dark:border-ink-500" style={{ height }}>
      {label ?? 'No data yet'}
    </div>
  );
}

/** Bar path with a 4px rounded data end and a square baseline end. */
function barPath(x: number, y: number, w: number, h: number, dir: 'up' | 'right', radius = 4): string {
  if (w <= 0 || h <= 0) return '';
  if (dir === 'up') {
    const r = Math.min(radius, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }
  const r = Math.min(radius, h / 2, w);
  return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
}

const AXIS_TEXT = { fill: 'var(--chart-axis)', fontSize: 10 } as const;
const GRID = { stroke: 'var(--chart-grid)', strokeWidth: 1 } as const;

function isIntegerData(values: Array<number | null | undefined>): boolean {
  return values.every((v) => v === null || v === undefined || Number.isInteger(v));
}

// ---------------------------------------------------------------------------------------------
// LineChart
// ---------------------------------------------------------------------------------------------

export interface LineSeries {
  name: string;
  /** One value per label; null = gap. */
  values: Array<number | null>;
  color?: string;
}

export function LineChart({ labels, series, height = 200, area, yFormat = defaultFormat, yMin, title, className }: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  /** Area wash under each line (default: only for a single series). */
  area?: boolean;
  yFormat?: ValueFormat;
  /** Lower bound of the y axis (default 0, or the data minimum when negative). */
  yMin?: number;
  title?: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const [hover, setHover] = useState<number | null>(null);
  const all = series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const n = labels.length;
  const withArea = area ?? series.length === 1;

  if (n === 0 || all.length === 0) return <div className={className}><NoData height={height} /></div>;

  const ticks = niceTicks(Math.min(yMin ?? 0, ...all), Math.max(...all), 4, isIntegerData(all));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const tickW = Math.max(...ticks.map((t) => yFormat(t).length)) * 6 + 10;
  const pad = { l: tickW, r: 14, t: 10, b: 22 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * innerH;
  const colors = series.map((s, i) => safeColor(s.color, seriesColor(i)));
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 64))));

  const pathFor = (values: Array<number | null>) => {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  const focusIndex = (i: number) => {
    const idx = Math.max(0, Math.min(n - 1, i));
    setHover(idx);
    const ys = series.map((s) => s.values[idx]).filter((v): v is number => v !== null);
    show({
      x: x(idx),
      y: ys.length ? y(Math.max(...ys)) : pad.t + innerH / 2,
      title: labels[idx],
      rows: series.map((s, si) => ({
        label: s.name,
        value: s.values[idx] === null || s.values[idx] === undefined ? '—' : yFormat(s.values[idx] as number),
        color: colors[si],
      })),
    });
  };
  const clear = () => {
    setHover(null);
    hide();
  };

  return (
    <div className={cls('min-w-0', className)}>
      <div ref={ref} className="relative" style={{ height }}>
        {width > 0 && (
          <svg
            width={width}
            height={height}
            className="block overflow-visible outline-none"
            tabIndex={0}
            role="img"
            aria-label={title ?? 'Line chart'}
            onPointerMove={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const mx = e.clientX - rect.left;
              focusIndex(n === 1 ? 0 : Math.round(((mx - pad.l) / innerW) * (n - 1)));
            }}
            onPointerLeave={clear}
            onBlur={clear}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') focusIndex((hover ?? -1) + 1);
              if (e.key === 'ArrowLeft') focusIndex((hover ?? n) - 1);
            }}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} {...GRID} />
                <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" {...AXIS_TEXT} className="num">{yFormat(t)}</text>
              </g>
            ))}
            {labels.map((lab, i) => (i % labelEvery === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= labelEvery / 2) ? (
              <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle'} {...AXIS_TEXT}>
                {lab}
              </text>
            ) : null)}
            {withArea && series.map((s, si) => {
              const d = pathFor(s.values);
              const firstIdx = s.values.findIndex((v) => v !== null);
              const lastIdx = s.values.length - 1 - [...s.values].reverse().findIndex((v) => v !== null);
              if (!d || firstIdx < 0 || s.values.some((v, i) => v === null && i > firstIdx && i < lastIdx)) return null;
              return (
                <path key={`a${si}`} d={`${d}L${x(lastIdx)},${y(lo)}L${x(firstIdx)},${y(lo)}Z`} fill={colors[si]} fillOpacity={0.1} />
              );
            })}
            {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + innerH} stroke="var(--chart-axis)" strokeWidth={1} />}
            {series.map((s, si) => (
              <path key={si} d={pathFor(s.values)} fill="none" stroke={colors[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {series.map((s, si) => {
              const idx = hover ?? s.values.length - 1;
              const v = s.values[idx];
              if (v === null || v === undefined) return null;
              return (
                <circle key={`d${si}`} cx={x(idx)} cy={y(v)} r={4} fill={colors[si]} stroke="var(--chart-surface)" strokeWidth={2} />
              );
            })}
          </svg>
        )}
        <TooltipBox tip={tip} width={width} />
      </div>
      {series.length > 1 && (
        <Legend className="mt-2" items={series.map((s, i) => ({ label: s.name, color: colors[i], shape: 'line' }))} />
      )}
      <SrTable caption={title} head={['', ...series.map((s) => s.name)]} rows={labels.map((l, i) => [l, ...series.map((s) => s.values[i] ?? '—')])} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// BarChart (single series, vertical columns or horizontal bars)
// ---------------------------------------------------------------------------------------------

export interface BarDatum {
  label: string;
  value: number;
  /** Override (hex or var(--…)); default is the single series colour. */
  color?: string;
  /** Secondary text in the tooltip (e.g. "12 projects"). */
  hint?: string;
}

export function BarChart({
  data, orientation = 'vertical', height, valueFormat = defaultFormat, color, onSelect, title, className,
}: {
  data: BarDatum[];
  orientation?: 'vertical' | 'horizontal';
  /** Vertical: chart height (default 200). Horizontal: computed from the row count. */
  height?: number;
  valueFormat?: ValueFormat;
  color?: string;
  /** Click on a bar (deep-link to a filtered view). */
  onSelect?: (datum: BarDatum, index: number) => void;
  title?: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const [active, setActive] = useState<number | null>(null);
  const base = safeColor(color, seriesColor(0));
  const values = data.map((d) => (Number.isFinite(d.value) ? d.value : 0));
  const sr = <SrTable caption={title} head={['', 'Value']} rows={data.map((d) => [d.label, valueFormat(d.value)])} />;

  if (data.length === 0) return <div className={className}><NoData height={height ?? 160} /></div>;

  const enter = (i: number, x: number, y: number) => {
    setActive(i);
    show({ x, y, title: data[i].label, rows: [{ label: data[i].hint ?? '', value: valueFormat(values[i]), color: safeColor(data[i].color, base), shape: 'rect' }] });
  };
  const leave = () => {
    setActive(null);
    hide();
  };
  const markProps = (i: number, tx: number, ty: number) => ({
    onPointerEnter: () => enter(i, tx, ty),
    onPointerLeave: leave,
    onFocus: () => enter(i, tx, ty),
    onBlur: leave,
    onClick: onSelect ? () => onSelect(data[i], i) : undefined,
    tabIndex: onSelect ? 0 : undefined,
    style: { cursor: onSelect ? 'pointer' : 'default' },
  });

  if (orientation === 'horizontal') {
    const row = 28;
    const h = height ?? data.length * row + 8;
    const labelW = Math.min(180, Math.max(60, Math.max(...data.map((d) => d.label.length)) * 6.2 + 12));
    const valueW = Math.max(...values.map((v) => valueFormat(v).length)) * 6.5 + 12;
    const max = Math.max(...values, 0) || 1;
    const innerW = Math.max(10, width - labelW - valueW);
    return (
      <div className={cls('min-w-0', className)}>
        <div ref={ref} className="relative" style={{ height: h }}>
          {width > 0 && (
            <svg width={width} height={h} className="block" role="img" aria-label={title ?? 'Bar chart'}>
              {data.map((d, i) => {
                const yy = 4 + i * row;
                const bw = (Math.max(0, values[i]) / max) * innerW;
                const thick = Math.min(18, row - 8);
                const by = yy + (row - thick) / 2;
                const label = d.label.length * 6.2 > labelW - 12 ? `${d.label.slice(0, Math.floor((labelW - 16) / 6.2))}…` : d.label;
                return (
                  <g key={i} {...markProps(i, labelW + bw, by + thick / 2)}>
                    <rect x={0} y={yy} width={width} height={row} fill="transparent" />
                    <text x={labelW - 10} y={by + thick / 2 + 3.5} textAnchor="end" fontSize={11} fill="currentColor" className="text-zinc-600 dark:text-zinc-300">{label}</text>
                    <rect x={labelW} y={by} width={innerW} height={thick} rx={4} fill="var(--chart-grid)" opacity={0.45} />
                    <path d={barPath(labelW, by, Math.max(bw, values[i] > 0 ? 2 : 0), thick, 'right')} fill={safeColor(d.color, base)} opacity={active === null || active === i ? 1 : 0.55} />
                    <text x={labelW + bw + 6} y={by + thick / 2 + 3.5} fontSize={11} fontWeight={600} fill="currentColor" className="num text-zinc-800 dark:text-zinc-200">{valueFormat(values[i])}</text>
                  </g>
                );
              })}
            </svg>
          )}
          <TooltipBox tip={tip} width={width} />
        </div>
        {sr}
      </div>
    );
  }

  const h = height ?? 200;
  const ticks = niceTicks(Math.min(0, ...values), Math.max(0, ...values), 4, isIntegerData(values));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const tickW = Math.max(...ticks.map((t) => valueFormat(t).length)) * 6 + 10;
  const pad = { l: tickW, r: 8, t: 16, b: 22 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = h - pad.t - pad.b;
  const slot = innerW / data.length;
  const bw = Math.max(2, Math.min(24, slot * 0.6));
  const y = (v: number) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * innerH;
  const zero = y(0);
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(innerW / 56))));
  const maxChars = Math.max(3, Math.floor((slot * labelEvery) / 6));

  return (
    <div className={cls('min-w-0', className)}>
      <div ref={ref} className="relative" style={{ height: h }}>
        {width > 0 && (
          <svg width={width} height={h} className="block" role="img" aria-label={title ?? 'Bar chart'}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} {...GRID} />
                <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" {...AXIS_TEXT} className="num">{valueFormat(t)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const cx = pad.l + slot * (i + 0.5);
              const v = values[i];
              const top = Math.min(y(v), zero);
              const bh = Math.abs(y(v) - zero);
              const showValue = data.length <= 12 && bw >= 10;
              return (
                <g key={i} {...markProps(i, cx, top)}>
                  <rect x={cx - slot / 2} y={pad.t} width={slot} height={innerH} fill="transparent" />
                  <path
                    d={v >= 0 ? barPath(cx - bw / 2, top, bw, Math.max(bh, v !== 0 ? 1.5 : 0), 'up') : `M${cx - bw / 2},${zero}h${bw}v${bh}h${-bw}Z`}
                    fill={safeColor(d.color, base)}
                    opacity={active === null || active === i ? 1 : 0.55}
                  />
                  {showValue && (
                    <text x={cx} y={v >= 0 ? top - 5 : zero + bh + 12} textAnchor="middle" fontSize={10} fontWeight={600} fill="currentColor" className="num text-zinc-700 dark:text-zinc-300">
                      {valueFormat(v)}
                    </text>
                  )}
                  {i % labelEvery === 0 && (
                    <text x={cx} y={h - 6} textAnchor="middle" {...AXIS_TEXT}>
                      {d.label.length > maxChars ? `${d.label.slice(0, maxChars - 1)}…` : d.label}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        )}
        <TooltipBox tip={tip} width={width} />
      </div>
      {sr}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// StackedBar (categories × series)
// ---------------------------------------------------------------------------------------------

export interface StackSeries {
  name: string;
  /** One value per category. */
  values: number[];
  color?: string;
}

export function StackedBar({
  categories, series, orientation = 'vertical', height, valueFormat = defaultFormat, normalize, title, className,
}: {
  categories: string[];
  series: StackSeries[];
  orientation?: 'vertical' | 'horizontal';
  height?: number;
  valueFormat?: ValueFormat;
  /** Each bar shows shares of 100 % instead of absolute totals. */
  normalize?: boolean;
  title?: string;
  className?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const colors = series.map((s, i) => safeColor(s.color, seriesColor(i)));
  const totals = categories.map((_, ci) => series.reduce((sum, s) => sum + Math.max(0, s.values[ci] ?? 0), 0));
  const GAP = 2;

  if (categories.length === 0 || series.length === 0 || totals.every((t) => t === 0)) {
    return <div className={className}><NoData height={height ?? 180} /></div>;
  }

  const fmt = (v: number, total: number) => (normalize ? formatPercent(total ? v / total : 0) : valueFormat(v));
  const tipFor = (ci: number, x: number, yy: number) => show({
    x, y: yy, title: categories[ci],
    rows: [
      ...series.map((s, si) => ({ label: s.name, value: fmt(s.values[ci] ?? 0, totals[ci]), color: colors[si], shape: 'rect' as const })),
      ...(normalize ? [] : [{ label: 'Total', value: valueFormat(totals[ci]) }]),
    ],
  });

  const legend = <Legend className="mt-2" items={series.map((s, i) => ({ label: s.name, color: colors[i] }))} />;
  const sr = (
    <SrTable caption={title} head={['', ...series.map((s) => s.name), 'Total']}
      rows={categories.map((c, ci) => [c, ...series.map((s) => s.values[ci] ?? 0), totals[ci]])} />
  );

  if (orientation === 'horizontal') {
    const row = 30;
    const h = height ?? categories.length * row + 4;
    const labelW = Math.min(170, Math.max(56, Math.max(...categories.map((c) => c.length)) * 6.2 + 12));
    const totalW = normalize ? 8 : Math.max(...totals.map((t) => valueFormat(t).length)) * 6.5 + 12;
    const innerW = Math.max(10, width - labelW - totalW);
    const max = normalize ? 1 : Math.max(...totals) || 1;
    return (
      <div className={cls('min-w-0', className)}>
        <div ref={ref} className="relative" style={{ height: h }}>
          {width > 0 && (
            <svg width={width} height={h} className="block" role="img" aria-label={title ?? 'Stacked bar chart'}>
              {categories.map((c, ci) => {
                const thick = Math.min(18, row - 10);
                const by = 2 + ci * row + (row - thick) / 2;
                let cursor = labelW;
                const segs = series.map((s, si) => ({ v: Math.max(0, s.values[ci] ?? 0), si })).filter((x) => x.v > 0);
                return (
                  <g key={ci} onPointerMove={(e) => {
                    const r = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                    tipFor(ci, r ? e.clientX - r.left : labelW, by + thick / 2);
                  }} onPointerLeave={hide}>
                    <rect x={0} y={2 + ci * row} width={width} height={row} fill="transparent" />
                    <text x={labelW - 10} y={by + thick / 2 + 3.5} textAnchor="end" fontSize={11} fill="currentColor" className="text-zinc-600 dark:text-zinc-300">{c}</text>
                    {segs.map(({ v, si }, k) => {
                      const w = ((normalize ? v / (totals[ci] || 1) : v) / max) * innerW;
                      const last = k === segs.length - 1;
                      const drawW = Math.max(0, w - (last ? 0 : GAP));
                      const d = last ? barPath(cursor, by, drawW, thick, 'right') : `M${cursor},${by}h${drawW}v${thick}h${-drawW}Z`;
                      cursor += w;
                      return <path key={si} d={d} fill={colors[si]} />;
                    })}
                    {!normalize && (
                      <text x={cursor + 6} y={by + thick / 2 + 3.5} fontSize={11} fontWeight={600} fill="currentColor" className="num text-zinc-800 dark:text-zinc-200">{valueFormat(totals[ci])}</text>
                    )}
                  </g>
                );
              })}
            </svg>
          )}
          <TooltipBox tip={tip} width={width} />
        </div>
        {legend}
        {sr}
      </div>
    );
  }

  const h = height ?? 200;
  const ticks = normalize ? [0, 0.25, 0.5, 0.75, 1] : niceTicks(0, Math.max(...totals), 4, isIntegerData(series.flatMap((s) => s.values)));
  const hi = ticks[ticks.length - 1] || 1;
  const tickFmt = (t: number) => (normalize ? formatPercent(t) : valueFormat(t));
  const tickW = Math.max(...ticks.map((t) => tickFmt(t).length)) * 6 + 10;
  const pad = { l: tickW, r: 8, t: 10, b: 22 };
  const innerW = Math.max(10, width - pad.l - pad.r);
  const innerH = h - pad.t - pad.b;
  const slot = innerW / categories.length;
  const bw = Math.max(3, Math.min(24, slot * 0.6));
  const y = (v: number) => pad.t + (1 - v / hi) * innerH;
  const labelEvery = Math.max(1, Math.ceil(categories.length / Math.max(1, Math.floor(innerW / 56))));

  return (
    <div className={cls('min-w-0', className)}>
      <div ref={ref} className="relative" style={{ height: h }}>
        {width > 0 && (
          <svg width={width} height={h} className="block" role="img" aria-label={title ?? 'Stacked bar chart'}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} {...GRID} />
                <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" {...AXIS_TEXT} className="num">{tickFmt(t)}</text>
              </g>
            ))}
            {categories.map((c, ci) => {
              const cx = pad.l + slot * (ci + 0.5);
              let acc = 0;
              const segs = series.map((s, si) => ({ v: Math.max(0, s.values[ci] ?? 0), si })).filter((x) => x.v > 0);
              return (
                <g key={ci} onPointerEnter={() => tipFor(ci, cx, y(normalize ? 1 : totals[ci]))} onPointerLeave={hide}>
                  <rect x={cx - slot / 2} y={pad.t} width={slot} height={innerH} fill="transparent" />
                  {segs.map(({ v, si }, k) => {
                    const val = normalize ? v / (totals[ci] || 1) : v;
                    const y0 = y(acc);
                    acc += val;
                    const y1 = y(acc);
                    const last = k === segs.length - 1;
                    const segH = Math.max(0, y0 - y1 - (last ? 0 : GAP));
                    const top = y0 - segH;
                    const d = last ? barPath(cx - bw / 2, top, bw, segH, 'up') : `M${cx - bw / 2},${top}h${bw}v${segH}h${-bw}Z`;
                    return <path key={si} d={d} fill={colors[si]} />;
                  })}
                  {ci % labelEvery === 0 && <text x={cx} y={h - 6} textAnchor="middle" {...AXIS_TEXT}>{c}</text>}
                </g>
              );
            })}
          </svg>
        )}
        <TooltipBox tip={tip} width={width} />
      </div>
      {legend}
      {sr}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Donut
// ---------------------------------------------------------------------------------------------

export interface DonutDatum {
  label: string;
  value: number;
  color?: string;
}

export function Donut({ data, size = 140, thickness = 18, centerValue, centerLabel, legend = true, valueFormat = defaultFormat, title, className }: {
  data: DonutDatum[];
  size?: number;
  thickness?: number;
  /** Big number in the hole (default: the total). */
  centerValue?: ReactNode;
  centerLabel?: ReactNode;
  legend?: boolean;
  valueFormat?: ValueFormat;
  title?: string;
  className?: string;
}) {
  const { tip, show, hide } = useTooltip();
  const [active, setActive] = useState<number | null>(null);
  const parts = data.filter((d) => Number.isFinite(d.value) && d.value > 0);
  const total = parts.reduce((s, d) => s + d.value, 0);
  const colors = data.map((d, i) => safeColor(d.color, seriesColor(i)));
  if (total === 0) return <div className={className}><NoData height={size} /></div>;

  const r = (size - thickness) / 2;
  const c = 2 * Math.PI * r;
  const GAP = parts.length > 1 ? 2 : 0;
  let offset = 0;

  return (
    <div className={cls('flex min-w-0 flex-wrap items-center gap-5', className)}>
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90" role="img" aria-label={title ?? 'Donut chart'}>
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--chart-grid)" strokeWidth={thickness} opacity={0.5} />
          {data.map((d, i) => {
            if (!(d.value > 0)) return null;
            const len = (d.value / total) * c;
            const seg = (
              <circle
                key={i}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={colors[i]}
                strokeWidth={active === i ? thickness + 3 : thickness}
                strokeDasharray={`${Math.max(0.5, len - GAP)} ${c - Math.max(0.5, len - GAP)}`}
                strokeDashoffset={-offset}
                style={{ pointerEvents: 'stroke', transition: 'stroke-width .15s' }}
                onPointerMove={(e) => {
                  const box = e.currentTarget.ownerSVGElement?.getBoundingClientRect();
                  setActive(i);
                  show({
                    x: box ? e.clientX - box.left : size / 2, y: box ? e.clientY - box.top : size / 2,
                    rows: [{ label: d.label, value: `${valueFormat(d.value)} · ${formatPercent(d.value / total)}`, color: colors[i], shape: 'rect' }],
                  });
                }}
                onPointerLeave={() => {
                  setActive(null);
                  hide();
                }}
              />
            );
            offset += len;
            return seg;
          })}
        </svg>
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            <div className="text-xl font-bold leading-none tracking-tight text-zinc-900 dark:text-white">{centerValue ?? valueFormat(total)}</div>
            {centerLabel && <div className="label-xs mt-1">{centerLabel}</div>}
          </div>
        </div>
        <TooltipBox tip={tip} width={size} />
      </div>
      {legend && (
        <div className="min-w-[140px] flex-1 space-y-1.5">
          {data.map((d, i) => (
            <div
              key={d.label}
              className={cls('flex items-center gap-2 text-xs transition-opacity', active !== null && active !== i && 'opacity-50')}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            >
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: colors[i] }} />
              <span className="min-w-0 flex-1 truncate text-zinc-600 dark:text-zinc-300">{d.label}</span>
              <span className="num font-semibold text-zinc-900 dark:text-zinc-100">{valueFormat(d.value)}</span>
              <span className="num w-9 text-right text-faint">{formatPercent(total ? d.value / total : 0)}</span>
            </div>
          ))}
        </div>
      )}
      <SrTable caption={title} head={['', 'Value', 'Share']} rows={data.map((d) => [d.label, valueFormat(d.value), formatPercent(total ? d.value / total : 0)])} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Heatmap (rows × columns, sequential brand ramp) — e.g. bottleneck hours per blueprint stage
// ---------------------------------------------------------------------------------------------

export function Heatmap({ rows, cols, values, valueFormat = defaultFormat, max, cellHeight = 34, emptyLabel = '—', title, className }: {
  rows: string[];
  cols: string[];
  /** values[row][col]; null = no data for that cell. */
  values: Array<Array<number | null>>;
  valueFormat?: ValueFormat;
  /** Value mapped to the darkest step (default: the data maximum). */
  max?: number;
  cellHeight?: number;
  emptyLabel?: string;
  title?: string;
  className?: string;
}) {
  const [ref, width, box] = useWidth<HTMLDivElement>();
  const { tip, show, hide } = useTooltip();
  const flat = values.flat().filter((v): v is number => v !== null && Number.isFinite(v));
  if (rows.length === 0 || cols.length === 0 || flat.length === 0) return <div className={className}><NoData height={120} /></div>;
  const top = max ?? Math.max(...flat, 0);
  const labelW = Math.min(200, Math.max(70, Math.max(...rows.map((r) => r.length)) * 6.4 + 12));

  return (
    <div className={cls('min-w-0', className)}>
      <div ref={ref} className="relative overflow-x-auto">
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `${labelW}px repeat(${cols.length}, minmax(48px, 1fr))` }}>
          <div />
          {cols.map((c) => (
            <div key={c} className="truncate px-1 pb-1 text-center text-[10px] font-semibold text-zinc-500 dark:text-zinc-400" title={c}>{c}</div>
          ))}
          {rows.map((r, ri) => (
            <div key={r} className="contents">
              <div className="truncate pr-2 text-right text-[11px] text-zinc-600 dark:text-zinc-300" title={r} style={{ lineHeight: `${cellHeight}px` }}>{r}</div>
              {cols.map((c, ci) => {
                const v = values[ri]?.[ci] ?? null;
                const t = v === null || top <= 0 ? 0 : Math.max(0, Math.min(1, v / top));
                return (
                  <div
                    key={c}
                    className={cls('grid place-items-center rounded text-[10px] font-semibold num transition-[filter] hover:brightness-110',
                      v === null && 'hatched')}
                    style={{
                      height: cellHeight,
                      background: v === null ? undefined : `rgba(0, 148, 100, ${0.07 + 0.88 * t})`,
                      color: t > 0.55 ? '#fff' : undefined,
                    }}
                    onPointerEnter={(e) => {
                      const frame = box.current?.getBoundingClientRect();
                      const cell = e.currentTarget.getBoundingClientRect();
                      if (frame) show({ x: cell.left - frame.left + cell.width / 2, y: cell.top - frame.top + cell.height / 2, title: r, rows: [{ label: c, value: v === null ? emptyLabel : valueFormat(v) }] });
                    }}
                    onPointerLeave={hide}
                  >
                    <span className={t > 0.55 ? '' : 'text-zinc-700 dark:text-zinc-200'}>{v === null ? '' : valueFormat(v)}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <TooltipBox tip={tip} width={width} />
      </div>
      <SrTable caption={title} head={['', ...cols]} rows={rows.map((r, ri) => [r, ...cols.map((_, ci) => {
        const v = values[ri]?.[ci];
        return v === null || v === undefined ? emptyLabel : valueFormat(v);
      })])} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Sparkline (fixed size, for tiles and table cells)
// ---------------------------------------------------------------------------------------------

export function Sparkline({ values, width = 120, height = 32, color, area = true, className }: {
  values: number[];
  width?: number;
  height?: number;
  color?: string;
  area?: boolean;
  className?: string;
}) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 2) return <svg width={width} height={height} className={className} aria-hidden />;
  const stroke = safeColor(color, seriesColor(0));
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pad = 4;
  const x = (i: number) => pad + (i / (v.length - 1)) * (width - pad * 2);
  const y = (n: number) => pad + (1 - (n - min) / (max - min || 1)) * (height - pad * 2);
  const d = v.map((n, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(n).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} className={className} aria-hidden>
      {area && <path d={`${d}L${x(v.length - 1)},${height - pad}L${x(0)},${height - pad}Z`} fill={stroke} fillOpacity={0.1} />}
      <path d={d} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(v.length - 1)} cy={y(v[v.length - 1])} r={3.5} fill={stroke} stroke="var(--chart-surface)" strokeWidth={2} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Funnel (ordered stages: detected → accepted → active → done)
// ---------------------------------------------------------------------------------------------

export interface FunnelStage {
  label: string;
  value: number;
}

export function Funnel({ stages, valueFormat = defaultFormat, onSelect, title, className }: {
  stages: FunnelStage[];
  valueFormat?: ValueFormat;
  onSelect?: (stage: FunnelStage, index: number) => void;
  title?: string;
  className?: string;
}) {
  const max = Math.max(...stages.map((s) => s.value), 0);
  if (stages.length === 0 || max === 0) return <div className={className}><NoData height={120} /></div>;
  return (
    <div className={cls('min-w-0 space-y-1', className)}>
      {stages.map((s, i) => {
        const prev = i > 0 ? stages[i - 1].value : null;
        const pct = Math.max(2, (s.value / max) * 100);
        // Ordinal ramp on one hue: the first stage is the full brand step, later stages lighten but
        // stay well clear of the surface.
        const alpha = 1 - (i / Math.max(1, stages.length - 1)) * 0.5;
        const Tag = onSelect ? 'button' : 'div';
        return (
          <div key={s.label}>
            {prev !== null && (
              <div className="py-0.5 text-center text-[10px] text-faint">
                ↓ <span className="num font-semibold">{prev > 0 ? formatPercent(s.value / prev) : '—'}</span> conversion
              </div>
            )}
            <Tag
              {...(onSelect ? { type: 'button' as const, onClick: () => onSelect(s, i) } : {})}
              className={cls('flex w-full items-center gap-3 text-left', onSelect && 'group')}
            >
              <span className="w-28 shrink-0 truncate text-right text-xs text-zinc-600 dark:text-zinc-300">{s.label}</span>
              <span className="flex min-w-0 flex-1 justify-center">
                <span
                  className="flex h-8 items-center justify-center rounded-md text-xs font-bold text-white transition-[filter] group-hover:brightness-110"
                  style={{ width: `${pct}%`, background: `rgba(0, 148, 100, ${alpha})` }}
                >
                  <span className="num px-2">{pct > 14 ? valueFormat(s.value) : ''}</span>
                </span>
              </span>
              <span className="num w-12 shrink-0 text-xs font-semibold text-zinc-800 dark:text-zinc-200">{valueFormat(s.value)}</span>
            </Tag>
          </div>
        );
      })}
      <SrTable caption={title} head={['Stage', 'Count']} rows={stages.map((s) => [s.label, valueFormat(s.value)])} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Gauge (semicircle meter)
// ---------------------------------------------------------------------------------------------

export function Gauge({ value, min = 0, max = 100, label, size = 160, thresholds, format, className }: {
  value: number | null | undefined;
  min?: number;
  max?: number;
  label?: ReactNode;
  size?: number;
  /**
   * Severity colouring: values past `warn` turn amber, past `bad` rose. `higherIsBetter` flips the
   * direction (on-time %, first-pass rate). Without thresholds the fill is brand green.
   */
  thresholds?: { warn: number; bad: number; higherIsBetter?: boolean };
  format?: ValueFormat;
  className?: string;
}) {
  const fmt = format ?? ((v: number) => `${Math.round(v)}`);
  const known = value !== null && value !== undefined && Number.isFinite(value);
  const t = known ? Math.max(0, Math.min(1, ((value as number) - min) / (max - min || 1))) : 0;
  let color = seriesColor(0);
  if (known && thresholds) {
    const v = value as number;
    const { warn, bad, higherIsBetter } = thresholds;
    const isBad = higherIsBetter ? v <= bad : v >= bad;
    const isWarn = higherIsBetter ? v <= warn : v >= warn;
    color = isBad ? '#e11d48' : isWarn ? '#f59e0b' : '#10b981';
  }
  const stroke = Math.max(8, size * 0.09);
  const r = (size - stroke) / 2;
  const cx = size / 2;
  const cy = size / 2;
  const half = Math.PI * r;
  const h = size / 2 + stroke;
  return (
    <div className={cls('inline-flex flex-col items-center', className)}>
      <svg width={size} height={h} role="img" aria-label={`${typeof label === 'string' ? label : 'Gauge'}: ${known ? fmt(value as number) : 'no data'}`}>
        <path d={`M${stroke / 2},${cy} A${r},${r} 0 0 1 ${size - stroke / 2},${cy}`} fill="none" stroke="var(--chart-grid)" strokeWidth={stroke} strokeLinecap="round" />
        {known && t > 0 && (
          <path
            d={`M${stroke / 2},${cy} A${r},${r} 0 0 1 ${size - stroke / 2},${cy}`}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${t * half} ${half}`}
            style={{ transition: 'stroke-dasharray .5s' }}
          />
        )}
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize={size * 0.17} fontWeight={700} fill="currentColor" className="text-zinc-900 dark:text-white">
          {known ? fmt(value as number) : '—'}
        </text>
      </svg>
      {label && <div className="label-xs -mt-1 text-center">{label}</div>}
    </div>
  );
}
