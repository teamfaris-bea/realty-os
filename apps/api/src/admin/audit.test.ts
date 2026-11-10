// R-AUDIT-5 / R-AUDIT-4 / R-AUDIT-3 for api/admin: every admin endpoint that changes something writes
// its audit row in the same transaction, with a redacted diff (ids, codes, labels and numbers as
// {from, to}; emails and anything not known to be non-PII as {"changed": true}). One call per
// endpoint, then a normalized snapshot of every admin audit row.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ATTESTATION_TEXT } from './policy.js';
import { auditRows, call, freshReauth, inviteViaApi, normalize } from './testing.js';

let h: ApiHarness;
let owner: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-AUDIT-5 admin audit trail', () => {
  it('R-AUDIT-5 R-AUDIT-4: one call per admin endpoint; every change is audited with a redacted diff (snapshot), and no email ever reaches audit_log', async () => {
    const agent = await inviteViaApi(h, owner, 'agent', { email: 'audit.agent@example.test' });
    await freshReauth(h, owner);
    const settings = async () => (await call<{ settings: { version: number } }>(owner, 'GET', '/settings')).body.settings;
    const memberVersion = async (id: string) => (await call<{ members: { userId: string; version: number }[] }>(owner, 'GET', '/members')).body.members.find((m) => m.userId === id)!.version;

    // members and invites
    const inv = await call<{ invite: { id: string } }>(owner, 'POST', '/invites', { email: 'revoked.person@example.test', role: 'isa' });
    expect((await call(owner, 'DELETE', `/invites/${inv.body.invite.id}`)).status).toBe(200);
    expect((await call(owner, 'PATCH', `/members/${agent.userId}`, { role: 'team_lead', version: await memberVersion(agent.userId!) })).status).toBe(200);
    expect((await call(owner, 'PATCH', `/members/${agent.userId}`, { status: 'suspended', version: await memberVersion(agent.userId!) })).status).toBe(200);
    expect((await call(owner, 'PATCH', `/members/${agent.userId}`, { status: 'active', version: await memberVersion(agent.userId!) })).status).toBe(200);
    // teams, ponds, routing
    const team = await call<{ team: { id: string } }>(owner, 'POST', '/teams', { name: 'North' });
    await call(owner, 'PATCH', `/teams/${team.body.team.id}`, { name: 'North Shore' });
    await call(owner, 'PUT', `/teams/${team.body.team.id}/members`, { members: [{ userId: agent.userId, isLead: true }] });
    await call(owner, 'DELETE', `/teams/${team.body.team.id}`);
    const pond = await call<{ pond: { id: string } }>(owner, 'POST', '/ponds', { name: 'Nurture pond' });
    await call(owner, 'PATCH', `/ponds/${pond.body.pond.id}`, { claimsPerDay: 3 });
    await call(owner, 'PUT', `/ponds/${pond.body.pond.id}/members`, { userIds: [agent.userId] });
    const rule = await call<{ rule: { id: string; version: number } }>(owner, 'POST', '/routing-rules', {
      name: 'Buyers',
      strategy: 'round_robin',
      match: { lead_types: ['buy'] },
      fallbackPondId: pond.body.pond.id,
      members: [{ userId: agent.userId, weight: 1 }],
    });
    await call(owner, 'PUT', `/routing-rules/${rule.body.rule.id}/members`, [{ userId: agent.userId, weight: 4 }]);
    await call(owner, 'PATCH', `/routing-rules/${rule.body.rule.id}`, { offerWindowSeconds: 120, version: rule.body.rule.version + 1 });
    const second = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', { name: 'Everyone else', strategy: 'pond', targetPondId: pond.body.pond.id });
    expect((await call(owner, 'PUT', '/routing-rules/order', { ruleIds: [second.body.rule.id, rule.body.rule.id] })).status).toBe(200);
    await call(owner, 'DELETE', `/routing-rules/${rule.body.rule.id}`);
    await call(owner, 'DELETE', `/routing-rules/${second.body.rule.id}`);
    await call(owner, 'DELETE', `/ponds/${pond.body.pond.id}`);
    // settings, identity, policy
    await call(owner, 'PATCH', '/settings', { version: (await settings()).version, firstTouchSlaSeconds: 600, teamLeadRecordingAccess: false });
    await call(owner, 'PATCH', '/settings/identity', { version: (await settings()).version, brokeragePostalAddress: '12 Broad St, Charleston, SC 29401' });
    const pol = await call<{ id: string }>(owner, 'POST', '/compliance-policies', { contactWindowStart: '08:30', attestation: ATTESTATION_TEXT });
    expect(pol.status).toBe(201);
    expect((await call(owner, 'POST', `/compliance-policies/${pol.body.id}/activate`, { attestation: ATTESTATION_TEXT })).status).toBe(200);

    const rows = (await auditRows(h, owner.tenantId!)).filter((r) => !r.action.startsWith('session.'));
    for (const r of rows) {
      expect(r.actor_user_id).toBe(owner.userId);
      expect(r.request_id).not.toBeNull();
    }
    const text = JSON.stringify(rows);
    expect(text).not.toMatch(/@example\.test/);
    expect(text).not.toMatch(/revoked\.person|audit\.agent/);
    expect(normalize(rows.map((r) => ({ action: r.action, entity: r.entity_type, reason: r.reason, changes: r.changes })))).toMatchSnapshot();
  });

  it('R-AUDIT-3: when an admin change fails, its audit row is not written either (one transaction)', async () => {
    const before = (await auditRows(h, owner.tenantId!)).length;
    await freshReauth(h, owner);
    const v = (await call<{ members: { userId: string; version: number }[] }>(owner, 'GET', '/members')).body.members.find((m) => m.userId === owner.userId)!.version;
    expect((await call(owner, 'PATCH', `/members/${owner.userId}`, { role: 'admin', version: v })).code).toBe('LAST_OWNER');
    expect((await call(owner, 'POST', '/routing-rules', { name: 'Bad', strategy: 'direct' })).code).toBe('RULE_INVALID');
    expect((await auditRows(h, owner.tenantId!)).length).toBe(before);
  });
});
