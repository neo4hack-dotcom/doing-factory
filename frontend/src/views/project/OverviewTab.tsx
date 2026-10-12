// Project page › Overview: the AI summary, the request (description + inputs), what the workflow
// produced so far (key vars, each traced to its step), external links (Jira, MCP, docs), and —
// for a project with dependencies or fan-out children — their progress and the dependency graph.
import { ArrowUpRight, ExternalLink, FileText, GitFork, Link2, Network, Sparkles, Variable } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { DependencyGraph } from '../../components/DependencyGraph';
import { Markdown, safeUrl } from '../../components/Markdown';
import { Button, Card, CardHeader, EmptyState, ProgressBar, StatusBadge } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatPercent, humanize, timeAgo } from '../../lib/format';
import { Link as RouteLink, paths } from '../../lib/router';
import type { Link, LinkKind, Project, ProjectSummary } from '../../types';
import { AiChip, AiWorking } from '../task/common';
import { varSourceStep } from './model';
import { VarValue } from './values';

const LINK_ICON: Record<LinkKind, LucideIcon> = { jira: ArrowUpRight, mcp: Network, url: Link2, doc: FileText };

export function OverviewTab({ project, childSummaries, parent, summarizing, onSummarize, onOpenStep }: {
  project: Project;
  childSummaries: ProjectSummary[];
  parent: Pick<ProjectSummary, 'id' | 'key' | 'title' | 'status'> | null;
  summarizing: boolean;
  onSummarize: () => void;
  onOpenStep: (stepId: string) => void;
}) {
  const inputs = Object.entries(project.inputs ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined);
  const vars = Object.entries(project.vars ?? {}).filter(([k]) => !k.startsWith('_') && k !== 'dependencies');
  const hasGraph = project.vars?.dependencies !== undefined || project.child_ids.length > 0 || !!project.parent_id;

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
      <div className="min-w-0 space-y-5">
        <Card padding="none" tone={project.ai_summary ? 'ai' : 'default'}>
          <CardHeader
            title={<span className="inline-flex items-center gap-2">AI summary {project.ai_summary && <AiChip />}</span>}
            icon={Sparkles}
            iconTone="violet"
            actions={<Button size="xs" variant="ai" icon={Sparkles} busy={summarizing} onClick={onSummarize}>{project.ai_summary ? 'Refresh' : 'Summarize'}</Button>}
          />
          <div className="px-4 py-3.5">
            {summarizing ? <AiWorking label="The AI is reading the project…" lines={3} />
              : project.ai_summary ? <Markdown content={project.ai_summary} size="xs" />
                : <p className="text-sm text-muted">No summary yet — ask the AI for a status in plain words (where it stands, what blocks, what is next).</p>}
          </div>
        </Card>

        <Card padding="none">
          <CardHeader title="Request" subtitle={`${humanize(project.source?.type || 'manual')} · created ${timeAgo(project.created_at)}`} icon={FileText} />
          <div className="space-y-4 px-4 py-3.5">
            {project.description ? <Markdown content={project.description} size="xs" /> : <p className="text-sm text-faint">No description.</p>}
            {inputs.length > 0 && (
              <dl className="grid gap-x-4 gap-y-2.5 border-t hairline pt-3.5 sm:grid-cols-[minmax(120px,auto)_1fr]">
                {inputs.map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="label-xs pt-0.5">{humanize(k)}</dt>
                    <dd className="min-w-0"><VarValue value={v} compact /></dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
        </Card>

        <Card padding="none">
          <CardHeader title="Produced so far" subtitle="Workflow variables, each from the step that stored it" icon={Variable} />
          {vars.length === 0 ? (
            <EmptyState compact icon={Variable} title="Nothing produced yet" description="Step outputs land here as the workflow runs." />
          ) : (
            <ul className="divide-y hairline">
              {vars.map(([k, v]) => {
                const src = varSourceStep(project, k);
                return (
                  <li key={k} className="px-4 py-3">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{humanize(k)}</span>
                      {src && (
                        <button type="button" onClick={() => onOpenStep(src.step.id)} className="truncate text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
                          from {src.step.name}
                        </button>
                      )}
                    </div>
                    <div className="max-h-80 overflow-y-auto"><VarValue value={v} compact /></div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      <div className="min-w-0 space-y-5">
        <Card padding="none">
          <CardHeader title="Links" icon={Link2} divider={project.links.length > 0} subtitle={project.links.length ? undefined : 'Jira issues, MCP servers and documents appear here once created.'} />
          {project.links.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-4 py-3.5">
              {project.links.map((l) => <LinkChip key={l.id} link={l} />)}
            </div>
          )}
        </Card>

        {(parent || childSummaries.length > 0 || project.child_ids.length > 0) && (
          <Card padding="none">
            <CardHeader title="Related projects" icon={GitFork} iconTone="indigo"
              subtitle={project.child_ids.length ? `${childSummaries.filter((c) => c.status === 'done').length} of ${project.child_ids.length} children done` : undefined} />
            <ul className="divide-y hairline">
              {parent && (
                <li>
                  <RouteLink to={paths.project(parent.id)} className="flex items-center gap-2 px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-ink-700/30">
                    <span className="label-xs w-14 shrink-0">Parent</span>
                    <span className="num font-mono text-xs font-bold text-muted">{parent.key}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{parent.title}</span>
                    <StatusBadge kind="project" value={parent.status} size="xs" />
                  </RouteLink>
                </li>
              )}
              {project.child_ids.map((cid) => {
                const c = childSummaries.find((x) => x.id === cid);
                return (
                  <li key={cid}>
                    <RouteLink to={paths.project(cid)} className="block px-4 py-2.5 text-sm hover:bg-zinc-50 dark:hover:bg-ink-700/30">
                      <div className="flex items-center gap-2">
                        <span className="num font-mono text-xs font-bold text-muted">{c?.key ?? cid}</span>
                        <span className="min-w-0 flex-1 truncate font-medium">{c?.title ?? 'Child project'}</span>
                        {c && <StatusBadge kind="project" value={c.status} size="xs" />}
                      </div>
                      {c && (
                        <div className="mt-1.5 flex items-center gap-2">
                          <ProgressBar value={c.progress} size="xs" tone={c.status === 'done' ? 'emerald' : 'sky'} className="flex-1" />
                          <span className="num w-9 text-right text-[10px] text-faint">{formatPercent(c.progress)}</span>
                        </div>
                      )}
                    </RouteLink>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      {hasGraph && (
        <Card padding="none" className="xl:col-span-2">
          <CardHeader title="Dependencies" subtitle="What this project needs, what already exists, and the child projects building the rest" icon={Network} iconTone="emerald" />
          <div className="p-3">
            <DependencyGraph project={project} children={childSummaries} parent={parent} />
          </div>
        </Card>
      )}
    </div>
  );
}

export function LinkChip({ link, className }: { link: Link; className?: string }) {
  const Icon = LINK_ICON[link.kind] ?? Link2;
  const url = link.url ? safeUrl(link.url) : '';
  const body = (
    <>
      <Icon size={12} className={link.kind === 'jira' ? 'text-sky-500' : 'text-faint'} />
      {link.kind === 'jira' && link.external_id && <span className="font-mono font-semibold">{link.external_id}</span>}
      <span className="max-w-[16rem] truncate">{link.kind === 'jira' && link.external_id && link.label === link.external_id ? '' : link.label}</span>
      {link.status && <span className="text-faint">· {link.status}</span>}
      {url && <ExternalLink size={11} className="text-faint" />}
    </>
  );
  const base = cls('inline-flex items-center gap-1.5 rounded-md border hairline px-2 py-1 text-xs font-medium', className);
  return url
    ? <a href={url} target="_blank" rel="noopener noreferrer" title={link.url} className={cls(base, 'hover:border-brand-500/60')}>{body}</a>
    : <span className={base} title={humanize(link.kind)}>{body}</span>;
}
