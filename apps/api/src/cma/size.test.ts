// R-MLS-7 at the CMA API (module 71) against real Postgres: MLS records synced under the Spark mapping (no confirmed
// finished-living-area field) are stored without a size, so a CMA neither takes the subject's size from the record nor
// compares any sale by size, and says so in words. Fakes only: the RESO records carry BuildingAreaTotal and LivingArea
// (synthetic values) and reach the database through lane V1-A's real sync with a deterministic record feed; nothing is
// sent and no MLS is called. E641, E642.
import type { TenantId } from '@realty/core/foundation';
import type { ResoLike } from '@realty/core/listings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { syncConnection } from '../mls/sync.js';
import { makeDue, mlsDeps, pagedFeed } from '../mls/testing.js';
import { SPARK_FIELD_MAPPING } from '../providers/integrations/spark.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, codes, contact, daysAgo, localSales, oneTap, saleReso } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;

/** RESO records through V1-A's sync with the Spark field mapping (as a Spark connection's sync reads them). */
async function syncUnderSparkMapping(records: ResoLike[]): Promise<void> {
  await makeDue(h, w.mls);
  const feed = { ...pagedFeed([records]), fields: SPARK_FIELD_MAPPING };
  const r = await syncConnection(mlsDeps(h, { [w.mls]: feed }), w.tenantId as TenantId, w.mls);
  expect(r).toMatchObject({ outcome: 'synced', skippedInvalid: 0, inserted: records.length });
}

/** A sale with every area field a feed may send (synthetic); BuildingAreaTotal larger than LivingArea, as total area is. */
const withAreas = (r: ResoLike): ResoLike => ({ ...r, BuildingAreaTotal: Math.round(Number(r['LivingArea']) * 1.3), AboveGradeFinishedArea: null });

const SEEN_LINE1 = '700 Sample Avenue';

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  const records: ResoLike[] = [];
  for (let i = 0; i < 30; i++) {
    const sqft = 1200 + ((i * 37) % 600);
    const days = 10 + ((i * 29) % 290);
    const price = Math.round(sqft * 35_000);
    records.push(withAreas(saleReso({ sqft, beds: 2 + (i % 3), closeDate: daysAgo(days), contractDate: daysAgo(days + 30), closePriceCents: price, originalListPriceCents: price })));
  }
  // the seller's own earlier sale, and an active listing nearby (the market context)
  records.push(withAreas(saleReso({ line1: '700 Sample Ave', closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 })));
  records.push(withAreas(saleReso({ line1: '702 Sample Ave', status: 'active', sqft: 1550, closePriceCents: null, closeDate: null })));
  await syncUnderSparkMapping(records);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-MLS-7: a CMA over MLS records without a confirmed size field', () => {
  it('E642 R-MLS-7: stored rows have no size and no size source (BuildingAreaTotal and LivingArea unread)', async () => {
    const rows = (await h.su.query<{ n: number; sized: number; sourced: number }>("SELECT count(*)::int AS n, count(sqft)::int AS sized, count(size_source)::int AS sourced FROM listings WHERE tenant_id = $1 AND source = 'mls'", [w.tenantId])).rows[0]!;
    expect(rows).toEqual({ n: 32, sized: 0, sourced: 0 });
  });

  it('E642 R-MLS-7 R-CMA-2: the subject\'s MLS record has no size: the one-tap CMA asks for it, saying the MLS has none, never a size from another field', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'property', line1: SEEN_LINE1 });
    const r = await oneTap(w.agents[0]!, c);
    const err = r.body as unknown as { error: { details: { missing: string[]; sentence: string } } };
    expect([r.status, r.code, err.error.details.missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['sqft']]);
    expect(err.error.details.sentence).toBe('Size not available from the MLS for this home. Enter the size to prepare a CMA.');
  });

  it('E641 R-MLS-7 R-CMA-2 R-CMA-3: with the agent\'s size there is still no value: no sale is compared by size, each says why, the result says so, and no response names BuildingAreaTotal', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'property', line1: SEEN_LINE1 });
    const r = await oneTap(w.agents[0]!, c, { facts: { sqft: 1500 } });
    expect(r.status).toBe(201);
    const v = r.body.cma;
    expect(v.subject.facts['sqft']).toEqual({ value: 1500, source: 'agent' });
    expect(v.subject.sizeSentence).toBe('Size entered by the agent.');
    expect(v.result).toMatchObject({ available: false, reason: 'NO_SALES', valueCents: null, lowCents: null, highCents: null });
    expect(v.result.sentences).toEqual([
      'No value: no closed sales of this kind of home with a size from the MLS were found.',
      '30 closed sales of this kind of home were not used: size not available from the MLS, so no size adjustment or price per sq ft can be worked out for them.',
    ]);
    expect(v.comps).toEqual([]);
    expect(v.notUsed.length).toBe(30);
    for (const n of v.notUsed) expect([n.reason, n.sentence]).toEqual(['no_size', 'Not used: size not available from the MLS.']);
    expect(v.market.rates.filter((x) => x.applied)).toEqual([]);
    expect(JSON.stringify(r.body)).not.toMatch(/BuildingAreaTotal|LivingArea/);
    // the stored CMA carries the same honest result
    const stored = (await h.su.query<{ value_cents: string | null; result: { sentences: string[] } }>('SELECT value_cents, result FROM cma_reports WHERE id = $1', [v.id])).rows[0]!;
    expect(stored.value_cents).toBeNull();
    expect(stored.result.sentences[1]).toMatch(/size not available from the MLS/);
  });
});

describe('E652 R-MLS-7 R-CMA-8: a stored CMA built on a size that is not finished living area', () => {
  let v: CmaWorld;
  beforeAll(async () => {
    v = await cmaWorld(h);
    await localSales(v, 12); // the RESO default size field (LivingArea): a CMA with a value
  }, 180_000);

  it('E652 R-MLS-7 R-CMA-8: a CMA stored with BuildingAreaTotal sizes (before migration 0082) is never shown as finished living area: the view leads with why, readiness blocks it, the stored record is unchanged', async () => {
    const c = await contact(v.agents[0]!);
    await address(h, v.tenantId, c, { kind: 'property', line1: '710 Sample Avenue' });
    const made = await oneTap(v.agents[0]!, c, { facts: { sqft: 1500, propertyType: 'single_family' } });
    expect(made.status).toBe(201);
    const id = made.body.cma.id;
    expect(made.body.cma.result.available).toBe(true);
    expect(codes(made.body)).not.toContain('SIZE_NOT_LIVING_AREA');
    // as a live Spark sync would have stored it before R-MLS-7 (a fixture: the draft's stored sizes named the total area)
    await h.su.query(
      `UPDATE cma_reports SET subject = jsonb_set(subject, '{resolved,sizeSource}', '"BuildingAreaTotal"'),
              result = jsonb_set(result, '{comps}', (SELECT jsonb_agg(jsonb_set(x, '{sale,sizeSource}', '"BuildingAreaTotal"')) FROM jsonb_array_elements(result->'comps') x))
        WHERE id = $1`,
      [id],
    );
    const stored = (await h.su.query<{ result: { sentences: string[] } }>('SELECT result FROM cma_reports WHERE id = $1', [id])).rows[0]!;
    const r = await call<CmaBody>(v.agents[0]!, 'GET', `/cma/${id}`);
    expect(r.status).toBe(200);
    const warn = 'This CMA was prepared from a size that is not finished living area (total, unfinished or below-grade area), so its sizes, size adjustments and price per sq ft do not hold. Prepare a new CMA.';
    expect(r.body.cma.result.sentence).toBe(warn);
    expect(r.body.cma.result.sentences).toEqual([warn, ...stored.result.sentences]);
    expect(r.body.cma.clientShare.ready).toBe(false);
    expect(r.body.cma.clientShare.blockers.find((b) => b.code === 'SIZE_NOT_LIVING_AREA')?.sentence).toBe(warn);
    // the stored record (R-CMA-8) is what it was: the view adds the warning, nothing rewrites it
    expect((await h.su.query<{ result: { sentences: string[] } }>('SELECT result FROM cma_reports WHERE id = $1', [id])).rows[0]!.result.sentences).toEqual(stored.result.sentences);
    // only the subject's size source is enough
    await h.su.query(`UPDATE cma_reports SET result = jsonb_set(result, '{comps}', (SELECT jsonb_agg(jsonb_set(x, '{sale,sizeSource}', '"LivingArea"')) FROM jsonb_array_elements(result->'comps') x)) WHERE id = $1`, [id]);
    expect(codes((await call<CmaBody>(v.agents[0]!, 'GET', `/cma/${id}`)).body)).toContain('SIZE_NOT_LIVING_AREA');
  });
});

