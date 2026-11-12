// Sold-data reads (comps.ts) under RLS, through real Postgres. R-CMA-1, R-CMA-2 (the candidate read), R-TEN-1; E363,
// E365, E366 (E81 kept), E370 (the near-match read). Synthetic rows only.
import type { TenantId } from '@realty/core/foundation';
import { addressKey, cellsWithin, geoCell, streetOfKey } from '@realty/core/listings';
import { type Tx, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, listing } from '../assistant/testing.js';
import { liveNearMatches, mlsRowsAtAddress, soldCandidates, type SoldQuery } from './comps.js';
import { syncConnection } from './sync.js';
import { makeDue, mlsConnection, mlsDeps, pagedFeed, reso, soldReso } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;
let conn: string;
const LAT = 37_804_412;
const LON = -122_271_146;

const asAgent = <T>(fn: (tx: Tx) => Promise<T>) => withTenantTx(w.agents[0]!.actor(), fn, { db: h.database });
const q = (o: Partial<SoldQuery> = {}): SoldQuery => ({ connectionIds: [conn], propertyType: 'single_family', since: '2025-11-01', until: '2026-11-01', tiers: [], ...o });

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
  conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
  const team = await listing(h, w, w.agents[0]!.userId!, { postalCode: '94610', status: 'sold' });
  await h.su.query("UPDATE listings SET mls_number = 'M4090' WHERE id = $1", [team]);
  const recs = [
    // 20 sales in 94610 spread over the year, same subdivision, near the subject
    ...Array.from({ length: 20 }, (_, i) => soldReso(4000 + i, { PostalCode: '94610', CloseDate: `2026-${String(1 + (i % 10)).padStart(2, '0')}-1${i % 9}`, Latitude: String((LAT + i * 300) / 1e6), Longitude: String((LON - i * 300) / 1e6) })),
    soldReso(4050, { PostalCode: '94610', SubdivisionName: 'SAMPLE HEIGHTS' }), // another spelling
    soldReso(4051, { PostalCode: '94610', CloseDate: null }), // E363: never a candidate
    soldReso(4052, { PostalCode: '94610', CloseDate: '2026-11-05' }), // after the valuation date
    soldReso(4053, { PostalCode: '94610', PropertyType: 'Residential Lease' }), // E360
    soldReso(4054, { PostalCode: '94610', PropertySubType: 'Condominium' }), // another type
    reso(4055, { PostalCode: '94610' }), // active
    soldReso(4056, { PostalCode: '94699', City: 'Sampleton', SubdivisionName: 'Sample Heights', Latitude: '40.1', Longitude: '-100.1' }), // same name far away
    soldReso(4090, { PostalCode: '94610', ListingId: 'M4090' }), // E366: the team's own listing, sold in the MLS
    reso(4091, { PostalCode: '94610', StreetNumber: '4101', StreetDirPrefix: 'W', StreetName: 'Sample', StreetSuffix: 'Avenue' }), // live near match of 4101 Sample Ave
    // gates/F4: live records whose PostalCode the feed sent as a ZIP+4 (stored as sent); 4093 is set back to version 1 below
    reso(4092, { PostalCode: '94610-1234', StreetNumber: '4105', StreetName: 'Sample', StreetSuffix: 'Avenue' }),
    reso(4093, { PostalCode: '94610-5678', StreetNumber: '4105', StreetName: 'Sample', StreetSuffix: 'Street' }),
    reso(4094, { PostalCode: '94611-1234', StreetNumber: '4105', StreetName: 'Sample', StreetSuffix: 'Avenue' }), // another ZIP
  ];
  await makeDue(h, conn);
  const r = await syncConnection(mlsDeps(h, { [conn]: pagedFeed([recs]) }), w.tenantId as TenantId, conn);
  expect(r).toMatchObject({ outcome: 'synced', skippedInvalid: 0 });
  await h.su.query('ANALYZE listings');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('soldCandidates (R-CMA-2: the candidate read)', () => {
  it('R-CMA-1 E363: only closed, non-lease MLS sales of the type with a close date inside the window; newest first; never a null close date', async () => {
    const r = await asAgent((tx) => soldCandidates(tx, q({ tiers: [{ tier: 'postal_code', postalCodes: ['94610'] }] })));
    const mls = r.rows.filter((x) => x.source === 'mls');
    expect(mls.length).toBe(22); // 20 + the other spelling + the team listing's mirror
    expect(mls.every((x) => x.status === 'sold' && !x.is_lease && x.close_date !== null && x.close_date <= '2026-11-01' && x.property_type === 'single_family')).toBe(true);
    expect(mls.map((x) => x.mls_number)).not.toEqual(expect.arrayContaining(['M4051']));
    for (const n of ['M4051', 'M4052', 'M4053', 'M4054', 'M4055']) expect(mls.some((x) => x.mls_number === n), n).toBe(false);
    const dates = mls.map((x) => x.close_date!);
    expect(dates).toEqual([...dates].sort().reverse());
    expect(r.reads).toEqual([{ tier: 'postal_code', rows: 22, limitReached: false }]);
  });

  it('R-CMA-2: tiers: subdivision (any spelling, same postal code or cells; not the same name far away), 1-mi cells, city spellings; limits are reported', async () => {
    const cells = cellsWithin(LAT, LON, 1);
    const r = await asAgent((tx) =>
      soldCandidates(tx, q({
        tiers: [
          { tier: 'subdivision', names: ['sample heights'], postalCodes: ['94610'], cells: cellsWithin(LAT, LON, 3) },
          { tier: 'cells_1mi', cells },
          { tier: 'city', cities: ['OAKLAND'], region: 'CA', limit: 5 },
        ],
      })),
    );
    expect(r.reads.map((x) => [x.tier, x.limitReached])).toEqual([['subdivision', false], ['cells_1mi', false], ['city', true]]);
    expect(r.reads[0]!.rows).toBe(22);
    expect(r.rows.some((x) => x.mls_number === 'M4056')).toBe(false); // E362: the same-named subdivision 1,000 mi away
    expect(r.reads[1]!.rows).toBeGreaterThan(0);
    expect(r.reads[2]!.rows).toBe(5);
    // an empty connection list reads nothing
    expect((await asAgent((tx) => soldCandidates(tx, q({ connectionIds: [], tiers: [{ tier: 'postal_code', postalCodes: ['94610'] }] })))).rows).toEqual([]);
  });

  it('R-CMA-2: below its limit, a tier\'s count equals the unlimited count; at the limit it says so', async () => {
    const unlimited = Number((await h.su.query("SELECT count(*) FROM listings WHERE tenant_id = $1 AND source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date BETWEEN '2025-11-01' AND '2026-11-01' AND postal_code = '94610' AND property_type = 'single_family'", [w.tenantId])).rows[0].count);
    const r = await asAgent((tx) => soldCandidates(tx, q({ tiers: [{ tier: 'postal_code', postalCodes: ['94610', '94610'] }, { tier: 'rate_pool', cells: [], postalCodes: ['94610'], limit: 3 }] })));
    expect(r.reads[0]).toEqual({ tier: 'postal_code', rows: unlimited, limitReached: false });
    expect(r.reads[1]).toEqual({ tier: 'rate_pool', rows: 3, limitReached: true });
  });

  it('E366 R-MLS-5: the sold team row whose mirror is in the result is returned by primary key; the mirror is linked once (E81)', async () => {
    const r = await asAgent((tx) => soldCandidates(tx, q({ tiers: [{ tier: 'postal_code', postalCodes: ['94610'] }] })));
    const mirror = r.rows.filter((x) => x.mls_number === 'M4090');
    expect(mirror.map((x) => x.source).sort()).toEqual(['mls', 'team']);
    expect(mirror.find((x) => x.source === 'mls')!.team_listing_id).toBe(mirror.find((x) => x.source === 'team')!.id);
  });
});

describe('address reads (F2)', () => {
  it('E365: mlsRowsAtAddress finds the rows at one address key, any status, newest first', async () => {
    const key = addressKey({ line1: '4010 Sample Avenue', city: 'Oakland', region: 'California', postalCode: '94610' })!;
    const rows = await asAgent((tx) => mlsRowsAtAddress(tx, key));
    expect(rows.map((x) => x.mls_number)).toEqual(['M4000']);
  });

  it('E370: liveNearMatches finds a live listing with the same number and street name in the postal code, ignoring the directional and suffix; never a sold one', async () => {
    const s = streetOfKey(addressKey({ line1: '4101 Sample Ave', city: 'Oakland', region: 'CA', postalCode: '94610' })!)!;
    const rows = await asAgent((tx) => liveNearMatches(tx, s));
    expect(rows.map((x) => x.mls_number)).toEqual(['M4091']);
    expect(await asAgent((tx) => liveNearMatches(tx, { ...s, streetNumber: '4102' }))).toEqual([]);
    expect(await asAgent((tx) => liveNearMatches(tx, { ...s, postalCode: '9461' }))).toEqual([]);
  });

  it('E370 (gates/F4): liveNearMatches reads a live record whose stored PostalCode is a ZIP+4 of the 5-digit code, with or without a stored key; never another ZIP\'s', async () => {
    // M4093 as stored before 0061, not yet re-read by the 0068 backfill: no stored key, so only its address gives one
    await h.su.query("UPDATE listings SET address_key = NULL, mls_normalize_version = 1 WHERE tenant_id = $1 AND source = 'mls' AND mls_number = 'M4093'", [w.tenantId]);
    const s = streetOfKey(addressKey({ line1: '4105 Sample Ave', city: 'Oakland', region: 'CA', postalCode: '94610' })!)!;
    const rows = await asAgent((tx) => liveNearMatches(tx, s));
    expect(rows.map((x) => [x.mls_number, x.postal_code, x.address_key === null]).sort()).toEqual([
      ['M4092', '94610-1234', false],
      ['M4093', '94610-5678', true],
    ]);
    expect((await asAgent((tx) => liveNearMatches(tx, { ...s, postalCode: '94611' }))).map((x) => x.mls_number)).toEqual(['M4094']);
  });
});

describe('geo_cell parity (S0 generated column = core geoCell)', () => {
  it('R-CMA-1: the stored cell equals core geoCell for every synced row, and for a coordinate table with negatives, 0 and the poles', async () => {
    const rows = (await h.su.query<{ latitude_e6: number; longitude_e6: number; geo_cell: number }>("SELECT latitude_e6, longitude_e6, geo_cell FROM listings WHERE tenant_id = $1 AND latitude_e6 IS NOT NULL", [w.tenantId])).rows;
    expect(rows.length).toBeGreaterThan(20);
    for (const r of rows) expect(r.geo_cell).toBe(geoCell(r.latitude_e6, r.longitude_e6));
    const table = [[0, 0], [-1, -1], [1, 1], [-14_493, 14_493], [14_492, -14_494], [90_000_000, 180_000_000], [-90_000_000, -180_000_000], [37_804_412, -122_271_146], [-33_868_800, 151_209_300]];
    const db = (await h.su.query<{ c: number }>(`SELECT ((floor(v.lat / 14493.0) + 6300) * 25000 + (floor(v.lon / 14493.0) + 12500))::integer AS c FROM (VALUES ${table.map((_, i) => `($${2 * i + 1}::int, $${2 * i + 2}::int)`).join(',')}) v(lat, lon)`, table.flat())).rows.map((x) => x.c);
    expect(db).toEqual(table.map(([a, b]) => geoCell(a!, b!)));
  });
});

describe('R-TEN-1: another tenant reads none of these rows', () => {
  it('R-TEN-1: soldCandidates, mlsRowsAtAddress and liveNearMatches under another tenant return nothing, even with this tenant\'s connection id', async () => {
    const other = await h.signup();
    const asOther = <T>(fn: (tx: Tx) => Promise<T>) => withTenantTx(other.actor(), fn, { db: h.database });
    const r = await asOther((tx) => soldCandidates(tx, q({ tiers: [{ tier: 'postal_code', postalCodes: ['94610'] }, { tier: 'cells_3mi', cells: cellsWithin(LAT, LON, 3) }, { tier: 'subdivision', names: ['Sample Heights'], postalCodes: ['94610'], cells: [] }, { tier: 'city', cities: ['Oakland'], region: 'CA' }] })));
    expect(r.rows).toEqual([]);
    expect(await asOther((tx) => mlsRowsAtAddress(tx, '4010 sample ave||oakland|ca|94610'))).toEqual([]);
    expect(await asOther((tx) => liveNearMatches(tx, { postalCode: '94610', streetNumber: '4101', streetNameTokens: ['sample', 'ave'] }))).toEqual([]);
  });
});
