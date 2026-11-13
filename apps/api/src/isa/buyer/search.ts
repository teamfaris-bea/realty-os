// Which listings the AI may share with a buyer, and their fact lines (ISA-2b item 10; R-ISA-17, R-ISA-7, R-MLS-2/3/4/5;
// docs/AI_ISA.md §6.1, §6.2). One rule set, run when the bundle is built (TX-A), again when the facts message is built
// (TX-B) and again at dispatch (TX1): a row is shared only when ALL hold. VERIFY WITH MLS (C-ISA-8) every rule.
//
//   MLS row   clientView not null (live, reviewed, attributed connection; display_allowed; not a team mirror); active
//             or coming_soon; its own feed row fresh (feedStale over last_seen_in_feed_at); NOT is_lease AND
//             mls_normalize_version >= 2 (batch 10's lease flag; older rows: LEASE_UNCHECKED); off_market_at null.
//   team row  active, with a live MLS mirror (team_listing_id = its id) that is display_allowed, client-eligible,
//             fresh, active, not a lease and normalized: "listed as Active in the MLS as of" is then true. An
//             off-MLS, office-exclusive or coming-soon team listing is never shared (TEAM_NOT_ON_MLS).
//   both      renderBuyerListing succeeds (status and price not omitted, brokerage and attribution present).
import type { Instant } from '@realty/core/foundation';
import { feedStale, NORMALIZE_VERSION } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { clientView, LISTING_COLS, type ListingRow, type MlsEligibility } from '../../mls/eligibility.js';
import { renderBuyerListing } from '../coreSeam.js';

/** Batch 10's normalization version, the first that sets the lease flag (core NORMALIZE_VERSION). */
export const LEASE_CHECKED_NORMALIZE_VERSION = 2;
void NORMALIZE_VERSION;

export type ShareRefusal = 'MLS_NOT_ELIGIBLE' | 'STATUS_NOT_SHAREABLE' | 'OFF_MARKET' | 'LEASE_UNCHECKED' | 'ROW_STALE' | 'TEAM_NOT_ON_MLS' | 'RENDER_REFUSED' | 'NOT_FOUND';

export interface ShareableFact {
  listingId: string;
  connectionId: string;
  factKind: 'listing_active' | 'listing_coming_soon';
  status: 'active' | 'coming_soon';
  priceCents: number;
  asOf: Instant;
  line: string;
  attribution: string | null;
  disclaimer: string | null;
  sourceName: string;
  label: { beds: number | null; baths: number | null; propertyType: string | null; city: string | null };
}

type Row = ListingRow & { is_lease: boolean; mls_normalize_version: number };

async function rowOf(tx: Tx, id: string): Promise<Row | null> {
  const r = await sql<Row>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

async function mirrorOf(tx: Tx, teamId: string): Promise<Row | null> {
  const r = await sql<Row>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls'
    AND l.team_listing_id = ${teamId} ORDER BY l.mls_modified_at DESC NULLS LAST LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

const leaseChecked = (r: Row) => !r.is_lease && Number(r.mls_normalize_version) >= LEASE_CHECKED_NORMALIZE_VERSION;

/** The MLS feed checks shared by an MLS row and a team row's mirror. */
function feedCheck(e: MlsEligibility, r: Row, now: Instant): ShareRefusal | null {
  if (r.mls_connection_id === null || !e.clientIds.includes(r.mls_connection_id) || !r.display_allowed) return 'MLS_NOT_ELIGIBLE';
  if (r.off_market_at !== null) return 'OFF_MARKET';
  if (!leaseChecked(r)) return 'LEASE_UNCHECKED';
  const pack = e.pack(r.mls_connection_id)!;
  if (r.last_seen_in_feed_at === null || feedStale(r.last_seen_in_feed_at.getTime() as Instant, now, pack)) return 'ROW_STALE';
  return null;
}

/** One listing's shareable fact under every rule above, or the refusal. */
export async function shareableFactInTx(tx: Tx, e: MlsEligibility, listingId: string, teamName: string, now: Instant): Promise<{ ok: true; fact: ShareableFact } | { ok: false; code: ShareRefusal }> {
  const r = await rowOf(tx, listingId);
  if (r === null) return { ok: false, code: 'NOT_FOUND' };
  let feedRow: Row;
  if (r.source === 'team') {
    if (r.status !== 'active') return { ok: false, code: 'TEAM_NOT_ON_MLS' };
    const m = await mirrorOf(tx, r.id);
    if (m === null || m.status !== 'active' || feedCheck(e, m, now) !== null) return { ok: false, code: 'TEAM_NOT_ON_MLS' };
    feedRow = m;
  } else {
    if (r.team_listing_id !== null) return { ok: false, code: 'MLS_NOT_ELIGIBLE' };
    if (r.status !== 'active' && r.status !== 'coming_soon') return { ok: false, code: 'STATUS_NOT_SHAREABLE' };
    const bad = feedCheck(e, r, now);
    if (bad !== null) return { ok: false, code: bad };
    feedRow = r;
  }
  const d = clientView(e, r);
  if (d === null) return { ok: false, code: 'MLS_NOT_ELIGIBLE' };
  const conn = e.connections.find((c) => c.id === feedRow.mls_connection_id)!;
  const seen = feedRow.last_seen_in_feed_at!.getTime();
  const asOf = (conn.lastSyncedAt !== null ? Math.min(seen, conn.lastSyncedAt) : seen) as Instant;
  const rendered = renderBuyerListing(d, { mlsName: conn.displayName, teamName, asOf, fresh: true });
  if (!rendered.ok) return { ok: false, code: 'RENDER_REFUSED' };
  const pack = e.pack(feedRow.mls_connection_id);
  return {
    ok: true,
    fact: {
      listingId: r.id, connectionId: feedRow.mls_connection_id!, factKind: d.status === 'coming_soon' ? 'listing_coming_soon' : 'listing_active', status: d.status as 'active' | 'coming_soon',
      priceCents: d.listPriceCents as number, asOf, line: rendered.line, attribution: d.attribution ?? pack?.attributionText ?? null, disclaimer: d.disclaimer ?? pack?.disclaimerText ?? null,
      sourceName: conn.displayName,
      label: { beds: d.beds ?? null, baths: d.bathsX10 === undefined || d.bathsX10 === null ? null : d.bathsX10 / 10, propertyType: d.propertyType ?? null, city: d.locality?.city ?? null },
    },
  };
}

/** Listings this person (any record) already got, or may have got, in the repeat window (Q6: 90 days). */
export async function recentlySharedListingIds(tx: Tx, contactId: string, days: number): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    SELECT f.listing_id AS id FROM ai_isa_shared_facts f LEFT JOIN messages m ON m.tenant_id = f.tenant_id AND m.id = f.message_id
     WHERE f.tenant_id = app.tenant_id() AND f.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)) AND f.listing_id IS NOT NULL
       AND f.created_at >= now() - make_interval(days => ${days})
       AND (f.status = 'sent' OR (f.status = 'pending' AND m.status = 'dispatch_unknown'))
    UNION
    SELECT sm.listing_id FROM saved_search_matches sm JOIN saved_searches s ON s.tenant_id = sm.tenant_id AND s.id = sm.search_id
     JOIN messages m ON m.tenant_id = sm.tenant_id AND m.id = sm.alerted_message_id
     WHERE sm.tenant_id = app.tenant_id() AND s.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
       AND m.created_at >= now() - make_interval(days => ${days})`.execute(tx);
  return new Set(r.rows.map((x) => x.id));
}
