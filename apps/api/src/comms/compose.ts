// Creating outbound messages (ARCHITECTURE §9 paths 1, 2, 4–8). Creating a message never sends it:
// every send goes through dispatchOutbound's send-time gate.
//
// - composeHumanMessage: an agent's text/email from the contact, feed or thread. Immediate ⇒ queued and
//   dispatched in the request (TX1 runs as the agent); scheduled ⇒ 'scheduled' + a comms.dispatch job at
//   that instant, re-gated then (and it needs a re-tap if the client replied since, E27).
// - previewHumanMessage: the compose-time preview (phase 'preview'; only a blocking preview is stored).
// - queueOutboundInTx: for assistant/system senders (api/assistant playbook steps, first response, search
//   alerts; comms' own opt-out confirmation / HELP reply), in the caller's system transaction.
import { type Channel, type NumberFacts, chooseSender, classifyHumanPurpose } from '@realty/core/compliance';
import type { ContactId, IdGenerator, Instant, TenantId, UserActor } from '@realty/core/foundation';
import { at, toIso } from '@realty/core/foundation';
import { type Tx, lockContact } from '@realty/db';
import { AppError } from '../errors.js';
import { COMMS_DISPATCH } from '../worker/contracts.js';
import { enqueueTyped } from '../worker/registry.js';
import { dispatchOutbound } from './dispatch.js';
import { decisionView, evaluateGate, insertDecision, resolvedPolicy } from './gateInput.js';
import { renderHumanBody, unsubscribeUrl } from './render.js';
import { contactFacts, dealOrAppointmentContext, detailVisibleContact } from './repos/contacts.js';
import * as g from './repos/gate.js';
import { actionFacts } from './repos/automation.js';
import * as msgs from './repos/messages.js';
import { asUser } from './runtime.js';
import type { CommsDeps, DecisionView, DispatchResult, OutboundIntent } from './types.js';

export interface ComposeInput {
  channel: 'sms' | 'email';
  body: string;
  subject?: string | undefined;
  scheduleAt?: string | undefined;
  idempotencyKey: string;
  toPointId?: string | undefined;
  confirmDecisionId?: string | undefined;
}

export interface MessageView {
  id: string;
  channel: 'sms' | 'mms' | 'email';
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
  const kind = channel === 'email' ? 'email' : 'phone';
  if (toPointId) return points.find((p) => p.id === toPointId && p.kind === kind) ?? null;
  return points.find((p) => p.kind === kind && p.status === 'active') ?? points.find((p) => p.kind === kind) ?? null;
}

async function draftFor(tx: Tx, deps: CommsDeps, contactId: string, userId: string | null, channel: 'sms' | 'email', toPointId: string | undefined, now: Instant, o: { firstResponse?: boolean; purpose?: 'marketing' | 'informational'; phoneNumberId?: string | null } = {}): Promise<Draft> {
  const point = pickPoint(await g.contactPoints(tx, contactId), channel, toPointId);
  if (!point) throw new AppError('CONTACT_POINT_MISSING');
  const conversationId = await msgs.ensureConversation(tx, deps.ids.next<'ConversationId'>(), contactId, null);
  const conv = await g.conversationOf(tx, contactId);
  let phoneNumberId: string | null = null;
  let emailIdentityId: string | null = null;
  let fromAddress: string | null = null;
  if (channel === 'sms') {
    const n = o.phoneNumberId ? await g.numberFacts(tx, o.phoneNumberId) : await chooseNumber(tx, conv, userId, o.firstResponse === true);
    if (n) {
      phoneNumberId = n.id;
      fromAddress = n.e164;
    }
  } else {
    emailIdentityId = await g.chooseEmailIdentity(tx, userId);
    if (emailIdentityId) fromAddress = (await g.emailIdentityFacts(tx, emailIdentityId))?.fromAddress ?? null;
  }
  const purpose = o.purpose ?? classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now });
  return { point, conversationId, phoneNumberId, emailIdentityId, fromAddress, purpose, inboundSeq: conv?.inboundSeq ?? 0 };
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
  };
}

/** POST /contacts/:id/messages/preview: what the gate would say now (nothing is sent or created). */
export async function previewHumanMessage(actor: UserActor, contactId: string, input: Omit<ComposeInput, 'idempotencyKey' | 'scheduleAt' | 'confirmDecisionId'>, deps: CommsDeps): Promise<{ decision: DecisionView; body: string }> {
  return asUser(deps, actor, async (tx, now) => {
    if (!(await detailVisibleContact(tx, contactId))) throw new AppError('NOT_FOUND');
    const d = await draftFor(tx, deps, contactId, actor.userId, input.channel, input.toPointId, now);
    const { tenant } = await resolvedPolicy(tx);
    const body = renderHumanBody(input.body, { channel: input.channel, purpose: d.purpose, identity: { brokerageLegalName: tenant.brokerageLegalName, postalAddress: tenant.postalAddress }, unsubscribe: d.purpose === 'marketing' ? '(unsubscribe link)' : null });
    const intent = humanIntent(contactId, d, input.channel, body);
    const evaluated = await evaluateGate(tx, intent, now);
    if (evaluated.decision.outcome === 'allow') {
      return { decision: { id: null, outcome: 'allow', reasons: [...evaluated.decision.reasons], explanation: evaluated.decision.explanation, deferUntil: null, canConfirm: false, phase: 'preview' }, body };
    }
    const stored = await insertDecision(tx, { ids: deps.ids, intent, evaluated, phase: 'preview', actorUserId: actor.userId, now });
    return { decision: decisionView(stored, 'preview'), body };
  });
}

/** POST /contacts/:id/messages (BUILD_PLAN): GateDecision | Message. */
export async function composeHumanMessage(actor: UserActor, contactId: string, input: ComposeInput, deps: CommsDeps): Promise<ComposeResult> {
  const key = `h:${actor.userId}:${input.idempotencyKey}`;
  type Created = { kind: 'existing'; m: msgs.MessageRow } | { kind: 'created'; messageId: string; scheduled: boolean } | { kind: 'blocked'; decision: DecisionView };
  const created: Created = await asUser(deps, actor, async (tx, now) => {
    const prior = await msgs.messageByIdempotencyKey(tx, key);
    if (prior) {
      if (prior.contactId !== contactId) throw new AppError('NOT_FOUND');
      return { kind: 'existing', m: prior };
    }
    if (!(await detailVisibleContact(tx, contactId))) throw new AppError('NOT_FOUND');
    if (input.channel === 'email' && !(input.subject ?? '').trim()) throw new AppError('SUBJECT_REQUIRED');
    let scheduledFor: Instant | null = null;
    if (input.scheduleAt) {
      scheduledFor = at(input.scheduleAt);
      if (scheduledFor <= now) throw new AppError('SCHEDULE_IN_PAST');
    }
    const d = await draftFor(tx, deps, contactId, actor.userId, input.channel, input.toPointId, now);
    const messageId = deps.ids.next<'MessageId'>();
    const { tenant } = await resolvedPolicy(tx);
    const unsub = input.channel === 'email' && d.purpose === 'marketing' ? unsubscribeUrl(deps.publicBaseUrl, deps.linkSecret, actor.tenantId, messageId) : null;
    const body = renderHumanBody(input.body, { channel: input.channel, purpose: d.purpose, identity: { brokerageLegalName: tenant.brokerageLegalName, postalAddress: tenant.postalAddress }, unsubscribe: unsub });
    if (!d.fromAddress) {
      // No sending number / identity: the gate says why (SENDER_UNAVAILABLE); nothing to create.
      const intent = humanIntent(contactId, d, input.channel, body);
      const evaluated = await evaluateGate(tx, intent, now);
      const stored = await insertDecision(tx, { ids: deps.ids, intent, evaluated, phase: 'preview', actorUserId: actor.userId, now });
      return { kind: 'blocked', decision: decisionView(stored, 'preview') };
    }
    const inserted = await msgs.insertOutbound(tx, {
      id: messageId,
      conversationId: d.conversationId,
      contactId,
      channel: input.channel,
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
    });
    if (!inserted) {
      // the same command raced in (double tap, network retry): it is that command's message
      const winner = await msgs.messageByIdempotencyKey(tx, key);
      if (!winner || winner.contactId !== contactId) throw new AppError('NOT_FOUND');
      return { kind: 'existing', m: winner };
    }
    if (scheduledFor !== null) {
      await enqueueTyped(tx, COMMS_DISPATCH, { messageId }, { dedupeKey: COMMS_DISPATCH.dedupeKey({ messageId }), runAt: scheduledFor });
    }
    return { kind: 'created', messageId, scheduled: scheduledFor !== null };
  });

  if (created.kind === 'blocked') return { message: null, decision: created.decision, result: 'not_created' };
  const tenantId = actor.tenantId as TenantId;
  let messageId: string;
  if (created.kind === 'existing') {
    messageId = created.m.id;
    // An idempotent re-post is the same command and has no new effect (a retry of the original request
    // must never stand in for the human having seen a reply, E27: that re-tap is POST /messages/:id/send).
    // Only an explicit confirmation of a decision the human was shown does something new.
    if (!(created.m.status === 'queued' && input.confirmDecisionId)) {
      return { message: messageView(created.m), decision: null, result: 'noop' };
    }
  } else {
    messageId = created.messageId;
    if (created.scheduled) return { message: await viewOf(actor, messageId, deps), decision: null, result: 'scheduled' };
  }
  const r = await dispatchOutbound(messageId, deps, {
    tenantId,
    actor,
    ...(input.confirmDecisionId ? { confirm: { decisionId: input.confirmDecisionId, byUserId: actor.userId } } : {}),
    ...(created.kind === 'existing' ? { retap: true } : {}),
  });
  return { message: await viewOf(actor, messageId, deps), decision: 'decision' in r ? r.decision : null, result: r.kind };
}

/**
 * POST /messages/:id/send: the human re-taps a waiting message (E27) or confirms a decision. An approved
 * assistant draft is sent with its approver as the sender (ARCHITECTURE §9 path 4), so when its send-time
 * decision needs confirmation, that approver (and only they) confirms it here; its TX1 stays a system
 * transaction and the confirm decision records the approver.
 */
export async function sendExisting(actor: UserActor, messageId: string, confirmDecisionId: string | undefined, deps: CommsDeps): Promise<ComposeResult> {
  const kind = await asUser(deps, actor, async (tx) => {
    const m = await msgs.messageById(tx, messageId);
    if (!m) throw new AppError('NOT_FOUND');
    let k: 'human' | 'approved_draft';
    if (m.initiator === 'human' && m.initiatedByUserId === actor.userId) k = 'human';
    else if (m.initiator === 'assistant' && m.assistantActionId && confirmDecisionId) {
      const a = await actionFacts(tx, m.assistantActionId);
      if (!a || a.autonomy !== 'requires_approval' || a.status !== 'approved' || a.decidedByUserId !== actor.userId) throw new AppError('NOT_FOUND');
      k = 'approved_draft';
    } else throw new AppError('NOT_FOUND');
    if (!(await contactFacts(tx, m.contactId))) throw new AppError('NOT_FOUND');
    if (m.status !== 'queued' && m.status !== 'scheduled') throw new AppError('MESSAGE_NOT_SENDABLE', { status: m.status });
    return k;
  });
  if (kind === 'approved_draft') {
    const r = await dispatchOutbound(messageId, deps, { tenantId: actor.tenantId, confirm: { decisionId: confirmDecisionId!, byUserId: actor.userId } });
    return { message: await viewOf(actor, messageId, deps), decision: 'decision' in r ? r.decision : null, result: r.kind };
  }
  const r = await dispatchOutbound(messageId, deps, {
    tenantId: actor.tenantId,
    actor,
    retap: true,
    ...(confirmDecisionId ? { confirm: { decisionId: confirmDecisionId, byUserId: actor.userId } } : {}),
  });
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
  channel: 'sms' | 'email';
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

export type QueueResult = { ok: true; messageId: string; created: boolean } | { ok: false; code: 'CONTACT_POINT_MISSING' | 'SENDER_UNAVAILABLE' };

/**
 * Queues an assistant/system message in the caller's (system) transaction and enqueues its comms.dispatch
 * job. Nothing is sent here: the send-time gate decides when the job runs. Idempotent by key.
 */
export async function queueOutboundInTx(tx: Tx, deps: Pick<CommsDeps, 'ids'>, spec: QueueSpec, now: Instant): Promise<QueueResult> {
  const prior = await msgs.messageByIdempotencyKey(tx, spec.idempotencyKey);
  if (prior) return { ok: true, messageId: prior.id, created: false };
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
