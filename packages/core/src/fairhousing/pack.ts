// Loading the fair-housing pack from pack data (R-FH-5, R-INT-6).
//
// The `platform:fair_housing` clearance pack (jurisdiction_packs, 0018) names the lexicon version
// in `rules.lexicon_version` and carries counsel's review instant. A jurisdiction pack may ADD hard
// terms, soft terms and exemptions, and may escalate a built-in soft term to hard; it can never
// remove a built-in term (stricter only). An exemption added by a pack is the one way to narrow
// matching (for example qualified housing for older persons) and is itself pack data counsel
// reviews. An unknown lexicon version or malformed data is a refusal, never a silent fallback.
import { z } from 'zod';
import { compilePattern } from './check.js';
import { DEFAULT_FAIR_HOUSING_PACK, FAIR_HOUSING_LEXICON_VERSION } from './lexicon.js';
import { type Exemption, type FairHousingPack, PROTECTED_CLASSES, type Term } from './types.js';

const PatternSchema = z.string().min(1).max(400).refine((p) => {
  try {
    compilePattern(p);
    return true;
  } catch {
    return false;
  }
}, 'not a valid fair-housing pattern');

const TermSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_.-]{3,80}$/),
  label: z.string().min(1).max(120),
  class: z.enum(PROTECTED_CLASSES as unknown as [string, ...string[]]),
  patterns: z.array(PatternSchema).min(1).max(50),
  note: z.string().max(300).optional(),
});

const ExemptionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9_.-]{3,80}$/),
  effect: z.enum(['not_a_reference', 'anti_discrimination']),
  patterns: z.array(PatternSchema).min(1).max(50),
  note: z.string().max(300).optional(),
});

export const FairHousingRulesSchema = z.object({
  lexicon_version: z.string().min(1),
  hard: z.array(TermSchema).max(500).optional(),
  soft: z.array(TermSchema).max(500).optional(),
  exemptions: z.array(ExemptionSchema).max(200).optional(),
  escalate_to_hard: z.array(z.string()).max(200).optional(),
});

export type FairHousingPackError =
  | { ok: false; code: 'FAIR_HOUSING_LEXICON_UNKNOWN'; detail: string }
  | { ok: false; code: 'FAIR_HOUSING_PACK_INVALID'; detail: string };

/**
 * Build the pack from the `platform:fair_housing` pack row (its `rules` jsonb and
 * `reviewed_by_counsel_at`), optionally extended by jurisdiction additions with the same shape.
 */
export function fairHousingPackFrom(
  platform: { rules: unknown; reviewedByCounselAt: string | null },
  jurisdictionAdditions: readonly unknown[] = [],
): { ok: true; pack: FairHousingPack } | FairHousingPackError {
  const base = FairHousingRulesSchema.safeParse(platform.rules);
  if (!base.success) return { ok: false, code: 'FAIR_HOUSING_PACK_INVALID', detail: base.error.issues.map((i) => i.path.join('.') || i.code).join(', ') };
  if (base.data.lexicon_version !== FAIR_HOUSING_LEXICON_VERSION) {
    return { ok: false, code: 'FAIR_HOUSING_LEXICON_UNKNOWN', detail: base.data.lexicon_version };
  }
  const hard: Term[] = [...DEFAULT_FAIR_HOUSING_PACK.hard];
  let soft: Term[] = [...DEFAULT_FAIR_HOUSING_PACK.soft];
  const exemptions: Exemption[] = [...DEFAULT_FAIR_HOUSING_PACK.exemptions];
  const layers = [base.data];
  for (const add of jurisdictionAdditions) {
    const parsed = FairHousingRulesSchema.partial({ lexicon_version: true }).safeParse(add);
    if (!parsed.success) return { ok: false, code: 'FAIR_HOUSING_PACK_INVALID', detail: parsed.error.issues.map((i) => i.path.join('.') || i.code).join(', ') };
    layers.push({ ...parsed.data, lexicon_version: FAIR_HOUSING_LEXICON_VERSION });
  }
  const ids = new Set([...hard, ...soft, ...exemptions].map((t) => t.id));
  for (const layer of layers) {
    for (const t of [...(layer.hard ?? []), ...(layer.soft ?? []), ...(layer.exemptions ?? [])]) {
      if (ids.has(t.id)) return { ok: false, code: 'FAIR_HOUSING_PACK_INVALID', detail: `duplicate id ${t.id}` };
      ids.add(t.id);
    }
    hard.push(...((layer.hard ?? []) as Term[]));
    soft.push(...((layer.soft ?? []) as Term[]));
    exemptions.push(...((layer.exemptions ?? []) as Exemption[]));
    for (const id of layer.escalate_to_hard ?? []) {
      const t = soft.find((s) => s.id === id);
      if (t === undefined) return { ok: false, code: 'FAIR_HOUSING_PACK_INVALID', detail: `escalate_to_hard: unknown soft term ${id}` };
      soft = soft.filter((s) => s.id !== id);
      hard.push(t);
    }
  }
  return { ok: true, pack: { hard, soft, exemptions, lexiconVersion: FAIR_HOUSING_LEXICON_VERSION, reviewedByCounselAt: platform.reviewedByCounselAt } };
}

/** What the UI says about the pack (R-FH-5: it states when the lexicon has not been reviewed). */
export function fairHousingReviewState(pack: Pick<FairHousingPack, 'lexiconVersion' | 'reviewedByCounselAt'>): { reviewed: boolean; text: string } {
  if (pack.reviewedByCounselAt === null) {
    return {
      reviewed: false,
      text: `The fair-housing wording list (${pack.lexiconVersion}) has not been reviewed by counsel yet. Pieces are checked against it, and publishing stays off until it is reviewed.`,
    };
  }
  return { reviewed: true, text: `The fair-housing wording list (${pack.lexiconVersion}) was reviewed by counsel on ${pack.reviewedByCounselAt.slice(0, 10)}.` };
}
