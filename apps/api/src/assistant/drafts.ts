// Approving, rejecting and reviewing what the assistant proposed (ARCHITECTURE §11; R-AST-5, R-AST-6,
// R-AST-7, R-GATE-4, R-AUDIT-5 "draft approve with edits"; E16, E35).
//
// Approve is ONE tap: POST /assistant/actions/:id/approve { commandId, editedPayload? }.
//   TX-U (the agent, RLS-bound)  lock_contact → the action (own, proposed) → core.checkDraftCurrent:
//        owner / ownership period changed ⇒ `invalidated` + DRAFT_INVALIDATED (R-AST-7);
//        the client wrote since it was drafted ⇒ DRAFT_STALE with the fresh inbound seq: the agent
//        re-reviews and re-taps with `reviewedInboundSeq` (R-AST-6) → `approved` (decided by the agent;
//        edits audited as draft.approved_with_edits, PII redacted)
//   TX-S (system)  lock_contact → re-check the inbound seq (a reply that slipped in between reverts the
//        approval to proposed: DRAFT_STALE) → queueOutboundInTx(initiator 'assistant', the approved action);
//        rendered like a human send: an email gets the approving agent's own signature (read as them) and the
//        brokerage footer, a marketing text the brokerage line (R-PAR-25), so it matches the composer's preview
//   dispatchOutbound — the send-time gate with the approving agent as the sender (ARCHITECTURE §9 path 4)
// A seller update (Phase 2 assembles them) is sendable only with the agent's own edit (R-AST-17).
// A handback is approved by sending its suggested reply (or the agent's edit); with neither it is
// simply marked handled. Internal cards (summaries, saved-search proposals) are acknowledged.
import { checkDraftCurrent, draftCategory, formatDue } from '@realty/core/assistant';
import { classifyHumanPurpose } from '@realty/core/compliance';
import type { ContactId, IanaZone, Instant, UserActor } from '@realty/core/foundation';
import { type Tx, lockContact } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { dispatchOutbound, queueOutboundInTx } from '../comms/index.js';
import { storedDecisionView } from '../comms/gateInput.js';
import { renderHumanBody, unsubscribeUrl } from '../comms/render.js';
import { dealOrAppointmentContext } from '../comms/repos/contacts.js';
import { conversationOf, tenantFacts } from '../comms/repos/gate.js';
import { asSystem, asUser } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { senderSignature } from '../templates/repos/signature.js';
import * as A from './repos/actions.js';
import { contactCore } from './repos/context.js';
import type { AssistantDeps } from './types.js';
import { type ActionView, actionViews } from './views.js';

export interface EditedPayload {
  /** 'web_chat' (module 22, R-INBOX-4): an approved draft may answer in the lead's website chat */
  channel?: 'sms' | 'email' | 'web_chat' | undefined;
  subject?: string | undefined;
  body?: string | undefined;
  /** seller updates only: the approver's own recommendation, never prefilled (R-SELL-3) */
  recommendation?: string | undefined;
}

/** R-SELL-3: the shortest recommendation the database accepts on an approved seller update (0018 CHECK). */
export const SELLER_RECOMMENDATION_MIN = 20;

export interface ApproveInput {
  commandId: string;
  editedPayload?: EditedPayload | undefined;
  /** the inbound seq the agent re-reviewed after a DRAFT_STALE (R-AST-6) */
  reviewedInboundSeq?: number | undefined;
}

export interface ApproveResult {
  actionId: string;
  status: string;
  result: 'sent' | 'acknowledged' | 'queued' | 'blocked' | 'failed' | 'dispatch_unknown' | 'noop';
  messageId: string | null;
  decision: { id: string | null; outcome: string; reasons: string[]; explanation: string; phase: string } | null;
  /** a replay ('noop'): the status of the message the first approval made (with `decision` when it was blocked) */
  messageStatus?: string | null;
}

const SENDABLE = new Set(['message_draft', 'handback', 'seller_update_draft']);

interface Planned {
  kind: 'send' | 'acknowledged' | 'replay' | 'invalidated';
  sendActionId: string;
  messageKey: string;
  channel: 'sms' | 'email' | 'web_chat';
  subject: string | null;
  body: string;
  pinnedInboundSeq: number;
  contactId: string;
}

function mergedDraft(a: A.ActionRow, edit: EditedPayload | undefined): { channel: 'sms' | 'email' | 'web_chat'; subject: string | null; body: string } | null {
  const base = (a.kind === 'handback' ? (a.payload.draft as Record<string, unknown> | undefined) : a.payload) ?? {};
  const channel = edit?.channel ?? (base.channel === 'email' ? 'email' : base.channel === 'web_chat' || base.channel === 'inbound_channel' ? 'web_chat' : 'sms');
  const body = (edit?.body ?? (typeof base.body === 'string' ? base.body : '')).trim();
  const subject = (edit?.subject ?? (typeof base.subject === 'string' ? base.subject : '')).trim();
  if (body === '') return null;
  return { channel, subject: subject === '' ? null : subject, body };
}

async function contactState(tx: Tx, contactId: string): Promise<{ ownerUserId: string | null; periodSeq: number | null }> {
  const r = await sql<{ owner_user_id: string | null; ownership_period_seq: string | null }>`
    SELECT owner_user_id, ownership_period_seq FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const c = r.rows[0];
  return { ownerUserId: c?.owner_user_id ?? null, periodSeq: c?.ownership_period_seq == null ? null : Number(c.ownership_period_seq) };
}

async function messageByKey(tx: Tx, key: string): Promise<{ id: string; status: string; gate_decision_id: string | null } | null> {
  const r = await sql<{ id: string; status: string; gate_decision_id: string | null }>`SELECT id, status, gate_decision_id FROM messages WHERE tenant_id = app.tenant_id() AND idempotency_key = ${key}`.execute(tx);
  return r.rows[0] ?? null;
}

const approvalKey = (actionId: string) => `assistant-approve:${actionId}`;

/** POST /assistant/actions/:id/approve */
export async function approveAction(actor: UserActor, actionId: string, input: ApproveInput, deps: AssistantDeps): Promise<ApproveResult> {
  type Out = { kind: 'done'; result: ApproveResult } | { kind: 'stale'; inboundSeq: number; pinned: number | null } | { kind: 'invalidated' } | { kind: 'send'; plan: Planned };
  const out: Out = await asUser(deps, actor, async (tx, now) => {
    const peek = await A.actionById(tx, actionId);
    if (!peek || peek.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (peek.contactId) await lockContact(tx, peek.contactId as ContactId);
    const a = (await A.actionById(tx, actionId, { lock: true }))!;
    if (a.status === 'invalidated') return { kind: 'invalidated' };
    if (a.status !== 'proposed') {
      // the same tap arriving twice (double tap, network retry): report what the first one did
      if ((a.status === 'approved' || a.status === 'executed') && a.decidedByUserId === actor.userId) {
        const sendId = typeof a.payload.sentActionId === 'string' ? a.payload.sentActionId : a.id;
        const m = await messageByKey(tx, approvalKey(sendId));
        // what the first approval did: its message's status and, when blocked, the stored decision (finding F1: a
        // bare noop read as "Sent" although the chat had ended)
        if (m) return { kind: 'done', result: { actionId, status: a.status, result: 'noop', messageId: m.id, decision: await storedDecisionView(tx, m.gate_decision_id), messageStatus: m.status } };
        // approved but never queued (the queue transaction failed or the process died after the tap):
        // the re-tap finishes the send instead of reporting it handled
        const resume = a.status === 'approved' ? await unsentApproval(tx, a, sendId) : null;
        if (resume === 'invalidated') return { kind: 'invalidated' };
        if (resume) return { kind: 'send', plan: resume };
        return { kind: 'done', result: { actionId, status: a.status, result: 'acknowledged', messageId: null, decision: null } };
      }
      throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    }
    if (a.autonomy === 'within_playbook') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    const conv = a.contactId ? await conversationOf(tx, a.contactId) : null;
    if (a.contactId) {
      const c = await contactState(tx, a.contactId);
      const check = checkDraftCurrent({ draft: { ownerUserId: a.ownerUserId, boundOwnershipSeq: a.boundOwnershipSeq, pinnedInboundSeq: a.pinnedInboundSeq }, contact: { ownerUserId: c.ownerUserId, ownershipPeriodSeq: c.periodSeq }, conversation: conv ? { inboundSeq: conv.inboundSeq } : null });
      if (!check.ok && check.code === 'DRAFT_INVALIDATED') {
        await A.setStatus(tx, a.id, 'invalidated');
        await A.resolveFeedFor(tx, a.id, now);
        return { kind: 'invalidated' };
      }
      if (!check.ok && check.code === 'DRAFT_STALE') {
        if (input.reviewedInboundSeq === undefined || conv === null || input.reviewedInboundSeq !== conv.inboundSeq) return { kind: 'stale', inboundSeq: conv?.inboundSeq ?? 0, pinned: a.pinnedInboundSeq };
        // the agent saw the newest reply and still wants this sent: re-pin (R-AST-6 re-review)
        await sql`UPDATE assistant_actions SET pinned_inbound_seq = ${conv.inboundSeq} WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
        a.pinnedInboundSeq = conv.inboundSeq;
      }
    }
    // R-AST-17 / R-SELL-3: a seller update is never sent as drafted: the agent writes their own recommendation
    // (one shape: editedPayload.recommendation, which the 0018 CHECK requires on the approval) and taps send;
    // it goes out after the assembled update
    const recommendation = input.editedPayload?.recommendation?.trim() ?? '';
    if (a.kind === 'seller_update_draft' && recommendation.length < SELLER_RECOMMENDATION_MIN) throw new AppError('SELLER_UPDATE_NEEDS_RECOMMENDATION');
    const merged = SENDABLE.has(a.kind) ? mergedDraft(a, input.editedPayload) : null;
    const draft = merged && a.kind === 'seller_update_draft' ? { ...merged, body: `${merged.body}\n\n${recommendation}` } : merged;
    const edited = input.editedPayload !== undefined && draft !== null;
    if (draft === null || !a.contactId) {
      // nothing to send: a summary / proposal reviewed, or a handback the agent will answer themselves
      await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now });
      await A.resolveFeedFor(tx, a.id, now);
      return { kind: 'done', result: { actionId, status: 'approved', result: 'acknowledged', messageId: null, decision: null } };
    }
    let sendActionId = a.id;
    if (a.kind === 'handback') {
      // the reply goes out as its own human-approved draft (a handback itself is internal and never sendable)
      sendActionId = deps.ids.next<'AssistantActionId'>();
      const inbound = typeof a.payload.inboundMessageId === 'string' ? await inboundBody(tx, a.payload.inboundMessageId) : null;
      await A.insertAction(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, {
        id: sendActionId,
        contactId: a.contactId,
        kind: 'message_draft',
        category: draftCategory({ inboundText: inbound, draftText: draft.body }),
        autonomy: 'requires_approval',
        playbookVersionId: null,
        status: 'approved',
        ownerUserId: actor.userId,
        explanation: 'Your reply to the handback.',
        payload: { channel: draft.channel, body: draft.body, ...(draft.subject ? { subject: draft.subject } : {}) },
        pinnedInboundSeq: a.pinnedInboundSeq,
        boundOwnershipSeq: a.boundOwnershipSeq,
        aiRunId: null,
        triggerRef: { kind: 'handback', actionId: a.id },
        dedupeKey: `handback_reply:${a.id}:${input.commandId}`,
        claims: [],
        decidedByUserId: actor.userId,
      });
      await A.mergePayload(tx, a.id, { sentActionId: sendActionId });
      await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now });
    } else {
      await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now, editedPayload: edited ? { channel: draft.channel, body: draft.body, ...(draft.subject ? { subject: draft.subject } : {}), ...(a.kind === 'seller_update_draft' ? { recommendation } : {}) } : null });
    }
    if (edited) {
      const before = mergedDraft(a, undefined);
      await audit(tx, actor, { action: 'draft.approved_with_edits', entity: { type: 'assistant_action', id: a.id }, changes: redactDiff(before ?? {}, draft, { entity: 'message' }) });
    }
    await A.resolveFeedFor(tx, a.id, now);
    return { kind: 'send', plan: { kind: 'send', sendActionId, messageKey: approvalKey(sendActionId), channel: draft.channel, subject: draft.subject, body: draft.body, pinnedInboundSeq: a.pinnedInboundSeq ?? 0, contactId: a.contactId } };
  });
  if (out.kind === 'done') return out.result;
  if (out.kind === 'invalidated') throw new AppError('DRAFT_INVALIDATED');
  if (out.kind === 'stale') throw new AppError('DRAFT_STALE', { inboundSeq: out.inboundSeq, pinnedInboundSeq: out.pinned });
  return queueAndSend(actor, actionId, out.plan, deps);
}

/** The send plan of an approved draft whose message was never queued (null: nothing was to be sent). */
async function unsentApproval(tx: Tx, a: A.ActionRow, sendId: string): Promise<Planned | 'invalidated' | null> {
  if (!a.contactId) return null;
  if (a.kind === 'handback' && sendId === a.id) return null; // a handback marked handled without a reply
  const send = sendId === a.id ? a : await A.actionById(tx, sendId, { lock: true });
  if (!send || send.status !== 'approved' || !SENDABLE.has(send.kind) || send.contactId !== a.contactId) return null;
  const draft = mergedDraft(send, (send.editedPayload ?? undefined) as EditedPayload | undefined);
  if (!draft) return null;
  const c = await contactState(tx, a.contactId);
  if (send.ownerUserId !== c.ownerUserId || (send.boundOwnershipSeq ?? null) !== c.periodSeq) {
    // the lead changed hands since the tap (R-AST-7): the old owner's approval does not send
    await A.setStatus(tx, send.id, 'invalidated');
    return 'invalidated';
  }
  return { kind: 'send', sendActionId: send.id, messageKey: approvalKey(send.id), channel: draft.channel, subject: draft.subject, body: draft.body, pinnedInboundSeq: send.pinnedInboundSeq ?? 0, contactId: a.contactId };
}

async function inboundBody(tx: Tx, messageId: string): Promise<string | null> {
  // D5b (R-REACT-7): a reaction's quote is the team's words, never the client's
  const r = await sql<{ body: string }>`
    SELECT body FROM messages m WHERE tenant_id = app.tenant_id() AND id = ${messageId}
       AND NOT EXISTS (SELECT 1 FROM message_reactions mr WHERE mr.tenant_id = m.tenant_id AND mr.message_id = m.id)`.execute(tx);
  return r.rows[0]?.body ?? null;
}

async function queueAndSend(actor: UserActor, actionId: string, plan: Planned, deps: AssistantDeps): Promise<ApproveResult> {
  // The approving human is the sender (ARCHITECTURE §9 path 4), so their email carries their own plain-text
  // signature above the brokerage footer (R-PAR-25), as a human one-to-one email and the composer's preview do.
  // It is their own membership row (RLS: self), read as them: the queue transaction below is the system's.
  const signature = plan.channel === 'email' ? await asUser(deps, actor, (tx) => senderSignature(tx)) : null;
  type Q = { kind: 'stale'; inboundSeq: number } | { kind: 'queued'; messageId: string } | { kind: 'not_queued'; code: string };
  const q: Q = await asSystem(deps, actor.tenantId, 'assistant', async (tx, now) => {
    await lockContact(tx, plan.contactId as ContactId);
    const conv = await conversationOf(tx, plan.contactId);
    const prior = await messageByKey(tx, plan.messageKey);
    if (prior) return { kind: 'queued', messageId: prior.id };
    if (conv && conv.inboundSeq > plan.pinnedInboundSeq) {
      // a reply arrived between the tap and the queue: undo the approval, the agent re-reviews (R-AST-6)
      await revertApproval(tx, actionId, plan.sendActionId);
      return { kind: 'stale', inboundSeq: conv.inboundSeq };
    }
    // The approving human is the sender, so the human one-to-one purpose rules apply (R-CONSENT-5).
    const purpose = classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, plan.contactId), now });
    const t = await tenantFacts(tx);
    const identity = { brokerageLegalName: t.brokerageLegalName, postalAddress: t.postalAddress };
    // a chat reply renders like a text (brokerage name on marketing)
    const body = plan.channel !== 'email' ? renderHumanBody(plan.body, { channel: 'sms', purpose, identity, unsubscribe: null }) : plan.body;
    const r = await queueOutboundInTx(tx, deps, {
      contactId: plan.contactId,
      channel: plan.channel,
      body,
      ...(plan.channel === 'email' ? { subject: plan.subject ?? 'Following up' } : {}),
      initiator: 'assistant',
      purpose,
      category: (await A.actionById(tx, plan.sendActionId))!.category as never,
      assistantActionId: plan.sendActionId,
      idempotencyKey: plan.messageKey,
    }, now);
    if (!r.ok) {
      await revertApproval(tx, actionId, plan.sendActionId);
      return { kind: 'not_queued', code: r.code };
    }
    if (plan.channel === 'email') {
      // the email footer (brokerage name, postal address, unsubscribe link for marketing) needs the message id
      const unsub = purpose === 'marketing' ? unsubscribeUrl(deps.publicBaseUrl, deps.linkSecret, actor.tenantId, r.messageId) : null;
      const full = renderHumanBody(plan.body, { channel: 'email', purpose, identity, unsubscribe: unsub, signature });
      await sql`UPDATE messages SET body = ${full} WHERE tenant_id = app.tenant_id() AND id = ${r.messageId} AND status IN ('queued','scheduled')`.execute(tx);
    }
    return { kind: 'queued', messageId: r.messageId };
  });
  if (q.kind === 'stale') throw new AppError('DRAFT_STALE', { inboundSeq: q.inboundSeq, pinnedInboundSeq: plan.pinnedInboundSeq });
  if (q.kind === 'not_queued') throw new AppError(q.code === 'CONTACT_POINT_MISSING' || q.code === 'CONTACT_MERGED' ? q.code : 'SENDER_UNAVAILABLE');
  const d = await dispatchOutbound(q.messageId, deps, { tenantId: actor.tenantId });
  const status = await asUser(deps, actor, async (tx) => (await A.actionById(tx, actionId))?.status ?? 'approved');
  const result: ApproveResult['result'] = d.kind === 'not_due' ? 'queued' : d.kind === 'needs_retap' ? 'blocked' : d.kind;
  return { actionId, status, result, messageId: q.messageId, decision: 'decision' in d ? d.decision : null };
}

async function revertApproval(tx: Tx, actionId: string, sendActionId: string): Promise<void> {
  await sql`UPDATE assistant_actions SET status = 'proposed', decided_by_user_id = NULL, decided_at = NULL WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  if (sendActionId !== actionId) {
    await sql`UPDATE assistant_actions SET status = 'superseded' WHERE tenant_id = app.tenant_id() AND id = ${sendActionId}`.execute(tx);
    await sql`UPDATE assistant_actions SET payload = payload - 'sentActionId' WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  }
  await sql`
    UPDATE priority_feed_items SET state = 'open', resolved_at = NULL, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND assistant_action_id = ${actionId} AND state = 'done'
       AND NOT EXISTS (SELECT 1 FROM priority_feed_items o WHERE o.tenant_id = priority_feed_items.tenant_id AND o.user_id = priority_feed_items.user_id
                        AND o.dedupe_key = priority_feed_items.dedupe_key AND o.state IN ('open','snoozed'))`.execute(tx);
}

/** POST /assistant/actions/:id/reject */
export async function rejectAction(actor: UserActor, actionId: string, deps: AssistantDeps): Promise<{ actionId: string; status: string }> {
  return asUser(deps, actor, async (tx, now) => {
    const peek = await A.actionById(tx, actionId);
    if (!peek || peek.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (peek.contactId) await lockContact(tx, peek.contactId as ContactId);
    const a = (await A.actionById(tx, actionId, { lock: true }))!;
    if (a.status === 'rejected') return { actionId, status: 'rejected' };
    // an autonomous playbook message is not stopped by a card decision (dispatch does not read it): it is
    // stopped by pausing or stopping the enrollment, which cancels it (R-GATE-4)
    if (a.status !== 'proposed' || a.autonomy === 'within_playbook') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    await A.setDecision(tx, a.id, { status: 'rejected', decidedByUserId: actor.userId, now });
    await A.resolveFeedFor(tx, a.id, now);
    return { actionId, status: 'rejected' };
  });
}

/** GET /assistant/inbox: the agent's open assistant cards with explanation and evidence. */
export async function inbox(actor: UserActor, deps: AssistantDeps, limit = 50): Promise<ActionView[]> {
  return asUser(deps, actor, async (tx) => actionViews(tx, actor, deps.envelope, await A.inboxActions(tx, limit)));
}

export async function actionView(actor: UserActor, actionId: string, deps: AssistantDeps): Promise<ActionView> {
  return asUser(deps, actor, async (tx) => {
    const a = await A.actionById(tx, actionId);
    if (!a) throw new AppError('NOT_FOUND');
    return (await actionViews(tx, actor, deps.envelope, [a]))[0]!;
  });
}

// ---- claim review (R-AST-5) -----------------------------------------------------------------------

export interface ClaimReviewInput {
  status: 'confirmed' | 'corrected' | 'rejected';
  corrected?: { text?: string | undefined; dueAt?: string | undefined; allDay?: boolean | undefined } | undefined;
}

/**
 * POST /assistant/claims/:id/review. Only after a confirm or correct may a needs-review claim feed a
 * task due date (its promise task gets the date and loses needs_review); a rejected claim cancels it.
 */
export async function reviewClaim(actor: UserActor, claimId: string, input: ClaimReviewInput, deps: AssistantDeps): Promise<{ claimId: string; reviewStatus: string }> {
  return asUser(deps, actor, async (tx, now) => {
    const c = await A.claimById(tx, claimId);
    if (!c) throw new AppError('NOT_FOUND');
    const a = await A.actionById(tx, c.actionId);
    if (!a || a.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (a.contactId) await lockContact(tx, a.contactId as ContactId);
    if (c.reviewStatus !== 'unreviewed') throw new AppError('ALREADY_REVIEWED');
    let structured: Record<string, unknown> | undefined;
    if (input.status === 'corrected' && input.corrected?.dueAt) {
      const at = Date.parse(input.corrected.dueAt);
      if (!Number.isFinite(at)) throw new AppError('VALIDATION_FAILED');
      const prev = (c.structured?.due ?? {}) as Record<string, unknown>;
      // shown (and pinned on the promise task) in the client's zone, like the assistant's own dates (R-AST-2)
      const contact = a.contactId ? await contactCore(tx, a.contactId) : null;
      const zone = contact?.zone ?? (typeof prev.zone === 'string' ? (prev.zone as IanaZone) : ('UTC' as IanaZone));
      const allDay = input.corrected.allDay === true;
      structured = { ...(c.structured ?? {}), due: { ...prev, at, allDay, zone, display: formatDue(at as Instant, allDay, zone), corrected: true } };
    }
    if (input.status === 'corrected' && !input.corrected?.text && !structured) throw new AppError('VALIDATION_FAILED');
    await A.reviewClaim(tx, claimId, { status: input.status, userId: actor.userId, now, ...(input.corrected?.text ? { text: input.corrected.text.slice(0, 300) } : {}), ...(structured ? { structured } : {}) });
    await applyReviewToTasks(tx, claimId, input.status, structured ?? c.structured, now);
    return { claimId, reviewStatus: input.status };
  });
}

async function applyReviewToTasks(tx: Tx, claimId: string, status: 'confirmed' | 'corrected' | 'rejected', structured: Record<string, unknown> | null, now: Instant): Promise<void> {
  void now;
  if (status === 'rejected') {
    await sql`UPDATE tasks SET status = 'canceled', needs_review = false WHERE tenant_id = app.tenant_id() AND source_claim_id = ${claimId} AND status = 'open'`.execute(tx);
    return;
  }
  const due = (structured?.due ?? null) as { at?: number; allDay?: boolean; zone?: string } | null;
  const at = due && typeof due.at === 'number' ? new Date(due.at).toISOString() : null;
  await sql`
    UPDATE tasks SET needs_review = false, due_at = COALESCE(${at}::timestamptz, due_at), due_all_day = ${due?.allDay === true},
           due_tz = COALESCE(${due?.zone ?? null}, due_tz)
     WHERE tenant_id = app.tenant_id() AND source_claim_id = ${claimId} AND status = 'open'`.execute(tx);
}
