// Turning the model's per-item claims into a call review (R-COACH-2, R-COACH-6, E105).
//
// R-COACH-2: an item is met or missed ONLY when at least one of its evidence refs verifies against
// the call's transcript (`verifyQuote` from core/assistant: verbatim modulo whitespace/case/quotes,
// within the cited offsets). Otherwise it is needs_review and leaves the denominator (E105).
//
// Per rubric item (in rubric order; items in `disabledKeys` are omitted):
//   - claims whose key is not in the rubric are ignored;
//   - a met/missed claim with no verifying ref is dropped (it cannot decide anything);
//   - a not_applicable claim is usable as-is (it only ever leaves the denominator);
//   - no usable claim (none at all, or only unverified ones)  ⇒ needs_review;
//   - usable claims that disagree (met vs missed, or either vs not_applicable) ⇒ needs_review;
//   - usable claims that agree ⇒ that status; the FIRST usable claim (input order) supplies
//     `claimId` and `quotes` (its verified refs only).
// A needs_review item carries the first claim's id for the key (so a reviewer can see what the model
// said), or null when there was no claim, and never any quotes.
//
// R-COACH-6: the result has counts only (metCount of scoredCount), never a percentage or grade.
import { verifyQuote, type EvidenceRef } from '../assistant/index.js';
import { assertRubric } from './rubric.js';
import type { CallScore, CallTranscript, ItemStatus, Rubric, RubricClaim, ScoreOptions, ScoredItem } from './types.js';

/** The refs of `claim` that verify against `transcript`, in order. */
export function verifiedRefs(claim: Pick<RubricClaim, 'evidence'>, transcript: CallTranscript): EvidenceRef[] {
  return claim.evidence.filter((ref) => verifyQuote(transcript, ref).verified);
}

function resolveItem(key: string, claims: readonly RubricClaim[], transcript: CallTranscript): ScoredItem {
  if (claims.length === 0) return { key, status: 'needs_review', claimId: null, quotes: [] };
  const usable: { claim: RubricClaim; quotes: EvidenceRef[] }[] = [];
  for (const claim of claims) {
    const quotes = verifiedRefs(claim, transcript);
    if (claim.status === 'not_applicable' || quotes.length > 0) usable.push({ claim, quotes });
  }
  const first = usable[0];
  const firstClaimId = (claims[0] as RubricClaim).claimId;
  if (first === undefined) return { key, status: 'needs_review', claimId: firstClaimId, quotes: [] };
  if (usable.some((u) => u.claim.status !== first.claim.status)) {
    return { key, status: 'needs_review', claimId: firstClaimId, quotes: [] };
  }
  const status: ItemStatus = first.claim.status;
  return { key, status, claimId: first.claim.claimId, quotes: first.quotes };
}

/** Counts met and scored (met + missed) items; needs_review and not_applicable leave the denominator. */
export function countItems(items: readonly Pick<ScoredItem, 'status'>[]): { metCount: number; scoredCount: number } {
  let metCount = 0;
  let scoredCount = 0;
  for (const it of items) {
    if (it.status === 'met') metCount += 1;
    if (it.status === 'met' || it.status === 'missed') scoredCount += 1;
  }
  return { metCount, scoredCount };
}

export function scoreFromClaims(claims: readonly RubricClaim[], rubric: Rubric, transcript: CallTranscript, opts: ScoreOptions = {}): CallScore {
  assertRubric(rubric);
  const disabled = new Set(opts.disabledKeys ?? []);
  const byKey = new Map<string, RubricClaim[]>();
  for (const c of claims) {
    const list = byKey.get(c.itemKey);
    if (list) list.push(c);
    else byKey.set(c.itemKey, [c]);
  }
  const items = rubric.items.filter((it) => !disabled.has(it.key)).map((it) => resolveItem(it.key, byKey.get(it.key) ?? [], transcript));
  return { rubricVersion: rubric.version, items, ...countItems(items) };
}

/**
 * The only way a review is summarised for people (R-COACH-2, R-COACH-6): "6 of 8 checks".
 * Never a bare number or percentage.
 */
export function scoreSummaryText(score: Pick<CallScore, 'metCount' | 'scoredCount'>): string {
  if (score.scoredCount === 0) return 'No checks scored yet';
  return `${score.metCount} of ${score.scoredCount} ${score.scoredCount === 1 ? 'check' : 'checks'}`;
}

/** `call_scores.items` jsonb: [{key, status, claim_id}] in rubric order. */
export function callScoreItemsJson(score: CallScore): { key: string; status: ItemStatus; claim_id: string | null }[] {
  return score.items.map((it) => ({ key: it.key, status: it.status, claim_id: it.claimId }));
}
