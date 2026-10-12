// Settings › Backup — one JSON restore point (export / import) and the Sandbox demo environment:
// install it, then play a sponsor creating a use case that the watcher detects into Intake.
import {
  AlertTriangle, CheckCircle2, Download, FileJson, FlaskConical, Radar, Sparkles, Upload, Wand2, XCircle,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../../api';
import { Badge, Button, Input, useBusy, useConfirm, useToast } from '../../components/ui';
import { formatNumber, plural } from '../../lib/format';
import { navigate, paths } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Backup } from '../../types';
import { DEMO_CONTENTS, installDemo, simulateUseCase } from './demo';
import type { DemoInstall, SimulationOutcome } from './demo';
import { downloadJson, Note, Section } from './shared';

/** Collections and counts of a backup file, for the confirmation. */
function describeBackup(b: Backup): { lines: string[]; valid: boolean } {
  const docs = (b.docs ?? {}) as Record<string, unknown[]>;
  const lines = Object.entries(docs).map(([k, v]) => `${plural(Array.isArray(v) ? v.length : 0, k.replace(/s$/, ''), k)}`);
  if (Array.isArray(b.events)) lines.push(plural(b.events.length, 'audit event'));
  if (Array.isArray(b.llm_calls)) lines.push(plural(b.llm_calls.length, 'LLM call'));
  return { lines, valid: b.format === 'doing-factory-backup' };
}

export default function BackupTab() {
  const { reload, onboarding, settings } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const file = useRef<HTMLInputElement>(null);
  const [install, setInstall] = useState<DemoInstall | null>(null);
  const [hint, setHint] = useState('');
  const [simulation, setSimulation] = useState<SimulationOutcome | null>(null);

  const exportBackup = () => run('export', async () => {
    const backup = await api.admin.export();
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    downloadJson(`doing-factory-backup-${stamp}.json`, backup);
    toast.success('Backup downloaded.');
  });

  const importBackup = async (f: File) => {
    let backup: Backup;
    try {
      backup = JSON.parse(await f.text()) as Backup;
    } catch {
      toast.error(`${f.name} is not a JSON file.`);
      return;
    }
    const { lines, valid } = describeBackup(backup);
    const ok = await confirm({
      title: `Import ${f.name}?`,
      message: (
        <div className="space-y-2">
          {!valid && <p className="font-semibold text-amber-600">This file does not look like a DOINg.AI Factory backup.</p>}
          <p>Every collection in the file <b>replaces</b> the current one; collections absent from it are kept. Live MCP connections restart.</p>
          {lines.length > 0 && <ul className="list-disc pl-5 text-xs">{lines.map((l) => <li key={l}>{l}</li>)}</ul>}
        </div>
      ),
      tone: 'danger',
      confirmLabel: 'Import and replace',
      steps: 2,
    });
    if (!ok) return;
    await run('import', async () => {
      const res = await api.admin.import(backup);
      await reload();
      const counts = (res.imported ?? {}) as Record<string, number>;
      toast.success(`Backup imported — ${Object.entries(counts).map(([k, n]) => `${formatNumber(n)} ${k}`).join(', ') || 'done'}.`);
    });
  };

  const doInstall = () => run('install', async () => {
    const res = await installDemo();
    setInstall(res);
    await reload();
    const c = res.created;
    const added = c.users + c.teams + c.connectors + c.operations + c.watchers;
    toast.success(added ? `Sandbox installed — ${c.users} people, ${c.teams} teams, ${c.connectors} connectors, ${c.operations} operations, ${c.watchers} watcher.` : 'The Sandbox was already installed — nothing missing.');
  });

  const doSimulate = () => run('simulate', async () => {
    setSimulation(null);
    const res = await simulateUseCase(hint.trim());
    setSimulation(res);
    if (res.detected) toast.success(`"${res.name}" created in the sandbox DOINg.AI and detected into Intake.`, { action: { label: 'Open Intake', onClick: () => navigate(paths.intake()) } });
    else toast.info(`"${res.name}" created in the sandbox DOINg.AI.`);
  });

  const llmReady = !!settings?.llm.base_url && !!settings.llm.model;
  const demoInstalled = !!onboarding?.demo_installed;

  return (
    <div className="space-y-5">
      <Section title="Backup" subtitle="Everything in one JSON file: settings, people, connectors, blueprints, projects, audit chain." icon={FileJson}>
        <div className="grid gap-4 md:grid-cols-2">
          <div className="rounded-xl border p-4 hairline">
            <div className="flex items-center gap-2 text-sm font-semibold"><Download size={16} className="text-brand-500" /> Export</div>
            <p className="mt-1 text-xs text-muted">A restore point you can re-import here or on another machine.</p>
            <Note tone="amber" icon={AlertTriangle} className="mt-3">The file contains secrets in clear (API keys, connector tokens): store it like a password.</Note>
            <Button className="mt-3" icon={Download} busy={busy === 'export'} onClick={() => void exportBackup()}>Download backup</Button>
          </div>
          <div className="rounded-xl border p-4 hairline">
            <div className="flex items-center gap-2 text-sm font-semibold"><Upload size={16} className="text-brand-500" /> Import</div>
            <p className="mt-1 text-xs text-muted">Restores a backup: the collections it contains replace the current ones. The audit chain is restored with its hashes.</p>
            <input
              ref={file}
              type="file"
              accept="application/json,.json"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void importBackup(f);
              }}
            />
            <Button className="mt-3" variant="outline" icon={Upload} busy={busy === 'import'} onClick={() => file.current?.click()}>Choose a backup file…</Button>
          </div>
        </div>
      </Section>

      <Section
        title="Demo environment"
        subtitle="Try the whole factory end to end with bundled servers and fictional data — everything is labelled Sandbox."
        icon={FlaskConical}
        iconTone="violet"
        actions={demoInstalled ? <Badge tone="emerald" icon={CheckCircle2}>Installed</Badge> : <Badge tone="zinc">Not installed</Badge>}
      >
        <div className="grid gap-5 lg:grid-cols-2">
          <div>
            <p className="label-xs mb-2">What it installs</p>
            <ul className="space-y-1.5">
              {DEMO_CONTENTS.map((line) => (
                <li key={line} className="flex items-start gap-2 text-xs text-zinc-700 dark:text-zinc-300">
                  <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-brand-500" /> {line}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">Idempotent: running it again only adds what is missing. Your own data is never touched.</p>
            <Button className="mt-3" icon={FlaskConical} busy={busy === 'install'} onClick={() => void doInstall()}>
              {demoInstalled ? 'Repair / complete the demo' : 'Install demo'}
            </Button>
            {install?.connectors && install.connectors.length > 0 && (
              <ul className="mt-3 space-y-1">
                {install.connectors.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-xs">
                    {c.ok ? <CheckCircle2 size={13} className="text-emerald-500" /> : <XCircle size={13} className="text-rose-500" />}
                    <span className="font-medium">{c.name}</span>
                    <span className="text-muted">{c.ok ? plural(c.tool_count, 'tool') : c.error}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.03] p-4">
            <div className="flex items-center gap-2 text-sm font-semibold"><Wand2 size={16} className="text-violet-500" /> Simulate a sponsor creating a use case</div>
            <p className="mt-1 text-xs text-muted">
              The local LLM invents a realistic use case, a sandbox sponsor creates it in the sandbox DOINg.AI, and the watcher picks it up into Intake — the real flow, end to end.
            </p>
            <Input className="mt-3" value={hint} onChange={(e) => setHint(e.target.value)} placeholder="Optional theme, e.g. trade finance document checks" disabled={!demoInstalled} />
            <Button
              className="mt-3"
              variant="ai"
              icon={Sparkles}
              busy={busy === 'simulate'}
              disabled={!demoInstalled || !llmReady}
              onClick={() => void doSimulate()}
            >
              Simulate a new use case
            </Button>
            {!demoInstalled && <p className="mt-2 text-xs text-faint">Install the demo first.</p>}
            {demoInstalled && !llmReady && <p className="mt-2 text-xs text-amber-600 dark:text-amber-400">Configure the AI model first (Settings › AI Model).</p>}
            {simulation && (
              <div className="mt-4 rounded-lg border bg-white p-3 animate-slide-up hairline dark:bg-ink-900">
                <p className="text-sm font-semibold text-zinc-900 dark:text-white">{simulation.name}</p>
                {simulation.description && <p className="mt-1 text-xs text-muted">{simulation.description}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                  {simulation.detected !== null
                    ? <Badge tone={simulation.detected ? 'emerald' : 'zinc'} icon={Radar}>{simulation.detected ? `${plural(simulation.detected, 'new item')} in Intake` : 'No new item detected'}</Badge>
                    : <Badge tone="amber">{simulation.watcherError || 'No enabled portfolio watcher'}</Badge>}
                  {simulation.detected ? <Button size="xs" variant="outline" icon={Radar} onClick={() => navigate(paths.intake())}>Open Intake</Button> : null}
                </div>
                {simulation.warnings.map((w) => <p key={w} className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">{w}</p>)}
              </div>
            )}
          </div>
        </div>
      </Section>
    </div>
  );
}
