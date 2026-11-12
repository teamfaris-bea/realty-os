// Sold-data reads for valuations (D9; module 24, used by api/cma, lane V1-C). R-CMA-1, R-CMA-2 (the candidate read),
// R-TEN-1. SECURITY NOTE (ARCHITECTURE §21.8b):
//   - Every read runs under the CALLER's RLS (any member may read listings), with plain-column predicates only: int4
//     geo cells, text postal codes and spellings, date windows, uuid connection ids. They are leakproof on PG16, so
//     under FORCE RLS they stay index conditions on the migration's partial indexes (0101 placeholder). No definer,
//     no function on row data.
//   - Candidates are closed MLS sales only: source 'mls', status 'sold', not a lease, a close date inside the window.
//     `close_date IS NOT NULL` matters: close_date DESC sorts NULLs first, so rows the backfill has not filled would
//     otherwise fill every limit. Rows are evidence for the engine (core/valuation, lane V1-B), which decides what a
//     comparable is and measures real distances; nothing here is shown to a client (R-CMA-7 is api/cma's).
//   - Each tier is one ordered, limited read. A tier over several spellings or postal codes runs one ordered, limited
//     subquery per value (UNION ALL): `= ANY` on a leading index column does not return close-date order on PG16, so
//     the limit would need every matching row first. Distance tiers read `geo_cell = ANY(cells)` inside the date
//     window, which the area bounds. Each read reports whether it hit its limit (F6: the engine says so).
//   - Subdivision and city spellings come from a loose index scan (the mlsCitySpellings pattern), so the tier queries
//     compare stored spellings with plain equality.
//   - The sold team rows whose MLS mirrors are in the result are returned too, by primary key (F4, E366): the team
//     row is authoritative (R-MLS-5) and the engine combines it with the mirror's close price.
import type { Tx } from '@realty/db';
import { addressKey, streetOfKey } from '@realty/core/listings';
import { sql } from 'kysely';
import { LISTING_COLS, type ListingRow } from './eligibility.js';

/** Rows per tier read and for the rate pool. VERIFY (engineering): replaced by core/valuation CMA_DEFAULTS at merge (lane V1-B). */
export const SOLD_TIER_LIMIT = 300;
export const SOLD_RATE_POOL_LIMIT = 600;
/** Distinct spellings a loose scan returns at most (a bound on the work, not a product rule). */
const MAX_SPELLINGS = 20_000;

export type SoldTier = 'subdivision' | 'cells_1mi' | 'postal_code' | 'cells_3mi' | 'city' | 'rate_pool';

/**
 * One tier's area. Subdivision: the subject's subdivision (any stored spelling of it) within its postal codes or its
 * cells (the engine applies "same postal code or 3 mi", E362). Distance tiers and the rate pool: geo cells (core
 * cellsWithin). Postal code: 5-digit codes. City: spellings of the city within its region.
 */
export type TierQuery =
  | { tier: 'subdivision'; names: readonly string[]; postalCodes: readonly string[]; cells: readonly number[]; limit?: number }
  | { tier: 'cells_1mi' | 'cells_3mi'; cells: readonly number[]; limit?: number }
  | { tier: 'postal_code'; postalCodes: readonly string[]; limit?: number }
  | { tier: 'city'; cities: readonly string[]; region: string; limit?: number }
  | { tier: 'rate_pool'; cells: readonly number[]; postalCodes: readonly string[]; limit?: number };

export interface SoldQuery {
  /** the client-eligible or agent-usable MLS connections (valuationEligible decides; empty ⇒ nothing) */
  connectionIds: readonly string[];
  /** the subject's property type; null ⇒ any (the engine requires a type, R-CMA-2) */
  propertyType: string | null;
  /** `YYYY-MM-DD`, inclusive */
  since: string;
  /** `YYYY-MM-DD`, inclusive (the valuation date: a later close is never read, E363) */
  until: string;
  tiers: readonly TierQuery[];
}

export interface SoldCandidates {
  /** MLS sales of every tier, de-duplicated by id, then the sold team rows their mirrors name */
  rows: ListingRow[];
  reads: { tier: SoldTier; rows: number; limitReached: boolean }[];
}

const DEFAULT_LIMIT: Record<SoldTier, number> = { subdivision: SOLD_TIER_LIMIT, cells_1mi: SOLD_TIER_LIMIT, postal_code: SOLD_TIER_LIMIT, cells_3mi: SOLD_TIER_LIMIT, city: SOLD_TIER_LIMIT, rate_pool: SOLD_RATE_POOL_LIMIT };

/** Stored spellings of a text column among sold MLS rows that equal `wanted` case- and space-insensitively (loose index scan). */
async function soldSpellings(tx: Tx, column: 'subdivision_name' | 'city', wanted: readonly string[]): Promise<string[]> {
  const fold = (s: string) => s.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  const want = new Set(wanted.map(fold).filter((x) => x !== ''));
  if (want.size === 0) return [];
  const col = sql.ref(`l.${column}`);
  const extra = column === 'subdivision_name' ? sql`AND l.subdivision_name IS NOT NULL` : sql``;
  const r = await sql<{ v: string }>`
    WITH RECURSIVE c(v) AS (
      (SELECT ${col} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.status = 'sold' AND NOT l.is_lease AND l.close_date IS NOT NULL ${extra}
        ORDER BY ${col} LIMIT 1)
      UNION ALL
      SELECT (SELECT ${col} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.status = 'sold' AND NOT l.is_lease AND l.close_date IS NOT NULL ${extra}
                 AND ${col} > c.v ORDER BY ${col} LIMIT 1)
        FROM c WHERE c.v IS NOT NULL)
    SELECT v FROM c WHERE v IS NOT NULL LIMIT ${MAX_SPELLINGS}`.execute(tx);
  return r.rows.map((x) => x.v).filter((v) => want.has(fold(v)));
}

const SOLD = sql`l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.status = 'sold' AND NOT l.is_lease AND l.close_date IS NOT NULL`;

function soldWindow(q: SoldQuery) {
  const type = q.propertyType === null ? sql`` : sql`AND l.property_type = ${q.propertyType}`;
  return sql`${SOLD} AND l.close_date BETWEEN ${q.since}::date AND ${q.until}::date AND l.mls_connection_id = ANY (${[...q.connectionIds]}::uuid[]) ${type}`;
}

/** One ordered, limited subquery per value, unioned, then ordered and limited again. */
function perValue(q: SoldQuery, eq: ReturnType<typeof sql>[], limit: number, filter = sql``) {
  const parts = eq.map((e) => sql`(SELECT ${LISTING_COLS} FROM listings l WHERE ${soldWindow(q)} AND ${e} ${filter} ORDER BY l.close_date DESC, l.id LIMIT ${limit})`);
  return sql<ListingRow>`SELECT * FROM (${sql.join(parts, sql` UNION ALL `)}) u ORDER BY u.close_date DESC, u.id LIMIT ${limit}`;
}

async function readTier(tx: Tx, q: SoldQuery, t: TierQuery): Promise<ListingRow[]> {
  const limit = Math.max(1, Math.min(t.limit ?? DEFAULT_LIMIT[t.tier], 2000));
  switch (t.tier) {
    case 'cells_1mi':
    case 'cells_3mi': {
      if (t.cells.length === 0) return [];
      return (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE ${soldWindow(q)} AND l.geo_cell = ANY (${[...t.cells]}::int[])
                                     ORDER BY l.close_date DESC, l.id LIMIT ${limit}`.execute(tx)).rows;
    }
    case 'postal_code': {
      const zips = [...new Set(t.postalCodes)];
      if (zips.length === 0) return [];
      return (await perValue(q, zips.map((z) => sql`l.postal_code = ${z}`), limit).execute(tx)).rows;
    }
    case 'city': {
      const spellings = await soldSpellings(tx, 'city', t.cities);
      if (spellings.length === 0) return [];
      return (await perValue(q, spellings.map((c) => sql`l.city = ${c} AND l.region = ${t.region}`), limit).execute(tx)).rows;
    }
    case 'subdivision': {
      const spellings = await soldSpellings(tx, 'subdivision_name', t.names);
      if (spellings.length === 0 || (t.postalCodes.length === 0 && t.cells.length === 0)) return [];
      const near = sql`AND (l.postal_code = ANY (${[...t.postalCodes]}::text[]) OR l.geo_cell = ANY (${[...t.cells]}::int[]))`;
      return (await perValue(q, spellings.map((n) => sql`l.subdivision_name = ${n}`), limit, near).execute(tx)).rows;
    }
    case 'rate_pool': {
      const byCell = t.cells.length === 0 ? [] : await readTier(tx, q, { tier: 'cells_3mi', cells: t.cells, limit });
      const byZip = t.postalCodes.length === 0 ? [] : await readTier(tx, q, { tier: 'postal_code', postalCodes: t.postalCodes, limit });
      const seen = new Set<string>();
      return [...byCell, ...byZip]
        .filter((r) => !seen.has(r.id) && (seen.add(r.id), true))
        .sort((a, b) => (a.close_date! < b.close_date! ? 1 : a.close_date! > b.close_date! ? -1 : a.id < b.id ? -1 : 1))
        .slice(0, limit);
    }
  }
}

/** Closed MLS sales per tier (see the header), the sold team rows their mirrors name, and what each read hit. */
export async function soldCandidates(tx: Tx, q: SoldQuery): Promise<SoldCandidates> {
  if (q.connectionIds.length === 0) return { rows: [], reads: q.tiers.map((t) => ({ tier: t.tier, rows: 0, limitReached: false })) };
  const byId = new Map<string, ListingRow>();
  const reads: SoldCandidates['reads'] = [];
  for (const t of q.tiers) {
    const rows = await readTier(tx, q, t);
    reads.push({ tier: t.tier, rows: rows.length, limitReached: rows.length >= Math.max(1, Math.min(t.limit ?? DEFAULT_LIMIT[t.tier], 2000)) });
    for (const r of rows) if (!byId.has(r.id)) byId.set(r.id, r);
  }
  const teamIds = [...new Set([...byId.values()].map((r) => r.team_listing_id).filter((x): x is string => x !== null))];
  const team = teamIds.length === 0 ? [] : (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'team' AND l.id = ANY (${teamIds}::uuid[]) ORDER BY l.id`.execute(tx)).rows;
  return { rows: [...byId.values(), ...team], reads };
}

/** The MLS rows at one address key, any status, newest first (the subject's sale history and its live listings, E365). */
export async function mlsRowsAtAddress(tx: Tx, key: string): Promise<ListingRow[]> {
  return (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.address_key = ${key}
                                ORDER BY l.mls_modified_at DESC, l.id LIMIT 100`.execute(tx)).rows;
}

/** Street-type and directional tokens a near match ignores ("40 Marsh Ln" ~ "40 W Marsh Lane"). */
const NEAR_IGNORED = new Set(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw', 'st', 'ave', 'blvd', 'rd', 'dr', 'ln', 'ct', 'pl', 'ter', 'cir', 'pkwy', 'hwy', 'sq', 'trl', 'way']);
const nameCore = (tokens: readonly string[]) => tokens.filter((t) => !NEAR_IGNORED.has(t)).join(' ');

/**
 * The live MLS rows (coming soon, active, pending) in the same 5-digit postal code with the same street number and
 * street-name tokens (F2), ignoring street-type, directional and unit differences. Uses listings_mls_postal_idx (the
 * stored PostalCode compared with plain equality; VERIFY WITH MLS that the feed sends the 5-digit code). E370: a
 * near match blocks sharing until the agent confirms it is a different home (api/cma).
 */
export async function liveNearMatches(tx: Tx, o: { postalCode: string; streetNumber: string; streetNameTokens: readonly string[] }): Promise<ListingRow[]> {
  const zip = (o.postalCode.match(/\d/g) ?? []).join('').slice(0, 5);
  if (zip.length !== 5) return [];
  const want = nameCore(o.streetNameTokens);
  const r = await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls'
                                    AND l.postal_code = ${zip} AND l.status IN ('coming_soon','active','pending')
                                  ORDER BY l.mls_modified_at DESC, l.id LIMIT 5000`.execute(tx);
  return r.rows.filter((row) => {
    const key = row.address_key ?? addressKey({ line1: row.address_line1, line2: row.address_line2, city: row.city, region: row.region, postalCode: row.postal_code });
    const s = key === null ? null : streetOfKey(key);
    return s !== null && s.streetNumber === o.streetNumber.toLowerCase() && nameCore(s.streetNameTokens) === want;
  });
}
