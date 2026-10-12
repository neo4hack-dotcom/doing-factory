// Project page › Artifacts: every document the workflow produced (specs, briefs, test plans,
// release notes…) with a Markdown viewer/editor (AiRewrite, Save → new version), the version
// history (read any earlier version, restore it), and a JSON viewer for structured artifacts.
import { Eye, FileJson, FileText, History, Pencil, RotateCcw, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { AiRewrite } from '../../components/AiRewrite';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Card, CopyButton, EmptyState, Select, Textarea, useBusy, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { Artifact, Project } from '../../types';
import { Segmented } from '../task/common';
import { JsonView } from './values';

export function ArtifactsTab({ project, selectedId, onSelect, onArtifactSaved, onOpenStep }: {
  project: Project;
  selectedId: string;
  onSelect: (artifactId: string) => void;
  onArtifactSaved: (artifact: Artifact) => void;
  onOpenStep: (stepId: string) => void;
}) {
  const artifacts = useMemo(
    () => [...project.artifacts].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')),
    [project.artifacts],
  );
  const stepName = (id: string) => project.stages.flatMap((s) => s.steps).find((s) => s.id === id)?.name ?? '';
  const current = artifacts.find((a) => a.id === selectedId) ?? artifacts[0];

  if (artifacts.length === 0) {
    return (
      <div className="card py-8">
        <EmptyState icon={FileText} title="No artifacts yet" description="Documents written by AI and people — specs, decision briefs, test plans, release notes — appear here as steps complete." />
      </div>
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]">
      <Card padding="none" className="h-fit overflow-hidden">
        <ul className="divide-y hairline">
          {artifacts.map((a) => {
            const active = a.id === current?.id;
            const Icon = a.kind === 'json' ? FileJson : FileText;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  onClick={() => onSelect(a.id)}
                  aria-current={active || undefined}
                  className={cls('relative flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors', active ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-zinc-50 dark:hover:bg-ink-700/30')}
                >
                  {active && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" aria-hidden />}
                  <Icon size={15} className="mt-0.5 shrink-0 text-faint" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{a.title || 'Untitled artifact'}</div>
                    <div className="truncate text-[11px] text-muted">{stepName(a.step_id) || 'Project'} · v{a.version} · {timeAgo(a.updated_at)}</div>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      </Card>
      {current && <ArtifactViewer key={current.id} project={project} artifact={current} stepName={stepName(current.step_id)} onSaved={onArtifactSaved} onOpenStep={onOpenStep} />}
    </div>
  );
}

function ArtifactViewer({ project, artifact, stepName, onSaved, onOpenStep }: {
  project: Project;
  artifact: Artifact;
  stepName: string;
  onSaved: (artifact: Artifact) => void;
  onOpenStep: (stepId: string) => void;
}) {
  const { userId, userById } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState(artifact.content);
  const [version, setVersion] = useState(artifact.version);
  const isJson = artifact.kind === 'json';
  const readOnly = project.status === 'cancelled';

  // A new version arriving (live refresh, another editor) resets the view unless we are editing.
  useEffect(() => {
    setVersion(artifact.version);
    if (mode === 'preview') setDraft(artifact.content);
  }, [artifact.version, artifact.content]);

  const history = useMemo(
    () => [...(artifact.history ?? [])].filter((h) => h.version !== artifact.version).sort((a, b) => b.version - a.version),
    [artifact.history, artifact.version],
  );
  const old = version !== artifact.version ? history.find((h) => h.version === version) : undefined;
  const shown = old ? old.content : artifact.content;
  const dirty = draft !== artifact.content;
  const author = (id: string) => userById(id)?.name ?? (id === 'ai' ? 'AI' : id || 'system');

  const save = (content: string, message: string) => run('save', async () => {
    const saved = await api.projects.updateArtifact(project.id, artifact.id, userId, content);
    onSaved(saved);
    setDraft(saved.content);
    setVersion(saved.version);
    setMode('preview');
    toast.success(message);
  });

  return (
    <Card padding="none" className="min-w-0">
      <div className="flex flex-wrap items-center gap-2 border-b hairline px-4 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-bold text-zinc-900 dark:text-white">{artifact.title || 'Untitled artifact'}</h3>
          <p className="truncate text-[11px] text-muted">
            {stepName && <><button type="button" className="font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => onOpenStep(artifact.step_id)}>{stepName}</button> · </>}
            v{artifact.version} by {author(artifact.updated_by)} · <span title={formatDateTime(artifact.updated_at)}>{timeAgo(artifact.updated_at)}</span>
          </p>
        </div>
        {history.length > 0 && (
          <div className="flex items-center gap-1.5">
            <History size={13} className="text-faint" />
            <Select
              aria-label="Version"
              value={String(version)}
              onChange={(e) => { setVersion(Number(e.target.value)); setMode('preview'); }}
              options={[
                { value: String(artifact.version), label: `v${artifact.version} · current` },
                ...history.map((h) => ({ value: String(h.version), label: `v${h.version} · ${author(h.updated_by)} · ${timeAgo(h.updated_at)}` })),
              ]}
              className="h-8 w-auto text-xs"
            />
          </div>
        )}
        {!isJson && !old && !readOnly && (
          <Segmented
            value={mode}
            onChange={setMode}
            options={[{ key: 'preview', label: 'Preview', icon: Eye }, { key: 'edit', label: 'Edit', icon: Pencil }]}
          />
        )}
        <CopyButton text={mode === 'edit' ? draft : shown} size="xs" />
      </div>

      {old && (
        <div className="flex flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <Badge tone="amber" size="xs">v{old.version}</Badge>
          Viewing an earlier version by {author(old.updated_by)}, {formatDateTime(old.updated_at)}.
          <div className="ml-auto flex gap-1.5">
            <Button size="xs" variant="ghost" onClick={() => setVersion(artifact.version)}>Back to current</Button>
            {!isJson && !readOnly && (
              <Button size="xs" variant="outline" icon={RotateCcw} busy={busy === 'save'} onClick={() => void save(old.content, `Restored v${old.version} as a new version.`)}>Restore</Button>
            )}
          </div>
        </div>
      )}

      <div className="px-4 py-4">
        {isJson ? (
          <JsonView value={artifact.data ?? undefined} text={artifact.data === undefined || artifact.data === null ? shown : undefined} collapsedLines={60} />
        ) : mode === 'edit' && !old ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="label-xs">Markdown</span>
              <AiRewrite value={draft} onChange={setDraft} disabled={busy === 'save'} />
            </div>
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} minRows={14} maxRows={40} className="font-mono text-[12.5px]" aria-label="Artifact content" />
            <div className="flex flex-wrap items-center justify-end gap-2">
              {dirty && <span className="mr-auto text-[11px] text-amber-600 dark:text-amber-400">Unsaved changes</span>}
              <Button size="sm" variant="ghost" onClick={() => { setDraft(artifact.content); setMode('preview'); }}>Discard</Button>
              <Button size="sm" icon={Save} disabled={!dirty} busy={busy === 'save'} onClick={() => void save(draft, `Saved as v${artifact.version + 1}.`)}>Save version</Button>
            </div>
          </div>
        ) : shown.trim() ? (
          <Markdown content={shown} />
        ) : (
          <p className="text-sm text-faint">This artifact is empty.</p>
        )}
      </div>
    </Card>
  );
}
