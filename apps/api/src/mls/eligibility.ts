// Which MLS data may reach a client right now (R-MLS-2, R-MLS-3, R-MLS-5; E81, E85, E86).
//
// One place decides, and every client-facing path calls it (saved-search matching and alerts in
// assistant/searches.ts, the compliance sweep, the competing endpoint's pause):
//   - a connection's data is CLIENT-ELIGIBLE only while the connection is live (connected/degraded), its
//     licence pack is counsel-reviewed and carries an attribution and a disclaimer, and its feed is fresh
//     (core feedStale with the pack's max_staleness_hours; a pack without a limit is always stale);
//   - a row is client-eligible only when its connection is, the listing broker allows internet display
//     (display_allowed, E86), it does not mirror a team listing (team_listing_id IS NULL: the team row is
//     authoritative and the listing is counted once, E81), and core applyDisplayRules(client) shows it.
// Stale data is never sent: alerts are re-checked here at queue time and the sweep cancels queued ones.
// Reads run under the caller's RLS (any member may read listings and connection rows).
import { type DisplayListing, type LicensePack, type ListingFacts, type MlsConnectionId, STRICTEST_LICENSE_PACK, applyDisplayRules, feedStale, packReviewed, parseLicensePack, staleNotice } from '@realty/core/listings';
import type { IanaZone, Instant, ListingId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface MlsConnectionFacts {
  id: string;
  status: string;
  displayName: string;
  lastSyncedAt: Instant | null;
  pack: LicensePack;
}

export interface MlsEligibility {
  connections: MlsConnectionFacts[];
  /** connections whose rows may reach clients now */
  clientIds: string[];
  /** connections whose feed is stale now (R-MLS-3: their rows pause in alerts and competing sets) */
  staleIds: string[];
  pack(connectionId: string | null): LicensePack | null;
}

const LIVE = new Set(['connected', 'degraded']);

export async function mlsConnections(tx: Tx): Promise<MlsConnectionFacts[]> {
  const r = await sql<{ id: string; status: string; display_name: string; last_synced_at: Date | null; license_pack: unknown }>`
    SELECT id, status, display_name, last_synced_at, license_pack FROM integration_connections
     WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed' ORDER BY created_at, id`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, status: x.status, displayName: x.display_name, lastSyncedAt: x.last_synced_at ? (x.last_synced_at.getTime() as Instant) : null, pack: parseLicensePack(x.license_pack) }));
}

/** Whether a connection's data may reach clients at `now` (see the header). */
export function connectionClientEligible(c: MlsConnectionFacts, now: Instant): boolean {
  return LIVE.has(c.status) && packReviewed(c.pack) && c.pack.attributionText !== null && c.pack.disclaimerText !== null && !feedStale(c.lastSyncedAt, now, c.pack);
}

export async function mlsEligibility(tx: Tx, now: Instant): Promise<MlsEligibility> {
  const connections = await mlsConnections(tx);
  const byId = new Map(connections.map((c) => [c.id, c]));
  return {
    connections,
    clientIds: connections.filter((c) => connectionClientEligible(c, now)).map((c) => c.id),
    staleIds: connections.filter((c) => feedStale(c.lastSyncedAt, now, c.pack)).map((c) => c.id),
    pack: (id) => (id === null ? null : (byId.get(id)?.pack ?? null)),
  };
}

/** "MLS data as of …" for the freshest connection (R-MLS-3 UI notice). */
export function mlsAsOf(e: MlsEligibility, zone: IanaZone): string | null {
  if (e.connections.length === 0) return null;
  const last = e.connections.map((c) => c.lastSyncedAt).reduce<Instant | null>((a, b) => (b !== null && (a === null || b > a) ? b : a), null);
  return staleNotice(last, zone);
}

/**
 * The stored spellings of MLS cities that equal `cities` case-insensitively. Lets the candidate queries
 * compare `city` with plain equality (leakproof, so the RLS-bound planner can use listings_mls_city_idx);
 * lower(city) on row data would force a scan of every MLS row under RLS.
 */
export async function mlsCitySpellings(tx: Tx, cities: readonly string[]): Promise<string[]> {
  const want = new Set(cities.map((c) => c.trim().toLowerCase()).filter((c) => c !== ''));
  if (want.size === 0) return [];
  // a loose index scan over listings_mls_city_idx: one probe per distinct city, not one row per listing
  const r = await sql<{ city: string }>`
    WITH RECURSIVE c(city) AS (
      (SELECT l.city FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' ORDER BY l.city LIMIT 1)
      UNION ALL
      SELECT (SELECT l.city FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.city > c.city ORDER BY l.city LIMIT 1)
        FROM c WHERE c.city IS NOT NULL)
    SELECT city FROM c WHERE city IS NOT NULL LIMIT 20000`.execute(tx);
  return r.rows.map((x) => x.city).filter((c) => want.has(c.trim().toLowerCase()));
}

// ---- listing rows ----------------------------------------------------------------------------------

/** The listing columns every MLS-aware reader selects (LISTING_COLS) and their row type. */
export const LISTING_COLS = sql`l.id, l.source, l.mls_number, l.status, l.address_line1, l.address_line2, l.city, l.region, l.postal_code, l.list_price_cents,
  l.beds, l.baths_x10, l.sqft, l.property_type, l.description, l.list_date, l.attributes, l.mls_connection_id, l.mls_modified_at,
  l.listing_brokerage_name, l.display_allowed, l.team_listing_id, l.last_seen_in_feed_at, l.off_market_at`;

export interface ListingRow {
  id: string;
  source: 'team' | 'mls';
  mls_number: string | null;
  status: ListingFacts['status'];
  address_line1: string;
  address_line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  list_price_cents: string | number | null;
  beds: number | null;
  baths_x10: number | null;
  sqft: number | null;
  property_type: ListingFacts['propertyType'];
  description: string | null;
  list_date: Date | string | null;
  attributes: Record<string, unknown> | null;
  mls_connection_id: string | null;
  mls_modified_at: Date | null;
  listing_brokerage_name: string | null;
  display_allowed: boolean;
  team_listing_id: string | null;
  last_seen_in_feed_at: Date | null;
  off_market_at: Date | null;
}

/** What the sync keeps of an MLS record beyond the columns (listings.attributes.mls). */
export interface MlsAttributes {
  listing_key: string;
  address_display: boolean;
  photo_urls: string[];
  photos_count: number | null;
}

export function mlsAttributesOf(row: Pick<ListingRow, 'attributes'>): MlsAttributes | null {
  const m = row.attributes?.['mls'];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const a = m as Record<string, unknown>;
  return {
    listing_key: typeof a['listing_key'] === 'string' ? a['listing_key'] : '',
    address_display: a['address_display'] === true,
    photo_urls: Array.isArray(a['photo_urls']) ? a['photo_urls'].filter((u): u is string => typeof u === 'string') : [],
    photos_count: typeof a['photos_count'] === 'number' ? a['photos_count'] : null,
  };
}

const ms = (d: Date | null): Instant | null => (d ? (d.getTime() as Instant) : null);
const dateText = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** A listings row as core/listings facts. */
export function factsOfRow(r: ListingRow): ListingFacts {
  const a = r.source === 'mls' ? mlsAttributesOf(r) : null;
  return {
    id: r.id as ListingId,
    source: r.source,
    listingKey: a?.listing_key || null,
    mlsNumber: r.mls_number,
    status: r.status,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    region: r.region,
    postalCode: r.postal_code,
    listPriceCents: r.list_price_cents === null ? null : Number(r.list_price_cents),
    beds: r.beds,
    bathsX10: r.baths_x10,
    sqft: r.sqft,
    propertyType: r.property_type,
    description: r.description,
    listDate: dateText(r.list_date),
    mlsConnectionId: r.mls_connection_id as MlsConnectionId | null,
    mlsModifiedAt: ms(r.mls_modified_at),
    listingBrokerageName: r.listing_brokerage_name,
    displayAllowed: r.display_allowed,
    addressDisplayAllowed: a?.address_display ?? false,
    photoUrls: a?.photo_urls ?? [],
    photosCount: a?.photos_count ?? null,
    teamListingId: r.team_listing_id as ListingId | null,
    lastSeenInFeedAt: ms(r.last_seen_in_feed_at),
    offMarketAt: ms(r.off_market_at),
  };
}

/**
 * The client rendering of an MLS row, or null when it must not reach a client now. Team rows are not MLS
 * data and are never refused here (the caller keeps its Phase 1 rules for them).
 */
export function clientView(e: MlsEligibility, r: ListingRow): DisplayListing | null {
  const f = factsOfRow(r);
  if (r.source === 'team') return applyDisplayRules(f, STRICTEST_LICENSE_PACK, 'client'); // the pack does not govern team rows
  if (r.mls_connection_id === null || !e.clientIds.includes(r.mls_connection_id) || r.team_listing_id !== null || !r.display_allowed) return null;
  return applyDisplayRules(f, e.pack(r.mls_connection_id)!, 'client');
}
