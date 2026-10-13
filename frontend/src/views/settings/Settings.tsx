// Settings — the administration section. A vertical tab list (#/settings/:tab, so every tab can be
// linked from an error message or the onboarding) and one file per tab; the first-run wizard can be
// re-opened from here at any time.
import { Rocket, Settings as SettingsIcon, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import type { ComponentType } from 'react';
import { Onboarding } from '../../components/Onboarding';
import { Button, SectionHeader } from '../../components/ui';
import { cls } from '../../lib/cls';
import { SETTINGS_NAV } from '../../lib/nav';
import { usePageTitle } from '../../lib/pageTitle';
import { Link, paths } from '../../lib/router';
import type { SettingsTab } from '../../lib/router';
import { useApp } from '../../lib/store';
import AiModelTab from './AiModelTab';
import AuditTab from './AuditTab';
import BackupTab from './BackupTab';
import ConnectorsTab from './ConnectorsTab';
import EngineTab from './EngineTab';
import GeneralTab from './GeneralTab';
import NotificationsTab from './NotificationsTab';
import PeopleTab from './PeopleTab';
import WatchersTab from './WatchersTab';
import { Note } from './shared';

export interface SettingsProps {
  /** Active tab from #/settings/:tab. */
  tab: SettingsTab;
}

const TABS: Record<SettingsTab, { component: ComponentType; description: string }> = {
  ai: { component: AiModelTab, description: 'The local LLM that drafts, reviews, routes and runs agents.' },
  connectors: { component: ConnectorsTab, description: 'MCP servers: DOINg.AI portfolio, Jira, notification channels, Git, docs…' },
  watchers: { component: WatchersTab, description: 'Scheduled polls that detect new use cases and feed Intake.' },
  people: { component: PeopleTab, description: 'People, teams (mapped to Jira projects) and the roles used by blueprints.' },
  notifications: { component: NotificationsTab, description: 'In-app notifications and the optional external channel.' },
  engine: { component: EngineTab, description: 'AI autonomy, agent budgets and the scheduler.' },
  general: { component: GeneralTab, description: 'Name of this Factory and the hours-saved baselines behind the KPIs.' },
  audit: { component: AuditTab, description: 'Tamper-evident trail of every human, AI and system action.' },
  backup: { component: BackupTab, description: 'Export / import everything as one JSON restore point.' },
};

export default function Settings({ tab }: SettingsProps) {
  const { isAdmin, me } = useApp();
  const [wizard, setWizard] = useState(false);
  const current = SETTINGS_NAV.find((t) => t.key === tab) ?? SETTINGS_NAV[0];
  const { component: Tab, description } = TABS[current.key];
  usePageTitle(`Settings · ${current.label}`);

  return (
    <>
      <SectionHeader
        eyebrow="Settings"
        icon={SettingsIcon}
        title={current.label}
        description={description}
        actions={<Button variant="outline" size="sm" icon={Rocket} onClick={() => setWizard(true)}>Setup wizard</Button>}
      />
      <div className="mt-6 grid gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="lg:sticky lg:top-0 lg:self-start">
          <ul className="no-scrollbar flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {SETTINGS_NAV.map((t) => {
              const Icon = t.icon;
              const active = t.key === current.key;
              return (
                <li key={t.key} className="shrink-0">
                  <Link
                    to={paths.settings(t.key)}
                    aria-current={active ? 'page' : undefined}
                    className={cls(
                      'relative flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm transition-colors',
                      active
                        ? 'bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-300'
                        : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-ink-700 dark:hover:text-zinc-100',
                    )}
                  >
                    {active && <span className="absolute inset-y-1.5 left-0 hidden w-0.5 rounded-full bg-brand-500 lg:block" />}
                    <Icon size={16} className={active ? 'text-brand-500' : 'text-zinc-400'} />
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <section className="min-w-0" key={current.key}>
          {!isAdmin && me && (
            <Note tone="amber" icon={ShieldAlert} className="mb-4">
              You are acting as <b>{me.name}</b>, who is not an administrator: the server may refuse configuration changes. Switch persona in the header to an admin.
            </Note>
          )}
          <div className="animate-fade-in"><Tab /></div>
        </section>
      </div>
      <Onboarding open={wizard} onClose={() => setWizard(false)} />
    </>
  );
}
