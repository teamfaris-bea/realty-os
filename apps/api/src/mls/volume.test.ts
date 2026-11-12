// RLS volume benchmark for module 24 (PHASE2_3_PLAN §5.4 #24 and §6 exit criterion 6): 500k MLS rows in one
// tenant, under app_user and FORCE RLS. Proves isolation at volume and measures the MLS read paths:
//   - a second tenant sees none of the 500k rows (counts, previews, competing) and the first sees exactly its own;
//   - saved-search previews and the competing endpoint use the 0041 partial indexes and stay fast;
//   - saved-search matching of a 1,000-row MLS delta (two sync runs of SYNC_BATCH) finishes well under 60 s.
//   - D9 (lane V1-A): half the rows are sold history over 24 months (coordinates and subdivisions populated, 2 % leases,
//     5 % unfilled version-1 rows with null close dates), skewed: one postal code with 40,000 sold rows, one city with
//     120,000 and one subdivision with 5,000 (the real mix is VERIFY V2). soldCandidates stays under 1.5 s p95 per tier,
//     skewed areas included, on a 0068_cma_mls_data index with no Seq Scan; below its limit a tier's 12-month count equals the
//     unlimited count; a backfill page of 500 completes inside one sync run's budget.
// Within each postal code prices run from $300k to $800k and beds from 1 to 5. Rows are bulk-inserted by the superuser (a load fixture, not an application path); every measured read and
// the delta sync run as app_user through the module's own functions and routes. Timings are printed; the
// budgets asserted are deliberately loose so a slow CI box does not flake (VERIFY on production hardware).
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, listing, ownedContact } from '../assistant/testing.js';
import { cellsWithin } from '@realty/core/listings';
import { type SoldQuery, type TierQuery, soldCandidates, tierSql } from './comps.js';
import { SYNC_BATCH, syncConnection } from './sync.js';
import { MLS_VOLUME, makeDue, mlsConnection, mlsDeps, mlsVolumeFixture, pagedFeed, reso, soldReso, splitFeed, startBackfill } from './testing.js';

const { ROWS, ZIPS, HOT_ZIP, HOT_LAT, HOT_LON } = MLS_VOLUME;
let h: ApiHarness;
let w: AssistantWorld;
let other: TestClient;
let conn: string;
let otherConn: string;
const searchIds: string[] = [];
let subject: string;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  const r = await fn();
  return [r, performance.now() - t];
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  other = await h.signup();
  conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
  otherConn = await mlsConnection(h, other.tenantId!, other.userId!, { lastSyncedAt: new Date() });
  const t0 = performance.now();
  await mlsVolumeFixture(h, w.tenantId, conn);
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed)
     SELECT $1, gen_random_uuid(), 'mls', 'B' || i, 'active', i || ' Other St', 'City1', 'CA', (94000 + i % ${ZIPS})::text, 40000000, 3, $2, timestamptz '2026-11-01', 'B Brokerage (test)', true
       FROM generate_series(1, 100) i`,
    [other.tenantId, otherConn],
  );
  await h.su.query('ANALYZE listings');
  console.info(`[mls volume] inserted ${ROWS} MLS rows in ${Math.round(performance.now() - t0)} ms`);
  // 20 active searches on postal codes of the generated set
  for (let i = 0; i < 20; i++) {
    const c = await ownedContact(w.agents[0]!);
    const id = randomUUID();
    await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Vol','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, id, c.id, JSON.stringify({ postalCodes: [String(94000 + i)], priceMaxCents: 60_000_000, bedsMin: 2 })]);
    expect((await call(w.agents[0]!, 'POST', `/saved-searches/${id}/approve`, { checked: [] })).status).toBe(200);
    // active without the activation pass (which would alert the whole backlog): the delta below is what is measured
    await h.su.query("UPDATE saved_searches SET status = 'active', activated_at = now() WHERE id = $1", [id]);
    searchIds.push(id);
  }
  subject = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94007', priceCents: 50_000_000, beds: 3 });
}, 900_000);
afterAll(async () => {
  await h?.close();
});

describe('RLS volume benchmark: 500k MLS rows per tenant', () => {
  it('R-TEN-1 at volume: each tenant sees exactly its own MLS rows under app_user', async () => {
    const count = (c: TestClient) => withTenantTx(c.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM listings WHERE source = 'mls'`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(await count(w.agents[0]!)).toBe(ROWS);
    expect(await count(other)).toBe(100);
    const r = await call<{ listings: unknown[] }>(other, 'GET', `/listings/${subject}/competing`);
    expect(r.status).toBe(404);
  }, 120_000);

  it('saved-search previews over 500k rows use the MLS index and stay fast (p95 printed; budget 1.5 s)', async () => {
    const times: number[] = [];
    for (const id of searchIds) {
      const [r, ms] = await timed(() => call<{ search: { matches: { source: string }[] } }>(w.agents[0]!, 'GET', `/saved-searches/${id}/preview`));
      expect(r.status).toBe(200);
      expect(r.body.search.matches.length, JSON.stringify(r.body).slice(0, 600)).toBeGreaterThan(0);
      expect(r.body.search.matches.some((m) => m.source === 'mls')).toBe(true);
      times.push(ms);
    }
    console.info(`[mls volume] preview p95 ${Math.round(p95(times))} ms over ${times.length}`);
    expect(p95(times)).toBeLessThan(1500);
    const plan = await withTenantTx(w.agents[0]!.actor(), async (tx) =>
      (await sql<{ 'QUERY PLAN': string }>`EXPLAIN SELECT l.id FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.status IN ('active','coming_soon')
         AND l.display_allowed AND l.team_listing_id IS NULL AND l.mls_connection_id = ANY (${[conn]}::uuid[]) AND l.postal_code = ANY (${['94001']}::text[])
         ORDER BY l.mls_modified_at DESC, l.id LIMIT 2000`.execute(tx)).rows.map((x) => x['QUERY PLAN']).join('\n'), { db: h.database });
    expect(plan, plan).toMatch(/listings_mls_postal_idx|listings_mls_city_idx|listings_match_idx/);
    expect(plan).not.toMatch(/Seq Scan/);
  }, 300_000);

  it('the competing endpoint over 500k rows stays fast (p95 printed; budget 1.5 s)', async () => {
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const [r, ms] = await timed(() => call<{ listings: unknown[] }>(w.agents[0]!, 'GET', `/listings/${subject}/competing`));
      expect(r.status).toBe(200);
      expect(r.body.listings.length).toBeGreaterThan(0);
      times.push(ms);
    }
    console.info(`[mls volume] competing p95 ${Math.round(p95(times))} ms`);
    expect(p95(times)).toBeLessThan(1500);
  }, 300_000);

  it('saved-search matching of a 1,000-row MLS delta (two sync runs) finishes under 60 s; each new match alerts once', async () => {
    const delta = Array.from({ length: 1000 }, (_, i) =>
      i % 2 === 0
        ? reso(900_000 + i, { ListingId: `V${i + 1}`, PostalCode: String(94000 + ((i + 1) % ZIPS)), ListPrice: 450000, ModificationTimestamp: '2026-11-11T00:00:00Z' }) // updates of existing rows
        : reso(900_000 + i, { ListingId: `N${i}`, PostalCode: String(94000 + (i % 20)), ListPrice: 450000, ModificationTimestamp: '2026-11-11T00:00:00Z' }), // new listings in searched zips
    );
    const feed = pagedFeed([delta]);
    const deps = mlsDeps(h, { [conn]: feed });
    const t0 = performance.now();
    let matched = 0;
    for (let run = 0; run < 2; run++) {
      await makeDue(h, conn);
      const r = await syncConnection(deps, w.tenantId as TenantId, conn);
      expect(r.outcome).toBe('synced');
      matched += r.matched;
    }
    const ms = performance.now() - t0;
    console.info(`[mls volume] 1,000-row delta (batch ${SYNC_BATCH}) synced and matched in ${Math.round(ms)} ms, ${matched} new matches`);
    expect(ms).toBeLessThan(60_000);
    expect(matched).toBeGreaterThan(0);
    const dup = await h.su.query("SELECT search_id, listing_id, count(*) FROM saved_search_matches WHERE tenant_id = $1 GROUP BY 1, 2 HAVING count(*) > 1", [w.tenantId]);
    expect(dup.rowCount).toBe(0);
  }, 300_000);

  // ---- D9 sold data ------------------------------------------------------------------------------------------------
  const subjectQuery = (tiers: TierQuery[], months = 24): SoldQuery => ({ connectionIds: [conn], propertyType: 'single_family', since: months === 24 ? '2024-11-01' : '2025-11-01', until: '2026-11-01', tiers });
  const HOT_CELLS_1 = cellsWithin(HOT_LAT + 15_000, HOT_LON - 15_000, 1);
  const HOT_CELLS_3 = cellsWithin(HOT_LAT + 15_000, HOT_LON - 15_000, 3);
  const TIERS: [string, TierQuery][] = [
    ['subdivision (5,000 sold, skewed)', { tier: 'subdivision', names: ['big subdivision'], postalCodes: [HOT_ZIP], cells: HOT_CELLS_3 }],
    ['1-mi cells (hot area)', { tier: 'cells_1mi', cells: HOT_CELLS_1 }],
    ['postal code (40,000 sold, skewed)', { tier: 'postal_code', postalCodes: [HOT_ZIP] }],
    ['3-mi cells (hot area)', { tier: 'cells_3mi', cells: HOT_CELLS_3 }],
    ['city (120,000 sold, skewed)', { tier: 'city', cities: ['big city'], region: 'CA' }],
    ['rate pool (hot area)', { tier: 'rate_pool', cells: HOT_CELLS_3, postalCodes: [HOT_ZIP] }],
    ['postal code (typical)', { tier: 'postal_code', postalCodes: ['94007'] }],
  ];

  it('R-CMA-2 (D9): soldCandidates p95 < 1.5 s per tier over 500k rows, skewed areas included; each tier plan uses a 0068_cma_mls_data index with no Seq Scan', async () => {
    for (const [name, tier] of TIERS) {
      const times: number[] = [];
      let rows = 0;
      for (let i = 0; i < 10; i++) {
        const [r, ms] = await timed(() => withTenantTx(w.agents[0]!.actor(), (tx) => soldCandidates(tx, subjectQuery([tier])), { db: h.database }));
        rows = r.reads[0]!.rows;
        expect(r.rows.every((x) => x.close_date !== null && x.status === 'sold' && !x.is_lease)).toBe(true);
        times.push(ms);
      }
      console.info(`[mls volume] soldCandidates ${name}: ${rows} rows, p95 ${Math.round(p95(times))} ms`);
      expect(rows, name).toBeGreaterThan(0);
      expect(p95(times), name).toBeLessThan(1500);
      if (tier.tier === 'rate_pool') continue;
      const plan = await withTenantTx(w.agents[0]!.actor(), async (tx) => {
        const s = (await tierSql(tx, subjectQuery([tier]), tier))!;
        return (await sql<{ 'QUERY PLAN': string }>`EXPLAIN ${s}`.execute(tx)).rows.map((x) => x['QUERY PLAN']).join('\n');
      }, { db: h.database });
      expect(plan, `${name}\n${plan}`).toMatch(/listings_mls_sold_(postal|subdivision|cell|city)_idx/);
      expect(plan, `${name}\n${plan}`).not.toMatch(/Seq Scan/);
    }
  }, 600_000);

  it('R-CMA-2 (D9): below its limit, a tier\'s 12-month count equals the unlimited count', async () => {
    const tier: TierQuery = { tier: 'postal_code', postalCodes: ['94007'] };
    const r = await withTenantTx(w.agents[0]!.actor(), (tx) => soldCandidates(tx, subjectQuery([tier], 12)), { db: h.database });
    const all = Number((await h.su.query("SELECT count(*) FROM listings WHERE tenant_id = $1 AND source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date BETWEEN '2025-11-01' AND '2026-11-01' AND postal_code = '94007' AND property_type = 'single_family'", [w.tenantId])).rows[0].count);
    expect(all).toBeGreaterThan(50);
    expect(r.reads[0]).toEqual({ tier: 'postal_code', rows: all, limitReached: false });
    // and the other tenant reads none of it
    const o = await withTenantTx(other.actor(), (tx) => soldCandidates(tx, subjectQuery(TIERS.map((t) => t[1]))), { db: h.database });
    expect(o.rows).toEqual([]);
  }, 120_000);

  it('E372 (D9): a backfill page of 500 version-1 rows completes inside one sync run\'s budget (60 s)', async () => {
    // the unfilled rows are j % 20 = 1: S1, S21, S41, …, modified at 2026-11-01 + j seconds
    const page = Array.from({ length: SYNC_BATCH }, (_, k) => {
      const j = 1 + 20 * k;
      return soldReso(j, { ListingId: `S${j}`, PostalCode: j <= 40000 ? HOT_ZIP : String(94000 + (j % ZIPS)), ModificationTimestamp: new Date(Date.UTC(2026, 10, 1) + j * 1000).toISOString() });
    });
    await startBackfill(h, conn);
    await makeDue(h, conn);
    const t0 = performance.now();
    const r = await syncConnection(mlsDeps(h, { [conn]: splitFeed({ backfill: [{ records: page, more: true }] }) }), w.tenantId as TenantId, conn);
    const ms = performance.now() - t0;
    console.info(`[mls volume] backfill page of ${SYNC_BATCH} filled ${r.filled} rows in ${Math.round(ms)} ms`);
    expect(r).toMatchObject({ outcome: 'synced', filled: SYNC_BATCH, inserted: 0, matched: 0 });
    expect(ms).toBeLessThan(60_000);
  }, 300_000);
});
