// The value and range (R-CMA-4): the weighted median of the adjusted comps, weights from how little each
// needed adjusting, and the lowest-to-highest adjusted comp as the range. Integer cents and integer basis
// points throughout; ties broken by identity, so the result never depends on input order (R-CMA-5).

import { adjustComp, adjustedPrice, type FittedRates, type PoolSale } from './adjust.js';
import { type Screened, type TierSearch, addMonths, closedAfter, monthIndex } from './select.js';
import type { Adjustment, CmaRule, CmaSubject, NotUsedReason } from './types.js';

/** Three-way comparison of strings (code-unit order), shared by every tie-break so ties resolve one way. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface WeighedComp {
  readonly identity: string;
  readonly adjustedPriceCents: number;
  /** The gross of the comp's adjustments other than size, in basis points of its price (adjust.ts). */
  readonly weightBasisBps: number;
}

/** Raw weight: 10^12 / (10,000 + basis bps), an integer proportional to 1,000,000 / (10,000 + basis bps). */
export function rawWeight(basisBps: number): number {
  return Math.floor(1_000_000_000_000 / (10_000 + basisBps));
}

/**
 * Weights in basis points summing to exactly 10,000: proportional to rawWeight, rounded by largest
 * remainder, remainder ties to the smaller identity. Empty in, empty out.
 */
export function weightsBps(comps: readonly WeighedComp[]): Map<string, number> {
  const out = new Map<string, number>();
  const raws = comps.map((c) => rawWeight(c.weightBasisBps));
  const total = raws.reduce((a, b) => a + b, 0);
  const parts = comps.map((c, i) => {
    const scaled = (raws[i] as number) * 10_000;
    return { id: c.identity, floor: Math.floor(scaled / total), rem: scaled % total };
  });
  let left = 10_000 - parts.reduce((a, p) => a + p.floor, 0);
  const byRem = [...parts].sort((a, b) => b.rem - a.rem || compareText(a.id, b.id));
  for (const p of byRem) {
    if (left <= 0) break;
    p.floor += 1;
    left -= 1;
  }
  for (const p of parts) out.set(p.id, p.floor);
  return out;
}

/** Sort by adjusted price, then identity; the value is the first comp whose cumulative weight reaches 5,000 bps. */
export function weightedMedian(comps: readonly WeighedComp[], weights: ReadonlyMap<string, number>): number | null {
  if (comps.length === 0) return null;
  const sorted = [...comps].sort((a, b) => a.adjustedPriceCents - b.adjustedPriceCents || compareText(a.identity, b.identity));
  let cum = 0;
  for (const c of sorted) {
    cum += weights.get(c.identity) ?? 0;
    if (cum >= 5_000) return c.adjustedPriceCents;
  }
  return (sorted[sorted.length - 1] as WeighedComp).adjustedPriceCents;
}

export interface Estimate {
  readonly valueCents: number;
  readonly lowCents: number;
  readonly highCents: number;
  readonly weights: ReadonlyMap<string, number>;
}

/** The value and range of at least minComps comps, or null with fewer (INSUFFICIENT_COMPS). */
export function estimate(comps: readonly WeighedComp[], minComps: number): Estimate | null {
  if (comps.length < Math.max(1, minComps)) return null;
  const weights = weightsBps(comps);
  const value = weightedMedian(comps, weights) as number;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const c of comps) {
    low = Math.min(low, c.adjustedPriceCents);
    high = Math.max(high, c.adjustedPriceCents);
  }
  return { valueCents: value, lowCents: low, highCents: high, weights };
}

// ---------------------------------------------------------------- comp choice (shared with the back-test)

export interface ChosenComp {
  readonly s: Screened;
  readonly adjustments: readonly Adjustment[];
  readonly adjustedPriceCents: number;
  readonly grossAdjustmentBps: number;
  readonly weightBasisBps: number;
}

/** The estimate input of chosen comps. */
export function weighed(comps: readonly ChosenComp[]): WeighedComp[] {
  return comps.map((c) => ({ identity: c.s.c.ref.identity, adjustedPriceCents: c.adjustedPriceCents, weightBasisBps: c.weightBasisBps }));
}

export interface Choice {
  readonly comps: readonly ChosenComp[];
  /** Candidates not used and why (subject sales excluded: they are the sale history). */
  readonly notUsed: readonly { readonly s: Screened; readonly reason: NotUsedReason }[];
}

function byIdentity(a: Screened, b: Screened): number {
  return compareText(a.c.ref.identity, b.c.ref.identity);
}

/**
 * Adjusts every eligible sale in the reached area and look-back that passes the similarity filters,
 * ranks them (tier, gross adjustment, distance, close date newest first, identity) and keeps maxComps.
 * Agent-added sales are always kept, ahead of the ranked ones.
 */
export function chooseComps(
  subject: CmaSubject,
  screened: readonly Screened[],
  search: TierSearch,
  rates: FittedRates,
  valuationDate: string,
  rule: CmaRule,
  exclude: ReadonlySet<string>,
  withText = true,
): Choice {
  const notUsed: { s: Screened; reason: NotUsedReason }[] = [];
  const forced: ChosenComp[] = [];
  const ranked: ChosenComp[] = [];
  const adjust = (s: Screened): ChosenComp => {
    const adjustments = adjustComp(subject, s.c.sale, rates, withText);
    return { s, adjustments, ...adjustedPrice(s.c.sale, adjustments) };
  };
  const cutoff = addMonths(valuationDate, -search.lookbackMonths);
  for (const s of screened) {
    if (s.subjectSale) continue;
    if (s.fail !== null) notUsed.push({ s, reason: s.fail });
    else if (exclude.has(s.c.ref.identity)) notUsed.push({ s, reason: 'excluded_by_agent' });
    else if (s.included) forced.push(adjust(s));
    else if (s.tierIdx < 0 || s.tierIdx > search.tierIdx) notUsed.push({ s, reason: 'outside_area' });
    else if (s.similarFail !== null) notUsed.push({ s, reason: s.similarFail });
    else if (!closedAfter(s, cutoff)) notUsed.push({ s, reason: 'too_old' });
    else ranked.push(adjust(s));
  }
  ranked.sort(
    (a, b) =>
      a.s.tierIdx - b.s.tierIdx ||
      a.grossAdjustmentBps - b.grossAdjustmentBps ||
      (a.s.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.s.distanceM ?? Number.MAX_SAFE_INTEGER) ||
      compareText(b.s.c.sale.closeDate as string, a.s.c.sale.closeDate as string) ||
      byIdentity(a.s, b.s),
  );
  // `screened` is in canonical (identity) order, so the agent-added comps already are too.
  const room = Math.max(0, rule.maxComps - forced.length);
  for (const r of ranked.slice(room)) notUsed.push({ s: r.s, reason: 'not_among_closest' });
  return { comps: [...forced, ...ranked.slice(0, room)], notUsed };
}

/** The rate pool: default-eligible sales in the pool tier over ratePoolMonths, the most recent first, capped. */
export function ratePool(screened: readonly Screened[], poolIdx: number, newestExclusive: string | null, oldestExclusive: string, rule: CmaRule): Screened[] {
  return screened
    .filter((s) => {
      if (!s.defaultOk || s.tierIdx < 0 || s.tierIdx > poolIdx) return false;
      const d = s.c.sale.closeDate as string;
      return d > oldestExclusive && (newestExclusive === null || d < newestExclusive);
    })
    .sort((a, b) => compareText(b.c.sale.closeDate as string, a.c.sale.closeDate as string) || byIdentity(a, b))
    .slice(0, rule.ratePoolLimit);
}

export function poolSales(pool: readonly Screened[]): PoolSale[] {
  return pool.map((s) => ({ sale: s.c.sale, month: monthIndex(s.refDate as string) }));
}

