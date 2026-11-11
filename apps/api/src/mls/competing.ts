// GET /listings/:id/competing (PHASE2_3_PLAN §5.4 #24; R-MLS-3, R-MLS-4, R-MLS-5; E81, E85).
//
// The agent's back-office view of the listings competing with one listing: core competingSet over the
// tenant's team listings and the MLS rows of live connections, in core's deterministic order, each with why
// it matched. Runs under the caller's RLS (every member may read listings).
//   - R-MLS-3: an MLS connection whose feed is stale contributes nothing (its rows pause) and the response
//     says "MLS data as of …"; team listings remain.
//   - R-MLS-5 / E81: a mirrored team listing is counted once (the team row is authoritative) and a status
//     disagreement between the team row and its MLS copy is reported.
//   - R-MLS-4: every MLS listing is labelled MLS with its listing brokerage, never the team's own.
// The agent audience only: client-facing renderings (seller updates, portal) call core applyDisplayRules
// with the client audience in their own modules.
import { type CompetingRule, type CriterionMatch, DEFAULT_COMPETING_RULE, type DisplayListing, type MirrorStatusMismatch, applyDisplayRules, competingSet, dedupeMirrors, STRICTEST_LICENSE_PACK } from '@realty/core/listings';
import type { IanaZone, Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { LISTING_COLS, type ListingRow, factsOfRow, mlsAsOf, mlsEligibility } from './eligibility.js';

export interface CompetingView {
  subjectId: string;
  listings: DisplayListing[];
  why: CriterionMatch[];
  mirrorMismatches: MirrorStatusMismatch[];
  /** true when an MLS connection exists but its rows are paused because the feed is stale (R-MLS-3) */
  mlsPaused: boolean;
  /** "MLS data as of …" (null when the tenant has no MLS connection) */
  mlsDataAsOf: string | null;
  rule: CompetingRule;
}

const CANDIDATE_LIMIT = 1000;

export async function competingFor(tx: Tx, listingId: string, now: Instant): Promise<CompetingView> {
  const subj = (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId}`.execute(tx)).rows[0];
  if (!subj) throw new AppError('NOT_FOUND');
  const e = await mlsEligibility(tx, now);
  const live = e.connections.filter((c) => (c.status === 'connected' || c.status === 'degraded') && !e.staleIds.includes(c.id)).map((c) => c.id);
  const rule: CompetingRule = { ...DEFAULT_COMPETING_RULE, area: 'city_or_postal_code', mlsFeedStale: e.connections.length > 0 && live.length === 0 };
  const rows = (
    await sql<ListingRow>`
      SELECT ${LISTING_COLS} FROM listings l
       WHERE l.tenant_id = app.tenant_id() AND l.id <> ${subj.id}
         AND (l.source = 'team' OR l.mls_connection_id = ANY (${live}::uuid[]))
         AND (l.team_listing_id = ${subj.id}
              OR (l.status = ANY (${[...rule.statuses]}::text[])
                  AND (left(l.postal_code, 5) = left(${subj.postal_code}, 5) OR (lower(l.city) = lower(${subj.city}) AND l.region = ${subj.region}))))
       ORDER BY l.id LIMIT ${CANDIDATE_LIMIT}`.execute(tx)
  ).rows;
  const subject = factsOfRow(subj);
  const candidates = rows.map(factsOfRow);
  const { listings, why } = competingSet(subject, candidates, rule);
  const view = (r: (typeof listings)[number]) => applyDisplayRules(r, r.mlsConnectionId ? (e.pack(r.mlsConnectionId) ?? STRICTEST_LICENSE_PACK) : STRICTEST_LICENSE_PACK, 'agent')!;
  const zone = (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.z ?? 'UTC';
  return {
    subjectId: subj.id,
    listings: listings.map(view),
    why,
    mirrorMismatches: dedupeMirrors([subject, ...candidates]).mismatches,
    mlsPaused: e.staleIds.length > 0 && e.connections.some((c) => e.staleIds.includes(c.id) && (c.status === 'connected' || c.status === 'degraded')),
    mlsDataAsOf: mlsAsOf(e, zone as IanaZone),
    rule,
  };
}
