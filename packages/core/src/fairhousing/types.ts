// Shared vocabulary of core/fairhousing (PHASE2_3_PLAN module 20; DATA_MODEL R-FH-1..5).
//
// One lexicon pack, four uses: the marketing copy check (R-FH-1, module 27/29), the assistant and
// voice guard (R-FH-2/3, modules 25/47), and the targeting validator (R-FH-4, module 51). The
// pack's counsel-review state is the `platform:fair_housing` clearance pack (R-INT-6); it ships
// unreviewed. Everything legal in here is product policy data, not legal advice:
// **VERIFY WITH COUNSEL** (C3, C5) per jurisdiction.

/**
 * Classes the lexicon refers to. The first seven are the federal Fair Housing Act classes; the rest
 * are protected in many states and cities (VERIFY WITH COUNSEL per jurisdiction, C3). `steering`
 * is not a class: it covers wording that describes who lives in an area or its "kind of people".
 */
export type ProtectedClass =
  | 'race'
  | 'color'
  | 'religion'
  | 'sex'
  | 'disability'
  | 'familial_status'
  | 'national_origin'
  | 'age'
  | 'marital_status'
  | 'sexual_orientation'
  | 'gender_identity'
  | 'source_of_income'
  | 'military_status'
  | 'steering';

export const PROTECTED_CLASSES: readonly ProtectedClass[] = [
  'race',
  'color',
  'religion',
  'sex',
  'disability',
  'familial_status',
  'national_origin',
  'age',
  'marital_status',
  'sexual_orientation',
  'gender_identity',
  'source_of_income',
  'military_status',
  'steering',
];

/**
 * One lexicon entry. `patterns` use a small phrase grammar over normalized word tokens (see
 * `compilePattern` in ./check.ts):
 *   word       the exact token ("kids")
 *   word*      a token starting with "word" ("famil*" matches family, families, familial)
 *   a|b|c*     any of the alternatives
 *   a|b?       an optional word ("for a|the? famil*" matches "for families" and "for a family")
 *   *          zero or one token of anything ("not suitable for * kids")
 */
export interface Term {
  id: string;
  label: string;
  class: ProtectedClass;
  patterns: readonly string[];
  /** Why this wording is listed (shown to the person editing the copy). */
  note?: string;
}

/**
 * A phrase that changes what a match means.
 * - `not_a_reference`: the words do not refer to a protected class at all ("family room",
 *   "single-family", "Church Street"). A match whose last token falls inside it is dropped.
 * - `anti_discrimination`: an equal-opportunity frame ("regardless of", "we do not discriminate
 *   against"). A match starting within 3 tokens after it, in the same sentence, is `negated`: a
 *   hard match becomes soft (a person still sees it), a soft one stays soft. A bare negation is
 *   NOT a frame: "no children" and "not for families" are themselves hard terms.
 */
export interface Exemption {
  id: string;
  effect: 'not_a_reference' | 'anti_discrimination';
  patterns: readonly string[];
  note?: string;
}

/** The fair-housing pack (PHASE2_3_PLAN §5.4 #20). Its review state is `platform:fair_housing`. */
export interface FairHousingPack {
  hard: Term[];
  soft: Term[];
  exemptions: Exemption[];
  lexiconVersion: string;
  /** Mirrors the `platform:fair_housing` pack's reviewed_by_counsel_at; null = unreviewed (ships so). */
  reviewedByCounselAt: string | null;
}

/** One lexicon hit, located in the ORIGINAL text (UTF-16 offsets, end exclusive). */
export interface Match {
  termId: string;
  label: string;
  class: ProtectedClass;
  severity: 'hard' | 'soft';
  start: number;
  end: number;
  /** The original words matched (verbatim slice of the input). */
  text: string;
  /** Inside an equal-opportunity frame: a hard term was downgraded to soft. */
  negated: boolean;
}

export interface CheckResult {
  hard: Match[];
  soft: Match[];
}
