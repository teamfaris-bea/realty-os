// The bulk sheet's person and plan pickers (parity module 64, R-PAR-35, R-PAR-16, DATA_MODEL §12): Assign lists
// only the members the viewer may assign to (Owner/Admin: active members who can hold leads, never a TC; a
// Team Lead: themself and their team), Start plan lists only approved plans the viewer may start (team plans
// and their own personal plan, never the instant reply to new leads), and the confirm sheet shows who is left
// out and why exactly as the server counted them. The role rules here are checked against core's own.
import { ROLES, type Role, can } from '@realty/core/foundation';
import { bulkActionPreflight } from '@realty/core/parity/bulk';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { FakeFetch, err, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import type { Member, Playbook } from '../admin/lib/types.js';
import type { BulkActionView } from './api.js';
import { reasonWordsFor } from './api.js';
import { ASSIGN_ROLES, RUN_ROLES, assignTargetsFromMembers, assignTargetsFromTeam, mayBulkAssign, mayBulkEnroll, planChoices } from './choices.js';
import { surface as bulkSurface } from './index.js';

const ME = '01900000-0000-7000-8000-0000000000aa';
const SAM = '01900000-0000-7000-8000-0000000000b1';
const TESS = '01900000-0000-7000-8000-0000000000b2';
const GONE = '01900000-0000-7000-8000-0000000000b3';
const TC = '01900000-0000-7000-8000-0000000000b4';
const C = ['01900000-0000-7000-8000-00000000c001', '01900000-0000-7000-8000-00000000c002', '01900000-0000-7000-8000-00000000c003'];
const ACTION = '01900000-0000-7000-8000-0000000ba001';

function app(fake: FakeFetch, path: string, role: Role) {
  const s = sessionFixture();
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: tableWith(bulkSurface) });
}

const draft = (over: Partial<BulkActionView> = {}): BulkActionView => ({
  id: ACTION,
  kind: 'assign',
  status: 'draft',
  mine: true,
  selected: 3,
  targetCount: 2,
  preflight: { ALREADY_OWNER: 1 },
  sharedAddresses: 0,
  counts: { selected: 3, done: 0, skipped: 1, blocked: 0, failed: 0, canceled: 0, pending: 2, byReason: { ALREADY_OWNER: 1 } },
  templateId: null,
  templateVersion: null,
  subject: null,
  body: null,
  failureCode: null,
  createdAt: '2026-11-10T10:00:00Z',
  confirmedAt: null,
  finishedAt: null,
  ...over,
});

const member = (userId: string, displayName: string, role: Member['role'], status: Member['status'] = 'active'): Member => ({ userId, displayName, email: `${displayName.split(' ')[0]!.toLowerCase()}@example.test`, role, status, acceptingLeads: true, mfaEnabled: false, joinedAt: '2026-01-01T00:00:00Z', version: 1 });
const members = { status: 200, body: { members: [member(SAM, 'Sam Lee', 'agent'), member(TESS, 'Tess Ward', 'isa'), member(ME, 'Ava Agent', 'owner'), member(GONE, 'Gus Gone', 'agent', 'suspended'), member(TC, 'Theo Clark', 'tc')], invites: [] } };

const version = { id: 'v1', versionNo: 1, status: 'approved', contentSha256: 'a'.repeat(64), steps: [], tone: {}, issues: [], createdAt: '2026-11-01T00:00:00Z' };
const pb = (id: string, name: string, over: Partial<Playbook> = {}): Playbook => ({ id, kind: 'nurture', scope: 'team', ownerUserId: null, name, templateKey: null, approvedVersionId: 'v1', versions: [version], ...over });
const PB = { buyer: '01900000-0000-7000-8000-0000000000f1', draft: '01900000-0000-7000-8000-0000000000f2', mine: '01900000-0000-7000-8000-0000000000f3', theirs: '01900000-0000-7000-8000-0000000000f4', instant: '01900000-0000-7000-8000-0000000000f5' };
const playbooks = {
  status: 200,
  body: {
    playbooks: [
      pb(PB.instant, 'Instant reply to new leads', { kind: 'new_lead_response' }),
      pb(PB.buyer, 'Buyer plan'),
      pb(PB.draft, 'Draft plan', { approvedVersionId: null, versions: [{ ...version, status: 'draft' }] }),
      pb(PB.mine, 'My check-ins', { scope: 'agent', ownerUserId: ME }),
      pb(PB.theirs, "Sam's plan", { scope: 'agent', ownerUserId: SAM }),
    ],
  },
};

describe('R-PAR-35 bulk assign: the person picker', () => {
  it('an Owner picks from the active members who can hold leads (never a TC, never someone suspended); person → Confirm is 2 taps, the left-out counted by reason', async () => {
    const fake = new FakeFetch()
      .on('GET /members', members)
      .on('POST /bulk-actions', { status: 201, body: { action: draft() } })
      .on(`POST /bulk-actions/${ACTION}/confirm`, { status: 200, body: { action: draft({ status: 'confirmed', confirmedAt: '2026-11-10T10:01:00Z' }) } })
      .on(`GET /bulk-actions/${ACTION}`, { status: 200, body: { action: draft({ status: 'running' }) } });
    app(fake, `/bulk/new?kind=assign&contacts=${C.join(',')}`, 'owner');
    const u = userEvent.setup();
    const picker = await screen.findByRole('region', { name: 'Assign to' });
    await waitFor(() => expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ava Agent (you)', 'Sam Lee', 'Tess Ward']));
    expect(fake.callsTo('GET /team/scoreboard?range=today')).toHaveLength(0);
    let taps = 0;
    await u.click(within(picker).getByRole('button', { name: 'Sam Lee' }));
    taps += 1;
    const sheet = await screen.findByRole('dialog', { name: 'Assign 2 of 3?' });
    expect(within(sheet).getByText('Assign to Sam Lee')).toBeInTheDocument();
    expect(within(sheet).getByText(/of 3 selected will be assigned to Sam Lee\./)).toBeInTheDocument();
    const left = within(sheet).getByRole('region', { name: 'Left out (1)' });
    expect(within(left).getByRole('listitem').textContent).toBe('1 are already theirs');
    // the runner sends no summary to whoever runs it (apps/api/src/bulk/run.ts), even when they own some of the people
    expect(within(sheet).getByText('Each one moves to Sam Lee under the same rules as assigning one lead. Sam Lee and each current owner other than you get one notice for the whole group, not one per lead.')).toBeInTheDocument();
    expect(fake.callsTo('POST /bulk-actions')[0]!.body).toMatchObject({ kind: 'assign', selection: { contactIds: C }, toUserId: SAM });
    expect(fake.callsTo(`POST /bulk-actions/${ACTION}/confirm`)).toHaveLength(0); // nothing starts before Confirm
    await u.click(within(sheet).getByRole('button', { name: 'Assign 2 people' }));
    taps += 1;
    await waitFor(() => expect(fake.callsTo(`POST /bulk-actions/${ACTION}/confirm`)).toHaveLength(1));
    expect(taps).toBe(2);
  });

  it('R-PAR-35 assigning to yourself says "you" and promises you no notice (the runner sends its creator no summary); the other current owners still get one each', async () => {
    const fake = new FakeFetch()
      .on('GET /members', members)
      .on('POST /bulk-actions', { status: 201, body: { action: draft() } });
    app(fake, `/bulk/new?kind=assign&contacts=${C.join(',')}`, 'owner');
    const picker = await screen.findByRole('region', { name: 'Assign to' });
    await userEvent.setup().click(await within(picker).findByRole('button', { name: 'Ava Agent (you)' }));
    const sheet = await screen.findByRole('dialog', { name: 'Assign 2 of 3?' });
    expect(fake.callsTo('POST /bulk-actions')[0]!.body).toMatchObject({ kind: 'assign', toUserId: ME });
    expect(within(sheet).getByText('Assign to you')).toBeInTheDocument();
    expect(within(sheet).getByText(/of 3 selected will be assigned to you\./)).toBeInTheDocument();
    expect(within(sheet).getByText('Each one moves to you under the same rules as assigning one lead. Each current owner gets one notice for the whole group, not one per lead.')).toBeInTheDocument();
    expect(within(sheet).queryByText(/Ava Agent/)).toBeNull();
  });

  it('R-PAR-35 a person passed in by the caller (/bulk/new?to=…) is worded the same way: "you" for the viewer, "the new owner" for anyone else', async () => {
    const self = new FakeFetch().on('POST /bulk-actions', { status: 201, body: { action: draft() } });
    const first = app(self, `/bulk/new?kind=assign&contacts=${C.join(',')}&to=${ME}`, 'team_lead');
    const mine = await screen.findByRole('dialog', { name: 'Assign 2 of 3?' });
    expect(self.callsTo('POST /bulk-actions')[0]!.body).toMatchObject({ kind: 'assign', toUserId: ME });
    expect(within(mine).getByText(/of 3 selected will be assigned to you\./)).toBeInTheDocument();
    expect(within(mine).getByText('Each one moves to you under the same rules as assigning one lead. Each current owner gets one notice for the whole group, not one per lead.')).toBeInTheDocument();
    first.view.unmount();
    const other = new FakeFetch().on('POST /bulk-actions', { status: 201, body: { action: draft() } });
    app(other, `/bulk/new?kind=assign&contacts=${C.join(',')}&to=${SAM}`, 'team_lead');
    const theirs = await screen.findByRole('dialog', { name: 'Assign 2 of 3?' });
    expect(within(theirs).getByText(/of 3 selected will get this assignment\./)).toBeInTheDocument();
    expect(within(theirs).getByText('Each one moves to the new owner under the same rules as assigning one lead. The new owner and each current owner other than you get one notice for the whole group, not one per lead.')).toBeInTheDocument();
  });

  it('a Team Lead picks only from themself and their team (the server lists them), never from every member', async () => {
    const fake = new FakeFetch()
      .on('GET /team/scoreboard?range=today', { status: 200, body: { range: { key: 'today', from: '', to: '', days: 1, zone: 'UTC' }, members: [{ userId: SAM, name: 'Sam Lee' }, { userId: ME, name: 'Ava Agent' }] } })
      .on('POST /bulk-actions', { status: 201, body: { action: draft({ preflight: { NOT_PERMITTED: 1 }, counts: { ...draft().counts, byReason: { NOT_PERMITTED: 1 } } }) } });
    app(fake, `/bulk/new?kind=assign&contacts=${C.join(',')}`, 'team_lead');
    const picker = await screen.findByRole('region', { name: 'Assign to' });
    expect(within(picker).getByText('Pick who takes them: you, or someone on a team you lead.')).toBeInTheDocument();
    await waitFor(() => expect(within(picker).getAllByRole('button').map((b) => b.textContent)).toEqual(['Ava Agent (you)', 'Sam Lee']));
    expect(fake.callsTo('GET /members')).toHaveLength(0);
    await userEvent.setup().click(within(picker).getByRole('button', { name: 'Sam Lee' }));
    // someone outside the team is "not permitted" for an assign: said as what it is
    const sheet = await screen.findByRole('dialog', { name: 'Assign 2 of 3?' });
    expect(within(sheet).getByRole('region', { name: 'Left out (1)' }).textContent).toContain("1 aren't yours or your team's to assign");
  });

  it('an agent (or ISA) is never offered anyone: the sheet says why and asks the server nothing', async () => {
    for (const role of ['agent', 'isa'] as const) {
      const fake = new FakeFetch();
      const view = app(fake, `/bulk/new?kind=assign&contacts=${C[0]}`, role);
      expect(await screen.findByText("Your role can't run this bulk action.")).toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Assign to' })).toBeNull();
      expect(fake.calls.filter((c) => c.path === '/members' || c.path.startsWith('/team/') || c.path === '/bulk-actions')).toEqual([]);
      view.view.unmount();
    }
  });

  it('the person list is the bulk.assign target rule: active, able to hold leads; a Team Lead gets exactly the rows the server sent', () => {
    expect(assignTargetsFromMembers(members.body.members, ME).map((t) => t.userId)).toEqual([ME, SAM, TESS]);
    expect(assignTargetsFromTeam([{ userId: SAM, name: null }], ME)).toEqual([{ userId: SAM, name: 'Unnamed member', you: false }]);
  });
});

describe('R-PAR-16 R-PAR-35 bulk Start plan: the plan picker', () => {
  it('lists only approved plans the viewer may start: team plans and their own personal plan (never a draft-only plan, another agent\'s plan, or the instant reply to new leads)', async () => {
    const fake = new FakeFetch()
      .on('GET /playbooks', playbooks)
      .on('POST /bulk-actions', { status: 201, body: { action: draft({ kind: 'enroll', selected: 3, targetCount: 0, preflight: { ALREADY_ENROLLED: 1, UNREACHABLE: 1, NOT_VISIBLE: 1 }, counts: { ...draft().counts, byReason: {} } }) } });
    app(fake, `/bulk/new?kind=enroll&contacts=${C.join(',')}`, 'agent');
    const plans = await screen.findByRole('region', { name: 'Plans' });
    await waitFor(() => expect(within(plans).getAllByRole('button').map((b) => b.firstChild?.textContent)).toEqual(['Buyer plan', 'My check-ins']));
    expect(within(plans).getByRole('button', { name: /My check-ins/ }).textContent).toContain('Your plan, for people you own · Stay in touch');
    expect(within(plans).getByRole('button', { name: /Buyer plan/ }).textContent).toContain('Team plan');
    await userEvent.setup().click(within(plans).getByRole('button', { name: /Buyer plan/ }));
    expect(fake.callsTo('POST /bulk-actions')[0]!.body).toMatchObject({ kind: 'enroll', selection: { contactIds: C }, playbookId: PB.buyer });
    // who is left out and why, exactly as the server counted them; with nobody left there is nothing to confirm
    const sheet = await screen.findByRole('dialog', { name: 'Enroll 0 of 3?' });
    expect(within(sheet).getByText('Start “Buyer plan”')).toBeInTheDocument();
    const left = within(sheet).getByRole('region', { name: 'Left out (3)' });
    expect(within(left).getAllByRole('listitem').map((li) => li.textContent).sort()).toEqual(['1 are already in a plan', "1 aren't yours to reach", "1 can't be reached by text or email"]);
    expect(within(sheet).getByText(/stops when someone replies/)).toBeInTheDocument();
    expect(within(sheet).getByRole('button', { name: 'Enroll 0 people' })).toBeDisabled();
  });

  it('a personal plan covers only the viewer\'s own people: the people it skips are said to be not theirs', async () => {
    const fake = new FakeFetch()
      .on('GET /playbooks', playbooks)
      .on('POST /bulk-actions', { status: 201, body: { action: draft({ kind: 'enroll', selected: 3, targetCount: 2, preflight: { NOT_PERMITTED: 1 } }) } })
      .on(`POST /bulk-actions/${ACTION}/confirm`, { status: 200, body: { action: draft({ kind: 'enroll', status: 'confirmed', targetCount: 2 }) } });
    app(fake, `/bulk/new?kind=enroll&contacts=${C.join(',')}`, 'agent');
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: /My check-ins/ }));
    const sheet = await screen.findByRole('dialog', { name: 'Enroll 2 of 3?' });
    expect(within(sheet).getByText(/of 3 selected will start “My check-ins”\./)).toBeInTheDocument();
    expect(within(sheet).getByRole('region', { name: 'Left out (1)' }).textContent).toContain("1 aren't yours (a personal plan covers only people you own)");
    await u.click(within(sheet).getByRole('button', { name: 'Enroll 2 people' }));
    await waitFor(() => expect(fake.callsTo(`POST /bulk-actions/${ACTION}/confirm`)).toHaveLength(1));
  });

  it('with no approved plan the picker says how to get one; a plan stopped meanwhile is refused in plain words', async () => {
    const empty = new FakeFetch().on('GET /playbooks', { status: 200, body: { playbooks: [pb(PB.draft, 'Draft plan', { approvedVersionId: null })] } });
    const first = app(empty, `/bulk/new?kind=enroll&contacts=${C[0]}`, 'isa');
    expect(await screen.findByText('No plan is ready to start. A plan needs an approved version first: approve one under Playbooks.')).toBeInTheDocument();
    first.view.unmount();
    const stopped = new FakeFetch().on('GET /playbooks', playbooks).on('POST /bulk-actions', err(409, 'PLAYBOOK_NOT_APPROVED'));
    app(stopped, `/bulk/new?kind=enroll&contacts=${C[0]}`, 'owner');
    await userEvent.setup().click(await screen.findByRole('button', { name: /Buyer plan/ }));
    expect(await screen.findByText('This playbook has no approved version yet.')).toBeInTheDocument();
    expect(stopped.calls.filter((c) => c.path.endsWith('/confirm'))).toEqual([]);
  });

  it('the plan list rule: approved, not the instant reply, a team plan or the viewer\'s own (team plans first)', () => {
    expect(planChoices(playbooks.body.playbooks, ME).map((p) => p.id)).toEqual([PB.buyer, PB.mine]);
    expect(planChoices(playbooks.body.playbooks, SAM).map((p) => p.id)).toEqual([PB.buyer, PB.theirs]);
    expect(planChoices(playbooks.body.playbooks, undefined).map((p) => p.id)).toEqual([PB.buyer]);
  });
});

describe('DATA_MODEL §12 the roles the bulk bar offers Assign and Start plan to are core\'s', () => {
  const actor = (role: Role) => ({ kind: 'user' as const, userId: ME as never, tenantId: 'tenant' as never, role, sessionId: 's' });
  it('Assign: exactly the roles core lets assign (bulk.assign; the action preflight refuses the rest)', () => {
    for (const role of ROLES) {
      const core = bulkActionPreflight({ kind: 'assign', role, selected: 1, audienceProtected: false }).ok && can(actor(role), 'bulk.assign', { team: true, own: true, target: { role: 'agent', inMyTeam: true } }).ok;
      expect(mayBulkAssign(role), role).toBe(core);
    }
    expect([...ASSIGN_ROLES]).toEqual(['owner', 'admin', 'team_lead']);
  });
  it('Start plan: exactly the roles core lets run bulk work (bulk.run), so every role but the TC', () => {
    for (const role of ROLES) {
      const core = bulkActionPreflight({ kind: 'enroll', role, selected: 1, audienceProtected: false, playbookApproved: true }).ok && can(actor(role), 'bulk.run', { own: true }).ok;
      expect(mayBulkEnroll(role), role).toBe(core);
    }
    expect([...RUN_ROLES]).toEqual(['owner', 'admin', 'team_lead', 'agent', 'isa']);
    expect(mayBulkAssign(null)).toBe(false);
    expect(mayBulkEnroll(undefined)).toBe(false);
  });
  it('"not permitted" reads as what it means for an assign and for a personal plan; other reasons are unchanged', () => {
    expect(reasonWordsFor('NOT_PERMITTED', { kind: 'assign' })).toBe("aren't yours or your team's to assign");
    expect(reasonWordsFor('NOT_PERMITTED', { kind: 'enroll', personalPlan: true })).toBe("aren't yours (a personal plan covers only people you own)");
    expect(reasonWordsFor('NOT_PERMITTED', { kind: 'enroll' })).toBe("aren't allowed for your role");
    expect(reasonWordsFor('ALREADY_ENROLLED', { kind: 'enroll', personalPlan: true })).toBe('are already in a plan');
  });
});
