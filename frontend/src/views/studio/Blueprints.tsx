// Blueprints (#/studio/blueprints): the workflow templates the Factory runs. Cards with identity,
// shape (stages/steps), status and one-click actions; "New blueprint" opens a blank designer and
// "Generate with AI" turns a plain-language description into an unsaved draft for the designer.
import {
  Archive, ArchiveRestore, Copy, Layers, MoreHorizontal, PenSquare, Plus, Search, ShieldCheck, Sparkles, Trash2, Workflow,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { AiRewrite } from '../../components/AiRewrite';
import {
  Badge, Button, Card, EmptyState, Field, IconButton, Input, MenuItem, Modal, Popover, SectionHeader, Tabs, Textarea,
  cls, useBusy, useConfirm, useToast,
} from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { usePageTitle } from '../../lib/pageTitle';
import { navigate, paths } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Blueprint, BlueprintStatus, ValidationReport } from '../../types';
import { BlueprintIcon, MiniPipeline } from './parts/BlueprintDetails';
import { clearGeneratedDraft, stashGeneratedDraft } from './parts/session';

type Filter = 'all' | BlueprintStatus;

const STATUS_TONE = { active: 'emerald', draft: 'amber', archived: 'zinc' } as const;

const EXAMPLES = [
  'Onboard a new SaaS vendor: the requester describes the need, security reviews the data flows, legal approves the contract, IT configures SSO, and the requester is notified.',
  'Data access request: a user asks for a dataset, the data owner approves, compliance checks GDPR rules, then a Jira ticket is created for the platform team.',
  'Small change request: estimate the effort with the team, get the product manager approval, create the Jira stories and wait until the epic is done.',
];

export default function Blueprints() {
  usePageTitle('Blueprints');
  const { blueprints, reload } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [generateOpen, setGenerateOpen] = useState(false);

  const counts = useMemo(() => ({
    all: blueprints.length,
    active: blueprints.filter((b) => b.status === 'active').length,
    draft: blueprints.filter((b) => b.status === 'draft').length,
    archived: blueprints.filter((b) => b.status === 'archived').length,
  }), [blueprints]);

  const query = q.trim().toLowerCase();
  const shown = blueprints
    .filter((b) => filter === 'all' || b.status === filter)
    .filter((b) => !query || [b.name, b.key, b.kind, b.description].some((v) => v.toLowerCase().includes(query)))
    .sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : ['active', 'draft', 'archived'].indexOf(a.status) - ['active', 'draft', 'archived'].indexOf(b.status)));

  const newBlank = () => {
    clearGeneratedDraft();
    navigate(paths.blueprint('new'));
  };

  return (
    <>
      <SectionHeader
        eyebrow="Studio"
        icon={Workflow}
        title="Blueprints"
        description="Workflow templates: the stages and steps the Factory runs for each kind of project — AI drafts, people decide, MCP tools deliver."
        actions={(
          <>
            <Button variant="ai" icon={Sparkles} onClick={() => setGenerateOpen(true)}>Generate with AI</Button>
            <Button icon={Plus} onClick={newBlank}>New blueprint</Button>
          </>
        )}
      />

      {blueprints.length === 0 ? (
        <EmptyState
          icon={Workflow}
          title="No blueprint yet"
          description="A blueprint describes how a kind of project flows: intake, specification, approvals, delivery, release. Start blank or let the AI draft one from a description."
          action={<div className="flex gap-2"><Button variant="ai" icon={Sparkles} onClick={() => setGenerateOpen(true)}>Generate with AI</Button><Button variant="outline" icon={Plus} onClick={newBlank}>New blueprint</Button></div>}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <Tabs<Filter> value={filter} onChange={setFilter} tabs={[
              { key: 'all', label: 'All', count: counts.all },
              { key: 'active', label: 'Active', count: counts.active },
              { key: 'draft', label: 'Drafts', count: counts.draft },
              { key: 'archived', label: 'Archived', count: counts.archived },
            ]} />
            <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search blueprints…" className="w-64 max-w-full" />
          </div>
          {shown.length === 0 ? (
            <EmptyState compact icon={Layers} title="Nothing matches" description="Try another filter or search." />
          ) : (
            <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {shown.map((bp, i) => <BlueprintCard key={bp.id} bp={bp} index={i} onChanged={reload} />)}
            </div>
          )}
        </>
      )}

      <GenerateModal open={generateOpen} onClose={() => setGenerateOpen(false)} />
    </>
  );
}

function BlueprintCard({ bp, index, onChanged }: { bp: Blueprint; index: number; onChanged: () => Promise<void> }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const steps = bp.stages.reduce((n, s) => n + s.steps.length, 0);
  const ai = bp.stages.reduce((n, s) => n + s.steps.filter((t) => ['ai_task', 'agent_task', 'quality_gate'].includes(t.type)).length, 0);
  const open = () => navigate(paths.blueprint(bp.id));

  const duplicate = () => run('duplicate', async () => {
    const copy = await api.blueprints.duplicate(bp.id);
    await onChanged();
    toast.success(`Created “${copy.name}” as a draft`, { action: { label: 'Open', onClick: () => navigate(paths.blueprint(copy.id)) } });
  });
  const setStatus = (status: BlueprintStatus) => run('status', async () => {
    await api.blueprints.update(bp.id, { status });
    await onChanged();
    toast.success(status === 'archived' ? `“${bp.name}” archived — no longer offered for new projects` : `“${bp.name}” is active`);
  });
  const remove = () => run('delete', async () => {
    if (!(await confirm({
      title: `Delete “${bp.name}”?`,
      message: 'The blueprint is removed permanently. Blueprints used by projects, watchers or fan-out steps cannot be deleted — archive them instead.',
      tone: 'danger', confirmLabel: 'Delete blueprint',
    }))) return;
    await api.blueprints.remove(bp.id);   // 409 → the backend explains who uses it (toasted by useBusy)
    await onChanged();
    toast.success(`“${bp.name}” deleted`);
  });

  return (
    <Card padding="none" onClick={open} className="group flex flex-col animate-slide-up" style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}>
      <div className="flex items-start gap-3 p-4">
        <BlueprintIcon bp={bp} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h3 className="truncate text-[15px] font-bold text-zinc-900 group-hover:text-brand-700 dark:text-white dark:group-hover:text-brand-300">{bp.name}</h3>
            {bp.builtin && <Badge size="xs" tone="brand" icon={ShieldCheck} title="Shipped with the Factory — duplicate to customise">builtin</Badge>}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <code className="font-mono">{bp.key}</code>
            <span className="text-faint">·</span>
            <span>{bp.kind}</span>
            <span className="text-faint">·</span>
            <span className="font-mono">{bp.key_prefix}-####</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1" onClick={(e) => e.stopPropagation()}>
          <Badge size="xs" tone={STATUS_TONE[bp.status]} dot>{bp.status}</Badge>
          <IconButton ref={menuAnchor} icon={MoreHorizontal} label="Actions" size="sm" busy={!!busy} onClick={() => setMenu((m) => !m)} />
          <Popover anchor={menuAnchor} open={menu} onClose={() => setMenu(false)} align="right" width={220}>
            <div className="p-1">
              <MenuItem icon={PenSquare} label="Open designer" onClick={() => { setMenu(false); open(); }} />
              <MenuItem icon={Copy} label="Duplicate" hint="as draft" onClick={() => { setMenu(false); void duplicate(); }} />
              {bp.status === 'archived' || bp.status === 'draft'
                ? <MenuItem icon={ArchiveRestore} label="Activate" onClick={() => { setMenu(false); void setStatus('active'); }} />
                : <MenuItem icon={Archive} label="Archive" onClick={() => { setMenu(false); void setStatus('archived'); }} />}
              {bp.status === 'draft' && <MenuItem icon={Archive} label="Archive" onClick={() => { setMenu(false); void setStatus('archived'); }} />}
              {!bp.builtin && <MenuItem icon={Trash2} label="Delete" danger onClick={() => { setMenu(false); void remove(); }} />}
            </div>
          </Popover>
        </div>
      </div>
      <p className="line-clamp-2 min-h-[2.5rem] px-4 text-xs leading-relaxed text-muted">{bp.description || <span className="italic text-faint">No description</span>}</p>
      <div className="mt-auto space-y-2 px-4 pb-4 pt-3">
        <MiniPipeline bp={bp} />
        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted">
          <span className="num">
            <b className="text-zinc-700 dark:text-zinc-200">{bp.stages.length}</b> stages · <b className="text-zinc-700 dark:text-zinc-200">{steps}</b> steps
            {ai > 0 && <> · <span className="text-violet-600 dark:text-violet-400">{ai} AI</span></>}
            {bp.inputs.length > 0 && <> · {bp.inputs.length} inputs</>}
          </span>
          <span className="text-faint">v{bp.version} · {timeAgo(bp.updated_at)}</span>
        </div>
      </div>
      <div className={cls('flex border-t hairline text-xs font-semibold')} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={open} className="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-brand-600 hover:bg-brand-500/5 dark:text-brand-400">
          <PenSquare size={13} /> Open designer
        </button>
        <span className="w-px bg-zinc-200 dark:bg-ink-600" />
        <button type="button" onClick={() => void duplicate()} disabled={!!busy} className="flex flex-1 items-center justify-center gap-1.5 py-2.5 text-muted hover:bg-zinc-50 hover:text-zinc-800 disabled:opacity-50 dark:hover:bg-ink-700 dark:hover:text-zinc-100">
          <Copy size={13} /> Duplicate
        </button>
      </div>
    </Card>
  );
}

function GenerateModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [description, setDescription] = useState('');
  const [busy, run] = useBusy();
  const generate = () => run('generate', async () => {
    const draft = await api.blueprints.generate(description.trim()) as Blueprint & { validation?: ValidationReport };
    const { validation, ...blueprint } = draft;
    stashGeneratedDraft({ blueprint, validation: validation ?? null, description: description.trim() });
    onClose();
    navigate(paths.blueprint('new'));
  });
  const tooShort = description.trim().length < 10;
  return (
    <Modal
      open={open}
      onClose={() => busy !== 'generate' && onClose()}
      title="Generate a blueprint with AI"
      subtitle="Describe the process in plain words — the local model drafts stages, steps, roles and operations."
      icon={Sparkles}
      iconTone="violet"
      size="lg"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy === 'generate'}>Cancel</Button>
          <Button variant="ai" icon={Sparkles} busy={busy === 'generate'} disabled={tooShort} onClick={() => void generate()}>Generate draft</Button>
        </>
      )}
    >
      <div className="space-y-4">
        <Field label="What happens, who decides?" aside={<AiRewrite value={description} onChange={setDescription} />}
          help="Mention the steps, the roles that approve, the systems to update (Jira, catalogs…) and who is told at the end.">
          <Textarea value={description} onChange={(e) => setDescription(e.target.value)} minRows={6} disabled={busy === 'generate'}
            placeholder="e.g. A business sponsor submits a use case; a PM writes the spec with AI help; security and compliance approve; the team estimates; Jira stories are created; we wait for the epic to be done, then announce the release." />
        </Field>
        {!description.trim() && (
          <div>
            <div className="label-xs mb-1.5">Examples</div>
            <div className="space-y-1.5">
              {EXAMPLES.map((ex) => (
                <button key={ex} type="button" onClick={() => setDescription(ex)}
                  className="block w-full rounded-lg border hairline px-3 py-2 text-left text-xs text-muted transition hover:border-brand-500/50 hover:bg-brand-500/5 hover:text-zinc-800 dark:hover:text-zinc-100">
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {busy === 'generate' && (
          <div className="flex items-center gap-3 rounded-lg border border-violet-500/30 bg-violet-500/5 px-3 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">
            <span className="h-2 w-2 animate-pulse rounded-full bg-violet-500" />
            The local model is designing the workflow — this can take up to a minute. The draft opens in the designer, unsaved.
          </div>
        )}
      </div>
    </Modal>
  );
}
