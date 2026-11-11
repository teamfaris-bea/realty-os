// Adversarial tests of api/insights (critical module: money visibility). Each case is an attack an insider, another
// tenant or a compromised worker could try, and the layer that refuses it (route matrix, RLS, the re-check in the
// write transaction).
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { type InsightsWorld, ago, call, deal, freshReauth, insightsWorld, leadSource, runWeeklyPlan, staleReauth, thisMonday, ym } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let other: InsightsWorld;
let a0: TestClient;
let a1: TestClient;
let month: string;
let src: string;

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  other = await insightsWorld(h);
  [a0, a1] = w.agents as [TestClient, TestClient];
  month = ym(new Date(), w.zone);
  src = await leadSource(h, w.tenantId, 'Zillow');
  await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: ago(0.05), sourceId: src, commissionCents: 1_234_500, name: 'Secret commission deal' });
  await deal(h, w.tenantId, { owner: a1, stage: 'under_contract', enteredAt: ago(3), commissionCents: 777_700 });
  await freshReauth(h, w.owner);
  await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: src, month, amountCents: 55_500 });
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('money visibility (R-OWNER-1, R-OWNER-5, R-PERM-10)', () => {
  it('R-OWNER-5: the system actor, whatever its via, can neither read nor write a manual cost, nor read any commission', async () => {
    for (const via of ['timer', 'worker', 'provider', 'assistant', 'import'] as const) {
      const r = await withTenantTx(systemActor(w.tenantId as TenantId, via), async (tx) => ({
        manual: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM lead_source_costs WHERE origin = 'manual'`.execute(tx)).rows[0]!.n,
        fin: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM deal_financials`.execute(tx)).rows[0]!.n,
        viewMoney: (await sql<{ n: number }>`SELECT count(gross_commission_cents)::int AS n FROM v_owner_source_dollars`.execute(tx)).rows[0]!.n,
      }), { db: h.database });
      expect(r, via).toEqual({ manual: 0, fin: 0, viewMoney: 0 });
      const write = withTenantTx(systemActor(w.tenantId as TenantId, via), (tx) =>
        sql`INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin, entered_by_user_id) VALUES (app.tenant_id(), gen_random_uuid(), ${src}, ${`${month}-01`}::date, 1, 'manual', ${w.owner.userId})`.execute(tx), { db: h.database });
      await expect(write, via).rejects.toThrow(/row-level security|duplicate key/);
      const upd = await withTenantTx(systemActor(w.tenantId as TenantId, via), (tx) => sql`UPDATE lead_source_costs SET amount_cents = 0 WHERE origin = 'manual'`.execute(tx), { db: h.database });
      expect(Number(upd.numAffectedRows), via).toBe(0);
    }
    expect((await h.su.query(`SELECT amount_cents::int AS c FROM lead_source_costs WHERE tenant_id = $1 AND origin = 'manual'`, [w.tenantId])).rows).toEqual([{ c: 55_500 }]);
  });

  it('R-OWNER-1: the weekly plan job runs as the system actor and puts no money in any plan or card', async () => {
    await runWeeklyPlan(h, w.tenantId, thisMonday(w.zone));
    const rows = (await h.su.query(`SELECT payload::text AS p FROM assistant_actions WHERE tenant_id = $1 AND kind = 'weekly_plan'`, [w.tenantId])).rows;
    const cards = (await h.su.query(`SELECT reasons::text AS r FROM priority_feed_items WHERE tenant_id = $1 AND item_type = 'weekly_plan'`, [w.tenantId])).rows;
    expect(rows.length).toBeGreaterThan(0);
    for (const t of [...rows.map((r) => r.p), ...cards.map((c) => c.r)]) expect(t).not.toMatch(/1234500|777700|55500|\$|cents|commission/i);
  });

  it('R-PERM-10: a Team Lead may read their team’s commission rows directly, yet every owner-view route is 404 for them; an agent reading the view directly sees only their own deals’ money', async () => {
    const tlFin = await withTenantTx({ kind: 'user', userId: w.teamLead.userId!, tenantId: w.tenantId as TenantId, role: 'team_lead', sessionId: 'x' }, (tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM deal_financials`.execute(tx), { db: h.database });
    expect(tlFin.rows[0]!.n).toBe(2);
    for (const url of ['/owner/sources', '/owner/forecast', '/owner/velocity', '/lead-source-costs']) expect((await call(w.teamLead, 'GET', url)).status).toBe(404);
    const mine = await withTenantTx({ kind: 'user', userId: a1.userId!, tenantId: w.tenantId as TenantId, role: 'agent', sessionId: 'x' }, (tx) => sql<{ c: string | null }>`SELECT gross_commission_cents AS c FROM v_owner_source_dollars`.execute(tx), { db: h.database });
    expect(mine.rows.every((r) => r.c === null)).toBe(true); // a1's only deal is open; a0's closed deal shows no money (or is invisible)
  });

  it('R-PERM-5: a 404 for the owner view looks exactly like a route that does not exist (no existence oracle)', async () => {
    const r = await call(a0, 'GET', '/owner/sources');
    const nope = await call(a0, 'GET', '/owner/nothing-here');
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    expect(nope.status).toBe(404);
  });
});

describe('tenancy (R-TEN-3)', () => {
  it('R-TEN-3: another tenant’s Owner sees none of this tenant’s closings, costs or sources, and cannot write a cost against this tenant’s source', async () => {
    const s = await call<{ closedInPeriod: number; rows: unknown[] }>(other.owner, 'GET', `/owner/sources?from=${month}&to=${month}`);
    expect(s.body).toMatchObject({ closedInPeriod: 0, rows: [] });
    const c = await call<{ sources: { id: string }[]; costs: unknown[] }>(other.owner, 'GET', `/lead-source-costs?from=${month}&to=${month}`);
    expect(c.body.sources.map((x) => x.id)).not.toContain(src);
    expect(c.body.costs).toEqual([]);
    expect(JSON.stringify(s.body) + JSON.stringify(c.body)).not.toMatch(/Secret commission deal|Zillow/);
    await freshReauth(h, other.owner);
    expect((await call(other.owner, 'PUT', '/lead-source-costs', { leadSourceId: src, month, amountCents: 1 })).status).toBe(404);
    const f = await call<{ openDeals: number }>(other.owner, 'GET', '/owner/forecast');
    expect(f.body.openDeals).toBe(0);
  });

  it('R-TEN-3: a tenant id smuggled into a cost write or a goal is refused by the strict schemas', async () => {
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: src, month, amountCents: 1, tenantId: other.tenantId })).status).toBe(422);
    expect((await call(w.owner, 'POST', '/goals', { userId: a0.userId, periodKind: 'year', periodStart: `${month.slice(0, 4)}-01-01`, metric: 'touches', target: 1, tenant_id: other.tenantId })).status).toBe(422);
  });
});

describe('re-auth for closed months (R-PERM-13)', () => {
  it('R-PERM-13: a stale session cannot edit a closed month by any spelling of the month; the refused write leaves no row and no audit entry', async () => {
    await staleReauth(h, w.admin);
    for (const m of ['2025-12', '2024-01']) expect((await call(w.admin, 'PUT', '/lead-source-costs', { leadSourceId: src, month: m, amountCents: 1 })).status).toBe(401);
    for (const m of ['2025-1', '2025-12-01', ' 2025-12', '2025-13']) expect((await call(w.admin, 'PUT', '/lead-source-costs', { leadSourceId: src, month: m, amountCents: 1 })).status).toBe(422);
    expect((await h.su.query(`SELECT 1 FROM lead_source_costs WHERE tenant_id = $1 AND month < date_trunc('month', now())`, [w.tenantId])).rowCount).toBe(0);
    expect((await h.su.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'source_cost.changed' AND actor_user_id = $2`, [w.tenantId, w.admin.userId])).rowCount).toBe(0);
  });
});

describe('the weekly plan cannot be steered by another member', () => {
  it('R-PLAN-3: a member cannot accept an item index their own plan does not show, nor someone else’s plan; a malformed week is refused', async () => {
    const wk = (await call<{ week: string }>(a0, 'GET', '/me/weekly-plans/current')).body.week;
    expect((await call(a1, 'POST', `/me/weekly-plans/${wk}/accept`, { itemIndexes: [0] })).status).toBe(404);
    expect((await call(a0, 'POST', `/me/weekly-plans/${wk}/accept`, { itemIndexes: [7] })).status).toBe(422);
    expect((await call(a0, 'GET', `/me/weekly-plans/2026-W46;DROP`)).status).toBe(422);
  });
});
