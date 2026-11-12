// Test fixtures for core/valuation: a subject, sale and candidate builders, and seeded synthetic
// markets. Every name and place here is invented (the repository is public). Deterministic: the only
// randomness is a seeded PRNG.
import type { CmaCandidate, CmaRef, CmaSale, CmaSubject } from '../types.js';

/** mulberry32: a small seeded PRNG for reproducible fixtures. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export const VALUATION_DATE = '2026-11-28';
/** Microdegrees of latitude per mile (about). */
export const LAT_PER_MILE = 14_493;
export const SUBJECT_LAT = 35_000_000;
export const SUBJECT_LON = -90_000_000;

export function subject(over: Partial<CmaSubject> = {}): CmaSubject {
  return {
    propertyType: 'single_family',
    sqft: 2_000,
    sizeSource: 'LivingArea',
    beds: 3,
    bathsX10: 20,
    yearBuilt: 1995,
    lotSqft: 7_500,
    garageSpacesX10: 20,
    poolPrivate: false,
    storiesX10: 10,
    latE6: SUBJECT_LAT,
    lonE6: SUBJECT_LON,
    postalCode: '99001',
    city: 'Fairview',
    region: 'ZZ',
    subdivisionName: 'Maple Glen',
    addressKey: '100 example st|fairview|zz|99001',
    ownIdentities: ['subject-listing'],
    ownMlsNumbers: ['S100'],
    ...over,
  };
}

export function ref(id: string, over: Partial<CmaRef> = {}): CmaRef {
  return { identity: id, source: 'mls', teamListingId: null, mlsNumber: `M-${id}`, connectionId: 'conn-1', ...over };
}

export function sale(over: Partial<CmaSale> = {}): CmaSale {
  return {
    status: 'sold',
    closePriceCents: 40_000_000,
    closeDate: '2026-09-15',
    contractDate: '2026-08-20',
    listPriceCents: 41_000_000,
    originalListPriceCents: 41_000_000,
    concessionsCents: null,
    saleConditions: [],
    isLease: false,
    propertyType: 'single_family',
    sqft: 2_000,
    sizeSource: 'LivingArea',
    beds: 3,
    bathsX10: 20,
    yearBuilt: 1995,
    lotSqft: 7_500,
    garageSpacesX10: 20,
    poolPrivate: false,
    storiesX10: 10,
    latE6: SUBJECT_LAT + 2_000,
    lonE6: SUBJECT_LON + 2_000,
    postalCode: '99001',
    city: 'Fairview',
    region: 'ZZ',
    subdivisionName: 'Maple Glen',
    addressKey: null,
    daysOnMarket: 20,
    ...over,
  };
}

export function cand(id: string, saleOver: Partial<CmaSale> = {}, refOver: Partial<CmaRef> = {}): CmaCandidate {
  return { ref: ref(id, refOver), sale: sale({ addressKey: `${id} sample rd|fairview|zz|99001`, ...saleOver }) };
}

/** ISO date `months` months before VALUATION_DATE, on day `day`. */
export function monthsBefore(months: number, day = 10, from = VALUATION_DATE): string {
  const idx = Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7)) - 1 - months;
  const y = Math.floor(idx / 12);
  const m = idx - y * 12 + 1;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface MarketSpec {
  readonly n: number;
  readonly seed: number;
  /** $/sq ft at the valuation date, in cents. */
  readonly ppsfCents?: number;
  /** Change of $/sq ft a month, in cents (linear in level). */
  readonly trendCentsPerMonth?: number;
  /** Months of history (sales spread uniformly over the months before the valuation date). */
  readonly months?: number;
  /** Contribution of a private pool, in cents; share of sales with a pool. */
  readonly poolCents?: number;
  readonly poolShare?: number;
  /** Contribution of each bedroom above 3, in cents. */
  readonly bedCents?: number;
  /** Multiplicative noise amplitude (0.01 = +-1 %). */
  readonly noise?: number;
  /** Radius of the market in miles. */
  readonly radiusMiles?: number;
  readonly idPrefix?: string;
}

/**
 * A synthetic linear market: price = sqft x (ppsf + trend x (month - valuation month)) + features,
 * with seeded noise. The subject sits at the centre.
 */
export function linearMarket(spec: MarketSpec): CmaCandidate[] {
  const rnd = prng(spec.seed);
  const ppsf = spec.ppsfCents ?? 20_000;
  const trend = spec.trendCentsPerMonth ?? 0;
  const months = spec.months ?? 24;
  const radius = spec.radiusMiles ?? 1.5;
  const out: CmaCandidate[] = [];
  for (let i = 0; i < spec.n; i++) {
    const back = Math.floor(rnd() * months); // 0 .. months-1 months before the valuation date
    const sqft = 1_500 + Math.floor(rnd() * 1_000);
    const beds = 2 + Math.floor(rnd() * 4);
    const pool = rnd() < (spec.poolShare ?? 0.3);
    const angle = rnd() * 2 * Math.PI;
    const r = rnd() * radius;
    const lat = Math.round(SUBJECT_LAT + Math.sin(angle) * r * LAT_PER_MILE);
    const lon = Math.round(SUBJECT_LON + (Math.cos(angle) * r * LAT_PER_MILE) / Math.cos((35 * Math.PI) / 180));
    const noise = 1 + (rnd() * 2 - 1) * (spec.noise ?? 0);
    const base = sqft * (ppsf - trend * back) + (pool ? (spec.poolCents ?? 0) : 0) + (beds - 3) * (spec.bedCents ?? 0);
    const price = Math.round(base * noise);
    const closeDate = monthsBefore(back, 1 + Math.floor(rnd() * 27));
    const id = `${spec.idPrefix ?? 'm'}${String(i).padStart(4, '0')}`;
    out.push(
      cand(id, {
        closePriceCents: price,
        closeDate,
        contractDate: closeDate,
        listPriceCents: price,
        originalListPriceCents: price,
        sqft,
        beds,
        poolPrivate: pool,
        latE6: lat,
        lonE6: lon,
        postalCode: r < 1 ? '99001' : '99002',
        subdivisionName: r < 0.5 ? 'Maple Glen' : 'Cedar Row',
        yearBuilt: 1985 + Math.floor(rnd() * 20),
      }),
    );
  }
  return out;
}

/** A shuffle by a seeded PRNG (Fisher-Yates). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const rnd = prng(seed);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
}
