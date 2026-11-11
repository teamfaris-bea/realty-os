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

/** A live mls_feed connection (system actor), with a placeholder credential row; returns its id. */
export async function mlsConnection(h: ApiHarness, tenantId: string, createdByUserId: string, o: { pack?: Record<string, unknown>; status?: 'connected' | 'degraded'; lastSyncedAt?: Date | null } = {}): Promise<string> {
  const id = randomUUID();
  const credId = randomUUID();
  await withTenantTx(
    systemActor(tenantId, 'provider'),
    async (tx) => {
      await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref, created_by_user_id)
                VALUES (app.tenant_id(), ${credId}, 'mls', ${randomBytes(48)}, 1, 'test-feed', ${createdByUserId})`.execute(tx);
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, connected_at, license_pack, last_synced_at)
                VALUES (app.tenant_id(), ${id}, 'mls_feed', ${o.status ?? 'connected'}, 'Test MLS feed', ${`test:${id}`}, ${credId}, now(),
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
