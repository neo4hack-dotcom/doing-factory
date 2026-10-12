// Portfolio tree: parents with the child projects their fan-out steps started (e.g. a use case and
// one MCP Delivery per missing server), with "children delivered" progress on each parent.
import { ChevronDown, ChevronRight, CornerDownRight } from 'lucide-react';
import { useState } from 'react';
import { PipelineStrip } from '../../components/PipelineStrip';
import { IconButton, ProgressBar, StatusBadge } from '../../components/ui';
import { cls } from '../../lib/cls';
import { timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import type { ProjectSummary } from '../../types';
import { BlueprintChip, PriorityFlag, RiskBadge } from './bits';
import { buildTree } from './model';
import type { TreeNode } from './model';

export function PortfolioTree({ items }: { items: ProjectSummary[] }) {
  const roots = buildTree(items);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setCollapsed((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const families = roots.filter((r) => r.children.length > 0).length;

  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b hairline px-4 py-2.5">
        <span className="label-xs">{roots.length} top-level · {families} with child projects</span>
        <span className="flex gap-1">
          <button type="button" className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => setCollapsed(new Set())}>Expand all</button>
          <span className="text-faint">·</span>
          <button type="button" className="text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400"
            onClick={() => setCollapsed(new Set(roots.filter((r) => r.children.length).map((r) => r.summary.id)))}>Collapse all</button>
        </span>
      </div>
      <div className="divide-y divide-zinc-100 dark:divide-ink-600">
        {roots.map((node) => (
          <TreeRow key={node.summary.id} node={node} depth={0} collapsed={collapsed} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}

function TreeRow({ node, depth, collapsed, onToggle }: {
  node: TreeNode; depth: number; collapsed: Set<string>; onToggle: (id: string) => void;
}) {
  const p = node.summary;
  const hasKids = node.children.length > 0;
  const open = !collapsed.has(p.id);
  const childRatio = p.child_count ? p.children_done / p.child_count : 0;
  return (
    <>
      <div className={cls('flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-ink-700/40', depth > 0 && 'bg-zinc-50/40 dark:bg-ink-900/20')}>
        <div className="flex shrink-0 items-center" style={{ paddingLeft: depth * 22 }}>
          {hasKids ? (
            <IconButton icon={open ? ChevronDown : ChevronRight} label={open ? 'Collapse children' : 'Expand children'} size="xs" onClick={() => onToggle(p.id)} />
          ) : depth > 0 ? (
            <CornerDownRight size={13} className="mx-1.5 text-zinc-300 dark:text-ink-400" />
          ) : <span className="w-6" />}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="num shrink-0 text-[11px] font-bold text-muted">{p.key}</span>
            <PriorityFlag priority={p.priority} />
            <Link to={paths.project(p.id)} className="truncate text-sm font-semibold text-zinc-900 hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400">{p.title}</Link>
            <StatusBadge kind="project" value={p.status} size="xs" />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <BlueprintChip blueprintId={p.blueprint_id} name={p.blueprint_name} />
            {node.orphan && <span className="text-[11px] text-faint">child of a project outside these filters</span>}
          </div>
        </div>
        {p.child_count > 0 ? (
          <div className="hidden w-48 shrink-0 md:block">
            <ProgressBar value={childRatio} tone={childRatio >= 1 ? 'emerald' : 'indigo'} size="xs" label={`${p.children_done}/${p.child_count} children delivered`} showValue />
          </div>
        ) : <div className="hidden w-48 shrink-0 md:block" />}
        <PipelineStrip summary={p} size="sm" className="hidden w-44 shrink-0 lg:block" />
        <RiskBadge risk={p.risk} />
        <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted sm:block">{timeAgo(p.updated_at)}</span>
      </div>
      {hasKids && open && node.children.map((c) => (
        <TreeRow key={c.summary.id} node={c} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} />
      ))}
    </>
  );
}
