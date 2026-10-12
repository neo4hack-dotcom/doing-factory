// Compliance Rules (#/studio/rules): what quality gates check. Grouped by category with severity
// chips; enable/disable inline; the drawer edits everything the AI reviewer reads (description,
// guidance) and how the rule is checked (AI or a person).
import { Bot, Plus, Save, Search, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { AiRewrite } from '../../components/AiRewrite';
import {
  Badge, Button, Card, Drawer, EmptyState, Field, Input, SectionHeader, Select, Skeleton, StatusBadge, Tabs, Textarea, Toggle,
  cls, useBusy, useConfirm, useToast,
} from '../../components/ui';
import { usePageTitle } from '../../lib/pageTitle';
import { SEVERITY } from '../../lib/status';
import type { Rule, RuleCategory, RuleCheck, Severity } from '../../types';
import { MONO, TagInput } from './parts/editors';
import { fingerprint } from './parts/model';

const CATEGORIES: RuleCategory[] = ['Security', 'Data', 'Operations', 'Architecture', 'Legal', 'Quality'];
const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low'];

function blankRule(category: RuleCategory = 'Security'): Rule {
  return { id: '', code: '', title: '', description: '', category, severity: 'medium', tags: [], check: 'ai', guidance: '', enabled: true };
}

export default function Rules() {
  usePageTitle('Compliance Rules');
  const toast = useToast();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [severity, setSeverity] = useState<'' | Severity>('');
  const [editing, setEditing] = useState<Rule | null>(null);
  const [toggling, setToggling] = useState('');

  const load = () => api.rules.list().then(setRules).catch((err) => setError(err instanceof Error ? err.message : String(err)));
  useEffect(() => { void load(); }, []);

  const query = q.trim().toLowerCase();
  const filtered = useMemo(() => (rules ?? [])
    .filter((r) => !severity || r.severity === severity)
    .filter((r) => !query || [r.code, r.title, r.description, r.guidance, ...r.tags].some((v) => v.toLowerCase().includes(query))), [rules, severity, query]);
  const groups = CATEGORIES.map((c) => ({
    category: c,
    rules: filtered.filter((r) => r.category === c).sort((a, b) => SEVERITY[b.severity].rank - SEVERITY[a.severity].rank || a.code.localeCompare(b.code)),
  })).filter((g) => g.rules.length);
  const all = rules ?? [];

  const toggle = async (rule: Rule, enabled: boolean) => {
    setToggling(rule.id);
    setRules((list) => (list ?? []).map((r) => (r.id === rule.id ? { ...r, enabled } : r)));   // optimistic
    try {
      const saved = await api.rules.update(rule.id, { enabled });
      setRules((list) => (list ?? []).map((r) => (r.id === saved.id ? saved : r)));
    } catch (err) {
      setRules((list) => (list ?? []).map((r) => (r.id === rule.id ? rule : r)));
      toast.error(err);
    } finally {
      setToggling('');
    }
  };

  return (
    <>
      <SectionHeader
        eyebrow="Studio"
        icon={ShieldCheck}
        title="Compliance Rules"
        description="What quality gates check before a delivery moves on: the AI reviews the evidence against each enabled rule; manual rules wait for a person."
        actions={<Button icon={Plus} onClick={() => setEditing(blankRule())}>Add rule</Button>}
      />

      {error ? (
        <EmptyState icon={ShieldCheck} title="Cannot load the rules" description={error} />
      ) : !rules ? (
        <div className="space-y-3"><Skeleton className="h-10 w-full" /><Skeleton className="h-64 w-full" /></div>
      ) : rules.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="No compliance rule" description="Quality gates have nothing to check. Add your first rule — security, data protection, operations…"
          action={<Button icon={Plus} onClick={() => setEditing(blankRule())}>Add rule</Button>} />
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {SEVERITIES.map((s) => {
              const n = all.filter((r) => r.severity === s && r.enabled).length;
              const on = severity === s;
              return (
                <button key={s} type="button" onClick={() => setSeverity(on ? '' : s)}
                  className={cls('card flex items-center justify-between px-3 py-2.5 text-left transition', on ? 'ring-2 ring-brand-500/40' : 'hover:border-zinc-300 dark:hover:border-ink-400')}>
                  <StatusBadge kind="severity" value={s} />
                  <span className="num text-lg font-bold text-zinc-900 dark:text-white">{n}<span className="ml-1 text-[11px] font-normal text-faint">enabled</span></span>
                </button>
              );
            })}
          </div>
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search code, title, tag…" className="w-72 max-w-full" />
            {severity && <Button size="sm" variant="ghost" onClick={() => setSeverity('')}>Clear severity filter</Button>}
            <span className="num ml-auto text-xs text-muted">{all.filter((r) => r.enabled).length} of {all.length} enabled</span>
          </div>
          {groups.length === 0 ? (
            <EmptyState compact icon={Search} title="No rule matches" />
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <Card key={g.category} padding="none">
                  <div className="flex items-center justify-between gap-2 border-b hairline px-4 py-2.5">
                    <h2 className="text-sm font-bold text-zinc-900 dark:text-white">{g.category}</h2>
                    <div className="flex items-center gap-1">
                      {SEVERITIES.map((s) => {
                        const n = g.rules.filter((r) => r.severity === s).length;
                        return n ? <Badge key={s} size="xs" tone={SEVERITY[s].tone}>{n} {s}</Badge> : null;
                      })}
                    </div>
                  </div>
                  <ul>
                    {g.rules.map((r) => (
                      <li key={r.id} className={cls('flex items-start gap-3 border-b hairline px-4 py-3 last:border-0', !r.enabled && 'opacity-60')}>
                        <div className="pt-0.5"><Toggle size="sm" checked={r.enabled} disabled={toggling === r.id} onChange={(v) => void toggle(r, v)} /></div>
                        <button type="button" onClick={() => setEditing(r)} className="min-w-0 flex-1 text-left">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <code className="font-mono text-xs font-bold text-zinc-700 dark:text-zinc-200">{r.code}</code>
                            <span className="text-sm font-semibold text-zinc-900 hover:text-brand-700 dark:text-white dark:hover:text-brand-300">{r.title}</span>
                          </div>
                          {r.description && <p className="mt-0.5 line-clamp-2 text-xs text-muted">{r.description}</p>}
                          {r.tags.length > 0 && (
                            <div className="mt-1.5 flex flex-wrap gap-1">{r.tags.map((t) => <Badge key={t} size="xs" tone="zinc" variant="outline">{t}</Badge>)}</div>
                          )}
                        </button>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <StatusBadge kind="severity" value={r.severity} />
                          {r.check === 'ai'
                            ? <Badge size="xs" tone="violet" icon={Bot}>AI check</Badge>
                            : <Badge size="xs" tone="sky" icon={UserRound}>manual</Badge>}
                        </div>
                      </li>
                    ))}
                  </ul>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      <RuleEditor
        rule={editing}
        knownTags={[...new Set(all.flatMap((r) => r.tags))].sort()}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setRules((list) => {
            const cur = list ?? [];
            return cur.some((r) => r.id === saved.id) ? cur.map((r) => (r.id === saved.id ? saved : r)) : [...cur, saved];
          });
          setEditing(null);
        }}
        onDeleted={(id) => { setRules((list) => (list ?? []).filter((r) => r.id !== id)); setEditing(null); }}
      />
    </>
  );
}

function RuleEditor({ rule, knownTags, onClose, onSaved, onDeleted }: {
  rule: Rule | null;
  knownTags: string[];
  onClose: () => void;
  onSaved: (rule: Rule) => void;
  onDeleted: (id: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const [draft, setDraft] = useState<Rule>(rule ?? blankRule());
  const [baseline, setBaseline] = useState('');

  useEffect(() => {
    if (!rule) return;
    setDraft(rule);
    setBaseline(fingerprint(rule));
  }, [rule]);

  const dirty = !!rule && fingerprint(draft) !== baseline;
  const set = (patch: Partial<Rule>) => setDraft((d) => ({ ...d, ...patch }));

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', tone: 'warning', confirmLabel: 'Discard' }))) return;
    onClose();
  };
  const save = () => run('save', async () => {
    const saved = draft.id ? await api.rules.update(draft.id, draft) : await api.rules.create(draft);
    toast.success(`Rule ${saved.code} saved`);
    onSaved(saved);
  });
  const remove = () => run('delete', async () => {
    if (!(await confirm({ title: `Delete rule ${draft.code}?`, message: 'Quality gates stop checking it. Past gate results keep their findings.', tone: 'danger', confirmLabel: 'Delete rule' }))) return;
    await api.rules.remove(draft.id);
    toast.success(`Rule ${draft.code} deleted`);
    onDeleted(draft.id);
  });

  return (
    <Drawer
      open={!!rule}
      onClose={() => void close()}
      icon={ShieldCheck}
      title={draft.id ? `${draft.code} · ${draft.title || 'Rule'}` : 'New compliance rule'}
      subtitle={draft.id ? draft.category : 'Checked by quality gates that select it (by tag or id)'}
      footer={(
        <>
          {draft.id && <Button variant="ghost" icon={Trash2} className="mr-auto text-rose-600 dark:text-rose-400" busy={busy === 'delete'} onClick={() => void remove()}>Delete</Button>}
          <Button variant="ghost" onClick={() => void close()}>Cancel</Button>
          <Button icon={Save} busy={busy === 'save'} disabled={!draft.title.trim() || (!!draft.id && !dirty)} onClick={() => void save()}>{draft.id ? 'Save' : 'Add rule'}</Button>
        </>
      )}
    >
      <div className="space-y-4 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <Field label="Code" help="Empty = auto (RULE-001…)">
            <Input value={draft.code} onChange={(e) => set({ code: e.target.value.toUpperCase() })} className={MONO} placeholder="SEC-010" />
          </Field>
          <Field label="Title" required>
            <Input value={draft.title} onChange={(e) => set({ title: e.target.value })} placeholder="Secrets are never stored in the repository" />
          </Field>
        </div>
        <Field label="Description" help="What must be true — the AI reviewer reads it" aside={<AiRewrite value={draft.description} onChange={(description) => set({ description })} />}>
          <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} minRows={3} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <Select value={draft.category} onChange={(e) => set({ category: e.target.value as RuleCategory })} options={CATEGORIES} />
          </Field>
          <Field label="Severity" help="Gates block on failures at or above their threshold">
            <Select value={draft.severity} onChange={(e) => set({ severity: e.target.value as Severity })}
              options={SEVERITIES.map((s) => ({ value: s, label: SEVERITY[s].label }))} />
          </Field>
        </div>
        <Field label="How it is checked">
          <Tabs<RuleCheck> size="sm" value={draft.check} onChange={(check) => set({ check })}
            tabs={[{ key: 'ai', label: 'AI check', icon: Bot }, { key: 'manual', label: 'Manual', icon: UserRound }]} />
          <p className="mt-2 text-xs text-muted">
            {draft.check === 'ai'
              ? 'The AI evaluates the evidence (vars, artifacts) against this rule and reports pass / warn / fail with its reasoning.'
              : 'The gate shows it as pending: a reviewer confirms it by hand before the project moves on.'}
          </p>
        </Field>
        <Field label="Tags" help="Gates select rules by tag (e.g. mcp, release, personal-data)">
          <TagInput value={draft.tags} onChange={(tags) => set({ tags })} suggestions={knownTags} />
        </Field>
        <Field label="Guidance" help="How to comply / what evidence to look for — shown with findings and given to the AI" aside={<AiRewrite value={draft.guidance} onChange={(guidance) => set({ guidance })} />}>
          <Textarea value={draft.guidance} onChange={(e) => set({ guidance: e.target.value })} minRows={4} />
        </Field>
        <Toggle checked={draft.enabled} onChange={(enabled) => set({ enabled })} label="Enabled" description="Disabled rules are ignored by every gate." />
      </div>
    </Drawer>
  );
}
