// estimation · waiting_human: the AI's suggestion (value, confidence, breakdown, rationale) to start
// from, and the team's own estimate — which is what gets submitted.
import { Calculator, Plus, Send, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { AiRewrite } from '../../components/AiRewrite';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Field, IconButton, Input, Select, Textarea, useToast } from '../../components/ui';
import { api } from '../../api';
import { formatNumber } from '../../lib/format';
import type { Estimate, EstimateLine } from '../../types';
import type { ActionProps } from './types';
import { ActionBar, AiChip, AiWorking, NotAllowed, Section } from './common';
import { stepConfig } from './logic';

type Unit = Estimate['unit'];
type Confidence = Estimate['confidence'];

interface Draft {
  value: string;
  unit: Unit;
  confidence: Confidence;
  breakdown: Array<{ id: number; item: string; value: string }>;
  rationale: string;
}

let lineSeq = 0;

/** Reads an AI suggestion (an Estimate-shaped dict of unknown quality) defensively. */
export function readSuggestion(raw: Record<string, unknown> | null | undefined): Omit<Estimate, 'submitted_by' | 'ai_suggestion'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = typeof raw.value === 'number' ? raw.value : Number(raw.value);
  const breakdown = Array.isArray(raw.breakdown)
    ? (raw.breakdown as unknown[]).flatMap((l): EstimateLine[] => {
      if (!l || typeof l !== 'object') return [];
      const line = l as Record<string, unknown>;
      const v = typeof line.value === 'number' ? line.value : Number(line.value);
      return [{ item: String(line.item ?? ''), value: Number.isFinite(v) ? v : 0 }];
    })
    : [];
  return {
    value: Number.isFinite(value) ? value : null,
    unit: raw.unit === 'points' ? 'points' : 'days',
    confidence: raw.confidence === 'low' || raw.confidence === 'high' ? raw.confidence : 'medium',
    breakdown,
    rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
  };
}

function toDraft(e: Partial<Estimate> | null | undefined, unit: Unit): Draft {
  return {
    value: e?.value === null || e?.value === undefined ? '' : String(e.value),
    unit: e?.unit ?? unit,
    confidence: e?.confidence ?? 'medium',
    breakdown: (e?.breakdown ?? []).map((l) => ({ id: ++lineSeq, item: l.item, value: String(l.value) })),
    rationale: e?.rationale ?? '',
  };
}

const CONFIDENCE_TONE = { low: 'rose', medium: 'amber', high: 'emerald' } as const;

export function EstimationAction({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  const toast = useToast();
  const cfg = stepConfig(step, 'estimation');
  const defaultUnit: Unit = cfg.unit === 'points' ? 'points' : 'days';
  const suggestion = useMemo(() => readSuggestion(step.estimate?.ai_suggestion ?? null), [step.estimate?.ai_suggestion]);
  // A previously saved human estimate wins; otherwise start empty (the suggestion is one click away).
  const hasSaved = step.estimate?.value !== null && step.estimate?.value !== undefined;
  const [draft, setDraft] = useState<Draft>(() => toDraft(hasSaved ? step.estimate : null, defaultUnit));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (step.ai_busy || suggestion) setRequested(false);
  }, [step.ai_busy, suggestion]);

  const sum = draft.breakdown.reduce((acc, l) => acc + (Number(l.value) || 0), 0);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const useSuggestion = () => {
    if (!suggestion) return;
    setDraft(toDraft(suggestion, defaultUnit));
    setErrors({});
    toast.info('Suggestion copied — adjust it, then submit.');
  };

  const askAi = async () => {
    try {
      await api.steps.aiDraft(project.id, step.id, userId);
      setRequested(true);
      toast.info('The AI is estimating from the specification…');
    } catch (err) {
      toast.error(err);
    }
  };

  const submit = () => {
    const errs: Record<string, string> = {};
    const value = Number(draft.value);
    if (draft.value.trim() === '' || !Number.isFinite(value) || value <= 0) errs.value = 'Enter a positive number';
    const lines = draft.breakdown.filter((l) => l.item.trim() || l.value.trim());
    if (lines.some((l) => !l.item.trim() || !Number.isFinite(Number(l.value)))) errs.breakdown = 'Every line needs a name and a number';
    if (cfg.require_breakdown && lines.length === 0) errs.breakdown = 'This step requires a breakdown — add at least one line';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const estimate: Partial<Estimate> = {
      value,
      unit: draft.unit,
      confidence: draft.confidence,
      breakdown: lines.map((l) => ({ item: l.item.trim(), value: Number(l.value) })),
      rationale: draft.rationale.trim(),
    };
    void run('estimate', () => api.steps.estimate(project.id, step.id, userId, estimate), `Estimate submitted — ${formatNumber(value, 1)} ${draft.unit}`);
  };

  const drafting = step.ai_busy || requested;

  return (
    <div className="space-y-5">
      {drafting && !suggestion ? (
        <AiWorking label="The AI is estimating the work from the specification…" lines={4} />
      ) : suggestion ? (
        <div className="overflow-hidden rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-50/70 to-white dark:from-violet-500/[0.07] dark:to-transparent">
          <div className="flex flex-wrap items-center gap-2 border-b border-violet-500/15 px-3.5 py-2">
            <AiChip label="AI suggestion" />
            <span className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white num">
              {suggestion.value === null ? '—' : formatNumber(suggestion.value, 1)}
              <span className="ml-1 text-sm font-semibold text-muted">{suggestion.unit}</span>
            </span>
            <Badge tone={CONFIDENCE_TONE[suggestion.confidence]} size="xs">{suggestion.confidence} confidence</Badge>
            {canAct && <Button size="xs" variant="outline" icon={Wand2} className="ml-auto" onClick={useSuggestion}>Use suggestion</Button>}
          </div>
          <div className="grid gap-4 px-3.5 py-3 md:grid-cols-2">
            {suggestion.breakdown.length > 0 && (
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left"><th className="label-xs pb-1 font-bold">Work item</th><th className="label-xs pb-1 text-right font-bold">{suggestion.unit}</th></tr>
                </thead>
                <tbody className="divide-y hairline">
                  {suggestion.breakdown.map((l, i) => (
                    <tr key={i}><td className="py-1 pr-2 text-zinc-700 dark:text-zinc-300">{l.item}</td><td className="num py-1 text-right font-semibold">{formatNumber(l.value, 1)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            {suggestion.rationale && <div className={suggestion.breakdown.length ? '' : 'md:col-span-2'}><Markdown content={suggestion.rationale} size="xs" /></div>}
          </div>
        </div>
      ) : cfg.ai_suggest !== false && canAct ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 dark:border-ink-400">
          <Sparkles size={15} className="shrink-0 text-violet-500" />
          <p className="min-w-0 flex-1 text-xs text-muted">No AI suggestion yet — ask for one to start from, or estimate directly.</p>
          <Button size="xs" variant="ai" icon={Sparkles} onClick={() => void askAi()}>Suggest an estimate</Button>
        </div>
      ) : null}

      <Section title="Your estimate" icon={Calculator}>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Total" required error={errors.value}>
            <Input
              type="number"
              min={0}
              step="0.5"
              value={draft.value}
              onChange={(e) => set({ value: e.target.value })}
              disabled={!canAct}
              invalid={!!errors.value}
              className="num"
            />
          </Field>
          <Field label="Unit">
            <Select value={draft.unit} onChange={(e) => set({ unit: e.target.value as Unit })} disabled={!canAct} options={[{ value: 'days', label: 'Days' }, { value: 'points', label: 'Story points' }]} />
          </Field>
          <Field label="Confidence">
            <Select value={draft.confidence} onChange={(e) => set({ confidence: e.target.value as Confidence })} disabled={!canAct} options={[{ value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }]} />
          </Field>
        </div>

        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="label-xs">Breakdown{cfg.require_breakdown && <span className="ml-1 text-rose-500">*</span>}</span>
            {draft.breakdown.length > 0 && (
              <span className="text-[11px] text-muted">
                Sum <b className="num text-zinc-800 dark:text-zinc-100">{formatNumber(sum, 1)}</b> {draft.unit}
                {canAct && Math.abs(sum - Number(draft.value || 0)) > 0.001 && sum > 0 && (
                  <button type="button" className="ml-2 font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => set({ value: String(Math.round(sum * 10) / 10) })}>
                    Use as total
                  </button>
                )}
              </span>
            )}
          </div>
          <div className="space-y-1.5">
            {draft.breakdown.map((line) => (
              <div key={line.id} className="flex items-center gap-1.5">
                <Input
                  value={line.item}
                  onChange={(e) => set({ breakdown: draft.breakdown.map((l) => (l.id === line.id ? { ...l, item: e.target.value } : l)) })}
                  placeholder="Work item"
                  disabled={!canAct}
                  className="h-8 flex-1 text-xs"
                />
                <Input
                  type="number"
                  min={0}
                  step="0.5"
                  value={line.value}
                  onChange={(e) => set({ breakdown: draft.breakdown.map((l) => (l.id === line.id ? { ...l, value: e.target.value } : l)) })}
                  disabled={!canAct}
                  aria-label={`${line.item || 'Line'} estimate`}
                  className="num h-8 w-24 text-xs"
                />
                <IconButton icon={Trash2} label="Remove line" size="sm" disabled={!canAct} onClick={() => set({ breakdown: draft.breakdown.filter((l) => l.id !== line.id) })} />
              </div>
            ))}
            {errors.breakdown && <p className="text-[11px] text-rose-600 dark:text-rose-400">{errors.breakdown}</p>}
            <Button variant="ghost" size="xs" icon={Plus} disabled={!canAct} onClick={() => set({ breakdown: [...draft.breakdown, { id: ++lineSeq, item: '', value: '' }] })}>
              Add line
            </Button>
          </div>
        </div>

        <Field label="Rationale" className="mt-4" aside={<AiRewrite value={draft.rationale} onChange={(t) => set({ rationale: t })} disabled={!canAct} />}>
          <Textarea
            value={draft.rationale}
            onChange={(e) => set({ rationale: e.target.value })}
            placeholder="Assumptions, risks, what is out of scope…"
            minRows={3}
            disabled={!canAct}
          />
        </Field>
      </Section>

      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : undefined}>
        <Button size="sm" icon={Send} busy={busy === 'estimate'} disabled={!canAct || !!busy} onClick={submit}>
          Submit estimate
        </Button>
      </ActionBar>
    </div>
  );
}
