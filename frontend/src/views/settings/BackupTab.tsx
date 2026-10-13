// Settings › Backup — one JSON restore point: export everything, or import a backup file.
import { AlertTriangle, Download, FileJson, Upload } from 'lucide-react';
import { useRef } from 'react';
import { api } from '../../api';
import { Button, useBusy, useConfirm, useToast } from '../../components/ui';
import { formatNumber, plural } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { Backup } from '../../types';
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
  const { reload } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const file = useRef<HTMLInputElement>(null);

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
    </div>
  );
}
