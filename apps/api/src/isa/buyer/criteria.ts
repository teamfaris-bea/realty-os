// Buyer search criteria from the assignment's USABLE qualification claims only (ISA-2b item 10; R-ISA-17, R-ISA-27;
// docs/AI_ISA.md §6.2). Pure. The latest claim per field wins; the model never supplies criteria or keywords, and a
// location (postal codes or cities) is required. A core criteria builder is an ISA-1 follow-up; this is the API's.
import { type CriterionKey, parseCriterion, type SearchCriteria } from '@realty/core/assistant';
import type { UsableQualClaim } from '../coreSeam.js';

export interface CriteriaFromClaims {
  criteria: SearchCriteria;
  /** criterion key → the claim it came from (the saved-search proposal's evidence) */
  evidence: { key: CriterionKey; modelKey: string; value: unknown; claim: UsableQualClaim }[];
}

const ZIP = /^\d{5}$/;
const FIELDS = ['areas', 'budget', 'beds_min', 'baths_min', 'property_type'] as const;

function latestPerField(claims: readonly UsableQualClaim[]): Map<string, UsableQualClaim> {
  const out = new Map<string, UsableQualClaim>();
  for (const c of claims) {
    if (!(FIELDS as readonly string[]).includes(c.field)) continue;
    const prev = out.get(c.field);
    if (!prev || c.saidAt > prev.saidAt || (c.saidAt === prev.saidAt && c.claimId > prev.claimId)) out.set(c.field, c);
  }
  return out;
}

/** The criteria, or null (CRITERIA_INCOMPLETE) when no usable location claim exists. */
export function criteriaFromClaims(claims: readonly UsableQualClaim[]): CriteriaFromClaims | null {
  const latest = latestPerField(claims);
  const criteria: Record<string, unknown> = {};
  const evidence: CriteriaFromClaims['evidence'] = [];
  const put = (modelKey: string, value: unknown, claim: UsableQualClaim): void => {
    const p = parseCriterion(modelKey, value);
    if (!p.ok) return;
    const prev = criteria[p.key];
    criteria[p.key] = Array.isArray(prev) && Array.isArray(p.value) ? [...prev, ...p.value] : p.value;
    evidence.push({ key: p.key, modelKey, value, claim });
  };
  const areas = latest.get('areas');
  if (areas) {
    const list = (Array.isArray(areas.value) ? areas.value : [areas.value]).map((x) => String(x).trim()).filter((x) => x !== '').slice(0, 20);
    const zips = list.filter((x) => ZIP.test(x));
    const cities = list.filter((x) => !ZIP.test(x) && /^[A-Za-z][A-Za-z .'-]{0,79}$/.test(x));
    if (zips.length > 0) put('postal_codes', zips, areas);
    if (cities.length > 0) put('cities', cities.map((city) => ({ city })), areas);
  }
  if (criteria.postalCodes === undefined && criteria.cities === undefined) return null;
  const budget = latest.get('budget');
  if (budget) put('price_max', budget.value, budget);
  const beds = latest.get('beds_min');
  if (beds) put('beds_min', beds.value, beds);
  const baths = latest.get('baths_min');
  if (baths) put('baths_min', baths.value, baths);
  const type = latest.get('property_type');
  if (type) put('property_type', type.value, type);
  return { criteria: criteria as SearchCriteria, evidence };
}
