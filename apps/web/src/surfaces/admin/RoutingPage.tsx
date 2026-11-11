// Lead routing: rules, ponds and lead timers (BUILD_PLAN module 17 admin; api/admin module 10).
//
// - Rules run top to bottom; the first enabled rule that matches decides who is offered the lead
//   (R-OWN-10). Reordering sends the whole new order in one request, which the server applies in one
//   transaction, so routing never sees half an order.
// - Ponds hold unowned leads that eligible people may claim, within the pond's daily limit and
//   cooldown. A pond with leads waiting, the default pond, or one a rule still uses cannot be archived;
//   the server says which.
// - Lead timers apply to new deadlines only (R-OWN-15): deadlines already running keep their times,
//   and the page says so where the timers are edited.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { formatDuration, plural, roleLabel } from './lib/format.js';
import { useAction, useAnnounce } from './lib/hooks.js';
import { ADMIN_MESSAGES } from './lib/messages.js';
import { LEAD_TYPES, type RuleForm, STRATEGIES, describeMatch, describeStrategy, emptyRuleForm, formOf, formProblems, membersBody, moved, ruleBody } from './lib/routing.js';
import type { LeadSource, Member, MembersResponse, Pond, RoutingRule, Settings } from './lib/types.js';
import { Check, ErrorLine, Pill, Section, SelectField, StatusLine } from './lib/ui.js';
import { LeadSourcesSection } from '../lead-email/EmailIntake.js';

const RULES_KEY = ['admin', 'routing-rules'] as const;
const PONDS_KEY = ['admin', 'ponds'] as const;
export const SETTINGS_KEY = ['admin', 'settings'] as const;

const OFFERABLE = new Set(['agent', 'team_lead', 'isa']);

function useRoutingData() {
  const api = useApi();
  const rules = useQuery<{ rules: RoutingRule[] }, ApiError>({ queryKey: RULES_KEY, queryFn: ({ signal }) => api.get('/routing-rules', { signal }) });
  const ponds = useQuery<{ ponds: Pond[] }, ApiError>({ queryKey: PONDS_KEY, queryFn: ({ signal }) => api.get('/ponds', { signal }) });
  const members = useQuery<MembersResponse, ApiError>({ queryKey: ['admin', 'members'], queryFn: ({ signal }) => api.get('/members', { signal }) });
  const sources = useQuery<{ sources: LeadSource[] }, ApiError>({ queryKey: ['admin', 'lead-sources'], queryFn: ({ signal }) => api.get('/lead-sources', { signal }) });
  return { rules, ponds, members, sources };
}

export default function RoutingPage() {
  const d = useRoutingData();
  const [status, announce] = useAnnounce();
  const members = d.members.data?.members ?? [];
  const ponds = (d.ponds.data?.ponds ?? []).filter((p) => !p.archived);
  const sources = d.sources.data?.sources ?? [];
  const names = {
    person: (id: string) => members.find((m) => m.userId === id)?.displayName ?? 'a former member',
    pond: (id: string) => d.ponds.data?.ponds.find((p) => p.id === id)?.name ?? 'a pond',
    source: (id: string) => sources.find((s) => s.id === id)?.name ?? 'a lead source',
  };
  const error = d.rules.error ?? d.ponds.error ?? d.members.error ?? d.sources.error;
  return (
    <div className="flex w-full flex-col gap-8">
      <StatusLine text={status} />
      {error ? <Notice tone="error">{messageFor(error, ADMIN_MESSAGES)}</Notice> : null}
      <Rules rules={(d.rules.data?.rules ?? []).filter((r) => !r.archived)} members={members} ponds={ponds} sources={sources} names={names} onDone={announce} loading={d.rules.isPending} />
      <LeadSourcesSection sources={sources} loading={d.sources.isPending} />
      <Ponds ponds={ponds} members={members} onDone={announce} />
      <Timers onDone={announce} />
    </div>
  );
}

interface Names {
  person(id: string): string;
  pond(id: string): string;
  source(id: string): string;
}

function Rules({ rules, members, ponds, sources, names, onDone, loading }: { rules: RoutingRule[]; members: Member[]; ponds: Pond[]; sources: LeadSource[]; names: Names; onDone(t: string): void; loading: boolean }) {
  const [creating, setCreating] = useState(false);
  const order = useAction<{ ruleIds: string[] }, { rules: RoutingRule[] }>('PUT', { invalidate: [[...RULES_KEY]] });
  const ids = rules.map((r) => r.id);
  const move = async (id: string, dir: -1 | 1) => {
    const r = await order.run('/routing-rules/order', { ruleIds: moved(ids, id, dir) });
    if (r.ok) onDone('Order saved');
  };
  return (
    <Section
      title="Routing rules"
      description="New leads are checked against these rules from the top. The first enabled rule that matches decides who is offered the lead."
      actions={
        !creating ? (
          <Button variant="secondary" onClick={() => setCreating(true)}>
            New rule
          </Button>
        ) : null
      }
    >
      {creating ? (
        <Card>
          <RuleEditor initial={emptyRuleForm()} members={members} ponds={ponds} sources={sources} onCancel={() => setCreating(false)} onSaved={(n) => (setCreating(false), onDone(`Rule ${n} created`))} />
        </Card>
      ) : null}
      {loading ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {!loading && rules.length === 0 ? <Notice tone="warn">There are no rules yet, so new leads are not offered to anyone. Add a rule to start routing.</Notice> : null}
      <ol className="flex flex-col gap-2">
        {rules.map((r, i) => (
          <li key={r.id}>
            <RuleRow rule={r} position={i + 1} first={i === 0} last={i === rules.length - 1} members={members} ponds={ponds} sources={sources} names={names} onMove={move} moving={order.pending} onDone={onDone} />
          </li>
        ))}
      </ol>
      <ErrorLine message={order.error?.message} />
    </Section>
  );
}

function RuleRow(p: { rule: RoutingRule; position: number; first: boolean; last: boolean; members: Member[]; ponds: Pond[]; sources: LeadSource[]; names: Names; onMove(id: string, dir: -1 | 1): void; moving: boolean; onDone(t: string): void }) {
  const { rule, names } = p;
  const [editing, setEditing] = useState(false);
  const patch = useAction<{ enabled: boolean; version: number }, { rule: RoutingRule }>('PATCH', { invalidate: [[...RULES_KEY]] });
  const archive = useAction<undefined, { ok: true }>('DELETE', { invalidate: [[...RULES_KEY]] });
  if (editing) {
    return (
      <Card>
        <RuleEditor initial={formOf(rule)} rule={rule} members={p.members} ponds={p.ponds} sources={p.sources} onCancel={() => setEditing(false)} onSaved={(n) => (setEditing(false), p.onDone(`Rule ${n} saved`))} />
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2">
        <span className="mt-0.5 inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-surface-2 px-2 text-[14px] font-semibold text-ink" aria-label={`Position ${p.position}`}>
          {p.position}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-semibold text-ink">
            {rule.name} {!rule.enabled ? <Pill tone="warn">Off</Pill> : null}
          </p>
          <p className="text-[15px] text-ink">{describeMatch(rule.match, names.source)}</p>
          <p className="text-[14px] text-ink-muted">{describeStrategy(rule, names.person, names.pond)}</p>
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => setEditing(true)}>
          Edit
        </Button>
        <Button variant="quiet" pending={patch.pending} onClick={async () => (await patch.run(`/routing-rules/${rule.id}`, { enabled: !rule.enabled, version: rule.version })).ok && p.onDone(`${rule.name} turned ${rule.enabled ? 'off' : 'on'}`)}>
          {rule.enabled ? 'Turn off' : 'Turn on'}
        </Button>
        <Button variant="quiet" disabled={p.first || p.moving} onClick={() => p.onMove(rule.id, -1)}>
          Move up<span className="sr-only">: {rule.name}</span>
        </Button>
        <Button variant="quiet" disabled={p.last || p.moving} onClick={() => p.onMove(rule.id, 1)}>
          Move down<span className="sr-only">: {rule.name}</span>
        </Button>
        <Button variant="quiet" pending={archive.pending} onClick={async () => (await archive.run(`/routing-rules/${rule.id}`)).ok && p.onDone(`${rule.name} archived`)}>
          Archive
        </Button>
      </div>
      <ErrorLine message={(patch.error ?? archive.error)?.message} />
    </Card>
  );
}

function RuleEditor({ initial, rule, members, ponds, sources, onCancel, onSaved }: { initial: RuleForm; rule?: RoutingRule; members: Member[]; ponds: Pond[]; sources: LeadSource[]; onCancel(): void; onSaved(name: string): void }) {
  const [f, setF] = useState<RuleForm>(initial);
  const [tried, setTried] = useState(false);
  const create = useAction<Record<string, unknown>, { rule: RoutingRule }>('POST', { invalidate: [[...RULES_KEY]] });
  const patch = useAction<Record<string, unknown>, { rule: RoutingRule }>('PATCH', { invalidate: [[...RULES_KEY]] });
  const put = useAction<{ userId: string; weight: number }[], { rule: RoutingRule }>('PUT', { invalidate: [[...RULES_KEY]] });
  const problems = formProblems(f);
  const candidates = members.filter((m) => m.status === 'active' && OFFERABLE.has(m.role));
  const set = <K extends keyof RuleForm>(k: K, v: RuleForm[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggle = (k: 'leadTypes' | 'sources', v: string, on: boolean) =>
    setF((x) => {
      const s = new Set(x[k]);
      if (on) s.add(v);
      else s.delete(v);
      return { ...x, [k]: s };
    });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTried(true);
    if (problems.length > 0) return;
    const body = ruleBody(f);
    if (!rule) {
      const r = await create.run('/routing-rules', { ...body, members: membersBody(f) });
      if (r.ok) onSaved(r.data.rule.name);
      return;
    }
    const r = await patch.run(`/routing-rules/${rule.id}`, { ...body, version: rule.version });
    if (!r.ok) return;
    if (f.strategy === 'round_robin' || f.strategy === 'weighted') {
      const m = await put.run(`/routing-rules/${rule.id}/members`, membersBody(f));
      if (!m.ok) return;
    }
    onSaved(r.data.rule.name);
  };
  const failure = create.error ?? patch.error ?? put.error;
  const offersPeople = f.strategy === 'round_robin' || f.strategy === 'weighted';
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4" aria-label={rule ? `Edit ${rule.name}` : 'New routing rule'}>
      <TextField label="Rule name" value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={120} />
      <Fieldset legend="Which leads">
        <div className="flex flex-wrap gap-x-6">
          {LEAD_TYPES.map((t) => (
            <Check key={t.value} label={t.label} checked={f.leadTypes.has(t.value)} onChange={(on) => toggle('leadTypes', t.value, on)} />
          ))}
        </div>
        {sources.length > 0 ? (
          <div className="flex flex-wrap gap-x-6">
            {sources.map((s) => (
              <Check key={s.id} label={`From ${s.name}`} checked={f.sources.has(s.id)} onChange={(on) => toggle('sources', s.id, on)} />
            ))}
          </div>
        ) : null}
        <TextField label="ZIP codes" hint="Separate with commas. Leave empty for every area." value={f.zips} onChange={(e) => set('zips', e.target.value)} />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <TextField label="Lowest price ($)" inputMode="numeric" value={f.priceMin} onChange={(e) => set('priceMin', e.target.value)} />
          <TextField label="Highest price ($)" inputMode="numeric" value={f.priceMax} onChange={(e) => set('priceMax', e.target.value)} />
        </div>
        <p className="text-[14px] text-ink-muted">Nothing checked or filled in means every lead matches.</p>
      </Fieldset>
      <Fieldset legend="Who gets them">
        <SelectField label="How" value={f.strategy} onChange={(e) => set('strategy', e.target.value as RuleForm['strategy'])} hint={STRATEGIES.find((s) => s.value === f.strategy)?.hint}>
          {STRATEGIES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </SelectField>
        {f.strategy === 'direct' ? (
          <SelectField label="Person" value={f.directUserId} onChange={(e) => set('directUserId', e.target.value)}>
            <option value="">Pick someone</option>
            {candidates.map((m) => (
              <option key={m.userId} value={m.userId}>
                {m.displayName} · {roleLabel(m.role)}
              </option>
            ))}
          </SelectField>
        ) : null}
        {f.strategy === 'pond' ? (
          <SelectField label="Pond" value={f.targetPondId} onChange={(e) => set('targetPondId', e.target.value)}>
            <option value="">Pick a pond</option>
            {ponds.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
        ) : null}
        {offersPeople ? (
          <div className="flex flex-col gap-1">
            {candidates.map((m) => (
              <div key={m.userId} className="flex flex-wrap items-center gap-3">
                <Check
                  label={`${m.displayName} · ${roleLabel(m.role)}`}
                  hint={!m.acceptingLeads ? 'Not taking new leads right now' : undefined}
                  checked={f.members.has(m.userId)}
                  onChange={(on) =>
                    setF((x) => {
                      const n = new Map(x.members);
                      if (on) n.set(m.userId, n.get(m.userId) ?? 1);
                      else n.delete(m.userId);
                      return { ...x, members: n };
                    })
                  }
                />
                {f.strategy === 'weighted' && f.members.has(m.userId) ? (
                  <TextField
                    label={`Weight for ${m.displayName}`}
                    inputMode="numeric"
                    className="w-40"
                    value={String(f.members.get(m.userId) ?? 1)}
                    onChange={(e) => {
                      const n = Number(e.target.value.replace(/\D/g, '') || '1');
                      setF((x) => ({ ...x, members: new Map(x.members).set(m.userId, n) }));
                    }}
                  />
                ) : null}
              </div>
            ))}
            {candidates.length === 0 ? <p className="text-[15px] text-ink-muted">No active agents, ISAs or Team Leads yet. Invite someone first.</p> : null}
          </div>
        ) : null}
        {f.strategy !== 'pond' ? (
          <>
            <SelectField label="If no one accepts" value={f.fallbackPondId} onChange={(e) => set('fallbackPondId', e.target.value)}>
              <option value="">Use the default pond</option>
              {ponds.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </SelectField>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <TextField label="Offer window (minutes)" hint="Empty uses the team's lead timer." inputMode="numeric" value={f.offerWindowMinutes} onChange={(e) => set('offerWindowMinutes', e.target.value)} />
              <TextField label="Offers before falling back" hint="Empty uses the team's lead timer." inputMode="numeric" value={f.maxOffers} onChange={(e) => set('maxOffers', e.target.value)} />
            </div>
          </>
        ) : null}
      </Fieldset>
      <Check label="Rule is on" checked={f.enabled} onChange={(v) => set('enabled', v)} />
      {tried && problems.length > 0 ? (
        <Notice tone="error">
          <ul className="list-disc pl-5">
            {problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <ErrorLine message={failure?.message} />
      <div className="flex gap-2">
        <Button type="submit" pending={create.pending || patch.pending || put.pending}>
          {rule ? 'Save rule' : 'Create rule'}
        </Button>
        <Button variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="flex flex-col gap-3 rounded-xl border border-line p-3">
      <legend className="px-1 text-[15px] font-semibold text-ink">{legend}</legend>
      {children}
    </fieldset>
  );
}

// ---- ponds ---------------------------------------------------------------------------------------

const POND_ROLES = [
  { value: 'agent', label: 'Agents' },
  { value: 'team_lead', label: 'Team Leads' },
  { value: 'isa', label: 'ISAs' },
] as const;

function Ponds({ ponds, members, onDone }: { ponds: Pond[]; members: Member[]; onDone(t: string): void }) {
  const [name, setName] = useState('');
  const create = useAction<{ name: string }, { pond: Pond }>('POST', { invalidate: [[...PONDS_KEY]] });
  return (
    <Section title="Ponds" description="Leads no one owns wait in a pond. Eligible people claim them, within the pond's daily limit.">
      <ul className="flex flex-col gap-2">
        {ponds.map((p) => (
          <li key={p.id}>
            <PondRow pond={p} members={members} onDone={onDone} />
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run('/ponds', { name: name.trim() });
          if (r.ok) {
            setName('');
            onDone(`Pond ${r.data.pond.name} created`);
          }
        }}
      >
        <TextField label="New pond name" value={name} onChange={(e) => setName(e.target.value)} className="sm:flex-1" maxLength={120} />
        <Button type="submit" variant="secondary" pending={create.pending} disabled={!name.trim()}>
          Add pond
        </Button>
      </form>
      <ErrorLine message={create.error?.message} />
    </Section>
  );
}

function PondRow({ pond, members, onDone }: { pond: Pond; members: Member[]; onDone(t: string): void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ openToAll: pond.openToAll, eligibleRoles: new Set<string>(pond.eligibleRoles), claimsPerDay: String(pond.claimsPerDay), cooldown: String(pond.claimCooldownHours), reinquiry: pond.reinquiry, memberIds: new Set(pond.memberUserIds) });
  const patch = useAction<Record<string, unknown>, { pond: Pond }>('PATCH', { invalidate: [[...PONDS_KEY]] });
  const put = useAction<{ userIds: string[] }, { pond: Pond }>('PUT', { invalidate: [[...PONDS_KEY]] });
  const del = useAction<undefined, { ok: true }>('DELETE', { invalidate: [[...PONDS_KEY]] });
  const save = async () => {
    const r = await patch.run(`/ponds/${pond.id}`, {
      openToAll: f.openToAll,
      eligibleRoles: [...f.eligibleRoles],
      claimsPerDay: Number(f.claimsPerDay),
      claimCooldownHours: Number(f.cooldown),
      reinquiry: f.reinquiry,
    });
    if (!r.ok) return;
    if (!f.openToAll) {
      const m = await put.run(`/ponds/${pond.id}/members`, { userIds: [...f.memberIds] });
      if (!m.ok) return;
    }
    setEditing(false);
    onDone(`${pond.name} saved`);
  };
  const who = pond.openToAll ? `Open to ${pond.eligibleRoles.map((r) => POND_ROLES.find((x) => x.value === r)?.label ?? r).join(', ')}` : `Open to ${plural(pond.memberUserIds.length, 'chosen person', 'chosen people')}`;
  const failure = patch.error ?? put.error ?? del.error;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-medium text-ink">
            {pond.name} {pond.isDefault ? <Pill>Default</Pill> : null}
          </p>
          <p className="text-[14px] text-ink-muted">
            {plural(pond.waitingLeads, 'lead')} waiting · {who} · {pond.claimsPerDay} claims a day each · {pond.claimCooldownHours} h before a released lead can be reclaimed by the same person
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Edit'}
        </Button>
        {!pond.isDefault ? (
          <>
            <Button variant="quiet" pending={patch.pending} onClick={async () => (await patch.run(`/ponds/${pond.id}`, { isDefault: true })).ok && onDone(`${pond.name} is the default pond`)}>
              Make default
            </Button>
            <Button variant="quiet" pending={del.pending} onClick={async () => (await del.run(`/ponds/${pond.id}`)).ok && onDone(`${pond.name} archived`)}>
              Archive
            </Button>
          </>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-3">
          <Check label="Anyone in these roles may claim" checked={f.openToAll} onChange={(v) => setF((x) => ({ ...x, openToAll: v }))} />
          {f.openToAll ? (
            <div className="flex flex-wrap gap-x-6">
              {POND_ROLES.map((r) => (
                <Check
                  key={r.value}
                  label={r.label}
                  checked={f.eligibleRoles.has(r.value)}
                  onChange={(on) =>
                    setF((x) => {
                      const s = new Set(x.eligibleRoles);
                      if (on) s.add(r.value);
                      else s.delete(r.value);
                      return { ...x, eligibleRoles: s };
                    })
                  }
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              {members
                .filter((m) => m.status === 'active' && OFFERABLE.has(m.role))
                .map((m) => (
                  <Check
                    key={m.userId}
                    label={`${m.displayName} · ${roleLabel(m.role)}`}
                    checked={f.memberIds.has(m.userId)}
                    onChange={(on) =>
                      setF((x) => {
                        const s = new Set(x.memberIds);
                        if (on) s.add(m.userId);
                        else s.delete(m.userId);
                        return { ...x, memberIds: s };
                      })
                    }
                  />
                ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextField label="Claims per person per day" inputMode="numeric" value={f.claimsPerDay} onChange={(e) => setF((x) => ({ ...x, claimsPerDay: e.target.value.replace(/\D/g, '') }))} />
            <TextField label="Reclaim cooldown (hours)" inputMode="numeric" value={f.cooldown} onChange={(e) => setF((x) => ({ ...x, cooldown: e.target.value.replace(/\D/g, '') }))} />
            <SelectField label="When a pond lead asks again" value={f.reinquiry} onChange={(e) => setF((x) => ({ ...x, reinquiry: e.target.value as Pond['reinquiry'] }))}>
              <option value="reroute">Route it again</option>
              <option value="stay">Keep it in the pond</option>
            </SelectField>
          </div>
          <p className="text-[14px] text-ink-muted">Limits apply to claims made from now on. Leads people already own stay with them.</p>
          <div>
            <Button pending={patch.pending || put.pending} onClick={() => void save()}>
              Save pond
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine message={failure?.message} />
    </Card>
  );
}

// ---- lead timers ---------------------------------------------------------------------------------

type TimerKey = 'offerWindowSeconds' | 'maxOffers' | 'firstTouchSlaSeconds' | 'firstTouchReleaseSeconds' | 'reinquirySlaAfterDays' | 'inactivityReleaseDays' | 'inactivityWarningHours' | 'autoPauseAfterMisses' | 'uncontactedCapacityCap' | 'isaAccessAfterHandoffDays';

/** Each timer as people think of it (minutes, hours, days), with how it maps to the stored value. */
export const TIMER_FIELDS: readonly { key: TimerKey; label: string; unit: 'minutes' | 'count' | 'days' | 'hours'; nullable?: string; hint?: string }[] = [
  { key: 'offerWindowSeconds', label: 'Time to accept an offer', unit: 'minutes' },
  { key: 'maxOffers', label: 'Offers before a lead goes to the pond', unit: 'count' },
  { key: 'firstTouchSlaSeconds', label: 'First contact due within', unit: 'minutes', hint: 'Counts calls, texts and emails a person sends. The assistant’s instant reply does not count.' },
  { key: 'firstTouchReleaseSeconds', label: 'Release an untouched lead after', unit: 'minutes', nullable: 'Never release automatically' },
  { key: 'reinquirySlaAfterDays', label: 'A returning lead starts a new first-contact clock after', unit: 'days' },
  { key: 'inactivityReleaseDays', label: 'Release a lead with no contact after', unit: 'days', nullable: 'Never release for inactivity' },
  { key: 'inactivityWarningHours', label: 'Warn the owner before that release', unit: 'hours' },
  { key: 'autoPauseAfterMisses', label: 'Stop offering to someone after missed offers in a row', unit: 'count' },
  { key: 'uncontactedCapacityCap', label: 'Most uncontacted leads one person may hold', unit: 'count' },
  { key: 'isaAccessAfterHandoffDays', label: 'ISA keeps access after a handoff for', unit: 'days' },
];

const UNIT_LABEL = { minutes: 'minutes', count: '', days: 'days', hours: 'hours' } as const;

export function toInput(unit: (typeof TIMER_FIELDS)[number]['unit'], v: number | null): string {
  if (v === null) return '';
  return unit === 'minutes' ? String(Math.round(v / 60)) : String(v);
}

export function fromInput(unit: (typeof TIMER_FIELDS)[number]['unit'], text: string): number | null {
  const t = text.trim();
  if (t === '' || !/^\d+$/.test(t)) return null;
  return unit === 'minutes' ? Number(t) * 60 : Number(t);
}

function Timers({ onDone }: { onDone(t: string): void }) {
  const api = useApi();
  const q = useQuery<{ settings: Settings }, ApiError>({ queryKey: SETTINGS_KEY, queryFn: ({ signal }) => api.get('/settings', { signal }) });
  return (
    <Section title="Lead timers" description="Changes apply to new offers and new deadlines. Deadlines already running keep the times they started with.">
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      {q.data ? <TimersForm key={q.data.settings.version} settings={q.data.settings} onDone={onDone} /> : null}
    </Section>
  );
}

function TimersForm({ settings, onDone }: { settings: Settings; onDone(t: string): void }) {
  const [vals, setVals] = useState<Record<string, string>>(() => Object.fromEntries(TIMER_FIELDS.map((f) => [f.key, toInput(f.unit, settings[f.key])])));
  const [hours, setHours] = useState({ start: settings.routingHoursStart.slice(0, 5), end: settings.routingHoursEnd.slice(0, 5), tz: settings.defaultTimezone });
  const a = useAction<Record<string, unknown>, { settings: Settings }>('PATCH', { invalidate: [[...SETTINGS_KEY]] });
  const body: Record<string, unknown> = {};
  for (const f of TIMER_FIELDS) {
    const raw = vals[f.key] ?? '';
    const v = fromInput(f.unit, raw);
    if (raw.trim() === '' && !f.nullable) continue;
    if (raw.trim() !== '' && v === null) continue;
    if (v !== settings[f.key]) body[f.key] = v;
  }
  if (hours.start !== settings.routingHoursStart.slice(0, 5)) body.routingHoursStart = hours.start;
  if (hours.end !== settings.routingHoursEnd.slice(0, 5)) body.routingHoursEnd = hours.end;
  if (hours.tz.trim() && hours.tz !== settings.defaultTimezone) body.defaultTimezone = hours.tz.trim();
  const changed = Object.keys(body).length > 0;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/settings', { ...body, version: settings.version });
    if (r.ok) onDone('Lead timers saved');
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-4">
      <Card className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {TIMER_FIELDS.map((f) => (
          <TextField
            key={f.key}
            label={UNIT_LABEL[f.unit] ? `${f.label} (${UNIT_LABEL[f.unit]})` : f.label}
            inputMode="numeric"
            value={vals[f.key] ?? ''}
            onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))}
            hint={[f.hint, f.nullable ? `Empty: ${f.nullable.toLowerCase()}.` : null, `Now: ${describeTimer(f.unit, settings[f.key], f.nullable)}`].filter(Boolean).join(' ')}
          />
        ))}
      </Card>
      <Card className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <TextField label="Offer leads from" type="time" value={hours.start} onChange={(e) => setHours((h) => ({ ...h, start: e.target.value }))} />
        <TextField label="Until" type="time" value={hours.end} onChange={(e) => setHours((h) => ({ ...h, end: e.target.value }))} />
        <TextField label="Team time zone" value={hours.tz} onChange={(e) => setHours((h) => ({ ...h, tz: e.target.value }))} hint="For example America/Chicago." />
      </Card>
      <ErrorLine message={a.error?.message} />
      <div>
        <Button type="submit" pending={a.pending} disabled={!changed}>
          Save lead timers
        </Button>
      </div>
    </form>
  );
}

function describeTimer(unit: (typeof TIMER_FIELDS)[number]['unit'], v: number | null, nullable?: string): string {
  if (v === null) return nullable ?? 'not set';
  if (unit === 'minutes') return formatDuration(v);
  if (unit === 'days') return v === 1 ? '1 day' : `${v} days`;
  if (unit === 'hours') return `${v} h`;
  return String(v);
}
