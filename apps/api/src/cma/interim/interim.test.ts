// Tests of the interim stand-ins (deleted with ./interim at the V1-A / V1-B merge; those lanes own the real tests and the
// mutation testing). They pin the contracts module 71 relies on: the address key (R-CMA-1, E365), the geo cell parity with
// listings.geo_cell (0061), the pack's valuation section (strictest defaults), and the engine's determinism and value rules
// (R-CMA-2..5).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { addressKey, geoCell, uspsState } from './address.js';
import { STRICTEST_VALUATION_USE, soldFieldsAllowed, valuationUse } from './pack.js';
import { CMA_DEFAULTS, type CmaCandidate, type CmaSubject, prepareCma } from './valuation.js';

describe('addressKey (R-CMA-1, E365)', () => {
  it('E365: differently spelled addresses give one key; the state folds to its USPS code; the ZIP is cut to five digits', () => {
    const a = addressKey({ line1: '640 Sample Ave.', line2: 'Apt 2', city: 'Oakland', region: 'California', postalCode: '94110-1234' });
    const b = addressKey({ line1: '640 SAMPLE AVENUE', line2: 'Unit 2', city: 'OAKLAND', region: 'CA', postalCode: '94110' });
    const c = addressKey({ line1: '640 Sample Avenue #2', city: null, region: 'ca', postalCode: '94110' });
    expect(a).toBe('640 sample ave #2|94110|CA');
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(addressKey({ line1: '640 Sample Ave', city: 'Oakland', region: 'CA', postalCode: '94110' })).toBe('640 sample ave|94110|CA');
  });

  it('a missing street, ZIP or state gives no key', () => {
    expect(addressKey({ line1: null, city: 'Oakland', region: 'CA', postalCode: '94110' })).toBeNull();
    expect(addressKey({ line1: '1 Main St', city: 'Oakland', region: 'Atlantis', postalCode: '94110' })).toBeNull();
    expect(addressKey({ line1: '1 Main St', city: 'Oakland', region: 'CA', postalCode: '941' })).toBeNull();
    expect(uspsState('south carolina')).toBe('SC');
  });
});

describe('geoCell parity with listings.geo_cell (0061)', () => {
  let db: TestDb;
  let su: pg.Client;
  beforeAll(async () => {
    db = await createTestDb();
    su = new pg.Client({ connectionString: db.ownerUrl });
    await su.connect();
  }, 120_000);
  afterAll(async () => {
    await su?.end();
    await db?.drop();
  });

  it('geoCell equals the generated column\'s own expression on negatives, 0, the poles and the antimeridian', async () => {
    const expr = (await su.query<{ e: string }>("SELECT pg_get_expr(d.adbin, d.adrelid) AS e FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = 'public.listings'::regclass AND a.attname = 'geo_cell'")).rows[0]!.e;
    const pts: [number, number][] = [[0, 0], [-1, -1], [1, 1], [90_000_000, 180_000_000], [-90_000_000, -180_000_000], [37_750_000, -122_420_000], [-33_868_820, 151_209_290], [14_492, -14_494], [-14_493, 14_493]];
    for (const [lat, lon] of pts) {
      const r = await su.query<{ c: number }>(`SELECT ${expr} AS c FROM (SELECT $1::int AS latitude_e6, $2::int AS longitude_e6) l`, [lat, lon]);
      expect([lat, lon, geoCell(lat, lon)]).toEqual([lat, lon, r.rows[0]!.c]);
    }
  });
});

describe('valuationUse (strictest defaults)', () => {
  it('a pack without a valuation section, or with invalid keys, allows nothing', () => {
    expect(valuationUse({})).toEqual(STRICTEST_VALUATION_USE);
    expect(valuationUse(null)).toEqual(STRICTEST_VALUATION_USE);
    expect(valuationUse({ valuation: { agent_cma: 'yes', client_cma: 1, avm_flag_scope: 'none', statements: { ca: 'x', TX: '', SC: 'Statement' }, reviewed_by_counsel_at: 'soon' } })).toEqual({
      ...STRICTEST_VALUATION_USE,
      statements: { SC: 'Statement' },
    });
    expect(soldFieldsAllowed({ audiences: { client: { fields: ['closePrice'] } } })).toBe(false);
    expect(soldFieldsAllowed({ audiences: { client: { fields: ['closePrice', 'closeDate'] } } })).toBe(true);
  });
});

const subject: CmaSubject = {
  propertyType: 'single_family', sqft: 1500, sizeSource: 'LivingArea', beds: 3, bathsX10: 20, yearBuilt: null, lotSqft: null, garageSpacesX10: null, storiesX10: null, poolPrivate: null,
  latE6: 37_750_000, lonE6: -122_420_000, subdivision: 'Sample Heights', postalCode: '94110', city: 'Oakland', region: 'CA', addressKey: '1 sample ave|94110|CA', listingIds: ['subject'], mlsNumbers: [],
};
function cand(i: number, o: Partial<CmaCandidate['sale']> = {}): CmaCandidate {
  return {
    ref: { id: `c${String(i).padStart(3, '0')}`, source: 'mls', mlsNumber: `M${i}`, connectionId: 'k', brokerage: 'B', addressKey: `${i} x st|94110|CA`, address: { line1: `${i} X St`, line2: null, city: 'Oakland', region: 'CA', postalCode: '94110' } },
    sale: { status: 'sold', closePriceCents: 50_000_000 + i * 100_000, closeDate: `2026-${String(1 + (i % 9)).padStart(2, '0')}-15`, contractDate: null, originalListPriceCents: null, concessionsCents: null, saleConditions: [], daysOnMarket: 20, propertyType: 'single_family', sqft: 1300 + i * 10, sizeSource: 'LivingArea', beds: 3, bathsX10: 20, yearBuilt: null, lotSqft: null, latE6: 37_750_000 + i * 100, lonE6: -122_420_000, subdivision: 'Sample Heights', postalCode: '94110', isLease: false, ...o },
    tiers: ['subdivision', 'postal_code'],
  };
}
const run = (cs: CmaCandidate[], o: { include?: string[]; exclude?: string[] } = {}) => prepareCma({ subject, candidates: cs, tiers: [], valuationDate: '2026-11-12', include: o.include ?? [], exclude: o.exclude ?? [] });

describe('prepareCma stand-in (R-CMA-2..5)', () => {
  it('R-CMA-5: the same inputs in any order give the same result, in integer cents', () => {
    const cs = Array.from({ length: 30 }, (_, i) => cand(i));
    const a = run(cs);
    const b = run([...cs].reverse());
    expect(b).toEqual(a);
    expect(Number.isInteger(a.valueCents)).toBe(true);
    expect(a.comps.reduce((s, c) => s + c.weightBps, 0)).toBe(10_000);
  });

  it('R-CMA-4: the value is inside the lowest-to-highest adjusted range; fewer than 3 comps give no value (E364)', () => {
    const r = run(Array.from({ length: 12 }, (_, i) => cand(i)));
    expect(r.valueCents!).toBeGreaterThanOrEqual(r.lowCents!);
    expect(r.valueCents!).toBeLessThanOrEqual(r.highCents!);
    expect(r.comps.length).toBe(CMA_DEFAULTS.maxComps);
    const two = run([cand(1), cand(2)]);
    expect(two).toMatchObject({ available: false, reason: 'INSUFFICIENT_COMPS', valueCents: null });
    expect(two.comps).toHaveLength(2);
  });

  it('R-CMA-2: the subject, a lease, a future sale and another type are never comps; a short sale only once included (E363, E367)', () => {
    const cs = [cand(1), cand(2), cand(3), cand(4, { isLease: true }), cand(5, { closeDate: '2026-12-01' }), cand(6, { propertyType: 'condo' }), cand(7, { saleConditions: ['short_sale'] }), { ...cand(8), ref: { ...cand(8).ref, id: 'subject' } }];
    const r = run(cs);
    const reason = (id: string) => r.notUsed.find((n) => n.ref.id === id)?.reason;
    expect([reason('c004'), reason('c005'), reason('c006'), reason('c007'), reason('subject')]).toEqual(['lease', 'future_sale', 'other_type', 'sale_conditions', 'subject']);
    const inc = run(cs, { include: ['c004', 'c005', 'c007', 'subject'] });
    expect(inc.comps.map((c) => c.ref.id)).toContain('c007');
    expect(inc.comps.map((c) => c.ref.id)).not.toContain('c004');
    expect(inc.comps.map((c) => c.ref.id)).not.toContain('c005');
  });

  it('R-CMA-3: a feature without enough support is not adjusted and says so; concessions only lower a price (E368)', () => {
    const r = run([cand(1), cand(2), cand(3, { concessionsCents: 1_500_000 })]);
    expect(r.rates.find((x) => x.feature === 'sqft')).toMatchObject({ adjusted: false });
    expect(r.rates.find((x) => x.feature === 'sqft')!.sentence).toMatch(/^Not adjusted for size: not enough local sales/);
    const c3 = r.comps.find((c) => c.ref.id === 'c003')!;
    expect(c3.adjustments).toEqual([{ feature: 'concessions', amountCents: -1_500_000, sentence: '−$15,000 for seller concessions.' }]);
    expect(c3.adjustedPriceCents).toBe(c3.sale.closePriceCents! - 1_500_000);
  });
});
