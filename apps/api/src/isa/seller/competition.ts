// Competing listings for a seller (R-ISA-17, R-ISA-18; E535, E537; docs/AI_ISA.md §6.3 "New competing listings").
// Asking prices only: never sold data, so allowed before platform:cma (E534). core competingSet on the confirmed
// subject: postal code, any price, beds ±1, the same property type, size ±20 %, coming soon / active / pending, display
// allowed, live feeds only, and maxCount = every candidate (uncapped: the sort falls back to id order without a subject
// price). MLS rows only, never team rows or mirrors (owner question 12). The read is bounded at 5,000 rows: at the limit
// the run is skipped (WATCH_LIMIT_REACHED), never a partial picture. Each line is rendered by ISA-1 from the client
// DisplayListing with its own source and as-of (min of the row's last_seen_in_feed_at and its feed's last sync).
import { type CompetingRule, type ListingFacts, competingSet } from '@realty/core/listings';
import { smsSegments } from '@realty/core/texting';
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type ListingRow, type MlsEligibility, LISTING_COLS, clientRendering, factsOfRow } from './cmaSeam.js';
import { type CompetitorEvent, type FactSource, fitsSms, renderCompetitor } from './isa1Seam.js';
import type { SubjectFactsRow } from './subject.js';

/** The bounded read (§6.3; liveNearMatches reads the same bound). */
export const COMPETITION_READ_LIMIT = 5000;
/** At most this many competitors are offered to the model as handles in one bundle (H1). */
export const MAX_COMPETITION_HANDLES = 3;
/** SMS facts only within three segments with attribution (§6.1; VERIFY WITH MLS). */
export const SMS_FACT_PARTS = 3;

export const COMPETITION_RULE: Omit<CompetingRule, 'maxCount'> = {
  area: 'postal_code',
  priceBandPct: null,
  bedsDelta: 1,
  sqftBandPct: 20,
  samePropertyType: true,
  statuses: ['coming_soon', 'active', 'pending'],
  onlyDisplayAllowed: true,
  mlsFeedStale: false,
};

export interface Competitors {
  ok: boolean;
  code: 'WATCH_LIMIT_REACHED' | 'NO_SUBJECT' | null;
  rows: ListingRow[];
}

/** The competing MLS rows of the confirmed subject, read under the caller's RLS (live, client-eligible feeds only). */
export async function competitorsInTx(tx: Tx, e: MlsEligibility, subject: { recordRow: ListingRow; facts: SubjectFactsRow }): Promise<Competitors> {
  const zip = subject.recordRow.postal_code.trim().slice(0, 5);
  const live = e.clientIds.filter((id) => !e.staleIds.includes(id));
  if (zip.length !== 5 || live.length === 0) return { ok: true, code: null, rows: [] };
  const rows = (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.team_listing_id IS NULL
      AND NOT l.is_lease AND l.status = ANY (${[...COMPETITION_RULE.statuses]}::text[]) AND left(l.postal_code, 5) = ${zip}
      AND l.mls_connection_id = ANY (${live}::uuid[]) ORDER BY l.id LIMIT ${COMPETITION_READ_LIMIT + 1}`.execute(tx)).rows;
  if (rows.length > COMPETITION_READ_LIMIT) return { ok: false, code: 'WATCH_LIMIT_REACHED', rows: [] };
  const s: ListingFacts = { ...factsOfRow(subject.recordRow), beds: subject.facts.beds, sqft: subject.facts.sqft, propertyType: subject.facts.type as ListingFacts['propertyType'] };
  const self = new Set([subject.recordRow.id]);
  const candidates = rows.filter((r) => !self.has(r.id));
  const { listings } = competingSet(s, candidates.map(factsOfRow), { ...COMPETITION_RULE, maxCount: candidates.length });
  const byId = new Map(candidates.map((r) => [r.id, r]));
  return { ok: true, code: null, rows: listings.map((l) => byId.get(l.id!)!).filter((r) => r !== undefined) };
}

/**
 * A row's own source and as-of (§6.1): min(last_seen_in_feed_at, lastSyncedAt); fresh within max_staleness_hours.
 * VERIFY (engineering, verify item 4): the incremental feed moves last_seen_in_feed_at only on a changed record
 * (mls/sync.ts), so row freshness offers only recently changed rows; ISA-2b's buyer search has the same effect.
 */
export function sourceOf(e: MlsEligibility, row: ListingRow, teamName: string, now: Instant): FactSource | null {
  const conn = e.connections.find((c) => c.id === row.mls_connection_id);
  if (!conn || conn.lastSyncedAt === null) return null;
  const seen = row.last_seen_in_feed_at?.getTime() ?? null;
  const asOf = (seen === null ? conn.lastSyncedAt : Math.min(seen, conn.lastSyncedAt)) as Instant;
  const hours = conn.pack.maxStalenessHours;
  const fresh = seen !== null && hours !== null && now - asOf <= hours * 3_600_000;
  return { mlsName: conn.displayName, teamName, asOf, fresh };
}

export type CompetitorLine = { ok: true; line: string; channel: 'sms' | 'email' } | { ok: false; refusal: string };

/**
 * One competitor line, and the channel the line alone with its own footer fits (SMS only when fitsSms and smsSegments both
 * hold). H2 (index.ts renderSellerFactsInTx) decides a message's channel on the whole message as queued, never on this.
 */
export function competitorLine(e: MlsEligibility, row: ListingRow, event: CompetitorEvent, teamName: string, now: Instant): CompetitorLine {
  const d = clientRendering(e, row, null);
  const src = sourceOf(e, row, teamName, now);
  if (d === null || src === null) return { ok: false, refusal: 'NOT_DISPLAYABLE' };
  const r = renderCompetitor(d, src, event);
  if (!r.ok) return { ok: false, refusal: r.refusal };
  const withFoot = [r.line, d.attribution, d.disclaimer].filter((x) => x !== null && x !== '').join('\n');
  return { ok: true, line: r.line, channel: smsFits(withFoot) ? 'sms' : 'email' };
}

/** ISA-1's fitsSms counts some characters as one septet; the real segment count must agree (VERIFY item: fitsSms). */
export function smsFits(body: string): boolean {
  return fitsSms(body) && smsSegments(body).parts <= SMS_FACT_PARTS;
}
