// Out-of-sample back-test (R-CMA-4 evidence, never a score, R-AST-13). The most recent closed sales in
// the reached area whose price was agreed in the window before the valuation date are each valued by
// the same method, with market rates refit once from sales that closed before the window starts (F12)
// and with candidates that closed before the tested sale's own date. No tested sale contributes to any
// rate it is valued with, and none sees a later sale.
import { fitRates } from './adjust.js';
import { chooseComps, estimate, poolSales, ratePool, weighed } from './estimate.js';
import { type Screened, type TierSearch, addMonths, monthIndex, poolTierIndex, screen, searchTier } from './select.js';
import { BACKTEST_TOO_FEW, backtestSentence } from './text.js';
import type { BacktestView, CmaCandidate, CmaRule, CmaSubject } from './types.js';

export interface BacktestTrace {
  readonly windowStart: string;
  /** identities and close dates of the sales the back-test rates were fitted on. */
  readonly pool: readonly { readonly identity: string; readonly closeDate: string }[];
  readonly tested: readonly {
    readonly identity: string;
    readonly refDate: string;
    /** Close dates of every candidate offered when valuing this sale. */
    readonly candidateCloseDates: readonly string[];
    readonly candidateIdentities: readonly string[];
    readonly valueCents: number | null;
  }[];
}

/** The tested sale as a subject: its own facts, its own listing and address excluded. */
export function subjectOfSale(c: CmaCandidate): CmaSubject {
  const s = c.sale;
  return {
    propertyType: s.propertyType,
    sqft: s.sqft,
    sizeSource: s.sizeSource,
    beds: s.beds,
    bathsX10: s.bathsX10,
    yearBuilt: s.yearBuilt,
    lotSqft: s.lotSqft,
    garageSpacesX10: s.garageSpacesX10,
    poolPrivate: s.poolPrivate,
    storiesX10: s.storiesX10,
    latE6: s.latE6,
    lonE6: s.lonE6,
    postalCode: s.postalCode,
    city: s.city,
    region: s.region,
    subdivisionName: s.subdivisionName,
    addressKey: s.addressKey,
    ownIdentities: c.ref.teamListingId === null ? [c.ref.identity] : [c.ref.identity, c.ref.teamListingId],
    ownMlsNumbers: c.ref.mlsNumber === null ? [] : [c.ref.mlsNumber],
  };
}

function medianInt(sorted: readonly number[]): number {
  const n = sorted.length;
  const mid = n >> 1;
  return n % 2 === 1 ? (sorted[mid] as number) : Math.floor(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

export function runBacktest(
  subject: CmaSubject,
  canonical: readonly CmaCandidate[],
  screened: readonly Screened[],
  search: TierSearch,
  valuationDate: string,
  rule: CmaRule,
): { view: BacktestView; trace: BacktestTrace } {
  const windowStart = addMonths(valuationDate, -rule.backtestWindowMonths);
  const poolIdx = poolTierIndex(subject, search.tierIdx);
  const pool = ratePool(screened, poolIdx, windowStart, addMonths(windowStart, -rule.ratePoolMonths), rule);
  const rates = fitRates(poolSales(pool), monthIndex(windowStart), rule);
  const tested = screened
    .filter((s) => s.defaultOk && s.fail === null && s.tierIdx >= 0 && s.tierIdx <= search.tierIdx && (s.refDate as string) >= windowStart)
    .sort((a, b) => {
      const da = a.c.sale.closeDate as string;
      const db = b.c.sale.closeDate as string;
      return da > db ? -1 : da < db ? 1 : a.c.ref.identity < b.c.ref.identity ? -1 : a.c.ref.identity > b.c.ref.identity ? 1 : 0;
    })
    .slice(0, rule.backtestMaxSales);

  const misses: number[] = [];
  let notValued = 0;
  const traced: BacktestTrace['tested'][number][] = [];
  for (const t of tested) {
    const refDate = t.refDate as string;
    const asSubject = subjectOfSale(t.c);
    const before = canonical.filter((c) => c.sale.closeDate !== null && c.sale.closeDate < refDate);
    const sc = screen(asSubject, before, refDate, rule, NO_EXCLUSIONS, false);
    const se = searchTier(asSubject, sc, refDate, rule, NO_EXCLUSIONS);
    const choice = chooseComps(asSubject, sc, se, { ...rates, refMonth: monthIndex(refDate) }, refDate, rule, NO_EXCLUSIONS, false);
    const est = estimate(
      weighed(choice.comps),
      rule.minComps,
    );
    const price = t.c.sale.closePriceCents as number;
    if (est === null) notValued++;
    else misses.push(Math.round((Math.abs(est.valueCents - price) * 10_000) / price));
    traced.push({
      identity: t.c.ref.identity,
      refDate,
      candidateCloseDates: before.map((c) => c.sale.closeDate as string),
      candidateIdentities: before.map((c) => c.ref.identity),
      valueCents: est?.valueCents ?? null,
    });
  }
  misses.sort((a, b) => a - b);
  const valued = misses.length;
  const enough = valued >= rule.backtestMinSales;
  const medianMissBps = enough ? medianInt(misses) : null;
  const within10PctBps = enough ? Math.floor((misses.filter((m) => m <= rule.backtestWithinBps).length * 10_000) / valued) : null;
  return {
    view: {
      salesTested: valued,
      notValued,
      medianMissBps,
      within10PctBps,
      windowStart,
      sentence: enough ? backtestSentence(valued, medianMissBps as number, within10PctBps as number, rule) : BACKTEST_TOO_FEW,
    },
    trace: { windowStart, pool: pool.map((s) => ({ identity: s.c.ref.identity, closeDate: s.c.sale.closeDate as string })), tested: traced },
  };
}
