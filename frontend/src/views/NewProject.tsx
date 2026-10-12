// New project in two steps: pick a blueprint (preselected from ?blueprint= or when only one is
// active), then title, description (✨ rewrite), the blueprint's own inputs and the people. Create
// starts the workflow and opens the project — three clicks from the portfolio.
import {
  AlertTriangle, ArrowLeft, ArrowRight, Check, Layers, Plus, Rocket, Settings2, Tag, Workflow, X,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api } from '../api';
import { AiRewrite } from '../components/AiRewrite';
import { FormRenderer, initialFormValue, normalizeFormValue, validateForm } from '../components/FormRenderer';
import type { FormValue } from '../components/FormRenderer';
import { iconByName, StepIcon } from '../components/StepIcon';
import {
  Badge, Button, Card, CardHeader, EmptyState, Field, Input, Kbd, Select, Textarea, TONE, Tooltip, toneOf, useToast,
} from '../components/ui';
import { cls } from '../lib/cls';
import { MOD_LABEL, useHotkeys } from '../lib/hotkeys';
import { usePageTitle } from '../lib/pageTitle';
import { Link, navigate, paths } from '../lib/router';
import { PRIORITY } from '../lib/status';
import { useApp } from '../lib/store';
import type { Blueprint, Priority } from '../types';

export interface NewProjectProps {
  /** Preselected blueprint from #/projects/new?blueprint=<id>. */
  blueprintId?: string;
}

const AUTONOMY_COPY: Record<string, { label: string; hint: string }> = {
  supervised: { label: 'Supervised', hint: 'Every AI output waits for a human review.' },
  approve_writes: { label: 'Approve writes', hint: 'The AI drafts freely; writes to external systems need a confirmation.' },
  full: { label: 'Full autonomy', hint: 'The AI runs every automated step on its own.' },
};

export default function NewProject({ blueprintId }: NewProjectProps) {
  usePageTitle('New project');
  const { blueprints, blueprintById } = useApp();
  const active = useMemo(() => blueprints.filter((b) => b.status === 'active'), [blueprints]);
  const drafts = blueprints.filter((b) => b.status === 'draft').length;

  // A single active blueprint needs no choice; an unknown id falls back to the picker.
  const preselected = blueprintById(blueprintId);
  const selected = preselected && preselected.status !== 'archived' ? preselected : active.length === 1 ? active[0] : undefined;

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label-xs mb-1.5 flex items-center gap-1.5"><Plus size={12} className="text-brand-500" />Projects</div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] dark:text-white">New project</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">Pick a blueprint, describe the work, and the Factory runs the workflow — AI drafts, people decide.</p>
        </div>
        <Stepper step={selected ? 2 : 1} onBack={selected && active.length > 1 ? () => navigate(paths.newProject(), { replace: true }) : undefined} />
      </div>

      {selected ? (
        <ProjectForm key={selected.id} blueprint={selected} canChange={active.length > 1} />
      ) : active.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No active blueprint"
          description={drafts ? `${drafts} draft blueprint${drafts === 1 ? ' is' : 's are'} waiting to be activated in the Blueprint Studio.` : 'A project runs a blueprint: create or activate one first.'}
          action={<Button icon={Workflow} onClick={() => navigate(paths.blueprints())}>Open the Blueprint Studio</Button>}
        />
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {active.map((bp, i) => (
              <BlueprintCard key={bp.id} bp={bp} index={i} onPick={() => navigate(paths.newProject(bp.id), { replace: true })} />
            ))}
          </div>
          {drafts > 0 && (
            <p className="mt-4 text-xs text-muted">
              {drafts} draft blueprint{drafts === 1 ? '' : 's'} not shown · <Link to={paths.blueprints()} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">Blueprint Studio</Link>
            </p>
          )}
        </>
      )}
    </>
  );
}

function Stepper({ step, onBack }: { step: 1 | 2; onBack?: () => void }) {
  const items = ['Blueprint', 'Details'];
  return (
    <ol className="flex items-center gap-2 text-xs font-semibold">
      {items.map((label, i) => {
        const n = i + 1;
        const done = n < step;
        const current = n === step;
        const clickable = done && n === 1 && !!onBack;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className={cls('h-px w-8', done || current ? 'bg-brand-500' : 'bg-zinc-300 dark:bg-ink-400')} />}
            <button
              type="button"
              disabled={!clickable}
              onClick={onBack}
              className={cls('inline-flex items-center gap-1.5', clickable && 'hover:text-brand-600 dark:hover:text-brand-400',
                current ? 'text-zinc-900 dark:text-white' : 'text-muted')}
            >
              <span className={cls('grid h-6 w-6 place-items-center rounded-full text-[11px]',
                done ? 'bg-emerald-500 text-white' : current ? 'bg-brand-500 text-white' : 'bg-zinc-200 text-zinc-500 dark:bg-ink-500 dark:text-zinc-400')}>
                {done ? <Check size={12} strokeWidth={3} /> : n}
              </span>
              {label}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function BlueprintCard({ bp, index, onPick }: { bp: Blueprint; index: number; onPick: () => void }) {
  const tone = toneOf(bp.color);
  const Icon = iconByName(bp.icon);
  const steps = bp.stages.reduce((n, s) => n + s.steps.length, 0);
  return (
    <Card padding="none" onClick={onPick} className="group flex flex-col overflow-hidden animate-slide-up" style={{ animationDelay: `${index * 40}ms` }}>
      <div className="flex h-1">
        {bp.stages.map((s) => <span key={s.id} className={cls('flex-1', TONE[toneOf(s.color)].dot)} />)}
      </div>
      <div className="flex flex-1 items-start gap-3 p-4">
        <span className={cls('grid h-11 w-11 shrink-0 place-items-center rounded-xl transition-transform group-hover:scale-105', TONE[tone].icon)}>
          <Icon size={21} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="font-semibold text-zinc-900 dark:text-white">{bp.name}</h3>
            {bp.builtin && <Badge size="xs">Builtin</Badge>}
          </div>
          <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-muted">{bp.description || 'No description.'}</p>
        </div>
        <ArrowRight size={16} className="mt-1 shrink-0 text-zinc-300 transition-all group-hover:translate-x-0.5 group-hover:text-brand-500 dark:text-ink-400" />
      </div>
      <div className="flex items-center gap-2 border-t hairline px-4 py-2.5 text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><Layers size={12} />{bp.stages.length} stages</span>
        <span className="text-faint">·</span>
        <span>{steps} steps</span>
        <span className="text-faint">·</span>
        <span>{bp.inputs.length} inputs</span>
        <span className="num ml-auto rounded bg-zinc-100 px-1.5 py-px font-mono text-[10px] font-bold text-zinc-600 dark:bg-ink-600 dark:text-zinc-300">{bp.key_prefix}-0001</span>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Step 2: the form
// ---------------------------------------------------------------------------------------------

function ProjectForm({ blueprint: bp, canChange }: { blueprint: Blueprint; canChange: boolean }) {
  const { users, teams, me, userId, settings, onboarding } = useApp();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [inputs, setInputs] = useState<FormValue>(() => initialFormValue(bp.inputs));
  const [sponsorId, setSponsorId] = useState(() => (me?.roles.includes('sponsor') ? me.id : ''));
  const [ownerId, setOwnerId] = useState(() => me?.id ?? '');
  const [teamId, setTeamId] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [due, setDue] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.getElementById('np-title')?.focus();
  }, []);

  const peopleOptions = users
    .filter((u) => u.active)
    .map((u) => ({ value: u.id, label: u.title ? `${u.name} — ${u.title}` : u.name }));
  const sponsors = users.filter((u) => u.active && u.roles.includes('sponsor'));
  const autonomy = bp.autonomy || settings?.engine.autonomy || 'approve_writes';
  const aiSteps = bp.stages.flatMap((s) => s.steps).filter((s) => ['ai_task', 'agent_task', 'quality_gate'].includes(s.type)).length;
  const llmMissing = onboarding ? !onboarding.llm_configured : false;

  const create = async () => {
    const next: Record<string, string> = { ...validateForm(bp.inputs, inputs) };
    if (!title.trim()) next.__title = 'Give the project a title';
    setErrors(next);
    if (Object.keys(next).length) {
      toast.warn('Some required fields are empty.');
      const first = next.__title ? 'np-title' : null;
      if (first) document.getElementById(first)?.focus();
      return;
    }
    setBusy(true);
    try {
      const project = await api.projects.create({
        blueprint_id: bp.id,
        title: title.trim(),
        description: description.trim(),
        inputs: normalizeFormValue(bp.inputs, inputs),
        priority,
        sponsor_id: sponsorId,
        owner_id: ownerId,
        team_id: teamId,
        tags,
        due_date: due || null,
        created_by: userId,
      });
      toast.success(`${project.key} created — the workflow has started.`);
      navigate(paths.project(project.id));
    } catch (err) {
      toast.error(err);
      setBusy(false);
    }
  };

  useHotkeys({ 'mod+enter': () => void create() }, !busy);

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px] animate-fade-in">
      <div className="space-y-5">
        <Card padding="none">
          <CardHeader
            icon={iconByName(bp.icon)}
            iconTone={toneOf(bp.color)}
            eyebrow="Blueprint"
            title={bp.name}
            subtitle={bp.description}
            actions={canChange && (
              <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => navigate(paths.newProject(), { replace: true })}>Change</Button>
            )}
          />
          <div className="space-y-4 p-4">
            <Field label="Title" required htmlFor="np-title" error={errors.__title}>
              <Input id="np-title" value={title} invalid={!!errors.__title} maxLength={160}
                placeholder={bp.kind === 'use_case' ? 'e.g. Intraday liquidity forecasting' : bp.kind === 'mcp_delivery' ? 'e.g. Nostro Balances MCP' : 'A short, specific name'}
                onChange={(e) => {
                  setTitle(e.target.value);
                  if (errors.__title) setErrors(({ __title: _drop, ...rest }) => rest);
                }} />
            </Field>
            <Field label="Description" htmlFor="np-desc" help="What is asked and why — the AI steps read it." aside={<AiRewrite value={description} onChange={setDescription} />}>
              <Textarea id="np-desc" value={description} minRows={3} placeholder="Context, expected outcome, constraints…" onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
        </Card>

        {bp.inputs.length > 0 && (
          <Card padding="none">
            <CardHeader icon={Settings2} iconTone="sky" title="Blueprint inputs" subtitle={`What the ${bp.name} workflow needs to start.`} />
            <div className="p-4">
              <FormRenderer fields={bp.inputs} value={inputs} errors={errors} onChange={(v) => {
                setInputs(v);
                if (Object.keys(errors).length) setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k === '__title' || validateForm(bp.inputs, v)[k])));
              }} />
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-5 lg:sticky lg:top-4 lg:self-start">
        <Card padding="none">
          <CardHeader title="People & planning" divider />
          <div className="space-y-3.5 p-4">
            <Field label="Sponsor" htmlFor="np-sponsor" help={sponsors.length === 0 && users.length > 0 ? 'Nobody holds the Sponsor role yet.' : undefined}>
              <Select id="np-sponsor" value={sponsorId} onChange={(e) => setSponsorId(e.target.value)} placeholder="No sponsor"
                options={[...sponsors.map((u) => ({ value: u.id, label: u.title ? `${u.name} — ${u.title}` : u.name })),
                  ...peopleOptions.filter((o) => !sponsors.some((s) => s.id === o.value))]} />
            </Field>
            <Field label="Owner" htmlFor="np-owner" help="Handles failures and owner-assigned steps.">
              <Select id="np-owner" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} placeholder="No owner" options={peopleOptions} />
            </Field>
            <Field label="Team" htmlFor="np-team" help={teams.length ? 'Leave empty to let the workflow route it.' : 'No team yet — Settings › People & Teams.'}>
              <Select id="np-team" value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder="Routed by the workflow"
                options={teams.map((t) => ({ value: t.id, label: t.name }))} />
            </Field>
            <Field label="Priority">
              <div className="grid grid-cols-4 gap-1 rounded-lg border border-zinc-300 p-0.5 dark:border-ink-500" role="radiogroup" aria-label="Priority">
                {(Object.keys(PRIORITY) as Priority[]).map((p) => (
                  <button key={p} type="button" role="radio" aria-checked={priority === p} onClick={() => setPriority(p)}
                    className={cls('h-7 rounded-md text-[11px] font-semibold transition-colors',
                      priority === p ? cls(TONE[PRIORITY[p].tone].solid) : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-ink-600')}>
                    {PRIORITY[p].label}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Due date" htmlFor="np-due">
              <Input id="np-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
            </Field>
            <Field label="Tags">
              <TagEditor value={tags} onChange={setTags} />
            </Field>
          </div>
        </Card>

        <Card padding="none">
          <CardHeader title="What will happen" subtitle={`${bp.stages.length} stages · ${aiSteps} AI-driven steps`} divider />
          <ol className="space-y-2.5 p-4">
            {bp.stages.map((s, i) => (
              <li key={s.id} className="flex gap-2.5">
                <span className={cls('mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white', TONE[toneOf(s.color)].solid)}>{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-800 dark:text-zinc-100">
                    <span className="truncate">{s.name}</span>
                    {s.parallel && <Badge size="xs" tone="violet">Parallel</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {s.steps.map((st) => (
                      <Tooltip key={st.id} content={st.name}><StepIcon type={st.type} size="sm" /></Tooltip>
                    ))}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <div className="border-t hairline px-4 py-3 text-[11px] text-muted">
            <span className="font-semibold text-zinc-700 dark:text-zinc-200">{AUTONOMY_COPY[autonomy]?.label ?? autonomy}</span>
            {' — '}{AUTONOMY_COPY[autonomy]?.hint}
          </div>
        </Card>

        {llmMissing && aiSteps > 0 && (
          <div className="flex gap-2.5 rounded-xl border border-amber-500/40 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            <div>
              No AI model is configured: the AI steps will stop with an actionable error until one is.{' '}
              <Link to={paths.settings('ai')} className="font-semibold underline">Settings › AI Model</Link>
            </div>
          </div>
        )}

        <Button size="lg" icon={Rocket} busy={busy} onClick={() => void create()} className="w-full">
          Create & start
          <Kbd className="ml-1 border-white/30 bg-white/15 text-white dark:border-white/30 dark:bg-white/15 dark:text-white">{MOD_LABEL}↵</Kbd>
        </Button>
      </div>
    </div>
  );
}

function TagEditor({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState('');
  const add = (raw: string) => {
    const tag = raw.trim().replace(/^#/, '').toLowerCase().replace(/\s+/g, '-');
    if (tag && !value.includes(tag)) onChange([...value, tag]);
    setDraft('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(draft);
    } else if (e.key === 'Backspace' && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-zinc-300 bg-white px-2 py-1 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 dark:border-ink-500 dark:bg-ink-900">
      {value.map((t) => (
        <span key={t} className="inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-ink-600 dark:text-zinc-200">
          #{t}
          <button type="button" aria-label={`Remove tag ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="text-zinc-400 hover:text-rose-500"><X size={11} /></button>
        </span>
      ))}
      <span className="inline-flex min-w-[6rem] flex-1 items-center gap-1">
        {value.length === 0 && <Tag size={12} className="shrink-0 text-zinc-400" />}
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onBlur={() => draft.trim() && add(draft)}
          placeholder={value.length ? '' : 'Add a tag, Enter'}
          aria-label="Add a tag"
          className="h-6 min-w-0 flex-1 bg-transparent text-xs text-zinc-900 outline-none placeholder:text-zinc-400 dark:text-zinc-100"
        />
      </span>
    </div>
  );
}
