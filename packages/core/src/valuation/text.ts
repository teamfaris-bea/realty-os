// Deterministic English for the CMA (R-CMA-2, R-CMA-3, R-CMA-4): every adjustment, tier, tier limit,
// not-used reason, rate and the back-test. Fixed templates only: no model text, no locale lookups.
import type { AdjustmentFeature, CmaRule, CmaSaleCondition, CmaTier, CmaTierRead, NotUsedReason, RateSupport } from './types.js';

// ---------------------------------------------------------------- formats

function groups(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "$1,234" (whole dollars, rounded half away from zero). */
export function money(cents: number): string {
  const dollars = Math.round(Math.abs(cents) / 100);
  return `${cents < 0 && dollars > 0 ? '-' : ''}$${groups(dollars)}`;
}

/** "+$1,234" / "-$1,234" / "$0". */
export function signedMoney(cents: number): string {
  const m = money(cents);
  return m === '$0' || m.startsWith('-') ? m : `+${m}`;
}

/** Basis points as a percent with up to two decimals: 1234 -> "12.34 %", -50 -> "-0.5 %". */
export function percent(bps: number): string {
  const sign = bps < 0 ? '-' : '';
  const a = Math.abs(bps);
  const whole = Math.floor(a / 100);
  const frac = String(a % 100).padStart(2, '0').replace(/0+$/, '');
  return `${sign}${whole}${frac === '' ? '' : `.${frac}`} %`;
}

/** Metres as miles to one decimal: "0.4 mi". */
export function miles(m: number): string {
  const tenths = Math.round(m / 160.9344);
  return `${Math.floor(tenths / 10)}.${tenths % 10} mi`;
}

export function count(n: number): string {
  return groups(n);
}

function tenths(x10: number): string {
  return x10 % 10 === 0 ? String(x10 / 10) : `${Math.floor(x10 / 10)}.${x10 % 10}`;
}

function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------- tiers

const TIER_NAMES: Readonly<Record<CmaTier | 'rate_pool', string>> = {
  subdivision: 'the same subdivision',
  within_1mi: 'within 1 mile',
  postal_code: 'the same postal code',
  within_3mi: 'within 3 miles',
  city: 'the same city',
  rate_pool: 'the market-rate area',
};

export function tierName(tier: CmaTier | 'rate_pool'): string {
  return TIER_NAMES[tier];
}

export function tierReachedSentence(tier: CmaTier | null, reached: boolean, months: number, rule: CmaRule): string {
  if (tier === null) return 'No area could be searched: the home has no subdivision, coordinates, postal code or city.';
  if (!reached) return `Fewer than ${rule.minComps} similar sales were found, even in ${tierName(tier)} over ${months} months.`;
  return `Comparable sales come from ${tierName(tier)}, sold within ${months} months.`;
}

export function olderSalesSentence(rule: CmaRule): string {
  return `Sales older than ${rule.lookbackMonths} months were used because fewer than ${rule.minComps} similar sales closed in the last ${rule.lookbackMonths} months in any area.`;
}

export function tierSkippedSentence(skipped: readonly CmaTier[]): string | null {
  const distance = skipped.includes('within_1mi') || skipped.includes('within_3mi');
  const parts: string[] = [];
  if (distance) parts.push('distance tiers were skipped because the home has no coordinates');
  if (skipped.includes('subdivision')) parts.push('the subdivision tier was skipped because the home has no subdivision');
  if (skipped.includes('postal_code')) parts.push('the postal-code tier was skipped because the home has no postal code');
  if (skipped.includes('city')) parts.push('the city tier was skipped because the home has no city');
  if (parts.length === 0) return null;
  const s = parts.join('; ');
  return `${s.charAt(0).toUpperCase()}${s.slice(1)}.`;
}

/** F6: a tier whose read hit its limit says so. */
export function tierLimitSentence(read: CmaTierRead, rule: CmaRule): string {
  const limit = read.tier === 'rate_pool' ? rule.ratePoolLimit : rule.tierLimit;
  return `Only the ${count(limit)} most recent sales in ${tierName(read.tier)} were read.`;
}

export function filterSkippedSentence(filter: 'beds' | 'year_built'): string {
  return filter === 'beds'
    ? 'Bedrooms were not compared because the home has no bedroom count.'
    : 'Year built was not compared because the home has no year built.';
}

// ---------------------------------------------------------------- not used

const CONDITION_NAMES: Readonly<Record<CmaSaleCondition, string>> = {
  standard: 'standard sale',
  short_sale: 'short sale',
  reo: 'bank-owned (REO)',
  auction: 'auction',
  probate: 'probate',
  other: 'special sale condition',
};

export function conditionName(c: CmaSaleCondition): string {
  return CONDITION_NAMES[c];
}

export function notUsedSentence(reason: NotUsedReason, ctx: { conditions: readonly CmaSaleCondition[]; rule: CmaRule; lookbackMonths: number }): string {
  switch (reason) {
    case 'not_sold':
      return 'Not used: not a closed sale.';
    case 'no_close_price':
      return 'Not used: no closed price recorded.';
    case 'no_close_date':
      return 'Not used: no close date recorded.';
    case 'after_valuation_date':
      return 'Not used: it closed after the valuation date.';
    case 'too_old':
      return `Not used: it closed more than ${ctx.lookbackMonths} months before the valuation date.`;
    case 'lease':
      return 'Not used: a lease, not a sale.';
    case 'other_property_type':
      return 'Not used: a different property type.';
    case 'no_size':
      return 'Not used: no size recorded.';
    case 'other_size_source':
      return 'Not used: its size is measured differently.';
    case 'subject_listing':
      return 'Not used: this is the home being valued (shown in its sale history).';
    case 'subject_address':
      return "Not used: a sale at this home's address (shown in its sale history).";
    case 'duplicate':
      return 'Not used: the same sale is already counted.';
    case 'sale_condition':
      return `Not used: ${ctx.conditions.map(conditionName).join(', ')}.`;
    case 'implausible_price':
      return 'Not used: the price looks like a rent or a data error.';
    case 'excluded_by_agent':
      return 'Not used: removed by the agent.';
    case 'outside_area':
      return 'Not used: outside the area searched.';
    case 'size_not_similar':
      return `Not used: its size differs by more than ${percent(ctx.rule.sizeToleranceBps)}.`;
    case 'beds_not_similar':
      return `Not used: more than ${plural(ctx.rule.bedsTolerance, 'bedroom', 'bedrooms')} different.`;
    case 'year_built_not_similar':
      return `Not used: built more than ${ctx.rule.yearBuiltTolerance} years apart.`;
    case 'not_among_closest':
      return `Not used: ${ctx.rule.maxComps} closer matches were found.`;
  }
}

// ---------------------------------------------------------------- comps

export function compTierSentence(tier: CmaTier | null, distanceM: number | null): string {
  const where = tier === null ? 'Added by the agent' : `In ${tierName(tier)}`;
  return `${where}; ${distanceM === null ? 'distance not known' : `${miles(distanceM)} away`}.`;
}

export function compIncludedSentence(conditions: readonly CmaSaleCondition[], implausible: boolean): string {
  const parts = conditions.map(conditionName);
  if (implausible) parts.push('a price that looked like a rent or a data error');
  return parts.length === 0 ? 'Added by the agent.' : `Added by the agent after review: ${parts.join(', ')}.`;
}

export function compWeightSentence(weightBps: number, basisBps: number): string {
  return `Counts for ${percent(weightBps)} of the value: its adjustments other than size total ${percent(basisBps)} of its price.`;
}

export function compSoldSentence(closeDate: string, months: number, datedByClose: boolean): string {
  const when = months <= 0 ? 'this month' : `${plural(months, 'month', 'months')} before the valuation date`;
  return `Sold ${closeDate}; price agreed ${when}${datedByClose ? ' (dated by its close date: no contract date)' : ''}.`;
}

// ---------------------------------------------------------------- rates and adjustments

const FEATURE_NAMES: Readonly<Record<AdjustmentFeature, string>> = {
  time: 'Market change',
  size: 'Size',
  beds: 'Bedrooms',
  baths: 'Bathrooms',
  garage: 'Garage spaces',
  pool: 'Private pool',
  year_built: 'Year built',
  lot: 'Lot size',
  stories: 'Stories',
  concessions: 'Seller concessions',
};

export function featureName(f: AdjustmentFeature): string {
  return FEATURE_NAMES[f];
}

/** A feature's display unit and the factor from its stored unit (tenths for baths, garage, stories). */
const UNITS: Readonly<Record<Exclude<AdjustmentFeature, 'time' | 'concessions'>, { unit: string; factor: number }>> = {
  size: { unit: 'sq ft', factor: 1 },
  beds: { unit: 'bedroom', factor: 1 },
  baths: { unit: 'bath', factor: 10 },
  garage: { unit: 'garage space', factor: 10 },
  pool: { unit: 'pool', factor: 1 },
  year_built: { unit: 'year', factor: 1 },
  lot: { unit: 'sq ft of lot', factor: 1 },
  stories: { unit: 'story', factor: 10 },
};

export function displayValue(f: AdjustmentFeature, v: number): string {
  if (f === 'pool') return v === 1 ? 'a pool' : 'no pool';
  if (f === 'baths' || f === 'garage' || f === 'stories') return tenths(v);
  if (f === 'year_built') return String(v);
  if (f === 'size' || f === 'lot') return `${count(v)} sq ft`;
  return count(v);
}

export function supportSentence(f: AdjustmentFeature, s: RateSupport): string {
  switch (s.kind) {
    case 'with_without':
      return `from ${count(s.first)} sales with, ${count(s.second)} without`;
    case 'above_below':
      return `from ${count(s.first)} sales above, ${count(s.second)} below the usual ${f === 'size' ? 'size' : featureName(f).toLowerCase()}`;
    case 'sales_months':
      return `from ${plural(s.first, 'sale', 'sales')} over ${plural(s.second, 'month', 'months')}`;
    case 'none':
      return 'from no sales';
  }
}

export function rateText(f: Exclude<AdjustmentFeature, 'concessions'>, rate: number): string {
  if (f === 'time') return `${percent(rate)} a month`;
  const u = UNITS[f];
  return `${money(rate * u.factor)} per ${u.unit}`;
}

export function rateAppliedSentence(f: Exclude<AdjustmentFeature, 'concessions'>, rate: number, support: RateSupport): string {
  if (f === 'time') return `Prices per sq ft changed by ${percent(rate)} a month (${supportSentence(f, support)}).`;
  return `${featureName(f)}: ${rateText(f, rate)} (${supportSentence(f, support)}).`;
}

const WITH_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  pool: ['with a pool', 'without a pool'],
};

/** "Not enough sales with a pool (1) to measure it." and its kin (F11). */
export function rateUnsupportedSentence(f: Exclude<AdjustmentFeature, 'concessions'>, support: RateSupport, rule: CmaRule): string {
  if (f === 'time') {
    return `No market-change adjustment: ${plural(support.first, 'sale', 'sales')} over ${plural(support.second, 'month', 'months')} (at least ${rule.timeMinSales} over ${rule.timeMinMonths} are needed).`;
  }
  const name = featureName(f).toLowerCase();
  if (support.kind === 'with_without') {
    const words = WITH_WORDS[f] ?? [`with ${name}`, `without ${name}`];
    if (support.first < rule.minSalesPerSide) return `Not enough sales ${words[0]} (${count(support.first)}) to measure it.`;
    if (support.second < rule.minSalesPerSide) return `Not enough sales ${words[1]} (${count(support.second)}) to measure it.`;
    return `Not enough pairs of sales to measure ${name} (${count(support.pairs)}; ${rule.minPairs} are needed).`;
  }
  if (support.kind === 'above_below') {
    if (support.first < rule.minSalesPerSide || support.second < rule.minSalesPerSide) {
      return `Not enough variety in ${name} to measure it: ${count(support.first)} sales above and ${count(support.second)} below the usual.`;
    }
    return `Not enough pairs of sales to measure ${name} (${count(support.pairs)}; ${rule.minPairs} are needed).`;
  }
  return `Not enough sales to measure ${name}.`;
}

export function rateFewValuesSentence(f: AdjustmentFeature, distinct: number, rule: CmaRule): string {
  return `Not enough different ${featureName(f).toLowerCase()} values (${distinct}; ${rule.minDistinctValues} are needed) to measure it.`;
}

export function rateWrongSignSentence(f: Exclude<AdjustmentFeature, 'concessions'>, rate: number): string {
  return `${featureName(f)} measured at ${rateText(f, rate)}, but more ${UNITS[f as keyof typeof UNITS]?.unit ?? featureName(f).toLowerCase()} cannot lower a price, so it is not adjusted.`;
}

export function adjustmentSentence(f: Exclude<AdjustmentFeature, 'concessions'>, subjectValue: number, compValue: number, rate: number, amount: number, support: RateSupport): string {
  if (f === 'time') {
    return `${featureName(f)}: ${plural(compValue, 'month', 'months')} at ${percent(rate)} a month (${supportSentence(f, support)}): ${signedMoney(amount)}.`;
  }
  return `${featureName(f)}: ${displayValue(f, subjectValue)} here, ${displayValue(f, compValue)} there, at ${rateText(f, rate)} (${supportSentence(f, support)}): ${signedMoney(amount)}.`;
}

export function concessionSentence(amount: number): string {
  return `Seller concessions of ${money(amount)} are taken off its price: ${signedMoney(-amount)}.`;
}

// ---------------------------------------------------------------- value and back-test

export function unavailableSentence(reason: 'NO_SALES' | 'INSUFFICIENT_COMPS' | 'SUBJECT_INCOMPLETE' | 'SUBJECT_TYPE_NOT_SUPPORTED', found: number, rule: CmaRule): string {
  switch (reason) {
    case 'NO_SALES':
      return 'No value: no closed sales of this kind of home were found.';
    case 'INSUFFICIENT_COMPS':
      return `No value: ${plural(found, 'comparable sale was', 'comparable sales were')} found, and at least ${rule.minComps} are needed.`;
    case 'SUBJECT_INCOMPLETE':
      return 'No value: the home needs a property type and a size.';
    case 'SUBJECT_TYPE_NOT_SUPPORTED':
      return 'No value: land and other property types are not valued yet.';
  }
}

export function valueSentence(comps: number): string {
  return `The value is the weighted middle of ${count(comps)} adjusted sales; the range runs from the lowest to the highest adjusted sale. An estimate from recent MLS sales, not an appraisal.`;
}

export const BACKTEST_TOO_FEW = 'Not enough recent local sales to measure how close this method comes.';

export function backtestSentence(tested: number, medianMissBps: number, withinBps: number, rule: CmaRule): string {
  return `On ${plural(tested, 'recent local sale', 'recent local sales')}, valued only from earlier sales, this method missed the price by ${percent(medianMissBps)} at the median, and came within ${percent(rule.backtestWithinBps)} on ${percent(withinBps)} of them.`;
}
