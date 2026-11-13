// Test helpers for module 24 (imported by *.test.ts only). Synthetic data only: standard RESO field names,
// no real MLS, brokerage, account or address. Connections are made by the SYSTEM actor (the 0018 guard lets
// only it move an external connection live), exactly as the Spark validation or a provider callback would.
import { randomBytes, randomUUID } from 'node:crypto';
import type { ResoLike } from '@realty/core/listings';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { ApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { systemActor } from '../worker/systemActor.js';
import type { MlsRecordFeed, MlsRecordPage } from './feeds.js';
import type { MlsDeps } from './sync.js';

export const TEST_ATTRIBUTION = 'Listing information from the regional MLS (test attribution).';
export const TEST_DISCLAIMER = 'Information deemed reliable but not guaranteed (test disclaimer).';

/** A counsel-reviewed pack showing everything to clients (fixtures only; VERIFY WITH COUNSEL in real use). */
export const REVIEWED_PACK = Object.freeze({
  reviewed_by_counsel_at: '2026-11-01T00:00:00Z',
  max_staleness_hours: 24,
  attribution_text: TEST_ATTRIBUTION,
  disclaimer_text: TEST_DISCLAIMER,
  allow_rehost_photos: false,
  require_listing_brokerage: true,
  audiences: {
    client: { fields: ['mlsNumber', 'status', 'listPrice', 'beds', 'baths', 'sqft', 'propertyType', 'description', 'listDate', 'address', 'locality', 'photos'], statuses: ['active', 'coming_soon', 'pending'] },
    public: { fields: [], statuses: [] },
  },
});

/** A live mls_feed connection (system actor), with a placeholder credential row; returns its id. `spark`: its external account is 'spark:<id>', as saveSparkCredential sets it. */
export async function mlsConnection(h: ApiHarness, tenantId: string, createdByUserId: string, o: { pack?: Record<string, unknown>; status?: 'connected' | 'degraded'; lastSyncedAt?: Date | null; spark?: boolean } = {}): Promise<string> {
  const id = randomUUID();
  const credId = randomUUID();
  await withTenantTx(
    systemActor(tenantId, 'provider'),
    async (tx) => {
      await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref, created_by_user_id)
                VALUES (app.tenant_id(), ${credId}, 'mls', ${randomBytes(48)}, 1, 'test-feed', ${createdByUserId})`.execute(tx);
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, connected_at, license_pack, last_synced_at)
                VALUES (app.tenant_id(), ${id}, 'mls_feed', ${o.status ?? 'connected'}, 'Test MLS feed', ${`${o.spark ? 'spark' : 'test'}:${id}`}, ${credId}, now(),
                        ${JSON.stringify(o.pack ?? REVIEWED_PACK)}::jsonb, ${o.lastSyncedAt === undefined ? null : o.lastSyncedAt})`.execute(tx);
    },
    { db: h.database },
  );
  return id;
}

/** A RESO record (synthetic), display allowed unless overridden. */
export function reso(i: number, o: Record<string, unknown> = {}): ResoLike {
  return {
    ListingKey: `TK${String(i).padStart(5, '0')}`,
    ListingId: `M${i}`,
    StandardStatus: 'Active',
    ListPrice: 500000 + i,
    StreetNumber: String(10 + i),
    StreetName: 'Sample',
    StreetSuffix: 'Ave',
    City: 'Oakland',
    StateOrProvince: 'CA',
    PostalCode: '94110',
    BedroomsTotal: 3,
    BathroomsTotalInteger: 2,
    LivingArea: 1400,
    PropertyType: 'Residential',
    PropertySubType: 'Single Family Residence',
    ListOfficeName: 'Other Brokerage (test)',
    ModificationTimestamp: '2026-11-10T10:00:00Z',
    InternetEntireListingDisplayYN: true,
    InternetAddressDisplayYN: true,
    Media: [{ MediaURL: `https://photos.example.invalid/${i}/1.jpg`, Order: 1, MediaCategory: 'Photo' }],
    ZZ_SyntheticLocalCode: 'Q7',
    ...o,
  };
}

/** A queue of pages: each call returns the next one (records as given, out of order if the test says so). */
export function pagedFeed(pages: ResoLike[][], o: { fail?: () => Error | null } = {}): MlsRecordFeed & { calls: number; push(p: ResoLike[]): void } {
  let n = 0;
  const f = {
    fields: {},
    calls: 0,
    push(p: ResoLike[]) {
      pages.push(p);
    },
    async records(_cursor: string | null, limit: number): Promise<MlsRecordPage> {
      f.calls += 1;
      const err = o.fail?.() ?? null;
      if (err) throw err;
      const page = pages.shift() ?? [];
      const records = page.slice(0, limit);
      if (page.length > limit) pages.unshift(page.slice(limit)); // the rest is the next read (like a real feed's limit)
      n += records.length;
      return { records, cursor: `c${n}`, unpositioned: 0, more: page.length > limit };
    },
  };
  return f;
}

export function mlsDeps(h: ApiHarness, feeds: Record<string, MlsRecordFeed> = {}): MlsDeps {
  return { ...depsFromPlatform(h.app.platform), mls: h.app.platform.config.mls, ...(Object.keys(feeds).length > 0 ? { recordFeed: (id: string) => feeds[id] ?? null } : {}) };
}

/** Makes a connection due now (the stored instant, R-OWN-27). */
export async function makeDue(h: ApiHarness, connectionId: string): Promise<void> {
  await h.su.query("UPDATE integration_connections SET next_sync_at = now() - interval '1 second' WHERE id = $1", [connectionId]);
}

export async function mlsRows(h: ApiHarness, tenantId: string): Promise<{ id: string; mls_number: string; status: string; list_price_cents: string; mls_modified_at: Date; display_allowed: boolean; team_listing_id: string | null; description: string | null; sqft: number | null; attributes: Record<string, unknown> }[]> {
  return (await h.su.query("SELECT id, mls_number, status, list_price_cents, mls_modified_at, display_allowed, team_listing_id, description, sqft, attributes FROM listings WHERE tenant_id = $1 AND source = 'mls' ORDER BY mls_number", [tenantId])).rows;
}

// ---- D9 sold data (lane V1-A) -------------------------------------------------------------------------

/** A closed sale (synthetic) with every sale and property field; western longitude as text, as feeds send it. */
export function soldReso(i: number, o: Record<string, unknown> = {}): ResoLike {
  return reso(i, {
    StandardStatus: 'Closed',
    ListPrice: 520000 + i,
    ClosePrice: 505000 + i,
    CloseDate: '2026-09-30',
    PurchaseContractDate: '2026-09-01',
    OriginalListPrice: 535000 + i,
    ConcessionsAmount: '7500.00',
    SpecialListingConditions: 'Standard',
    DaysOnMarket: 18,
    Latitude: '37.8044123',
    Longitude: '-122.2711456',
    YearBuilt: 1962,
    LotSizeAcres: 0.12,
    SubdivisionName: 'Sample Heights',
    GarageSpaces: 1,
    PoolPrivateYN: 'N',
    Stories: '1.5',
    InternetAutomatedValuationDisplayYN: 'Y',
    ...o,
  });
}

/**
 * A record feed with separate incremental and backfill queues. The incremental cursor is never null in these tests
 * (start the connection at 'i0'); a null or 'b…' cursor is the backfill's. Each page's `more` is as given.
 */
export function splitFeed(o: { incremental?: { records: ResoLike[]; more?: boolean }[]; backfill?: { records: ResoLike[]; more?: boolean }[] } = {}) {
  const inc = [...(o.incremental ?? [])];
  const bf = [...(o.backfill ?? [])];
  let i = 0;
  let b = 0;
  const f = {
    fields: {},
    calls: [] as ('incremental' | 'backfill')[],
    failIncremental: null as Error | null,
    pushIncremental(records: ResoLike[], more = false) {
      inc.push({ records, more });
    },
    pushBackfill(records: ResoLike[], more = false) {
      bf.push({ records, more });
    },
    async records(cursor: string | null, _limit: number): Promise<MlsRecordPage> {
      const backfill = cursor === null || cursor.startsWith('b');
      f.calls.push(backfill ? 'backfill' : 'incremental');
      if (!backfill && f.failIncremental) throw f.failIncremental;
      const p = (backfill ? bf : inc).shift() ?? { records: [], more: false };
      if (backfill) b += p.records.length;
      else i += p.records.length;
      return { records: p.records, cursor: p.records.length === 0 ? cursor : backfill ? `b${b}` : `i${i}`, unpositioned: 0, more: p.more ?? false };
    },
  };
  return f;
}

/** Starts a connection's backfill as the one-time migration does (superuser: the table owner). */
export async function startBackfill(h: ApiHarness, connectionId: string, syncCursor = 'i0'): Promise<void> {
  await h.su.query('UPDATE integration_connections SET mls_backfill_pending = true, mls_backfill_cursor = NULL, sync_cursor = $2 WHERE id = $1', [connectionId, syncCursor]);
}

/** A version-1 MLS row as stored before the sale facts existed (load fixture, superuser). Returns its id. */
export async function v1Row(h: ApiHarness, tenantId: string, connectionId: string, o: { mlsNumber: string; postalCode?: string; modifiedAt?: string; status?: string; priceCents?: number }): Promise<string> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                           property_type, attributes, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, last_seen_in_feed_at)
     VALUES ($1,$2,'mls',$3,$4,'1 Old Row Rd','Oakland','CA',$5,$6,3,20,1400,'single_family','{"mls":{"address_display":true,"photo_urls":[]}}'::jsonb,$7,$8,'Other Brokerage (test)',true,now())`,
    [tenantId, id, o.mlsNumber, o.status ?? 'sold', o.postalCode ?? '94110', o.priceCents ?? 50_000_000, connectionId, o.modifiedAt ?? '2026-11-10T10:00:00Z'],
  );
  return id;
}

// ---- the 500k skewed volume fixture (lane V1-A; shared with api/cma's volume check) ----------------------------------

/** The shape of mlsVolumeFixture: 500k MLS rows, half active/pending (500 per postal code), half sold history (D9). */
export const MLS_VOLUME = Object.freeze({
  ROWS: 500_000,
  ACTIVE: 250_000,
  SOLD: 250_000,
  ZIPS: 500,
  /** 40,000 sold rows over 24 months, in a 2 x 2 mi grid near HOT_LAT/HOT_LON; 5,000 of them in 'Big Subdivision' */
  HOT_ZIP: '94999',
  HOT_LAT: 37_800_000,
  HOT_LON: -122_270_000,
  /** 120,000 sold rows */
  BIG_CITY: 'Big City',
  BIG_SUBDIVISION: 'Big Subdivision',
});

/**
 * Bulk-inserts the 500k skewed MLS rows of one tenant's connection (superuser: a load fixture, not an application path;
 * the table owner passes the 0061 valuation guard). Sold rows close over the 730 days before `anchorDate` (default
 * 2026-11-01, the module 24 benchmark's fixed window; the CMA check passes today, so its 24-month window is full).
 * 2 % leases, 5 % unfilled version-1 rows with null close dates. `sizeSource` (default none, as module 24's benchmark
 * stores) is the RESO field the filled rows' sizes were read from; the CMA engine compares only like sizes (V3).
 */
export async function mlsVolumeFixture(h: ApiHarness, tenantId: string, connectionId: string, o: { anchorDate?: string; sizeSource?: string } = {}): Promise<void> {
  const { ACTIVE, SOLD, ZIPS, HOT_ZIP, HOT_LAT, HOT_LON } = MLS_VOLUME;
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                           property_type, attributes, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, last_seen_in_feed_at)
     SELECT $1, gen_random_uuid(), 'mls', 'V' || i, CASE WHEN (i / ${ZIPS}) % 10 = 0 THEN 'pending' ELSE 'active' END, (i % 9000 + 1) || ' Volume St',
            'City' || (i % 200), 'CA', (94000 + i % ${ZIPS})::text, 30000000 + ((i / ${ZIPS}) % 1000) * 50000, 1 + (i / ${ZIPS}) % 5, 20, 1200 + i % 900,
            'single_family', '{"mls":{"address_display":true,"photo_urls":[]}}'::jsonb, $2, timestamptz '2026-11-01' + (i || ' seconds')::interval,
            'Volume Brokerage (test)', (i / ${ZIPS}) % 10 <> 3, now()
       FROM generate_series(1, ${ACTIVE}) i`,
    [tenantId, connectionId],
  );
  // D9 sold history: j = 1..SOLD. j <= 40,000: the hot postal code (a 2 x 2 mi grid near HOT_LAT/LON), its 5,000 j % 8 = 0
  // rows the big subdivision; j <= 120,000: the big city. 2 % leases (j % 50 = 0), 5 % unfilled version-1 rows (j % 20 = 1).
  await h.su.query(
    `INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, list_price_cents, beds, baths_x10, sqft,
                           property_type, attributes, mls_connection_id, mls_modified_at, listing_brokerage_name, display_allowed, last_seen_in_feed_at,
                           close_price_cents, close_date, purchase_contract_date, latitude_e6, longitude_e6, year_built, lot_sqft, subdivision_name,
                           sale_conditions, is_lease, avm_display_allowed, mls_normalize_version, size_source)
     SELECT $1, gen_random_uuid(), 'mls', 'S' || j, 'sold', (j % 9000 + 1) || ' History Rd',
            CASE WHEN j <= 120000 THEN 'Big City' ELSE 'City' || (j % 200) END, 'CA',
            CASE WHEN j <= 40000 THEN '${HOT_ZIP}' ELSE (94000 + j % ${ZIPS})::text END,
            30000000 + (j % 1000) * 50000, 1 + j % 5, 20, 1200 + j % 900, 'single_family',
            '{"mls":{"address_display":true,"photo_urls":[]}}'::jsonb, $2, timestamptz '2026-11-01' + (j || ' seconds')::interval, 'Volume Brokerage (test)', true, now(),
            CASE WHEN u THEN NULL ELSE 29000000 + (j % 1000) * 50000 END,
            CASE WHEN u THEN NULL ELSE $3::date - (j % 730) END,
            CASE WHEN u THEN NULL ELSE $3::date - (j % 730) - 30 END,
            CASE WHEN u THEN NULL WHEN j <= 40000 THEN ${HOT_LAT} + (j % 200) * 150 ELSE 36000000 + ((j % ${ZIPS}) % 25) * 60000 + (j % 97) * 200 END,
            CASE WHEN u THEN NULL WHEN j <= 40000 THEN ${HOT_LON} - ((j / 200) % 200) * 150 ELSE -121000000 - ((j % ${ZIPS}) / 25) * 60000 - (j % 89) * 200 END,
            CASE WHEN u THEN NULL ELSE 1950 + j % 70 END,
            CASE WHEN u THEN NULL ELSE 4000 + j % 6000 END,
            CASE WHEN u THEN NULL WHEN j <= 40000 AND j % 8 = 0 THEN 'Big Subdivision' ELSE 'Sub ' || (j % 3000) END,
            CASE WHEN u THEN '{}'::text[] ELSE ARRAY['standard'] END,
            j % 50 = 0, NOT u, CASE WHEN u THEN 1 ELSE 2 END, CASE WHEN u THEN NULL ELSE $4::text END
       FROM generate_series(1, ${SOLD}) j, LATERAL (SELECT j % 20 = 1 AS u) x`,
    [tenantId, connectionId, o.anchorDate ?? '2026-11-01', o.sizeSource ?? null],
  );
}
