// Type-specific config forms for the 10 step types — one component per models.py config class.
// Each reads its config with defaults filled in (configOf) and writes back only the keys it edits.
import { AlertTriangle, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge, Button, Checkbox, Field, IconButton, Input, Select, Tabs, Textarea, Toggle } from '../../../components/ui';
import { SEVERITY } from '../../../lib/status';
import type {
  AgentTaskConfig, AiTaskConfig, ApprovalConfig, AudienceDef, Blueprint, Connector, EstimationConfig, FanOutConfig,
  HumanFormConfig, LinkKind, McpOperationConfig, NotifyConfig, Operation, ProjectRole, PromptDef, QualityGateConfig,
  RoleDef, Rule, StepDef, StepType, User, WaitForConfig,
} from '../../../types';
import {
  ExprInput, FieldDefsEditor, JsonEditor, MappingEditor, MultiPick, Section, TemplateField,
} from './editors';
import type { PickOption } from './editors';
import { configOf, earlierSteps, varName } from './model';
import type { StepRef, VarGroup } from './model';

export interface ConfigContext {
  bp: Blueprint;
  ref: StepRef;
  step: StepDef;
  vars: VarGroup[];
  roles: RoleDef[];
  users: User[];
  operations: Operation[];
  connectors: Connector[];
  blueprints: Blueprint[];
  rules: Rule[];
  prompts: PromptDef[];
  /** Merges `patch` into step.config. */
  set: (patch: Record<string, unknown>) => void;
}

export const PROJECT_ROLES: Array<{ value: ProjectRole; label: string }> = [
  { value: '', label: 'None' },
  { value: 'sponsor', label: 'Project sponsor' },
  { value: 'owner', label: 'Project owner' },
  { value: 'team_lead', label: 'Team lead' },
  { value: 'team', label: 'Whole team' },
];

export function roleOptions(roles: RoleDef[]): PickOption[] {
  return roles.map((r) => ({ value: r.key, label: r.label || r.key, hint: r.description }));
}

function opOptions(operations: Operation[]) {
  return operations.map((o) => ({ value: o.key, label: `${o.name || o.key} · ${o.key}${o.sensitive ? ' (writes)' : ''}` }));
}

function OperationPicker({ ctx, value, onChange, help }: { ctx: ConfigContext; value: string; onChange: (key: string) => void; help?: ReactNode }) {
  const op = ctx.operations.find((o) => o.key === value);
  const connector = op ? ctx.connectors.find((c) => c.id === op.connector_id) : undefined;
  return (
    <Field
      label="Operation"
      required
      help={help}
      error={value && !op ? `No operation with the key '${value}' — create it in Studio › Operations.` : undefined}
      aside={op?.sensitive ? <Badge size="xs" tone="amber" icon={ShieldAlert} title="Writes to an external system: asks for confirmation unless autonomy is Full">sensitive</Badge> : undefined}
    >
      <Select value={value} onChange={(e) => onChange(e.target.value)} placeholder={ctx.operations.length ? 'Select an operation…' : 'No operation defined yet'} options={opOptions(ctx.operations)}>
        {value && !op && <option value={value}>{value} (missing)</option>}
      </Select>
      {op && (
        <p className="mt-1 text-[11px] text-muted">
          {op.mode === 'direct' ? 'Direct call' : op.mode === 'llm' ? 'LLM builds the arguments' : 'Agent'} · {connector?.name ?? 'unknown connector'}{op.tool ? <> · <code className="font-mono">{op.tool}</code></> : null}
          {op.description ? ` — ${op.description}` : ''}
        </p>
      )}
    </Field>
  );
}

function opInputKeys(ctx: ConfigContext, key: string) {
  const op = ctx.operations.find((o) => o.key === key);
  return (op?.inputs ?? []).map((f) => ({ key: f.key, label: f.label, required: f.required }));
}

// ---------------------------------------------------------------------------------------------

function AiTaskForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as AiTaskConfig;
  const promptOptions = ctx.prompts.map((p) => ({ value: p.key, label: `${p.name} · ${p.key}` }));
  return (
    <>
      <TemplateField label="Prompt" required value={c.prompt} onChange={(prompt) => ctx.set({ prompt })} vars={ctx.vars} minRows={6}
        help="What the AI must produce. The project brief is appended automatically when “Include project context” is on."
        placeholder="Write the functional specification for {{ project.title }}…" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="System prompt" help="The AI role, from Studio › Prompts">
          <Select value={c.system_prompt} onChange={(e) => ctx.set({ system_prompt: e.target.value })} options={promptOptions}>
            {!promptOptions.some((o) => o.value === c.system_prompt) && <option value={c.system_prompt}>{c.system_prompt}</option>}
          </Select>
        </Field>
        <Field label="Output">
          <Select value={c.output} onChange={(e) => ctx.set({ output: e.target.value })}
            options={[{ value: 'markdown', label: 'Markdown document' }, { value: 'json', label: 'Structured JSON' }]} />
        </Field>
      </div>
      {c.output === 'json' && (
        <Field label="JSON schema" help="Optional: the output is validated against it (and stored as vars.<name>).">
          <JsonEditor value={c.json_schema} nullable onChange={(json_schema) => ctx.set({ json_schema })} placeholder='{"type": "object", "properties": {…}}' />
        </Field>
      )}
      <Field label="Artifact title" help="Saved as a versioned project artifact; empty = the step name">
        <Input value={c.artifact_title} onChange={(e) => ctx.set({ artifact_title: e.target.value })} />
      </Field>
      <div className="space-y-2">
        <Toggle checked={c.review} onChange={(review) => ctx.set({ review })} label="Human review"
          description="A person approves, edits or regenerates the draft before the workflow continues." />
        <Toggle checked={c.include_context} onChange={(include_context) => ctx.set({ include_context })} label="Include project context"
          description="Appends the project brief (description, inputs, latest artifacts)." />
      </div>
    </>
  );
}

function HumanFormForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as HumanFormConfig;
  return (
    <>
      <Field label="Instructions" help="Shown above the form">
        <Textarea value={c.instructions} onChange={(e) => ctx.set({ instructions: e.target.value })} minRows={2} />
      </Field>
      <Section title="Form fields" hint={`Stored in vars.${varName(ctx.step)}.<key>`}>
        <FieldDefsEditor fields={c.fields} onChange={(fields) => ctx.set({ fields })} emptyLabel="No field yet — add the questions the assignee answers." />
      </Section>
      <TemplateField label="AI prefill prompt" value={c.ai_prefill} onChange={(ai_prefill) => ctx.set({ ai_prefill })} vars={ctx.vars}
        help="Optional. The AI drafts the empty fields in the background; the person reviews and submits. Empty = no AI draft."
        placeholder="Draft the answers from the use case description…" />
      <Field label="Artifact title" help="The submitted form is saved as a Markdown artifact">
        <Input value={c.artifact_title} onChange={(e) => ctx.set({ artifact_title: e.target.value })} />
      </Field>
      <Toggle checked={c.include_context} onChange={(include_context) => ctx.set({ include_context })} label="Include project context in the AI prefill" />
    </>
  );
}

function ApprovalForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as ApprovalConfig;
  const earlier = earlierSteps(ctx.bp, ctx.ref);
  const setApprovers = (approvers: ApprovalConfig['approvers']) => ctx.set({ approvers });
  const roleOpts = ctx.roles.map((r) => ({ value: r.key, label: r.label || r.key }));
  return (
    <>
      <Section title="Approvers" hint="One approval per listed role (any user holding it, or explicitly assigned)"
        actions={<Button size="xs" variant="outline" icon={Plus} onClick={() => setApprovers([...c.approvers, { role: '', label: '' }])}>Add</Button>}>
        {c.approvers.length === 0 && <p className="text-xs italic text-faint">No approver — the step's assignees decide.</p>}
        {c.approvers.map((a, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-1.5">
            <Select value={a.role} placeholder="Role…" options={roleOpts}
              onChange={(e) => setApprovers(c.approvers.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}>
              {a.role && !roleOpts.some((o) => o.value === a.role) && <option value={a.role}>{a.role} (unknown)</option>}
            </Select>
            <Input value={a.label} placeholder="Label (e.g. Security officer)"
              onChange={(e) => setApprovers(c.approvers.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
            <IconButton icon={Trash2} label="Remove approver" size="xs" onClick={() => setApprovers(c.approvers.filter((_, j) => j !== i))} />
          </div>
        ))}
      </Section>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Policy">
          <Select value={c.policy} onChange={(e) => ctx.set({ policy: e.target.value })} options={[
            { value: 'all', label: 'All roles must approve' }, { value: 'any', label: 'First approval wins' }, { value: 'quorum', label: 'Quorum (n approvals)' },
          ]} />
        </Field>
        {c.policy === 'quorum' && (
          <Field label="Quorum">
            <Input type="number" min={1} value={c.quorum} onChange={(e) => ctx.set({ quorum: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="On rejection">
          <Select value={c.on_reject.action} onChange={(e) => ctx.set({ on_reject: { ...c.on_reject, action: e.target.value } })} options={[
            { value: 'reopen', label: 'Send back (reopen a step)' }, { value: 'fail', label: 'Fail the project' },
          ]} />
        </Field>
        {c.on_reject.action === 'reopen' && (
          <Field label="Send back to" help="Only earlier steps">
            <Select value={c.on_reject.goto_step} onChange={(e) => ctx.set({ on_reject: { ...c.on_reject, goto_step: e.target.value } })}
              options={[{ value: '', label: 'The previous step' }, ...earlier.map((t) => ({ value: t.id, label: `${t.name || t.id} · ${t.id}` }))]} />
          </Field>
        )}
      </div>
      <TemplateField label="Decision brief prompt" value={c.brief_prompt} onChange={(brief_prompt) => ctx.set({ brief_prompt })} vars={ctx.vars}
        help="Optional. The AI writes a short brief for approvers (risks, what they are signing)." minRows={3} />
      <Field label="Show to approvers" help="Earlier outputs displayed in the approval panel">
        <MultiPick value={c.show_vars} onChange={(show_vars) => ctx.set({ show_vars })} mono
          options={earlier.map((t) => ({ value: varName(t), label: `vars.${varName(t)}`, hint: t.name }))}
          emptyHint="No earlier step yet." />
      </Field>
    </>
  );
}

function EstimationForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as EstimationConfig;
  return (
    <>
      <Field label="Unit">
        <Select value={c.unit} onChange={(e) => ctx.set({ unit: e.target.value })} options={[{ value: 'days', label: 'Days' }, { value: 'points', label: 'Story points' }]} />
      </Field>
      <Toggle checked={c.ai_suggest} onChange={(ai_suggest) => ctx.set({ ai_suggest })} label="AI suggestion" description="The AI proposes a value, a breakdown and its rationale to start from." />
      {c.ai_suggest && (
        <TemplateField label="Suggestion prompt" value={c.prompt} onChange={(prompt) => ctx.set({ prompt })} vars={ctx.vars} minRows={3}
          help="Optional: extra guidance for the AI estimate (empty = default)." />
      )}
      <Toggle checked={c.require_breakdown} onChange={(require_breakdown) => ctx.set({ require_breakdown })} label="Require a breakdown" />
    </>
  );
}

const LINK_KINDS: Array<{ value: LinkKind; label: string }> = [
  { value: 'jira', label: 'Jira issue' }, { value: 'mcp', label: 'MCP server' }, { value: 'url', label: 'Web link' }, { value: 'doc', label: 'Document' },
];

function McpOperationForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as McpOperationConfig;
  const link = c.create_link;
  const outputVars: VarGroup[] = [{ title: 'Operation output', items: [{ path: 'output', label: 'The result (after extract)' }] }, ...ctx.vars];
  return (
    <>
      <OperationPicker ctx={ctx} value={c.operation_key} onChange={(operation_key) => ctx.set({ operation_key })} />
      <Section title="Input" hint="Values passed to the operation — Jinja templates over the project context">
        <MappingEditor value={c.input} onChange={(input) => ctx.set({ input })} vars={ctx.vars} suggestedKeys={opInputKeys(ctx, c.operation_key)} emptyLabel="No input." />
      </Section>
      <Section title="Link on the project"
        actions={<Toggle size="sm" checked={!!link} onChange={(on) => ctx.set({ create_link: on ? { kind: 'jira', label: '', url: '', external_id: '' } : null })} label="Create a link" />}>
        {link ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Kind">
              <Select value={link.kind} onChange={(e) => ctx.set({ create_link: { ...link, kind: e.target.value } })} options={LINK_KINDS} />
            </Field>
            <ExprInput label="Label" value={link.label} onChange={(label) => ctx.set({ create_link: { ...link, label } })} vars={outputVars} expression={false} placeholder="Epic {{ output.key }}" />
            <ExprInput label="URL" value={link.url} onChange={(url) => ctx.set({ create_link: { ...link, url } })} vars={outputVars} expression={false} placeholder="{{ output.url }}" />
            <ExprInput label="External id" value={link.external_id} onChange={(external_id) => ctx.set({ create_link: { ...link, external_id } })} vars={outputVars} expression={false} placeholder="{{ output.key }}" />
          </div>
        ) : <p className="text-xs text-faint">Optionally adds a chip (Jira issue, catalog entry…) to the project from the output.</p>}
      </Section>
    </>
  );
}

function AgentTaskForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as AgentTaskConfig;
  const scope = c.connector_ids.length ? ctx.connectors.filter((x) => c.connector_ids.includes(x.id)) : ctx.connectors.filter((x) => x.enabled);
  const toolOptions: PickOption[] = scope.flatMap((conn) => conn.tools.map((t) => ({
    value: `${conn.slug}__${t.name}`, label: t.name, hint: t.description, group: conn.name,
    badge: t.sensitive ? <Badge size="xs" tone="amber">writes</Badge> : undefined,
  })));
  return (
    <>
      <TemplateField label="Goal" required value={c.goal} onChange={(goal) => ctx.set({ goal })} vars={ctx.vars} minRows={5} rewrite
        help="What the agent must achieve with the tools. Be explicit about the expected result." />
      <Field label="Connectors" help="Empty = every enabled connector">
        <MultiPick value={c.connector_ids} onChange={(connector_ids) => ctx.set({ connector_ids })} placeholder="All enabled connectors"
          options={ctx.connectors.map((x) => ({ value: x.id, label: x.name, hint: `${x.tools.length} tools · ${x.kind}${x.sandbox ? ' · sandbox' : ''}` }))}
          emptyHint="No connector — add one in Settings › Connectors." />
      </Field>
      <Field label="Allowed tools" help="Empty = all tools of the connectors. Sensitive (write) tools ask for confirmation under “Approve writes”.">
        <MultiPick value={c.allowed_tools} onChange={(allowed_tools) => ctx.set({ allowed_tools })} placeholder="All tools" mono
          options={toolOptions} emptyHint="These connectors list no tools yet — test them in Settings › Connectors." />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Max actions" help="0 = the engine default">
          <Input type="number" min={0} value={c.max_actions} onChange={(e) => ctx.set({ max_actions: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
        <Field label="Artifact title">
          <Input value={c.artifact_title} onChange={(e) => ctx.set({ artifact_title: e.target.value })} />
        </Field>
      </div>
      <Field label="Output schema" help={'Optional JSON schema of the final answer; empty = {"final": "…"}'}>
        <JsonEditor value={c.output_schema} nullable onChange={(output_schema) => ctx.set({ output_schema })} />
      </Field>
      <Toggle checked={c.include_context} onChange={(include_context) => ctx.set({ include_context })} label="Include project context" />
    </>
  );
}

function QualityGateForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as QualityGateConfig;
  const tags = [...new Set(ctx.rules.flatMap((r) => r.tags))].sort();
  const earlier = earlierSteps(ctx.bp, ctx.ref);
  const matched = ctx.rules.filter((r) => r.enabled && (
    (!c.rule_tags.length && !c.rule_ids.length) || c.rule_ids.includes(r.id) || r.tags.some((t) => c.rule_tags.includes(t))));
  return (
    <>
      <Field label="Rule tags" help="Rules carrying any of these tags. No tag and no rule = every enabled rule.">
        <MultiPick value={c.rule_tags} onChange={(rule_tags) => ctx.set({ rule_tags })} placeholder="All enabled rules"
          options={tags.map((t) => ({ value: t, label: t, hint: `${ctx.rules.filter((r) => r.tags.includes(t)).length} rules` }))}
          emptyHint="No tagged rule — add tags in Studio › Compliance Rules." />
      </Field>
      <Field label="Specific rules">
        <MultiPick value={c.rule_ids} onChange={(rule_ids) => ctx.set({ rule_ids })} placeholder="None"
          options={ctx.rules.map((r) => ({ value: r.id, label: `${r.code} · ${r.title}`, hint: `${r.category} · ${SEVERITY[r.severity]?.label ?? r.severity}${r.enabled ? '' : ' · disabled'}`, group: r.category }))} />
      </Field>
      <p className="text-xs text-muted"><b className="num">{matched.length}</b> enabled rule{matched.length === 1 ? '' : 's'} will be checked.</p>
      <Field label="Evidence" help="Earlier outputs given to the AI; empty = all vars + artifacts">
        <MultiPick value={c.evidence} onChange={(evidence) => ctx.set({ evidence })} placeholder="All vars and artifacts" mono
          options={earlier.map((t) => ({ value: varName(t), label: `vars.${varName(t)}`, hint: t.name }))} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Block on" help="Failures at or above this severity stop the gate">
          <Select value={c.block_on} onChange={(e) => ctx.set({ block_on: e.target.value })} options={[
            { value: 'critical', label: 'Critical only' }, { value: 'high', label: 'High and above' }, { value: 'medium', label: 'Medium and above' }, { value: 'any', label: 'Any failure' },
          ]} />
        </Field>
        <Field label="Override roles" help="Who may override a blocking finding">
          <MultiPick value={c.override_roles} onChange={(override_roles) => ctx.set({ override_roles })} options={roleOptions(ctx.roles)} />
        </Field>
      </div>
    </>
  );
}

const INHERIT = [
  { value: 'sponsor', label: 'Sponsor' }, { value: 'owner', label: 'Owner' }, { value: 'team', label: 'Team' }, { value: 'priority', label: 'Priority' },
];

function FanOutForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as FanOutConfig;
  const target = ctx.blueprints.find((b) => b.key === c.blueprint_key);
  const itemVars: VarGroup[] = [{ title: 'Item', hint: 'The current element of the list', items: [{ path: 'item', label: 'Current item' }] }, ...ctx.vars];
  return (
    <>
      <ExprInput label="Items" value={c.items} onChange={(items) => ctx.set({ items })} vars={ctx.vars} placeholder="vars.dependencies.missing"
        help="A Jinja expression returning a list: one child project per element. Empty list → done “No items”." />
      <Field label="Child blueprint" required error={c.blueprint_key && !target ? `No blueprint with the key '${c.blueprint_key}'` : undefined}>
        <Select value={c.blueprint_key} onChange={(e) => ctx.set({ blueprint_key: e.target.value })} placeholder="Select a blueprint…"
          options={ctx.blueprints.filter((b) => b.key && b.key !== ctx.bp.key).map((b) => ({ value: b.key, label: `${b.name} · ${b.key}${b.status !== 'active' ? ` (${b.status})` : ''}` }))} />
      </Field>
      <ExprInput label="Child title" value={c.title} onChange={(title) => ctx.set({ title })} vars={itemVars} expression={false} placeholder="MCP server: {{ item.name }}" />
      <Section title="Child inputs" hint={target ? `Inputs of “${target.name}”` : 'Pick the child blueprint to see its inputs'}>
        <MappingEditor value={c.inputs} onChange={(inputs) => ctx.set({ inputs })} vars={itemVars} emptyLabel="No input mapping."
          suggestedKeys={(target?.inputs ?? []).map((f) => ({ key: f.key, label: f.label, required: f.required }))} />
      </Section>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Wait">
          <Select value={c.wait} onChange={(e) => ctx.set({ wait: e.target.value })} options={[
            { value: 'all', label: 'Until every child is done' }, { value: 'none', label: 'Do not wait' },
          ]} />
        </Field>
        <Field label="Children inherit">
          <MultiPick value={c.inherit} onChange={(inherit) => ctx.set({ inherit })} options={INHERIT} placeholder="Nothing" />
        </Field>
      </div>
    </>
  );
}

type AudienceKind = 'role' | 'project_role' | 'user_id';

function audienceKind(a: AudienceDef): AudienceKind {
  return a.user_id ? 'user_id' : a.project_role ? 'project_role' : 'role';
}

function NotifyForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as NotifyConfig;
  const setAudience = (audience: AudienceDef[]) => ctx.set({ audience });
  const mode = c.prompt || !c.body ? 'ai' : 'static';
  const blank: AudienceDef = { role: '', project_role: '', user_id: '' };
  return (
    <>
      <Section title="Audience" actions={<Button size="xs" variant="outline" icon={Plus} onClick={() => setAudience([...c.audience, { ...blank, project_role: 'sponsor' }])}>Add</Button>}>
        {c.audience.length === 0 && <p className="text-xs italic text-amber-600 dark:text-amber-400">Nobody will be notified — add at least one recipient.</p>}
        {c.audience.map((a, i) => {
          const kind = audienceKind(a);
          const update = (next: AudienceDef) => setAudience(c.audience.map((x, j) => (j === i ? next : x)));
          return (
            <div key={i} className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-1.5">
              <Select value={kind} onChange={(e) => {
                const k = e.target.value as AudienceKind;
                update(k === 'role' ? { ...blank, role: ctx.roles[0]?.key ?? '' } : k === 'project_role' ? { ...blank, project_role: 'sponsor' } : { ...blank, user_id: ctx.users[0]?.id ?? '' });
              }} options={[{ value: 'project_role', label: 'Project role' }, { value: 'role', label: 'Role' }, { value: 'user_id', label: 'Person' }]} />
              {kind === 'role' ? (
                <Select value={a.role} onChange={(e) => update({ ...blank, role: e.target.value })} options={ctx.roles.map((r) => ({ value: r.key, label: r.label || r.key }))} placeholder="Role…" />
              ) : kind === 'project_role' ? (
                <Select value={a.project_role} onChange={(e) => update({ ...blank, project_role: e.target.value as ProjectRole })} options={PROJECT_ROLES.filter((p) => p.value)} />
              ) : (
                <Select value={a.user_id} onChange={(e) => update({ ...blank, user_id: e.target.value })} options={ctx.users.map((u) => ({ value: u.id, label: u.name }))} placeholder="Person…" />
              )}
              <IconButton icon={Trash2} label="Remove recipient" size="xs" onClick={() => setAudience(c.audience.filter((_, j) => j !== i))} />
            </div>
          );
        })}
      </Section>
      <ExprInput label="Subject" value={c.subject} onChange={(subject) => ctx.set({ subject })} vars={ctx.vars} expression={false} placeholder="{{ project.key }} is live" />
      <Tabs size="sm" value={mode} onChange={(k) => ctx.set(k === 'ai' ? { prompt: c.prompt || c.body || 'Announce the news to the recipients in a few friendly sentences.', body: '' } : { body: c.body || c.prompt, prompt: '' })}
        tabs={[{ key: 'ai', label: 'AI writes the message' }, { key: 'static', label: 'Static message' }]} />
      {mode === 'ai' ? (
        <TemplateField label="Prompt" value={c.prompt} onChange={(prompt) => ctx.set({ prompt })} vars={ctx.vars} minRows={3}
          help="The AI writes the body for these recipients." />
      ) : (
        <TemplateField label="Body" value={c.body} onChange={(body) => ctx.set({ body })} vars={ctx.vars} minRows={4} rewrite
          help="Rendered as is (Jinja), no LLM involved." />
      )}
      <Field label="Channel" help="External uses the operation set in Settings › Notifications">
        <Select value={c.channel} onChange={(e) => ctx.set({ channel: e.target.value })} options={[
          { value: 'in_app', label: 'In-app' }, { value: 'external', label: 'External channel' }, { value: 'both', label: 'Both' },
        ]} />
      </Field>
    </>
  );
}

function WaitForForm({ ctx }: { ctx: ConfigContext }) {
  const c = configOf(ctx.step) as WaitForConfig;
  const untilVars: VarGroup[] = [{ title: 'Operation output', items: [{ path: 'output', label: 'Latest poll result' }] }, ...ctx.vars];
  return (
    <>
      <OperationPicker ctx={ctx} value={c.operation_key} onChange={(operation_key) => ctx.set({ operation_key })} help="Polled until the condition holds" />
      <Section title="Input">
        <MappingEditor value={c.input} onChange={(input) => ctx.set({ input })} vars={ctx.vars} suggestedKeys={opInputKeys(ctx, c.operation_key)} emptyLabel="No input." />
      </Section>
      <ExprInput label="Until" value={c.until} onChange={(until) => ctx.set({ until })} vars={untilVars} placeholder="output.status == 'Done'"
        help="A condition over `output`; true → the step is done." />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Poll every (minutes)">
          <Input type="number" min={1} value={c.poll_minutes} onChange={(e) => ctx.set({ poll_minutes: Math.max(1, Number(e.target.value) || 1) })} />
        </Field>
        <Field label="Timeout (hours)" help="0 = wait forever">
          <Input type="number" min={0} step="0.5" value={c.timeout_hours} onChange={(e) => ctx.set({ timeout_hours: Math.max(0, Number(e.target.value) || 0) })} />
        </Field>
      </div>
      <Checkbox checked={c.manual_complete} onChange={(manual_complete) => ctx.set({ manual_complete })} label="Allow manual completion" description="A person may mark it done without waiting." />
    </>
  );
}

const FORMS: Record<StepType, (props: { ctx: ConfigContext }) => ReactNode> = {
  ai_task: AiTaskForm,
  human_form: HumanFormForm,
  approval: ApprovalForm,
  estimation: EstimationForm,
  mcp_operation: McpOperationForm,
  agent_task: AgentTaskForm,
  quality_gate: QualityGateForm,
  fan_out: FanOutForm,
  notify: NotifyForm,
  wait_for: WaitForForm,
};

export function StepConfigForm({ ctx }: { ctx: ConfigContext }) {
  const Form = FORMS[ctx.step.type];
  if (!Form) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <AlertTriangle size={13} /> Unknown step type '{ctx.step.type}' — pick a type above.
      </p>
    );
  }
  return <div className="space-y-4"><Form ctx={ctx} /></div>;
}

