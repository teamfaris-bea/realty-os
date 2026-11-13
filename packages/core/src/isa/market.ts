// Market changes (R-ISA-19; E537; docs/AI_ISA.md §6.3 "Market changes"). No sold-derived statistics in v1: only
// the displayable, UNCAPPED count of homes like the seller's (same type, beds ±1, size ±20 %, same postal code,
// display-allowed, fresh rows), by status. Shared only when active + coming soon changed by at least 3 AND at least
// 25 % since the snapshot, at most once per 30 days, and never across a change of the connection set, the display
// rules version or the rule itself (then the snapshot is reset silently). No forecasts, no direction words beyond
// "up from" / "down from" a stated count. VERIFY (C-ISA-8): thresholds and wording.
// R-MLS-7: the size band runs only with a known subject size (every Spark subject has none until the MLS confirms its
// finished-living-area field). The snapshot says whether it ran: the sentence claims "similar size" only then, and a
// count with the band is never compared with one without (the snapshot is reset, like a rule change).
import { DAY_MS, type Instant } from '../foundation/index.js';
import { ISA_GROUNDING_DEFAULTS } from './constants.js';

export const MARKET_RULE_VERSION = 'isa-market-count/1';

export interface StatusCounts {
  active: number;
  comingSoon: number;
  pending: number;
}

export interface CountSnapshot {
  counts: StatusCounts;
  at: Instant;
  /** The sorted MLS connection ids the count read. */
  connections: readonly string[];
  displayRulesVersion: string;
  ruleVersion: string;
  /** The ±20 % size band was applied (the subject's size is known, R-MLS-7); false: the count is not by size. */
  sizeFilterApplied: boolean;
}

export type MarketDelta =
  | { share: true; sentence: string; snapshot: CountSnapshot }
  | { share: false; reason: 'NO_SNAPSHOT' | 'VERSION_CHANGED' | 'BELOW_THRESHOLD' | 'TOO_SOON' | 'INVALID'; snapshot: CountSnapshot };

function valid(c: StatusCounts): boolean {
  return [c.active, c.comingSoon, c.pending].every((n) => Number.isInteger(n) && n >= 0);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** The count sentence (§6.3), with the comparison count and date; "similar size" only when the size band ran (R-MLS-7). */
export function countSentence(i: { now: StatusCounts; prev: StatusCounts; prevAt: Instant; beds: number; postalCode: string; sizeFilterApplied: boolean }): string {
  const nowAc = i.now.active + i.now.comingSoon;
  const prevAc = i.prev.active + i.prev.comingSoon;
  const dir = nowAc >= prevAc ? 'up from' : 'down from';
  const d = new Date(i.prevAt);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const lo = Math.max(0, i.beds - 1);
  return `${i.now.active} active and ${i.now.comingSoon} coming soon, plus ${i.now.pending} pending, among homes like yours (same type, ${lo}–${i.beds + 1} bedrooms${i.sizeFilterApplied ? ', similar size' : ''}) that the MLS lets us show in ${i.postalCode.slice(0, 5)}, ${dir} ${prevAc} on ${MON[d.getUTCMonth()]} ${d.getUTCDate()}.`;
}

/**
 * Whether today's count is worth a message. `lastSharedAt` is the last count message; `current` becomes the new
 * snapshot only when shared or when versions changed (otherwise the comparison base stays, so slow drift adds up).
 */
export function marketDeltas(i: { prev: CountSnapshot | null; current: CountSnapshot; lastSharedAt: Instant | null; beds: number; postalCode: string; minAbs?: number; minPct?: number; minDaysBetween?: number }): MarketDelta {
  const t = ISA_GROUNDING_DEFAULTS.marketDelta;
  const cur = i.current;
  if (!valid(cur.counts)) return { share: false, reason: 'INVALID', snapshot: i.prev ?? cur };
  const p = i.prev;
  if (p === null) return { share: false, reason: 'NO_SNAPSHOT', snapshot: cur };
  if (!sameSet(p.connections, cur.connections) || p.displayRulesVersion !== cur.displayRulesVersion || p.ruleVersion !== cur.ruleVersion || p.sizeFilterApplied !== cur.sizeFilterApplied) return { share: false, reason: 'VERSION_CHANGED', snapshot: cur };
  const prevAc = p.counts.active + p.counts.comingSoon;
  const nowAc = cur.counts.active + cur.counts.comingSoon;
  const diff = Math.abs(nowAc - prevAc);
  const pct = i.minPct ?? t.minPct;
  // ≥ 25 % of the previous count (integer math); from zero, any change of minAbs counts as ≥ 25 %
  if (diff < (i.minAbs ?? t.minAbs) || diff * 100 < prevAc * pct) return { share: false, reason: 'BELOW_THRESHOLD', snapshot: p };
  if (i.lastSharedAt !== null && cur.at - i.lastSharedAt < (i.minDaysBetween ?? t.minDaysBetween) * DAY_MS) return { share: false, reason: 'TOO_SOON', snapshot: p };
  return { share: true, sentence: countSentence({ now: cur.counts, prev: p.counts, prevAt: p.at, beds: i.beds, postalCode: i.postalCode, sizeFilterApplied: cur.sizeFilterApplied }), snapshot: cur };
}
