// Review reply drafts and one-tap replies (module 53; DATA_MODEL R-GBP-1, R-GBP-4; E132, E133, E464-E466, E469-E471).
//
// A reply is a review_reply_draft (requires_approval, novel_message by CHECK) that an Owner or Admin posts with one tap;
// the assistant only drafts, and only when a person asked (never by rating or sentiment, E133). Drafts are owner-less
// (owner_user_id and contact_id NULL): only tenant-wide actors see them, the inbox and the feed never list them, and the
// generic assistant action routes never handle them (E471). Every route reads the review as the person (RLS); an action
// id must be a review_reply_draft of this review that gbp_reviews.reply_action_id names, or it is NOT_FOUND.
//
//   draft    TX1 as the person: the review is visible, platform:gbp cleared, not removed, its location live, no reply
//            in flight (REPLY_IN_PROGRESS). 'assistant': the model (outside any transaction) gets only the rating, the
//            review text and the team's name; a failure or a draft with a hard guard code creates nothing
//            (ASSISTANT_UNAVAILABLE). 'manual': stored with its guard codes for editing.
//            TX2 as the system: the waiting draft is superseded, the new one inserted, the review marked drafted.
//   reply    the one tap. TX1 as the person: the guard on the final text (REPLY_PRIVACY), the review unchanged since the
//            draft (REPLY_STALE), platform:gbp and platform:fair_housing cleared, the location live, an adapter on the
//            platform; the claim is the decision proposed → approved, so a second tap finds it approved and answers
//            REPLY_IN_PROGRESS without calling Google (E464). marketing/publish.ts sendReviewReply, outside any
//            transaction. TX2 as the system: replied → executed and "Replied on Google"; failed → back to a draft;
//            unknown → stays approved ("Checking with Google") until the sync settles it (E465), never posted twice.
//   discard  a waiting draft is rejected by the person and the review needs a reply again; one being posted is not.
// A public review reply is publishing, not contact communication (R-GATE-15): no messages row, contact point, touch or
// consent event, and nothing here imports comms/dispatch, leads, ownership or assistant/drafts.
import { createHash } from 'node:crypto';
import { type IdGenerator, type TenantId, type UserActor } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { fairHousingPack, identityOf } from '../marketing/repo.js';
import { sendReviewReply } from '../marketing/publish.js';
import type { AiProvider } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import { type GuardCode, guardReply } from './guard.js';
import { REVIEW_REPLY_TEMPLATE, parseReply, replyPrompt } from './prompt.js';
import type { GbpProvider } from './provider.js';
import * as R from './repos/gbp.js';
import { SETTLE_AFTER_MS, tokenOf } from './sync.js';
import { notClearedSentence } from './status.js';

export interface ReplyDeps {
  db: Database;
  envelope: EnvelopeService;
  ids: IdGenerator;
  ai: AiProvider;
  gbp?: GbpProvider;
  /** tests: how long one reply is waited for */
  replyTimeoutMs?: number;
}

/** The fixed explanation of every reply draft: never the reviewer's name or the review's words. */
export const DRAFT_EXPLANATION = 'A reply to a Google review, waiting for an Owner or Admin to post it.';

export type ReviewState = 'needs_reply' | 'draft_waiting' | 'posting' | 'checking' | 'replied' | 'replied_outside' | 'removed';
const STATE_LABEL: Record<ReviewState, string> = {
  needs_reply: 'Needs a reply',
  draft_waiting: 'Draft waiting',
  posting: 'Posting…',
  checking: 'Checking with Google',
  replied: 'Replied',
  replied_outside: 'Replied on Google outside Realty OS',
  removed: 'Removed at Google',
};

export interface ReviewView {
  id: string;
  connectionId: string;
  rating: number | null;
  body: string | null;
  reviewerDisplay: string | null;
  reviewedAt: string;
  state: ReviewState;
  stateLabel: string;
  /** the waiting draft (Owner/Admin only: the action is invisible to anyone else) */
  draft: { actionId: string; text: string; guard: GuardCode[]; byAssistant: boolean } | null;
}

export const reviewSha256 = (r: Pick<R.ReviewRow, 'rating' | 'body'>) => createHash('sha256').update(`${r.rating ?? ''}\n${r.body ?? ''}`, 'utf8').digest('hex');
const asSystem = <T>(d: Pick<ReplyDeps, 'db'>, tenantId: string, fn: (tx: Tx) => Promise<T>) => withTenantTx(systemActor(tenantId, 'provider'), fn, { db: d.db, retries: 2 });
const asPerson = <T>(d: Pick<ReplyDeps, 'db'>, actor: UserActor, fn: (tx: Tx) => Promise<T>) => withTenantTx(actor, fn, { db: d.db, retries: 0 });

function stateOf(r: R.ReviewRow, a: R.DraftRow | null, now: number): ReviewState {
  if (r.rating === null) return 'removed';
  if (r.reply_status === 'none') return 'needs_reply';
  if (r.reply_status === 'replied') return r.reply_action_id ? 'replied' : 'replied_outside';
  if (a?.status === 'approved') return a.decided_at && a.decided_at.getTime() < now - SETTLE_AFTER_MS ? 'checking' : 'posting';
  return 'draft_waiting';
}

async function viewOf(tx: Tx, r: R.ReviewRow, now: number): Promise<ReviewView> {
  // the action is read under the caller's RLS: owner-less, so only tenant-wide actors read it at all
  const a = r.reply_action_id ? await R.actionById(tx, r.reply_action_id) : null;
  const draft = a && r.reply_status === 'drafted' && a.kind === 'review_reply_draft' && a.payload.review_id === r.id
    ? { actionId: a.id, text: a.edited_payload?.text ?? a.payload.text ?? '', guard: (a.payload.guard ?? []) as GuardCode[], byAssistant: a.payload.mode === 'assistant' }
    : null;
  const state = stateOf(r, a, now);
  return { id: r.id, connectionId: r.connection_id, rating: r.rating, body: r.body, reviewerDisplay: r.reviewer_display, reviewedAt: r.reviewed_at.toISOString(), state, stateLabel: STATE_LABEL[state], draft };
}

/** GET /gbp/reviews. While platform:gbp is uncleared no stored review is read. */
export async function listReviews(tx: Tx, o: { connectionId: string | null; filter: 'needs_reply' | 'all' }, now: number): Promise<{ state: 'not_cleared' | 'ready'; sentence: string; reviews: ReviewView[] }> {
  const pack = await R.packState(tx);
  if (!pack.cleared) return { state: 'not_cleared', sentence: notClearedSentence(pack.version), reviews: [] };
  if (o.connectionId && !(await R.locationById(tx, o.connectionId))) throw new AppError('NOT_FOUND');
  const rows = await R.reviewsOf(tx, o.connectionId, o.filter === 'needs_reply');
  const reviews: ReviewView[] = [];
  for (const r of rows) reviews.push(await viewOf(tx, r, now));
  return { state: 'ready', sentence: reviews.length === 0 ? (o.filter === 'needs_reply' ? 'No review needs a reply.' : 'No reviews yet.') : `${reviews.length} review${reviews.length === 1 ? '' : 's'}.`, reviews };
}

export async function oneReview(deps: Pick<ReplyDeps, 'db'>, actor: UserActor, reviewId: string): Promise<ReviewView> {
  return asPerson(deps, actor, async (tx) => {
    const r = await R.reviewById(tx, reviewId);
    if (!r) throw new AppError('NOT_FOUND');
    return viewOf(tx, r, Date.now());
  });
}

/** The review (as the person) and the gates every write shares. */
async function liveReview(tx: Tx, reviewId: string, o: { forUpdate?: boolean } = {}): Promise<{ review: R.ReviewRow; location: R.LocationRow; pack: R.PackState }> {
  const review = await R.reviewById(tx, reviewId, o);
  if (!review) throw new AppError('NOT_FOUND');
  const pack = await R.packState(tx);
  if (!pack.cleared) throw new AppError('GBP_NOT_CLEARED');
  const location = await R.locationById(tx, review.connection_id);
  if (!location || (location.status !== 'connected' && location.status !== 'degraded')) throw new AppError('CHANNEL_NOT_CONNECTED');
  return { review, location, pack };
}

/** The action named by the review, of this review and of the reply kind; anything else is NOT_FOUND. */
async function namedDraft(tx: Tx, review: R.ReviewRow, actionId: string): Promise<R.DraftRow> {
  if (review.reply_status !== 'drafted' || review.reply_action_id !== actionId) throw new AppError('NOT_FOUND');
  const a = await R.actionById(tx, actionId, { forUpdate: true });
  if (!a || a.kind !== 'review_reply_draft' || a.payload.review_id !== review.id) throw new AppError('NOT_FOUND');
  return a;
}

// ---- draft --------------------------------------------------------------------------------------------------------

export async function draftReply(deps: ReplyDeps, actor: UserActor, reviewId: string, input: { mode: 'assistant' | 'manual'; text?: string | undefined }): Promise<ReviewView> {
  // TX1, as the person
  const t1 = await asPerson(deps, actor, async (tx) => {
    const { review } = await liveReview(tx, reviewId);
    if (review.rating === null) throw new AppError('REPLY_STALE');
    if (review.reply_action_id && review.reply_status === 'drafted') {
      const cur = await R.actionById(tx, review.reply_action_id);
      if (cur?.status === 'approved') throw new AppError('REPLY_IN_PROGRESS');
    }
    const s = (await sql<{ ai: boolean }>`SELECT ai_enabled AS ai FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0];
    const identity = await identityOf(tx);
    const fh = await fairHousingPack(tx, identity.jurisdictions);
    return { review, aiEnabled: s?.ai === true, teamName: identity.teamName, fh };
  });
  let text: string;
  let run: { model: string; inputTokens: number; outputTokens: number; latencyMs: number; ok: boolean; runId?: string | undefined } | null = null;
  if (input.mode === 'assistant') {
    if (!t1.aiEnabled) throw new AppError('ASSISTANT_UNAVAILABLE', { reason: 'AI_OFF' });
    const started = Date.now();
    let parsed: string | null = null;
    try {
      const res = await deps.ai.complete(replyPrompt({ rating: t1.review.rating!, body: t1.review.body, teamName: t1.teamName }));
      parsed = res.stopReason === 'end_turn' ? parseReply(res.text) : null;
      run = { model: res.model, inputTokens: res.inputTokens, outputTokens: res.outputTokens, latencyMs: Date.now() - started, ok: parsed !== null };
    } catch {
      run = { model: 'unknown', inputTokens: 0, outputTokens: 0, latencyMs: Date.now() - started, ok: false };
    }
    // E132: an assistant draft never names the reviewer or a price: a hard guard code creates nothing
    const refused = parsed === null || guardReply(parsed, { reviewerDisplay: t1.review.reviewer_display, fairHousing: t1.fh }).codes.length > 0;
    await recordRun(deps, actor, t1.review.id, run, refused ? 'failed' : 'succeeded');
    if (refused) throw new AppError('ASSISTANT_UNAVAILABLE', { reason: 'DRAFT_REFUSED' });
    text = parsed!;
  } else {
    text = (input.text ?? '').trim();
    if (text === '') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/text', code: 'required' }] });
  }
  const guard = guardReply(text, { reviewerDisplay: t1.review.reviewer_display, fairHousing: t1.fh });
  // TX2, as the system
  const actionId = deps.ids.next<'AssistantActionId'>();
  await asSystem(deps, actor.tenantId, async (tx) => {
    const cur = await R.reviewById(tx, reviewId, { forUpdate: true });
    if (!cur || cur.rating === null) throw new AppError('REPLY_STALE');
    if (cur.reply_status === 'replied') throw new AppError('REPLY_STALE');
    if (cur.reply_status === 'drafted' && cur.reply_action_id) {
      const old = await R.actionById(tx, cur.reply_action_id, { forUpdate: true });
      if (old?.status === 'approved') throw new AppError('REPLY_IN_PROGRESS');
      if (old?.status === 'proposed') await R.setActionStatus(tx, old.id, 'superseded');
    }
    const payload = { review_id: cur.id, text, review_sha256: reviewSha256(cur), guard: guard.codes, mode: input.mode };
    await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, ai_run_id, trigger_ref)
              VALUES (app.tenant_id(), ${actionId}, NULL, 'review_reply_draft', 'novel_message', 'requires_approval', 'proposed', NULL, ${DRAFT_EXPLANATION},
                      ${JSON.stringify(payload)}::jsonb, ${run?.runId ?? null}, ${JSON.stringify({ reviewId: cur.id })}::jsonb)`.execute(tx);
    await R.setReply(tx, cur.id, 'drafted', actionId);
    await audit(tx, systemActor(actor.tenantId, 'provider'), { action: 'gbp.reply_drafted', entity: { type: 'gbp_review', id: cur.id }, changes: redactSnapshot({ action_id: actionId, mode: input.mode, guard: guard.codes, requested_by_user_id: actor.userId }), reason: 'TAPPED' });
  });
  return oneReview(deps, actor, reviewId);
}

async function recordRun(deps: ReplyDeps, actor: UserActor, reviewId: string, run: { model: string; inputTokens: number; outputTokens: number; latencyMs: number; ok: boolean; runId?: string | undefined } | null, status: 'succeeded' | 'failed'): Promise<void> {
  if (!run) return;
  const id = deps.ids.next<'AiRunId'>();
  await asSystem(deps, actor.tenantId, (tx) =>
    sql`INSERT INTO ai_runs (tenant_id, id, purpose, model, prompt_template_key, prompt_version, input_refs, output_enc, key_version, internal_signals,
          input_tokens, output_tokens, latency_ms, status, requested_for_user_id)
        VALUES (app.tenant_id(), ${id}, 'review_reply', ${run.model.slice(0, 100)}, ${REVIEW_REPLY_TEMPLATE.key}, ${REVIEW_REPLY_TEMPLATE.version},
          ${JSON.stringify({ reviewIds: [reviewId] })}::jsonb, NULL, NULL, '{}'::jsonb, ${run.inputTokens}, ${run.outputTokens}, ${run.latencyMs}, ${status}, ${actor.userId})`.execute(tx),
  );
  run.runId = status === 'succeeded' ? id : undefined;
}

// ---- the one tap --------------------------------------------------------------------------------------------------

export type ReplyOutcome = { kind: 'replied' } | { kind: 'failed'; code: string } | { kind: 'unknown' };

export const OUTCOME_SENTENCE = {
  replied: 'Replied on Google',
  failed: (code: string) => `Google did not take the reply (${code}). Edit it or try again.`,
  unknown: "We didn't hear back from Google. We are checking; we won't post it twice.",
};

export async function postReply(deps: ReplyDeps, actor: UserActor, reviewId: string, input: { actionId: string; text: string }): Promise<{ review: ReviewView; outcome: ReplyOutcome; sentence: string }> {
  const text = input.text.trim();
  // TX1, as the person: every check, then the claim (proposed → approved, as themselves)
  const t1 = await asPerson(deps, actor, async (tx) => {
    // the person locks the action (the claim), not the review: gbp_reviews is written by the system only
    const { review, location, pack } = await liveReview(tx, reviewId);
    const a = await namedDraft(tx, review, input.actionId);
    if (a.status === 'approved') throw new AppError('REPLY_IN_PROGRESS');
    if (a.status !== 'proposed') throw new AppError('NOT_FOUND');
    const identity = await identityOf(tx);
    const g = guardReply(text, { reviewerDisplay: review.reviewer_display, fairHousing: await fairHousingPack(tx, identity.jurisdictions) });
    // E469: each code and its span (offsets into the person's own text; never the text itself)
    if (text === '' || g.codes.length > 0) throw new AppError('REPLY_PRIVACY', { codes: text === '' ? ['LENGTH'] : g.codes, spans: g.spans });
    // E466: the review changed at Google after the draft was written
    if (review.rating === null || a.payload.review_sha256 !== reviewSha256(review)) throw new AppError('REPLY_STALE');
    if (!pack.fairHousingCleared) throw new AppError('PLATFORM_NOT_CLEARED', { pack: 'platform:fair_housing' });
    if (!deps.gbp?.configured) throw new AppError('GBP_NOT_CONFIGURED');
    if (!location.external_account_id || !location.credential_id) throw new AppError('CHANNEL_NOT_CONNECTED');
    await sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now(), edited_payload = ${JSON.stringify({ text })}::jsonb, updated_at = now()
               WHERE tenant_id = app.tenant_id() AND id = ${a.id} AND status = 'proposed'`.execute(tx);
    return { review, location };
  });
  const token = await asSystem(deps, actor.tenantId, (tx) => tokenOf(tx, deps.envelope, actor.tenantId as TenantId, t1.location.credential_id!)).catch(() => null);
  // the provider, outside any transaction, by the claim holder only
  const sent = token
    ? await sendReviewReply({ gbp: deps.gbp }, { externalAccountId: t1.location.external_account_id!, accessToken: token, externalReviewId: t1.review.external_review_id, text }, deps.replyTimeoutMs)
    : { failed: 'CREDENTIAL_UNAVAILABLE' };
  const outcome: ReplyOutcome = sent === 'replied' ? { kind: 'replied' } : sent === 'unknown' ? { kind: 'unknown' } : { kind: 'failed', code: sent.failed };
  // TX2, as the system
  await asSystem(deps, actor.tenantId, async (tx) => {
    const a = await R.actionById(tx, input.actionId, { forUpdate: true });
    if (!a || a.status !== 'approved') return; // the sync settled it meanwhile
    if (outcome.kind === 'replied') {
      await R.setActionStatus(tx, a.id, 'executed');
      const r = await R.reviewById(tx, reviewId, { forUpdate: true });
      if (r && r.reply_status === 'drafted' && r.reply_action_id === a.id) await R.setReply(tx, r.id, 'replied', a.id);
      await audit(tx, systemActor(actor.tenantId, 'provider'), { action: 'gbp.reply_posted', entity: { type: 'gbp_review', id: reviewId }, changes: redactSnapshot({ action_id: a.id, approved_by_user_id: actor.userId }), reason: 'PROVIDER_CONFIRMED' });
    } else if (outcome.kind === 'failed') {
      await R.revertToProposed(tx, a.id);
    }
  });
  const sentence = outcome.kind === 'replied' ? OUTCOME_SENTENCE.replied : outcome.kind === 'failed' ? OUTCOME_SENTENCE.failed(outcome.code) : OUTCOME_SENTENCE.unknown;
  return { review: await oneReview(deps, actor, reviewId), outcome, sentence };
}

// ---- discard ------------------------------------------------------------------------------------------------------

export async function discardReply(deps: ReplyDeps, actor: UserActor, reviewId: string, input: { actionId: string }): Promise<ReviewView> {
  await asPerson(deps, actor, async (tx) => {
    const review = await R.reviewById(tx, reviewId);
    if (!review) throw new AppError('NOT_FOUND');
    const a = await namedDraft(tx, review, input.actionId);
    if (a.status === 'approved') throw new AppError('REPLY_IN_PROGRESS');
    if (a.status !== 'proposed') throw new AppError('NOT_FOUND');
    await sql`UPDATE assistant_actions SET status = 'rejected', decided_by_user_id = app.user_id(), decided_at = now(), updated_at = now()
               WHERE tenant_id = app.tenant_id() AND id = ${a.id} AND status = 'proposed'`.execute(tx);
  });
  await asSystem(deps, actor.tenantId, async (tx) => {
    const r = await R.reviewById(tx, reviewId, { forUpdate: true });
    if (r && r.reply_status === 'drafted' && r.reply_action_id === input.actionId) await R.setReply(tx, r.id, 'none', null);
    await audit(tx, systemActor(actor.tenantId, 'provider'), { action: 'gbp.reply_discarded', entity: { type: 'gbp_review', id: reviewId }, changes: redactSnapshot({ action_id: input.actionId, discarded_by_user_id: actor.userId }), reason: 'TAPPED' });
  });
  return oneReview(deps, actor, reviewId);
}
