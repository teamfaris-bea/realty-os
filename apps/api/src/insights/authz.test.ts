// Role × route for api/insights against core can() (DATA_MODEL §8 rows "Owner view" and "Source costs"; agent_goals).
// Every denial is 404 (R-PERM-5): an agent or a Team Lead asking for the owner view never learns it exists.
import { ROLES, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type InsightsWorld, call, freshReauth, insightsWorld, staleReauth, ym } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
const by: Partial<Record<Role, TestClient>> = {};

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  Object.assign(by, { owner: w.owner, admin: w.admin, team_lead: w.teamLead, agent: w.agents[0], isa: w.isa, tc: w.tc });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-OWNER-1 R-OWNER-5 R-PERM-5 role × route', () => {
  it('R-OWNER-1 R-PERM-5: each role gets exactly what can() says on the owner-view, cost and goal routes (denials are 404, the closed month adds 401 re-auth)', async () => {
    const month = ym(new Date(), w.zone);
    const got: Record<string, number> = {};
    const want: Record<string, number> = {};
    for (const role of ROLES) {
      const c = by[role]!;
      const actor = { kind: 'user' as const, userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 's' };
      got[`${role} sources`] = (await call(c, 'GET', '/owner/sources')).status;
      want[`${role} sources`] = can(actor, 'owner_view.view', {}).ok ? 200 : 404;
      got[`${role} forecast`] = (await call(c, 'GET', '/owner/forecast')).status;
      want[`${role} forecast`] = want[`${role} sources`]!;
      await staleReauth(h, c);
      got[`${role} cost open month`] = (await call(c, 'PUT', '/lead-source-costs', { leadSourceId: w.sourceId, month, amountCents: 100 })).status;
      want[`${role} cost open month`] = can(actor, 'source_cost.edit', { closedPeriod: false }).ok ? 200 : 404;
      got[`${role} cost closed month stale`] = (await call(c, 'PUT', '/lead-source-costs', { leadSourceId: w.sourceId, month: '2025-02', amountCents: 100 })).status;
      const closed = can(actor, 'source_cost.edit', { closedPeriod: true });
      want[`${role} cost closed month stale`] = closed.ok ? 200 : closed.code === 'REAUTH_REQUIRED' ? 401 : 404;
      got[`${role} own goals`] = (await call(c, 'GET', '/goals')).status;
      want[`${role} own goals`] = can(actor, 'goal.view', { own: true }).ok ? 200 : 404;
      got[`${role} goal for agent`] = (await call(c, 'POST', '/goals', { userId: w.agents[1]!.userId, periodKind: 'year', periodStart: `${month.slice(0, 4)}-01-01`, metric: role === 'owner' ? 'closings' : role === 'admin' ? 'touches' : 'appointments_set', target: 3 })).status;
      want[`${role} goal for agent`] = can(actor, 'goal.manage', { team: role === 'team_lead' }).ok ? 201 : 404;
      got[`${role} plan`] = (await call(c, 'GET', '/me/weekly-plans/current')).status;
      want[`${role} plan`] = 200;
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner sources': 200, 'admin sources': 200, 'team_lead sources': 404, 'agent sources': 404, 'owner cost closed month stale': 401, 'admin cost closed month stale': 401, 'team_lead goal for agent': 201, 'agent goal for agent': 404 });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: w.sourceId, month: '2025-02', amountCents: 100 })).status).toBe(200);
  });

  it('R-OWNER-1: core can() never lets the system actor or a support session read the owner view or edit costs', () => {
    const tenantId = w.tenantId as never;
    for (const via of ['timer', 'provider', 'assistant', 'import', 'worker'] as const) {
      for (const a of ['owner_view.view', 'source_cost.edit', 'goal.manage'] as const) expect(can({ kind: 'system', tenantId, via }, a, { closedPeriod: false }).ok).toBe(false);
    }
    for (const a of ['owner_view.view', 'source_cost.edit', 'goal.view', 'goal.manage'] as const) expect(can({ kind: 'support', tenantId, userId: 'u' as never, grantId: 'g' }, a, { own: true, closedPeriod: false }).ok).toBe(false);
    // the closed-month fact fails closed: absent means closed (re-auth required)
    expect(can({ kind: 'user', tenantId, userId: 'u' as never, role: 'owner', sessionId: 's' }, 'source_cost.edit', {})).toEqual({ ok: false, code: 'REAUTH_REQUIRED', reauth: true });
  });
});
