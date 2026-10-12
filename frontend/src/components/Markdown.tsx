// Dependency-free Markdown renderer (ported from DOINg.MCP, hardened).
//
// Safety: output is built as React elements — never dangerouslySetInnerHTML — so LLM text (which
// may echo tool output or user data) cannot inject markup; raw HTML is limited to a whitelist and
// URLs to http(s)/mailto/relative/hash. Robustness: every branch of the block parser consumes at
// least one line, so no input can stall it (the original hung the tab on "```c++", "``` js",
// "````" and "```py title=x" — see tests/markdown.test.tsx).
//
// Extras: GFM tables, task lists, ~~~ fences, and the DOINg.AI ```chart fenced-block protocol:
//   ```chart
//   {"type": "bar" | "donut" | "kpi", "title": "…", "data": [{"label": "…", "value": 5, "color": "#009464"}]}
//   ```
// rendered as inline SVG; an invalid spec degrades to a JSON code block.
import { createElement } from 'react';
import type { ReactNode } from 'react';
import { cls } from '../lib/cls';
import { formatCompact } from '../lib/format';
import { BarChart, Donut, safeColor, seriesColor } from './Charts';

export type MarkdownSize = 'xs' | 'sm';

interface Styles {
  root: string;
  h1: string;
  h2: string;
  h3: string;
  code: string;
  pre: string;
  table: string;
}

const SIZES: Record<MarkdownSize, Styles> = {
  xs: {
    root: 'space-y-1.5 text-xs leading-relaxed',
    h1: 'text-sm', h2: 'text-[13px]', h3: 'text-xs',
    code: 'text-[11px]', pre: 'text-[11px]', table: 'text-[11px]',
  },
  sm: {
    root: 'space-y-2.5 text-sm leading-relaxed',
    h1: 'text-lg', h2: 'text-base', h3: 'text-sm',
    code: 'text-[12px]', pre: 'text-[12px]', table: 'text-xs',
  },
};

const CLS = {
  a: 'font-medium text-brand-600 underline decoration-brand-500/40 underline-offset-2 hover:decoration-brand-500 dark:text-brand-400',
  code: 'rounded bg-zinc-100 px-1 py-0.5 font-mono text-brand-700 dark:bg-ink-600 dark:text-brand-300',
  pre: 'overflow-auto rounded-lg border border-zinc-800 bg-ink-900 p-3 font-mono leading-relaxed text-zinc-100',
  table: 'w-full border-collapse',
  th: 'border border-zinc-200 bg-zinc-50 px-2.5 py-1.5 text-left font-semibold dark:border-ink-500 dark:bg-ink-700',
  td: 'border border-zinc-200 px-2.5 py-1.5 align-top dark:border-ink-500',
  ul: 'list-disc space-y-1 pl-5 marker:text-zinc-400',
  ol: 'list-decimal space-y-1 pl-5 marker:text-zinc-400',
  task: 'flex items-start gap-2',
  quote: 'border-l-2 border-brand-500/50 pl-3 text-zinc-600 dark:text-zinc-400',
  h: 'font-bold tracking-tight text-zinc-900 dark:text-white',
  hr: 'border-zinc-200 dark:border-ink-500',
};

/** Only http(s), mailto, hash and relative URLs survive; everything else (javascript:, data:…) becomes '#'. */
export function safeUrl(url: string): string {
  const u = url.trim();
  return /^(https?:|mailto:|#|\/(?!\/))/i.test(u) ? u : '#';
}

function linkProps(href: string): Record<string, string> {
  // In-app hash routes stay in this tab; external links open a new one without an opener.
  return href.startsWith('#') || href.startsWith('/') ? { href } : { href, target: '_blank', rel: 'noopener noreferrer' };
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const INLINE: { name: string; re: RegExp }[] = [
  { name: 'code', re: /`([^`]+?)`/ },
  { name: 'bold', re: /\*\*([\s\S]+?)\*\*/ },
  { name: 'boldu', re: /__([\s\S]+?)__/ },
  { name: 'strike', re: /~~([\s\S]+?)~~/ },
  { name: 'italic', re: /\*([^*\n]+?)\*/ },
  { name: 'italicu', re: /(?<![A-Za-z0-9])_([^_\n]+?)_(?![A-Za-z0-9])/ },
  { name: 'link', re: /\[([^\]]+?)\]\(([^)\s]+?)\)/ },
  { name: 'autolink', re: /(https?:\/\/[^\s)<>]+)/ },
];

function inline(text: string, key: string, s: Styles): ReactNode[] {
  if (!text) return [];
  let best: { name: string; m: RegExpExecArray } | null = null;
  for (const p of INLINE) {
    const m = p.re.exec(text);
    if (m && (best === null || m.index < best.m.index)) best = { name: p.name, m };
  }
  if (!best) return [text];
  const { m, name } = best;
  const before = text.slice(0, m.index);
  const after = text.slice(m.index + m[0].length);
  const k = `${key}_${m.index}`;
  let node: ReactNode;
  if (name === 'code') node = <code key={k} className={cls(CLS.code, s.code)}>{m[1]}</code>;
  else if (name === 'bold' || name === 'boldu') node = <strong key={k} className="font-semibold">{inline(m[1], k, s)}</strong>;
  else if (name === 'italic' || name === 'italicu') node = <em key={k}>{inline(m[1], k, s)}</em>;
  else if (name === 'strike') node = <del key={k}>{inline(m[1], k, s)}</del>;
  else if (name === 'link') node = <a key={k} className={CLS.a} {...linkProps(safeUrl(m[2]))}>{inline(m[1], k, s)}</a>;
  else node = <a key={k} className={CLS.a} {...linkProps(safeUrl(m[1]))}>{m[1]}</a>;
  return [...inline(before, `${key}b`, s), node, ...inline(after, `${key}a`, s)];
}

// ---------------------------------------------------------------------------------------------
// Whitelisted raw HTML (rendered from a parsed DOM, never as a string)
// ---------------------------------------------------------------------------------------------

const HTML_CLS: Record<string, string> = {
  a: CLS.a, code: CLS.code, pre: CLS.pre, table: CLS.table, th: CLS.th, td: CLS.td,
  ul: CLS.ul, ol: CLS.ol, blockquote: CLS.quote, hr: CLS.hr,
  strong: 'font-semibold', b: 'font-semibold', em: 'italic', i: 'italic',
  u: 'underline', s: 'line-through', del: 'line-through', small: 'text-[0.85em]',
  h1: CLS.h, h2: CLS.h, h3: CLS.h, h4: CLS.h, h5: CLS.h, h6: CLS.h,
};
const HTML_OK = new Set([...Object.keys(HTML_CLS), 'p', 'br', 'span', 'div', 'thead', 'tbody', 'tr', 'li', 'sup', 'sub']);
const VOID_TAGS = new Set(['br', 'hr']);

function htmlNode(node: ChildNode, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;  // text
  if (node.nodeType !== 1) return null;               // comments, processing instructions…
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'iframe' || tag === 'object') return null;
  const children = Array.from(el.childNodes).map((c, i) => htmlNode(c, `${key}_${i}`));
  if (!HTML_OK.has(tag)) return <span key={key}>{children}</span>; // unknown tags unwrap to text
  const props: Record<string, unknown> = { key, className: HTML_CLS[tag] };
  if (VOID_TAGS.has(tag)) return createElement(tag, props);
  if (tag === 'a') Object.assign(props, linkProps(safeUrl(el.getAttribute('href') ?? '')));
  return createElement(tag, props, children.length ? children : undefined);
}

function renderHtml(html: string, key: string): ReactNode {
  // No DOMParser (tests, SSR): show the source as text rather than guess.
  if (typeof DOMParser === 'undefined') return <p key={key} className="whitespace-pre-wrap">{html}</p>;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return <div key={key} className="space-y-1">{Array.from(doc.body.childNodes).map((n, i) => htmlNode(n, `${key}_${i}`))}</div>;
}

// ---------------------------------------------------------------------------------------------
// ```chart blocks
// ---------------------------------------------------------------------------------------------

export interface ChartSpec {
  type: 'bar' | 'donut' | 'kpi';
  title?: string;
  data: Array<{ label: string; value: number; color?: string }>;
}

/** Parses a ```chart block body; null when it is not a valid, renderable spec. */
export function parseChartSpec(source: string): ChartSpec | null {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const spec = raw as { type?: unknown; title?: unknown; data?: unknown };
  if (spec.type !== 'bar' && spec.type !== 'donut' && spec.type !== 'kpi') return null;
  if (!Array.isArray(spec.data)) return null;
  const data = spec.data
    .filter((d): d is { label: unknown; value: unknown; color?: unknown } => !!d && typeof d === 'object')
    .map((d) => ({
      label: String(d.label ?? ''),
      value: typeof d.value === 'number' ? d.value : Number(d.value),
      color: typeof d.color === 'string' ? d.color : undefined,
    }))
    .filter((d) => d.label && Number.isFinite(d.value))
    .slice(0, 20);
  if (data.length === 0) return null;
  return { type: spec.type, title: typeof spec.title === 'string' ? spec.title : undefined, data };
}

function ChartBlock({ spec }: { spec: ChartSpec }) {
  return (
    <figure className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-ink-500 dark:bg-ink-800">
      {spec.title && <figcaption className="label-xs mb-2.5">{spec.title}</figcaption>}
      {spec.type === 'bar' && <BarChart data={spec.data} orientation="horizontal" title={spec.title} />}
      {spec.type === 'donut' && <Donut data={spec.data} size={120} thickness={16} title={spec.title} />}
      {spec.type === 'kpi' && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {spec.data.map((d, i) => (
            <div key={i} className="rounded-md border border-zinc-200 bg-zinc-50 p-2.5 dark:border-ink-500 dark:bg-ink-700"
              style={{ borderTopWidth: 3, borderTopColor: safeColor(d.color, seriesColor(i)) }}>
              <div className="label-xs truncate" title={d.label}>{d.label}</div>
              <div className="mt-1 text-xl font-bold tracking-tight text-zinc-900 dark:text-white">{formatCompact(d.value)}</div>
            </div>
          ))}
        </div>
      )}
    </figure>
  );
}

// ---------------------------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------------------------

const HTML_BLOCK = /^<(table|ul|ol|pre|blockquote|h[1-6]|div|p|details)\b/i;
/** Opening fence: 3+ backticks or tildes, then ANY info string ("c++", " js", "py title=x"). */
const FENCE_OPEN = /^(`{3,}|~{3,})\s*([^`\s]*)?.*$/;

/** A fence opener, unless a backtick fence has backticks in its info string (inline ```code```). */
function fenceOpen(trimmed: string): RegExpExecArray | null {
  const m = FENCE_OPEN.exec(trimmed);
  if (m && m[1][0] === '`' && trimmed.slice(m[1].length).includes('`')) return null;
  return m;
}
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^(-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?/;

const isDelim = (s: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(s) && s.includes('-');
const cells = (s: string) => s.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

function startsBlock(lines: string[], i: number): boolean {
  const t = lines[i].trim();
  return !!fenceOpen(t) || HTML_BLOCK.test(t) || HEADING.test(lines[i]) || QUOTE.test(lines[i])
    || LIST_ITEM.test(lines[i]) || HR.test(t)
    || (lines[i].includes('|') && i + 1 < lines.length && isDelim(lines[i + 1]));
}

function parseBlocks(src: string, s: Styles): ReactNode[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code (and ```chart blocks). The closing fence must use the same character and be at
    // least as long; an unclosed fence runs to the end of the text.
    const fence = fenceOpen(trimmed);
    if (fence) {
      const marker = fence[1];
      const lang = (fence[2] ?? '').toLowerCase();
      const close = new RegExp(`^${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
      const buf: string[] = [];
      i++;
      while (i < lines.length && !close.test(lines[i].trim())) buf.push(lines[i++]);
      i++; // closing fence (or past the end)
      const body = buf.join('\n');
      if (lang === 'chart') {
        const spec = parseChartSpec(body);
        if (spec) {
          out.push(<ChartBlock key={key()} spec={spec} />);
          continue;
        }
      }
      out.push(<pre key={key()} className={cls(CLS.pre, s.pre)}><code>{body}</code></pre>);
      continue;
    }

    // Raw HTML block (whitelisted on render): consume until the opening tag is balanced.
    if (HTML_BLOCK.test(trimmed)) {
      const tag = /^<(\w+)/.exec(trimmed)![1].toLowerCase();
      const openRe = new RegExp(`<${tag}\\b`, 'gi');
      const closeRe = new RegExp(`</${tag}>`, 'gi');
      const buf: string[] = [];
      let depth = 0;
      do {
        const l = lines[i];
        buf.push(l);
        depth += (l.match(openRe)?.length ?? 0) - (l.match(closeRe)?.length ?? 0);
        i++;
      } while (i < lines.length && depth > 0);
      out.push(renderHtml(buf.join('\n'), key()));
      continue;
    }

    const h = HEADING.exec(line);
    if (h) {
      const level = h[1].length;
      const size = level === 1 ? s.h1 : level === 2 ? s.h2 : s.h3;
      out.push(createElement(`h${level}`, { key: key(), className: cls(CLS.h, size, 'pt-1') }, inline(h[2], key(), s)));
      i++;
      continue;
    }

    if (HR.test(trimmed)) {
      out.push(<hr key={key()} className={CLS.hr} />);
      i++;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && isDelim(lines[i + 1])) {
      const header = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const k = key();
      out.push(
        <div key={k} className="overflow-x-auto">
          <table className={cls(CLS.table, s.table)}>
            <thead><tr>{header.map((c, j) => <th key={j} className={CLS.th}>{inline(c, `${k}h${j}`, s)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{header.map((_, ci) => <td key={ci} className={CLS.td}>{inline(r[ci] ?? '', `${k}c${ri}_${ci}`, s)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (QUOTE.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) buf.push(lines[i++].replace(QUOTE, ''));
      out.push(<blockquote key={key()} className={CLS.quote}>{parseBlocks(buf.join('\n'), s)}</blockquote>);
      continue;
    }

    const first = LIST_ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]);
      const baseIndent = first[1].length;
      const items: Array<{ text: string; depth: number }> = [];
      while (i < lines.length) {
        const im = LIST_ITEM.exec(lines[i]);
        if (im) {
          items.push({ text: im[3], depth: Math.min(3, Math.max(0, Math.floor((im[1].length - baseIndent) / 2))) });
          i++;
        } else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i]) && !startsBlock(lines, i)) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // lazy continuation line
          i++;
        } else break;
      }
      const k = key();
      out.push(createElement(ordered ? 'ol' : 'ul', { key: k, className: ordered ? CLS.ol : CLS.ul }, items.map((it, j) => {
        const task = /^\[([ xX])\]\s+(.*)$/.exec(it.text);
        const indent = it.depth ? { marginLeft: `${it.depth * 1.25}rem` } : undefined;
        if (task) {
          return (
            <li key={j} className={cls(CLS.task, 'list-none -ml-5')} style={indent}>
              <input type="checkbox" checked={task[1] !== ' '} readOnly disabled className="mt-1 h-3.5 w-3.5 shrink-0 accent-brand-500" />
              <span className={task[1] !== ' ' ? 'text-zinc-500 line-through decoration-zinc-400' : ''}>{inline(task[2], `${k}t${j}`, s)}</span>
            </li>
          );
        }
        return <li key={j} style={indent}>{inline(it.text, `${k}i${j}`, s)}</li>;
      })));
      continue;
    }

    // Paragraph: consecutive plain lines (single newlines become <br>). Always consumes the current
    // line even if a later check would call it a block start — the guarantee that the loop advances.
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) para.push(lines[i++]);
    const k = key();
    const parts: ReactNode[] = [];
    para.forEach((p, idx) => {
      if (idx > 0) parts.push(<br key={`${k}br${idx}`} />);
      parts.push(...inline(p, `${k}p${idx}`, s));
    });
    out.push(<p key={k}>{parts}</p>);
  }
  return out;
}

/** Renders Markdown safely. `size="xs"` for chat bubbles and compact panels, `"sm"` (default) for documents. */
export function Markdown({ content, size = 'sm', className }: { content: string; size?: MarkdownSize; className?: string }) {
  const s = SIZES[size];
  return <div className={cls('min-w-0 break-words text-zinc-700 dark:text-zinc-300', s.root, className)}>{parseBlocks(content ?? '', s)}</div>;
}
