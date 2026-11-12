// INTERIM (lane V1-C, until lane V1-B merges): a stand-in for @realty/core/valuation's prepareCma.
//
// V1-B owns the engine (packages/core/src/valuation: CmaRef, CmaSubject, CmaSale schemas, CMA_DEFAULTS, prepareCma;
// mutation-tested, R-CMA-2..5). Lane V1-C may not edit core, so this stand-in keeps the same names and the rules' shape
// so the API can be built and tested end to end. apps/api/src/cma/deps.ts re-exports it; at the V1-B merge deps.ts
// points at @realty/core/valuation and this file is deleted. Its method version says it is the interim one, so a stored
// CMA never passes for V1-B's.
//
// Pure: no I/O, no clock, no randomness; integer cents; the same inputs give the same result in any order (R-CMA-5).
// Reads property, transaction, time and location facts only (strict schemas below; R-CMA-2, R-PRED-4).
// No confidence, probability or score field exists (R-CMA-4, R-AST-13).
import { z } from 'zod';
import { distanceMiles } from './address.js';

export const CMA_PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'manufactured', 'other'] as const;
export type CmaPropertyType = (typeof CMA_PROPERTY_TYPES)[number];
export const SALE_CONDITIONS = ['standard', 'short_sale', 'reo', 'auction', 'probate', 'other'] as const;
export type SaleCondition = (typeof SALE_CONDITIONS)[number];
/** Area tiers, narrowest first (R-CMA-2: tier 1 is the same subdivision within the same postal code or 3 mi). */
export const CMA_TIERS = ['subdivision', 'radius_1mi', 'postal_code', 'city'] as const;
export type CmaTier = (typeof CMA_TIERS)[number];

/** VERIFY (engineering): every value. Changing any of them changes the method version (R-CMA-5). */
export const CMA_DEFAULTS = Object.freeze({
  lookbackMonths: 12,
  tierLimit: 300,
  ratePoolLimit: 600,
  maxComps: 6,
  minComps: 3,
  minSalePriceCents: 1_000_000, // $10,000
  minPctOfOriginalList: 20,
  minSupportPerSide: 10,
  minSupportPairs: 30,
  subdivisionMiles: 3,
  backtestSales: 20,
  backtestWithinPct: 10,
});
export type CmaDefaults = typeof CMA_DEFAULTS;
export const CMA_METHOD_VERSION = 'interim-v1c-1';

const Int = z.number().int();
const Cents = Int.min(0).max(1e13);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The agent-entered subject facts (strict: no other key is accepted, R-CMA-2 / fair housing). */
export const CmaSubjectFactsSchema = z
  .object({
    propertyType: z.enum(CMA_PROPERTY_TYPES).optional(),
    sqft: Int.min(100).max(100_000).optional(),
    beds: Int.min(0).max(50).nullable().optional(),
    bathsX10: Int.min(0).max(500).nullable().optional(),
    yearBuilt: Int.min(1600).max(2100).nullable().optional(),
    lotSqft: Int.min(0).max(1e9).nullable().optional(),
    garageSpacesX10: Int.min(0).max(500).nullable().optional(),
    storiesX10: Int.min(0).max(500).nullable().optional(),
    poolPrivate: z.boolean().nullable().optional(),
    subdivision: z.string().trim().min(1).max(120).nullable().optional(),
  })
  .strict();
export type CmaSubjectFacts = z.infer<typeof CmaSubjectFactsSchema>;

export const CmaSubjectSchema = z
  .object({
    propertyType: z.enum(CMA_PROPERTY_TYPES),
    sqft: Int.min(1),
    sizeSource: z.string().nullable(),
    beds: Int.nullable(),
    bathsX10: Int.nullable(),
    yearBuilt: Int.nullable(),
    lotSqft: Int.nullable(),
    garageSpacesX10: Int.nullable(),
    storiesX10: Int.nullable(),
    poolPrivate: z.boolean().nullable(),
    latE6: Int.nullable(),
    lonE6: Int.nullable(),
    subdivision: z.string().nullable(),
    postalCode: z.string().nullable(),
    city: z.string().nullable(),
    region: z.string().nullable(),
    addressKey: z.string().nullable(),
    listingIds: z.array(z.string()),
    mlsNumbers: z.array(z.string()),
  })
  .strict();
export type CmaSubject = z.infer<typeof CmaSubjectSchema>;

export const CmaRefSchema = z
  .object({
    id: z.string(),
    source: z.enum(['team', 'mls']),
    mlsNumber: z.string().nullable(),
    connectionId: z.string().nullable(),
    brokerage: z.string().nullable(),
    addressKey: z.string().nullable(),
    address: z.object({ line1: z.string(), line2: z.string().nullable(), city: z.string(), region: z.string(), postalCode: z.string() }).strict(),
  })
  .strict();
export type CmaRef = z.infer<typeof CmaRefSchema>;

export const CmaSaleSchema = z
  .object({
    status: z.string(),
    closePriceCents: Cents.nullable(),
    closeDate: Day.nullable(),
    contractDate: Day.nullable(),
    originalListPriceCents: Cents.nullable(),
    concessionsCents: Cents.nullable(),
    saleConditions: z.array(z.enum(SALE_CONDITIONS)),
    daysOnMarket: Int.nullable(),
    propertyType: z.enum(CMA_PROPERTY_TYPES).nullable(),
    sqft: Int.nullable(),
    sizeSource: z.string().nullable(),
    beds: Int.nullable(),
    bathsX10: Int.nullable(),
    yearBuilt: Int.nullable(),
    lotSqft: Int.nullable(),
    latE6: Int.nullable(),
    lonE6: Int.nullable(),
    subdivision: z.string().nullable(),
    postalCode: z.string(),
    isLease: z.boolean(),
  })
  .strict();
export type CmaSale = z.infer<typeof CmaSaleSchema>;

export interface CmaCandidate {
  ref: CmaRef;
  sale: CmaSale;
  /** the tiers whose query returned it */
  tiers: CmaTier[];
}

export interface TierRead {
  tier: CmaTier;
  ran: boolean;
  count: number;
  limit: number;
  limitReached: boolean;
}

export interface CmaInput {
  subject: CmaSubject;
  candidates: readonly CmaCandidate[];
  tiers: readonly TierRead[];
  valuationDate: string;
  include: readonly string[];
  exclude: readonly string[];
  defaults?: CmaDefaults;
}

export interface CmaAdjustment {
  feature: AdjFeature;
  amountCents: number;
  sentence: string;
}
export interface CmaComp {
  ref: CmaRef;
  sale: CmaSale;
  tier: CmaTier;
  distanceMiles: number | null;
  distanceSentence: string;
  adjustments: CmaAdjustment[];
  adjustedPriceCents: number;
  weightBps: number;
  why: string[];
  includedByAgent: boolean;
}
export interface CmaNotUsed {
  ref: CmaRef;
  reason: NotUsedReason;
  sentence: string;
  /** whether the agent may add it back with `include` */
  includable: boolean;
}
export interface CmaRate {
  feature: AdjFeature;
  adjusted: boolean;
  centsPerUnit: number | null;
  unit: string;
  support: { below: number; above: number; pairs: number };
  sentence: string;
}
export interface CmaResult {
  methodVersion: string;
  available: boolean;
  reason: 'INSUFFICIENT_COMPS' | null;
  sentence: string;
  valueCents: number | null;
  lowCents: number | null;
  highCents: number | null;
  comps: CmaComp[];
  notUsed: CmaNotUsed[];
  rates: CmaRate[];
  area: { tierUsed: CmaTier | null; tiers: (TierRead & { sentence: string })[] };
  market: { sales: number; medianPricePerSqftCents: number | null; medianDaysOnMarket: number | null; sentence: string };
  backtest: { tested: number; withinPct: number; within: number; sentence: string };
}

export type AdjFeature = 'time' | 'sqft' | 'beds' | 'baths' | 'concessions';
export type NotUsedReason = 'excluded_by_agent' | 'lease' | 'not_sold' | 'future_sale' | 'outside_lookback' | 'implausible_price' | 'sale_conditions' | 'other_type' | 'other_size_measure' | 'subject' | 'no_size' | 'not_chosen';

const TIER_RANK = new Map(CMA_TIERS.map((t, i) => [t, i]));
const TIER_WORDS: Record<CmaTier, string> = { subdivision: 'the same subdivision', radius_1mi: 'within 1 mile', postal_code: 'the same postal code', city: 'the same city' };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const dollars = (c: number) => `${c < 0 ? '−' : ''}$${Math.round(Math.abs(c) / 100).toLocaleString('en-US')}`;
const CONDITION_WORDS: Record<SaleCondition, string> = { standard: 'standard', short_sale: 'short sale', reo: 'bank-owned (REO)', auction: 'auction', probate: 'probate', other: 'other sale conditions' };

function dayNumber(d: string): number {
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
}
function monthsBefore(d: string, months: number): string {
  const [y, m, day] = d.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 - months, day));
  return t.toISOString().slice(0, 10);
}
function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Why a candidate is not a comp, or null when it is eligible. */
function screen(subject: CmaSubject, c: CmaCandidate, input: CmaInput, d: CmaDefaults): { reason: NotUsedReason; sentence: string; includable: boolean } | null {
  const s = c.sale;
  const id = c.ref.id;
  const isSubject = subject.listingIds.includes(id) || (c.ref.mlsNumber !== null && subject.mlsNumbers.includes(c.ref.mlsNumber)) || (subject.addressKey !== null && c.ref.addressKey === subject.addressKey);
  if (isSubject) return { reason: 'subject', sentence: 'Not used: this is the home being valued (its own sale history).', includable: false };
  if (s.isLease) return { reason: 'lease', sentence: 'Not used: a lease, not a sale.', includable: false };
  if (s.status !== 'sold' || s.closePriceCents === null || s.closePriceCents <= 0 || s.closeDate === null) return { reason: 'not_sold', sentence: 'Not used: not a closed sale.', includable: false };
  if (s.closeDate > input.valuationDate) return { reason: 'future_sale', sentence: 'Not used: it closed after the valuation date.', includable: false };
  if (s.propertyType !== subject.propertyType) return { reason: 'other_type', sentence: 'Not used: a different property type.', includable: false };
  if (s.sqft === null || s.sqft <= 0) return { reason: 'no_size', sentence: 'Not used: its size is not recorded.', includable: false };
  if (subject.sizeSource !== null && s.sizeSource !== null && s.sizeSource !== subject.sizeSource) return { reason: 'other_size_measure', sentence: `Not used: its size is measured differently (${s.sizeSource}).`, includable: false };
  if (s.closeDate < monthsBefore(input.valuationDate, d.lookbackMonths)) return { reason: 'outside_lookback', sentence: `Not used: it sold more than ${d.lookbackMonths} months before the valuation date.`, includable: false };
  if (input.exclude.includes(id)) return { reason: 'excluded_by_agent', sentence: 'Not used: you removed it.', includable: true };
  const included = input.include.includes(id);
  if (!included) {
    if (s.closePriceCents < d.minSalePriceCents || (s.originalListPriceCents !== null && s.closePriceCents * 100 < s.originalListPriceCents * d.minPctOfOriginalList))
      return { reason: 'implausible_price', sentence: 'Not used: the price looks like a rent or a data error.', includable: true };
    const odd = s.saleConditions.filter((x) => x !== 'standard');
    if (odd.length > 0) return { reason: 'sale_conditions', sentence: `Not used: ${odd.map((x) => CONDITION_WORDS[x]).join(', ')}.`, includable: true };
  }
  return null;
}

/** Theil–Sen slope (median of pairwise slopes) in cents per unit, with its support around `at`. */
function slope(points: readonly { x: number; y: number }[], at: number): { rate: number | null; below: number; above: number; pairs: number } {
  const below = points.filter((p) => p.x < at).length;
  const above = points.filter((p) => p.x > at).length;
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
    const a = points[i]!;
    const b = points[j]!;
    if (a.x !== b.x) slopes.push((b.y - a.y) / (b.x - a.x));
  }
  return { rate: median(slopes), below, above, pairs: slopes.length };
}

interface Feature {
  feature: Exclude<AdjFeature, 'concessions'>;
  unit: string;
  canLower: boolean;
  of: (s: CmaSale) => number | null;
  subject: number | null;
  words: string;
}

export { monthsBefore };

export function prepareCma(input: CmaInput): CmaResult {
  const d = input.defaults ?? CMA_DEFAULTS;
  const subject = CmaSubjectSchema.parse(input.subject);
  // one entry per ref id, in a fixed order (input order never matters)
  const byId = new Map<string, CmaCandidate>();
  for (const c of input.candidates) {
    const prev = byId.get(c.ref.id);
    byId.set(c.ref.id, prev ? { ...prev, tiers: [...new Set([...prev.tiers, ...c.tiers])] } : c);
  }
  const all = [...byId.values()].sort((a, b) => cmp(a.ref.id, b.ref.id));
  const notUsed: CmaNotUsed[] = [];
  const eligible: CmaCandidate[] = [];
  for (const c of all) {
    const r = screen(subject, c, input, d);
    if (r) notUsed.push({ ref: c.ref, ...r });
    else eligible.push(c);
  }

  const valDay = dayNumber(input.valuationDate);
  const tierOf = (c: CmaCandidate): CmaTier => [...c.tiers].sort((a, b) => TIER_RANK.get(a)! - TIER_RANK.get(b)!)[0] ?? 'city';
  const dist = (c: CmaCandidate): number | null =>
    subject.latE6 !== null && subject.lonE6 !== null && c.sale.latE6 !== null && c.sale.lonE6 !== null ? distanceMiles({ latE6: subject.latE6, lonE6: subject.lonE6 }, { latE6: c.sale.latE6, lonE6: c.sale.lonE6 }) : null;

  // rates from the run's local sales (R-CMA-3)
  const pool = [...eligible].sort((a, b) => cmp(b.sale.closeDate!, a.sale.closeDate!) || cmp(a.ref.id, b.ref.id)).slice(0, d.ratePoolLimit);
  const saleDay = (s: CmaSale) => dayNumber(s.contractDate ?? s.closeDate!);
  const features: Feature[] = [
    { feature: 'time', unit: 'day', canLower: true, of: (s) => saleDay(s), subject: valDay, words: 'market change since the sale' },
    { feature: 'sqft', unit: 'sq ft', canLower: false, of: (s) => s.sqft, subject: subject.sqft, words: 'size' },
    { feature: 'beds', unit: 'bedroom', canLower: false, of: (s) => s.beds, subject: subject.beds, words: 'bedrooms' },
    { feature: 'baths', unit: 'tenth of a bath', canLower: false, of: (s) => s.bathsX10, subject: subject.bathsX10, words: 'bathrooms' },
  ];
  const rates: CmaRate[] = [];
  const rateOf = new Map<string, number>();
  for (const f of features) {
    const pts = pool.flatMap((c) => {
      const x = f.of(c.sale);
      return x === null ? [] : [{ x, y: c.sale.closePriceCents! - (c.sale.concessionsCents ?? 0) }];
    });
    if (f.subject === null) {
      rates.push({ feature: f.feature, adjusted: false, centsPerUnit: null, unit: f.unit, support: { below: 0, above: 0, pairs: 0 }, sentence: `Not adjusted for ${f.words}: the subject's value is not known.` });
      continue;
    }
    // time: the support sides are the older and newer halves of the sales
    const at = f.feature === 'time' ? (median(pts.map((p) => p.x)) ?? valDay) : f.subject;
    const s = slope(pts, at);
    const support = { below: s.below, above: s.above, pairs: s.pairs };
    const enough = s.below >= d.minSupportPerSide && s.above >= d.minSupportPerSide && s.pairs >= d.minSupportPairs && s.rate !== null;
    if (!enough) {
      rates.push({ feature: f.feature, adjusted: false, centsPerUnit: null, unit: f.unit, support, sentence: `Not adjusted for ${f.words}: not enough local sales (${s.below} below, ${s.above} above; ${d.minSupportPerSide} each needed).` });
      continue;
    }
    if (!f.canLower && s.rate! < 0) {
      rates.push({ feature: f.feature, adjusted: false, centsPerUnit: null, unit: f.unit, support, sentence: `Not adjusted for ${f.words}: local sales show a negative rate, which this feature cannot have.` });
      continue;
    }
    const rate = Math.round(s.rate!);
    rateOf.set(f.feature, rate);
    rates.push({ feature: f.feature, adjusted: true, centsPerUnit: rate, unit: f.unit, support, sentence: `${dollars(rate)} per ${f.unit} for ${f.words}, from ${s.pairs} pairs of local sales.` });
  }
  rates.push({ feature: 'concessions', adjusted: true, centsPerUnit: -1, unit: 'dollar', support: { below: 0, above: 0, pairs: 0 }, sentence: 'Seller concessions are subtracted from the price, dollar for dollar.' });

  // choose: narrowest tier first, then nearest in size, then most recent
  const ranked = [...eligible].sort(
    (a, b) =>
      TIER_RANK.get(tierOf(a))! - TIER_RANK.get(tierOf(b))! ||
      Math.abs(a.sale.sqft! - subject.sqft) - Math.abs(b.sale.sqft! - subject.sqft) ||
      cmp(b.sale.closeDate!, a.sale.closeDate!) ||
      cmp(a.ref.id, b.ref.id),
  );
  const chosen = ranked.slice(0, d.maxComps);
  for (const c of ranked.slice(d.maxComps)) notUsed.push({ ref: c.ref, reason: 'not_chosen', sentence: 'Not used: closer or more similar sales were chosen.', includable: false });

  const raw = chosen.map((c) => {
    const s = c.sale;
    const adjustments: CmaAdjustment[] = [];
    for (const f of features) {
      const rate = rateOf.get(f.feature);
      const x = f.of(s);
      if (rate === undefined || x === null || f.subject === null || x === f.subject) continue;
      const amount = Math.round(rate * (f.subject - x));
      if (amount === 0) continue;
      adjustments.push({ feature: f.feature, amountCents: amount, sentence: f.feature === 'time' ? `${dollars(amount)} for the market since ${s.contractDate ? 'its contract date' : 'its close date (no contract date recorded)'}.` : `${dollars(amount)} for ${f.words} (${x} vs ${f.subject}).` });
    }
    if ((s.concessionsCents ?? 0) > 0) adjustments.push({ feature: 'concessions', amountCents: -s.concessionsCents!, sentence: `${dollars(-s.concessionsCents!)} for seller concessions.` });
    const total = adjustments.reduce((a, x) => a + x.amountCents, 0);
    const gross = adjustments.reduce((a, x) => a + Math.abs(x.amountCents), 0);
    const miles = dist(c);
    const tier = tierOf(c);
    const why = [`Sold ${s.closeDate} in ${TIER_WORDS[tier]}`, `${s.sqft} sq ft (subject ${subject.sqft})`];
    if (input.include.includes(c.ref.id)) why.push('You added it');
    const odd = s.saleConditions.filter((x) => x !== 'standard');
    if (odd.length > 0) why.push(`Labelled: ${odd.map((x) => CONDITION_WORDS[x]).join(', ')}`);
    return {
      c,
      tier,
      miles,
      adjustments,
      adjusted: s.closePriceCents! + total,
      w: 1_000_000 / (1_000 + Math.round((gross * 1_000) / s.closePriceCents!)),
      why,
    };
  });
  // weights in bps summing to 10,000 (largest remainder, ties by id)
  const wsum = raw.reduce((a, r) => a + r.w, 0);
  const shares = raw.map((r) => ({ r, exact: wsum === 0 ? 0 : (r.w * 10_000) / wsum }));
  const floors = shares.map((x) => Math.floor(x.exact));
  let rest = raw.length === 0 ? 0 : 10_000 - floors.reduce((a, b) => a + b, 0);
  const order = shares.map((x, i) => ({ i, frac: x.exact - floors[i]!, id: x.r.c.ref.id })).sort((a, b) => b.frac - a.frac || cmp(a.id, b.id));
  for (const o of order) if (rest-- > 0) floors[o.i]! += 1;

  const comps: CmaComp[] = raw.map((r, i) => ({
    ref: r.c.ref,
    sale: r.c.sale,
    tier: r.tier,
    distanceMiles: r.miles === null ? null : Math.round(r.miles * 100) / 100,
    distanceSentence: r.miles === null ? 'Distance not known' : `${(Math.round(r.miles * 10) / 10).toFixed(1)} mi away`,
    adjustments: r.adjustments,
    adjustedPriceCents: r.adjusted,
    weightBps: floors[i]!,
    why: r.why,
    includedByAgent: input.include.includes(r.c.ref.id),
  }));

  const tiers = CMA_TIERS.map((t) => {
    const read = input.tiers.find((x) => x.tier === t) ?? { tier: t, ran: false, count: 0, limit: d.tierLimit, limitReached: false };
    const sentence = !read.ran
      ? t === 'radius_1mi'
        ? 'Distance search not run: the home has no map location.'
        : `Not searched: ${TIER_WORDS[t]} is not known.`
      : read.limitReached
        ? `${read.count} sales in ${TIER_WORDS[t]}: the search stopped at its limit of ${read.limit}, so only the most recent were read.`
        : `${read.count} sales in ${TIER_WORDS[t]}.`;
    return { ...read, sentence };
  });

  const ppsf = eligible.map((c) => (c.sale.closePriceCents! * 1) / c.sale.sqft!);
  const doms = eligible.flatMap((c) => (c.sale.daysOnMarket === null ? [] : [c.sale.daysOnMarket]));
  const mp = median(ppsf);
  const md = median(doms);
  const market = {
    sales: eligible.length,
    medianPricePerSqftCents: mp === null ? null : Math.round(mp),
    medianDaysOnMarket: md === null ? null : Math.round(md),
    sentence: eligible.length === 0 ? 'No comparable local sales in the look-back.' : `${eligible.length} comparable local sales${mp === null ? '' : `, median ${dollars(Math.round(mp))} per sq ft`}${md === null ? '' : `, median ${Math.round(md)} days on market`}.`,
  };

  // out-of-sample back-test: each recent local sale valued from the others (median price per sq ft of the 5 nearest in size)
  const recent = pool.slice(0, d.backtestSales);
  let within = 0;
  let tested = 0;
  if (pool.length >= 6) {
    for (const t of recent) {
      const others = pool.filter((o) => o.ref.id !== t.ref.id).sort((a, b) => Math.abs(a.sale.sqft! - t.sale.sqft!) - Math.abs(b.sale.sqft! - t.sale.sqft!) || cmp(a.ref.id, b.ref.id)).slice(0, 5);
      const m = median(others.map((o) => o.sale.closePriceCents! / o.sale.sqft!))!;
      const est = m * t.sale.sqft!;
      tested += 1;
      if (Math.abs(est - t.sale.closePriceCents!) * 100 <= t.sale.closePriceCents! * d.backtestWithinPct) within += 1;
    }
  }
  const backtest = {
    tested,
    withinPct: d.backtestWithinPct,
    within,
    sentence: tested === 0 ? 'Not tested: too few recent local sales to test the method on.' : `Tested on ${tested} recent local sales, each valued from the others: ${within} came within ${d.backtestWithinPct} % of the price it sold for.`,
  };

  const tierUsed = comps.length === 0 ? null : comps.map((c) => c.tier).sort((a, b) => TIER_RANK.get(a)! - TIER_RANK.get(b)!).at(-1)!;
  const base = { methodVersion: CMA_METHOD_VERSION, comps, notUsed, rates, area: { tierUsed, tiers }, market, backtest };
  if (comps.length < d.minComps) {
    return { ...base, available: false, reason: 'INSUFFICIENT_COMPS', sentence: `No value: ${comps.length} comparable ${comps.length === 1 ? 'sale was' : 'sales were'} found and at least ${d.minComps} are needed.`, valueCents: null, lowCents: null, highCents: null };
  }
  // weighted median of the adjusted prices (ties by id); the range is lowest to highest adjusted (owner question (f))
  const sorted = [...comps].sort((a, b) => a.adjustedPriceCents - b.adjustedPriceCents || cmp(a.ref.id, b.ref.id));
  let acc = 0;
  let value = sorted.at(-1)!.adjustedPriceCents;
  for (const c of sorted) {
    acc += c.weightBps;
    if (acc * 2 >= 10_000) {
      value = c.adjustedPriceCents;
      break;
    }
  }
  const low = sorted[0]!.adjustedPriceCents;
  const high = sorted.at(-1)!.adjustedPriceCents;
  return { ...base, available: true, reason: null, sentence: `Estimated value ${dollars(value)}, from ${comps.length} comparable sales adjusted to between ${dollars(low)} and ${dollars(high)}. An estimate, not an appraisal.`, valueCents: Math.max(0, value), lowCents: Math.max(0, low), highCents: Math.max(0, high) };
}
