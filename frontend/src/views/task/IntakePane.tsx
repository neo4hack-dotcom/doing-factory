// Inbox right pane for an intake item: what the watcher detected, the AI's triage suggestion, and
// Accept (start a project) / Dismiss — the full triage board stays in #/intake.
import { ArrowRight, Check, Radar, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, EmptyState, Skeleton, StatusBadge, useConfirmReason, useToast } from '../../components/ui';
import { api, errorMessage } from '../../api';
import { formatDateTime, timeAgo } from '../../lib/format';
import { Link, navigate, paths } from '../../lib/router';
import { useApp, useLive } from '../../lib/store';
import type { IntakeItem } from '../../types';
import { ActionBar, AiChip, AiWorking, Callout, Collapsible, JsonBlock, Section } from './common';

/** The richest free-text field of a detected item (DOINg.AI use cases carry `context`). */
function rawText(raw: Record<string, unknown>): string {
  for (const key of ['context', 'description', 'summary', 'body']) {
    const v = raw[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

export function IntakePane({ intakeId, onDecided }: { intakeId: string; onDecided: () => void }) {
  const { userId, blueprintById, teamById, userById } = useApp();
  const toast = useToast();
  const confirmReason = useConfirmReason();
  const [item, setItem] = useState<IntakeItem | null | undefined>(undefined);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const all = await api.intake.list();
      setItem(all.find((i) => i.id === intakeId) ?? null);
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [intakeId]);

  useEffect(() => {
    setItem(undefined);
    void load();
  }, [load]);
  useLive('intake.updated', (e) => {
    if (e.item?.id === intakeId) setItem(e.item);
  });

  if (error) return <Callout tone="rose" icon={X} title="Could not load this intake item">{error}</Callout>;
  if (item === undefined) return <div className="space-y-3"><Skeleton className="h-6 w-2/3" /><Skeleton lines={5} /></div>;
  if (item === null) {
    return <EmptyState compact icon={Radar} title="This intake item is gone" description="It may have been accepted or dismissed by someone else." action={<Link to={paths.intake()} className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-400">Open Intake</Link>} />;
  }

  const s = item.suggestion;
  const bp = blueprintById(s?.blueprint_id);
  const decided = item.status !== 'new';
  const text = rawText(item.raw ?? {});

  const accept = async () => {
    setBusy('accept');
    try {
      const project = await api.intake.accept(item.id, userId);
      toast.success(`${project.key} started from “${item.title}”`, { action: { label: 'Open project', onClick: () => navigate(paths.project(project.id)) } });
      onDecided();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async () => {
    const reason = await confirmReason({
      title: `Dismiss “${item.title}”?`,
      message: 'No project is started. The item stays visible in Intake as dismissed.',
      tone: 'warning',
      confirmLabel: 'Dismiss',
      reasonPlaceholder: 'Duplicate, out of scope, not ready…',
    });
    if (reason === null) return;
    setBusy('dismiss');
    try {
      await api.intake.dismiss(item.id, userId, reason);
      toast.success('Dismissed');
      onDecided();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  const analyze = async () => {
    setBusy('analyze');
    try {
      setItem(await api.intake.analyze(item.id));
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <header className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400"><Radar size={19} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted">
            Detected by <b>{item.watcher_name || 'a watcher'}</b> · <span title={formatDateTime(item.detected_at)}>{timeAgo(item.detected_at)}</span>
            {item.external_id && <> · <code className="font-mono">{item.external_id}</code></>}
          </div>
          <h2 className="mt-0.5 text-lg font-bold tracking-tight text-zinc-900 dark:text-white">{item.title}</h2>
        </div>
        <StatusBadge kind="intake" value={item.status} />
      </header>

      {item.ai_busy ? (
        <AiWorking label="The AI is qualifying this item…" lines={4} />
      ) : s ? (
        <div className="overflow-hidden rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-50/70 to-white dark:from-violet-500/[0.07] dark:to-transparent">
          <div className="flex flex-wrap items-center gap-2 border-b border-violet-500/15 px-3.5 py-2">
            <AiChip label="AI triage" />
            {s.confidence && <Badge tone={s.confidence === 'high' ? 'emerald' : s.confidence === 'low' ? 'rose' : 'amber'} size="xs">{s.confidence} confidence</Badge>}
          </div>
          <div className="space-y-3 px-3.5 py-3 text-sm">
            {s.summary && <Markdown content={s.summary} size="xs" />}
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
              <Fact label="Blueprint" value={bp?.name ?? (s.blueprint_id ? s.blueprint_id : '—')} />
              <Fact label="Priority" value={s.priority ? <StatusBadge kind="priority" value={s.priority} size="xs" /> : '—'} />
              <Fact label="Team" value={teamById(s.team_id)?.name ?? '—'} />
              <Fact label="Sponsor" value={userById(s.sponsor_id)?.name ?? '—'} />
            </dl>
            {s.required_capabilities.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {s.required_capabilities.map((c) => <Badge key={c} tone="indigo" size="xs">{c}</Badge>)}
              </div>
            )}
            {s.rationale && <p className="text-xs text-muted">{s.rationale}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 dark:border-ink-400">
          <Sparkles size={15} className="shrink-0 text-violet-500" />
          <p className="min-w-0 flex-1 text-xs text-muted">{item.ai_error ? `AI triage failed: ${item.ai_error}` : 'No AI triage yet — ask for a suggested blueprint, priority and team.'}</p>
          <Button size="xs" variant="ai" icon={Sparkles} busy={busy === 'analyze'} onClick={() => void analyze()}>Analyze</Button>
        </div>
      )}
      {s && item.ai_error && !item.ai_busy && (
        <p className="text-xs text-rose-600 dark:text-rose-400">The last AI triage failed (the suggestion above is from an earlier run): {item.ai_error}</p>
      )}

      {text && (
        <Section title="As detected">
          <div className="max-h-80 overflow-y-auto rounded-lg border hairline px-3 py-2.5"><Markdown content={text} size="xs" /></div>
        </Section>
      )}
      <Collapsible title="Raw item">
        <JsonBlock value={item.raw} />
      </Collapsible>

      {decided ? (
        <Callout tone={item.status === 'accepted' ? 'emerald' : 'sky'} icon={item.status === 'accepted' ? Check : X} title={item.status === 'accepted' ? 'Accepted' : 'Dismissed'}>
          {item.status === 'accepted' && item.project_id
            ? <Link to={paths.project(item.project_id)} className="font-semibold underline">Open the project</Link>
            : item.dismiss_reason || null}
        </Callout>
      ) : (
        <ActionBar note={<Link to={paths.intake()} className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline dark:text-brand-400">Open Intake <ArrowRight size={12} /></Link>}>
          <Button variant="outline" size="sm" icon={X} busy={busy === 'dismiss'} disabled={!!busy} onClick={() => void dismiss()}>Dismiss…</Button>
          <Button size="sm" icon={Check} busy={busy === 'accept'} disabled={!!busy} onClick={() => void accept()}>
            Accept{bp ? ` · ${bp.name}` : ''}
          </Button>
        </ActionBar>
      )}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label-xs">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-zinc-800 dark:text-zinc-100">{value}</dd>
    </div>
  );
}
