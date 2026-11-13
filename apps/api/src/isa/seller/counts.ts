// Market counts for the agent (R-ISA-19; owner question 2; docs/AI_ISA.md §6.3 "Market changes"). Uncapped, by
// status: the same type, beds ±1, size ±20 %, the same 5-digit ZIP, display-allowed MLS rows of live, fresh feeds.
// Shown to the agent as "not sent to clients yet" and never queued: COUNT_SHARE_ENABLED stays false until owner
// question 2 is resolved and the MLS confirms the rows are complete. The incremental feed moves last_seen only on
// change (mls/sync.ts), so a row-fresh count would undercount: the count is feed-fresh, not row-fresh (VERIFY WITH MLS).
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { MlsEligibility } from './cmaSeam.js';
import { type CountSnapshot, MARKET_RULE_VERSION, type StatusCounts, marketDeltas } from './isa1Seam.js';
import type { SubjectFactsRow } from './subject.js';
import { versionsOf } from './versions.js';

/** Owner question 2: counts are never sent to clients in this version. */
export const COUNT_SHARE_ENABLED = false;
export const COUNT_SENTENCE = 'Not sent to clients yet: counts of homes like theirs are shown to you only.';

export async function marketCountsInTx(tx: Tx, e: MlsEligibility, s: { postalCode: string; facts: SubjectFactsRow }, now: Instant, prev: CountSnapshot | null): Promise<{ counts: StatusCounts; snapshot: CountSnapshot; delta: ReturnType<typeof marketDeltas>; sentence: string }> {
  const live = e.clientIds.filter((id) => !e.staleIds.includes(id)).sort();
  const zip = s.postalCode.trim().slice(0, 5);
  const r = await sql<{ status: string; n: number }>`SELECT l.status, count(*)::int AS n FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls'
      AND l.team_listing_id IS NULL AND NOT l.is_lease AND l.display_allowed AND l.status IN ('active','coming_soon','pending') AND left(l.postal_code, 5) = ${zip}
      AND l.mls_connection_id = ANY (${live}::uuid[]) AND l.property_type = ${s.facts.type} AND l.beds BETWEEN ${s.facts.beds - 1} AND ${s.facts.beds + 1}
      AND l.sqft * 100 BETWEEN ${s.facts.sqft * 80} AND ${s.facts.sqft * 120} GROUP BY l.status`.execute(tx);
  const n = (k: string) => r.rows.find((x) => x.status === k)?.n ?? 0;
  const counts: StatusCounts = { active: n('active'), comingSoon: n('coming_soon'), pending: n('pending') };
  const v = versionsOf(e.connections.filter((c) => live.includes(c.id)));
  const snapshot: CountSnapshot = { counts, at: now, connections: live, displayRulesVersion: Object.values(v).join(','), ruleVersion: MARKET_RULE_VERSION };
  const delta = marketDeltas({ prev, current: snapshot, lastSharedAt: null, beds: s.facts.beds, postalCode: zip });
  return { counts, snapshot, delta, sentence: COUNT_SENTENCE };
}
