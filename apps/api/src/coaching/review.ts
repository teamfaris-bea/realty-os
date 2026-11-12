// The call review job (module 36; R-COACH-1, R-COACH-2, R-COACH-3, R-COACH-6, R-INT-6, E104, E105).
//
//   TX-A (system)  call facts + the Owner's switch + the platform:coaching pack → core.reviewEligible
//                  (pack cleared, scoring on, a person handled it, not imported, a provider recording on a
//                  lawful basis, a ready transcript); AI off ⇒ nothing (R-AST-18). Then the ONE call's
//                  transcript is decrypted for the prompt.
//   AiProvider.complete                                     (never inside a transaction; the fake in tests)
//   TX-B (system)  ai_runs row (output encrypted) → the same checks again (the switch or the pack may have
//                  changed while the model ran) → parseCallReview → core.scoreFromClaims (a quote decides an
//                  item only when it verifies against the transcript, E105) → one call_review action
//                  (internal, executed: never a card or an approval) with one claim per rubric claim and its
//                  quotes (encrypted) → the call_scores row. The DB refuses a review of an AI-handled call,
//                  of another agent, or without a lawful recording (call_scores_guard, 0052).
// Idempotent per call: the call_scores primary key and the action's dedupe key; the scan skips calls with a
// review run. Nothing here feeds routing, ownership or the scoreboard (R-COACH-5).
import { type Claim, type CheckedEvidenceRef, verifyQuote } from '@realty/core/assistant';
import { RUBRIC_V1, type CallTranscript, type ConsentBasis, type IneligibleReason, type RecordingSource, type RubricClaim, callScoreItemsJson, reviewEligible, scoreFromClaims } from '@realty/core/coaching';
import { type AssistantClaimId, type SystemActor, type TenantId, isRole } from '@realty/core/foundation';
import { withTenantTx, type Tx } from '@realty/db';
import { insertAction } from '../assistant/repos/actions.js';
import { callTranscripts } from '../assistant/repos/context.js';
import type { AssistantDeps } from '../assistant/types.js';
import { ProviderError } from '../providers/types.js';
import { buildCallReviewPrompt, parseCallReview } from './prompt.js';
import * as R from './repos/coaching.js';

export const CALL_REVIEW_DEDUPE = (callId: string) => `call_review:${callId}`;
export const reviewAad = (rowId: string) => ({ table: 'ai_runs', column: 'output_enc', rowId });

export type CallReviewResult =
  | { kind: 'reviewed'; callId: string; metCount: number; scoredCount: number; needsReview: number }
  | { kind: 'skipped'; reason: IneligibleReason | 'CALL_MISSING' | 'NO_AGENT' | 'ALREADY_REVIEWED' | 'AI_DISABLED' | 'MODEL_FAILED' | 'OUTPUT_NOT_CONTRACT' | 'OUTPUT_TOO_LARGE' };

type Gate = { ok: true; facts: R.CallReviewFactsRow & { agentUserId: string }; settings: R.CoachingSettingsRow } | { ok: false; reason: Exclude<CallReviewResult, { kind: 'reviewed' }>['reason'] };

/** Every check the job makes, in one place; run in TX-A and again in TX-B. */
async function gate(tx: Tx, callId: string, lock = false): Promise<Gate> {
  const facts = await R.callReviewFacts(tx, callId);
  if (!facts) return { ok: false, reason: 'CALL_MISSING' };
  const settings = await R.coachingSettings(tx, { lock });
  if (!settings) return { ok: false, reason: 'CALL_MISSING' };
  const rec = facts.recording;
  const e = reviewEligible({
    handledBy: facts.handledBy === 'human' ? 'human' : facts.handledBy === 'voicemail' ? 'voicemail' : 'assistant',
    // an agent with no membership row, or an unknown role, is never reviewed (counted as a TC)
    agentRole: facts.agentUserId === null ? null : facts.agentRole !== null && isRole(facts.agentRole) ? facts.agentRole : 'tc',
    imported: facts.imported,
    recording: rec === null || rec.shredded ? null : { source: rec.source as RecordingSource, consentBasis: rec.consentBasis as ConsentBasis },
    hasTranscript: facts.hasTranscript,
    callScoringEnabled: settings.scoringEnabled,
    coachingPackCleared: settings.packCleared,
  });
  if (!e.eligible) return { ok: false, reason: e.reason };
  if (!settings.aiEnabled) return { ok: false, reason: 'AI_DISABLED' };
  if (facts.agentUserId === null) return { ok: false, reason: 'NO_AGENT' };
  if (facts.reviewed) return { ok: false, reason: 'ALREADY_REVIEWED' };
  return { ok: true, facts: { ...facts, agentUserId: facts.agentUserId }, settings };
}

function coreTranscript(t: { callId: string; startedAt: number; segments: readonly { startMs: number; endMs: number; speaker?: string; text: string }[] }): CallTranscript {
  return { kind: 'transcript', sourceType: 'call', sourceId: t.callId, startedAt: t.startedAt as never, segments: t.segments.map((s) => ({ ...s })) };
}

const STATUS_WORD = { met: 'done', missed: 'not done', not_applicable: 'did not apply' } as const;

/** One stored claim per rubric claim: "<item label>: done/not done/did not apply", its quotes checked. */
function storedClaims(claims: readonly RubricClaim[], transcript: CallTranscript, labelOf: (k: string) => string): Claim[] {
  return claims.map((c, i) => {
    const evidence: CheckedEvidenceRef[] = c.evidence.map((ref) => {
      const v = verifyQuote(transcript, ref);
      return v.verified ? { ...ref, verified: true } : { ...ref, verified: false, reason: v.reason };
    });
    // R-AST-1 (deferred DB trigger): a claim not flagged needs_review carries a verified quote. A quote-less
    // "did not apply" is flagged here; the review item itself is decided by core (not_applicable).
    const decided = evidence.some((e) => e.verified);
    return {
      id: c.claimId,
      ordinal: i,
      kind: 'fact',
      text: `${labelOf(c.itemKey)}: ${STATUS_WORD[c.status]}`.slice(0, 300),
      evidence,
      needsReview: !decided,
      reviewReasons: decided ? [] : [evidence.length === 0 ? 'NO_EVIDENCE' : 'QUOTE_NOT_VERIFIED'],
    };
  });
}

/** Reviews one call (the `coaching.call_review` job). */
export async function reviewCall(actor: SystemActor, callId: string, deps: AssistantDeps): Promise<CallReviewResult> {
  const tenantId = actor.tenantId as TenantId;
  const rubric = RUBRIC_V1;
  const pre = await withTenantTx(
    actor,
    async (tx) => {
      const g = await gate(tx, callId);
      if (!g.ok) return g;
      const t = (await callTranscripts(tx, deps.envelope, tenantId, g.facts.contactId, [callId]))[0];
      if (!t) return { ok: false as const, reason: 'no_transcript' as const };
      return { ...g, transcript: coreTranscript(t) };
    },
    { db: deps.db, retries: 2 },
  );
  if (!pre.ok) return { kind: 'skipped', reason: pre.reason };

  const prompt = buildCallReviewPrompt(rubric, pre.transcript, pre.settings.disabledKeys);
  const started = Date.now();
  let text = '';
  let status: 'succeeded' | 'failed' | 'refused' = 'succeeded';
  let model = 'unknown';
  let tokens = { input: 0, output: 0 };
  let signals: Record<string, unknown> = {};
  try {
    const res = await deps.providers.ai.complete({ templateKey: prompt.templateKey, system: prompt.system, user: prompt.user, maxOutputTokens: prompt.maxOutputTokens });
    model = res.model;
    tokens = { input: Math.max(0, Math.trunc(res.inputTokens) || 0), output: Math.max(0, Math.trunc(res.outputTokens) || 0) };
    signals = { stopReason: res.stopReason };
    text = typeof res.text === 'string' ? res.text : '';
    if (res.stopReason === 'refusal') status = 'refused';
  } catch (e) {
    status = 'failed';
    signals = { error: e instanceof ProviderError ? `${e.kind}:${e.providerCode ?? ''}` : 'UNEXPECTED' };
  }
  const latency = Math.max(0, Date.now() - started);

  return withTenantTx(
    actor,
    async (tx): Promise<CallReviewResult> => {
      const aiRunId = deps.ids.next<'AiRunId'>();
      const parsed = status === 'succeeded' ? parseCallReview(text, { callId, handles: prompt.handles, allowedKeys: rubric.items.map((i) => i.key).filter((k) => !pre.settings.disabledKeys.includes(k)), nextClaimId: () => deps.ids.next<'AssistantClaimId'>() as AssistantClaimId }) : null;
      if (parsed && !parsed.ok) {
        status = 'failed';
        signals = { ...signals, error: parsed.code };
      }
      // an oversized output is neither stored nor parsed
      const keep = text !== '' && !(parsed && !parsed.ok && parsed.code === 'OUTPUT_TOO_LARGE');
      const enc = keep ? Buffer.from(await deps.envelope.inTx(tx, tenantId).encrypt(tenantId, reviewAad(aiRunId), Buffer.from(text, 'utf8'))) : null;
      await R.insertAiRun(tx, { id: aiRunId, model, templateKey: prompt.templateKey, templateVersion: prompt.templateVersion, callId, outputEnc: enc, signals, inputTokens: tokens.input, outputTokens: tokens.output, latencyMs: latency, status });
      if (status !== 'succeeded' || !parsed || !parsed.ok) return { kind: 'skipped', reason: parsed && !parsed.ok ? parsed.code : 'MODEL_FAILED' };

      // the Owner's switch, the pack and the call may have changed while the model ran
      const g = await gate(tx, callId, true);
      if (!g.ok) return { kind: 'skipped', reason: g.reason };

      const score = scoreFromClaims(parsed.claims, rubric, pre.transcript, { disabledKeys: g.settings.disabledKeys });
      const labels = new Map(rubric.items.map((i) => [i.key, i.label]));
      const claims = storedClaims(parsed.claims, pre.transcript, (k) => labels.get(k) ?? k);
      const actionId = deps.ids.next<'AssistantActionId'>();
      const inserted = await insertAction(tx, { envelope: deps.envelope, tenantId, ids: deps.ids }, {
        id: actionId,
        contactId: g.facts.contactId,
        kind: 'call_review',
        category: 'internal',
        autonomy: 'internal',
        playbookVersionId: null,
        status: 'executed',
        ownerUserId: g.facts.agentUserId,
        explanation: 'Checklist review of a call, each check with the words that show it.',
        payload: { callId, rubricVersion: rubric.version },
        pinnedInboundSeq: null,
        boundOwnershipSeq: null,
        aiRunId,
        triggerRef: { kind: 'call_ready', callId },
        dedupeKey: CALL_REVIEW_DEDUPE(callId),
        claims,
      });
      if (!inserted) return { kind: 'skipped', reason: 'ALREADY_REVIEWED' };
      const ok = await R.insertCallScore(tx, { callId, rubricVersion: score.rubricVersion, agentUserId: g.facts.agentUserId, contactId: g.facts.contactId, items: callScoreItemsJson(score), metCount: score.metCount, scoredCount: score.scoredCount, actionId });
      if (!ok) return { kind: 'skipped', reason: 'ALREADY_REVIEWED' };
      return { kind: 'reviewed', callId, metCount: score.metCount, scoredCount: score.scoredCount, needsReview: score.items.filter((i) => i.status === 'needs_review').length };
    },
    { db: deps.db, retries: 2 },
  );
}

export const REVIEW_JOB_DEDUPE = (callId: string) => `coaching.call_review:${callId}`;
