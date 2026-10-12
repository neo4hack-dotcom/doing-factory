// human_form · waiting_human: the form, pre-drafted by the AI when the blueprint asks for it. Fields
// still holding the AI's words are marked, the person can ask for a new draft with instructions,
// save without submitting, and submit once the required fields are filled.
import { Save, Send, Sparkles, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FormRenderer, initialFormValue, isEmptyValue, normalizeFormValue, validateForm,
} from '../../components/FormRenderer';
import type { FormValue } from '../../components/FormRenderer';
import { Markdown } from '../../components/Markdown';
import { Button, Input, useToast } from '../../components/ui';
import { api } from '../../api';
import { MOD_LABEL, useHotkeys } from '../../lib/hotkeys';
import { plural } from '../../lib/format';
import type { FieldDef } from '../../types';
import type { ActionProps } from './types';
import { ActionBar, AiChip, AiWorking, Callout, NotAllowed } from './common';
import { stepConfig } from './logic';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function FormAction({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  const toast = useToast();
  const cfg = stepConfig(step, 'human_form');
  const fields: FieldDef[] = useMemo(() => cfg.fields ?? [], [cfg.fields]);
  const [value, setValue] = useState<FormValue>(() => initialFormValue(fields, step.form));
  const [dirty, setDirty] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [instructions, setInstructions] = useState('');
  const [showRegen, setShowRegen] = useState(false);
  const [requested, setRequested] = useState(false);

  // Server-side changes (the AI draft landing, another person saving) flow into the form unless the
  // person is mid-edit; then only the fields they left empty take the AI's values.
  const formKey = JSON.stringify(step.form ?? {});
  const draftKey = JSON.stringify(step.ai_draft ?? null);
  const lastDraft = useRef(draftKey);
  useEffect(() => {
    if (!dirty) {
      setValue(initialFormValue(fields, step.form));
    } else if (draftKey !== lastDraft.current && step.ai_draft) {
      const draft = step.ai_draft;
      setValue((v) => {
        const next = { ...v };
        for (const f of fields) if (isEmptyValue(next[f.key]) && f.key in draft) next[f.key] = draft[f.key];
        return next;
      });
    }
    lastDraft.current = draftKey;
    // Keyed on the serialised server state, not on object identity (every refresh is a new object).
  }, [formKey, draftKey, fields]);

  // "Requested" bridges the gap between the click and the backend flagging ai_busy.
  useEffect(() => {
    if (step.ai_busy) setRequested(false);
  }, [step.ai_busy]);
  useEffect(() => {
    setRequested(false);
  }, [draftKey]);
  useEffect(() => {
    if (!requested) return;
    const t = setTimeout(() => setRequested(false), 120_000);
    return () => clearTimeout(t);
  }, [requested]);

  const drafting = step.ai_busy || requested;
  const draftedCount = step.ai_draft
    ? fields.filter((f) => f.key in step.ai_draft! && !isEmptyValue(value[f.key]) && same(step.ai_draft![f.key], value[f.key])).length
    : 0;

  const change = (next: FormValue) => {
    setValue(next);
    setDirty(true);
    if (Object.keys(errors).length) setErrors(validateForm(fields, next));
  };

  const save = () => run('save', () => api.steps.save(project.id, step.id, userId, normalizeFormValue(fields, value)), 'Draft saved')
    .then((p) => p && setDirty(false));

  const submit = async () => {
    const errs = validateForm(fields, value);
    setErrors(errs);
    const n = Object.keys(errs).length;
    if (n) {
      toast.warn(`${plural(n, 'field')} ${n === 1 ? 'needs' : 'need'} attention before you can submit.`);
      return;
    }
    const p = await run('submit', () => api.steps.complete(project.id, step.id, userId, { form: normalizeFormValue(fields, value) }), `${step.name} submitted — the workflow moves on`);
    if (p) setDirty(false);
  };

  const regenerate = async () => {
    // Persist what the person wrote first, so the new draft builds on it instead of erasing it.
    if (dirty) {
      const saved = await run('save', () => api.steps.save(project.id, step.id, userId, normalizeFormValue(fields, value)), '');
      if (!saved) return;
    }
    try {
      await api.steps.aiDraft(project.id, step.id, userId, instructions.trim());
      setDirty(false);
      setRequested(true);
      setShowRegen(false);
      setInstructions('');
      toast.info('The AI is drafting — the fields fill in as soon as it is done.');
    } catch (err) {
      toast.error(err);
    }
  };

  useHotkeys({ 'mod+enter': () => void submit() }, canAct && !busy);

  return (
    <div className="space-y-4">
      {cfg.instructions && (
        <div className="rounded-lg border hairline bg-zinc-50/60 px-3 py-2.5 dark:bg-ink-900/40">
          <Markdown content={cfg.instructions} size="xs" />
        </div>
      )}

      {drafting ? (
        <AiWorking label="The AI is drafting this form from the project context…" lines={3} />
      ) : draftedCount > 0 ? (
        <Callout tone="violet" icon={Sparkles} title={<span className="flex items-center gap-2">AI drafted {plural(draftedCount, 'field')} — review before submitting <AiChip /></span>}>
          Marked fields still hold the AI's words. Edit anything that is not right; your edits are kept if you ask for a new draft.
        </Callout>
      ) : null}

      <div className={drafting ? 'pointer-events-none opacity-60 transition-opacity' : 'transition-opacity'}>
        <FormRenderer
          fields={fields}
          value={value}
          onChange={change}
          errors={errors}
          aiDraft={step.ai_draft}
          disabled={!canAct || !!busy}
        />
      </div>

      {showRegen && canAct && (
        <form
          className="flex flex-wrap items-center gap-2 rounded-lg border border-violet-500/25 bg-violet-50/40 p-2.5 dark:bg-violet-500/5 animate-fade-in"
          onSubmit={(e) => {
            e.preventDefault();
            void regenerate();
          }}
        >
          <Wand2 size={15} className="shrink-0 text-violet-500" />
          <Input
            autoFocus
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Optional instructions — e.g. “focus on GDPR constraints, shorter scope”"
            className="h-8 min-w-[200px] flex-1 text-xs"
          />
          <Button type="submit" size="sm" variant="ai" icon={Sparkles} disabled={drafting}>Draft again</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowRegen(false)}>Cancel</Button>
        </form>
      )}

      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : dirty ? 'Unsaved changes' : <span className="hidden sm:inline">{MOD_LABEL}+Enter submits</span>}>
        {canAct && !showRegen && (
          <Button variant="ai" size="sm" icon={Sparkles} disabled={drafting || !!busy} onClick={() => setShowRegen(true)}>
            {step.ai_draft ? 'Regenerate' : 'Draft with AI'}
          </Button>
        )}
        <Button variant="outline" size="sm" icon={Save} busy={busy === 'save'} disabled={!canAct || !!busy || !dirty} onClick={() => void save()}>
          Save draft
        </Button>
        <Button size="sm" icon={Send} busy={busy === 'submit'} disabled={!canAct || !!busy || drafting} onClick={() => void submit()}>
          Submit
        </Button>
      </ActionBar>
    </div>
  );
}
