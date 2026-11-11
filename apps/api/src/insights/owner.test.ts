// The owner view through the real server (module 33; DATA_MODEL R-OWNER-1…5; E107–E109).
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { type InsightsWorld, ago, call, deal, freshReauth, history, insightsWorld, leadSource, staleReauth, ym } from './testing.js';

let h: ApiHarness;
let w: InsightsWorld;
let zillow: string;
let referral: string;
let empty: string;
let month: string;

interface Sources {
  method: string;
  closedInPeriod: number;
  rows: { leadSourceId: string; leadSourceName: string; closings: number; dealsWithCommission: number; missingCommission: number; commissionCents: number; commissionWords: string; costCents: number; costRows: number; costWords: string; costPerClosingCents: number | null; costPerClosingWords: string }[];
  excluded: { missingCommission: { count: number; deals: { dealId: string; name: string }[] }; noSource: { count: number; deals: { dealId: string }[] } };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h);
  zillow = await leadSource(h, w.tenantId, 'Zillow');
  referral = await leadSource(h, w.tenantId, 'Referral');
  empty = await leadSource(h, w.tenantId, 'Billboard');
  const closed = ago(0.1);
  month = ym(closed, w.zone);
  const [a0, a1] = w.agents as [typeof w.owner, typeof w.owner];
  await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: closed, sourceId: zillow, commissionCents: 1_000_000, name: 'Ortiz purchase' });
  await deal(h, w.tenantId, { owner: a1, stage: 'closed', closedAt: closed, sourceId: zillow, commissionCents: 500_050, name: 'Park purchase' });
  await deal(h, w.tenantId, { owner: a1, stage: 'closed', closedAt: closed, sourceId: zillow, name: 'Lee purchase' }); // E107: no financials row
  await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: closed, sourceId: referral, commissionCents: null, name: 'Diaz sale' }); // E107: null amount
  await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: closed, sourceId: null, commissionCents: 300_000, name: 'Walk-in sale' }); // no source
  await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: ago(400), sourceId: zillow, commissionCents: 9_999_999, name: 'Old deal' }); // outside the period
  // costs: Zillow 3 closings; Billboard cost with 0 closings (E108)
  await freshReauth(h, w.owner);
  for (const [src, cents] of [[zillow, 90_000], [empty, 25_000]] as const) {
    const r = await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: src, month, amountCents: cents });
    if (r.status !== 200) throw new Error(`cost: ${r.status} ${JSON.stringify(r.body)}`);
  }
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const get = async <T>(url: string, c = w.owner) => {
  const r = await call<T>(c, 'GET', url);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};

describe('R-OWNER-2 dollars by source', () => {
  it('R-OWNER-2 R-OWNER-1: commission of deals closed in the period by the deal’s source, each row with its denominators and the section’s method', async () => {
    const s = await get<Sources>(`/owner/sources?from=${month}&to=${month}`);
    expect(s.closedInPeriod).toBe(5);
    expect(s.method).toMatch(/closed in the period/);
    const z = s.rows.find((r) => r.leadSourceId === zillow)!;
    expect(z).toMatchObject({ leadSourceName: 'Zillow', closings: 3, dealsWithCommission: 2, missingCommission: 1, commissionCents: 1_500_050, costCents: 90_000, costRows: 1, costPerClosingCents: 30_000 });
    expect(z.commissionWords).toBe('$15,000.50 from 2 of 3 closings with a commission entered');
    expect(z.costPerClosingWords).toBe('$300.00 per closing (3 closings)');
    expect(z.costWords).toBe('$900.00 over 1 monthly entry');
  });

  it('E107: a closed deal without commission is left out of the dollars, counted and listed as missing commission (no financials row, or a null amount)', async () => {
    const s = await get<Sources>(`/owner/sources?from=${month}&to=${month}`);
    expect(s.excluded.missingCommission.count).toBe(2);
    expect(s.excluded.missingCommission.deals.map((d) => d.name).sort()).toEqual(['Diaz sale', 'Lee purchase']);
    const ref = s.rows.find((r) => r.leadSourceId === referral)!;
    expect(ref).toMatchObject({ closings: 1, dealsWithCommission: 0, missingCommission: 1, commissionCents: 0 });
    expect(s.excluded.noSource.count).toBe(1);
  });

  it('E108: a source with a cost and zero closings says "— (0 closings)", never $0 or ∞; a source with closings and no cost says no cost was entered', async () => {
    const s = await get<Sources>(`/owner/sources?from=${month}&to=${month}`);
    const b = s.rows.find((r) => r.leadSourceId === empty)!;
    expect(b).toMatchObject({ closings: 0, costCents: 25_000, costPerClosingCents: null, costPerClosingWords: '— (0 closings)' });
    expect(JSON.stringify(b)).not.toMatch(/Infinity|∞|NaN/);
    const ref = s.rows.find((r) => r.leadSourceId === referral)!;
    expect(ref.costPerClosingCents).toBeNull();
    expect(ref.costPerClosingWords).toBe('— (no cost entered; 1 closing)');
  });

  it('R-OWNER-2: a period outside the closings has no rows; a reversed or over-long period is refused', async () => {
    const s = await get<Sources>(`/owner/sources?from=2001-01&to=2001-02`);
    expect(s).toMatchObject({ closedInPeriod: 0, rows: [] });
    expect((await call(w.owner, 'GET', `/owner/sources?from=2026-05&to=2026-01`)).status).toBe(422);
    expect((await call(w.owner, 'GET', `/owner/sources?from=2020-01&to=2026-01`)).status).toBe(422);
  });
});

describe('R-OWNER-3 velocity and forecast', () => {
  it('R-OWNER-3: velocity is app.stage_dwell_norms() medians with n; stages with fewer than 5 moves are left out and listed', async () => {
    const [a0] = w.agents as [typeof w.owner];
    // 6 prospects that moved on after 10 days → prospect median 10, n=6; one active that moved on (n=1)
    for (let i = 0; i < 6; i++) {
      const d = await deal(h, w.tenantId, { owner: a0, stage: 'prospect', enteredAt: ago(30 + i) });
      await history(h, w.tenantId, d, 'agreement_signed', ago(20 + i));
    }
    const act = await deal(h, w.tenantId, { owner: a0, stage: 'active', enteredAt: ago(15) });
    await history(h, w.tenantId, act, 'under_contract', ago(5));
    const v = await get<{ method: string; rows: { stage: string; medianDays: number; sampleSize: number; words: string }[]; excluded: { thinStages: { stage: string; sampleSize: number }[] } }>('/owner/velocity');
    expect(v.method).toMatch(/Median days/);
    expect(v.rows).toEqual([{ stage: 'prospect', medianDays: 10, sampleSize: 6, words: 'median 10 days (n=6)' }]);
    expect(v.excluded.thinStages).toEqual(expect.arrayContaining([{ stage: 'active', sampleSize: 1 }]));
    expect(v.excluded.thinStages.map((t) => t.stage)).not.toContain('prospect');
  });

  it('E109 R-OWNER-3: stages with fewer than 10 entries in the last year are left out and counted; the range uses k of n per counted stage with an 80% Wilson interval', async () => {
    const h2 = await createApiHarness();
    try {
      const w2 = await insightsWorld(h2);
      const [a] = w2.agents as [typeof w2.owner];
      // under_contract: 10 entries 100–200 days ago, 8 closed within 90 days → share 0.8
      for (let i = 0; i < 10; i++) {
        const d = await deal(h2, w2.tenantId, { owner: a, stage: 'under_contract', enteredAt: ago(100 + i * 10) });
        if (i < 8) await history(h2, w2.tenantId, d, 'closed', ago(100 + i * 10 - 30));
      }
      // active: only 3 entries → thin
      for (let i = 0; i < 3; i++) await deal(h2, w2.tenantId, { owner: a, stage: 'active', enteredAt: ago(120 + i) });
      // open now: 2 under_contract (with commission 1,000,000 and none) + 1 prospect (thin: no history)
      await deal(h2, w2.tenantId, { owner: a, stage: 'under_contract', enteredAt: ago(1), commissionCents: 1_000_000 });
      await deal(h2, w2.tenantId, { owner: a, stage: 'under_contract', enteredAt: ago(2) });
      await deal(h2, w2.tenantId, { owner: a, stage: 'prospect', enteredAt: ago(1) });
      const f = (await call<{ openDeals: number; closings: Record<string, unknown> & { samples: { stage: string; n: number; k: number }[]; excluded: { thinStages: string[]; thinStageDeals: number } }; commission: Record<string, unknown> }>(w2.owner, 'GET', '/owner/forecast')).body;
      // the 10 old under_contract deals are still open too (stage under_contract), so they are forecast as well
      const uc = f.closings.samples.find((s) => s.stage === 'under_contract')!;
      expect(uc).toEqual({ stage: 'under_contract', n: 10, k: 8 });
      expect(f.closings.excluded.thinStages).toEqual(expect.arrayContaining(['prospect', 'agreement_signed', 'active']));
      expect(f.closings.excluded.thinStageDeals).toBe(4); // 3 active + 1 prospect
      expect(f.closings).toMatchObject({ unit: 'closings', horizonDays: 90, countedDeals: 12, notEnoughHistory: false });
      expect(f.closings.expected as number).toBeCloseTo(12 * 0.8, 6);
      expect(f.closings.low as number).toBeLessThan(f.closings.expected as number);
      expect(f.closings.high as number).toBeGreaterThan(f.closings.expected as number);
      expect(f.closings.method as string).toMatch(/not enough history/);
      // commission: only the one open deal with a commission counts; 11 counted-stage deals have none
      expect(f.commission).toMatchObject({ unit: 'commission_cents', countedDeals: 1, expected: 800_000 });
      expect((f.commission.excluded as { noCommission: number }).noCommission).toBe(11);
      expect(JSON.stringify(f)).not.toMatch(/confidence|probabilit/i);
    } finally {
      await h2.close();
    }
  });
});

describe('R-OWNER-1 R-PERM-5 who may read the owner view', () => {
  it('R-OWNER-1: Owner and Admin read it; a Team Lead, an agent, an ISA and a TC get 404 on every owner-view route', async () => {
    for (const url of ['/owner/sources', '/owner/velocity', '/owner/forecast', `/lead-source-costs?from=${month}&to=${month}`]) {
      expect((await call(w.admin, 'GET', url)).status, `admin ${url}`).toBe(200);
      for (const c of [w.teamLead, w.agents[0]!, w.isa, w.tc]) expect((await call(c, 'GET', url)).status, `${c.role} ${url}`).toBe(404);
    }
    await freshReauth(h, w.teamLead);
    expect((await call(w.teamLead, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month, amountCents: 1 })).status).toBe(404);
  });

  it('R-OWNER-1: the system actor reads closed deals from v_owner_source_dollars but never a commission, and no manual cost row', async () => {
    const r = await withTenantTx(systemActor(w.tenantId as TenantId, 'worker'), async (tx) => ({
      view: (await sql<{ gross_commission_cents: string | null; commission_status: string | null }>`SELECT gross_commission_cents, commission_status FROM v_owner_source_dollars`.execute(tx)).rows,
      fin: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM deal_financials`.execute(tx)).rows[0]!.n,
      costs: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM lead_source_costs WHERE origin = 'manual'`.execute(tx)).rows[0]!.n,
    }), { db: h.database });
    expect(r.view.length).toBeGreaterThanOrEqual(6);
    expect(r.view.every((x) => x.gross_commission_cents === null && x.commission_status === null)).toBe(true);
    expect(r.fin).toBe(0);
    expect(r.costs).toBe(0);
  });
});

describe('R-OWNER-5 source costs', () => {
  it('R-OWNER-5: the open month is written without re-auth as the person themselves; the change is audited with before and after', async () => {
    await staleReauth(h, w.admin);
    const r = await call<{ cost: { previousCents: number | null; amountCents: number; closedMonth: boolean } }>(w.admin, 'PUT', '/lead-source-costs', { leadSourceId: referral, month, amountCents: 12_345, note: 'flyers' });
    expect(r.status).toBe(200);
    expect(r.body.cost).toMatchObject({ previousCents: null, amountCents: 12_345, closedMonth: false });
    const row = (await h.su.query(`SELECT entered_by_user_id, origin FROM lead_source_costs WHERE tenant_id = $1 AND lead_source_id = $2`, [w.tenantId, referral])).rows[0];
    expect(row).toEqual({ entered_by_user_id: w.admin.userId, origin: 'manual' });
    const again = await call<{ cost: { previousCents: number | null } }>(w.admin, 'PUT', '/lead-source-costs', { leadSourceId: referral, month, amountCents: 20_000 });
    expect(again.body.cost.previousCents).toBe(12_345);
    const a = (await h.su.query(`SELECT actor_user_id, changes, reason FROM audit_log WHERE tenant_id = $1 AND action = 'source_cost.changed' AND actor_user_id = $2 ORDER BY occurred_at`, [w.tenantId, w.admin.userId])).rows;
    expect(a).toHaveLength(2);
    expect(a[1].changes).toMatchObject({ before_cents: { to: 12345 }, after_cents: { to: 20000 } });
    expect(a[1].reason).toBe('OPEN_MONTH');
  });

  it('R-OWNER-5 R-PERM-13: a closed month needs a fresh re-auth (401 REAUTH_REQUIRED, nothing written), then succeeds; a future month is refused', async () => {
    const closed = '2025-01';
    await staleReauth(h, w.owner);
    const r = await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month: closed, amountCents: 5_000 });
    expect([r.status, r.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await h.su.query(`SELECT 1 FROM lead_source_costs WHERE tenant_id = $1 AND month = '2025-01-01'`, [w.tenantId])).rowCount).toBe(0);
    await freshReauth(h, w.owner);
    const ok = await call<{ cost: { closedMonth: boolean } }>(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month: closed, amountCents: 5_000 });
    expect(ok.status).toBe(200);
    expect(ok.body.cost.closedMonth).toBe(true);
    const a = (await h.su.query(`SELECT reason FROM audit_log WHERE tenant_id = $1 AND action = 'source_cost.changed' AND reason = 'CLOSED_MONTH'`, [w.tenantId])).rowCount;
    expect(a).toBe(1);
    const fut = await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month: '2999-01', amountCents: 1 });
    expect([fut.status, fut.code]).toEqual([422, 'COST_MONTH_IN_FUTURE']);
  });

  it('R-OWNER-5: the cost list shows both origins to Owner/Admin; an unknown source is 404; a tenant id in the body is refused', async () => {
    await h.su.query(`INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin) VALUES ($1, gen_random_uuid(), $2, $3, 777, 'ads_sync')`, [w.tenantId, zillow, `${month}-01`]);
    const l = await get<{ costs: { origin: string; amountCents: number; leadSourceId: string }[] }>(`/lead-source-costs?from=${month}&to=${month}`);
    expect(l.costs.filter((c) => c.leadSourceId === zillow).map((c) => c.origin).sort()).toEqual(['ads_sync', 'manual']);
    const s = await get<Sources>(`/owner/sources?from=${month}&to=${month}`);
    expect(s.rows.find((r) => r.leadSourceId === zillow)).toMatchObject({ costCents: 90_777, costRows: 2 });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: '01900000-0000-7000-8000-000000000001', month, amountCents: 1 })).status).toBe(404);
    expect((await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month, amountCents: 1, tenantId: w.tenantId })).status).toBe(422);
  });
});
