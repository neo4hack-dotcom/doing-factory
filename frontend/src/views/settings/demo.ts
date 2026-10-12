// The Sandbox demo flows shared by Settings › Backup and the first-run wizard: install the demo
// environment, then "a sponsor creates a use case" — the LLM invents it in the sandbox DOINg.AI and
// the watchers polling that connector run at once so the item shows up in Intake right away.
import { api } from '../../api';
import type { DemoInstallResult } from '../../types';

/** Connector test report the installer adds to DemoInstallResult. */
export interface DemoConnectorReport {
  id: string;
  name: string;
  ok: boolean;
  tool_count: number;
  error: string;
}

export type DemoInstall = DemoInstallResult & { connectors?: DemoConnectorReport[] };

export const DEMO_CONTENTS = [
  'A sandbox DOINg.AI portfolio MCP server (projects, sponsors, MCP catalog) — fictional data',
  'A sandbox Jira MCP server with projects MCPF, DATA, PAY, SEC and OPS',
  '8 people (sponsor, product manager, dev lead, developer, IT ops, security, compliance, admin) and 5 teams mapped to Jira',
  '12 operations (list / search / register MCP, Jira epics, stories, change requests…)',
  'The watcher "New DOINg.AI use cases" sending new sponsor use cases to Intake every 15 minutes',
];

export async function installDemo(): Promise<DemoInstall> {
  return (await api.admin.installDemo()) as DemoInstall;
}

export interface SimulationOutcome {
  name: string;
  description: string;
  warnings: string[];
  /** Items the watchers detected right after (null = no watcher could run). */
  detected: number | null;
  watcherError: string;
}

/** Simulates a sponsor creating a use case, then runs the watchers so it is detected now. */
export async function simulateUseCase(hint = ''): Promise<SimulationOutcome> {
  const res = (await api.admin.simulateUseCase(hint || undefined)) as { use_case: Record<string, unknown>; warnings?: string[] };
  const uc = res.use_case ?? {};
  const outcome: SimulationOutcome = {
    name: String(uc.name ?? uc.title ?? 'New use case'),
    description: String(uc.description ?? ''),
    warnings: res.warnings ?? [],
    detected: null,
    watcherError: '',
  };
  try {
    const watchers = (await api.watchers.list()).filter((w) => w.enabled && w.operation_key.startsWith('portfolio.'));
    for (const w of watchers) {
      const run = await api.watchers.run(w.id);
      if (run.ok) outcome.detected = (outcome.detected ?? 0) + run.new;
      else outcome.watcherError = run.error;
    }
  } catch (err) {
    outcome.watcherError = err instanceof Error ? err.message : 'The watcher could not run';
  }
  return outcome;
}
