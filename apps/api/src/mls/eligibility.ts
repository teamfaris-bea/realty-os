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
//
// D9 (R-CMA-6, R-CMA-7: the licence-pack and eligibility parts; SECURITY NOTE, ARCHITECTURE §21.8b):
//   - valuationEligible decides whether a connection's sold data may be used for a valuation use now. agent_cma
//     needs a live connection and the pack's valuation.agent_cma (a stale feed is not blocked: the CMA says "MLS
//     data as of …", owner question (h)). client_cma and automated_notes also need the valuation section
//     counsel-reviewed with a statement for the subject's state, AND the connection client-eligible as above (display
//     pack reviewed, attribution, disclaimer, fresh feed; FEED_STALE has its own code). Every refusal is a code and
//     a sentence in words, never a silent empty result.
//   - clientSoldView renders a mirrored team sale for a client (F4): clientView refuses every mirror (the team row is
//     authoritative, E81), so a sold mirror is shown only here, as the team row's display plus the mirror's sold
//     fields, and only when the mirror passes every clientView condition except that refusal and the pack lists the
//     sold fields and 'sold'. clientView itself is unchanged.
import { type DisplayListing, EMPTY_VALUATION_FACTS, type LicensePack, type ListingFacts, type MlsConnectionId, type SaleCondition, STRICTEST_LICENSE_PACK, type ValuationFacts, type ValuationUse, applyDisplayRules, feedStale, packReviewed, parseLicensePack, staleNotice, valuationUse } from '@realty/core/listings';
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
  l.listing_brokerage_name, l.display_allowed, l.team_listing_id, l.last_seen_in_feed_at, l.off_market_at,
  l.close_price_cents, l.close_date::text AS close_date, l.purchase_contract_date::text AS purchase_contract_date, l.original_list_price_cents,
  l.concessions_cents, l.sale_conditions, l.days_on_market, l.latitude_e6, l.longitude_e6, l.geo_cell, l.year_built, l.lot_sqft, l.subdivision_name,
  l.garage_spaces_x10, l.stories_x10, l.pool_private, l.size_source, l.is_lease, l.avm_display_allowed, l.address_key, l.mls_normalize_version`;

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
  // D9 sale and property facts (R-CMA-1); dates as `YYYY-MM-DD` text, bigints as text or numbers
  close_price_cents: string | number | null;
  close_date: string | null;
  purchase_contract_date: string | null;
  original_list_price_cents: string | number | null;
  concessions_cents: string | number | null;
  sale_conditions: string[];
  days_on_market: number | null;
  latitude_e6: number | null;
  longitude_e6: number | null;
  geo_cell: number | null;
  year_built: number | null;
  lot_sqft: string | number | null;
  subdivision_name: string | null;
  garage_spaces_x10: number | null;
  stories_x10: number | null;
  pool_private: boolean | null;
  size_source: string | null;
  is_lease: boolean;
  avm_display_allowed: boolean;
  address_key: string | null;
  mls_normalize_version: number;
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
const num = (v: string | number | null): number | null => (v === null ? null : Number(v));

/** The stored sale and property facts of a row (team rows: the empty facts; only the MLS sync writes them). */
export function valuationOfRow(r: ListingRow): ValuationFacts {
  if (r.source !== 'mls') return EMPTY_VALUATION_FACTS;
  return {
    closePriceCents: num(r.close_price_cents),
    closeDate: r.close_date,
    contractDate: r.purchase_contract_date,
    originalListPriceCents: num(r.original_list_price_cents),
    concessionsCents: num(r.concessions_cents),
    saleConditions: (r.sale_conditions ?? []) as SaleCondition[],
    daysOnMarket: r.days_on_market,
    latitudeE6: r.latitude_e6,
    longitudeE6: r.longitude_e6,
    yearBuilt: r.year_built,
    lotSqft: num(r.lot_sqft),
    subdivisionName: r.subdivision_name,
    garageSpacesX10: r.garage_spaces_x10,
    poolPrivate: r.pool_private,
    storiesX10: r.stories_x10,
    sizeSource: r.size_source,
    isLease: r.is_lease,
    avmDisplayAllowed: r.avm_display_allowed,
    unreadable: [],
  };
}
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
    valuation: valuationOfRow(r),
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

// ---- valuation use (D9) -------------------------------------------------------------------------------

/**
 * Where an Owner or Admin records valuation use: module 41's MLS page (apps/web surfaces/integrations, "Valuation use"),
 * which sends V1-A's PUT /admin/mls/connections/:id/license-pack `valuation` body (batch 10 review api-ui/F2).
 */
export const VALUATION_USE_WHERE = 'An Owner or Admin records this from your MLS agreement on the MLS admin page, under Valuation use.';

export type ValuationRefusal = 'NO_MLS_CONNECTION' | 'MLS_NOT_LIVE' | 'PACK_DOES_NOT_ALLOW' | 'VALUATION_NOT_REVIEWED' | 'NO_VALUATION_STATEMENT' | 'MLS_NOT_CLIENT_ELIGIBLE' | 'FEED_STALE';

export const VALUATION_SENTENCE: Readonly<Record<ValuationRefusal, string>> = Object.freeze({
  NO_MLS_CONNECTION: 'There is no MLS connection to value this home from.',
  MLS_NOT_LIVE: 'The MLS connection is not live, so its sales cannot be used.',
  PACK_DOES_NOT_ALLOW: `The MLS licence pack does not record that this use of sold data is allowed. ${VALUATION_USE_WHERE}`,
  VALUATION_NOT_REVIEWED: 'The valuation part of the MLS licence pack is not marked as reviewed by counsel, so nothing built from MLS sales reaches a client.',
  NO_VALUATION_STATEMENT: "The MLS licence pack has no valuation statement for this home's state, so nothing built from MLS sales reaches a client.",
  MLS_NOT_CLIENT_ELIGIBLE: 'MLS data cannot reach clients: the display licence pack is not counsel-reviewed or lacks an attribution or a disclaimer.',
  FEED_STALE: 'The MLS data is older than the licence pack allows, so nothing built from it reaches a client until the feed is fresh.',
});

export type ValuationEligibility = { ok: true } | { ok: false; code: ValuationRefusal; sentence: string };
const refuse = (code: ValuationRefusal): ValuationEligibility => ({ ok: false, code, sentence: VALUATION_SENTENCE[code] });

/**
 * Whether one connection's sold data may be used for `use` now, for a subject in `region` (R-CMA-6, R-CMA-7: the
 * licence and eligibility parts). See the header. VERIFY WITH COUNSEL / MLS.
 */
export function valuationEligible(e: MlsEligibility, connectionId: string | null, use: ValuationUse, region: string | null, now: Instant): ValuationEligibility {
  const c = connectionId === null ? undefined : e.connections.find((x) => x.id === connectionId);
  if (c === undefined) return refuse('NO_MLS_CONNECTION');
  if (!LIVE.has(c.status)) return refuse('MLS_NOT_LIVE');
  const u = valuationUse(c.pack, use, region);
  if (!u.ok) return refuse(u.reason);
  if (use === 'agent_cma') return { ok: true };
  if (!packReviewed(c.pack) || c.pack.attributionText === null || c.pack.disclaimerText === null) return refuse('MLS_NOT_CLIENT_ELIGIBLE');
  if (feedStale(c.lastSyncedAt, now, c.pack)) return refuse('FEED_STALE');
  return { ok: true };
}

const SOLD_FIELDS = ['closePrice', 'closeDate'] as const;

/**
 * The client rendering of a mirrored team sale (F4, E366): the team row's display plus the mirror's sold fields, with
 * the pack's attribution and disclaimer; null unless the mirror passes every clientView condition but the
 * team_listing_id refusal and the pack lists the sold fields and 'sold' for clients.
 */
export function clientSoldView(e: MlsEligibility, mirror: ListingRow, team: ListingRow): DisplayListing | null {
  if (mirror.source !== 'mls' || team.source !== 'team' || mirror.team_listing_id !== team.id || mirror.status !== 'sold') return null;
  if (mirror.mls_connection_id === null || !e.clientIds.includes(mirror.mls_connection_id) || !mirror.display_allowed || mirror.is_lease) return null;
  const pack = e.pack(mirror.mls_connection_id)!;
  const rules = pack.audiences.client;
  if (!rules.statuses.includes('sold') || !SOLD_FIELDS.every((f) => rules.fields.includes(f))) return null;
  const m = applyDisplayRules({ ...factsOfRow(mirror), teamListingId: null }, pack, 'client');
  if (m === null) return null;
  // the team row's display without its (empty) sold fields: only the mirror's shown ones are added
  const { closePriceCents: _p, closeDate: _d, yearBuilt: _y, lotSqft: _l, subdivisionName: _s, ...t } = applyDisplayRules(factsOfRow(team), STRICTEST_LICENSE_PACK, 'client')!;
  return {
    ...t,
    status: 'sold',
    attribution: m.attribution,
    disclaimer: m.disclaimer,
    closePriceCents: m.closePriceCents ?? null,
    closeDate: m.closeDate ?? null,
    ...(m.yearBuilt !== undefined && { yearBuilt: m.yearBuilt }),
    ...(m.lotSqft !== undefined && { lotSqft: m.lotSqft }),
    ...(m.subdivisionName !== undefined && { subdivisionName: m.subdivisionName }),
  };
}
