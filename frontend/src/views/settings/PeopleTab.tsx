// Settings › People & Teams — who works in the Factory. Roles drive step assignment and approvals,
// teams map to Jira projects (routing), and every change reloads the shared reference data so the
// persona switcher, pickers and inboxes follow at once.
import { Contact, Pencil, Plus, Save, Search, ShieldCheck, Trash2, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '../../api';
import {
  Avatar, AvatarStack, Badge, Button, Card, EmptyState, Field, IconButton, Input, Modal, Select, Tabs, Textarea, Toggle,
  TONE, toneOf, useBusy, useConfirm, useToast,
} from '../../components/ui';
import { cls } from '../../lib/cls';
import { plural } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { RoleDef, Team, Tone, User } from '../../types';
import { ChipSelect, Note } from './shared';

type PeopleView = 'users' | 'teams' | 'roles';

const TONES: Tone[] = ['zinc', 'brand', 'emerald', 'sky', 'amber', 'rose', 'violet', 'indigo', 'cyan', 'fuchsia', 'pink', 'orange', 'teal'];

export default function PeopleTab() {
  const { users, teams, roles } = useApp();
  const [view, setView] = useState<PeopleView>('users');
  return (
    <div className="space-y-4">
      <Tabs<PeopleView>
        value={view}
        onChange={setView}
        tabs={[
          { key: 'users', label: 'People', icon: Contact, count: users.length },
          { key: 'teams', label: 'Teams', icon: Users, count: teams.length },
          { key: 'roles', label: 'Roles', icon: ShieldCheck, count: roles.length },
        ]}
      />
      {view === 'users' && <UsersPanel />}
      {view === 'teams' && <TeamsPanel />}
      {view === 'roles' && <RolesPanel />}
    </div>
  );
}

export function RoleChip({ roleKey }: { roleKey: string }) {
  const { roleByKey } = useApp();
  const role = roleByKey(roleKey);
  return <Badge tone={toneOf(role?.color)} size="xs" title={role?.description}>{role?.label ?? roleKey}</Badge>;
}

// ---- Users -------------------------------------------------------------------------------------

function UsersPanel() {
  const { users, teamById, reload, userId } = useApp();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<User | 'new' | null>(null);
  const [busy, run] = useBusy();
  const confirm = useConfirm();
  const toast = useToast();

  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    const list = s ? users.filter((u) => `${u.name} ${u.email} ${u.title} ${u.roles.join(' ')}`.toLowerCase().includes(s)) : users;
    return [...list].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  }, [users, q]);

  const toggleActive = (u: User) => run(`act:${u.id}`, async () => {
    await api.users.update(u.id, { active: !u.active });
    await reload();
  });

  const remove = async (u: User) => {
    const ok = await confirm({
      title: `Delete ${u.name}?`,
      message: 'Projects keep their history; the person leaves every team. Deactivating keeps them in pickers history instead.',
      tone: 'danger',
      confirmLabel: 'Delete person',
    });
    if (!ok) return;
    await run(`del:${u.id}`, async () => {
      await api.users.remove(u.id);
      await reload();
      toast.success(`${u.name} deleted.`);
    });
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, e-mails, roles…" className="max-w-xs" />
        <Button icon={UserPlus} className="ml-auto" onClick={() => setEditing('new')}>Add person</Button>
      </div>
      {users.length === 0 ? (
        <EmptyState icon={Contact} title="Nobody here yet" description="Add sponsors, product managers, developers, IT, security and compliance — or install the Sandbox demo team."
          action={<Button icon={UserPlus} onClick={() => setEditing('new')}>Add person</Button>} />
      ) : (
        <Card padding="none" className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b hairline">
              <tr>
                <th className="px-4 py-2.5 label-xs">Person</th>
                <th className="px-4 py-2.5 label-xs">Roles</th>
                <th className="px-4 py-2.5 label-xs">Teams</th>
                <th className="px-4 py-2.5 label-xs">Active</th>
                <th className="w-20 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
              {shown.map((u) => (
                <tr key={u.id} className={cls('group align-middle', !u.active && 'opacity-60')}>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <Avatar user={u} size={32} />
                      <div className="min-w-0">
                        <p className="truncate font-semibold text-zinc-900 dark:text-white">
                          {u.name}
                          {u.id === userId && <span className="ml-1.5 label-xs !text-brand-600 dark:!text-brand-400">you</span>}
                        </p>
                        <p className="truncate text-xs text-muted">{u.title ? `${u.title} · ` : ''}{u.email}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">{u.roles.length ? u.roles.map((r) => <RoleChip key={r} roleKey={r} />) : <span className="text-xs text-faint">—</span>}</div>
                  </td>
                  <td className="px-4 py-2.5 text-xs text-muted">{u.team_ids.map((t) => teamById(t)?.name ?? t).join(', ') || '—'}</td>
                  <td className="px-4 py-2.5"><Toggle size="sm" checked={u.active} disabled={busy === `act:${u.id}`} onChange={() => void toggleActive(u)} /></td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-0.5">
                      <IconButton icon={Pencil} label={`Edit ${u.name}`} size="xs" onClick={() => setEditing(u)} />
                      <IconButton icon={Trash2} label={`Delete ${u.name}`} size="xs" busy={busy === `del:${u.id}`} onClick={() => void remove(u)} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length === 0 && <p className="px-4 py-6 text-center text-xs text-muted">No match for "{q}".</p>}
        </Card>
      )}
      {editing && <UserModal key={editing === 'new' ? 'new' : editing.id} user={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UserModal({ user, onClose }: { user: User | null; onClose: () => void }) {
  const { roles, teams, reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [form, setForm] = useState({
    name: user?.name ?? '', email: user?.email ?? '', title: user?.title ?? '', roles: user?.roles ?? [],
    team_ids: user?.team_ids ?? [], active: user?.active ?? true, avatar_color: user?.avatar_color ?? '',
  });
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const save = () => run('save', async () => {
    const body = { ...form, name: form.name.trim(), email: form.email.trim() };
    if (user) await api.users.update(user.id, body);
    else await api.users.create(body);
    await reload();
    toast.success(`${body.name} saved.`);
    onClose();
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={user ? `Edit ${user.name}` : 'Add person'}
      icon={UserPlus}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={Save} busy={busy === 'save'} disabled={!form.name.trim()} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex items-start gap-4">
          <Avatar name={form.name || '?'} user={{ name: form.name || '?', avatar_color: form.avatar_color }} size={48} />
          <div className="grid flex-1 gap-4 sm:grid-cols-2">
            <Field label="Name" required><Input value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
            <Field label="E-mail" help="Matches sponsors detected by watchers (sponsor_email)."><Input type="email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Field>
            <Field label="Title"><Input value={form.title} onChange={(e) => set({ title: e.target.value })} placeholder="Engineering Lead" /></Field>
            <Field label="Avatar colour">
              <Select value={form.avatar_color} onChange={(e) => set({ avatar_color: e.target.value })}
                options={[{ value: '', label: 'Automatic' }, ...TONES.map((t) => ({ value: t, label: t }))]} />
            </Field>
          </div>
        </div>
        <Field label="Roles" help="Steps and approvals are assigned by role.">
          <ChipSelect options={roles.map((r) => ({ value: r.key, label: r.label, tone: toneOf(r.color), title: r.description }))}
            value={form.roles} onChange={(v) => set({ roles: v })} emptyLabel="No role defined — add some in the Roles tab." />
        </Field>
        <Field label="Teams">
          <ChipSelect options={teams.map((t) => ({ value: t.id, label: t.name }))} value={form.team_ids} onChange={(v) => set({ team_ids: v })} emptyLabel="No team yet." />
        </Field>
        <Toggle checked={form.active} onChange={(active) => set({ active })} label="Active" description="Inactive people get no new tasks and leave the pickers." />
      </div>
    </Modal>
  );
}

// ---- Teams -------------------------------------------------------------------------------------

function TeamsPanel() {
  const { teams, userById, reload } = useApp();
  const [editing, setEditing] = useState<Team | 'new' | null>(null);
  const [busy, run] = useBusy();
  const confirm = useConfirm();
  const toast = useToast();

  const remove = async (t: Team) => {
    if (!await confirm({ title: `Delete ${t.name}?`, message: 'Members stay; projects keep their history.', tone: 'danger', confirmLabel: 'Delete team' })) return;
    await run(`del:${t.id}`, async () => {
      await api.teams.remove(t.id);
      await reload();
      toast.success(`${t.name} deleted.`);
    });
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <p className="mr-auto text-sm text-muted">Teams receive delivery work; the AI routes each project to the team whose skills match.</p>
        <Button icon={Plus} onClick={() => setEditing('new')}>Add team</Button>
      </div>
      {teams.length === 0 ? (
        <EmptyState icon={Users} title="No team yet" description="A team maps to a Jira project and lists its skills, so the AI can route work to it."
          action={<Button icon={Plus} onClick={() => setEditing('new')}>Add team</Button>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {teams.map((t) => {
            const lead = userById(t.lead_user_id);
            const members = t.member_ids.map((id) => userById(id)).filter((u): u is User => !!u);
            return (
              <Card key={t.id} padding="none" className="flex flex-col">
                <div className="flex-1 p-4">
                  <div className="flex items-start gap-2">
                    <h3 className="mr-auto text-sm font-bold text-zinc-900 dark:text-white">{t.name}</h3>
                    {t.jira_project_key && <Badge tone="sky" size="xs" variant="outline" title="Jira project">{t.jira_project_key}</Badge>}
                  </div>
                  {t.jira_component && <p className="mt-0.5 text-2xs text-faint">Component · {t.jira_component}</p>}
                  {t.description && <p className="mt-1.5 line-clamp-2 text-xs text-muted">{t.description}</p>}
                  {t.skills.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">{t.skills.map((s) => <Badge key={s} tone="brand" size="xs">{s}</Badge>)}</div>
                  )}
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      {lead ? <><Avatar user={lead} size={24} /><span className="min-w-0 truncate text-xs"><span className="text-faint">Lead · </span>{lead.name}</span></> : <span className="text-xs text-faint">No lead</span>}
                    </div>
                    {members.length > 0 ? <AvatarStack users={members} max={5} size={24} /> : <span className="text-xs text-faint">No member</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1 border-t px-3 py-2 hairline">
                  <span className="mr-auto text-2xs text-faint">{plural(members.length, 'member')}</span>
                  <IconButton icon={Pencil} label={`Edit ${t.name}`} size="xs" onClick={() => setEditing(t)} />
                  <IconButton icon={Trash2} label={`Delete ${t.name}`} size="xs" busy={busy === `del:${t.id}`} onClick={() => void remove(t)} />
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {editing && <TeamModal key={editing === 'new' ? 'new' : editing.id} team={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function TeamModal({ team, onClose }: { team: Team | null; onClose: () => void }) {
  const { users, reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [form, setForm] = useState({
    name: team?.name ?? '', description: team?.description ?? '', jira_project_key: team?.jira_project_key ?? '',
    jira_component: team?.jira_component ?? '', skills: team?.skills ?? [], lead_user_id: team?.lead_user_id ?? '',
    member_ids: team?.member_ids ?? [],
  });
  const [skill, setSkill] = useState('');
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const addSkill = () => {
    const parts = skill.split(',').map((s) => s.trim()).filter((s) => s && !form.skills.includes(s));
    if (parts.length) set({ skills: [...form.skills, ...parts] });
    setSkill('');
  };
  const save = () => run('save', async () => {
    const body = { ...form, name: form.name.trim(), jira_project_key: form.jira_project_key.trim().toUpperCase() };
    if (body.lead_user_id && !body.member_ids.includes(body.lead_user_id)) body.member_ids = [...body.member_ids, body.lead_user_id];
    if (team) await api.teams.update(team.id, body);
    else await api.teams.create(body);
    await reload();
    toast.success(`${body.name} saved.`);
    onClose();
  });
  const active = users.filter((u) => u.active || form.member_ids.includes(u.id));
  return (
    <Modal
      open
      onClose={onClose}
      title={team ? `Edit ${team.name}` : 'Add team'}
      icon={Users}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button icon={Save} busy={busy === 'save'} disabled={!form.name.trim()} onClick={() => void save()}>Save</Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr_1fr]">
          <Field label="Name" required><Input value={form.name} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Jira project key"><Input value={form.jira_project_key} onChange={(e) => set({ jira_project_key: e.target.value })} className="font-mono uppercase" placeholder="MCPF" /></Field>
          <Field label="Jira component"><Input value={form.jira_component} onChange={(e) => set({ jira_component: e.target.value })} /></Field>
        </div>
        <Field label="Description"><Textarea value={form.description} minRows={2} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="Skills" help="Used by the AI to route work (e.g. python, oracle, kafka, payments). Enter or comma to add.">
          <div className="flex flex-wrap items-center gap-1.5 rounded-lg border p-2 hairline">
            {form.skills.map((s) => (
              <button key={s} type="button" title="Remove" onClick={() => set({ skills: form.skills.filter((x) => x !== s) })}
                className={cls('rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', TONE.brand.soft)}>{s} ×</button>
            ))}
            <input
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ',') {
                  e.preventDefault();
                  addSkill();
                } else if (e.key === 'Backspace' && !skill && form.skills.length) set({ skills: form.skills.slice(0, -1) });
              }}
              onBlur={addSkill}
              placeholder={form.skills.length ? '' : 'Add a skill…'}
              className="min-w-[8rem] flex-1 bg-transparent px-1 text-sm outline-none"
            />
          </div>
        </Field>
        <Field label="Lead">
          <Select value={form.lead_user_id} placeholder="No lead" onChange={(e) => set({ lead_user_id: e.target.value })}
            options={active.map((u) => ({ value: u.id, label: u.name }))} />
        </Field>
        <Field label="Members">
          <ChipSelect options={active.map((u) => ({ value: u.id, label: u.name }))} value={form.member_ids} onChange={(v) => set({ member_ids: v })} emptyLabel="Add people first." />
        </Field>
      </div>
    </Modal>
  );
}

// ---- Roles -------------------------------------------------------------------------------------

const slugKey = (label: string) => label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function RolesPanel() {
  const { roles, users, reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [rows, setRows] = useState<Array<RoleDef & { isNew?: boolean }>>(() => roles.map((r) => ({ ...r })));
  const dirty = JSON.stringify(rows.map(({ isNew: _n, ...r }) => r)) !== JSON.stringify(roles);
  const holders = (key: string) => users.filter((u) => u.roles.includes(key)).length;
  const update = (i: number, patch: Partial<RoleDef>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () => run('save', async () => {
    const list = rows.map(({ isNew: _n, ...r }) => ({ ...r, key: r.key.trim() || slugKey(r.label), label: r.label.trim() }));
    const saved = await api.roles.update(list);
    setRows(saved.map((r) => ({ ...r })));
    await reload();
    toast.success('Roles saved.');
  });

  return (
    <>
      <Note icon={ShieldCheck}>
        Roles decide who gets which step and who signs which approval in blueprints. A role still held by someone cannot be removed.
      </Note>
      <Card padding="none" className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b hairline">
            <tr>
              <th className="px-4 py-2.5 label-xs">Label</th>
              <th className="px-4 py-2.5 label-xs">Key</th>
              <th className="px-4 py-2.5 label-xs">Description</th>
              <th className="px-4 py-2.5 label-xs">Colour</th>
              <th className="px-4 py-2.5 label-xs">People</th>
              <th className="w-12" />
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
            {rows.map((r, i) => {
              const n = holders(r.key);
              return (
                <tr key={i} className="align-middle">
                  <td className="px-4 py-2">
                    <Input value={r.label} className="h-8"
                      onChange={(e) => update(i, r.isNew ? { label: e.target.value, key: slugKey(e.target.value) } : { label: e.target.value })} />
                  </td>
                  <td className="px-4 py-2">
                    <Input value={r.key} disabled={!r.isNew} className="h-8 font-mono text-xs" title={r.isNew ? '' : 'Keys are referenced by blueprints and people: they cannot change.'}
                      onChange={(e) => update(i, { key: slugKey(e.target.value) })} />
                  </td>
                  <td className="px-4 py-2"><Input value={r.description} className="h-8 text-xs" onChange={(e) => update(i, { description: e.target.value })} /></td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className={cls('h-3 w-3 shrink-0 rounded-full', TONE[toneOf(r.color)].dot)} />
                      <Select value={toneOf(r.color)} className="h-8 text-xs" options={TONES} onChange={(e) => update(i, { color: e.target.value })} />
                    </div>
                  </td>
                  <td className="num px-4 py-2 text-xs text-muted">{n || '—'}</td>
                  <td className="px-2 py-2">
                    <IconButton icon={Trash2} label={n ? `${plural(n, 'person', 'people')} hold this role` : `Remove ${r.label}`} size="xs" disabled={n > 0}
                      onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" icon={Plus} onClick={() => setRows((rs) => [...rs, { key: '', label: '', description: '', color: 'zinc', isNew: true }])}>Add role</Button>
        <Button variant="ghost" size="sm" disabled={!dirty} onClick={() => setRows(roles.map((r) => ({ ...r })))}>Discard</Button>
        <Button size="sm" icon={Save} className="ml-auto" busy={busy === 'save'} disabled={!dirty || rows.some((r) => !r.label.trim())} onClick={() => void save()}>Save roles</Button>
      </div>
    </>
  );
}
