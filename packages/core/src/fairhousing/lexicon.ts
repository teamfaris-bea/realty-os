// The built-in fair-housing lexicon `fh/1` (R-FH-5). Pack DATA, not code: the `platform:fair_housing`
// clearance pack names this version (`rules.lexicon_version = "fh/1"`, 0018_phase2_3_schema.sql) and
// ships unreviewed. Jurisdiction packs may add terms and exemptions (./pack.ts).
//
// **VERIFY WITH COUNSEL (C3, C5).** The entries follow the widely used "describe the property, not
// the people" advertising guidance; they are a starting point for counsel review, not a legal list.
// Classes beyond the seven federal ones (age, marital status, source of income, military status,
// sexual orientation, gender identity) vary by state and city; the strict default flags them
// everywhere. `hard` blocks approval of a marketing piece (R-FH-1); `soft` only flags it ("Check
// this"), and assistant output with either never goes out on its own (R-FH-2).
//
// Grammar (./check.ts compilePattern): words are folded, lower-case tokens; `word*` is a prefix;
// `a|b` alternatives; `*` alone is zero or one token of anything. Hyphens split words, so
// "adults-only" is "adults only" and "able-bodied" is "able bodied".
import type { Exemption, FairHousingPack, Term } from './types.js';

export const FAIR_HOUSING_LEXICON_VERSION = 'fh/1';

/** "perfect for families", "ideal for a young couple": describing the ideal occupant. */
const IDEAL = 'perfect|ideal|ideally|great|best|suited|suitable|made|wonderful|fantastic|excellent|tailored|designed|built|meant';
/** Words that may sit between "for" and the group: "for a young family", "for growing families". */
const WHO = 'a|an|the|young|growing|large|big|small|new|busy|active|any|your|every|all|extended|multigenerational|first|older|working|retired|newly|single|married|happy|lucky';
const FOR_GROUP = `for ${WHO}? ${WHO}?`;

const HARD: Term[] = [
  // ---- familial status ----
  {
    id: 'fh.familial.no_children',
    label: 'excludes children',
    class: 'familial_status',
    patterns: [
      'no child*|kid|kids|kiddos|minors|babies|infants|toddlers|teens|teenagers',
      'child|kid free',
      'childfree|kidfree',
      'not|unsuitable|unfit suitable|appropriate|safe|meant|intended for * child*|kid|kids|minors|babies|toddlers',
      'not|unsuitable|unfit for child*|kid|kids|minors|babies|toddlers',
      'no families',
      `not ${FOR_GROUP} famil*`,
    ],
    note: 'Advertising may not exclude households with children (familial status).',
  },
  {
    id: 'fh.familial.adults_only',
    label: 'adults only',
    class: 'familial_status',
    patterns: ['adults|adult only', 'adults preferred', 'for adults only', 'mature adults|couples|persons|tenants|buyers|residents'],
    note: 'Limits occupancy to adults (familial status). Qualified housing for older persons is a counsel question.',
  },
  {
    id: 'fh.familial.ideal_occupant',
    label: 'describes families or children as the ideal buyer',
    class: 'familial_status',
    patterns: [`${IDEAL} ${FOR_GROUP} family|families|kids|kid|children|child|newlyweds|parents|moms|dads`],
    note: 'Describe the property, not who should live there (E93: "perfect for young families").',
  },
  // ---- marital status ----
  {
    id: 'fh.marital.only',
    label: 'limits by marital status',
    class: 'marital_status',
    patterns: [
      'married|couples|couple|singles|single|unmarried only',
      'married couples|couple only',
      'no couples|singles|unmarried',
      `${IDEAL} ${FOR_GROUP} couple|couples|singles|bachelor|bachelors|bachelorette|newlyweds|single|married`,
    ],
  },
  // ---- sex, sexual orientation, gender identity ----
  {
    id: 'fh.sex.only',
    label: 'limits by sex',
    class: 'sex',
    patterns: [
      'male|males|men|man|female|females|women|woman|ladies|lady|gentlemen|gentleman|girls|boys only',
      'no men|males|women|females|ladies|girls|boys',
      `${IDEAL} ${FOR_GROUP} man|woman|men|women|lady|ladies|gentleman|gentlemen|guy|guys|girl|girls`,
    ],
  },
  {
    id: 'fh.orientation.only',
    label: 'limits by sexual orientation or gender identity',
    class: 'sexual_orientation',
    patterns: ['straight|gay|lesbian|lgbt|lgbtq|transgender|trans only', 'no gays|gay|lesbians|lgbt|lgbtq|transgender|trans'],
  },
  // ---- race, color, national origin ----
  {
    id: 'fh.race.area',
    label: 'describes an area by race, color or ethnicity',
    class: 'race',
    patterns: [
      'white|black|hispanic|latino|latina|latinx|asian|caucasian|ethnic|racial|minority|segregated|colored neighborhood*|neighbourhood*|community|communities|area|areas|enclave',
      'whites|blacks|hispanics|latinos|asians|caucasians only',
      'white|black|hispanic|latino|asian|caucasian buyers|tenants|families|people|residents only',
      'no blacks|whites|hispanics|latinos|asians|minorities',
    ],
  },
  {
    id: 'fh.national_origin.only',
    label: 'limits by national origin or language',
    class: 'national_origin',
    patterns: [
      'english speaking|speakers only',
      'english only',
      'must speak english',
      'americans|american|citizens|natives only',
      'no immigrants|foreigners|refugees|aliens|immigrant',
      'chinese|mexican|indian|arab|arabic|african|irish|italian|polish|korean|japanese|vietnamese|russian|jewish neighborhood*|neighbourhood*|community|enclave',
    ],
  },
  // ---- religion ----
  {
    id: 'fh.religion.only',
    label: 'limits by or describes an area by religion',
    class: 'religion',
    patterns: [
      'christian|christians|jewish|jews|muslim|muslims|catholic|catholics|protestant|hindu|hindus|buddhist|mormon|islamic|sikh|sikhs|atheist only',
      'christian|jewish|muslim|catholic|protestant|hindu|buddhist|mormon|islamic|sikh home|neighborhood*|neighbourhood*|community|area|family|families|buyers|tenants',
      'no christians|jews|muslims|catholics|hindus|sikhs|atheists',
    ],
  },
  // ---- disability ----
  {
    id: 'fh.disability.excludes',
    label: 'excludes people with disabilities',
    class: 'disability',
    patterns: [
      'no wheelchair*|handicap*|disabled|disabilities|disability|crutches|walkers',
      'able bodied',
      'ablebodied',
      'must be able to climb|walk',
      'not suitable|accessible|appropriate for * disabled|handicap*|wheelchair*|elderly',
      'unsuitable for * disabled|handicap*|wheelchair*|elderly',
      'physically fit|healthy only',
      'must be physically fit|healthy',
      'must be in good health',
      'good health required',
      'no mental|mentally ill*|illness|disabled',
    ],
  },
  // ---- source of income (VERIFY WITH COUNSEL: protected in many states and cities, not federally) ----
  {
    id: 'fh.income.excludes',
    label: 'excludes a lawful source of income',
    class: 'source_of_income',
    patterns: [
      'no section 8|eight',
      'no vouchers|voucher|welfare|hud',
      'no housing|government|public|rental assistance|aid|vouchers',
      'section 8|eight not accepted',
    ],
  },
  // ---- military status (VERIFY WITH COUNSEL) ----
  { id: 'fh.military.excludes', label: 'excludes military or veterans', class: 'military_status', patterns: ['no military|veterans|vets|servicemembers'] },
  // ---- age (VERIFY WITH COUNSEL: housing for older persons) ----
  {
    id: 'fh.age.excludes',
    label: 'limits by age',
    class: 'age',
    patterns: [
      'no seniors|elderly|retirees|students|young',
      'young people|professionals|couples|buyers|tenants only',
      'seniors|retirees|students only',
      `${IDEAL} for a|an|the? retirees|seniors|students|young|elderly|millennials|boomers|empty`,
    ],
  },
  // ---- steering: who lives in an area (R-FH-3) ----
  {
    id: 'fh.steering.kind_of_people',
    label: 'describes the kind of people in an area',
    class: 'steering',
    patterns: [
      'kind|type|sort|class of people|neighbors|neighbours|crowd|residents|folks|families',
      'people like you|us|yourself',
      'the right people|crowd',
      'desirable|undesirable neighbors|neighbours|residents|element',
      'your|our own kind',
    ],
    note: 'Describes who lives in an area rather than the property (steering).',
  },
];

const SOFT: Term[] = [
  { id: 'fh.familial.mention', label: 'mentions families or children', class: 'familial_status', patterns: ['family|families|familial', 'child|children|childs|childrens|childhood', 'kid|kids|kiddos', 'toddler*', 'newlywed*'], note: 'Describe the property, not who should live there.' },
  { id: 'fh.familial.family_area', label: 'family-friendly area', class: 'familial_status', patterns: ['family|families friendly', 'family neighborhood*|community|area|street|block'] },
  { id: 'fh.age.mention', label: 'mentions age', class: 'age', patterns: ['senior|seniors', 'retiree*', 'elderly', 'young professional*', 'empty nester*', 'golden years', 'active adult*', '55+|62+', '55|62 plus', '55|62 and older|over'], note: 'Housing for older persons has its own rules (VERIFY WITH COUNSEL).' },
  { id: 'fh.marital.mention', label: 'mentions marital status', class: 'marital_status', patterns: ['bachelor*', 'singles', 'married', 'newlywed*'] },
  { id: 'fh.sex.mention', label: 'gendered wording (say "in-law suite")', class: 'sex', patterns: ['mother in law'] },
  { id: 'fh.religion.mention', label: 'mentions a place of worship', class: 'religion', patterns: ['church*', 'synagogue*', 'mosque*', 'temple*', 'chapel*', 'parish*', 'cathedral*'], note: 'Directions by place of worship can read as a religious preference.' },
  { id: 'fh.disability.mention', label: 'mentions disability', class: 'disability', patterns: ['wheelchair*', 'handicap*', 'disabled', 'blind', 'deaf'], note: 'Describe accessibility features of the property instead.' },
  { id: 'fh.national_origin.mention', label: 'mentions national origin or language', class: 'national_origin', patterns: ['immigrant*', 'foreigner*', 'citizen*', 'english speaking', 'ethnic*', 'nationality'] },
  { id: 'fh.race.mention', label: 'mentions race', class: 'race', patterns: ['racial*', 'race', 'diverse', 'diversity', 'minorit*', 'integrated'] },
  {
    id: 'fh.steering.area_quality',
    label: 'describes an area’s safety or exclusivity',
    class: 'steering',
    patterns: ['safe neighborhood*|neighbourhood*|area|community|street|streets|block', 'safest', 'crime*', 'exclusive neighborhood*|neighbourhood*|community|area|enclave', 'restricted neighborhood*|neighbourhood*|community|area', 'prestigious neighborhood*|community|area', 'good|nice|quiet neighbors|neighbours', 'up and coming', 'gentrif*'],
    note: 'Safety and "exclusive" wording steer buyers; point to objective sources instead.',
  },
];

const EXEMPTIONS: Exemption[] = [
  {
    id: 'fh.ex.property_type',
    effect: 'not_a_reference',
    patterns: [
      'family room|rooms|den',
      'single|multi|two|three|four family',
      'singlefamily|multifamily',
      'family owned|run|business|dining|size|sized|style|farm',
      'familyroom',
      'single story|level|car|garage|wide',
    ],
    note: 'Property types and room names, not people (E93: "family room").',
  },
  {
    id: 'fh.ex.street_names',
    effect: 'not_a_reference',
    patterns: ['church|temple|chapel|parish|cathedral|bachelor st|street|rd|road|ave|avenue|ln|lane|dr|drive|hill|hills|way|blvd|ct|court|pl|place|square'],
    note: 'Street and place names.',
  },
  {
    id: 'fh.ex.equal_opportunity',
    effect: 'anti_discrimination',
    patterns: [
      'regardless of',
      'without regard to|for',
      'irrespective of',
      'do|does|will not discriminate',
      'dont|doesnt|wont discriminate',
      'never discriminate',
      'no discrimination',
      'equal housing|opportunity',
      'fair housing',
      'welcome all',
      'open to all|everyone|anyone',
      'all are|is welcome',
      'everyone is? welcome',
    ],
    note: 'An equal-opportunity statement right before a term downgrades it to "check this".',
  },
];

function deepFreeze<T>(o: T): T {
  if (o !== null && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

/** The built-in pack, deeply frozen. Ships unreviewed (R-INT-6); `reviewedByCounselAt` comes from `platform:fair_housing`. */
export const DEFAULT_FAIR_HOUSING_PACK: FairHousingPack = deepFreeze({
  hard: HARD,
  soft: SOFT,
  exemptions: EXEMPTIONS,
  lexiconVersion: FAIR_HOUSING_LEXICON_VERSION,
  reviewedByCounselAt: null,
});
