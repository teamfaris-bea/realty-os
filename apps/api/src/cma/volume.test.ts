// Volume check for module 71 (PHASE2_3_PLAN §6, owner budget "POST /cma p95 < 2 s", VERIFY budget): 500k MLS rows in one
// tenant, skewed so the subject's postal code and map cell hold a large share (every tier reaches its limit), under
// app_user and FORCE RLS, through the real route. Lane V1-A owns the 500k skewed fixture and the soldCandidates index plan;
// until it merges this runs the interim reads (apps/api/src/cma/interim) on a fixture of the same size. Rows are bulk-
// inserted by the superuser (a load fixture, not an application path; the table owner passes the 0061 valuation guard).
// The budget is asserted loosely enough for a shared CI box; timings are printed. VERIFY on production hardware.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CmaWorld, address, call, cmaWorld, contact, daysAgo, mlsSale } from './testing.js';

const ROWS = 500_000;
let h: ApiHarness;
let w: CmaWorld;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  const t0 = performance.now();
  // 40 % in the subject's postal code (94110) and around its point; the rest over 400 other postal codes; 70 % sold
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                           property_type, attributes, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, last_seen_in_feed_at,
                           close_price_cents, close_date, purchase_contract_date, sale_conditions, days_on_market, latitude_e6, longitude_e6, subdivision_name,
                           size_source, is_lease, avm_display_allowed, address_key)
     SELECT $1, gen_random_uuid(), 'mls', 'V' || i, CASE WHEN i % 10 < 7 THEN 'sold' WHEN i % 10 < 9 THEN 'active' ELSE 'pending' END,
            (i % 9000 + 1) || ' Volume St', CASE WHEN i % 5 < 2 THEN 'Oakland' ELSE 'City' || (i % 400) END, 'CA',
            CASE WHEN i % 5 < 2 THEN '94110' ELSE (95000 + i % 400)::text END, 50000000, 1 + i % 5, 20, 1100 + i % 900, 'single_family',
            '{"mls":{"address_display":true,"photo_urls":[]}}'::jsonb, $2, timestamptz '2026-11-01' + (i || ' seconds')::interval, 'Volume Brokerage (test)', true, now(),
            CASE WHEN i % 10 < 7 THEN 30000000 + (i % 1000) * 40000 END, CASE WHEN i % 10 < 7 THEN current_date - (i % 900) END,
            CASE WHEN i % 10 < 7 THEN current_date - (i % 900) - 30 END, '{}', 20 + i % 60,
            37750000 + ((i::bigint * 7919) % 60000)::int - 30000, -122420000 + ((i::bigint * 104729) % 60000)::int - 30000,
            CASE WHEN i % 3 = 0 THEN 'Sample Heights' ELSE 'Other Park ' || (i % 50) END, 'LivingArea', false, true,
            (i % 9000 + 1) || ' volume st|' || CASE WHEN i % 5 < 2 THEN '94110' ELSE (95000 + i % 400)::text END || '|CA'
       FROM generate_series(1, ${ROWS}) i`,
    [w.tenantId, w.mls],
  );
  await h.su.query('ANALYZE listings');
  console.info(`[cma volume] inserted ${ROWS} MLS rows in ${Math.round(performance.now() - t0)} ms`);
}, 900_000);
afterAll(async () => {
  await h?.close();
});

describe('POST /cma at volume (VERIFY budget)', () => {
  it('POST /cma and the one-tap CMA stay under p95 2 s on 500k skewed rows; every tier reads its own most recent sales up to its limit (F6)', async () => {
    const times: number[] = [];
    type Body = { cma: { area: { tiers: { tier: string; ran: boolean; limitReached: boolean }[] }; comps: unknown[] } };
    let last: Body | null = null;
    for (let i = 0; i < 8; i++) {
      const c = await contact(w.agents[0]!);
      const line1 = `${50 + i} Sample Avenue`;
      await address(h, w.tenantId, c, { line1 });
      await mlsSale(w, { line1, closeDate: daysAgo(3000), latE6: 37_750_000, lonE6: -122_420_000 });
      const t = performance.now();
      const r = await call<Body>(w.agents[0]!, 'POST', `/contacts/${c}/cma`);
      times.push(performance.now() - t);
      expect(r.status).toBe(201);
      last = r.body;
    }
    const t2 = performance.now();
    const e = await call(w.agents[0]!, 'POST', '/cma', { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110', city: 'Oakland' }, facts: { propertyType: 'single_family', sqft: 1500 } }, purpose: 'listing_price' });
    times.push(performance.now() - t2);
    expect(e.status).toBe(201);
    console.info(`[cma volume] POST /cma p95 ${Math.round(p95(times))} ms over ${times.length} runs (${times.map((x) => Math.round(x)).join(', ')})`);
    expect(last!.cma.comps.length).toBeGreaterThanOrEqual(3);
    for (const t of last!.cma.area.tiers) expect([t.tier, t.ran, t.limitReached]).toEqual([t.tier, true, true]);
    expect(p95(times)).toBeLessThan(2000);
  }, 300_000);
});
