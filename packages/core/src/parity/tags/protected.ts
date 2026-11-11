// Fair-housing protected-proxy classification of tag names and custom field labels/options
// (R-PAR-8, R-PAR-18; counsel item C-PAR-3).
//
// Two sources, both data:
//   1. core module 20's lexicon pack (`@realty/core/fairhousing`): any hard or soft match of the
//      marketing-copy check ("perfect for families", "seniors", "church"), and its shared attribute
//      vocabulary (`classifyAttributeKey`), protected classes and proxies only;
//   2. the parity proxy list below: short tag-style words a team uses to segment people by a
//      protected class ("VA buyer", "Section 8", "Spanish speaking").
// A match makes a tag `protected_proxy` (never a bulk audience, never applied in bulk, never on a pond
// card, never an assistant input) and refuses a custom field (CUSTOM_FIELD_PROTECTED: the built-in
// self-reported attributes are the only home for such facts).
//
// The strict default over-flags on purpose; the Owner may lift a tag's protection (R-PAR-8). A few
// words that are part of everyday real-estate data are allowed (birthday, home anniversary).
// **VERIFY WITH COUNSEL (C-PAR-3)**: which proxies, per state. Pure.
import { check, classifyAttributeKey, DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack, type ProtectedClass } from '../../fairhousing/index.js';
import { foldWords } from './fold.js';

export interface ProtectedLexicon {
  /** The module 20 pack (its version is the `platform:fair_housing` clearance pack's). */
  pack: FairHousingPack;
  /** Single folded words that mark a protected class or a stand-in for one. */
  words: Readonly<Record<string, ProtectedClass>>;
  /** Folded word sequences ("section 8"). */
  phrases: readonly { words: readonly string[]; class: ProtectedClass }[];
  /** Folded words the attribute vocabulary flags but that are everyday CRM data here. */
  allow: ReadonlySet<string>;
  /** Folded word sequences that describe a property or a place, not people ("family room", "Church St"); their words never count. */
  exempt: readonly (readonly string[])[];
  version: string;
}

export const PARITY_PROXY_LEXICON_VERSION = 'par-proxy/1';

const WORDS: Record<string, ProtectedClass> = {
  // military status (VA loans, PCS moves)
  va: 'military_status', vet: 'military_status', vets: 'military_status', veteran: 'military_status', veterans: 'military_status',
  military: 'military_status', pcs: 'military_status', tricare: 'military_status', servicemember: 'military_status', servicemembers: 'military_status',
  // source of income
  section8: 'source_of_income', hcv: 'source_of_income', voucher: 'source_of_income', vouchers: 'source_of_income', ssi: 'source_of_income',
  ssdi: 'source_of_income', welfare: 'source_of_income', snap: 'source_of_income',
  // disability
  disabled: 'disability', disability: 'disability', handicapped: 'disability', wheelchair: 'disability', blind: 'disability', deaf: 'disability',
  // age
  senior: 'age', seniors: 'age', elderly: 'age', retiree: 'age', retirees: 'age', millennial: 'age', millennials: 'age', boomer: 'age', boomers: 'age',
  // familial status
  pregnant: 'familial_status', expecting: 'familial_status', newborn: 'familial_status', baby: 'familial_status', kids: 'familial_status', children: 'familial_status',
  // religion
  church: 'religion', mosque: 'religion', synagogue: 'religion', temple: 'religion', kosher: 'religion', halal: 'religion', christian: 'religion',
  muslim: 'religion', jewish: 'religion', catholic: 'religion', hindu: 'religion', buddhist: 'religion', mormon: 'religion', lds: 'religion',
  // race, color, national origin
  hispanic: 'national_origin', latino: 'national_origin', latina: 'national_origin', latinx: 'national_origin', asian: 'race', african: 'race',
  caucasian: 'race', arab: 'national_origin', immigrant: 'national_origin', immigrants: 'national_origin', visa: 'national_origin',
  greencard: 'national_origin', citizen: 'national_origin', foreign: 'national_origin', foreigner: 'national_origin', esl: 'national_origin',
  spanish: 'national_origin', chinese: 'national_origin', mexican: 'national_origin', indian: 'national_origin', korean: 'national_origin',
  vietnamese: 'national_origin', russian: 'national_origin', haitian: 'national_origin', filipino: 'national_origin',
  // sexual orientation, gender identity, sex
  lgbt: 'sexual_orientation', lgbtq: 'sexual_orientation', gay: 'sexual_orientation', lesbian: 'sexual_orientation', queer: 'sexual_orientation',
  trans: 'gender_identity', transgender: 'gender_identity', nonbinary: 'gender_identity',
  // marital status
  divorced: 'marital_status', divorce: 'marital_status', divorcing: 'marital_status', widow: 'marital_status', widowed: 'marital_status', widower: 'marital_status',
};

const PHRASES: { words: string[]; class: ProtectedClass }[] = [
  { words: ['section', '8'], class: 'source_of_income' },
  { words: ['gi', 'bill'], class: 'military_status' },
  { words: ['green', 'card'], class: 'national_origin' },
  { words: ['single', 'mom'], class: 'familial_status' },
  { words: ['single', 'dad'], class: 'familial_status' },
  { words: ['single', 'parent'], class: 'familial_status' },
  { words: ['empty', 'nester'], class: 'age' },
  { words: ['empty', 'nesters'], class: 'age' },
  { words: ['first', 'language'], class: 'national_origin' },
  { words: ['55', 'plus'], class: 'age' },
  { words: ['55+'], class: 'age' },
];

// Real-estate dates and words the shared attribute vocabulary flags for ad targeting (R-FH-4) but that
// are ordinary person data in a CRM. They never count on their own (a lexicon word next to them still does).
const ALLOW = new Set(['birthday', 'birthdate', 'birth', 'dob', 'name', 'interest', 'interests', 'custom', 'audience', 'event', 'events', 'life',
  'score', 'likely', 'band', 'city', 'county', 'district', 'block', 'subdivision', 'zip', 'zipcode', 'postal', 'postcode', 'neighborhood',
  'neighbourhood', 'tract', 'census', 'polygon', 'firstname', 'lastname', 'surname', 'photo', 'face', 'relocation', 'behavior', 'behaviors',
  'behaviour', 'lookalike', 'prediction', 'predicted', 'propensity', 'wedding']);

// The same idea as module 20's `not_a_reference` exemptions (property types and street names).
const STREET = ['st', 'street', 'rd', 'road', 'ave', 'avenue', 'dr', 'drive', 'ln', 'lane', 'blvd', 'way', 'ct', 'court', 'hill', 'park'];
const EXEMPT: string[][] = [
  ['single', 'family'], ['multi', 'family'], ['multifamily'], ['family', 'room'], ['family', 'rooms'], ['family', 'home'],
  ...['church', 'temple', 'chapel'].flatMap((w) => STREET.map((s) => [w, s])),
];

export const DEFAULT_PROTECTED_LEXICON: ProtectedLexicon = {
  pack: DEFAULT_FAIR_HOUSING_PACK,
  words: WORDS,
  phrases: PHRASES,
  allow: ALLOW,
  exempt: EXEMPT,
  version: PARITY_PROXY_LEXICON_VERSION,
};

export interface ProtectedMatch {
  class: ProtectedClass | 'protected_proxy';
  /** Which list matched (for the explanation shown to the Admin). */
  via: 'fair_housing_lexicon' | 'attribute_vocabulary' | 'parity_proxy_word' | 'parity_proxy_phrase';
  /** The folded word or phrase that matched. */
  text: string;
}

function phraseAt(words: readonly string[], i: number, phrase: readonly string[]): boolean {
  for (let k = 0; k < phrase.length; k++) if (words[i + k] !== phrase[k]) return false;
  return true;
}

/** The first protected match in a name, or null. */
export function protectedMatch(name: string, lexicon: ProtectedLexicon = DEFAULT_PROTECTED_LEXICON): ProtectedMatch | null {
  if (typeof name !== 'string' || name.trim() === '') return null;
  const fh = check(name, lexicon.pack);
  const hit = fh.hard[0] ?? fh.soft[0];
  if (hit) return { class: hit.class, via: 'fair_housing_lexicon', text: hit.text };
  const all = foldWords(name);
  const covered = new Set<number>();
  for (let i = 0; i < all.length; i++) {
    for (const e of lexicon.exempt) if (phraseAt(all, i, e)) for (let k = 0; k < e.length; k++) covered.add(i + k);
  }
  const words = all.filter((_, i) => !covered.has(i));
  for (let i = 0; i < words.length; i++) {
    for (const p of lexicon.phrases) if (phraseAt(words, i, p.words)) return { class: p.class, via: 'parity_proxy_phrase', text: p.words.join(' ') };
  }
  for (const w of words) {
    const c = lexicon.words[w];
    if (c !== undefined) return { class: c, via: 'parity_proxy_word', text: w };
  }
  for (const w of words.length > 1 ? [...words, words.join('')] : words) {
    if (lexicon.allow.has(w)) continue;
    const cat = classifyAttributeKey(w);
    if (cat === 'protected_class' || cat === 'protected_proxy') return { class: 'protected_proxy', via: 'attribute_vocabulary', text: w };
  }
  return null;
}

/** PARITY_PLAN §4.2: true when the name matches the fair-housing protected-proxy lexicon. */
export function classifyProtected(name: string, lexicon: ProtectedLexicon = DEFAULT_PROTECTED_LEXICON): boolean {
  return protectedMatch(name, lexicon) !== null;
}
