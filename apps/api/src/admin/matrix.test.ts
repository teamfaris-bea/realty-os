// api/admin authorization: the route × role matrix for every admin route (R-PERM-1, R-PERM-5), with
// the member.role, settings.compliance and settings.identity rows checked against core.can(); re-auth
// on invites, role changes, policy loosening and identity (R-PERM-13); the route table (every route
// declares authorize, no route input accepts a tenant id: R-TEN-3); response schemas without
// confidence* or tenant id fields (R-AST-13, R-TEN-3).
import { type Action, ROLES, type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ATTESTATION_TEXT } from './policy.js';
import { ADMIN_RESPONSE_SCHEMAS } from './schemas.js';
import { call, freshReauth, inviteViaApi, staleReauth } from './testing.js';

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;
let target: TestClient; // an agent the member routes act on

beforeAll(async () => {
  h = await createApiHarness();
  users.owner = await h.signup();
  for (const role of ROLES) if (role !== 'owner') users[role] = await inviteViaApi(h, users.owner, role);
  target = await inviteViaApi(h, users.owner, 'agent');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const AUTH_DENIALS = new Set([401, 403, 404]);

/** What core.can() says for this role, action and facts (fresh re-auth): 'allowed' or the deny code. */
function expected(role: Role, action: Action, facts: ResourceFacts): string {
  const c = users[role];
  const now = 2_000_000_000_000 as never;
  const r = can({ kind: 'user', userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' }, action, { ...facts, reauth: { reauthenticatedAt: now, now } });
  return r.ok ? 'allowed' : r.code;
}

/** 'allowed' when the request passed authorization (any non-auth outcome), else the error code. */
function outcome(r: { status: number; code: string | null }): string {
  return AUTH_DENIALS.has(r.status) && r.code !== null && r.code !== 'VERSION_CONFLICT' ? r.code : 'allowed';
}

describe('R-PERM-1 route × role matrix (admin routes)', () => {
  it('R-PERM-1 R-PERM-5: member.role row: Owner any member; Admin non-Owners only (OWNER_REQUIRED on an Owner); everyone else 404', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      await freshReauth(h, c);
      // a stale version: an authorized request ends in 409 VERSION_CONFLICT and changes nothing
      got[`${role}→agent`] = outcome(await call(c, 'PATCH', `/members/${target.userId}`, { role: 'isa', version: 999 }));
      want[`${role}→agent`] = expected(role, 'member.role', { target: { role: 'agent', newRole: 'isa' } });
      got[`${role}→owner`] = outcome(await call(c, 'PATCH', `/members/${users.owner.userId}`, { role: 'admin', version: 999 }));
      want[`${role}→owner`] = expected(role, 'member.role', { target: { role: 'owner', newRole: 'admin' } });
      got[`${role} invite owner`] = outcome(await call(c, 'POST', '/invites', { email: `matrix-${role}@example.test`, role: 'owner' }));
      want[`${role} invite owner`] = expected(role, 'member.invite', { target: { role: 'owner', newRole: 'owner' } });
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner→agent': 'allowed', 'admin→agent': 'allowed', 'admin→owner': 'OWNER_REQUIRED', 'agent→agent': 'NOT_FOUND', 'tc→owner': 'NOT_FOUND' });
  });

  it('R-PERM-1: settings.compliance row: stricter Owner/Admin; looser Owner with attestation (Admin OWNER_REQUIRED); everyone else 404', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      await freshReauth(h, c);
      got[`${role} stricter`] = outcome(await call(c, 'POST', '/compliance-policies', { maxDeferrals: 3 }));
      want[`${role} stricter`] = expected(role, 'settings.compliance', { loosening: false });
      got[`${role} looser`] = outcome(await call(c, 'POST', '/compliance-policies', { contactWindowEnd: '20:30' }));
      want[`${role} looser`] = expected(role, 'settings.compliance', { loosening: true, attested: false });
      got[`${role} looser attested`] = outcome(await call(c, 'POST', '/compliance-policies', { contactWindowEnd: '20:30', attestation: ATTESTATION_TEXT }));
      want[`${role} looser attested`] = expected(role, 'settings.compliance', { loosening: true, attested: true });
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner looser': 'ATTESTATION_REQUIRED', 'owner looser attested': 'allowed', 'admin looser attested': 'OWNER_REQUIRED', 'team_lead stricter': 'NOT_FOUND' });
  });

  it('R-PERM-1 R-PERM-3: settings.identity row: Owner only (Admin 404 on the identity route, OWNER_REQUIRED on recording fields of /settings)', async () => {
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const c = users[role];
      await freshReauth(h, c);
      got[role] = outcome(await call(c, 'PATCH', '/settings/identity', { version: 999, teamName: 'Matrix Team' }));
      want[role] = expected(role, 'settings.identity', {});
    }
    expect(got).toEqual(want);
    expect(want).toEqual({ owner: 'allowed', admin: 'NOT_FOUND', team_lead: 'NOT_FOUND', agent: 'NOT_FOUND', isa: 'NOT_FOUND', tc: 'NOT_FOUND' });
    const rec = await call(users.admin, 'PATCH', '/settings', { version: 999, tcRecordingAccess: true });
    expect([rec.status, rec.code]).toEqual([403, 'OWNER_REQUIRED']);
  });

  it('R-PERM-1: every admin read and settings.routing route is Owner/Admin only; other roles get 404 for each', async () => {
    const reads = ['/members', '/routing-rules', '/ponds', '/teams', '/settings', '/compliance-policies'];
    for (const role of ROLES) {
      for (const url of reads) {
        const r = await call(users[role], 'GET', url);
        const ok = role === 'owner' || role === 'admin';
        expect({ role, url, status: r.status }).toEqual({ role, url, status: ok ? 200 : 404 });
      }
      const w = await call(users[role], 'POST', '/teams', { name: `t-${role}` });
      expect({ role, status: w.status }).toEqual({ role, status: role === 'owner' || role === 'admin' ? 201 : 404 });
    }
  });
});

describe('R-PERM-13 re-auth on the admin 🔒 actions', () => {
  it('R-PERM-13: invites, role changes, policy loosening and identity answer 401 REAUTH_REQUIRED after 15 minutes; lead timers and stricter policy do not', async () => {
    const o = users.owner;
    await staleReauth(h, o);
    const s = (await call<{ settings: { version: number } }>(o, 'GET', '/settings')).body.settings;
    const sensitive = [
      await call(o, 'POST', '/invites', { email: 'reauth@example.test', role: 'agent' }),
      await call(o, 'PATCH', `/members/${target.userId}`, { role: 'isa', version: 999 }),
      await call(o, 'POST', '/compliance-policies', { contactWindowEnd: '20:30', attestation: ATTESTATION_TEXT }),
      await call(o, 'PATCH', '/settings/identity', { version: s.version, teamName: 'Stale' }),
    ];
    expect(sensitive.map((r) => [r.status, r.code])).toEqual(Array(4).fill([401, 'REAUTH_REQUIRED']));
    expect((await call(o, 'PATCH', '/settings', { version: s.version, maxOffers: 3 })).status).toBe(200);
    expect((await call(o, 'POST', '/compliance-policies', { maxDeferrals: 3 })).status).toBe(201);
  });
});

describe('route table and schemas', () => {
  // admin's own routes only: /ponds/:id/cards and /members/:userId/deactivate belong to api/leads
  const adminUrls = /^\/api\/(members(?!\/:userId\/deactivate)|invites|routing-rules|ponds(?!\/:id\/cards)|teams|settings|compliance-policies)/;

  it('every admin route declares an Action and carries authorize(<that action>) (snapshot)', () => {
    const rows = h.app.platform.routeTable.filter((r) => adminUrls.test(r.url));
    for (const r of rows) expect(r.authorizes).toBe(r.auth);
    expect(rows.map((r) => `${r.method} ${r.url} → ${r.auth}`)).toMatchSnapshot();
  });

  it('R-TEN-3: no admin route input accepts a tenant id; strict bodies refuse an extra tenant_id', async () => {
    for (const r of h.app.platform.routeTable.filter((x) => adminUrls.test(x.url))) {
      for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    }
    await freshReauth(h, users.owner);
    const r = await call(users.owner, 'POST', '/teams', { name: 'x', tenant_id: users.admin.tenantId });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
  });

  it('R-AST-13 R-TEN-3: admin response schemas have no confidence* fields and no tenant id fields (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(ADMIN_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text).not.toMatch(/confidence/i);
      expect(text).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });
});
