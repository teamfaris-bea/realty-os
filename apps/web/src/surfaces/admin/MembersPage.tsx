// Members, invites and teams (BUILD_PLAN module 17 admin; api/admin module 10).
//
// - Invites, role changes, suspensions and removals ask for the password again when the last
//   confirmation is older than 15 minutes (R-PERM-13), then send the same request.
// - What a viewer may change follows DATA_MODEL §3 (the server decides; the page does not offer what
//   would be refused): an Admin never sees controls on an Owner and cannot pick the Owner role
//   (R-PERM-2). A tenant always keeps one active Owner; the server says so if a change would break it.
// - Removing someone who still holds leads runs the staged deactivation (R-OWN-22): the page first
//   shows how many leads and offers they hold and where they will go, then moves them. Nothing is
//   dropped as a side effect of a status flip.
// - Teams give a Team Lead their scope; only someone in a leading role can be marked lead.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Button, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { formatDate, plural, ROLE_OPTIONS, roleLabel } from './lib/format.js';
import { useAction, useAnnounce } from './lib/hooks.js';
import { ADMIN_MESSAGES } from './lib/messages.js';
import type { Deactivation, Invite, Member, MembersResponse, Role, Team } from './lib/types.js';
import { Check, ErrorLine, Pill, Section, SelectField, StatusLine } from './lib/ui.js';

const MEMBERS_KEY = ['admin', 'members'] as const;
const TEAMS_KEY = ['admin', 'teams'] as const;

/** Roles a viewer may assign (R-PERM-2: only an Owner grants Owner). */
export function assignableRoles(viewer: Role | undefined): Role[] {
  return ROLE_OPTIONS.map((r) => r.value).filter((r) => viewer === 'owner' || r !== 'owner');
}

/** Whether a viewer may change this member at all (an Admin never acts on an Owner). */
export function canManage(viewer: Role | undefined, target: Member): boolean {
  if (viewer === 'owner') return true;
  return viewer === 'admin' && target.role !== 'owner';
}

export default function MembersPage() {
  const api = useApi();
  const { session } = useSession();
  const viewer = session?.tenant?.role as Role | undefined;
  const [status, announce] = useAnnounce();
  const q = useQuery<MembersResponse, ApiError>({ queryKey: MEMBERS_KEY, queryFn: ({ signal }) => api.get('/members', { signal }) });
  const live = (q.data?.members ?? []).filter((m) => m.status !== 'removed');
  return (
    <div className="flex w-full flex-col gap-8">
      <StatusLine text={status} />
      <InviteForm viewer={viewer} onDone={announce} />
      {q.data && q.data.invites.length > 0 ? <PendingInvites invites={q.data.invites} viewer={viewer} onDone={announce} /> : null}
      <Section title="Members" description={q.data ? plural(live.length, 'member') : undefined}>
        {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
        {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
        <ul className="flex flex-col gap-2">
          {live.map((m) => (
            <li key={m.userId}>
              <MemberRow member={m} viewer={viewer} self={m.userId === session?.user.id} onDone={announce} />
            </li>
          ))}
        </ul>
      </Section>
      <Teams members={live} onDone={announce} />
    </div>
  );
}

function InviteForm({ viewer, onDone }: { viewer: Role | undefined; onDone(t: string): void }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('agent');
  const [mailFailed, setMailFailed] = useState(false);
  const a = useAction<{ email: string; role: Role }, { invite: Invite; emailSent: boolean }>('POST', { invalidate: [[...MEMBERS_KEY]] });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const r = await a.run('/invites', { email: email.trim(), role });
    if (r.ok) {
      setEmail('');
      setMailFailed(!r.data.emailSent);
      onDone(r.data.emailSent ? `Invite sent to ${r.data.invite.email}` : `Invite created for ${r.data.invite.email}`);
    }
  };
  return (
    <Section title="Invite someone" description="They get an email with a link that works for 7 days.">
      <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 md:flex-row md:items-end">
        <TextField label="Email" type="email" autoComplete="off" className="md:flex-1" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <SelectField label="Role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="md:w-60">
          {assignableRoles(viewer).map((r) => (
            <option key={r} value={r}>
              {roleLabel(r)}
            </option>
          ))}
        </SelectField>
        <Button type="submit" pending={a.pending} disabled={email.trim().length < 3}>
          Send invite
        </Button>
      </form>
      {mailFailed ? <Notice tone="warn">The invite was created, but the email didn't go out. Revoke it below and send it again.</Notice> : null}
      <ErrorLine message={a.error?.message} />
    </Section>
  );
}

function PendingInvites({ invites, viewer, onDone }: { invites: Invite[]; viewer: Role | undefined; onDone(t: string): void }) {
  const a = useAction<undefined, { ok: true }>('DELETE', { invalidate: [[...MEMBERS_KEY]] });
  return (
    <Section title="Waiting to join" description={plural(invites.length, 'invite')}>
      <ul className="flex flex-col gap-2">
        {invites.map((i) => (
          <li key={i.id}>
            <Card className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-[16px] text-ink [overflow-wrap:anywhere]">{i.email}</p>
                <p className="text-[14px] text-ink-muted">
                  {roleLabel(i.role)} · link works until {formatDate(i.expiresAt)}
                </p>
              </div>
              {viewer === 'owner' || i.role !== 'owner' ? (
                <Button
                  variant="secondary"
                  pending={a.pending}
                  onClick={async () => {
                    const r = await a.run(`/invites/${i.id}`);
                    if (r.ok) onDone(`Invite to ${i.email} revoked`);
                  }}
                >
                  Revoke
                </Button>
              ) : null}
            </Card>
          </li>
        ))}
      </ul>
      <ErrorLine message={a.error?.message} />
    </Section>
  );
}

function MemberRow({ member, viewer, self, onDone }: { member: Member; viewer: Role | undefined; self: boolean; onDone(t: string): void }) {
  const [role, setRole] = useState<Role>(member.role);
  const [removing, setRemoving] = useState(false);
  const patch = useAction<{ role?: Role; status?: string; version: number }, { member: Member }>('PATCH', { invalidate: [[...MEMBERS_KEY]] });
  const manage = canManage(viewer, member);
  const change = async (body: { role?: Role; status?: string }, done: string) => {
    const r = await patch.run(`/members/${member.userId}`, { ...body, version: member.version });
    if (r.ok) onDone(done);
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-medium text-ink">
            {member.displayName}
            {self ? <span className="font-normal text-ink-muted"> (you)</span> : null}
          </p>
          <p className="text-[14px] text-ink-muted [overflow-wrap:anywhere]">
            {member.email} · {roleLabel(member.role)}
            {member.joinedAt ? ` · joined ${formatDate(member.joinedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {member.status === 'suspended' ? <Pill tone="warn">Suspended</Pill> : null}
          {member.status === 'deactivating' ? <Pill tone="warn">Leaving: moving their leads and listings</Pill> : null}
          {['owner', 'admin'].includes(member.role) ? <Pill tone={member.mfaEnabled ? 'ok' : 'warn'}>{member.mfaEnabled ? 'Two-step on' : 'Two-step not set up'}</Pill> : null}
          {!member.acceptingLeads && member.role !== 'tc' && member.status === 'active' ? <Pill>Not taking new leads</Pill> : null}
        </div>
      </div>
      {manage && member.status !== 'deactivating' ? (
        <div className="flex flex-wrap items-end gap-2">
          <SelectField label={`Role for ${member.displayName}`} value={role} onChange={(e) => setRole(e.target.value as Role)} className="w-full sm:w-60">
            {assignableRoles(viewer).map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </SelectField>
          {role !== member.role ? (
            <Button pending={patch.pending} onClick={() => void change({ role }, `${member.displayName} is now ${roleLabel(role)}`)}>
              Save role
            </Button>
          ) : null}
          {!self && member.status === 'active' ? (
            <Button variant="secondary" pending={patch.pending} onClick={() => void change({ status: 'suspended' }, `${member.displayName} is suspended`)}>
              Suspend
            </Button>
          ) : null}
          {member.status === 'suspended' ? (
            <Button variant="secondary" pending={patch.pending} onClick={() => void change({ status: 'active' }, `${member.displayName} is active again`)}>
              Reactivate
            </Button>
          ) : null}
          {!self ? (
            <Button variant="quiet" onClick={() => setRemoving(true)}>
              Remove
            </Button>
          ) : null}
        </div>
      ) : null}
      {removing ? (
        <RemoveMember
          member={member}
          onCancel={() => setRemoving(false)}
          onDone={(t) => {
            setRemoving(false);
            onDone(t);
          }}
        />
      ) : null}
      <ErrorLine message={patch.error?.message} />
    </Card>
  );
}

const DESTINATIONS = [
  { value: 'team_lead', label: 'Their Team Lead' },
  { value: 'default_pond', label: 'The default pond' },
  { value: 'reroute', label: 'Route them again' },
] as const;

/** Remove: preview what they hold, choose where it goes, then move it and remove them (R-OWN-22). */
function RemoveMember({ member, onCancel, onDone }: { member: Member; onCancel(): void; onDone(t: string): void }) {
  const [destination, setDestination] = useState<Deactivation['destination']>('team_lead');
  const preview = useAction<{ mode: 'preview'; destination: string }, { deactivation: Deactivation }>('POST');
  const run = useAction<{ mode: 'run'; destination: string }, { deactivation: Deactivation }>('POST', { invalidate: [[...MEMBERS_KEY]] });
  const patch = useAction<{ status: 'removed'; version: number }, { member: Member }>('PATCH', { invalidate: [[...MEMBERS_KEY]] });
  const [held, setHeld] = useState<Deactivation | null>(null);
  const path = `/members/${member.userId}/deactivate`;
  const check = async () => {
    const r = await preview.run(path, { mode: 'preview', destination });
    if (r.ok) setHeld(r.data.deactivation);
  };
  const confirm = async () => {
    if (!held) return;
    // nothing to move: a plain status change; otherwise the staged deactivation moves leads and listings first (R-OWN-22)
    const nothing = held.owned + held.offered + held.openListings === 0;
    const r = nothing ? await patch.run(`/members/${member.userId}`, { status: 'removed', version: member.version }) : await run.run(path, { mode: 'run', destination });
    if (r.ok) onDone(nothing ? `${member.displayName} was removed` : `${member.displayName} is being removed; their ${held.openListings > 0 ? 'leads and listings are' : 'leads are'} moving now`);
  };
  // open-deal leads and listings go to a person: the Team Lead, else the Owner/Admin running this (the viewer: fallbackUserId)
  const toWhom = held?.teamLead ? (held.teamLead.displayName ?? 'their Team Lead') : 'you';
  const failure = preview.error ?? run.error ?? patch.error;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
      {!held ? (
        <>
          <p className="text-[15px] text-ink">First we check which leads and listings {member.displayName} still holds, so none are dropped.</p>
          <div className="flex gap-2">
            <Button pending={preview.pending} onClick={() => void check()}>
              Check their leads and listings
            </Button>
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-[15px] text-ink">
            {held.owned + held.offered === 0
              ? `${member.displayName} holds no leads or offers.`
              : `${member.displayName} holds ${plural(held.owned, 'lead')}${held.ownedWithOpenDeal > 0 ? ` (${held.ownedWithOpenDeal} with an open deal)` : ''} and ${plural(held.offered, 'open offer')}.`}
          </p>
          {held.owned + held.offered > 0 ? (
            <>
              <SelectField label="Move their leads to" value={destination} onChange={(e) => setDestination(e.target.value as Deactivation['destination'])} className="sm:w-72">
                {DESTINATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </SelectField>
              <p className="text-[14px] text-ink-muted">
                Leads with an open deal never go to a pond; they go to {toWhom}.
              </p>
            </>
          ) : null}
          {held.openListings > 0 ? (
            <>
              <p className="text-[15px] text-ink">
                They're the listing agent on {plural(held.openListings, 'open listing')}; those go to {toWhom}.
              </p>
              {/* VERIFY WITH COUNSEL (V11): the listing agreement itself is outside Realty OS */}
              <p className="text-[14px] text-ink-muted">This changes who handles the listing in Realty OS, not the listing agreement.</p>
            </>
          ) : null}
          {held.openDeals > 0 ? (
            <p className="text-[14px] text-ink-muted">
              Their {plural(held.openDeals, 'open deal')} {held.openDeals === 1 ? 'keeps' : 'keep'} {member.displayName} as the deal owner (a deal's owner can't be changed in Realty OS yet). Owners and Admins can still open them.
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button variant="danger" pending={run.pending || patch.pending} onClick={() => void confirm()}>
              Remove {member.displayName}
            </Button>
            <Button variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </>
      )}
      <ErrorLine message={failure?.message} />
    </div>
  );
}

const LEAD_ROLES = new Set<Role>(['team_lead', 'owner', 'admin']);

function Teams({ members, onDone }: { members: Member[]; onDone(t: string): void }) {
  const api = useApi();
  const q = useQuery<{ teams: Team[] }, ApiError>({ queryKey: TEAMS_KEY, queryFn: ({ signal }) => api.get('/teams', { signal }) });
  const [name, setName] = useState('');
  const create = useAction<{ name: string }, { team: Team }>('POST', { invalidate: [[...TEAMS_KEY]] });
  const nameOf = (id: string) => members.find((m) => m.userId === id)?.displayName ?? 'Former member';
  return (
    <Section title="Teams" description="A Team Lead sees and reassigns leads of the people on their team.">
      {q.isError ? <Notice tone="error">{messageFor(q.error, ADMIN_MESSAGES)}</Notice> : null}
      <ul className="flex flex-col gap-2">
        {q.data?.teams.map((t) => (
          <li key={t.id}>
            <TeamRow team={t} members={members} nameOf={nameOf} onDone={onDone} />
          </li>
        ))}
      </ul>
      <form
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await create.run('/teams', { name: name.trim() });
          if (r.ok) {
            setName('');
            onDone(`Team ${r.data.team.name} created`);
          }
        }}
      >
        <TextField label="New team name" value={name} onChange={(e) => setName(e.target.value)} className="sm:flex-1" maxLength={120} />
        <Button type="submit" variant="secondary" pending={create.pending} disabled={!name.trim()}>
          Add team
        </Button>
      </form>
      <ErrorLine message={create.error?.message} />
    </Section>
  );
}

function TeamRow({ team, members, nameOf, onDone }: { team: Team; members: Member[]; nameOf(id: string): string; onDone(t: string): void }) {
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState<Map<string, boolean>>(new Map(team.members.map((m) => [m.userId, m.isLead])));
  const put = useAction<{ members: { userId: string; isLead: boolean }[] }, { team: Team }>('PUT', { invalidate: [[...TEAMS_KEY]] });
  const patch = useAction<{ isDefault: true }, { team: Team }>('PATCH', { invalidate: [[...TEAMS_KEY]] });
  const del = useAction<undefined, { ok: true }>('DELETE', { invalidate: [[...TEAMS_KEY]] });
  const leads = team.members.filter((m) => m.isLead);
  const save = async () => {
    const r = await put.run(`/teams/${team.id}/members`, { members: [...picked].map(([userId, isLead]) => ({ userId, isLead })) });
    if (r.ok) {
      setEditing(false);
      onDone(`${team.name} saved`);
    }
  };
  const failure = put.error ?? patch.error ?? del.error;
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[16px] font-medium text-ink">
            {team.name} {team.isDefault ? <Pill>Default</Pill> : null}
          </p>
          <p className="text-[14px] text-ink-muted">
            {plural(team.members.length, 'member')}
            {leads.length > 0 ? ` · led by ${leads.map((l) => nameOf(l.userId)).join(', ')}` : ' · no Team Lead'}
          </p>
        </div>
        <Button variant="secondary" onClick={() => setEditing((v) => !v)}>
          {editing ? 'Close' : 'Edit members'}
        </Button>
        {!team.isDefault ? (
          <>
            <Button variant="quiet" pending={patch.pending} onClick={async () => (await patch.run(`/teams/${team.id}`, { isDefault: true })).ok && onDone(`${team.name} is the default team`)}>
              Make default
            </Button>
            <Button variant="quiet" pending={del.pending} onClick={async () => (await del.run(`/teams/${team.id}`)).ok && onDone(`${team.name} deleted`)}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
      {editing ? (
        <div className="flex flex-col gap-1">
          {members
            .filter((m) => m.status === 'active' || picked.has(m.userId))
            .map((m) => (
              <div key={m.userId} className="flex flex-wrap items-center gap-x-6">
                <Check
                  label={`${m.displayName} · ${roleLabel(m.role)}`}
                  checked={picked.has(m.userId)}
                  onChange={(on) =>
                    setPicked((p) => {
                      const n = new Map(p);
                      if (on) n.set(m.userId, false);
                      else n.delete(m.userId);
                      return n;
                    })
                  }
                />
                {picked.has(m.userId) && LEAD_ROLES.has(m.role) ? (
                  <Check label="Leads this team" checked={picked.get(m.userId) === true} onChange={(on) => setPicked((p) => new Map(p).set(m.userId, on))} />
                ) : null}
              </div>
            ))}
          <div>
            <Button pending={put.pending} onClick={() => void save()}>
              Save members
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine message={failure?.message} />
    </Card>
  );
}
