// Creating outbound messages (ARCHITECTURE §9 paths 1, 2, 4–8). Creating a message never sends it:
// every send goes through dispatchOutbound's send-time gate.
//
// - composeHumanMessage: an agent's text/email from the contact, feed or thread. Immediate ⇒ queued and
//   dispatched in the request (TX1 runs as the agent); scheduled ⇒ 'scheduled' + a comms.dispatch job at
//   that instant, re-gated then (and it needs a re-tap if the client replied since, E27).
// - previewHumanMessage: the compose-time preview ("Won't send: opted out of texts"); never stored.
// - queueOutboundInTx: for assistant/system senders (api/assistant playbook steps, first response, search
//   alerts; comms' own opt-out confirmation / HELP reply), in the caller's system transaction.
// None of them addresses a merged-away record (F1, merged.ts): the person lives on the survivor.
import { type Channel, type NumberFacts, chooseSender, classifyHumanPurpose } from '@realty/core/compliance';
import type { ContactId, IdGenerator, Instant, TenantId, UserActor } from '@realty/core/foundation';
import { at, toIso } from '@realty/core/foundation';
import { type Tx, lockContact } from '@realty/db';
import { audit, redactDiff, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { COMMS_DISPATCH } from '../worker/contracts.js';
import { enqueueTyped } from '../worker/registry.js';
import { dispatchOutbound } from './dispatch.js';
import { decisionView, evaluateGate, insertBlockedDecision, resolvedPolicy, storedDecisionView, verdictOf } from './gateInput.js';
import { renderHumanBody, unsubscribeUrl } from './render.js';
import { refuseMergedAway } from './merged.js';
import { contactFacts, dealOrAppointmentContext, detailVisibleContact, mergedAway } from './repos/contacts.js';
import * as g from './repos/gate.js';
import * as msgs from './repos/messages.js';
import { asUser } from './runtime.js';
import { senderSignature } from '../templates/repos/signature.js';
import type { CommsDeps, DecisionView, DispatchResult, OutboundIntent } from './types.js';
import { chatRoutes } from '../channels/repos/webchat.js';
import { attachUploadsInTx, mediaInputIssues, textTooLong, uploadsTotalBytes } from './outboundMedia.js';
import { MMS_LIMITS } from '@realty/core/texting';

export interface ComposeInput {
  /** 'web_chat' (module 22): a reply in the contact's website chat, through the session's widget; never scheduled */
  channel: 'sms' | 'email' | 'web_chat';
  body: string;
  subject?: string | undefined;
  scheduleAt?: string | undefined;
  idempotencyKey: string;
  toPointId?: string | undefined;
  /** parity module 63: the bulk action this send belongs to (messages_bulk_guard); absent for one-to-one sends */
  bulkActionId?: string | undefined;
  /** parity module 63: a bulk send is always marketing (R-PAR-39); absent = classified as today */
  purposeOverride?: 'marketing' | undefined;
  /** module 29: an open-house invite (email, marketing; R-MKT-8: one gated message per recipient, linked to the piece) */
  marketingPieceId?: string | undefined;
  /** D5a: the sender's own staged uploads (outboundMedia.ts), in order = positions; the row is stored as 'mms' */
  mediaIds?: readonly string[] | undefined;
}

export interface MessageView {
  id: string;
  channel: 'sms' | 'mms' | 'email' | 'web_chat';
  status: string;
  statusReason: string | null;
  purpose: 'marketing' | 'informational' | null;
  body: string;
  subject: string | null;
  scheduledFor: string | null;
  dispatchedAt: string | null;
}

export function messageView(m: msgs.MessageRow): MessageView {
  return {
    id: m.id,
    channel: m.channel,
    status: m.status,
    statusReason: m.statusReason,
    purpose: m.purpose,
    body: m.body,
    subject: m.subject,
    scheduledFor: m.scheduledFor === null ? null : toIso(m.scheduledFor),
    dispatchedAt: m.dispatchedAt === null ? null : toIso(m.dispatchedAt),
  };
}

export interface ComposeResult {
  message: MessageView | null;
  decision: DecisionView | null;
  result: DispatchResult['kind'] | 'scheduled' | 'not_created';
}

interface Draft {
  point: g.PointRow;
  conversationId: string;
  phoneNumberId: string | null;
  emailIdentityId: string | null;
  fromAddress: string | null;
  purpose: 'marketing' | 'informational';
  inboundSeq: number;
  /** web chat (module 22): the widget the session came through and whether it can take a reply now (R-INBOX-7, E77) */
  chat: { connectionId: string; live: boolean } | null;
  /** D5a: the kind of the sending number (SMS parts split at 152/66 on toll-free), null without one */
  numberType: 'local' | 'toll_free' | null;
}

/** The chat-widget fact for the gate (core check 10): a closed session takes no reply, like a disconnected widget (E77). */
export function chatConnection(chat: Draft['chat']): OutboundIntent['connection'] {
  return chat === null ? null : { status: chat.live ? 'connected' : 'other' };
}

/** Number choice by continuity (sticky → own direct → team main), never by registration (R-CONSENT-17). */
async function chooseNumber(tx: Tx, conv: g.ConversationRow | null, userId: string | null, firstResponse: boolean): Promise<(NumberFacts & { e164: string }) | null> {
  const nums = await g.candidateNumbers(tx, userId);
  const facts = async (id: string | null) => (id ? ((await g.numberFacts(tx, id)) ?? undefined) : undefined);
  const sticky = await facts(conv?.stickyPhoneNumberId ?? null);
  const direct = await facts(nums.direct);
  const main = await facts(nums.teamMain);
  const pick = chooseSender({ ...(sticky ? { stickyNumber: sticky } : {}), ...(direct ? { ownerDirect: direct } : {}), ...(main ? { teamMain: main } : {}), firstResponse });
  if (!pick) return null;
  return [sticky, direct, main].find((n) => n?.id === pick.id) ?? null;
}

function pickPoint(points: readonly g.PointRow[], channel: Channel, toPointId: string | undefined): g.PointRow | null {
  const kind = channel === 'email' ? 'email' : channel === 'web_chat' ? 'web_chat' : 'phone';
  if (toPointId) return points.find((p) => p.id === toPointId && p.kind === kind) ?? null;
  return points.find((p) => p.kind === kind && p.status === 'active') ?? points.find((p) => p.kind === kind) ?? null;
}

async function draftFor(tx: Tx, deps: CommsDeps, contactId: string, userId: string | null, channel: 'sms' | 'email' | 'web_chat', toPointId: string | undefined, now: Instant, o: { firstResponse?: boolean; purpose?: 'marketing' | 'informational'; phoneNumberId?: string | null } = {}): Promise<Draft> {
  if (channel === 'web_chat') return chatDraftFor(tx, deps, contactId, toPointId, now, o);
  const point = pickPoint(await g.contactPoints(tx, contactId), channel, toPointId);
  if (!point) throw new AppError('CONTACT_POINT_MISSING');
  const conversationId = await msgs.ensureConversation(tx, deps.ids.next<'ConversationId'>(), contactId, null);
  const conv = await g.conversationOf(tx, contactId);
  let phoneNumberId: string | null = null;
  let emailIdentityId: string | null = null;
  let fromAddress: string | null = null;
  let numberType: Draft['numberType'] = null;
  if (channel === 'sms') {
    const n = o.phoneNumberId ? await g.numberFacts(tx, o.phoneNumberId) : await chooseNumber(tx, conv, userId, o.firstResponse === true);
    if (n) {
      phoneNumberId = n.id;
      fromAddress = n.e164;
      numberType = n.numberType;
    }
  } else {
    emailIdentityId = await g.chooseEmailIdentity(tx, userId);
    if (emailIdentityId) fromAddress = (await g.emailIdentityFacts(tx, emailIdentityId))?.fromAddress ?? null;
  }
  const purpose = o.purpose ?? classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now });
  return { point, conversationId, phoneNumberId, emailIdentityId, fromAddress, purpose, inboundSeq: conv?.inboundSeq ?? 0, chat: null, numberType };
}

/**
 * A reply in website chat (module 22): to the contact's chat identity (the open session's first), sent by the
 * session's widget connection. Never to anything the visitor typed (R-INBOX-5, E154): that is not a point.
 */
async function chatDraftFor(tx: Tx, deps: CommsDeps, contactId: string, toPointId: string | undefined, now: Instant, o: { purpose?: 'marketing' | 'informational' }): Promise<Draft> {
  const routes = await chatRoutes(tx, contactId);
  const route = toPointId ? routes.find((r) => r.pointId === toPointId) : routes[0];
  const point = route ? (await g.contactPoints(tx, contactId)).find((p) => p.id === route.pointId && p.kind === 'web_chat') : undefined;
  if (!route || !point) throw new AppError('CONTACT_POINT_MISSING');
  const conversationId = await msgs.ensureConversation(tx, deps.ids.next<'ConversationId'>(), contactId, null);
  const conv = await g.conversationOf(tx, contactId);
  const purpose = o.purpose ?? classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now });
  const live = route.sessionOpen && (route.connectionStatus === 'connected' || route.connectionStatus === 'degraded');
  return { point, conversationId, phoneNumberId: null, emailIdentityId: null, fromAddress: `widget:${route.connectionId}`, purpose, inboundSeq: conv?.inboundSeq ?? 0, chat: { connectionId: route.connectionId, live }, numberType: null };
}

function humanIntent(contactId: string, d: Draft, channel: Channel, body: string): OutboundIntent {
  return {
    contactId,
    recipient: { kind: 'contact', addressHmac: d.point.hmac, channel, pointId: d.point.id },
    purpose: d.purpose,
    initiator: 'human',
    category: 'none',
    sender: { phoneNumberId: d.phoneNumberId, emailIdentityId: d.emailIdentityId },
    body,
    connection: chatConnection(d.chat),
  };
}

/** Chat text renders like a text message (brokerage name on marketing); email keeps its footer. */
const renderChannel = (c: 'sms' | 'email' | 'web_chat'): 'sms' | 'email' => (c === 'email' ? 'email' : 'sms');

/** POST /contacts/:id/messages/preview: what the gate would say now (nothing is sent, created or stored). */
export async function previewHumanMessage(actor: UserActor, contactId: string, input: Omit<ComposeInput, 'idempotencyKey' | 'scheduleAt' | 'mediaIds'> & { withMedia?: boolean | undefined }, deps: CommsDeps): Promise<{ decision: DecisionView; body: string; textSender: 'local' | 'toll_free' | null }> {
  // D5a: the same media codes as a send (an empty body is allowed only with media, on 'sms' only)
  const issues = mediaInputIssues({ ...input, mediaIds: input.withMedia ? ['00000000-0000-0000-0000-000000000000'] : [] });
  if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { issues });
  return asUser(deps, actor, async (tx, now) => {
    const c = await detailVisibleContact(tx, contactId);
    if (!c) throw new AppError('NOT_FOUND');
    await refuseMergedAway(tx, c);
    const d = await draftFor(tx, deps, contactId, actor.userId, input.channel, input.toPointId, now);
    const { tenant } = await resolvedPolicy(tx);
    const body = renderHumanBody(input.body, { channel: renderChannel(input.channel), purpose: d.purpose, identity: { brokerageLegalName: tenant.brokerageLegalName, postalAddress: tenant.postalAddress }, unsubscribe: d.purpose === 'marketing' ? '(unsubscribe link)' : null, signature: input.channel === 'email' ? await senderSignature(tx) : null });
    const intent = humanIntent(contactId, d, input.channel, body);
    const evaluated = await evaluateGate(tx, intent, now);
    return { decision: decisionView({ id: null, ...verdictOf(evaluated.decision) }, 'preview'), body, textSender: d.numberType };
  });
}

/** POST /contacts/:id/messages (BUILD_PLAN): GateDecision | Message. */
export async function composeHumanMessage(actor: UserActor, contactId: string, input: ComposeInput, deps: CommsDeps): Promise<ComposeResult> {
  const key = `h:${actor.userId}:${input.idempotencyKey}`;
  type Created = { kind: 'existing'; m: msgs.MessageRow; decision: DecisionView | null } | { kind: 'created'; messageId: string; scheduled: boolean } | { kind: 'blocked'; decision: DecisionView };
  const created: Created = await asUser(deps, actor, async (tx, now) => {
    const prior = await msgs.messageByIdempotencyKey(tx, key);
    if (prior) {
      if (prior.contactId !== contactId) throw new AppError('NOT_FOUND');
      return { kind: 'existing', m: prior, decision: await storedDecisionView(tx, prior.gateDecisionId) };
    }
    const c = await detailVisibleContact(tx, contactId);
    if (!c) throw new AppError('NOT_FOUND');
    // F1: a merged-away record is never a send target (the person lives on the survivor); nothing is created
    await refuseMergedAway(tx, c);
    // D5a (R-MMS-1, E292): the media rules, checked here so HTTP and direct callers get the same codes
    const mediaIds = input.mediaIds ?? [];
    const issues = mediaInputIssues(input);
    if (issues.length > 0) throw new AppError('VALIDATION_FAILED', { issues });
    if (input.channel === 'email' && !(input.subject ?? '').trim()) throw new AppError('SUBJECT_REQUIRED');
    let scheduledFor: Instant | null = null;
    if (input.scheduleAt && input.channel === 'web_chat') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/scheduleAt', code: 'chat_not_scheduled' }] });
    if (input.scheduleAt) {
      scheduledFor = at(input.scheduleAt);
      if (scheduledFor <= now) throw new AppError('SCHEDULE_IN_PAST');
    }
    const d = await draftFor(tx, deps, contactId, actor.userId, input.channel, input.toPointId, now, input.purposeOverride ? { purpose: input.purposeOverride } : {});
    const messageId = deps.ids.next<'MessageId'>();
    const { tenant } = await resolvedPolicy(tx);
    const unsub = input.channel === 'email' && d.purpose === 'marketing' ? unsubscribeUrl(deps.publicBaseUrl, deps.linkSecret, actor.tenantId, messageId) : null;
    const body = renderHumanBody(input.body, { channel: renderChannel(input.channel), purpose: d.purpose, identity: { brokerageLegalName: tenant.brokerageLegalName, postalAddress: tenant.postalAddress }, unsubscribe: unsub, signature: input.channel === 'email' ? await senderSignature(tx) : null });
    // D5a (R-MMS-9): a one-to-one text over 1,600 UTF-16 units is refused; R-MMS-2: media + text ≤ 5,000,000 bytes
    if (textTooLong(input, body)) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/body', code: 'text_too_long' }] });
    if (mediaIds.length > 0 && (await uploadsTotalBytes(tx, contactId, mediaIds)) + Buffer.byteLength(body, 'utf8') > MMS_LIMITS.totalBytes) {
      throw new AppError('MEDIA_TOO_LARGE', { limitBytes: MMS_LIMITS.totalBytes, scope: 'total' });
    }
    if (!d.fromAddress) {
      // No sending number / identity: the send is blocked (SENDER_UNAVAILABLE) and logged; nothing to create.
      const intent = humanIntent(contactId, d, input.channel, body);
      const evaluated = await evaluateGate(tx, intent, now);
      const verdict = verdictOf(evaluated.decision);
      if (verdict.outcome !== 'deny') throw new Error('a send without a sender passed the gate');
      const stored = await insertBlockedDecision(tx, { ids: deps.ids, intent, evaluated, verdict, actorUserId: actor.userId, now });
      return { kind: 'blocked', decision: decisionView(stored, 'send') };
    }
    const inserted = await msgs.insertOutbound(tx, {
      id: messageId,
      conversationId: d.conversationId,
      contactId,
      channel: mediaIds.length > 0 ? 'mms' : input.channel,
      phoneNumberId: d.phoneNumberId,
      emailIdentityId: d.emailIdentityId,
      fromAddress: d.fromAddress,
      toAddress: d.point.address,
      subject: input.channel === 'email' ? (input.subject ?? '').trim().slice(0, 300) : null,
      body,
      status: scheduledFor === null ? 'queued' : 'scheduled',
      scheduledFor,
      initiator: 'human',
      initiatedByUserId: actor.userId,
      purpose: d.purpose,
      actionCategory: 'none',
      assistantActionId: null,
      playbookStepRunId: null,
      pinnedInboundSeq: d.inboundSeq,
      idempotencyKey: key,
      occurredAt: scheduledFor ?? now,
      bulkActionId: input.bulkActionId ?? null,
      integrationConnectionId: d.chat?.connectionId ?? null,
      marketingPieceId: input.marketingPieceId ?? null,
    });
    if (!inserted) {
      // the same command raced in (double tap, network retry): it is that command's message
      const winner = await msgs.messageByIdempotencyKey(tx, key);
      if (!winner || winner.contactId !== contactId) throw new AppError('NOT_FOUND');
      return { kind: 'existing', m: winner, decision: await storedDecisionView(tx, winner.gateDecisionId) };
    }
    if (mediaIds.length > 0) await attachUploadsInTx(tx, { messageId, contactId, mediaIds });
    if (scheduledFor !== null) {
      await enqueueTyped(tx, COMMS_DISPATCH, { messageId }, { dedupeKey: COMMS_DISPATCH.dedupeKey({ messageId }), runAt: scheduledFor });
    }
    return { kind: 'created', messageId, scheduled: scheduledFor !== null };
  });

  if (created.kind === 'blocked') return { message: null, decision: created.decision, result: 'not_created' };
  // An idempotent re-post is the same command and has no new effect (a retry of the original request
  // must never stand in for the human having seen a reply, E27: that re-tap is POST /messages/:id/send). It reports
  // what the first one did: the message as it stands and, when it was blocked, the stored decision (finding F1).
  if (created.kind === 'existing') return { message: messageView(created.m), decision: created.decision, result: 'noop' };
  const messageId = created.messageId;
  if (created.scheduled) return { message: await viewOf(actor, messageId, deps), decision: null, result: 'scheduled' };
  const r = await dispatchOutbound(messageId, deps, { tenantId: actor.tenantId as TenantId, actor });
  return { message: await viewOf(actor, messageId, deps), decision: 'decision' in r ? r.decision : null, result: r.kind };
}

/**
 * POST /messages/:id/send: the human re-taps a waiting message of their own (E27: the client replied
 * since it was scheduled). Nothing is ever "confirmed past" the gate: the send-time check runs again and
 * an opt-out blocks it.
 */
export async function sendExisting(actor: UserActor, messageId: string, deps: CommsDeps): Promise<ComposeResult> {
  await asUser(deps, actor, async (tx) => {
    const m = await msgs.messageById(tx, messageId);
    if (!m || m.initiator !== 'human' || m.initiatedByUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (!(await contactFacts(tx, m.contactId))) throw new AppError('NOT_FOUND');
    if (m.status !== 'queued' && m.status !== 'scheduled') throw new AppError('MESSAGE_NOT_SENDABLE', { status: m.status });
    // the human tap is the audited decision (R-AUDIT-5); what dispatch then does is on the message itself
    await audit(tx, actor, { action: 'message.held_send', entity: { type: 'message', id: m.id }, changes: redactSnapshot({ status: m.status, statusReason: m.statusReason }, { entity: 'message' }), reason: m.statusReason ?? 'RETAP' });
  });
  const r = await dispatchOutbound(messageId, deps, { tenantId: actor.tenantId, actor, retap: true });
  return { message: await viewOf(actor, messageId, deps), decision: 'decision' in r ? r.decision : null, result: r.kind };
}

/** POST /messages/:id/cancel: the sender cancels a scheduled or waiting message. */
export async function cancelMessage(actor: UserActor, messageId: string, deps: CommsDeps): Promise<MessageView> {
  return asUser(deps, actor, async (tx) => {
    const m = await msgs.messageById(tx, messageId);
    if (!m || m.initiator !== 'human' || m.initiatedByUserId !== actor.userId) throw new AppError('NOT_FOUND');
    await lockContact(tx, m.contactId as ContactId);
    const cur = await msgs.lockMessage(tx, messageId);
    if (!cur || (cur.status !== 'queued' && cur.status !== 'scheduled')) throw new AppError('MESSAGE_NOT_SENDABLE', { status: cur?.status ?? 'missing' });
    await msgs.markCanceled(tx, messageId, 'CANCELED_BY_SENDER', null);
    await audit(tx, actor, { action: 'message.held_cancel', entity: { type: 'message', id: messageId }, changes: redactDiff({ status: cur.status }, { status: 'canceled' }, { entity: 'message' }), reason: cur.statusReason ?? 'CANCELED_BY_SENDER' });
    return messageView((await msgs.messageById(tx, messageId))!);
  });
}

async function viewOf(actor: UserActor, messageId: string, deps: CommsDeps): Promise<MessageView | null> {
  return asUser(deps, actor, async (tx) => {
    const m = await msgs.messageById(tx, messageId);
    return m ? messageView(m) : null;
  });
}

// ---- assistant / system messages -----------------------------------------------------------------

export interface QueueSpec {
  contactId: string;
  /** 'web_chat' (module 22): the first response where the lead wrote, or an approved draft (R-INBOX-4) */
  channel: 'sms' | 'email' | 'web_chat';
  body: string;
  subject?: string;
  initiator: 'assistant' | 'system';
  purpose: 'marketing' | 'informational';
  category: OutboundIntent['category'];
  assistantActionId?: string | null;
  playbookStepRunId?: string | null;
  toPointId?: string;
  /** a specific sending number (the opt-out confirmation replies from the number that was texted) */
  phoneNumberId?: string;
  scheduleAt?: Instant;
  /** unique per tenant: the same key never creates a second message */
  idempotencyKey: string;
  firstResponse?: boolean;
}

export type QueueResult = { ok: true; messageId: string; created: boolean } | { ok: false; code: 'CONTACT_POINT_MISSING' | 'SENDER_UNAVAILABLE' | 'CONTACT_MERGED' };

/**
 * Queues an assistant/system message in the caller's (system) transaction and enqueues its comms.dispatch
 * job. Nothing is sent here: the send-time gate decides when the job runs. Idempotent by key. Never to a
 * merged-away record (F1: CONTACT_MERGED, nothing created).
 */
export async function queueOutboundInTx(tx: Tx, deps: Pick<CommsDeps, 'ids'>, spec: QueueSpec, now: Instant): Promise<QueueResult> {
  const prior = await msgs.messageByIdempotencyKey(tx, spec.idempotencyKey);
  if (prior) return { ok: true, messageId: prior.id, created: false };
  if (await mergedAway(tx, spec.contactId)) return { ok: false, code: 'CONTACT_MERGED' };
  let d: Draft;
  try {
    d = await draftFor(tx, deps as CommsDeps, spec.contactId, null, spec.channel, spec.toPointId, now, { purpose: spec.purpose, firstResponse: spec.firstResponse === true, phoneNumberId: spec.phoneNumberId ?? null });
  } catch (e) {
    if (e instanceof AppError && e.code === 'CONTACT_POINT_MISSING') return { ok: false, code: 'CONTACT_POINT_MISSING' };
    throw e;
  }
  if (!d.fromAddress) return { ok: false, code: 'SENDER_UNAVAILABLE' };
  const messageId = deps.ids.next<'MessageId'>();
  const inserted = await msgs.insertOutbound(tx, {
    id: messageId,
    conversationId: d.conversationId,
    contactId: spec.contactId,
    channel: spec.channel,
    phoneNumberId: d.phoneNumberId,
    emailIdentityId: d.emailIdentityId,
    fromAddress: d.fromAddress,
    toAddress: d.point.address,
    subject: spec.channel === 'email' ? (spec.subject ?? '').slice(0, 300) : null,
    body: spec.body,
    status: spec.scheduleAt && spec.scheduleAt > now ? 'scheduled' : 'queued',
    scheduledFor: spec.scheduleAt && spec.scheduleAt > now ? spec.scheduleAt : null,
    initiator: spec.initiator,
    initiatedByUserId: null,
    purpose: spec.purpose,
    actionCategory: spec.category,
    assistantActionId: spec.assistantActionId ?? null,
    playbookStepRunId: spec.playbookStepRunId ?? null,
    pinnedInboundSeq: d.inboundSeq,
    idempotencyKey: spec.idempotencyKey,
    occurredAt: now,
    integrationConnectionId: d.chat?.connectionId ?? null,
  });
  if (!inserted) {
    const winner = await msgs.messageByIdempotencyKey(tx, spec.idempotencyKey);
    if (!winner) throw new Error('idempotency key taken by an invisible message');
    return { ok: true, messageId: winner.id, created: false };
  }
  await enqueueTyped(tx, COMMS_DISPATCH, { messageId }, { dedupeKey: COMMS_DISPATCH.dedupeKey({ messageId }), ...(spec.scheduleAt && spec.scheduleAt > now ? { runAt: spec.scheduleAt } : {}) });
  return { ok: true, messageId, created: true };
}

export type { IdGenerator };
