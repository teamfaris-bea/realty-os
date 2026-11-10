// api/admin ponds and teams through the real server and Postgres: archive guards (default pond,
// a pond a live rule uses, a pond with waiting leads), members, the default moving, Team Lead scope
// from team membership, and R-AUDIT-5 pond/team changes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { auditRows, call, freshReauth, inviteViaApi, routeInquiry } from './testing.js';

interface Pond {
  id: string;
  name: string;
  isDefault: boolean;
  openToAll: boolean;
  eligibleRoles: string[];
  claimsPerDay: number;
  memberUserIds: string[];
  waitingLeads: number;
}
interface Team {
  id: string;
  name: string;
  isDefault: boolean;
  members: { userId: string; isLead: boolean }[];
}

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;
let tl: TestClient;
let tc: TestClient;

const ponds = async () => (await call<{ ponds: Pond[] }>(owner, 'GET', '/ponds')).body.ponds;
const teams = async () => (await call<{ teams: Team[] }>(owner, 'GET', '/teams')).body.teams;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  agent = await inviteViaApi(h, owner, 'agent');
  tl = await inviteViaApi(h, owner, 'team_lead');
  tc = await inviteViaApi(h, owner, 'tc');
  await freshReauth(h, owner);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('ponds', () => {
  it('create with defaults, edit claim limits, restrict to members; TCs never join a pond', async () => {
    const p = await call<{ pond: Pond }>(owner, 'POST', '/ponds', { name: 'Expired listings' });
    expect(p.status).toBe(201);
    expect(p.body.pond).toMatchObject({ name: 'Expired listings', isDefault: false, openToAll: true, eligibleRoles: ['agent', 'team_lead', 'isa'], claimsPerDay: 5, waitingLeads: 0 });
    const e = await call<{ pond: Pond }>(owner, 'PATCH', `/ponds/${p.body.pond.id}`, { claimsPerDay: 2, openToAll: false, eligibleRoles: ['agent'] });
    expect(e.body.pond).toMatchObject({ claimsPerDay: 2, openToAll: false, eligibleRoles: ['agent'] });
    const m = await call<{ pond: Pond }>(owner, 'PUT', `/ponds/${p.body.pond.id}/members`, { userIds: [agent.userId] });
    expect(m.body.pond.memberUserIds).toEqual([agent.userId]);
    const bad = await call(owner, 'PUT', `/ponds/${p.body.pond.id}/members`, { userIds: [tc.userId] });
    expect([bad.status, bad.code]).toEqual([422, 'MEMBER_NOT_ELIGIBLE']);
    expect((await call(owner, 'PATCH', `/ponds/${p.body.pond.id}`, { claimsPerDay: 51 })).code).toBe('VALIDATION_FAILED');
  });

  it('the default pond cannot be archived; the default can move to another pond, which then may be archived only once it is not the default', async () => {
    const def = (await ponds()).find((p) => p.isDefault)!;
    expect((await call(owner, 'DELETE', `/ponds/${def.id}`)).code).toBe('DEFAULT_POND_PROTECTED');
    const p = await call<{ pond: Pond }>(owner, 'POST', '/ponds', { name: 'New default' });
    expect((await call<{ pond: Pond }>(owner, 'PATCH', `/ponds/${p.body.pond.id}`, { isDefault: true })).body.pond.isDefault).toBe(true);
    const list = await ponds();
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([p.body.pond.id]);
    expect((await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`)).code).toBe('DEFAULT_POND_PROTECTED');
    expect((await call(owner, 'PATCH', `/ponds/${def.id}`, { isDefault: true })).status).toBe(200);
    expect((await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`)).status).toBe(200);
    expect((await ponds()).some((x) => x.id === p.body.pond.id)).toBe(false);
    expect((await call(owner, 'PATCH', `/ponds/${p.body.pond.id}`, { name: 'x' })).code).toBe('NOT_FOUND');
  });

  it('POND_IN_USE: a pond a live routing rule sends leads to cannot be archived until the rule changes', async () => {
    const p = await call<{ pond: Pond }>(owner, 'POST', '/ponds', { name: 'Sellers pond' });
    const rule = await call<{ rule: { id: string; version: number } }>(owner, 'POST', '/routing-rules', { name: 'Sellers', strategy: 'pond', targetPondId: p.body.pond.id, match: { lead_types: ['sell'] } });
    const r = await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`);
    expect([r.status, r.code]).toEqual([409, 'POND_IN_USE']);
    expect(r.body).toMatchObject({ error: { details: { ruleIds: [rule.body.rule.id] } } });
    expect((await call(owner, 'DELETE', `/routing-rules/${rule.body.rule.id}`)).status).toBe(200);
    expect((await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`)).status).toBe(200);
  });

  it('POND_NOT_EMPTY: a pond with leads waiting cannot be archived (leads move only through ownership commands); the count is shown honestly', async () => {
    const p = await call<{ pond: Pond }>(owner, 'POST', '/ponds', { name: 'Overflow' });
    const rule = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', { name: 'Overflow', strategy: 'pond', targetPondId: p.body.pond.id });
    const lead = await routeInquiry(h, owner.tenantId!, { inquiryType: 'rent' });
    expect(lead).toMatchObject({ state: 'in_pond', pondId: p.body.pond.id });
    expect((await call(owner, 'DELETE', `/routing-rules/${rule.body.rule.id}`)).status).toBe(200);
    expect((await ponds()).find((x) => x.id === p.body.pond.id)!.waitingLeads).toBe(1);
    const r = await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`);
    expect([r.status, r.code]).toEqual([409, 'POND_NOT_EMPTY']);
    expect(r.body).toMatchObject({ error: { details: { waitingLeads: 1 } } });
    const after = (await h.su.query<{ ownership_state: string; pond_id: string }>('SELECT ownership_state, pond_id FROM contacts WHERE id = $1', [lead.contactId])).rows[0]!;
    expect(after).toEqual({ ownership_state: 'in_pond', pond_id: p.body.pond.id });
  });

  it('R-AUDIT-5: pond create / update / members / archive are audited as pond.changed with label names and ids only', async () => {
    const before = (await auditRows(h, owner.tenantId!, 'pond.')).length;
    const p = await call<{ pond: Pond }>(owner, 'POST', '/ponds', { name: 'Audit pond' });
    await call(owner, 'PATCH', `/ponds/${p.body.pond.id}`, { claimCooldownHours: 24 });
    await call(owner, 'PUT', `/ponds/${p.body.pond.id}/members`, { userIds: [agent.userId] });
    await call(owner, 'DELETE', `/ponds/${p.body.pond.id}`);
    const rows = (await auditRows(h, owner.tenantId!, 'pond.')).slice(before);
    expect(rows.map((r) => r.reason)).toEqual(['CREATED', 'UPDATED', 'MEMBERS_SET', 'ARCHIVED']);
    expect(rows[0]!.changes).toMatchObject({ name: { from: null, to: 'Audit pond' } });
    expect(rows[1]!.changes).toEqual({ claim_cooldown_hours: { from: 72, to: 24 } });
    expect(rows[2]!.changes).toEqual({ member_user_ids: { from: [], to: [agent.userId] } });
  });
});

describe('teams', () => {
  it('create, rename, set members with a Team Lead; the lead flag gives the Team Lead their team scope (app.my_team_member_ids)', async () => {
    const t = await call<{ team: Team }>(owner, 'POST', '/teams', { name: 'East' });
    expect(t.status).toBe(201);
    expect((await call<{ team: Team }>(owner, 'PATCH', `/teams/${t.body.team.id}`, { name: 'East side' })).body.team.name).toBe('East side');
    const set = await call<{ team: Team }>(owner, 'PUT', `/teams/${t.body.team.id}/members`, {
      members: [
        { userId: tl.userId, isLead: true },
        { userId: agent.userId, isLead: false },
      ],
    });
    expect(set.status).toBe(200);
    const scope = await withTenantTx(tl.actor(), async (tx) => (await sql<{ ids: string[] }>`SELECT app.my_team_member_ids() AS ids`.execute(tx)).rows[0]!.ids, { db: h.database });
    expect([...scope].sort()).toEqual([tl.userId, agent.userId].sort());
    // an agent cannot be marked lead: it would carry no scope, and an honest screen does not show it
    const bad = await call(owner, 'PUT', `/teams/${t.body.team.id}/members`, { members: [{ userId: agent.userId, isLead: true }] });
    expect([bad.status, bad.code]).toEqual([422, 'MEMBER_NOT_ELIGIBLE']);
    // removing the team removes the scope
    expect((await call(owner, 'DELETE', `/teams/${t.body.team.id}`)).status).toBe(200);
    const after = await withTenantTx(tl.actor(), async (tx) => (await sql<{ ids: string[] }>`SELECT app.my_team_member_ids() AS ids`.execute(tx)).rows[0]!.ids, { db: h.database });
    expect(after).toEqual([]);
  });

  it('the default team cannot be deleted (API and the 0006 trigger); the default can move', async () => {
    const def = (await teams()).find((t) => t.isDefault)!;
    expect((await call(owner, 'DELETE', `/teams/${def.id}`)).code).toBe('DEFAULT_TEAM_PROTECTED');
    await expect(
      withTenantTx(owner.actor(), async (tx) => {
        await sql`DELETE FROM teams WHERE tenant_id = app.tenant_id() AND id = ${def.id}::uuid`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/DEFAULT_TEAM_PROTECTED/);
    const t = await call<{ team: Team }>(owner, 'POST', '/teams', { name: 'West' });
    expect((await call<{ team: Team }>(owner, 'PATCH', `/teams/${t.body.team.id}`, { isDefault: true })).body.team.isDefault).toBe(true);
    expect((await teams()).filter((x) => x.isDefault).map((x) => x.id)).toEqual([t.body.team.id]);
    expect((await call(owner, 'DELETE', `/teams/${def.id}`)).status).toBe(200);
  });

  it('R-AUDIT-5: team changes are audited as team.changed (member and lead ids, labels)', async () => {
    const before = (await auditRows(h, owner.tenantId!, 'team.')).length;
    const t = await call<{ team: Team }>(owner, 'POST', '/teams', { name: 'Audit team' });
    await call(owner, 'PUT', `/teams/${t.body.team.id}/members`, { members: [{ userId: tl.userId, isLead: true }] });
    await call(owner, 'DELETE', `/teams/${t.body.team.id}`);
    const rows = (await auditRows(h, owner.tenantId!, 'team.')).slice(before);
    expect(rows.map((r) => r.reason)).toEqual(['CREATED', 'MEMBERS_SET', 'DELETED']);
    expect(rows[1]!.changes).toEqual({ member_user_ids: { from: [], to: [tl.userId] }, lead_user_ids: { from: [], to: [tl.userId] } });
  });

  it('R-PERM-1: a Team Lead and an agent get 404 on every pond and team write and read', async () => {
    const def = (await teams()).find((t) => t.isDefault)!;
    for (const c of [tl, agent]) {
      expect((await call(c, 'GET', '/teams')).status).toBe(404);
      expect((await call(c, 'GET', '/ponds')).status).toBe(404);
      expect((await call(c, 'POST', '/ponds', { name: 'x' })).status).toBe(404);
      expect((await call(c, 'PUT', `/teams/${def.id}/members`, { members: [] })).status).toBe(404);
    }
  });
});
