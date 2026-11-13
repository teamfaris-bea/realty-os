// D9 lane V1-A: MLS sold data through the sync (real Postgres, deterministic record feeds only; no provider, no network).
// R-CMA-1 (stored sale facts), the per-record savepoint (F3), the backfill pass (F14), F3-lease; E360, E361, E362,
// E363, E372; R-MLS-3, R-MLS-6 kept.
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { NORMALIZE_VERSION } from '@realty/core/listings';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type AssistantWorld, assistantWorld, call, messagesOf, ownedContact } from '../assistant/testing.js';
import { withTenantTx } from '@realty/db';
import { cancelIneligibleMlsAlertsInTx, sendDueAlertsInTx } from '../assistant/searches.js';
import { listingFollowers } from '../nurture/repos.js';
import { NURTURE_JOBS } from '../nurture/types.js';
import { systemActor } from '../worker/systemActor.js';
import { SparkError } from '../providers/integrations/spark.js';
import { FILLING_SENTENCE } from './admin.js';
import { SYNC_BATCH, syncConnection } from './sync.js';
import { makeDue, mlsConnection, mlsDeps, pagedFeed, reso, soldReso, splitFeed, startBackfill, v1Row } from './testing.js';

let h: ApiHarness;
let w: AssistantWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await assistantWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const tid = () => w.tenantId as TenantId;
async function run(connectionId: string, feed: { fields: object; records: (c: string | null, n: number) => Promise<unknown> }) {
  await makeDue(h, connectionId);
  return syncConnection(mlsDeps(h, { [connectionId]: feed as never }), tid(), connectionId);
}
type Row = Record<string, unknown>;
const rowOf = async (mlsNumber: string): Promise<Row> =>
  (await h.su.query("SELECT *, close_date::text AS close_date, purchase_contract_date::text AS purchase_contract_date FROM listings WHERE tenant_id = $1 AND source = 'mls' AND mls_number = $2", [w.tenantId, mlsNumber])).rows[0];
const connOf = async (id: string) => (await h.su.query<{ sync_cursor: string | null; last_synced_at: Date | null; mls_backfill_pending: boolean; mls_backfill_cursor: string | null; next_sync_at: Date }>('SELECT sync_cursor, last_synced_at, mls_backfill_pending, mls_backfill_cursor, next_sync_at FROM integration_connections WHERE id = $1', [id])).rows[0]!;

/** An active saved search on one postal code (agent 0's new contact). */
async function activeSearch(zip: string): Promise<{ contactId: string; searchId: string }> {
  const agent = w.agents[0]!;
  const c = await ownedContact(agent);
  const searchId = randomUUID();
  await h.su.query(`INSERT INTO saved_searches (tenant_id, id, contact_id, name, status, criteria, criterion_evidence) VALUES ($1,$2,$3,'Zip','proposed',$4::jsonb,'{}'::jsonb)`, [w.tenantId, searchId, c.id, JSON.stringify({ postalCodes: [zip] })]);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/approve`, { checked: [], alertChannel: 'sms' })).status).toBe(200);
  expect((await call(agent, 'POST', `/saved-searches/${searchId}/activate`)).status).toBe(200);
  return { contactId: c.id, searchId };
}
const alertsOf = async (contactId: string) => (await messagesOf(h, contactId)).filter((m) => m.action_category === 'search_alert');

describe('R-CMA-1: a closed sale is stored with every sale and property fact', () => {
  it('R-CMA-1: close price and date, contract date, location, year built, lot size, subdivision, sale conditions, concessions and the AVM flag are columns; address_key and version 2 are written', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    expect(await run(conn, pagedFeed([[soldReso(3001, { UnitNumber: '4', StateOrProvince: 'California' })]]))).toMatchObject({ outcome: 'synced', inserted: 1, skippedInvalid: 0 });
    const r = await rowOf('M3001');
    expect(r).toMatchObject({
      status: 'sold',
      close_price_cents: '50800100',
      close_date: '2026-09-30',
      purchase_contract_date: '2026-09-01',
      original_list_price_cents: '53800100',
      concessions_cents: '750000',
      sale_conditions: ['standard'],
      days_on_market: 18,
      latitude_e6: 37_804_412,
      longitude_e6: -122_271_146,
      year_built: 1962,
      lot_sqft: '5227',
      subdivision_name: 'Sample Heights',
      garage_spaces_x10: 10,
      stories_x10: 15,
      pool_private: false,
      size_source: 'LivingArea',
      is_lease: false,
      avm_display_allowed: true,
      address_key: '3011 sample ave|unit 4|oakland|ca|94110',
      mls_normalize_version: NORMALIZE_VERSION,
    });
    // the generated cell exists (its parity with core geoCell is in comps.test.ts)
    expect(typeof r['geo_cell']).toBe('number');
  });

  it('R-CMA-1: an incremental update rewrites the facts (strictly newer modification only, E141 unchanged)', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const feed = pagedFeed([[soldReso(3002)], [soldReso(3002, { ClosePrice: 1, ModificationTimestamp: '2026-11-10T09:00:00Z' })], [soldReso(3002, { ClosePrice: 499000, YearBuilt: null, ModificationTimestamp: '2026-11-10T11:00:00Z' })]]);
    await run(conn, feed);
    expect(await run(conn, feed)).toMatchObject({ skippedStale: 1 });
    expect((await rowOf('M3002'))['close_price_cents']).toBe('50800200');
    expect(await run(conn, feed)).toMatchObject({ updated: 1 });
    expect(await rowOf('M3002')).toMatchObject({ close_price_cents: '49900000', year_built: null });
  });
});

describe('E361 F3: bad values never halt the sync; a record the database refuses is skipped', () => {
  it('E361 R-CMA-1: "-80.1234567" text stores −80123457 µ°; latitude 95 and (0,0) are null; YearBuilt 0, Stories "1.5", CloseDate "2024-02-30" handled; every record is stored', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const r = await run(conn, pagedFeed([[
      soldReso(3101, { Latitude: '32.5', Longitude: '-80.1234567' }),
      soldReso(3102, { Latitude: 95, Longitude: -80 }),
      soldReso(3103, { Latitude: 0, Longitude: 0 }),
      soldReso(3104, { YearBuilt: 0, Stories: '1.5', CloseDate: '2024-02-30' }),
      reso(3105, { ListingContractDate: '2024-02-30' }),
    ]]));
    expect(r).toMatchObject({ inserted: 5, skippedInvalid: 0 });
    expect((await rowOf('M3101'))['longitude_e6']).toBe(-80_123_457);
    for (const n of ['M3102', 'M3103']) expect(await rowOf(n)).toMatchObject({ latitude_e6: null, longitude_e6: null, geo_cell: null });
    expect(await rowOf('M3104')).toMatchObject({ year_built: null, stories_x10: 15, close_date: null });
    expect((await rowOf('M3105'))['list_date']).toBeNull(); // the ::date cast would have aborted the batch before
  });

  it('E361 F3: one poisoned record in a batch of 500 (a forced 23514) leaves 499 stored and the cursor advanced; a NUL byte (class 22) is skipped too', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query("ALTER TABLE listings ADD CONSTRAINT test_poison CHECK (mls_number IS DISTINCT FROM 'M32250') NOT VALID");
    try {
      const page = Array.from({ length: SYNC_BATCH }, (_, i) => reso(32_000 + i, { PostalCode: '94320' }));
      page[250] = reso(32_250, { PostalCode: '94320' });
      page[300] = reso(32_300, { PostalCode: '94320', PublicRemarks: 'bad \u0000 byte' });
      const logs: { msg: string; data: unknown }[] = [];
      const log = { info: (msg: string, data: unknown) => logs.push({ msg, data }), warn: () => {}, error: () => {}, debug: () => {} };
      await makeDue(h, conn);
      const r = await syncConnection(mlsDeps(h, { [conn]: pagedFeed([page]) }), tid(), conn, log as never);
      expect(r).toMatchObject({ outcome: 'synced', inserted: SYNC_BATCH - 2, skippedInvalid: 2 });
      expect((await connOf(conn)).sync_cursor).toBe(`c${SYNC_BATCH}`);
      expect((await h.su.query("SELECT count(*)::int AS n FROM listings WHERE tenant_id = $1 AND mls_connection_id = $2", [w.tenantId, conn])).rows[0]).toEqual({ n: SYNC_BATCH - 2 });
      const line = logs.find((l) => l.msg === 'mls.sync')!;
      expect(line.data).toMatchObject({ issues: { MLS_RECORD_REFUSED_BY_DB: 2 } });
      expect(JSON.stringify(logs)).not.toMatch(/test_poison|violates|byte|M32250/); // codes and counts only
    } finally {
      await h.su.query('ALTER TABLE listings DROP CONSTRAINT test_poison');
    }
  });

  it('F3: a forced 40001 is not absorbed: the transaction retries and the batch is stored once', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query(`CREATE SEQUENCE test_serial_once;
      CREATE FUNCTION test_serial_once() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.mls_number = 'M3301' AND nextval('test_serial_once') = 1 THEN RAISE EXCEPTION 'forced' USING ERRCODE = 'serialization_failure'; END IF;
        RETURN NEW; END $$;
      CREATE TRIGGER test_serial_once BEFORE INSERT ON listings FOR EACH ROW EXECUTE FUNCTION test_serial_once();
      GRANT USAGE ON SEQUENCE test_serial_once TO app_user;`);
    try {
      const r = await run(conn, pagedFeed([[reso(3300, { PostalCode: '94330' }), reso(3301, { PostalCode: '94330' }), reso(3302, { PostalCode: '94330' })]]));
      expect(r).toMatchObject({ outcome: 'synced', inserted: 3, skippedInvalid: 0 });
      expect((await h.su.query("SELECT last_value FROM test_serial_once")).rows[0]).toEqual({ last_value: '2' });
    } finally {
      await h.su.query('DROP TRIGGER test_serial_once ON listings; DROP FUNCTION test_serial_once(); DROP SEQUENCE test_serial_once;');
    }
  });
});

describe('E360: a lease is never a sale, nor an alert (F3-lease)', () => {
  it('E360 R-CMA-1: a closed Residential Lease is stored with is_lease; an active lease never reaches a buyer alert', async () => {
    const { contactId, searchId } = await activeSearch('94360');
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const r = await run(conn, pagedFeed([[
      soldReso(3601, { PostalCode: '94360', PropertyType: 'Residential Lease', ClosePrice: '2,400.00' }),
      reso(3602, { PostalCode: '94360', PropertyType: 'Residential Lease', ListPrice: 2400 }),
      reso(3603, { PostalCode: '94360' }),
    ]]));
    expect(r.inserted).toBe(3);
    expect(await rowOf('M3601')).toMatchObject({ status: 'sold', is_lease: true, property_type: 'single_family', close_price_cents: '240000' });
    expect((await rowOf('M3602'))['is_lease']).toBe(true);
    expect(r.matched).toBe(1); // only the sale listing
    const matched = (await h.su.query<{ listing_id: string }>('SELECT listing_id FROM saved_search_matches WHERE search_id = $1', [searchId])).rows.map((x) => x.listing_id);
    expect(matched).toEqual([(await rowOf('M3603'))['id']]);
    expect(await alertsOf(contactId)).toHaveLength(1);
  });

  it('E360 F3-lease (b10 review ownership-data/F1): matches recorded before the lease flag (version-1 rows the backfill then flags as leases) are never alerted, a queued digest holding one is canceled, and neither makes anyone a nurture follower', async () => {
    const zip = '94364';
    const { contactId, searchId } = await activeSearch(zip);
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
    // stored by batch 9 (version 1, no lease flag): one matched and already queued in a digest, one matched and pending
    const queued = await v1Row(h, w.tenantId, conn, { mlsNumber: 'M3641', postalCode: zip, status: 'active', modifiedAt: '2026-11-10T10:00:00Z', priceCents: 260_000 });
    await h.su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now())', [w.tenantId, searchId, queued]);
    await h.su.query("UPDATE saved_searches SET alert_frequency = 'daily', last_alerted_at = now() - interval '2 days' WHERE id = $1", [searchId]);
    const sys = () => systemActor(tid(), 'worker');
    expect(await withTenantTx(sys(), (tx, now) => sendDueAlertsInTx(tx, mlsDeps(h), w.tenantId, now, { searchId }), { db: h.database })).toBe(1);
    const digest = (await alertsOf(contactId)).at(-1)!;
    expect(digest).toMatchObject({ status: 'queued' });
    expect(digest.body).toContain('$2,600');
    const pending = await v1Row(h, w.tenantId, conn, { mlsNumber: 'M3642', postalCode: zip, status: 'active', modifiedAt: '2026-11-10T10:00:00Z', priceCents: 275_000 });
    await h.su.query('INSERT INTO saved_search_matches (tenant_id, search_id, listing_id, matched_at) VALUES ($1,$2,$3, now())', [w.tenantId, searchId, pending]);
    // the backfill re-reads both as Residential Lease
    await startBackfill(h, conn);
    const lease = (n: number, cents: number) => reso(n, { PostalCode: zip, PropertyType: 'Residential Lease', ListPrice: cents / 100, ModificationTimestamp: '2026-11-10T10:00:00Z' });
    expect(await run(conn, splitFeed({ incremental: [{ records: [] }], backfill: [{ records: [lease(3641, 260_000), lease(3642, 275_000)], more: false }] }))).toMatchObject({ filled: 2 });
    for (const n of ['M3641', 'M3642']) expect(await rowOf(n)).toMatchObject({ is_lease: true, mls_normalize_version: NORMALIZE_VERSION });
    // the compliance sweep the sync runs after its pages cancels the queued digest (a lease is never a home for sale)
    // and releases its match; a second sweep finds nothing left
    expect((await alertsOf(contactId)).find((m) => m.id === digest.id)).toMatchObject({ status: 'canceled', status_reason: 'MLS_LEASE' });
    expect((await h.su.query('SELECT alerted_message_id FROM saved_search_matches WHERE search_id = $1 AND listing_id = $2', [searchId, queued])).rows[0]).toEqual({ alerted_message_id: null });
    expect(await withTenantTx(sys(), (tx, now) => cancelIneligibleMlsAlertsInTx(tx, now), { db: h.database })).toEqual([]);
    // the next pass, with the search due, sends nothing: neither lease is alerted
    await h.su.query("UPDATE saved_searches SET last_alerted_at = now() - interval '2 days' WHERE id = $1", [searchId]);
    expect(await withTenantTx(sys(), (tx, now) => sendDueAlertsInTx(tx, mlsDeps(h), w.tenantId, now, {}), { db: h.database })).toBe(0);
    expect((await alertsOf(contactId)).filter((m) => m.status !== 'canceled')).toHaveLength(0);
    // nurture: a matched lease makes nobody a follower, so a rent change fires no price drop or back on market
    for (const id of [queued, pending]) expect(await withTenantTx(sys(), (tx) => listingFollowers(tx, id), { db: h.database })).toEqual([]);
  });
});

describe('E362, E363: lot size, placeholders and sale facts stored as read', () => {
  it('E362 R-CMA-1: acres only, square metres, disagreeing fields; "None", "N/A" and "0" subdivisions are null', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await run(conn, pagedFeed([[
      soldReso(3621, { LotSizeAcres: 0.25 }),
      soldReso(3622, { LotSizeAcres: undefined, LotSizeArea: 1000, LotSizeUnits: 'Square Meters' }),
      soldReso(3623, { LotSizeSquareFeet: 9000, LotSizeAcres: 2 }),
      soldReso(3624, { SubdivisionName: 'None' }),
      soldReso(3625, { SubdivisionName: 'N/A' }),
      soldReso(3626, { SubdivisionName: 0 }),
    ]]));
    expect([(await rowOf('M3621'))['lot_sqft'], (await rowOf('M3622'))['lot_sqft'], (await rowOf('M3623'))['lot_sqft']]).toEqual(['10890', '10764', '9000']);
    for (const n of ['M3624', 'M3625', 'M3626']) expect((await rowOf(n))['subdivision_name']).toBeNull();
  });

  it('E363 R-CMA-1: ClosePrice on a pending record and Closed without CloseDate are stored as read', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await run(conn, pagedFeed([[reso(3631, { ClosePrice: 410000, StandardStatus: 'Pending' }), soldReso(3632, { CloseDate: null })]]));
    expect(await rowOf('M3631')).toMatchObject({ status: 'pending', close_price_cents: '41000000' });
    expect(await rowOf('M3632')).toMatchObject({ status: 'sold', close_date: null, close_price_cents: '50863200' });
  });
});

describe('E372: the backfill pass fills old rows without ever delaying new listings or sending anything', () => {
  it('E372 R-CMA-1 R-MLS-6 R-MLS-3: incremental first; a version-1 row with an equal ModificationTimestamp is filled; no alert, no nurture firing, no price history; sync_cursor is the incremental one; a second pass changes nothing; it ends with `more` false', async () => {
    const zip = '94372';
    const { contactId, searchId } = await activeSearch(zip);
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!, { lastSyncedAt: new Date() });
    const old = await v1Row(h, w.tenantId, conn, { mlsNumber: 'M3721', postalCode: zip, status: 'active', modifiedAt: '2026-11-10T10:00:00Z', priceCents: 50_000_000 });
    const since = await v1Row(h, w.tenantId, conn, { mlsNumber: 'M3722', postalCode: zip, modifiedAt: '2026-11-10T12:00:00Z' }); // modified since the backfill's copy
    await startBackfill(h, conn);
    const history = async () => (await h.su.query('SELECT count(*)::int AS n FROM listing_price_history WHERE listing_id = ANY($1::uuid[])', [[old, since]])).rows[0]!.n as number;
    const nurtureJobs = async () => (await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = $2 AND payload->>'listingId' = ANY($3::text[])", [w.tenantId, NURTURE_JOBS.listingChanged, [old, since]])).rows[0]!.n as number;
    const h0 = await history();
    const admin = async () => (await call<{ connections: { id: string; soldData: { backfillPending: boolean; sentence: string } }[] }>(w.owner, 'GET', '/admin/mls')).body.connections.find((c) => c.id === conn)!.soldData;
    expect(await admin()).toMatchObject({ backfillPending: true, sentence: FILLING_SENTENCE });

    const feed = splitFeed({
      incremental: [{ records: [reso(3720, { PostalCode: zip })] }],
      backfill: [
        { records: [soldReso(3721, { PostalCode: zip, StandardStatus: 'Active', ListPrice: 1, ClosePrice: null, CloseDate: null, ModificationTimestamp: '2026-11-10T10:00:00Z' }), soldReso(3722, { PostalCode: zip, ModificationTimestamp: '2026-11-10T11:00:00Z' })], more: true },
        { records: [soldReso(3721, { PostalCode: zip, StandardStatus: 'Active', ListPrice: 1, ClosePrice: null, CloseDate: null, ModificationTimestamp: '2026-11-10T10:00:00Z' })], more: false },
      ],
    });
    const r1 = await run(conn, feed);
    expect(feed.calls).toEqual(['incremental', 'backfill']);
    expect(r1).toMatchObject({ outcome: 'synced', inserted: 1, filled: 1, matched: 1 }); // the matched one is the new listing
    const filled = await rowOf('M3721');
    expect(filled).toMatchObject({ mls_normalize_version: NORMALIZE_VERSION, list_price_cents: '50000000', status: 'active', year_built: 1962, subdivision_name: 'Sample Heights', address_key: '3731 sample ave||oakland|ca|94372' });
    expect(await rowOf('M3722')).toMatchObject({ mls_normalize_version: 1, year_built: null }); // left to the incremental read
    expect(await history()).toBe(h0);
    expect(await nurtureJobs()).toBe(0);
    const matched = (await h.su.query<{ listing_id: string }>('SELECT listing_id FROM saved_search_matches WHERE search_id = $1', [searchId])).rows.map((x) => x.listing_id);
    expect(matched).not.toContain(old);
    const c1 = await connOf(conn);
    expect(c1).toMatchObject({ sync_cursor: 'i1', mls_backfill_pending: true, mls_backfill_cursor: 'b2' });
    expect(c1.next_sync_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000); // due at once while pending
    expect(await admin()).toMatchObject({ backfillPending: true, sentence: FILLING_SENTENCE });

    // a full incremental page: the backfill waits (new listings are never delayed)
    const full = splitFeed({ incremental: [{ records: [reso(3725, { PostalCode: '94379' })], more: true }] });
    await run(conn, full);
    expect(full.calls).toEqual(['incremental']);
    // a failed incremental read: no backfill read, nothing written, freshness unmoved
    const before = await connOf(conn);
    feed.failIncremental = new SparkError('UNREACHABLE', 503);
    feed.calls.length = 0;
    expect((await run(conn, feed)).outcome).toBe('failed');
    expect(feed.calls).toEqual(['incremental']);
    expect((await connOf(conn)).last_synced_at).toEqual(before.last_synced_at);
    feed.failIncremental = null;

    // the second page (the same record again) changes nothing and ends the backfill
    await h.su.query("UPDATE integration_connections SET sync_cursor = 'i1' WHERE id = $1", [conn]);
    feed.calls.length = 0;
    const r2 = await run(conn, feed);
    expect(feed.calls).toEqual(['incremental', 'backfill']);
    expect(r2).toMatchObject({ outcome: 'synced', filled: 0, matched: 0 });
    expect(await connOf(conn)).toMatchObject({ mls_backfill_pending: false, mls_backfill_cursor: null });
    expect((await connOf(conn)).next_sync_at.getTime()).toBeGreaterThan(Date.now() + 10 * 60_000);
    expect(await admin()).toMatchObject({ backfillPending: false });
    expect((await admin()).sentence).not.toBe(FILLING_SENTENCE);
    // ended: later runs read no backfill page
    feed.calls.length = 0;
    await run(conn, feed);
    expect(feed.calls).toEqual(['incremental']);
    expect(await alertsOf(contactId)).toHaveLength(1);
  });

  it('E372: a page of 500 backfill records completes inside one run', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const page = [];
    for (let i = 0; i < SYNC_BATCH; i++) {
      await v1Row(h, w.tenantId, conn, { mlsNumber: `M${38_000 + i}`, postalCode: '94380', modifiedAt: '2026-11-10T10:00:00Z' });
      page.push(soldReso(38_000 + i, { PostalCode: '94380' }));
    }
    await startBackfill(h, conn);
    const t0 = performance.now();
    const r = await run(conn, splitFeed({ backfill: [{ records: page, more: false }] }));
    const ms = performance.now() - t0;
    console.info(`[mls backfill] ${SYNC_BATCH} records filled in ${Math.round(ms)} ms`);
    expect(r).toMatchObject({ outcome: 'synced', filled: SYNC_BATCH, inserted: 0, updated: 0 });
    expect(ms).toBeLessThan(60_000); // one sync run's budget: the reconcile tick is every 60 s
  }, 120_000);

  it('E372 R-TEN-1: the backfill state is the system\'s: an Owner cannot set it', async () => {
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    const { withTenantTx } = await import('@realty/db');
    const { sql } = await import('kysely');
    await expect(withTenantTx(w.owner.actor(), async (tx) => void (await sql`UPDATE integration_connections SET mls_backfill_pending = true WHERE id = ${conn}`.execute(tx)), { db: h.database })).rejects.toThrow(/CONNECTION_BACKFILL_SYSTEM/);
  });
});
