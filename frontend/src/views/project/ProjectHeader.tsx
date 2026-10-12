// Project page header: identity (key, inline-editable title, status, priority, blueprint), risk
// with an AI "Explain", people, due date and tags; and the project-level actions — AI status
// report (per audience, copy / print), AI summary, Ask Factory, the audit dossier download, Cancel.
import {
  Ban, Bot, Check, FileBarChart, FileDown, HelpCircle, Pencil, Printer, Sparkles, Tag, Users, X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api, errorMessage } from '../../api';
import { Markdown } from '../../components/Markdown';
import {
  Avatar, Badge, Button, CopyButton, IconButton, Input, Modal, Popover, Select, StatusBadge, Tooltip, useBusy,
  useConfirmReason, useToast,
} from '../../components/ui';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { Project, ReportAudience } from '../../types';
import { AiChip, AiWorking } from '../task/common';
import { BlueprintChip, DueChip, RiskBadge } from './bits';

export function ProjectHeader({ project, onChanged, summarizing, onSummarize }: {
  project: Project;
  onChanged: (p: Project) => void;
  summarizing: boolean;
  onSummarize: () => void;
}) {
  const { userId, userById, teamById, openCopilot } = useApp();
  const toast = useToast();
  const confirmReason = useConfirmReason();
  const [busy, run] = useBusy();
  const [reportOpen, setReportOpen] = useState(false);
  const finished = project.status === 'done' || project.status === 'cancelled';
  const sponsor = userById(project.sponsor_id);
  const owner = userById(project.owner_id);
  const team = teamById(project.team_id);

  const cancel = async () => {
    const reason = await confirmReason({
      title: `Cancel ${project.key}?`,
      message: 'Open steps stop, nobody is asked for anything more, and the project becomes read-only. This is recorded in the audit trail.',
      tone: 'danger',
      confirmLabel: 'Cancel project',
      cancelLabel: 'Keep it',
      reasonLabel: 'Reason',
      reasonPlaceholder: 'Why is this project stopped?',
    });
    if (reason === null) return;
    await run('cancel', async () => {
      onChanged(await api.projects.cancel(project.id, userId, reason));
      toast.success(`${project.key} cancelled.`);
    });
  };

  const downloadDossier = () => run('dossier', async () => {
    const { filename, markdown } = await api.projects.dossier(project.id);
    const name = filename || `${project.key}-dossier.md`;
    downloadText(name, markdown, 'text/markdown');
    toast.success(`${name} downloaded.`);
  });

  return (
    <header className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono font-bold text-brand-600 dark:text-brand-400">{project.key}</span>
            <BlueprintChip blueprintId={project.blueprint_id} name={project.blueprint_name} />
            <StatusBadge kind="project" value={project.status} size="xs" />
            <StatusBadge kind="priority" value={project.priority} size="xs" />
            <RiskExplain project={project} />
          </div>
          <EditableTitle project={project} onChanged={onChanged} readOnly={project.status === 'cancelled'} />
        </div>
        <div className="flex flex-wrap items-center gap-2 no-print">
          <Button size="sm" variant="ai" icon={FileBarChart} onClick={() => setReportOpen(true)}>Status report</Button>
          <Button size="sm" variant="outline" icon={Sparkles} busy={summarizing} onClick={onSummarize}>Summarize</Button>
          <Button size="sm" variant="outline" icon={Bot} onClick={() => openCopilot({ projectId: project.id })}>Ask Factory</Button>
          <Tooltip content="Audit pack: steps, artifacts, approvals, gate checks, links and the verified audit trail (Markdown)">
            <Button size="sm" variant="outline" icon={FileDown} busy={busy === 'dossier'} onClick={() => void downloadDossier()}>Download dossier</Button>
          </Tooltip>
          {!finished && (
            <Tooltip content="Cancel this project">
              <IconButton icon={Ban} label="Cancel project" variant="outline" busy={busy === 'cancel'} onClick={() => void cancel()} />
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <Person label="Sponsor" name={sponsor?.name} user={sponsor} />
        <Person label="Owner" name={owner?.name} user={owner} />
        {team && <span className="inline-flex items-center gap-1.5"><Users size={13} className="text-faint" /><span className="label-xs">Team</span><span className="font-medium text-zinc-700 dark:text-zinc-200">{team.name}</span></span>}
        {project.stakeholder_ids.length > 0 && (
          <span className="inline-flex items-center gap-1.5"><span className="label-xs">Stakeholders</span>{project.stakeholder_ids.length}</span>
        )}
        <span className="inline-flex items-center gap-1.5"><span className="label-xs">Due</span><DueChip due={project.due_date} status={project.status} /></span>
        <span title={formatDateTime(project.updated_at)}>Updated {timeAgo(project.updated_at)}</span>
        {project.tags.length > 0 && (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Tag size={12} className="text-faint" />
            {project.tags.map((t) => <Badge key={t} size="xs" variant="outline">{t}</Badge>)}
          </span>
        )}
      </div>

      <ReportModal open={reportOpen} onClose={() => setReportOpen(false)} project={project} />
    </header>
  );
}

function Person({ label, name, user }: { label: string; name?: string; user?: { name: string; avatar_color?: string } }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="label-xs">{label}</span>
      {user ? <><Avatar user={user} size={20} /><span className="font-medium text-zinc-700 dark:text-zinc-200">{name}</span></> : <span className="text-faint">—</span>}
    </span>
  );
}

function EditableTitle({ project, onChanged, readOnly }: { project: Project; onChanged: (p: Project) => void; readOnly: boolean }) {
  const { userId } = useApp();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(project.title);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!editing) setValue(project.title);
  }, [project.title, editing]);

  const save = async () => {
    const title = value.trim();
    if (!title || title === project.title) {
      setEditing(false);
      setValue(project.title);
      return;
    }
    setSaving(true);
    try {
      onChanged(await api.projects.update(project.id, userId, { title }));
      setEditing(false);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="mt-1.5 flex max-w-3xl items-center gap-1.5">
        <Input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); setValue(project.title); }
          }}
          className="text-lg font-bold"
          aria-label="Project title"
          disabled={saving}
        />
        <IconButton icon={Check} label="Save title" variant="primary" busy={saving} onClick={() => void save()} />
        <IconButton icon={X} label="Cancel" onClick={() => { setEditing(false); setValue(project.title); }} />
      </div>
    );
  }
  return (
    <h1 className="group mt-1 flex items-start gap-2 text-xl font-bold leading-tight tracking-tight text-zinc-900 sm:text-2xl dark:text-white">
      <span className="min-w-0 break-words">{project.title}</span>
      {!readOnly && (
        <button type="button" onClick={() => setEditing(true)} aria-label="Edit title" title="Edit title"
          className="mt-1 shrink-0 rounded p-1 text-faint opacity-0 transition-opacity hover:text-zinc-700 focus-visible:opacity-100 group-hover:opacity-100 dark:hover:text-zinc-200">
          <Pencil size={14} />
        </button>
      )}
    </h1>
  );
}

function RiskExplain({ project }: { project: Project }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [markdown, setMarkdown] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const scoredAt = project.risk.computed_at ?? '';
  const cacheKey = useRef('');

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || loading || (markdown && cacheKey.current === scoredAt)) return;
    setLoading(true);
    setError('');
    try {
      const res = await api.projects.explainRisk(project.id);
      setMarkdown(res.markdown);
      cacheKey.current = scoredAt;
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1">
      <RiskBadge risk={project.risk} />
      <button ref={anchor} type="button" onClick={() => void toggle()} className="inline-flex items-center gap-0.5 rounded px-1 text-[11px] font-semibold text-violet-600 hover:underline dark:text-violet-400">
        <HelpCircle size={11} />Explain
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={380}>
        <div className="max-h-[60vh] overflow-y-auto p-3.5">
          <div className="mb-2 flex items-center gap-2">
            <AiChip label="AI risk read" />
            <span className="num text-[11px] text-muted">score {project.risk.score}/100</span>
          </div>
          {loading ? <AiWorking label="Reading the risk signals…" lines={3} />
            : error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>
              : markdown ? <Markdown content={markdown} size="xs" />
                : null}
          {project.risk.reasons.length > 0 && !loading && (
            <div className="mt-3 border-t hairline pt-2">
              <div className="label-xs mb-1">Signals</div>
              <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted">{project.risk.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      </Popover>
    </span>
  );
}

const AUDIENCES: Array<{ value: ReportAudience; label: string }> = [
  { value: 'sponsor', label: 'Sponsor — decisions, risks, dates' },
  { value: 'team', label: 'Team — tasks, blockers, next steps' },
  { value: 'executive', label: 'Executive — one-page summary' },
];

function ReportModal({ open, onClose, project }: { open: boolean; onClose: () => void; project: Project }) {
  const [audience, setAudience] = useState<ReportAudience>('sponsor');
  const [reports, setReports] = useState<Partial<Record<ReportAudience, string>>>({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const markdown = reports[audience] ?? '';

  const generate = async (aud: ReportAudience) => {
    setBusy(true);
    setError('');
    try {
      const res = await api.projects.report(project.id, aud);
      setReports((r) => ({ ...r, [aud]: res.markdown }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (open && !reports[audience] && !busy) void generate(audience);
    // Generate once per audience while the modal is open.
  }, [open, audience]);

  const print = () => printHtml(`${project.key} · Status report`, body.current?.innerHTML ?? '');

  let content: ReactNode;
  if (busy) content = <AiWorking label="Writing the status report…" lines={8} />;
  else if (error) content = <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>;
  else content = markdown ? <div ref={body}><Markdown content={markdown} /></div> : null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="Status report"
      subtitle={`${project.key} · ${project.title}`}
      icon={FileBarChart}
      iconTone="violet"
      footer={
        <>
          <Button variant="ghost" size="sm" icon={Sparkles} disabled={busy} onClick={() => void generate(audience)}>Regenerate</Button>
          <span className="flex-1" />
          <CopyButton text={markdown} label="Copy Markdown" variant="outline" />
          <Button size="sm" icon={Printer} disabled={!markdown || busy} onClick={print}>Print</Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="label-xs">Audience</span>
        <Select value={audience} onChange={(e) => setAudience(e.target.value as ReportAudience)} options={AUDIENCES} className="h-8 w-auto text-xs" aria-label="Audience" />
      </div>
      {content}
    </Modal>
  );
}

/** Saves `text` as a file through a temporary object URL (no server round-trip). */
function downloadText(filename: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Prints already-rendered (sanitised) Markdown HTML in a hidden iframe, so the report prints
 * without the app chrome and the open modal stays as it is.
 */
function printHtml(title: string, html: string): void {
  if (!html) return;
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
  document.body.appendChild(frame);
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    return;
  }
  const esc = title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] ?? c));
  doc.open();
  doc.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc}</title><style>
    body{font:13px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:32px;}
    h1,h2,h3{line-height:1.25;margin:1.2em 0 .4em} h1{font-size:22px} h2{font-size:17px} h3{font-size:14px}
    table{border-collapse:collapse;width:100%;margin:.6em 0} th,td{border:1px solid #ccc;padding:4px 8px;text-align:left}
    code,pre{font-family:ui-monospace,Menlo,monospace;font-size:12px} pre{background:#f5f5f5;padding:8px;white-space:pre-wrap}
    svg{max-width:100%} .no-print{display:none}
  </style></head><body><p style="color:#666;font-size:11px">${esc} · ${new Date().toLocaleString()}</p>${html}</body></html>`);
  doc.close();
  setTimeout(() => {
    win.focus();
    win.print();
    setTimeout(() => frame.remove(), 1000);
  }, 150);
}
