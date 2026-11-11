// The targeting validator (R-FH-4). Audience and targeting rules cannot reference protected
// classes, protected-proxy attributes, prediction output or (for ads) ZIP/neighborhood geography.
//
// Two layers:
//   1. the TYPE: `TargetingSpec` can express exactly one thing, a radius around the listing; every
//      protected or proxy field is typed `never`, so code cannot even build one (compile-time test);
//   2. the RUNTIME validator for data that arrives untyped (an admin form, a stored rule, a provider
//      echo): only the two known keys are accepted, everything else is refused with a reason.
// `classifyAttributeKey` is the shared vocabulary of forbidden attribute names; core/predict and
// core/ads use it for their own runtime checks.
// **VERIFY WITH COUNSEL** per jurisdiction, and VERIFY the platform's housing-category radius limits.

/** The only targeting a housing ad can carry (PHASE2_3_PLAN §5.4 #20). */
export type TargetingSpec = {
  geo: 'radius_of_listing';
  radiusMiles: number;
  ageMin?: never;
  ageMax?: never;
  age?: never;
  gender?: never;
  sex?: never;
  race?: never;
  ethnicity?: never;
  religion?: never;
  familialStatus?: never;
  maritalStatus?: never;
  disability?: never;
  nationalOrigin?: never;
  language?: never;
  income?: never;
  zip?: never;
  zips?: never;
  postalCode?: never;
  neighborhood?: never;
  interests?: never;
  lifeEvents?: never;
  lookalike?: never;
  customAudience?: never;
  predictionBand?: never;
};

export interface TargetingLimits {
  /** VERIFY: the platform housing special-ad-category minimum radius. */
  minRadiusMiles: number;
  maxRadiusMiles: number;
}
export const DEFAULT_TARGETING_LIMITS: TargetingLimits = { minRadiusMiles: 15, maxRadiusMiles: 50 };

export type AttributeCategory = 'protected_class' | 'protected_proxy' | 'geography' | 'prediction_output' | 'life_event' | 'identity';

const EXACT: Readonly<Record<string, AttributeCategory>> = {
  age: 'protected_class', sex: 'protected_class', gender: 'protected_class', race: 'protected_class', color: 'protected_class', colour: 'protected_class',
  religion: 'protected_class', creed: 'protected_class', faith: 'protected_class', disability: 'protected_class', handicap: 'protected_class',
  familial: 'protected_class', family: 'protected_class', children: 'protected_class', kids: 'protected_class', child: 'protected_class', pregnant: 'protected_class', pregnancy: 'protected_class',
  national: 'protected_class', nationality: 'protected_class', ancestry: 'protected_class', ethnicity: 'protected_class', ethnic: 'protected_class',
  citizenship: 'protected_class', immigration: 'protected_class', marital: 'protected_class', married: 'protected_class', spouse: 'protected_class',
  orientation: 'protected_class', lgbt: 'protected_class', lgbtq: 'protected_class', transgender: 'protected_class', military: 'protected_class', veteran: 'protected_class',
  genetic: 'protected_class', birth: 'protected_class', dob: 'protected_class', birthday: 'protected_class', birthdate: 'protected_class', generation: 'protected_class',
  language: 'protected_proxy', income: 'protected_proxy', voucher: 'protected_proxy', section8: 'protected_proxy', education: 'protected_proxy', school: 'protected_proxy',
  household: 'protected_proxy', occupants: 'protected_proxy', health: 'protected_proxy', medical: 'protected_proxy', interests: 'protected_proxy', interest: 'protected_proxy',
  behaviors: 'protected_proxy', behaviour: 'protected_proxy', behavior: 'protected_proxy', lookalike: 'protected_proxy', audience: 'protected_proxy', custom: 'protected_proxy',
  zip: 'geography', zips: 'geography', zipcode: 'geography', postal: 'geography', postcode: 'geography', neighborhood: 'geography', neighbourhood: 'geography',
  tract: 'geography', census: 'geography', county: 'geography', city: 'geography', district: 'geography', block: 'geography', subdivision: 'geography', polygon: 'geography', redline: 'geography',
  prediction: 'prediction_output', predicted: 'prediction_output', likely: 'prediction_output', band: 'prediction_output', score: 'prediction_output', propensity: 'prediction_output',
  life: 'life_event', event: 'life_event', events: 'life_event', divorce: 'life_event', death: 'life_event', newborn: 'life_event', baby: 'life_event', wedding: 'life_event', pcs: 'life_event', relocation: 'life_event',
  name: 'identity', surname: 'identity', firstname: 'identity', lastname: 'identity', photo: 'identity', face: 'identity',
};
const PREFIXES: readonly [string, AttributeCategory][] = [
  ['ethnic', 'protected_class'], ['religio', 'protected_class'], ['famil', 'protected_class'], ['disab', 'protected_class'], ['handicap', 'protected_class'],
  ['nation', 'protected_class'], ['immigra', 'protected_class'], ['pregnan', 'protected_class'], ['militar', 'protected_class'], ['veteran', 'protected_class'], ['ancest', 'protected_class'],
  ['gender', 'protected_class'], ['racial', 'protected_class'], ['marri', 'protected_class'], ['neighbo', 'geography'], ['predict', 'prediction_output'], ['propens', 'prediction_output'], ['lifeevent', 'life_event'],
];

/** Split a key into lower-case words: "ageMin" → age, min; "zip_codes" → zip, codes. */
export function attributeKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== '');
}

/** The forbidden category an attribute name belongs to, or null (shared with core/predict and core/ads). */
export function classifyAttributeKey(key: string): AttributeCategory | null {
  const words = attributeKeyWords(key);
  const joined = words.join('');
  for (const w of [...words, joined]) {
    const exact = EXACT[w];
    if (exact !== undefined) return exact;
  }
  for (const w of [...words, joined]) for (const [p, c] of PREFIXES) if (w.startsWith(p)) return c;
  return null;
}

const ALLOWED_KEYS = new Set(['geo', 'radiusMiles']);

export function validateTargeting(spec: unknown, limits: TargetingLimits = DEFAULT_TARGETING_LIMITS): { ok: true; spec: TargetingSpec } | { ok: false; issues: string[] } {
  const issues: string[] = [];
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, issues: ['targeting must be an object'] };
  const o = spec as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (ALLOWED_KEYS.has(k)) continue;
    const cat = classifyAttributeKey(k);
    issues.push(cat === null ? `${k}: not an allowed targeting field (only a radius around the listing)` : `${k}: ${CATEGORY_WORDS[cat]} cannot be used for targeting`);
  }
  if (o.geo !== 'radius_of_listing') issues.push('geo: only "radius_of_listing" is allowed');
  const r = o.radiusMiles;
  if (typeof r !== 'number' || !Number.isFinite(r)) issues.push('radiusMiles: a number of miles is required');
  else if (r < limits.minRadiusMiles || r > limits.maxRadiusMiles) issues.push(`radiusMiles: must be between ${limits.minRadiusMiles} and ${limits.maxRadiusMiles}`);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, spec: { geo: 'radius_of_listing', radiusMiles: r as number } };
}

const CATEGORY_WORDS: Readonly<Record<AttributeCategory, string>> = {
  protected_class: 'a protected class',
  protected_proxy: 'a stand-in for a protected class',
  geography: 'ZIP or neighborhood geography',
  prediction_output: 'prediction output',
  life_event: 'a life event',
  identity: 'personal identity',
};
