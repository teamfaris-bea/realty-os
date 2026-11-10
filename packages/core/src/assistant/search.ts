// Saved buyer searches proposed from a call (A4; R-AST-5, R-AST-10).
//
// After a call the assistant proposes criteria; each criterion maps to the claim (with call
// evidence) it came from. Criteria from needs-review claims are offered to the agent as prefilled
// but UNCHECKED values and are never part of the stored criteria until the agent checks or edits
// them (R-AST-5). A search becomes active only by the agent's approval (DB trigger, R-AST-10).
// Phase 1 matching uses the team's own `listings` only; alerts go out as `search_alert` /
// marketing through the gate.
import { z } from 'zod';
import { containsWords, normalizeForQuote } from './evidence.js';
import type { Claim } from './types.js';

export const PROPERTY_TYPES = ['single_family', 'condo', 'townhouse', 'multi_family', 'land', 'manufactured', 'other'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];
export type ListingStatus = 'coming_soon' | 'active' | 'pending' | 'sold' | 'withdrawn' | 'expired';

const Cents = z.number().int().min(0).max(100_000_000_000);
const SearchCriteriaInner = z
  .strictObject({
    postalCodes: z.array(z.string().regex(/^\d{5}$/)).min(1).max(50).optional(),
    cities: z
      .array(z.strictObject({ city: z.string().min(1).max(80), region: z.string().regex(/^[A-Z]{2}$/).optional() }))
      .min(1)
      .max(20)
      .optional(),
    priceMinCents: Cents.optional(),
    priceMaxCents: Cents.optional(),
    bedsMin: z.number().int().min(0).max(20).optional(),
    bathsMinX10: z.number().int().min(0).max(200).optional(),
    sqftMin: z.number().int().min(0).max(100_000).optional(),
    sqftMax: z.number().int().min(0).max(100_000).optional(),
    propertyTypes: z.array(z.enum(PROPERTY_TYPES)).min(1).max(PROPERTY_TYPES.length).optional(),
    keywords: z.array(z.string().min(2).max(40)).min(1).max(10).optional(),
  })
  .refine((c) => c.priceMinCents === undefined || c.priceMaxCents === undefined || c.priceMinCents <= c.priceMaxCents, { message: 'price range' })
  .refine((c) => c.sqftMin === undefined || c.sqftMax === undefined || c.sqftMin <= c.sqftMax, { message: 'sqft range' });

/** saved_searches.criteria */
export type SearchCriteria = z.infer<typeof SearchCriteriaInner>;
export const SearchCriteriaSchema: z.ZodType<SearchCriteria> = SearchCriteriaInner;

export type CriterionKey = keyof SearchCriteria;
export const CRITERION_KEYS: readonly CriterionKey[] = ['postalCodes', 'cities', 'priceMinCents', 'priceMaxCents', 'bedsMin', 'bathsMinX10', 'sqftMin', 'sqftMax', 'propertyTypes', 'keywords'];
const LIST_KEYS: ReadonlySet<CriterionKey> = new Set<CriterionKey>(['postalCodes', 'cities', 'propertyTypes', 'keywords']);

// ---- model criteria (what the prompt asks for) → typed values -------------------------------------

/** Model-facing names (dollars, decimal baths) → stored keys. */
const MODEL_KEYS: Record<string, CriterionKey> = {
  postal_codes: 'postalCodes',
  postal_code: 'postalCodes',
  zip: 'postalCodes',
  cities: 'cities',
  city: 'cities',
  price_min: 'priceMinCents',
  price_max: 'priceMaxCents',
  beds_min: 'bedsMin',
  baths_min: 'bathsMinX10',
  sqft_min: 'sqftMin',
  sqft_max: 'sqftMax',
  property_types: 'propertyTypes',
  property_type: 'propertyTypes',
  keywords: 'keywords',
};

const TYPE_SYNONYMS: Record<string, PropertyType> = {
  single_family: 'single_family',
  'single family': 'single_family',
  house: 'single_family',
  home: 'single_family',
  detached: 'single_family',
  condo: 'condo',
  condominium: 'condo',
  apartment: 'condo',
  townhouse: 'townhouse',
  townhome: 'townhouse',
  'town home': 'townhouse',
  multi_family: 'multi_family',
  'multi family': 'multi_family',
  duplex: 'multi_family',
  triplex: 'multi_family',
  fourplex: 'multi_family',
  land: 'land',
  lot: 'land',
  manufactured: 'manufactured',
  'mobile home': 'manufactured',
};

function asList(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [v];
}

function dollarsToCents(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '').replace(/k$/i, '000')) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

function intOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/[,\s]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

/**
 * Validates one criterion. Model-facing keys (`price_max` in dollars, `baths_min` decimal …) are
 * converted to stored units; stored keys (`priceMaxCents` …) are validated as they are. Values the
 * schema would reject are not ok.
 */
export function parseCriterion(key: string, value: unknown): { ok: true; key: CriterionKey; value: SearchCriteria[CriterionKey] } | { ok: false } {
  // `cities` and `keywords` are both model and stored names; their conversion is idempotent.
  const stored = MODEL_KEYS[key] === undefined ? CRITERION_KEYS.find((x) => x === key) : undefined;
  if (stored !== undefined) {
    // Already in stored units (cents, baths ×10), e.g. a claim's validated structured.criterion.
    const p = SearchCriteriaInner.safeParse({ [stored]: value });
    return p.success ? { ok: true, key: stored, value: (p.data as Record<string, unknown>)[stored] as SearchCriteria[CriterionKey] } : { ok: false };
  }
  const k: CriterionKey | undefined = MODEL_KEYS[key];
  if (k === undefined) return { ok: false };
  let v: unknown;
  switch (k) {
    case 'postalCodes':
      v = asList(value).map((x) => String(x).trim().slice(0, 5));
      break;
    case 'cities':
      v = asList(value).map((x) => {
        if (typeof x === 'object' && x !== null) return x;
        const [city, region] = String(x).split(',').map((s) => s.trim());
        return region ? { city, region: region.toUpperCase() } : { city };
      });
      break;
    case 'priceMinCents':
    case 'priceMaxCents':
      v = dollarsToCents(value);
      break;
    case 'bathsMinX10': {
      const n = typeof value === 'number' ? value : Number(value);
      v = Number.isFinite(n) ? Math.round(n * 10) : null;
      break;
    }
    case 'propertyTypes':
      v = asList(value).map((x) => TYPE_SYNONYMS[String(x).trim().toLowerCase().replace(/-/g, ' ')] ?? String(x));
      break;
    case 'keywords':
      v = asList(value).map((x) => String(x).trim());
      break;
    default:
      v = intOf(value);
  }
  const p = SearchCriteriaInner.safeParse({ [k]: v });
  if (!p.success) return { ok: false };
  return { ok: true, key: k, value: (p.data as Record<string, unknown>)[k] as SearchCriteria[CriterionKey] };
}

// ---- grounding: the value must be in the client's words (E33) -----------------------------------------

const NUMBER_WORDS: Readonly<Record<string, number>> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

/** Numbers in a normalized snippet: digits (with separators, decimals and k/thousand/million) and number words. */
function numbersIn(snippet: string): { value: number; bare: boolean }[] {
  const out: { value: number; bare: boolean }[] = [];
  const re = /(?<![\p{L}\p{N}.,])(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?![\p{N}])(?:\s*(k|thousand|grand|mm|m|mil|million)(?![\p{L}]))?/gu;
  for (const m of snippet.matchAll(re)) {
    const base = Number((m[1] as string).replace(/,/g, ''));
    const u = m[2];
    const mult = u === undefined ? 1 : u === 'k' || u === 'thousand' || u === 'grand' ? 1_000 : 1_000_000;
    out.push({ value: base * mult, bare: u === undefined });
  }
  for (const m of snippet.matchAll(/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/g)) out.push({ value: NUMBER_WORDS[m[1] as string] as number, bare: true });
  return out;
}

function phraseIn(snippets: readonly string[], phrase: string): boolean {
  const p = normalizeForQuote(phrase).text;
  return snippets.some((s) => containsWords(s, p) || containsWords(s, `${p}s`) || (p.endsWith('s') && containsWords(s, p.slice(0, -1))));
}

function numberIn(snippets: readonly string[], n: number, opts: { thousandsShorthand?: boolean } = {}): boolean {
  return snippets.some((s) =>
    numbersIn(s).some((x) => Math.abs(x.value - n) < 0.005 || (opts.thousandsShorthand === true && x.bare && x.value >= 100 && x.value < 1000 && Math.abs(x.value * 1000 - n) < 0.005)),
  );
}

/**
 * Whether a parsed criterion's value appears in the (normalized, verified) snippets of its claim:
 * zips, cities, keywords and property types as whole words; prices, beds, baths and sizes as
 * numbers ("$450,000", "450k", "450 thousand", "a 3 bedroom", "three bedrooms", "2.5 baths").
 * A value the client never said makes the claim needs_review (an unchecked prefill), never a
 * stored criterion (R-AST-5).
 */
export function criterionQuoted(key: CriterionKey, value: unknown, snippets: readonly string[]): boolean {
  if (snippets.length === 0) return false;
  switch (key) {
    case 'postalCodes':
      return (value as string[]).every((z) => snippets.some((s) => containsWords(s, z)));
    case 'cities':
      return (value as { city: string }[]).every((c) => phraseIn(snippets, c.city));
    case 'keywords':
      return (value as string[]).every((k) => phraseIn(snippets, k));
    case 'propertyTypes':
      return (value as PropertyType[]).every((t) =>
        [t.replace(/_/g, ' '), ...Object.entries(TYPE_SYNONYMS).filter(([, v]) => v === t).map(([k]) => k.replace(/_/g, ' '))].some((w) => phraseIn(snippets, w)),
      );
    case 'priceMinCents':
    case 'priceMaxCents':
      return numberIn(snippets, (value as number) / 100, { thousandsShorthand: true });
    case 'bathsMinX10':
      return numberIn(snippets, (value as number) / 10);
    default:
      return numberIn(snippets, value as number);
  }
}

// ---- proposal -------------------------------------------------------------------------------------

export interface SearchProposal {
  /** Only criteria from trustworthy claims: what would be stored and matched. */
  criteria: SearchCriteria;
  /** criterion key → id of the claim it came from (saved_searches.criterion_evidence). */
  criterionEvidence: Record<string, string>;
  /** Keys shown prefilled but unchecked: they come from needs-review or conflicting claims. */
  unchecked: CriterionKey[];
  /** The prefilled values of the unchecked keys (additive to the spec; never stored as criteria). */
  prefill: Partial<SearchCriteria>;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * R-AST-5 / A4: builds a saved-search proposal from claims whose `structured.criterion` is set.
 * Needs-review claims only prefill (unchecked); conflicting scalar values are unchecked too.
 */
export function proposeSearch(claims: readonly Claim[]): SearchProposal {
  const values = new Map<CriterionKey, unknown>();
  const evidence: Record<string, string> = {};
  const unchecked = new Set<CriterionKey>();
  for (const c of claims) {
    const crit = c.structured?.criterion;
    if (crit === undefined) continue;
    const parsed = parseCriterion(crit.key, crit.value);
    if (!parsed.ok) continue;
    const k = parsed.key;
    if (c.needsReview) unchecked.add(k);
    if (evidence[k] === undefined) evidence[k] = c.id;
    const prev = values.get(k);
    if (prev === undefined) values.set(k, parsed.value);
    else if (LIST_KEYS.has(k)) {
      const merged = [...(prev as unknown[])];
      for (const x of parsed.value as unknown[]) if (!merged.some((y) => sameValue(x, y))) merged.push(x);
      values.set(k, merged);
    } else if (!sameValue(prev, parsed.value)) {
      unchecked.add(k);
      values.set(k, parsed.value);
    }
  }
  const criteria: Record<string, unknown> = {};
  const prefill: Record<string, unknown> = {};
  for (const [k, v] of values) (unchecked.has(k) ? prefill : criteria)[k] = v;
  // A range conflict between two trustworthy claims (min > max): neither side is stored.
  for (const [lo, hi] of [['priceMinCents', 'priceMaxCents'], ['sqftMin', 'sqftMax']] as const) {
    if (typeof criteria[lo] === 'number' && typeof criteria[hi] === 'number' && (criteria[lo] as number) > (criteria[hi] as number)) {
      for (const k of [lo, hi]) {
        prefill[k] = criteria[k];
        delete criteria[k];
        unchecked.add(k);
      }
    }
  }
  return {
    // every value passed parseCriterion and ranges are consistent, so this always parses
    criteria: SearchCriteriaInner.parse(criteria),
    criterionEvidence: evidence,
    unchecked: CRITERION_KEYS.filter((k) => unchecked.has(k)),
    prefill: prefill as Partial<SearchCriteria>,
  };
}

/**
 * The criteria the agent approves: the trustworthy ones, plus the unchecked keys the agent checked
 * (with their prefilled values), plus the agent's own edits. Returns null when the result is
 * invalid. The agent is a human acting as themselves (DB trigger); this function is pure.
 */
export function applySearchReview(p: Pick<SearchProposal, 'criteria' | 'prefill'>, review: { checked: readonly CriterionKey[]; removed?: readonly CriterionKey[]; edits?: Partial<SearchCriteria> }): SearchCriteria | null {
  const out: Record<string, unknown> = { ...p.criteria };
  for (const k of review.checked) if (p.prefill[k] !== undefined) out[k] = p.prefill[k];
  for (const k of review.removed ?? []) delete out[k];
  for (const [k, v] of Object.entries(review.edits ?? {})) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  const parsed = SearchCriteriaInner.safeParse(out);
  return parsed.success ? parsed.data : null;
}

export function hasCriteria(c: SearchCriteria): boolean {
  return CRITERION_KEYS.some((k) => c[k] !== undefined);
}

// ---- matching -------------------------------------------------------------------------------------

export interface ListingFacts {
  source: 'team' | 'mls';
  status: ListingStatus;
  postalCode: string;
  city: string;
  region: string;
  listPriceCents: number | null;
  beds: number | null;
  bathsX10: number | null;
  sqft: number | null;
  propertyType: PropertyType | null;
  description: string | null;
}

const MATCHABLE: ReadonlySet<ListingStatus> = new Set<ListingStatus>(['active', 'coming_soon']);

function words(s: string): string {
  return ` ${s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
}

/**
 * Whether a listing matches approved criteria (R-AST-10: Phase 1 matches team listings only, and
 * only active / coming-soon ones). A criterion on a field the listing lacks does not match. Empty
 * criteria match nothing (never an alert for every listing).
 */
export function matchListing(c: SearchCriteria, l: ListingFacts): boolean {
  if (l.source !== 'team' || !MATCHABLE.has(l.status) || !hasCriteria(c)) return false;
  if (c.postalCodes !== undefined || c.cities !== undefined) {
    const zip = l.postalCode.trim().slice(0, 5);
    const inZip = c.postalCodes?.includes(zip) ?? false;
    const inCity =
      c.cities?.some((x) => x.city.trim().toLowerCase() === l.city.trim().toLowerCase() && (x.region === undefined || x.region === l.region.trim().toUpperCase())) ?? false;
    if (!inZip && !inCity) return false;
  }
  const atLeast = (min: number | undefined, v: number | null): boolean => min === undefined || (v !== null && v >= min);
  const atMost = (max: number | undefined, v: number | null): boolean => max === undefined || (v !== null && v <= max);
  if (!atLeast(c.priceMinCents, l.listPriceCents) || !atMost(c.priceMaxCents, l.listPriceCents)) return false;
  if (!atLeast(c.bedsMin, l.beds) || !atLeast(c.bathsMinX10, l.bathsX10)) return false;
  if (!atLeast(c.sqftMin, l.sqft) || !atMost(c.sqftMax, l.sqft)) return false;
  if (c.propertyTypes !== undefined && (l.propertyType === null || !c.propertyTypes.includes(l.propertyType))) return false;
  if (c.keywords !== undefined) {
    const hay = words(l.description ?? '');
    if (!c.keywords.every((k) => hay.includes(words(k)))) return false;
  }
  return true;
}

/** Saved-search alerts are marketing in the search_alert category (R-AST-10); the gate blocks them for an opted-out address (no consent level is read). */
export const SEARCH_ALERT = Object.freeze({ category: 'search_alert', purpose: 'marketing' } as const);
