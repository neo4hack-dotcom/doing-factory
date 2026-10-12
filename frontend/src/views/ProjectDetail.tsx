// Project page (#/projects/:id[/:stepId]): the header with the project-level AI actions, the
// pipeline (stage lanes, step nodes; the persona's turn highlighted), and tabs for the overview,
// artifacts, activity, merged trace and raw details. Clicking a step opens the drawer — the
// TaskPanel when the persona can act on it, the read-only step anatomy otherwise (both one toggle
// away). The step id lives in the URL, so a notification or the inbox deep-links straight to it.
// Live: `project.updated` for this project refetches it, child updates patch the children, and
// `step.trace` streams into the Trace tab.
import {
  Activity, ArrowLeft, BarChart3, Braces, FileText, FolderX, LayoutDashboard, ListTree, ScrollText, SearchX, Workflow,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage } from '../api';
import {
  Button, Card, CardHeader, Drawer, EmptyState, ProgressBar, Select, Skeleton, Stat, Tabs, useToast,
} from '../components/ui';
import { formatCompact, formatDateTime, formatNumber, plural, toMs } from '../lib/format';
import { usePageTitle } from '../lib/pageTitle';
import { Link, navigate, paths } from '../lib/router';
import { useApp, useLive } from '../lib/store';
import type { Artifact, Project, ProjectSummary, TraceEntry } from '../types';
import { STEP_TYPES } from '../types';
import TaskPanel from './TaskPanel';
import { ActivityTab } from './project/ActivityTab';
import { ArtifactsTab } from './project/ArtifactsTab';
import { canActOnStep, findStep, mergedTrace, projectProgress, upsertSummary } from './project/model';
import type { StepRef } from './project/model';
import { OverviewTab } from './project/OverviewTab';
import { PipelineLanes } from './project/PipelineLanes';
import { ProjectHeader } from './project/ProjectHeader';
import { StepDetails } from './project/StepDetails';
import { TraceList } from './project/TraceList';
import { JsonView } from './project/values';
import { Segmented } from './task/common';

export interface ProjectDetailProps {
  /** Project id from #/projects/:id. */
  id: string;
  /** Focused step from #/projects/:id/:stepId. */
  stepId?: string;
}

type TabKey = 'overview' | 'artifacts' | 'activity' | 'trace' | 'details';
type ParentRef = Pick<ProjectSummary, 'id' | 'key' | 'title' | 'status'>;

const LIVE_TRACE_CAP = 300;

export default function ProjectDetail({ id, stepId }: ProjectDetailProps) {
  const { me } = useApp();
  const toast = useToast();

  // ---- Project ----------------------------------------------------------------------------------
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState('');
  const [deleted, setDeleted] = useState(false);
  /** Trace entries streamed since the last fetch, per step (merged and deduplicated for display). */
  const [liveTrace, setLiveTrace] = useState<Record<string, TraceEntry[]>>({});
  const current = useRef<Project | null>(null);
  current.current = project;

  /** Accepts a project only when it is at least as fresh as the one shown (out-of-order replies). */
  const accept = useCallback((p: Project) => {
    if (p.id !== id) return;
    setProject((cur) => (!cur || cur.id !== p.id || (toMs(p.updated_at) ?? 0) >= (toMs(cur.updated_at) ?? 0) ? p : cur));
  }, [id]);

  const load = useCallback(async () => {
    try {
      accept(await api.projects.get(id));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [id, accept]);

  useEffect(() => {
    setProject(null);
    setError('');
    setDeleted(false);
    setLiveTrace({});
    void load();
  }, [load]);

  usePageTitle(project ? `${project.key} · ${project.title}` : 'Project');

  // ---- Related projects -------------------------------------------------------------------------
  const [children, setChildren] = useState<ProjectSummary[]>([]);
  const childKey = project?.child_ids.join(',') ?? '';
  useEffect(() => {
    if (!childKey) {
      setChildren([]);
      return;
    }
    let alive = true;
    api.projects.list({ parent_id: id })
      .then((rows) => alive && setChildren(rows))
      .catch(() => alive && setChildren([]));
    return () => {
      alive = false;
    };
  }, [id, childKey]);

  const [parent, setParent] = useState<ParentRef | null>(null);
  const parentId = project?.parent_id ?? '';
  useEffect(() => {
    if (!parentId) {
      setParent(null);
      return;
    }
    let alive = true;
    api.projects.get(parentId)
      .then((p) => alive && setParent({ id: p.id, key: p.key, title: p.title, status: p.status }))
      .catch(() => alive && setParent(null));
    return () => {
      alive = false;
    };
  }, [parentId]);

  // ---- Live -------------------------------------------------------------------------------------
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLive('project.updated', (e) => {
    if (e.project_id === id) {
      const seen = toMs(current.current?.updated_at) ?? 0;
      if ((toMs(e.summary?.updated_at) ?? Infinity) <= seen) return;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void load(), 250);
      return;
    }
    if (e.summary && e.summary.parent_id === id) setChildren((prev) => upsertSummary(prev, e.summary));
    if (e.summary && e.project_id === parentId) setParent({ id: e.summary.id, key: e.summary.key, title: e.summary.title, status: e.summary.status });
  });
  useLive('project.deleted', (e) => {
    if (e.project_id === id) setDeleted(true);
    else setChildren((prev) => prev.filter((c) => c.id !== e.project_id));
  });

  useLive('step.trace', (e) => {
    if (e.project_id !== id || !e.entry) return;
    setLiveTrace((prev) => {
      const list = prev[e.step_id] ?? [];
      return { ...prev, [e.step_id]: [...list.slice(-(LIVE_TRACE_CAP - 1)), e.entry] };
    });
  });

  // ---- Tabs & selection -------------------------------------------------------------------------
  const [tab, setTab] = useState<TabKey>('overview');
  const [artifactId, setArtifactId] = useState('');
  const [traceStep, setTraceStep] = useState('');

  const openStep = useCallback((sid: string) => navigate(paths.project(id, sid)), [id]);
  const closeStep = useCallback(() => navigate(paths.project(id)), [id]);
  const openArtifact = useCallback((aid: string) => {
    setArtifactId(aid);
    setTab('artifacts');
    navigate(paths.project(id));
  }, [id]);

  const [summarizing, setSummarizing] = useState(false);
  const summarize = async () => {
    if (!project) return;
    setSummarizing(true);
    setTab('overview');
    try {
      const { summary } = await api.projects.summarize(project.id);
      setProject((p) => (p ? { ...p, ai_summary: summary } : p));
    } catch (err) {
      toast.error(err);
    } finally {
      setSummarizing(false);
    }
  };

  const onArtifactSaved = useCallback((a: Artifact) => {
    setProject((p) => (p ? { ...p, artifacts: p.artifacts.map((x) => (x.id === a.id ? a : x)) } : p));
  }, []);

  const trace = useMemo(() => (project ? mergedTrace(project, liveTrace) : []), [project, liveTrace]);
  const shownTrace = useMemo(() => (traceStep ? trace.filter((e) => e.step_id === traceStep) : trace), [trace, traceStep]);

  // ---- Render -----------------------------------------------------------------------------------
  if (deleted) {
    return <EmptyState icon={FolderX} title="This project was deleted" description="It no longer exists." action={<Button size="sm" icon={ArrowLeft} onClick={() => navigate(paths.projects())}>All projects</Button>} />;
  }
  if (!project) {
    if (error) {
      return <EmptyState icon={SearchX} title="Project not found" description={error} action={<Button size="sm" icon={ArrowLeft} onClick={() => navigate(paths.projects())}>All projects</Button>} />;
    }
    return (
      <div className="space-y-5">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-44 w-full" />
        <Skeleton lines={6} />
      </div>
    );
  }

  const progress = projectProgress(project);
  const stepRef = findStep(project, stepId);
  const steps = project.stages.flatMap((s) => s.steps);

  return (
    <div className="space-y-5">
      <Link to={paths.projects()} className="inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-zinc-800 no-print dark:hover:text-zinc-200">
        <ArrowLeft size={13} /> Projects
      </Link>

      <ProjectHeader project={project} onChanged={accept} summarizing={summarizing} onSummarize={() => void summarize()} />

      <Card padding="none">
        <CardHeader
          title="Pipeline"
          icon={Workflow}
          subtitle={`${progress.done} of ${plural(progress.total, 'step')} done${project.blueprint_version ? ` · ${project.blueprint_name} v${project.blueprint_version}` : ''}`}
          actions={<div className="hidden w-44 sm:block"><ProgressBar value={progress.ratio} size="sm" tone={project.status === 'done' ? 'emerald' : 'brand'} showValue /></div>}
        />
        <div className="p-3">
          <PipelineLanes
            project={project}
            selectedStepId={stepId}
            onSelect={openStep}
            canAct={(stage, step) => canActOnStep(project, { stage, step }, me)}
          />
        </div>
      </Card>

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'overview', label: 'Overview', icon: LayoutDashboard },
          { key: 'artifacts', label: 'Artifacts', icon: FileText, count: project.artifacts.length },
          { key: 'activity', label: 'Activity', icon: Activity },
          { key: 'trace', label: 'Trace', icon: ScrollText, count: trace.length },
          { key: 'details', label: 'Details', icon: Braces },
        ]}
      />

      <div key={tab} className="animate-fade-in">
        {tab === 'overview' && (
          <OverviewTab project={project} childSummaries={children} parent={parent} summarizing={summarizing} onSummarize={() => void summarize()} onOpenStep={openStep} />
        )}
        {tab === 'artifacts' && (
          <ArtifactsTab project={project} selectedId={artifactId} onSelect={setArtifactId} onArtifactSaved={onArtifactSaved} onOpenStep={openStep} />
        )}
        {tab === 'activity' && <ActivityTab project={project} onOpenStep={openStep} />}
        {tab === 'trace' && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-muted">Everything the engine, the AI and the agents did — thoughts, tool calls, results, decisions — live.</p>
              <Select
                aria-label="Filter by step"
                value={traceStep}
                onChange={(e) => setTraceStep(e.target.value)}
                placeholder="All steps"
                options={steps.filter((s) => s.trace.length > 0 || (liveTrace[s.id]?.length ?? 0) > 0).map((s) => ({ value: s.id, label: s.name }))}
                className="h-8 w-auto text-xs"
              />
            </div>
            <TraceList entries={shownTrace} showStep={!traceStep} onStepClick={openStep} maxHeight={640} emptyLabel="The trace fills as steps run." />
          </div>
        )}
        {tab === 'details' && <DetailsTab project={project} />}
      </div>

      {stepRef && (
        <StepDrawer
          key={stepRef.step.id}
          project={project}
          stepRef={stepRef}
          canAct={canActOnStep(project, stepRef, me)}
          childSummaries={children}
          onClose={closeStep}
          onChanged={accept}
          onOpenArtifact={openArtifact}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step drawer
// ---------------------------------------------------------------------------------------------

function StepDrawer({ project, stepRef, canAct, childSummaries, onClose, onChanged, onOpenArtifact }: {
  project: Project;
  stepRef: StepRef;
  canAct: boolean;
  childSummaries: ProjectSummary[];
  onClose: () => void;
  onChanged: (p: Project) => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const { step, stage, stageIndex } = stepRef;
  // Opens on the action when the persona can act; the toggle keeps both one click away.
  const [mode, setMode] = useState<'task' | 'details'>(canAct ? 'task' : 'details');
  return (
    <Drawer
      open
      onClose={onClose}
      width="xl"
      title={step.name}
      subtitle={`Stage ${stageIndex + 1} · ${stage.name} · ${STEP_TYPES[step.type]?.label ?? step.type}`}
      icon={ListTree}
      actions={
        <Segmented
          size="xs"
          value={mode}
          onChange={setMode}
          options={[{ key: 'task', label: canAct ? 'Your action' : 'Task' }, { key: 'details', label: 'Details' }]}
          className="mr-1"
        />
      }
    >
      <div className="px-5 py-4">
        {mode === 'task'
          ? <TaskPanel project={project} stepId={step.id} onChanged={onChanged} compact />
          : <StepDetails project={project} stepRef={stepRef} childSummaries={childSummaries} onChanged={onChanged} onOpenArtifact={onOpenArtifact} />}
      </div>
    </Drawer>
  );
}

// ---------------------------------------------------------------------------------------------
// Details tab
// ---------------------------------------------------------------------------------------------

function DetailsTab({ project }: { project: Project }) {
  const m = project.metrics;
  const totalSteps = m.ai_steps + m.human_steps;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Stat label="LLM calls" icon={BarChart3} tone="violet" value={formatNumber(m.llm_calls)} />
        <Stat label="Tokens" icon={Braces} tone="violet" value={formatCompact(m.tokens_in + m.tokens_out)} sub={`${formatCompact(m.tokens_in)} in · ${formatCompact(m.tokens_out)} out`} />
        <Stat label="AI steps" icon={Workflow} tone="brand" value={formatNumber(m.ai_steps)} sub={totalSteps ? `${Math.round((m.ai_steps / totalSteps) * 100)}% of completed steps` : undefined} />
        <Stat label="Human steps" icon={Activity} tone="sky" value={formatNumber(m.human_steps)} />
        <Stat label="Hours saved" icon={BarChart3} tone="emerald" value={savedHours(m.hours_saved)} sub="estimated vs. manual work" />
      </div>

      <Card padding="none">
        <CardHeader title="Record" icon={Braces} />
        <dl className="grid gap-x-6 gap-y-3 px-4 py-3.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Project id"><code className="font-mono text-xs">{project.id}</code></Fact>
          <Fact label="Blueprint">{project.blueprint_name} · v{project.blueprint_version}</Fact>
          <Fact label="Source">{project.source?.type || 'manual'}{project.source?.external_id ? ` · ${project.source.external_id}` : ''}</Fact>
          <Fact label="Created">{formatDateTime(project.created_at)}</Fact>
          <Fact label="Started">{formatDateTime(project.started_at)}</Fact>
          <Fact label="Completed">{formatDateTime(project.completed_at)}</Fact>
          <Fact label="Autonomy">{project.autonomy || 'Global setting'}</Fact>
          <Fact label="Kind">{project.kind || '—'}</Fact>
          <Fact label="Risk score"><span className="num">{project.risk.score}</span> / 100 · computed {formatDateTime(project.risk.computed_at)}</Fact>
        </dl>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <RawCard title="Inputs" value={project.inputs} />
        <RawCard title="Source" value={project.source} />
        <RawCard title="Variables" value={project.vars} className="lg:col-span-2" />
      </div>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label-xs mb-0.5">{label}</dt>
      <dd className="truncate text-zinc-800 dark:text-zinc-200">{children}</dd>
    </div>
  );
}

function RawCard({ title, value, className }: { title: string; value: unknown; className?: string }) {
  return (
    <Card padding="none" className={className}>
      <CardHeader title={title} icon={Braces} />
      <div className="p-3"><JsonView value={value} collapsedLines={24} /></div>
    </Card>
  );
}

/** Hours saved as a plain amount ("12.5 h"): a saving reads better in hours than as a duration. */
function savedHours(hours: number): string {
  return `${formatNumber(hours, hours > 0 && hours < 10 ? 1 : 0)} h`;
}
