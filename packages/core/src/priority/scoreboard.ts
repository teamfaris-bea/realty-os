// Scoreboard and momentum (BUILD_PLAN module 5; ARCHITECTURE §14; R-ACC-4, R-ACC-5, R-AST-15,
// R-IMPORT-6).
//
// The numbers come from SQL views (v_speed_to_lead, v_agent_activity_daily, v_pipeline_momentum);
// these pure functions summarise view rows the same way everywhere and always return the
// denominators, so no surface can show a bare number ("12 of 14 within SLA", "median 4 min of 12
// responded").
import { type Instant, SECOND_MS } from '../foundation/index.js';
import { isHumanTouch } from './feed.js';
import type { SpeedRow, SpeedToLeadSummary, TouchCounts, TouchFacts } from './types.js';

/** R-ACC-5: a deal is slow when its stage dwell is more than this many times the tenant median. */
export const MOMENTUM_FACTOR = 1.5;
/** R-ACC-5: the tenant norm must rest on at least this many stage transitions (in 180 d). */
export const MOMENTUM_MIN_SAMPLE = 5;

/** The median of a non-empty sorted list; an even count averages the middle two, rounded. */
function median(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/**
 * Speed-to-lead over `v_speed_to_lead` rows (one per SLA ownership period). A period counts toward
 * `total` once it has an outcome: a human first touch, or a deadline that passed. With `now`,
 * untouched periods whose deadline is still ahead are `pending` (not counted against the agent);
 * without it every row counts, as in the view. The median is over responded periods only, and
 * `responded` is its denominator. Only human touches exist in the ledger (R-AST-15).
 */
export function speedToLeadSummary(rows: readonly SpeedRow[], opts: { now?: Instant } = {}): SpeedToLeadSummary {
  const seconds: number[] = [];
  let withinSla = 0;
  let total = 0;
  let pending = 0;
  for (const r of rows) {
    if (r.firstTouchAt === null && opts.now !== undefined && opts.now < r.firstTouchDueAt) {
      pending += 1;
      continue;
    }
    total += 1;
    if (r.firstTouchAt === null) continue;
    seconds.push(Math.max(0, Math.round((r.firstTouchAt - r.ownedAt) / SECOND_MS)));
    if (r.firstTouchAt <= r.firstTouchDueAt) withinSla += 1;
  }
  seconds.sort((a, b) => a - b);
  return { medianSeconds: seconds.length === 0 ? null : median(seconds), withinSla, total, responded: seconds.length, pending };
}

/**
 * Scoreboard touches: gate-allowed human outbound calls, texts, emails and website-chat replies only (a chat
 * reply is a message, counted with the texts and emails; owner decision D8 made it a touch, R-OWN-14). Assistant,
 * system and imported messages never count (R-AST-15, R-IMPORT-6); answered inbound calls are not touches.
 */
export function countTouches(rows: readonly TouchFacts[]): TouchCounts {
  let calls = 0;
  let textsAndEmails = 0;
  for (const t of rows) {
    if (!isHumanTouch(t)) continue;
    if (t.kind === 'call') calls += 1;
    else textsAndEmails += 1;
  }
  return { touches: calls + textsAndEmails, calls, textsAndEmails };
}

/**
 * R-ACC-5: slow when the current stage dwell is more than 1.5× the tenant median for that stage and
 * the median rests on at least 5 transitions. Malformed numbers never flag a deal.
 */
export function momentum(dwellDays: number, norm: { medianDays: number; sample: number }): { slow: boolean } {
  if (!Number.isFinite(dwellDays) || !Number.isFinite(norm.medianDays) || !Number.isFinite(norm.sample)) return { slow: false };
  if (dwellDays < 0 || norm.medianDays < 0) return { slow: false };
  return { slow: norm.sample >= MOMENTUM_MIN_SAMPLE && dwellDays > MOMENTUM_FACTOR * norm.medianDays };
}
