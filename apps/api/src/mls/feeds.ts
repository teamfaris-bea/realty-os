// The record source the MLS sync reads (module 24). Two implementations, one shape:
//   - Spark (MLS_PROVIDER=spark): the read-only adapter's sanitized RESO records, Media expanded, with the
//     Spark field mapping (BuildingAreaTotal for the size). Opened only for a live connection, the key
//     decrypted by the system actor (mls/spark/service.ts openSparkFeed, R-INT-4).
//   - any other MlsFeed adapter (the deterministic fake in dev and tests; UnlicensedMls, which throws
//     NEEDS_MLS_LICENSE, in a real deployment without Spark): its ResoListing rows as RESO-shaped records.
// Nothing here talks to a network itself: Spark's kill switch (MLS_LIVE_CALLS) and allow-list are the
// adapter's.
import type { FactField, ResoLike } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import type { TenantId } from '@realty/core/foundation';
import { SPARK_FIELD_MAPPING } from '../providers/integrations/spark.js';
import type { MlsFeed, ResoListing } from '../providers/integrations/types.js';
import { getSparkConnection } from '../integrations/repos/connections.js';
import { type SparkDeps, openSparkFeed } from './spark/service.js';

export interface MlsRecordPage {
  records: ResoLike[];
  cursor: string | null;
  /** records the feed could not place on the cursor (no key or modification time) */
  unpositioned: number;
  /** more records may be waiting right now */
  more: boolean;
}

export interface MlsRecordFeed {
  /** per-MLS overrides for core normalizeMlsListing */
  readonly fields: Readonly<Partial<Record<FactField, string>>>;
  records(cursor: string | null, limit: number): Promise<MlsRecordPage>;
}

/** A ResoListing (the Phase 2 adapter shape) as a RESO record. Display flags are absent: never allowed. */
export function resoOfListing(l: ResoListing): ResoLike {
  return {
    ListingKey: l.listingKey,
    ListingId: l.listingId,
    StandardStatus: l.standardStatus,
    ListPrice: (l.listPriceCents / 100).toFixed(2),
    UnparsedAddress: l.unparsedAddress,
    City: l.city,
    StateOrProvince: l.stateOrProvince,
    PostalCode: l.postalCode,
    BedroomsTotal: l.bedroomsTotal,
    BathroomsTotalInteger: l.bathroomsTotalX10 === null ? null : l.bathroomsTotalX10 / 10,
    LivingArea: l.livingAreaSqft,
    PropertyType: l.propertyType,
    ListOfficeName: l.listOfficeName,
    ModificationTimestamp: l.modificationTimestamp,
  };
}

export function adapterRecordFeed(feed: MlsFeed): MlsRecordFeed {
  return {
    fields: {},
    async records(cursor, limit) {
      const page = await feed.changes(cursor, limit);
      return { records: page.listings.map(resoOfListing), cursor: page.cursor, unpositioned: 0, more: page.listings.length >= limit };
    },
  };
}

/**
 * The record feed of a live connection, or null when this deployment has none for it. Runs in the sync's
 * first (system) transaction; the returned feed is used outside any transaction.
 */
export async function openRecordFeed(deps: SparkDeps, tx: Tx, tenantId: TenantId, connectionId: string, adapters: { mlsFeed: MlsFeed }): Promise<MlsRecordFeed | null> {
  if (deps.mls.provider === 'spark') {
    // the tenant's Spark connection only (an older mls_feed row is not read with its key)
    const conn = await getSparkConnection(tx);
    if (!conn || conn.id !== connectionId) return null;
    const spark = await openSparkFeed(deps, tx, tenantId);
    if (!spark) return null;
    return { fields: SPARK_FIELD_MAPPING, records: (c, n) => spark.records(c, n) };
  }
  return adapterRecordFeed(adapters.mlsFeed);
}
