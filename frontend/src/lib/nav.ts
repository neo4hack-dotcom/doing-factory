// Navigation vocabulary (docs/SPEC.md §11), shared by the sidebar, the command palette, the header
// title and the "g x" shortcuts — one list, so a renamed view is renamed everywhere.
import {
  Archive, BellRing, Bot, ChartColumn, Cog, FolderKanban, House, Inbox, MessageSquareText, Factory, Plug,
  Radar, ScrollText, Settings, ShieldCheck, Users, Workflow, Eye,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { paths, SETTINGS_TABS } from './router';
import type { RouteName, SettingsTab } from './router';

export interface NavItem {
  path: string;
  label: string;
  icon: LucideIcon;
  section: 'main' | 'studio' | 'bottom';
  /** Sidebar counter fed by the inbox counts. */
  badge?: 'inbox' | 'intake';
  /** Shows the live pulse (the Floor). */
  live?: boolean;
  /** "g <key>" go-to shortcut. */
  shortcut?: string;
  keywords?: string;
}

export const NAV_ITEMS: NavItem[] = [
  { path: paths.home(), label: 'Home', icon: House, section: 'main', shortcut: 'h', keywords: 'briefing dashboard start' },
  { path: paths.inbox(), label: 'Inbox', icon: Inbox, section: 'main', badge: 'inbox', shortcut: 'i', keywords: 'tasks approvals my work todo' },
  { path: paths.projects(), label: 'Projects', icon: FolderKanban, section: 'main', shortcut: 'p', keywords: 'portfolio use cases list' },
  { path: paths.floor(), label: 'Factory Floor', icon: Factory, section: 'main', live: true, shortcut: 'f', keywords: 'live board pipeline lanes' },
  { path: paths.intake(), label: 'Intake', icon: Radar, section: 'main', badge: 'intake', keywords: 'detected watcher triage new' },
  { path: paths.kpis(), label: 'KPIs', icon: ChartColumn, section: 'main', shortcut: 'k', keywords: 'metrics lead time throughput analytics' },
  { path: paths.blueprints(), label: 'Blueprints', icon: Workflow, section: 'studio', keywords: 'workflow templates stages designer' },
  { path: paths.operations(), label: 'Operations', icon: Plug, section: 'studio', keywords: 'mcp tools bindings' },
  { path: paths.prompts(), label: 'Prompts', icon: MessageSquareText, section: 'studio', keywords: 'llm system prompts library' },
  { path: paths.rules(), label: 'Compliance Rules', icon: ShieldCheck, section: 'studio', keywords: 'quality gate security rules' },
  { path: paths.settings(), label: 'Settings', icon: Settings, section: 'bottom', shortcut: 's', keywords: 'configuration admin' },
];

const SETTINGS_ICONS: Record<SettingsTab, LucideIcon> = {
  ai: Bot,
  connectors: Plug,
  watchers: Eye,
  people: Users,
  notifications: BellRing,
  engine: Cog,
  general: Settings,
  audit: ScrollText,
  backup: Archive,
};

export const SETTINGS_NAV: Array<{ key: SettingsTab; label: string; icon: LucideIcon }> =
  SETTINGS_TABS.map((t) => ({ ...t, icon: SETTINGS_ICONS[t.key] }));

/** Default header title per route (a view may override it with usePageTitle). */
export const ROUTE_TITLES: Record<RouteName, string> = {
  home: 'Home',
  inbox: 'Inbox',
  projects: 'Projects',
  'project-new': 'New project',
  project: 'Project',
  floor: 'Factory Floor',
  intake: 'Intake',
  kpis: 'KPIs',
  blueprints: 'Blueprints',
  blueprint: 'Blueprint Designer',
  operations: 'Operations',
  prompts: 'Prompts',
  rules: 'Compliance Rules',
  settings: 'Settings',
  'not-found': 'Not found',
};
