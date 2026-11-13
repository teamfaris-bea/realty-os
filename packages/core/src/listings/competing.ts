// Competing listings for a seller's listing (R-MLS-3, R-MLS-5; used by seller updates and
// GET /listings/:id/competing).
//
// Criteria are property and market facts only: area (same city or postal code; no radius), list
// price band, bedrooms, property type and status. Nothing about people, schools or neighbourhood
// character (fair housing).
//
// Handling:
// - the subject, mirrors of it (an mls row whose `team_listing_id` is the subject, the team row an
//   mls subject mirrors, other mirrors of the same team listing) and rows with the subject's MLS
//   number are never competitors;
// - candidates are first de-duplicated (`dedupeMirrors`, R-MLS-5 / E81): a mirrored team listing
//   counts once and the team row is authoritative;
// - `rule.mlsFeedStale` (R-MLS-3): MLS candidates pause; team listings remain;
// - `rule.onlyDisplayAllowed` (R-MLS-2, client-facing output): MLS candidates whose broker opted out
//   of internet display are dropped. The caller still renders each one through applyDisplayRules.
// - a lease (`valuation.isLease`, E360) never competes: its list price is a monthly rent, not a price for sale
//   (batch 10 review ownership-data/F5: the CMA's market context, the agent's competing view and seller updates).
//
// Order (deterministic, independent of input order):
//   1. absolute list-price distance from the subject, ascending (unknown prices last);
//   2. absolute bedroom difference, ascending (unknown last);
//   3. status: coming_soon, active, pending, sold, withdrawn, expired;
//   4. `listingIdentity`, ascending (code-unit order, not locale).
import { LISTING_STATUSES, type CompetingRule, type CriterionMatch, type ListingFacts, type MirrorStatusMismatch } from './types.js';

export const DEFAULT_COMPETING_RULE: CompetingRule = Object.freeze<CompetingRule>({
  area: 'postal_code',
  priceBandPct: 10,
  bedsDelta: 1,
  samePropertyType: false,
  statuses: ['active', 'pending'],
  maxCount: 10,
  onlyDisplayAllowed: false,
  mlsFeedStale: false,
});

/** A stable identity: the stored id, else `source:connection:mlsNumber-or-listingKey`. */
export function listingIdentity(l: ListingFacts): string {
  return l.id ?? `${l.source}:${l.mlsConnectionId ?? ''}:${l.mlsNumber ?? l.listingKey ?? ''}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * R-MLS-5 / E81: counts a mirrored team listing once. An mls row whose `teamListingId` names a team
 * row in the input is dropped (the team row is authoritative) and a status disagreement is reported.
 * Mirrors whose team row is absent stay, one per team listing (the lowest identity). Input order is
 * kept otherwise.
 */
export function dedupeMirrors(listings: readonly ListingFacts[]): { listings: ListingFacts[]; mismatches: MirrorStatusMismatch[] } {
  const teamById = new Map<string, ListingFacts>();
  for (const l of listings) if (l.source === 'team' && l.id !== null) teamById.set(l.id, l);
  const keptMirror = new Map<string, string>(); // teamListingId → identity of the mirror kept
  for (const l of listings) {
    if (l.source !== 'mls' || l.teamListingId === null || teamById.has(l.teamListingId)) continue;
    const prev = keptMirror.get(l.teamListingId);
    const id = listingIdentity(l);
    if (prev === undefined || cmp(id, prev) < 0) keptMirror.set(l.teamListingId, id);
  }
  const out: ListingFacts[] = [];
  const mismatches: MirrorStatusMismatch[] = [];
  for (const l of listings) {
    if (l.source === 'mls' && l.teamListingId !== null) {
      const own = teamById.get(l.teamListingId);
      if (own !== undefined) {
        if (own.status !== l.status) {
          mismatches.push({ teamListingId: l.teamListingId, mlsListing: listingIdentity(l), teamStatus: own.status, mlsStatus: l.status });
        }
        continue;
      }
      if (keptMirror.get(l.teamListingId) !== listingIdentity(l)) continue;
    }
    out.push(l);
  }
  return { listings: out, mismatches };
}

function isSubjectOrMirror(subject: ListingFacts, c: ListingFacts): boolean {
  if (listingIdentity(c) === listingIdentity(subject)) return true;
  if (subject.id !== null && c.teamListingId === subject.id) return true;
  if (subject.teamListingId !== null && (c.id === subject.teamListingId || c.teamListingId === subject.teamListingId)) return true;
  return subject.mlsNumber !== null && c.mlsNumber === subject.mlsNumber;
}

const zip5 = (s: string): string => s.trim().slice(0, 5);
const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
const STATUS_RANK = new Map(LISTING_STATUSES.map((s, i) => [s, i]));
const dollars = (cents: number): string => `$${Math.round(cents / 100).toLocaleString('en-US')}`;

function distance(a: number | null, b: number | null): number {
  return a === null || b === null ? Number.POSITIVE_INFINITY : Math.abs(a - b);
}

/**
 * The listings competing with `subject` under `rule`, in a deterministic order, with why each one
 * matched (one `CriterionMatch` per listing and criterion, in listing order).
 */
export function competingSet(subject: ListingFacts, candidates: readonly ListingFacts[], rule: CompetingRule): { listings: ListingFacts[]; why: CriterionMatch[] } {
  const statuses = new Set(rule.statuses);
  const chosen: { l: ListingFacts; why: Omit<CriterionMatch, 'listing'>[] }[] = [];

  for (const c of dedupeMirrors(candidates).listings) {
    if (isSubjectOrMirror(subject, c)) continue;
    if (c.valuation.isLease) continue;
    if (c.source === 'mls' && (rule.mlsFeedStale || (rule.onlyDisplayAllowed && !c.displayAllowed))) continue;
    const why: Omit<CriterionMatch, 'listing'>[] = [];

    const sameCity = sameText(c.city, subject.city) && sameText(c.region, subject.region);
    const sameZip = zip5(c.postalCode) === zip5(subject.postalCode);
    const inArea = rule.area === 'city' ? sameCity : rule.area === 'postal_code' ? sameZip : sameCity || sameZip;
    if (!inArea) continue;
    why.push({ criterion: 'area', detail: sameZip && rule.area !== 'city' ? `Same postal code ${zip5(c.postalCode)}` : `Same city ${c.city.trim()}` });

    if (rule.priceBandPct !== null) {
      const s = subject.listPriceCents;
      const p = c.listPriceCents;
      if (s === null || p === null) continue;
      // integer comparison: |p - s| ≤ s × pct / 100
      if (Math.abs(p - s) * 100 > s * rule.priceBandPct) continue;
      why.push({ criterion: 'price_band', detail: `${dollars(p)} is within ±${rule.priceBandPct} % of ${dollars(s)}` });
    }

    if (rule.bedsDelta !== null) {
      if (subject.beds === null || c.beds === null || Math.abs(c.beds - subject.beds) > rule.bedsDelta) continue;
      why.push({ criterion: 'beds', detail: `${c.beds} beds (subject ${subject.beds}, ±${rule.bedsDelta})` });
    }

    const sqftPct = rule.sqftBandPct ?? null;
    if (sqftPct !== null) {
      const s = subject.sqft;
      const q = c.sqft;
      if (s === null || q === null) continue;
      // integer comparison: |q - s| ≤ s × pct / 100
      if (Math.abs(q - s) * 100 > s * sqftPct) continue;
      why.push({ criterion: 'sqft_band', detail: `${q} sq ft is within ±${sqftPct} % of ${s} sq ft` });
    }

    if (rule.samePropertyType) {
      if (subject.propertyType === null || c.propertyType !== subject.propertyType) continue;
      why.push({ criterion: 'property_type', detail: `Same property type (${c.propertyType})` });
    }

    if (!statuses.has(c.status)) continue;
    why.push({ criterion: 'status', detail: `Status ${c.status}` });

    chosen.push({ l: c, why });
  }

  chosen.sort(
    (a, b) =>
      distance(a.l.listPriceCents, subject.listPriceCents) - distance(b.l.listPriceCents, subject.listPriceCents) ||
      distance(a.l.beds, subject.beds) - distance(b.l.beds, subject.beds) ||
      (STATUS_RANK.get(a.l.status) ?? 0) - (STATUS_RANK.get(b.l.status) ?? 0) ||
      cmp(listingIdentity(a.l), listingIdentity(b.l)),
  );

  const top = chosen.slice(0, Math.max(0, Math.floor(rule.maxCount)));
  return {
    listings: top.map((x) => x.l),
    why: top.flatMap((x) => x.why.map((w) => ({ listing: listingIdentity(x.l), ...w }))),
  };
}
