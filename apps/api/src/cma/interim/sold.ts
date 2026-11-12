// INTERIM (lane V1-C, until lane V1-A merges): the MLS sold-data reads of api/mls.
//
// V1-A owns soldCandidates (with its tier reads and index plan), mlsRowsAtAddress, liveNearMatches and the valuation facts
// of factsOfRow (R-CMA-1, R-CMA-2; F2, F6). Lane V1-C may not edit api/mls, so these stand-ins carry the same names and
// read S0's columns (migration 0061) under the caller's RLS; apps/api/src/cma/deps.ts re-exports them. At the V1-A merge
// deps.ts points at api/mls and this file is deleted. The query plans here are not V1-A's (its 500k budget is its own).
// Reads only property, transaction, time and location columns (R-CMA-2): no description, photos, contact or prediction.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { LISTING_COLS, type ListingRow } from '../../mls/eligibility.js';
import { addressKeyBase, cellsAround, distanceMiles } from './address.js';
import type { CmaPropertyType, CmaSale, CmaTier, SaleCondition } from './valuation.js';

export interface ValuationRow extends ListingRow {
  close_price_cents: string | number | null;
  close_date: Date | string | null;
  purchase_contract_date: Date | string | null;
  original_list_price_cents: string | number | null;
  concessions_cents: string | number | null;
  sale_conditions: SaleCondition[];
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
}

// LISTING_COLS + S0's valuation columns (0061)
const COLS = sql`${LISTING_COLS}, l.close_price_cents, l.close_date, l.purchase_contract_date, l.original_list_price_cents, l.concessions_cents,
  l.sale_conditions, l.days_on_market, l.latitude_e6, l.longitude_e6, l.geo_cell, l.year_built, l.lot_sqft, l.subdivision_name, l.garage_spaces_x10,
  l.stories_x10, l.pool_private, l.size_source, l.is_lease, l.avm_display_allowed, l.address_key`;

const num = (v: string | number | null): number | null => (v === null ? null : Number(v));
const day = (d: Date | string | null): string | null => (d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));

/** A listing row's valuation facts (V1-A: factsOfRow's `valuation`). */
export function saleOfRow(r: ValuationRow): CmaSale {
  return {
    status: r.status,
    closePriceCents: num(r.close_price_cents),
    closeDate: day(r.close_date),
    contractDate: day(r.purchase_contract_date),
    originalListPriceCents: num(r.original_list_price_cents),
    concessionsCents: num(r.concessions_cents),
    saleConditions: [...r.sale_conditions],
    daysOnMarket: r.days_on_market,
    propertyType: r.property_type as CmaPropertyType | null,
    sqft: r.sqft,
    sizeSource: r.size_source,
    beds: r.beds,
    bathsX10: r.baths_x10,
    yearBuilt: r.year_built,
    lotSqft: num(r.lot_sqft),
    latE6: r.latitude_e6,
    lonE6: r.longitude_e6,
    subdivision: r.subdivision_name,
    postalCode: r.postal_code,
    isLease: r.is_lease,
  };
}

export async function listingRow(tx: Tx, id: string): Promise<ValuationRow | null> {
  return (await sql<ValuationRow>`SELECT ${COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${id}::uuid`.execute(tx)).rows[0] ?? null;
}

export async function listingRows(tx: Tx, ids: readonly string[]): Promise<ValuationRow[]> {
  if (ids.length === 0) return [];
  return (await sql<ValuationRow>`SELECT ${COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ANY (${[...ids]}::uuid[]) ORDER BY l.id`.execute(tx)).rows;
}

/** The MLS mirrors of a team listing (R-MLS-5), newest first. */
export async function mirrorsOf(tx: Tx, teamListingId: string): Promise<ValuationRow[]> {
  return (await sql<ValuationRow>`SELECT ${COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.team_listing_id = ${teamListingId}::uuid
    ORDER BY l.mls_modified_at DESC NULLS LAST, l.id`.execute(tx)).rows;
}

export interface SoldQuery {
  connectionIds: readonly string[];
  propertyType: CmaPropertyType;
  valuationDate: string;
  fromDate: string;
  limit: number;
  subject: { latE6: number | null; lonE6: number | null; subdivision: string | null; postalCode: string | null; city: string | null; citySpellings: readonly string[]; region: string | null };
  subdivisionMiles: number;
}

export interface SoldRead {
  tier: CmaTier;
  ran: boolean;
  rows: ValuationRow[];
  limitReached: boolean;
}

/**
 * Every tier's most recent closed sales in one statement (F6): each tier is its own LIMITed branch, so the engine sees
 * each tier's own recent sales and whether its limit was reached. Leases and other property types are never read.
 */
export async function soldCandidates(tx: Tx, q: SoldQuery): Promise<SoldRead[]> {
  if (q.connectionIds.length === 0) return [];
  const s = q.subject;
  const zip = s.postalCode ? s.postalCode.trim().slice(0, 5) : null;
  const geo = s.latE6 !== null && s.lonE6 !== null;
  const base = sql`l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.mls_connection_id = ANY (${[...q.connectionIds]}::uuid[])
    AND l.status = 'sold' AND l.is_lease = false AND l.property_type = ${q.propertyType} AND l.close_price_cents > 0
    AND l.close_date <= ${q.valuationDate}::date AND l.close_date >= ${q.fromDate}::date`;
  const lim = q.limit + 1;
  const branches: { tier: CmaTier; where: ReturnType<typeof sql> | null }[] = [
    {
      tier: 'subdivision',
      where:
        s.subdivision === null
          ? null
          : geo
            ? sql`l.subdivision_name = ${s.subdivision} AND (l.postal_code LIKE ${`${zip ?? '#'}%`} OR l.geo_cell = ANY (${cellsAround(s.latE6!, s.lonE6!, q.subdivisionMiles)}::int[]))`
            : zip
              ? sql`l.subdivision_name = ${s.subdivision} AND l.postal_code LIKE ${`${zip}%`}`
              : null,
    },
    { tier: 'radius_1mi', where: geo ? sql`l.geo_cell = ANY (${cellsAround(s.latE6!, s.lonE6!, 1)}::int[])` : null },
    { tier: 'postal_code', where: zip ? sql`l.postal_code LIKE ${`${zip}%`}` : null },
    { tier: 'city', where: s.city && s.region && s.citySpellings.length > 0 ? sql`l.city = ANY (${[...s.citySpellings]}::text[]) AND l.region = ${s.region}` : null },
  ];
  const ran = branches.filter((b) => b.where !== null);
  if (ran.length === 0) return branches.map((b) => ({ tier: b.tier, ran: false, rows: [], limitReached: false }));
  const parts = ran.map((b) => sql`(SELECT ${sql.lit(b.tier)}::text AS cma_tier, ${COLS} FROM listings l WHERE ${base} AND ${b.where!} ORDER BY l.close_date DESC, l.id LIMIT ${lim})`);
  const rows = (await sql<ValuationRow & { cma_tier: CmaTier }>`${sql.join(parts, sql` UNION ALL `)}`.execute(tx)).rows;
  return branches.map((b) => {
    if (b.where === null) return { tier: b.tier, ran: false, rows: [], limitReached: false };
    let mine = rows.filter((r) => r.cma_tier === b.tier);
    // the cells are a square; the tiers are circles
    if (b.tier === 'radius_1mi' || (b.tier === 'subdivision' && geo)) {
      const miles = b.tier === 'radius_1mi' ? 1 : q.subdivisionMiles;
      mine = mine.filter(
        (r) =>
          (b.tier === 'subdivision' && zip !== null && r.postal_code.trim().slice(0, 5) === zip) ||
          (r.latitude_e6 !== null && r.longitude_e6 !== null && distanceMiles({ latE6: s.latE6!, lonE6: s.lonE6! }, { latE6: r.latitude_e6, lonE6: r.longitude_e6 }) <= miles),
      );
    }
    const limitReached = rows.filter((r) => r.cma_tier === b.tier).length > q.limit;
    return { tier: b.tier, ran: true, rows: mine.slice(0, q.limit), limitReached };
  });
}

/** Every MLS record at an address key: the subject's own history (E365). */
export async function mlsRowsAtAddress(tx: Tx, key: string): Promise<ValuationRow[]> {
  return (await sql<ValuationRow>`SELECT ${COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.address_key = ${key}
    ORDER BY l.close_date DESC NULLS LAST, l.mls_modified_at DESC NULLS LAST, l.id LIMIT 200`.execute(tx)).rows;
}

export const LIVE_STATUSES = ['coming_soon', 'active', 'pending'] as const;

/**
 * Live MLS listings that may be the subject although their key differs (F2): same street number, ZIP and state, and a
 * street name that differs only in its suffix or unit, or by at most two letters. VERIFY (engineering): the rule.
 */
export async function liveNearMatches(tx: Tx, key: string): Promise<ValuationRow[]> {
  const [street, zip] = key.split('|');
  const num = (street ?? '').split(' ')[0] ?? '';
  if (!zip || num === '') return [];
  const rows = (await sql<ValuationRow>`SELECT ${COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls'
      AND l.status = ANY (${[...LIVE_STATUSES]}::text[]) AND l.postal_code LIKE ${`${zip}%`} AND l.address_key IS NOT NULL AND l.address_key <> ${key}
      AND l.address_key LIKE ${`${num} %`} ORDER BY l.id LIMIT 200`.execute(tx)).rows;
  const mine = nameOf(addressKeyBase(key));
  return rows.filter((r) => {
    const other = nameOf(addressKeyBase(r.address_key!));
    return addressKeyBase(r.address_key!) === addressKeyBase(key) || other.core === mine.core || editDistance(other.core, mine.core) <= 2;
  });
}

const SUFFIXES = new Set(['st', 'ave', 'blvd', 'dr', 'rd', 'ln', 'ct', 'pl', 'ter', 'cir', 'pkwy', 'hwy', 'trl', 'way', 'sq']);
function nameOf(base: string): { core: string } {
  const words = (base.split('|')[0] ?? '').split(' ').slice(1);
  return { core: words.filter((w) => !SUFFIXES.has(w)).join(' ') };
}
function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0]![j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length]![b.length]!;
}
