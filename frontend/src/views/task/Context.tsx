// "What do I need to know to act?" — the step's purpose, the project brief, its key inputs and the
// documents produced so far, in one collapsible block above the action area.
import { BookOpen } from 'lucide-react';
import { useState } from 'react';
import { FormRenderer } from '../../components/FormRenderer';
import { Markdown } from '../../components/Markdown';
import { useApp } from '../../lib/store';
import { humanize, truncate } from '../../lib/format';
import type { Artifact, Project, StepRun } from '../../types';
import { ArtifactPreview, Collapsible, JsonBlock } from './common';
import { evidenceForVars, flatSteps, stepConfig } from './logic';

/** Documents worth reading before acting: the gate's evidence, else the latest earlier artifacts. */
function relevantArtifacts(project: Project, step: StepRun): Artifact[] {
  if (step.type === 'approval') return []; // the approval body shows its own evidence (show_vars)
  if (step.type === 'quality_gate') {
    const names = stepConfig(step, 'quality_gate').evidence ?? [];
    if (names.length) return evidenceForVars(project, names).flatMap((e) => e.artifacts.slice(0, 1));
  }
  const order = new Map(flatSteps(project).map((x, i) => [x.step.id, i]));
  const here = order.get(step.id) ?? Infinity;
  return project.artifacts
    .filter((a) => a.step_id !== step.id && (order.get(a.step_id) ?? -1) < here)
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, 3);
}

function InputsList({ project }: { project: Project }) {
  const { blueprintById } = useApp();
  const fields = blueprintById(project.blueprint_id)?.inputs ?? [];
  const entries = Object.entries(project.inputs ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length));
  if (!entries.length) return null;
  const known = fields.filter((f) => f.key in project.inputs);
  if (known.length) {
    return <FormRenderer fields={known} value={project.inputs} onChange={() => undefined} readOnly columns={2} />;
  }
  return (
    <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
      {entries.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="label-xs">{humanize(k)}</dt>
          <dd className="mt-0.5 break-words text-sm text-zinc-700 dark:text-zinc-300">
            {typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : <JsonBlock value={v} max={800} />}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function StepContext({ project, step, defaultOpen }: { project: Project; step: StepRun; defaultOpen: boolean }) {
  const [fullDescription, setFullDescription] = useState(false);
  const artifacts = relevantArtifacts(project, step);
  const description = project.description?.trim() ?? '';
  const longDescription = description.length > 600;
  const hasInputs = Object.values(project.inputs ?? {}).some((v) => v !== '' && v !== null && v !== undefined);
  if (!step.description && !description && !hasInputs && !artifacts.length) return null;

  return (
    <Collapsible
      title="Context"
      icon={BookOpen}
      defaultOpen={defaultOpen}
      meta={artifacts.length ? <span className="text-[11px] text-faint">{artifacts.length} document{artifacts.length > 1 ? 's' : ''}</span> : undefined}
    >
      <div className="space-y-4">
        {step.description && (
          <div>
            <div className="label-xs mb-1">This step</div>
            <Markdown content={step.description} size="xs" />
          </div>
        )}
        {description && (
          <div>
            <div className="label-xs mb-1">Project</div>
            <Markdown content={fullDescription || !longDescription ? description : truncate(description, 600)} size="xs" />
            {longDescription && (
              <button type="button" onClick={() => setFullDescription((f) => !f)} className="mt-1 text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
                {fullDescription ? 'Show less' : 'Show the full description'}
              </button>
            )}
          </div>
        )}
        {hasInputs && (
          <div>
            <div className="label-xs mb-1.5">Key inputs</div>
            <InputsList project={project} />
          </div>
        )}
        {artifacts.length > 0 && (
          <div>
            <div className="label-xs mb-1.5">{step.type === 'quality_gate' ? 'Evidence' : 'Latest documents'}</div>
            <div className="space-y-2">
              {artifacts.map((a) => <ArtifactPreview key={a.id} artifact={a} />)}
            </div>
          </div>
        )}
      </div>
    </Collapsible>
  );
}
