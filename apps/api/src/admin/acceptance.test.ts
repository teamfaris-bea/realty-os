// BUILD_PLAN module 10 acceptance: a new tenant, through the API only, invites agents, creates a
// team, a pond and a round-robin rule, sets lead timers and brokerage identity, and publishes a
// policy version; the next inquiry is offered to an invited agent instead of going to NO_RULE_MATCH.
// The inquiry enters the way api/leads' intake will call it: applyOwnershipCommand(create via intake)
// as the system actor, routed by the rules configured here (R-OWN-10).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, freshReauth, inviteViaApi, registerPush, routeInquiry } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('module 10 acceptance', () => {
  it('R-OWN-10: a tenant set up through the API only offers its next inquiry to an invited agent (not NO_RULE_MATCH)', async () => {
    const owner = await h.signup({ timezone: 'America/New_York' });
    const tenantId = owner.tenantId!;

    // before any rule: the inquiry goes to the default pond with NO_RULE_MATCH
    const before = await routeInquiry(h, tenantId, { inquiryType: 'buy' });
    expect(before).toMatchObject({ state: 'in_pond', reason: 'NO_RULE_MATCH', offeredTo: null });

    // invite two agents (emailed links, accepted through the API) who register a push device
    const agents: TestClient[] = [];
    for (let i = 0; i < 2; i++) {
      const a = await inviteViaApi(h, owner, 'agent', { email: `agent${i}@harbor.example.test` });
      await registerPush(a);
      agents.push(a);
    }
    await freshReauth(h, owner);

    // a team with both agents
    const team = await call<{ team: { id: string } }>(owner, 'POST', '/teams', { name: 'Buyers team' });
    expect(team.status).toBe(201);
    expect((await call(owner, 'PUT', `/teams/${team.body.team.id}/members`, { members: agents.map((a) => ({ userId: a.userId, isLead: false })) })).status).toBe(200);

    // a pond for leads nobody accepts
    const pond = await call<{ pond: { id: string } }>(owner, 'POST', '/ponds', { name: 'Buyer overflow', claimsPerDay: 3 });
    expect(pond.status).toBe(201);

    // a round-robin rule for buyers, falling back to that pond
    const rule = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', {
      name: 'Buyers round robin',
      strategy: 'round_robin',
      match: { lead_types: ['buy'] },
      fallbackPondId: pond.body.pond.id,
      members: agents.map((a) => ({ userId: a.userId, weight: 1 })),
    });
    expect(rule.status).toBe(201);

    // lead timers and brokerage identity
    let s = (await call<{ settings: { version: number } }>(owner, 'GET', '/settings')).body.settings;
    const timers = await call<{ settings: { version: number; offerWindowSeconds: number } }>(owner, 'PATCH', '/settings', {
      version: s.version,
      offerWindowSeconds: 240,
      maxOffers: 2,
      firstTouchSlaSeconds: 600,
      firstTouchReleaseSeconds: 1800,
      routingHoursStart: '08:00',
      routingHoursEnd: '21:00',
    });
    expect(timers.status).toBe(200);
    s = timers.body.settings;
    const identity = await call<{ settings: { identity: { missing: string[] } } }>(owner, 'PATCH', '/settings/identity', {
      version: s.version,
      brokerageLegalName: 'Harbor Realty LLC',
      teamName: 'The Harbor Team',
      brokerageLicenseNumber: 'SC-20931',
      brokeragePostalAddress: '12 Broad St, Charleston, SC 29401',
    });
    expect(identity.status).toBe(200);
    expect(identity.body.settings.identity.missing).toEqual([]);

    // publish a (stricter) policy version and make it active
    const pol = await call<{ id: string; active: boolean; loosening: boolean }>(owner, 'POST', '/compliance-policies', { autonomousCategories: ['speed_to_lead_reply', 'reminder'], activate: true });
    expect(pol.status).toBe(201);
    expect(pol.body).toMatchObject({ active: true, loosening: false });
    expect((await call<{ activePolicyId: string }>(owner, 'GET', '/compliance-policies')).body.activePolicyId).toBe(pol.body.id);

    // the next inquiry is offered to one of the invited agents, by the configured rule
    const next = await routeInquiry(h, tenantId, { inquiryType: 'buy' });
    expect(next.state).toBe('offered');
    expect(agents.map((a) => a.userId)).toContain(next.offeredTo);
    const offered = (await h.su.query<{ routing_rule_id: string; reason_code: string }>(
      "SELECT routing_rule_id, reason_code FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offered'",
      [next.contactId],
    )).rows[0]!;
    expect(offered.routing_rule_id).toBe(rule.body.rule.id);
    // the offer uses the tenant's new 240 s window (at least 240 s of routing-hours business time ahead)
    expect(next.offerExpiresAt!.getTime() - Date.now()).toBeGreaterThan(230_000);
    // and the agent sees the offer card through their own session's RLS
    const agent = agents.find((a) => a.userId === next.offeredTo)!;
    const { withTenantTx } = await import('@realty/db');
    const { sql } = await import('kysely');
    const visible = await withTenantTx(agent.actor(), async (tx) => (await sql`SELECT id FROM contacts WHERE id = ${next.contactId}::uuid`.execute(tx)).rows.length, { db: h.database });
    expect(visible).toBe(1);
  });
});
