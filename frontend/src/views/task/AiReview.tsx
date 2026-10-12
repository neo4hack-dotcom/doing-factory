// ai_task · ai_review: the AI's draft (Markdown or JSON) waits for a person. Read it, edit it in
// place (with ✨ rewrite), ask for a new version with instructions, then approve — the approved
// text is what the next steps use.
import { CheckCircle2, Eye, Pencil, Save, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AiRewrite } from '../../components/AiRewrite';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Input, Textarea, useToast } from '../../components/ui';
import { api } from '../../api';
import { formatDateTime, timeAgo } from '../../lib/format';
import type { Artifact } from '../../types';
import type { ActionProps } from './types';
import { ActionBar, ActorName, AiChip, AiWorking, JsonBlock, NotAllowed, Segmented } from './common';
import { stepArtifacts } from './logic';

type Mode = 'preview' | 'edit';

/** The artifact under review: the one the pending action names, else the step's latest. */
function reviewedArtifact(artifacts: Artifact[], payload: Record<string, unknown>, stepId: string): Artifact | null {
  const id = typeof payload.artifact_id === 'string' ? payload.artifact_id : '';
  return (id && artifacts.find((a) => a.id === id)) || stepArtifacts({ artifacts }, stepId)[0] || null;
}

function sourceText(artifact: Artifact | null, payload: Record<string, unknown>): string {
  if (artifact) return artifact.kind === 'json' ? JSON.stringify(artifact.data ?? safeParse(artifact.content), null, 2) : artifact.content;
  const raw = payload.content ?? payload.markdown ?? payload.output;
  return typeof raw === 'string' ? raw : raw === undefined ? '' : JSON.stringify(raw, null, 2);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function AiReview({ project, step, userId, canAct, blockedReason, busy, run, compact }: ActionProps) {
  const toast = useToast();
  const payload = useMemo(() => step.pending_action?.payload ?? {}, [step.pending_action?.payload]);
  const artifact = reviewedArtifact(project.artifacts, payload, step.id);
  const isJson = artifact?.kind === 'json' || (!artifact && typeof payload.content !== 'string' && payload.output !== undefined && typeof payload.output !== 'string');
  const original = sourceText(artifact, payload);
  const [text, setText] = useState(original);
  const [mode, setMode] = useState<Mode>('preview');
  const [instructions, setInstructions] = useState('');
  const [requested, setRequested] = useState(false);
  const dirty = text !== original;

  // A new version from the AI (regeneration) replaces the editor unless the person is mid-edit.
  useEffect(() => {
    if (!dirty) setText(original);
    setRequested(false);
    // Only a change of the server text matters here, not every keystroke.
  }, [original]);

  useEffect(() => {
    if (step.ai_busy) setRequested(false);
  }, [step.ai_busy]);

  let jsonError = '';
  let parsed: unknown;
  if (isJson) {
    try {
      parsed = JSON.parse(text);
    } catch {
      jsonError = 'Not valid JSON — fix it before approving.';
    }
  }

  const saveEdits = async (): Promise<boolean> => {
    if (!dirty || !artifact) return true;
    try {
      await api.projects.updateArtifact(project.id, artifact.id, userId, text);
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    }
  };

  const approve = async () => {
    // Persist the human edit under the person's name first (artifact history), then approve with it.
    if (!(await saveEdits())) return;
    const edited = dirty ? (isJson ? { content: text, data: parsed } : { content: text }) : undefined;
    await run('approve', () => api.steps.confirm(project.id, step.id, userId, true, edited), dirty ? 'Edited version approved — the workflow moves on' : 'Approved — the workflow moves on');
  };

  const regenerate = async () => {
    try {
      await api.steps.aiDraft(project.id, step.id, userId, instructions.trim());
      setRequested(true);
      setInstructions('');
      setText(original);
      toast.info('The AI is writing a new version…');
    } catch (err) {
      toast.error(err);
    }
  };

  const drafting = step.ai_busy || requested;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <AiChip label="AI draft" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-zinc-800 dark:text-zinc-100">{artifact?.title || step.pending_action?.title || step.name}</span>
        {artifact && (
          <span className="text-[11px] text-faint" title={formatDateTime(artifact.updated_at)}>
            v{artifact.version} · {timeAgo(artifact.updated_at)}
            {artifact.updated_by && artifact.updated_by !== 'ai' && <> · edited by <ActorName id={artifact.updated_by} size={14} /></>}
          </span>
        )}
        {dirty && <Badge tone="sky" size="xs">Edited</Badge>}
        <Segmented<Mode>
          size="xs"
          value={mode}
          onChange={setMode}
          options={[{ key: 'preview', label: 'Preview', icon: Eye }, { key: 'edit', label: 'Edit', icon: Pencil }]}
        />
      </div>
      {step.pending_action?.description && <p className="text-xs text-muted">{step.pending_action.description}</p>}

      {drafting ? (
        <AiWorking label="The AI is writing a new version…" lines={6} />
      ) : mode === 'edit' ? (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-faint">{isJson ? 'JSON — the next steps read this structure.' : 'Markdown'}</span>
            {!isJson && <AiRewrite value={text} onChange={setText} disabled={!canAct} />}
          </div>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            minRows={compact ? 10 : 14}
            maxRows={40}
            disabled={!canAct || !!busy}
            invalid={!!jsonError}
            spellCheck={!isJson}
            className={isJson ? 'font-mono text-xs' : 'text-[13px]'}
          />
          {jsonError && <p className="text-[11px] text-rose-600 dark:text-rose-400">{jsonError}</p>}
        </div>
      ) : (
        <div className="max-h-[34rem] overflow-y-auto rounded-lg border hairline px-4 py-3">
          {isJson ? <JsonBlock value={parsed ?? text} max={30_000} className="max-h-none border-0 bg-transparent p-0 dark:bg-transparent" />
            : text.trim() ? <Markdown content={text} /> : <p className="text-sm text-faint">The AI produced an empty document — ask for a new version.</p>}
        </div>
      )}

      {canAct && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-50/40 p-2.5 dark:bg-violet-500/5"
          onSubmit={(e) => {
            e.preventDefault();
            void regenerate();
          }}
        >
          <Wand2 size={15} className="shrink-0 text-violet-500" />
          <Input
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Ask for changes — e.g. “add a rollback section, shorter intro”"
            className="h-8 min-w-[200px] flex-1 text-xs"
            disabled={drafting}
          />
          <Button type="submit" size="sm" variant="ai" icon={Sparkles} disabled={drafting || !!busy}>Regenerate</Button>
        </form>
      )}

      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : dirty ? 'Your edits are saved under your name when you approve.' : 'Approving publishes this version to the next steps.'}>
        {dirty && artifact && (
          <Button
            variant="outline"
            size="sm"
            icon={Save}
            disabled={!canAct || !!busy || !!jsonError}
            onClick={() => void saveEdits().then((ok) => ok && toast.success('Edits saved'))}
          >
            Save edits
          </Button>
        )}
        <Button size="sm" icon={CheckCircle2} busy={busy === 'approve'} disabled={!canAct || !!busy || drafting || !!jsonError} onClick={() => void approve()}>
          {dirty ? 'Approve edited version' : 'Approve'}
        </Button>
      </ActionBar>
    </div>
  );
}
