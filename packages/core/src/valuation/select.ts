// Comparable selection (R-CMA-2): which sales may be comps, the area tiers, the similarity filters and
// the tier search. Pure. Every decision here reads only the strict input facts (types.ts).
import type { CmaCandidate, CmaRule, CmaSaleCondition, CmaSubject, CmaTier, NotUsedReason } from './types.js';
import { CMA_TIERS } from './types.js';

// ---------------------------------------------------------------- calendar (ISO dates, UTC arithmetic)

const DAY_MS = 86_400_000;

/** Days since 1970-01-01 of an ISO date. */
export function dayNumber(iso: string): number {
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / DAY_MS;
}

/** Whole-month index (year * 12 + month - 1). */
export function monthIndex(iso: string): number {
  return Number(iso.slice(0, 4)) * 12 + Number(iso.slice(5, 7)) - 1;
}

/** The ISO date `months` months after `iso` (negative: before), the day clamped to the month's length. */
export function addMonths(iso: string, months: number): string {
  const idx = monthIndex(iso) + months;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12; // 0-based
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const d = Math.min(Number(iso.slice(8, 10)), last);
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- geography

const EARTH_RADIUS_M = 6_371_008.8;

/** Great-circle distance in whole metres between two microdegree coordinates (haversine). */
export function distanceM(latA: number, lonA: number, latB: number, lonB: number): number {
  const rad = Math.PI / 180_000_000;
  const p1 = latA * rad;
  const p2 = latB * rad;
  const dp = (latB - latA) * rad;
  const dl = (lonB - lonA) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h))));
}

interface Located {
  readonly latE6: number | null;
  readonly lonE6: number | null;
}
function coords(f: Located): readonly [number, number] | null {
  return f.latE6 === null || f.lonE6 === null ? null : [f.latE6, f.lonE6];
}

/** Distance between subject and sale, or null when either lacks coordinates ("distance not known"). */
export function distanceBetween(a: Located, b: Located): number | null {
  const ca = coords(a);
  const cb = coords(b);
  return ca === null || cb === null ? null : distanceM(ca[0], ca[1], cb[0], cb[1]);
}

// ---------------------------------------------------------------- place keys

const SUBDIVISION_PLACEHOLDERS = new Set(['', 'none', 'n/a', 'na', '0', '-', 'no', 'unknown', 'not applicable', 'not in a subdivision']);

/** Normalized subdivision name; MLS placeholders ("None", "N/A", "0") are no subdivision (E362). */
export function subdivisionKey(name: string | null): string | null {
  if (name === null) return null;
  const k = name.trim().toLowerCase().replace(/\s+/g, ' ');
  return SUBDIVISION_PLACEHOLDERS.has(k) ? null : k;
}

/** The 5-digit ZIP of a postal code ("33101-1234" -> "33101"), else the trimmed upper-case code. */
export function postalKey(code: string | null): string | null {
  if (code === null) return null;
  const t = code.trim().toUpperCase();
  if (t === '') return null;
  const zip = /^(\d{5})(?:$|[-\s]?\d{4}$)/.exec(t);
  return zip ? (zip[1] as string) : t;
}

function placeKey(s: string | null): string | null {
  if (s === null) return null;
  const k = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return k === '' ? null : k;
}

// ---------------------------------------------------------------- tiers

export interface SubjectPlace {
  readonly subdivision: string | null;
  readonly postal: string | null;
  readonly city: string | null;
  readonly region: string | null;
  readonly located: boolean;
}

export function subjectPlace(s: CmaSubject): SubjectPlace {
  return {
    subdivision: subdivisionKey(s.subdivisionName),
    postal: postalKey(s.postalCode),
    city: placeKey(s.city),
    region: placeKey(s.region),
    located: coords(s) !== null,
  };
}

/** Whether a tier can be used for this subject (it has the fact the tier needs). */
export function tierAvailable(place: SubjectPlace, tier: CmaTier): boolean {
  switch (tier) {
    case 'subdivision':
      return place.subdivision !== null;
    case 'within_1mi':
    case 'within_3mi':
      return place.located;
    case 'postal_code':
      return place.postal !== null;
    case 'city':
      return place.city !== null;
  }
}

/**
 * The index in CMA_TIERS of the narrowest available tier the sale is in, or -1 when it is in none.
 * Tier 1 is the same subdivision AND (the same 5-digit postal code, or within 3 mi when both sides have
 * coordinates): a same-named subdivision in another town is never tier 1 (F5, E362).
 */
interface SalePlace {
  readonly subdivision: string | null;
  readonly postal: string | null;
  readonly city: string | null;
  readonly region: string | null;
}
type PlaceFacts = { readonly subdivisionName: string | null; readonly postalCode: string | null; readonly city: string | null; readonly region: string | null };
const PLACE_CACHE = new WeakMap<PlaceFacts, SalePlace>();
function salePlace(sale: PlaceFacts): SalePlace {
  let p = PLACE_CACHE.get(sale);
  if (p === undefined) {
    p = { subdivision: subdivisionKey(sale.subdivisionName), postal: postalKey(sale.postalCode), city: placeKey(sale.city), region: placeKey(sale.region) };
    PLACE_CACHE.set(sale, p);
  }
  return p;
}

export function narrowestTier(place: SubjectPlace, sale: PlaceFacts, dist: number | null, rule: CmaRule): number {
  const sp = salePlace(sale);
  const samePostal = place.postal !== null && sp.postal === place.postal;
  for (let i = 0; i < CMA_TIERS.length; i++) {
    const tier = CMA_TIERS[i] as CmaTier;
    if (!tierAvailable(place, tier)) continue;
    let inTier: boolean;
    switch (tier) {
      case 'subdivision':
        inTier = sp.subdivision === place.subdivision && (samePostal || (dist !== null && dist <= rule.farRadiusM));
        break;
      case 'within_1mi':
        inTier = dist !== null && dist <= rule.nearRadiusM;
        break;
      case 'postal_code':
        inTier = samePostal;
        break;
      case 'within_3mi':
        inTier = dist !== null && dist <= rule.farRadiusM;
        break;
      case 'city':
        inTier = sp.city === place.city && (place.region === null || sp.region === null || sp.region === place.region);
        break;
    }
    if (inTier) return i;
  }
  return -1;
}

// ---------------------------------------------------------------- screening

/** One candidate after the subject-independent and subject-dependent rules (no rates yet). */
export interface Screened {
  readonly c: CmaCandidate;
  /** Contract date, else close date (the date the price was agreed); null without either. */
  readonly refDate: string | null;
  readonly datedByClose: boolean;
  readonly distanceM: number | null;
  /** Index in CMA_TIERS of the narrowest tier, -1 outside every tier. */
  readonly tierIdx: number;
  /** First rule the sale fails as a comp (include applied); null = eligible. 'too_old' is relative to the extended look-back. */
  readonly fail: NotUsedReason | null;
  /** Eligible apart from the look-back, under the default rules (no include): the rate pool and back-test read these. */
  readonly defaultOk: boolean;
  /** Its only failures are the sale-condition or plausibility rules, so the agent may add it. */
  readonly includable: boolean;
  /** Eligible because the agent added it. */
  readonly included: boolean;
  readonly conditions: readonly CmaSaleCondition[];
  /** The first similarity filter it fails (null = similar). */
  readonly similarFail: NotUsedReason | null;
  /** It is the subject's own listing or a sale at the subject's address (E365). */
  readonly subjectSale: boolean;
}

/** Sort candidates into one canonical order so every result is independent of input order (R-CMA-5). */
export function canonicalOrder(candidates: readonly CmaCandidate[]): CmaCandidate[] {
  const keyed = candidates.map((c) => ({ c, json: null as string | null }));
  const json = (k: { c: CmaCandidate; json: string | null }) => (k.json ??= JSON.stringify([k.c.ref, k.c.sale]));
  keyed.sort((a, b) => {
    if (a.c.ref.identity !== b.c.ref.identity) return a.c.ref.identity < b.c.ref.identity ? -1 : 1;
    if (a.c.ref.source !== b.c.ref.source) return a.c.ref.source === 'team' ? -1 : 1;
    const ja = json(a);
    const jb = json(b);
    return ja === jb ? 0 : ja < jb ? -1 : 1;
  });
  return keyed.map((k) => k.c);
}

/** Whether the closed price is plausible for a sale (F13): not a rent or a data error. */
export function plausiblePrice(closePriceCents: number, originalListPriceCents: number | null, rule: CmaRule): boolean {
  if (closePriceCents < rule.minSalePriceCents) return false;
  if (originalListPriceCents !== null && originalListPriceCents > 0 && closePriceCents * 10_000 < originalListPriceCents * rule.minCloseToOriginalListBps) return false;
  return true;
}

function similarity(subject: CmaSubject, sale: CmaCandidate['sale'], rule: CmaRule): NotUsedReason | null {
  const s = subject.sqft as number;
  const c = sale.sqft as number;
  if (Math.abs(c - s) * 10_000 > rule.sizeToleranceBps * s) return 'size_not_similar';
  if (subject.beds !== null && sale.beds !== null && Math.abs(sale.beds - subject.beds) > rule.bedsTolerance) return 'beds_not_similar';
  if (subject.yearBuilt !== null && sale.yearBuilt !== null && Math.abs(sale.yearBuilt - subject.yearBuilt) > rule.yearBuiltTolerance) return 'year_built_not_similar';
  return null;
}

/**
 * Screens every candidate against R-CMA-2 for this subject and valuation date. `canonical` must be in
 * canonicalOrder (the first of a duplicate group in that order is the one counted, R-MLS-5).
 * The subject must have a property type and a size (prepareCma checks this first).
 */
export function screen(subject: CmaSubject, canonical: readonly CmaCandidate[], valuationDate: string, rule: CmaRule, include: ReadonlySet<string>, distanceForAll = true): Screened[] {
  const place = subjectPlace(subject);
  const ownIds = new Set(subject.ownIdentities);
  const ownMls = new Set(subject.ownMlsNumbers);
  const oldest = addMonths(valuationDate, -rule.extendedLookbackMonths);
  const seenIdentity = new Set<string>();
  const seenTeam = new Set<string>();
  const out: Screened[] = [];
  for (const c of canonical) {
    const { ref, sale } = c;
    const refDate = sale.contractDate ?? sale.closeDate;
    const conditions = sale.saleConditions.length === 0 ? sale.saleConditions : sale.saleConditions.filter((x) => x !== 'standard');
    const ownListing = ownIds.has(ref.identity) || (ref.teamListingId !== null && ownIds.has(ref.teamListingId)) || (ref.mlsNumber !== null && ownMls.has(ref.mlsNumber));
    const subjectSale = ownListing || (subject.addressKey !== null && sale.addressKey === subject.addressKey);
    let fail: NotUsedReason | null = null;
    let includable = false;
    let included = false;
    let defaultOk = false;
    if (subjectSale) fail = ownListing ? 'subject_listing' : 'subject_address';
    else if (sale.status !== 'sold') fail = 'not_sold';
    else if (sale.closePriceCents === null || sale.closePriceCents <= 0) fail = 'no_close_price';
    else if (sale.closeDate === null) fail = 'no_close_date';
    else if (sale.closeDate > valuationDate) fail = 'after_valuation_date';
    else if (sale.isLease) fail = 'lease';
    else if (sale.propertyType !== subject.propertyType) fail = 'other_property_type';
    else if (sale.sqft === null || sale.sqft <= 0) fail = 'no_size';
    else if (sale.sizeSource !== subject.sizeSource) fail = 'other_size_source';
    else {
      const condFail = conditions.length > 0;
      const priceFail = !plausiblePrice(sale.closePriceCents, sale.originalListPriceCents, rule);
      defaultOk = !condFail && !priceFail;
      includable = condFail || priceFail;
      // The agent's include pins a sale into the comps; it lifts only these two rules (E367, F13).
      included = include.has(ref.identity);
      if (includable && !included) fail = condFail ? 'sale_condition' : 'implausible_price';
      if (fail === null) {
        // Counted once (R-MLS-5): the first of an identity or a team listing in canonical order.
        if (seenIdentity.has(ref.identity) || (ref.teamListingId !== null && seenTeam.has(ref.teamListingId))) {
          fail = 'duplicate';
          defaultOk = false;
          included = false;
          includable = false;
        } else {
          seenIdentity.add(ref.identity);
          if (ref.teamListingId !== null) seenTeam.add(ref.teamListingId);
          if ((sale.closeDate as string) <= oldest) fail = 'too_old';
        }
      }
    }
    const eligibleish = fail === null || fail === 'too_old';
    const dist = eligibleish || distanceForAll ? distanceBetween(subject, sale) : null;
    out.push({
      c,
      refDate,
      datedByClose: sale.contractDate === null,
      distanceM: dist,
      tierIdx: eligibleish ? narrowestTier(place, sale, dist, rule) : -1,
      fail,
      defaultOk: defaultOk && eligibleish,
      includable,
      included: included && eligibleish,
      conditions,
      similarFail: eligibleish ? similarity(subject, sale, rule) : null,
      subjectSale,
    });
  }
  return out;
}

// ---------------------------------------------------------------- tier search

export interface TierSearch {
  /** Index in CMA_TIERS of the reached tier, or -1 when no tier is available for the subject. */
  readonly tierIdx: number;
  readonly lookbackMonths: number;
  /** Whether a tier held enough comps (else the widest available tier at the extended look-back). */
  readonly reached: boolean;
  readonly skipped: readonly CmaTier[];
}

/** Whether the sale closed within `months` of the valuation date. */
export function withinMonths(s: Screened, valuationDate: string, months: number): boolean {
  return closedAfter(s, addMonths(valuationDate, -months));
}

/** Whether the sale closed after the (exclusive) cutoff date. */
export function closedAfter(s: Screened, cutoffExclusive: string): boolean {
  return (s.c.sale.closeDate as string) > cutoffExclusive;
}

/**
 * Widens tier by tier, first at the look-back and then every tier at the extended look-back, until at
 * least minComps eligible sales pass the similarity filters (agent-added sales count). Records the tier.
 */
export function searchTier(subject: CmaSubject, screened: readonly Screened[], valuationDate: string, rule: CmaRule, exclude: ReadonlySet<string>): TierSearch {
  const place = subjectPlace(subject);
  const available: number[] = [];
  const skipped: CmaTier[] = [];
  CMA_TIERS.forEach((t, i) => (tierAvailable(place, t) ? available.push(i) : skipped.push(t)));
  const usable = screened.filter((s) => s.fail === null && !exclude.has(s.c.ref.identity));
  const forced = usable.filter((s) => s.included).length;
  const free = usable.filter((s) => !s.included && s.similarFail === null && s.tierIdx >= 0);
  for (const months of [rule.lookbackMonths, rule.extendedLookbackMonths]) {
    const cutoff = addMonths(valuationDate, -months);
    const inWindow = free.filter((s) => closedAfter(s, cutoff));
    for (const k of available) {
      if (forced + inWindow.filter((s) => s.tierIdx <= k).length >= rule.minComps) return { tierIdx: k, lookbackMonths: months, reached: true, skipped };
    }
  }
  return { tierIdx: available.length > 0 ? (available[available.length - 1] as number) : -1, lookbackMonths: rule.extendedLookbackMonths, reached: false, skipped };
}

/** The rate pool's tier: the reached tier widened to at least the postal code (the next available tier). */
export function poolTierIndex(subject: CmaSubject, reachedIdx: number): number {
  const place = subjectPlace(subject);
  const postalIdx = CMA_TIERS.indexOf('postal_code');
  let widest = -1;
  for (let i = 0; i < CMA_TIERS.length; i++) {
    if (!tierAvailable(place, CMA_TIERS[i] as CmaTier)) continue;
    widest = i;
    if (i >= postalIdx && i >= reachedIdx) return i;
  }
  return widest;
}
