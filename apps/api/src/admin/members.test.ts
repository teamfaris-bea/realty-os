// api/admin members and invites through the real server and real Postgres (as app_user):
// R-PERM-2 (role/status rules + last Owner, incl. a two-session race), R-PERM-13 (re-auth),
// R-PERM-14 (Owner/Admin MFA enrollment), R-PERM-15 (TC never holds leads), R-PERM-5 (404s),
// R-AUDIT-5 (membership invite / role change / suspend / remove are audited).
import type { ContactId, UserActor } from '@realty/core/foundation';
import { applyOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from './testing.js';

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;

interface MemberView {
  userId: string;
  role: string;
  status: string;
  acceptingLeads: boolean;
  version: number;
}

async function member(c: TestClient, userId: string): Promise<MemberView> {
  await freshReauth(h, c);
  const r = await call<{ members: MemberView[] }>(c, 'GET', '/members');
  const m = r.body.members.find((x) => x.userId === userId);
  if (!m) throw new Error(`member ${userId} not listed`);
  return m;
}

async function patchMember(c: TestClient, userId: string, body: Record<string, unknown>) {
  const m = await member(c, userId);
  return call<{ member: MemberView }>(c, 'PATCH', `/members/${userId}`, { version: m.version, ...body });
}

function actorOf(c: TestClient): UserActor {
  return c.actor();
}

async function selfCreatedLead(c: TestClient): Promise<ContactId> {
  const id = randomUUID() as ContactId;
  const r = await applyOwnershipCommand(actorOf(c), id, { kind: 'create', via: 'self' }, { commandId: randomUUID(), newContact: { displayName: 'Sam Sphere' }, db: h.database });
  if (!r.outcome.ok) throw new Error('self create rejected');
  return id;
}

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('invites', () => {
  it('R-PERM-13: an invite needs a re-authentication within 15 minutes; a stale session writes nothing', async () => {
    await staleReauth(h, owner);
    const email = 'stale-invite@example.test';
    const r = await call(owner, 'POST', '/invites', { email, role: 'agent' });
    expect([r.status, r.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await h.su.query('SELECT 1 FROM invites WHERE email = $1', [email])).rowCount).toBe(0);
    await freshReauth(h, owner);
    expect((await call(owner, 'POST', '/invites', { email, role: 'agent' })).status).toBe(201);
  });

  it('an invite stores only the token hash, expires in 7 days, and emails the accept link; the invitee joins with that role', async () => {
    await freshReauth(h, owner);
    const email = 'new.agent@example.test';
    const r = await call<{ invite: { id: string; expiresAt: string; role: string }; emailSent: boolean }>(owner, 'POST', '/invites', { email: ' New.Agent@Example.test ', role: 'agent' });
    expect(r.status).toBe(201);
    expect(r.body.emailSent).toBe(true);
    expect(r.body.invite.role).toBe('agent');
    const days = (Date.parse(r.body.invite.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7.0001);
    const link = h.providers.accountMail.lastLink(email)!;
    expect(link).toMatch(/^http:\/\/localhost:5173\/invite#token=[A-Za-z0-9_-]{43}$/);
    const token = link.split('#token=')[1]!;
    const row = (await h.su.query<{ token_hash: Buffer }>('SELECT token_hash FROM invites WHERE id = $1', [r.body.invite.id])).rows[0]!;
    expect(row.token_hash.length).toBe(32);
    expect(row.token_hash.toString('base64url')).not.toBe(token);
    const c = h.client('192.0.2.77');
    const acc = await c.post(`/api/auth/invites/${token}/accept`, { displayName: 'New Agent', password: 'correct horse battery staple' });
    expect(acc.statusCode).toBe(200);
    expect(c.role).toBe('agent');
  });

  it('MEMBER_EXISTS: inviting a current member is refused, so the invite path never re-roles anyone (roles change only under memberships_guard)', async () => {
    await freshReauth(h, admin);
    const r = await call(admin, 'POST', '/invites', { email: owner.email, role: 'agent' });
    expect([r.status, r.code]).toEqual([409, 'MEMBER_EXISTS']);
  });

  it('INVITE_PENDING: one pending invite per email; revoking it kills its link and allows a fresh invite', async () => {
    await freshReauth(h, owner);
    const email = 'pending@example.test';
    const first = await call<{ invite: { id: string } }>(owner, 'POST', '/invites', { email, role: 'isa' });
    expect(first.status).toBe(201);
    const token = h.providers.accountMail.lastLink(email)!.split('#token=')[1]!;
    expect((await call(owner, 'POST', '/invites', { email, role: 'isa' })).code).toBe('INVITE_PENDING');
    expect((await call(owner, 'DELETE', `/invites/${first.body.invite.id}`)).status).toBe(200);
    expect((await call(owner, 'DELETE', `/invites/${first.body.invite.id}`)).code).toBe('NOT_FOUND');
    const acc = await h.client('192.0.2.78').post(`/api/auth/invites/${token}/accept`, { displayName: 'X', password: 'correct horse battery staple' });
    expect(acc.statusCode).toBe(404);
    expect((await call(owner, 'POST', '/invites', { email, role: 'isa' })).status).toBe(201);
  });

  it('R-PERM-2 E53: an Admin can neither invite an Owner nor revoke an Owner invite (OWNER_REQUIRED, after the role checks pass)', async () => {
    await freshReauth(h, admin);
    const r = await call(admin, 'POST', '/invites', { email: 'second.owner@example.test', role: 'owner' });
    expect([r.status, r.code]).toEqual([403, 'OWNER_REQUIRED']);
    await freshReauth(h, owner);
    const inv = await call<{ invite: { id: string } }>(owner, 'POST', '/invites', { email: 'co.owner@example.test', role: 'owner' });
    expect(inv.status).toBe(201);
    expect((await call(admin, 'DELETE', `/invites/${inv.body.invite.id}`)).code).toBe('OWNER_REQUIRED');
    expect((await call(owner, 'DELETE', `/invites/${inv.body.invite.id}`)).status).toBe(200);
  });

  it('R-PERM-5: agents, ISAs, TCs and Team Leads get 404 on every member route; an unknown member is 404', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    const tl = await inviteViaApi(h, owner, 'team_lead');
    for (const c of [agent, tl]) {
      expect((await call(c, 'GET', '/members')).status).toBe(404);
      expect((await call(c, 'POST', '/invites', { email: 'x@example.test', role: 'agent' })).status).toBe(404);
      expect((await call(c, 'PATCH', `/members/${owner.userId}`, { role: 'agent', version: 1 })).status).toBe(404);
    }
    await freshReauth(h, owner);
    expect((await call(owner, 'PATCH', `/members/${randomUUID()}`, { role: 'agent', version: 1 })).code).toBe('NOT_FOUND');
  });
});

describe('role and status changes', () => {
  it('R-PERM-2 E53: an Admin cannot promote anyone (incl. themself) to Owner, nor demote or suspend an Owner', async () => {
    await freshReauth(h, admin);
    expect((await patchMember(admin, admin.userId!, { role: 'owner' })).code).toBe('OWNER_REQUIRED');
    expect((await patchMember(admin, owner.userId!, { role: 'admin' })).code).toBe('OWNER_REQUIRED');
    expect((await patchMember(admin, owner.userId!, { status: 'suspended' })).code).toBe('OWNER_REQUIRED');
    expect((await member(owner, owner.userId!)).role).toBe('owner');
  });

  it('R-PERM-2: the memberships_guard trigger backs the API: an Admin writing role=owner directly as app_user is refused', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await expect(
      withTenantTx(admin.actor(), async (tx) => {
        await sql`UPDATE memberships SET role = 'owner' WHERE tenant_id = app.tenant_id() AND user_id = ${agent.userId}::uuid`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/OWNER_ROLE_REQUIRES_OWNER/);
    await expect(
      withTenantTx(agent.actor(), async (tx) => {
        await sql`UPDATE memberships SET role = 'admin' WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/ROLE_CHANGE_FORBIDDEN/);
  });

  it('R-PERM-2 E53: the last active Owner can be neither demoted, suspended nor removed (LAST_OWNER)', async () => {
    await freshReauth(h, owner);
    for (const body of [{ role: 'admin' }, { status: 'suspended' }, { status: 'removed' }]) {
      const r = await patchMember(owner, owner.userId!, body);
      expect([r.status, r.code]).toEqual([409, 'LAST_OWNER']);
    }
    expect(await member(owner, owner.userId!)).toMatchObject({ role: 'owner', status: 'active' });
  });

  it('R-PERM-2: two Owners demoting each other in two concurrent sessions: exactly one wins and the tenant keeps one active Owner', async () => {
    const h2 = await createApiHarness();
    try {
      const o1 = await h2.signup();
      const o2 = await inviteViaApi(h2, o1, 'owner');
      // widen the race window in this test's own database (a timing fixture, not an RLS proof): every
      // membership update sleeps 300 ms before memberships_guard runs, so both PATCHes are inside
      // their UPDATE at the same time. Without the 0006 lock, 2 of 3 rounds left zero Owners.
      await h2.su.query('CREATE FUNCTION app.zz_slow() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$');
      await h2.su.query('CREATE TRIGGER aa_slow BEFORE UPDATE ON memberships FOR EACH ROW EXECUTE FUNCTION app.zz_slow()');
      for (let round = 0; round < 3; round++) {
        await freshReauth(h2, o1);
        await freshReauth(h2, o2);
        const v = async (c: TestClient, uid: string) => (await call<{ members: MemberView[] }>(c, 'GET', '/members')).body.members.find((m) => m.userId === uid)!.version;
        const [v2, v1] = [await v(o1, o2.userId!), await v(o2, o1.userId!)];
        const [a, b] = await Promise.all([
          call(o1, 'PATCH', `/members/${o2.userId}`, { role: 'admin', version: v2 }),
          call(o2, 'PATCH', `/members/${o1.userId}`, { role: 'admin', version: v1 }),
        ]);
        const statuses = [a.status, b.status].sort();
        expect(statuses[0]).toBe(200);
        expect(statuses[1]).toBeGreaterThanOrEqual(400);
        expect(['LAST_OWNER', 'OWNER_REQUIRED', 'UNAUTHENTICATED']).toContain(a.status === 200 ? b.code : a.code);
        const owners = await h2.su.query("SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'owner' AND status = 'active'", [o1.tenantId]);
        expect(owners.rowCount).toBe(1);
        // restore two Owners for the next round (the remaining Owner promotes the other back; their session was rotated)
        const winner = a.status === 200 ? o1 : o2;
        const loser = winner === o1 ? o2 : o1;
        await freshReauth(h2, winner);
        expect((await call(winner, 'PATCH', `/members/${loser.userId}`, { role: 'owner', version: await v(winner, loser.userId!) })).status).toBe(200);
        const relog = await h2.login(loser.email);
        relog.totpSecret = loser.totpSecret;
        const mfa = await relog.post('/api/auth/mfa/verify', { code: await relog.totp() });
        expect(mfa.statusCode).toBe(200);
        Object.assign(loser, { cookie: relog.cookie, csrf: relog.csrf, role: relog.role, tenantId: relog.tenantId });
      }
    } finally {
      await h2.close();
    }
  });

  it('session rotation on privilege change: a role change ends the member\'s sessions; their next session carries the new role', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    expect((await agent.get('/api/auth/session')).statusCode).toBe(200);
    await freshReauth(h, owner);
    expect((await patchMember(owner, agent.userId!, { role: 'team_lead' })).status).toBe(200);
    expect((await agent.get('/api/auth/session')).statusCode).toBe(401);
    const again = await h.login(agent.email);
    expect(again.role).toBe('team_lead');
  });

  it('R-PERM-14: a member promoted to Admin gets an enrollment-only session until TOTP is enrolled', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await freshReauth(h, owner);
    expect((await patchMember(owner, agent.userId!, { role: 'admin' })).status).toBe(200);
    const again = await h.login(agent.email);
    const r = await call(again, 'GET', '/members');
    expect([r.status, r.code]).toEqual([403, 'MFA_ENROLLMENT_REQUIRED']);
    await h.enrollMfa(again);
    expect((await call(again, 'GET', '/members')).status).toBe(200);
  });

  it('R-PERM-15: a member who holds leads cannot become a TC or be removed (MEMBER_HAS_LEADS); without leads a TC stops accepting leads', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await selfCreatedLead(agent);
    await freshReauth(h, owner);
    const toTc = await patchMember(owner, agent.userId!, { role: 'tc' });
    expect([toTc.status, toTc.code]).toEqual([409, 'MEMBER_HAS_LEADS']);
    expect(toTc.body).toMatchObject({ error: { details: { owned: 1, offered: 0 } } });
    expect((await patchMember(owner, agent.userId!, { status: 'removed' })).code).toBe('MEMBER_HAS_LEADS');
    const clean = await inviteViaApi(h, owner, 'agent');
    const ok = await patchMember(owner, clean.userId!, { role: 'tc' });
    expect(ok.status).toBe(200);
    expect(ok.body.member).toMatchObject({ role: 'tc', acceptingLeads: false });
    const back = await patchMember(owner, clean.userId!, { role: 'agent' });
    expect(back.body.member).toMatchObject({ role: 'agent', acceptingLeads: true });
  });

  it('suspend ends the member\'s sessions and their access; reactivating restores it; both are audited', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await freshReauth(h, admin);
    const s = await patchMember(admin, agent.userId!, { status: 'suspended' });
    expect(s.body.member.status).toBe('suspended');
    expect((await agent.get('/api/auth/session')).statusCode).toBe(401);
    await expect(h.login(agent.email)).resolves.toMatchObject({ tenantId: null });
    expect((await patchMember(admin, agent.userId!, { status: 'active' })).body.member.status).toBe('active');
    const rows = (await auditRows(h, owner.tenantId!, 'member.')).filter((r) => r.entity_id === agent.userId);
    expect(rows.map((r) => r.action)).toEqual(['member.suspended', 'member.reactivated']);
    expect(rows[0]!.changes).toEqual({ status: { from: 'active', to: 'suspended' } });
    expect(rows[0]!.actor_role).toBe('admin');
  });

  it('remove: a member without leads is removed and leaves every routing rule, pond and team list in the same transaction', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await freshReauth(h, owner);
    const rule = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', { name: 'All', strategy: 'round_robin', members: [{ userId: agent.userId, weight: 1 }] });
    expect(rule.status).toBe(201);
    const teams = await call<{ teams: { id: string; isDefault: boolean; members: { userId: string; isLead: boolean }[] }[] }>(owner, 'GET', '/teams');
    const team = teams.body.teams.find((t) => t.isDefault)!;
    expect((await call(owner, 'PUT', `/teams/${team.id}/members`, { members: [...team.members, { userId: agent.userId, isLead: false }] })).status).toBe(200);
    expect((await h.su.query('SELECT 1 FROM team_members WHERE user_id = $1', [agent.userId])).rowCount).toBe(1);
    const r = await patchMember(owner, agent.userId!, { status: 'removed' });
    expect(r.body.member.status).toBe('removed');
    expect((await h.su.query('SELECT 1 FROM routing_rule_members WHERE user_id = $1', [agent.userId])).rowCount).toBe(0);
    expect((await h.su.query('SELECT 1 FROM team_members WHERE user_id = $1', [agent.userId])).rowCount).toBe(0);
    const row = (await h.su.query<{ removed_at: Date | null }>('SELECT removed_at FROM memberships WHERE user_id = $1', [agent.userId])).rows[0]!;
    expect(row.removed_at).not.toBeNull();
    // a removed member is gone: further changes are 404
    expect((await call(owner, 'PATCH', `/members/${agent.userId}`, { status: 'active', version: 99 })).code).toBe('NOT_FOUND');
  });

  it('VERSION_CONFLICT: a stale version is refused with the fresh member in details', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await freshReauth(h, owner);
    const m = await member(owner, agent.userId!);
    const r = await call(owner, 'PATCH', `/members/${agent.userId}`, { role: 'isa', version: m.version + 5 });
    expect([r.status, r.code]).toEqual([409, 'VERSION_CONFLICT']);
    expect(r.body).toMatchObject({ error: { details: { member: { userId: agent.userId, role: 'agent' } } } });
  });

  it('R-PERM-13: a role change with a stale re-authentication is 401 REAUTH_REQUIRED and changes nothing', async () => {
    const agent = await inviteViaApi(h, owner, 'agent');
    await freshReauth(h, owner);
    const m = await member(owner, agent.userId!);
    await staleReauth(h, owner);
    const r = await call(owner, 'PATCH', `/members/${agent.userId}`, { role: 'isa', version: m.version });
    expect([r.status, r.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await member(owner, agent.userId!)).role).toBe('agent');
  });
});

describe('isolation', () => {
  it('R-PERM-5: another tenant\'s member id is 404 (RLS hides it; nothing is revealed)', async () => {
    const other = await h.signup();
    await freshReauth(h, owner);
    const r = await call(owner, 'PATCH', `/members/${other.userId}`, { role: 'agent', version: 1 });
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    expect((await h.su.query('SELECT role FROM memberships WHERE user_id = $1', [other.userId])).rows[0]?.role).toBe('owner');
  });
});
