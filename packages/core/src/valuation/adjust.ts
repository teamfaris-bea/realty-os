// Market rates and adjustments (R-CMA-3). Every rate is measured from the same run's local sales (the
// rate pool) with the Theil-Sen estimator (the median of pairwise slopes; robust to outliers, no
// trimming, V8). A rate is applied only with enough support counted in sales, not only pairs (F11), and
// a feature that cannot lower value is never adjusted with a negative rate. No adjustment is capped
// ("without regard to arbitrary limits", Fannie B4-1.3-09). Concessions only lower a price.
import type { Adjustment, AdjustmentFeature, CmaRule, CmaSale, CmaSubject, RateSupport, RateView } from './types.js';
import { monthIndex } from './select.js';
import {
  adjustmentSentence,
  concessionSentence,
  rateAppliedSentence,
  rateFewValuesSentence,
  rateUnsupportedSentence,
  rateWrongSignSentence,
} from './text.js';

/** Features fitted on the residual after time and size, in the order they are shown. */
export const OTHER_FEATURES = ['beds', 'baths', 'garage', 'pool', 'year_built', 'lot', 'stories'] as const;
export type OtherFeature = (typeof OTHER_FEATURES)[number];
export type RatedFeature = 'time' | 'size' | OtherFeature;

/** Features where more can never lower a price: a negative measured rate is not applied. */
export const CANNOT_LOWER_VALUE: ReadonlySet<RatedFeature> = new Set(['size', 'baths', 'garage', 'pool', 'lot']);

type Facts = Pick<CmaSale, 'beds' | 'bathsX10' | 'garageSpacesX10' | 'poolPrivate' | 'yearBuilt' | 'lotSqft' | 'storiesX10'>;

/** A feature's value in its stored unit (pool: 1/0), or null when not recorded. */
export function featureValue(f: OtherFeature, x: Facts): number | null {
  switch (f) {
    case 'beds':
      return x.beds;
    case 'baths':
      return x.bathsX10;
    case 'garage':
      return x.garageSpacesX10;
    case 'pool':
      return x.poolPrivate === null ? null : x.poolPrivate ? 1 : 0;
    case 'year_built':
      return x.yearBuilt;
    case 'lot':
      return x.lotSqft;
    case 'stories':
      return x.storiesX10;
  }
}

// ---------------------------------------------------------------- robust statistics

/** The k-th smallest value (0-based) of a, partially reordering a in place (Hoare quickselect, median-of-3 pivot). */
export function selectKth(a: Float64Array, k: number): number {
  let lo = 0;
  let hi = a.length - 1;
  while (hi > lo) {
    const mid = lo + ((hi - lo) >> 1);
    const x = a[lo] as number;
    const y = a[mid] as number;
    const z = a[hi] as number;
    const pivot = x < y ? (y < z ? y : x < z ? z : x) : x < z ? x : y < z ? z : y;
    let i = lo;
    let j = hi;
    while (i <= j) {
      while ((a[i] as number) < pivot) i++;
      while ((a[j] as number) > pivot) j--;
      if (i <= j) {
        const t = a[i] as number;
        a[i] = a[j] as number;
        a[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k] as number;
  }
  return a[k] as number;
}

/** Median of numbers (mean of the two middle values for an even count); null when empty. Order-independent. */
export function median(values: ArrayLike<number>): number | null {
  const n = values.length;
  if (n === 0) return null;
  const a = values instanceof Float64Array ? values : Float64Array.from(values);
  const mid = n >> 1;
  const upper = selectKth(a, mid);
  if (n % 2 === 1) return upper;
  // After selection every value left of mid is <= upper: the lower middle is their maximum.
  let lower = a[0] as number;
  for (let i = 1; i < mid; i++) if ((a[i] as number) > lower) lower = a[i] as number;
  return (lower + upper) / 2;
}

/**
 * Theil-Sen slope: the median of (y_j - y_i) / (x_j - x_i) over pairs whose x differ by at least minDx
 * (> 0). Each pair's slope is the same whichever way round it is taken, so the result does not depend
 * on input order (R-CMA-5).
 */
export function theilSen(xs: readonly number[], ys: readonly number[], minDx: number): { slope: number | null; pairs: number } {
  const n = xs.length;
  let pairs = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (Math.abs((xs[j] as number) - (xs[i] as number)) >= minDx) pairs++;
  if (pairs === 0) return { slope: null, pairs };
  const slopes = new Float64Array(pairs);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const xi = xs[i] as number;
    const yi = ys[i] as number;
    for (let j = i + 1; j < n; j++) {
      const dx = (xs[j] as number) - xi;
      if (Math.abs(dx) >= minDx) slopes[k++] = ((ys[j] as number) - yi) / dx;
    }
  }
  return { slope: median(slopes), pairs };
}

// ---------------------------------------------------------------- rate pool and fitting

export interface PoolSale {
  readonly sale: CmaSale;
  /** Month index of the contract date, else the close date. */
  readonly month: number;
}

export interface FittedRate {
  readonly feature: RatedFeature;
  /** Applied rate per stored unit (cents; basis points a month for time), or null when not applied. */
  readonly rate: number | null;
  readonly support: RateSupport;
  readonly view: RateView;
}

export interface FittedRates {
  /** The month all prices are brought to (the valuation month). */
  readonly refMonth: number;
  readonly poolSales: number;
  readonly time: FittedRate;
  readonly size: FittedRate;
  readonly features: ReadonlyMap<OtherFeature, FittedRate>;
}

function rateView(feature: RatedFeature, applied: boolean, rate: number | null, support: RateSupport, sentence: string): RateView {
  return { feature, applied, rate, support, sentence };
}

function roundRate(f: RatedFeature, rate: number): number {
  // Shown rates: whole basis points a month, whole cents per unit. The applied rate keeps full precision.
  return f === 'time' ? Math.round(rate) : Math.round(rate) || 0;
}

function fitted(feature: RatedFeature, measured: number | null, support: RateSupport, unsupported: string | null): FittedRate {
  if (unsupported !== null || measured === null) {
    return { feature, rate: null, support, view: rateView(feature, false, measured === null ? null : roundRate(feature, measured), support, unsupported ?? '') };
  }
  if (CANNOT_LOWER_VALUE.has(feature) && measured < 0) {
    return { feature, rate: null, support, view: rateView(feature, false, roundRate(feature, measured), support, rateWrongSignSentence(feature as Exclude<RatedFeature, 'time'>, roundRate(feature, measured))) };
  }
  return { feature, rate: measured, support, view: rateView(feature, true, roundRate(feature, measured), support, rateAppliedSentence(feature, roundRate(feature, measured), support)) };
}

function aboveBelow(values: readonly number[]): { above: number; below: number; distinct: number } {
  const m = median(values);
  let above = 0;
  let below = 0;
  for (const v of values) {
    if (m !== null && v > m) above++;
    else if (m !== null && v < m) below++;
  }
  return { above, below, distinct: new Set(values).size };
}

/** The time trend: Theil-Sen of price per sq ft against month index, as basis points a month. */
export function fitTime(pool: readonly PoolSale[], rule: CmaRule): FittedRate {
  const months = new Set(pool.map((p) => p.month)).size;
  const support: RateSupport = { kind: 'sales_months', first: pool.length, second: months, pairs: 0 };
  if (pool.length < rule.timeMinSales || months < rule.timeMinMonths) return fitted('time', null, support, rateUnsupportedSentence('time', support, rule));
  const xs = pool.map((p) => p.month);
  const ys = pool.map((p) => (p.sale.closePriceCents as number) / (p.sale.sqft as number));
  const { slope, pairs } = theilSen(xs, ys, 1);
  const level = median(ys) as number;
  const s2: RateSupport = { ...support, pairs };
  if (slope === null || level <= 0) return fitted('time', null, s2, rateUnsupportedSentence('time', s2, rule));
  return fitted('time', Math.round((slope / level) * 10_000), s2, null);
}

/** A comp's time adjustment: round(price x bps x months / 10,000), linear (R-CMA-3). */
export function timeAmount(priceCents: number, bps: number, months: number): number {
  return Math.round((priceCents * bps * months) / 10_000) || 0;
}

/** Fits every rate from the pool (R-CMA-3). The pool must hold sold sales with a price and a size. */
export function fitRates(pool: readonly PoolSale[], refMonth: number, rule: CmaRule): FittedRates {
  const time = fitTime(pool, rule);
  const bps = time.rate ?? 0;
  const adjusted = pool.map((p) => (p.sale.closePriceCents as number) + timeAmount(p.sale.closePriceCents as number, bps, refMonth - p.month));

  // Size: Theil-Sen of the time-adjusted price against sq ft, over pairs at least sizePairMinDiffSqft apart.
  const sqfts = pool.map((p) => p.sale.sqft as number);
  const sizeSides = aboveBelow(sqfts);
  const sizeFit = theilSen(sqfts, adjusted, rule.sizePairMinDiffSqft);
  const sizeSupport: RateSupport = { kind: 'above_below', first: sizeSides.above, second: sizeSides.below, pairs: sizeFit.pairs };
  const size = fitted('size', sizeFit.slope, sizeSupport, supportProblem('size', sizeSupport, sizeSides.distinct, false, rule));
  const sizeRate = size.rate ?? 0;

  // Other features: Theil-Sen of the residual (time-adjusted price - size rate x sq ft) against the feature.
  const residual = adjusted.map((a, i) => a - sizeRate * (sqfts[i] as number));
  const features = new Map<OtherFeature, FittedRate>();
  for (const f of OTHER_FEATURES) {
    const xs: number[] = [];
    const ys: number[] = [];
    pool.forEach((p, i) => {
      const v = featureValue(f, p.sale);
      if (v !== null) {
        xs.push(v);
        ys.push(residual[i] as number);
      }
    });
    const binary = f === 'pool';
    let support: RateSupport;
    let distinct: number;
    if (binary) {
      const withN = xs.filter((x) => x === 1).length;
      support = { kind: 'with_without', first: withN, second: xs.length - withN, pairs: withN * (xs.length - withN) };
      distinct = new Set(xs).size;
    } else {
      const sides = aboveBelow(xs);
      distinct = sides.distinct;
      support = { kind: 'above_below', first: sides.above, second: sides.below, pairs: 0 };
    }
    const problemBeforeFit = binary ? supportProblem(f, support, distinct, true, rule) : null;
    if (problemBeforeFit !== null) {
      features.set(f, fitted(f, null, support, problemBeforeFit));
      continue;
    }
    const fit = theilSen(xs, ys, 1); // stored values are integers: pairs that differ
    const s2: RateSupport = { ...support, pairs: fit.pairs };
    features.set(f, fitted(f, fit.slope, s2, supportProblem(f, s2, distinct, binary, rule)));
  }
  return { refMonth, poolSales: pool.length, time, size, features };
}

/** Why a rate lacks support (F11), or null when it has enough: sales on each side, pairs, distinct values. */
export function supportProblem(f: Exclude<RatedFeature, 'time'>, s: RateSupport, distinct: number, binary: boolean, rule: CmaRule): string | null {
  if (s.first < rule.minSalesPerSide || s.second < rule.minSalesPerSide) return rateUnsupportedSentence(f, s, rule);
  if (!binary && distinct < rule.minDistinctValues) return rateFewValuesSentence(f, distinct, rule);
  if (s.pairs < rule.minPairs) return rateUnsupportedSentence(f, s, rule);
  return null;
}

/** The rate views in display order. */
export function rateViews(r: FittedRates): RateView[] {
  return [r.time.view, r.size.view, ...OTHER_FEATURES.map((f) => (r.features.get(f) as FittedRate).view)];
}

// ---------------------------------------------------------------- per-comp adjustments

/** The months from a comp's price date (contract, else close) to the valuation month. */
export function compMonths(sale: CmaSale, refMonth: number): number {
  return refMonth - monthIndex((sale.contractDate ?? sale.closeDate) as string);
}

/**
 * Every adjustment for one comp, in display order: time, size, the other features, concessions.
 * A feature is adjusted only when its rate is applied and both sides record different values.
 */
export function adjustComp(subject: CmaSubject, sale: CmaSale, rates: FittedRates, withText = true): Adjustment[] {
  const out: Adjustment[] = [];
  const price = sale.closePriceCents as number;
  if (rates.time.rate !== null) {
    const months = compMonths(sale, rates.refMonth);
    if (months !== 0) {
      const amount = timeAmount(price, rates.time.rate, months);
      out.push({
        feature: 'time',
        subjectValue: 0,
        compValue: months,
        rate: rates.time.rate,
        amountCents: amount,
        support: rates.time.support,
        sentence: withText ? adjustmentSentence('time', 0, months, rates.time.rate, amount, rates.time.support) : '',
      });
    }
  }
  const push = (f: Exclude<AdjustmentFeature, 'time' | 'concessions'>, r: FittedRate, sv: number | null, cv: number | null) => {
    if (r.rate === null || sv === null || cv === null || sv === cv) return;
    const amount = Math.round(r.rate * (sv - cv)) || 0;
    out.push({ feature: f, subjectValue: sv, compValue: cv, rate: roundRate(f, r.rate), amountCents: amount, support: r.support, sentence: withText ? adjustmentSentence(f, sv, cv, roundRate(f, r.rate), amount, r.support) : '' });
  };
  push('size', rates.size, subject.sqft, sale.sqft);
  for (const f of OTHER_FEATURES) push(f, rates.features.get(f) as FittedRate, featureValue(f, subject), featureValue(f, sale));
  const concessions = sale.concessionsCents ?? 0;
  if (concessions > 0) {
    out.push({
      feature: 'concessions',
      subjectValue: null,
      compValue: concessions,
      rate: null,
      amountCents: -concessions,
      support: { kind: 'none', first: 0, second: 0, pairs: 0 },
      sentence: withText ? concessionSentence(concessions) : '',
    });
  }
  return out;
}

/**
 * Adjusted price (never below 0), the gross adjustment in basis points of the close price (ranking and
 * display, R-CMA-4), and the weight basis: the gross of every adjustment except size. Size is the one
 * adjustment that moves with the subject's own size, so leaving it out of the weights keeps the value
 * from ever falling when the subject is larger (F12); size similarity still filters (+-20 %) and ranks.
 */
export function adjustedPrice(sale: CmaSale, adjustments: readonly Adjustment[]): { adjustedPriceCents: number; grossAdjustmentBps: number; weightBasisBps: number } {
  const price = sale.closePriceCents as number;
  let net = 0;
  let gross = 0;
  let basis = 0;
  for (const a of adjustments) {
    net += a.amountCents;
    gross += Math.abs(a.amountCents);
    if (a.feature !== 'size') basis += Math.abs(a.amountCents);
  }
  return {
    adjustedPriceCents: Math.max(0, price + net),
    grossAdjustmentBps: Math.floor((gross * 10_000) / price),
    weightBasisBps: Math.floor((basis * 10_000) / price),
  };
}
