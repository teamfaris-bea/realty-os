// prepareCma: one comparable-sales valuation (R-CMA-2..5). Validate the strict inputs, screen the
// candidates, search the area tiers, fit market rates on the rate pool, adjust and rank the comps,
// take the weighted median, and back-test the method out of sample. Pure and deterministic.
import { fitRates, rateViews } from './adjust.js';
import { runBacktest } from './backtest.js';
import { type ChosenComp, chooseComps, estimate, poolSales, ratePool, weighed } from './estimate.js';
import {
  type Screened,
  type TierSearch,
  addMonths,
  canonicalOrder,
  monthIndex,
  plausiblePrice,
  poolTierIndex,
  screen,
  searchTier,
  unsizedSales,
} from './select.js';
import {
  compIncludedSentence,
  compSoldSentence,
  compTierSentence,
  compWeightSentence,
  conditionName,
  filterSkippedSentence,
  notUsedSentence,
  olderSalesSentence,
  tierLimitSentence,
  tierReachedSentence,
  tierSkippedSentence,
  unavailableSentence,
  valueSentence,
  noSizeSentence,
  BACKTEST_TOO_FEW,
  NO_SIZED_SALES,
} from './text.js';
import {
  type AreaView,
  type BacktestView,
  type CmaResult,
  type CmaRule,
  type CmaSubject,
  type CmaTier,
  type CmaTierRead,
  type CmaUnavailableReason,
  type CompView,
  type MarketView,
  type NotUsedReason,
  type NotUsedView,
  type PrepareCmaInput,
  type SubjectSaleView,
  CMA_DEFAULTS,
  CMA_METHOD_VERSION,
  CMA_SUPPORTED_TYPES,
  CMA_TIERS,
  CmaCandidateSchema,
  CmaSubjectSchema,
  CmaTierReadSchema,
} from './types.js';
import { z } from 'zod';

const ValuationDate = CmaCandidateSchema.shape.sale.shape.closeDate.unwrap();
const RuleOverrides = z.record(z.string(), z.number().int().min(0)).optional();

// ---------------------------------------------------------------- views

function emptyBacktest(valuationDate: string, rule: CmaRule): BacktestView {
  return { salesTested: 0, notValued: 0, medianMissBps: null, within10PctBps: null, windowStart: addMonths(valuationDate, -rule.backtestWindowMonths), sentence: BACKTEST_TOO_FEW };
}

function emptyMarket(rule: CmaRule): MarketView {
  return { poolTier: null, poolMonths: rule.ratePoolMonths, poolSales: 0, rates: [], sentences: [] };
}

function byIdentity(a: Screened, b: Screened): number {
  return a.c.ref.identity < b.c.ref.identity ? -1 : a.c.ref.identity > b.c.ref.identity ? 1 : 0;
}

function tierAt(idx: number): CmaTier | null {
  return idx < 0 ? null : (CMA_TIERS[idx] as CmaTier);
}

function areaView(search: TierSearch | null, subject: CmaSubject, tierReads: readonly CmaTierRead[], rule: CmaRule): AreaView {
  const sentences: string[] = [];
  if (search !== null) {
    sentences.push(tierReachedSentence(tierAt(search.tierIdx), search.reached, search.lookbackMonths, rule));
    if (search.reached && search.lookbackMonths > rule.lookbackMonths) sentences.push(olderSalesSentence(rule));
    const skipped = tierSkippedSentence(search.skipped);
    if (skipped !== null) sentences.push(skipped);
  }
  for (const read of tierReads) if (read.limitReached) sentences.push(tierLimitSentence(read, rule));
  if (search !== null && subject.beds === null) sentences.push(filterSkippedSentence('beds'));
  if (search !== null && subject.yearBuilt === null) sentences.push(filterSkippedSentence('year_built'));
  return {
    tier: search === null ? null : tierAt(search.tierIdx),
    lookbackMonths: search === null ? rule.lookbackMonths : search.lookbackMonths,
    tiersSkipped: search === null ? [] : search.skipped,
    tierReads,
    sentences,
  };
}

function compView(c: ChosenComp, weightBps: number, valuationDate: string, rule: CmaRule): CompView {
  const s = c.s;
  const sale = s.c.sale;
  const implausible = !plausiblePrice(sale.closePriceCents as number, sale.originalListPriceCents, rule);
  const labels = s.included ? [...s.conditions.map(conditionName), ...(implausible ? ['price reviewed by the agent'] : [])] : [];
  const why = [
    compTierSentence(s.tierIdx < 0 ? null : tierAt(s.tierIdx), s.distanceM),
    compSoldSentence(sale.closeDate as string, monthIndex(valuationDate) - monthIndex(s.refDate as string), s.datedByClose),
    ...(s.included ? [compIncludedSentence(s.conditions, implausible)] : []),
    compWeightSentence(weightBps, c.weightBasisBps),
  ];
  return {
    ref: s.c.ref,
    sale,
    tier: s.tierIdx < 0 ? null : tierAt(s.tierIdx),
    distanceM: s.distanceM,
    includedByAgent: s.included,
    labels,
    adjustments: c.adjustments,
    adjustedPriceCents: c.adjustedPriceCents,
    grossAdjustmentBps: c.grossAdjustmentBps,
    weightBasisBps: c.weightBasisBps,
    weightBps,
    why,
  };
}

/**
 * The closest notUsedLimit not-used sales, then every other sale the agent excluded (R-CMA-8: an exclusion is always
 * listed, so it can be seen and undone; the caller bounds the exclude list). Still in distance, then identity, order.
 */
function notUsedViews(items: readonly { s: Screened; reason: NotUsedReason }[], rule: CmaRule, lookbackMonths: number): NotUsedView[] {
  const sorted = [...items].sort((a, b) => (a.s.distanceM ?? Number.MAX_SAFE_INTEGER) - (b.s.distanceM ?? Number.MAX_SAFE_INTEGER) || byIdentity(a.s, b.s));
  return [...sorted.slice(0, rule.notUsedLimit), ...sorted.slice(rule.notUsedLimit).filter((x) => x.reason === 'excluded_by_agent')]
    .map(({ s, reason }) => ({
      ref: s.c.ref,
      reason,
      conditions: reason === 'sale_condition' ? s.conditions : [],
      distanceM: s.distanceM,
      includable: s.includable && (reason === 'sale_condition' || reason === 'implausible_price'),
      sentence: notUsedSentence(reason, { conditions: s.conditions, rule, lookbackMonths: s.fail === 'too_old' ? rule.extendedLookbackMonths : lookbackMonths }),
    }));
}

function subjectSalesView(screened: readonly Screened[]): SubjectSaleView[] {
  return screened
    .filter((s) => s.subjectSale)
    .map((s) => ({ ref: s.c.ref, closeDate: s.c.sale.closeDate, closePriceCents: s.c.sale.closePriceCents, status: s.c.sale.status }))
    .sort((a, b) => ((a.closeDate ?? '') > (b.closeDate ?? '') ? -1 : (a.closeDate ?? '') < (b.closeDate ?? '') ? 1 : a.ref.identity < b.ref.identity ? -1 : a.ref.identity > b.ref.identity ? 1 : 0));
}

// ---------------------------------------------------------------- entry point

function ruleOf(overrides: Partial<CmaRule> | undefined): { rule: CmaRule; methodVersion: string } {
  RuleOverrides.parse(overrides);
  const rule: CmaRule = Object.freeze({ ...CMA_DEFAULTS, ...(overrides ?? {}) });
  const custom = (Object.keys(CMA_DEFAULTS) as (keyof CmaRule)[]).some((k) => rule[k] !== CMA_DEFAULTS[k]) || Object.keys(rule).length !== Object.keys(CMA_DEFAULTS).length;
  return { rule, methodVersion: custom ? `${CMA_METHOD_VERSION}+custom-rule` : CMA_METHOD_VERSION };
}

/**
 * Values the subject from the candidates (R-CMA-2..5). Throws a ZodError when an input breaks its strict
 * schema (an unknown key included: the fair-housing validator). Same inputs in any order give the same
 * result, in integer cents.
 */
export function prepareCma(input: PrepareCmaInput): CmaResult {
  const { rule, methodVersion } = ruleOf(input.rule);
  const subject = CmaSubjectSchema.parse(input.subject);
  const candidates = canonicalOrder(input.candidates.map((c) => CmaCandidateSchema.parse(c)));
  const tierReads = [...input.tierReads.map((r) => CmaTierReadSchema.parse(r))].sort((a, b) => CMA_TIERS.indexOf(a.tier as CmaTier) - CMA_TIERS.indexOf(b.tier as CmaTier) || Number(a.limitReached) - Number(b.limitReached));
  const valuationDate = ValuationDate.parse(input.valuationDate);
  const include = new Set(input.include ?? []);
  const exclude = new Set(input.exclude ?? []);

  const unavailable = (reason: CmaUnavailableReason, extra: Partial<Pick<CmaResult, 'comps' | 'notUsed' | 'notUsedTotal' | 'subjectSales' | 'area' | 'market' | 'backtest'>> = {}, unsized = { count: 0, sizedOfKind: true }): CmaResult => {
    const comps = extra.comps ?? [];
    const noSize = unsized.count;
    // R-MLS-7: sales left out for an unknown size are counted; "none with a size" only when no sale of this kind has one
    const first = reason === 'NO_SALES' && noSize > 0 && !unsized.sizedOfKind ? NO_SIZED_SALES : unavailableSentence(reason, comps.length, rule);
    return {
      available: false,
      reason,
      methodVersion,
      valuationDate,
      comps,
      notUsed: extra.notUsed ?? [],
      notUsedTotal: extra.notUsedTotal ?? 0,
      subjectSales: extra.subjectSales ?? [],
      area: extra.area ?? areaView(null, subject, tierReads, rule),
      market: extra.market ?? emptyMarket(rule),
      backtest: extra.backtest ?? emptyBacktest(valuationDate, rule),
      sentences: [first, ...(noSize > 0 ? [noSizeSentence(noSize)] : [])],
    };
  };

  if (subject.propertyType === null || subject.sqft === null || subject.sqft <= 0) return unavailable('SUBJECT_INCOMPLETE');
  if (!CMA_SUPPORTED_TYPES.includes(subject.propertyType)) return unavailable('SUBJECT_TYPE_NOT_SUPPORTED');

  const screened = screen(subject, candidates, valuationDate, rule, include);
  const search = searchTier(subject, screened, valuationDate, rule, exclude);
  const poolIdx = poolTierIndex(subject, search.tierIdx);
  const pool = ratePool(screened, poolIdx, null, addMonths(valuationDate, -rule.ratePoolMonths), rule);
  const rates = fitRates(poolSales(pool), monthIndex(valuationDate), rule);
  const choice = chooseComps(subject, screened, search, rates, valuationDate, rule, exclude);
  const est = estimate(
    weighed(choice.comps),
    rule.minComps,
  );
  const comps = choice.comps.map((c) => compView(c, est?.weights.get(c.s.c.ref.identity) ?? 0, valuationDate, rule));
  const views = rateViews(rates);
  const market: MarketView = { poolTier: tierAt(poolIdx), poolMonths: rule.ratePoolMonths, poolSales: pool.length, rates: views, sentences: views.map((v) => v.sentence) };
  const area = areaView(search, subject, tierReads, rule);
  const backtest = runBacktest(subject, candidates, screened, search, valuationDate, rule).view;
  const common = {
    comps,
    notUsed: notUsedViews(choice.notUsed, rule, search.lookbackMonths),
    notUsedTotal: choice.notUsed.length,
    subjectSales: subjectSalesView(screened),
    area,
    market,
    backtest,
  };
  // R-MLS-7: closed sales of the subject's kind the unknown size alone kept out (each listed as not used: no_size)
  const unsized = unsizedSales(screened, valuationDate, rule);
  const noSize = unsized.count;
  const anyEligible = screened.some((s) => s.fail === null);
  if (!anyEligible) return unavailable('NO_SALES', common, unsized);
  if (est === null) return unavailable('INSUFFICIENT_COMPS', common, unsized);

  const dates = choice.comps.map((c) => c.s.c.sale.closeDate as string).sort();
  const dists = choice.comps.map((c) => c.s.distanceM).filter((d): d is number => d !== null);
  return {
    available: true,
    methodVersion,
    valuationDate,
    valueCents: est.valueCents,
    lowCents: est.lowCents,
    highCents: est.highCents,
    closeDateSpan: { earliest: dates[0] as string, latest: dates[dates.length - 1] as string },
    distanceSpanM: dists.length === choice.comps.length && dists.length > 0 ? { min: Math.min(...dists), max: Math.max(...dists) } : null,
    ...common,
    sentences: [valueSentence(comps.length), ...area.sentences, ...(noSize > 0 ? [noSizeSentence(noSize)] : [])],
  };
}

