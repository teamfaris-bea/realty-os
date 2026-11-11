// dispatchOutbound: THE outbound message path (ARCHITECTURE §9; R-GATE-2, -4, -7, -8, R-OWN-14, E7, E15,
// E22, E27, E46, E60, E66; core-compliance/2.0.0). With dial.ts it is the only module allowed to call a
// provider send (lint realty/no-provider-outbound + architecture.test.ts).
//
//   TX1  app.lock_contact → message FOR UPDATE (scheduled|queued, else no-op) → DB clock
//        re-read: pause, the client's replies since a human scheduled it (E27), the sender's authority
//        for this contact NOW (E15), the assistant approval / playbook approval + live enrollment +
//        the agent playbook still belonging to the contact owner, core.authorizeAutonomousAction,
//        opt-outs (STOP / unsubscribe / do-not-contact, no override), suppressions, registration →
//        core.canContact (allow | deny)
//        allow ⇒ 'dispatching' + dispatched_at (DB CHECK; the dispatch guard re-checks the opt-out and
//                the assistant autonomy); nothing is written to gate_decisions;
//                human owner/collaborator ⇒ the touch in THIS transaction (R-OWN-14, E66)
//        deny  ⇒ INSERT gate_decisions (the blocked-send evidence) + 'blocked' with the reason
//        guard refuses an allowed send about its recipient (RECIPIENT_OPTED_OUT, PERSON_DO_NOT_CONTACT,
//                RECIPIENT_SUPPRESSED, RECIPIENT_NOT_A_CONTACT_POINT: gateInput.ts GUARD_DENY_REASONS;
//                canContact reads the guard's own facts, so this is defence in depth) ⇒ TX1 rolls back whole
//                and runs again in a NEW transaction with the guard's code as a deny: recorded as above,
//                answered as blocked, never sent, never retried, never a 500
//   provider.send(idempotencyKey = message.id)        (never inside a transaction)
//        web chat (module 22): the transport's deliverChannelMessage (reserved name: only this file calls it,
//        R-GATE-15), through the session's widget connection; a closed session or a widget that is not connected is
//        CHANNEL_NOT_CONNECTED in TX1 (core check 10; R-INBOX-7, E77)
//   TX2  'sent' + provider ref | 'failed' | timeout ⇒ 'dispatch_unknown' + comms.reconcile (never resent)
//        email (module 22, R-GMAIL-12): TX2, as the SYSTEM, stores the hash of the Message-ID the provider confirmed
//        (messages.rfc_message_id_sha256; the messages_rfc_guard trigger refuses it from TX1, which runs as the person)
//
// Who runs TX1 (R-TEN-3): the session user for an in-request human send; for a human message the
// worker sends later, that human (rebuilt from the message row while the membership is active, so RLS
// re-decides visibility at send time); the system actor for assistant and system messages. When the
// human can no longer see the message (lost the lead), a system TX1 blocks it with
// SENDER_NOT_AUTHORIZED and offers the text to the new owner as a draft (E15).
import { ALWAYS_HUMAN_CATEGORIES, type Channel, type Initiator, type Purpose, classifyHumanPurpose } from '@realty/core/compliance';
import { INTENT_RULES, type PlaybookStep, PlaybookStepSchema, approvalCurrent, authorizeAutonomousAction, stepForChannel, stepRunAfterGate, storedTriggerStep, triggerStepAsPlaybookStep } from '@realty/core/assistant';
import type { Actor, ContactId, Instant, TenantId, UserActor } from '@realty/core/foundation';
import { MINUTE_MS, can, plusMs } from '@realty/core/foundation';
import { type Tx, applyOwnershipCommandInTx, dbNow, derivedCommandId, lockContact, recordConsentEvent, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { COMMS_RECONCILE } from '../worker/contracts.js';
import { enqueueTyped } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { type DispatchDenyReason, type StoredDecision, decisionView, evaluateGate, guardOptOutRefusal, insertBlockedDecision, resolvedPolicy, verdictOf } from './gateInput.js';
import { EMAIL_REF_HEADER, listUnsubscribeHeaders, replyAddress, replyToken, replyTokenHash, signedRef, unsubscribeUrl } from './render.js';
import * as auto from './repos/automation.js';
import { contactFacts, dealOrAppointmentContext } from './repos/contacts.js';
import { telephonyAccount } from './repos/credentials.js';
import * as g from './repos/gate.js';
import * as msgs from './repos/messages.js';
import { notifyUser } from './repos/notify.js';
import { asSystem, senderActor } from './runtime.js';
import { routeOfAddress } from '../channels/repos/webchat.js';
import { rfcMessageIdSha256 } from '../channels/rfcMessageId.js';
import { LEDGER_SYSTEM, SYSTEM_NOTICE, type CommsDeps, type DispatchResult, type OutboundIntent } from './types.js';

export interface DispatchOptions {
  /** the message's tenant (from the session, a job row or a webhook resolver; R-TEN-3) */
  tenantId: string;
  /** the session user of an in-request human send */
  actor?: UserActor;
  /** the human re-tapped a scheduled message after the client replied (E27) */
  retap?: boolean;
}

interface SendPlan {
  m: msgs.MessageRow;
  channel: 'sms' | 'email' | 'web_chat';
  emailFrom: { address: string; name: string } | null;
  replyTo: string | null;
  headers: Record<string, string> | null;
}

type Tx1 = { kind: 'done'; result: DispatchResult } | { kind: 'invisible' } | { kind: 'send'; plan: SendPlan; decision: StoredDecision };

interface Tx1Context {
  deps: CommsDeps;
  tenantId: string;
  actor: Actor;
  opts: DispatchOptions;
  forceDeny: DispatchDenyReason[];
}

const MAX_RECONCILE_MS = 10 * MINUTE_MS;

/** BUILD_PLAN interface (tenant and caller made explicit; reported as a spec correction). */
export async function dispatchOutbound(messageId: string, deps: CommsDeps, opts: DispatchOptions): Promise<DispatchResult> {
  const tenantId = opts.tenantId;
  let actor: Actor;
  const forceDeny: DispatchDenyReason[] = [];
  const pre = await asSystem(deps, tenantId, 'worker', async (tx) => {
    const m = await msgs.messageById(tx, messageId);
    if (!m) return null;
    const ua = m.initiator === 'human' && m.initiatedByUserId && !opts.actor ? await senderActor(tx, tenantId, m.initiatedByUserId, m.id) : null;
    return { m, ua };
  });
  if (!pre) return { kind: 'noop', messageId, status: 'missing' };
  if (pre.m.initiator === 'human') {
    if (opts.actor) actor = opts.actor;
    else if (pre.ua) actor = pre.ua;
    else {
      actor = systemActor(tenantId, 'worker');
      forceDeny.push('SENDER_NOT_AUTHORIZED');
    }
  } else actor = systemActor(tenantId, pre.m.initiator === 'assistant' ? 'assistant' : 'worker');

  // Defence in depth (R-PAR-12, D1): the guard should never refuse a send TX1 allowed. When it does, the
  // error has already rolled TX1 back (no dispatching row, no touch, nothing half-written) and that
  // transaction is gone; TX1 runs once more, in a fresh transaction, with the guard's code as a deny
  // reason, so it is blocked and recorded exactly like a canContact deny. That run cannot dispatch (its
  // verdict is a deny), so nothing is retried. Any other error is not a block and propagates.
  const guardDeny: DispatchDenyReason[] = [];
  const run = async (a: Actor, deny: DispatchDenyReason[]): Promise<Tx1> => {
    const once = () => withTenantTx(a, (tx, now) => tx1(tx, now, { deps, tenantId, actor: a, opts, forceDeny: [...deny, ...guardDeny] }, messageId), { db: deps.db, retries: 2 });
    try {
      return await once();
    } catch (e) {
      const refused = guardOptOutRefusal(e);
      if (refused === null || guardDeny.includes(refused)) throw e;
      guardDeny.push(refused);
      return once();
    }
  };
  let r = await run(actor, forceDeny);
  if (r.kind === 'invisible') {
    if (actor.kind !== 'user') return { kind: 'noop', messageId, status: 'missing' };
    // The human lost sight of the contact (reassigned / released, E15 / E66): the system blocks it.
    r = await run(systemActor(tenantId, 'worker'), ['SENDER_NOT_AUTHORIZED']);
    if (r.kind === 'invisible') return { kind: 'noop', messageId, status: 'missing' };
  }
  if (r.kind === 'done') return r.result;
  return sendAndRecord(r.plan, r.decision, deps, tenantId);
}

async function tx1(tx: Tx, txNow: Instant, c: Tx1Context, messageId: string): Promise<Tx1> {
  void txNow;
  const peek = await msgs.messageById(tx, messageId);
  if (!peek) return { kind: 'invisible' };
  await lockContact(tx, peek.contactId as ContactId);
  const m = await msgs.lockMessage(tx, messageId);
  if (!m) return { kind: 'invisible' };
  if (m.direction !== 'outbound' || m.imported || (m.status !== 'scheduled' && m.status !== 'queued')) return { kind: 'done', result: { kind: 'noop', messageId, status: m.status } };
  const now = await dbNow(tx);
  const human = m.initiator === 'human';
  const userTx = c.actor.kind === 'user';
  if (userTx && (!human || m.initiatedByUserId !== (c.actor as UserActor).userId)) throw new AppError('NOT_FOUND');
  if (m.status === 'scheduled' && m.scheduledFor !== null && m.scheduledFor > now && !c.opts.retap) return { kind: 'done', result: { kind: 'not_due', messageId, due: m.scheduledFor } };

  const conv = await g.conversationOf(tx, m.contactId);
  // E27: the client replied after a human scheduled this: it needs a re-tap (never auto-cancelled)
  if (human && c.forceDeny.length === 0 && !c.opts.retap && m.pinnedInboundSeq !== null && conv && conv.inboundSeq > m.pinnedInboundSeq) {
    await msgs.markAwaitingTap(tx, m.id, 'CLIENT_REPLIED_SINCE_SCHEDULED', null);
    if (!userTx && m.initiatedByUserId) {
      await notifyUser(tx, c.deps.ids, { userId: m.initiatedByUserId, kind: SYSTEM_NOTICE, priority: 'high', title: 'They replied since you scheduled a message', body: 'Check the reply, then tap Send if it still fits.', subjectType: 'message', subjectId: m.id, dedupeKey: `retap:${m.id}:${conv.inboundSeq}` }, now);
    }
    return { kind: 'done', result: { kind: 'needs_retap', messageId, reason: 'CLIENT_REPLIED_SINCE_SCHEDULED' } };
  }
  if (human && c.opts.retap && conv) await msgs.repin(tx, m.id, conv.inboundSeq);

  const channel: Channel = m.channel === 'email' ? 'email' : m.channel === 'web_chat' ? 'web_chat' : 'sms';
  // Purpose of a human free-form message, decided NOW (send-time inputs): it was informational when
  // written because the contact had written in within 30 days (or a deal/appointment was open); days
  // later that may no longer hold. Only ever tightened: informational → marketing (marketing adds the
  // brokerage-name / CAN-SPAM requirements and is what a marketing-only opt-out blocks).
  let purpose: Purpose = m.purpose ?? 'marketing';
  if (human && m.actionCategory === 'none' && purpose === 'informational') {
    const nowPurpose = classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, m.contactId), now });
    if (nowPurpose === 'marketing') {
      purpose = 'marketing';
      await msgs.setPurpose(tx, m.id, 'marketing');
    }
  }
  const env = c.deps.envelope.inTx(tx, c.tenantId as TenantId);
  const addressHmac = Buffer.from(await env.hmacAddress(c.tenantId as TenantId, m.toAddress)).toString('hex');
  const pointKind = channel === 'email' ? 'email' : channel === 'web_chat' ? 'web_chat' : 'phone';
  const point = (await g.contactPoints(tx, m.contactId)).find((p) => p.kind === pointKind && p.address === m.toAddress) ?? null;
  // web chat (module 22): the widget this message goes through, and whether its session can take it NOW
  let chatConnection: OutboundIntent['connection'] = null;
  if (channel === 'web_chat') {
    const route = await routeOfAddress(tx, m.contactId, m.toAddress);
    const live = route !== null && route.connectionId === m.integrationConnectionId && route.sessionOpen && (route.connectionStatus === 'connected' || route.connectionStatus === 'degraded');
    chatConnection = { status: live ? 'connected' : 'other' };
  }
  const owner = await contactOwnership(tx, m.contactId);
  const { policy, tenant } = await resolvedPolicy(tx);

  // ---- dispatch-time authorization (beyond canContact) ----
  const extra: DispatchDenyReason[] = [...c.forceDeny];
  let gateInitiator: Initiator = 'system';
  let actorUserId: string | null = null;
  let touch = false;
  if (human) {
    gateInitiator = 'human';
    actorUserId = m.initiatedByUserId;
    if (userTx) {
      const facts = await contactFacts(tx, m.contactId);
      const ok = facts !== null && can(c.actor, 'comms.send', { ...facts, purpose }).ok;
      if (!ok && !extra.includes('SENDER_NOT_AUTHORIZED')) extra.push('SENDER_NOT_AUTHORIZED');
      // parity module 63 (R-PAR-37): a bulk send is never a touch. Web chat: core's touch has no chat `via` yet
      // (lane gap), so a chat reply is not recorded as a touch rather than mislabelled as a text.
      touch = ok && facts !== null && (facts.own === true || facts.collaborator === true) && m.bulkActionId === null && channel !== 'web_chat';
    }
  } else if (m.initiator === 'assistant') {
    const a = m.assistantActionId ? await auto.actionFacts(tx, m.assistantActionId) : null;
    if (!a) extra.push('ASSISTANT_ACTION_NOT_APPROVED');
    else if (a.autonomy === 'requires_approval') {
      // An approved draft or handback reply: the approving human is the sender (ARCHITECTURE §9 path 4).
      gateInitiator = 'human';
      actorUserId = a.decidedByUserId;
      if (a.status !== 'approved' || a.decidedByUserId === null) extra.push('ASSISTANT_ACTION_NOT_APPROVED');
      else if (a.ownerUserId !== owner.ownerUserId || a.boundOwnershipSeq !== owner.periodSeq) extra.push('ASSISTANT_ACTION_STALE');
    } else if (a.autonomy === 'within_playbook') {
      gateInitiator = 'assistant';
      extra.push(...(await playbookReasons(tx, m, a, owner, channel, policy.autonomous, tenant, conv?.id ?? null)));
    } else extra.push('ASSISTANT_ACTION_NOT_APPROVED');
  }

  const intent: OutboundIntent = {
    contactId: m.contactId,
    recipient: { kind: 'contact', addressHmac, channel, pointId: point?.id ?? null },
    purpose,
    initiator: gateInitiator,
    category: m.actionCategory as OutboundIntent['category'],
    sender: { phoneNumberId: m.phoneNumberId, emailIdentityId: m.emailIdentityId },
    body: m.body,
    connection: chatConnection,
  };
  const evaluated = await evaluateGate(tx, intent, now);
  const verdict = verdictOf(evaluated.decision, extra);

  if (verdict.outcome === 'deny') {
    const blocked = await insertBlockedDecision(tx, { ids: c.deps.ids, intent, evaluated, verdict, actorUserId, messageId: m.id, now, extraDeny: extra });
    await msgs.markBlocked(tx, m.id, blocked.id, blocked.reasons[0] ?? 'DENIED');
    if (m.playbookStepRunId) {
      const u = stepRunAfterGate({ outcome: 'deny', reasons: blocked.reasons as never });
      await auto.updateStepRun(tx, m.playbookStepRunId, { status: u.status, decisionId: blocked.id, messageId: m.id });
    }
    if (!userTx) await afterSystemBlock(tx, c, m, owner, blocked, now);
    return { kind: 'done', result: { kind: 'blocked', messageId, decision: decisionView(blocked, 'send') } };
  }

  // allow
  let dispatchedAt = now;
  if (touch && userTx) {
    // R-OWN-14 / E66: the touch commits with TX1, under the same contact lock as auto_release / breach;
    // the message's dispatched_at is the touch instant the engine recorded (one instant for both).
    await applyOwnershipCommandInTx(tx, c.actor, m.contactId as ContactId, { kind: 'touch', via: channel === 'email' ? 'email' : 'sms', refId: m.id, at: now }, { commandId: derivedCommandId('comms.touch', m.id), ids: c.deps.ids });
    await setOwnershipCommand(tx, null);
    const t = await sql<{ at: Date | null }>`SELECT last_human_touch_at AS at FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${m.contactId}`.execute(tx);
    if (t.rows[0]?.at && t.rows[0].at.getTime() >= now) dispatchedAt = t.rows[0].at.getTime() as Instant;
  }
  await msgs.markDispatching(tx, m.id, dispatchedAt);
  await msgs.touchConversationOutbound(tx, m.conversationId, m.phoneNumberId, dispatchedAt);
  let emailFrom: SendPlan['emailFrom'] = null;
  let replyTo: string | null = null;
  let headers: Record<string, string> | null = null;
  if (channel === 'email') {
    const ident = m.emailIdentityId ? await g.emailIdentityFacts(tx, m.emailIdentityId) : null;
    if (ident) emailFrom = { address: ident.fromAddress, name: ident.displayName };
    const token = replyToken(c.deps.linkSecret, c.tenantId, m.conversationId);
    await msgs.setReplyTokenIfMissing(tx, m.conversationId, replyTokenHash(token));
    replyTo = replyAddress(c.deps.publicBaseUrl, token);
    headers = { [EMAIL_REF_HEADER]: signedRef(c.deps.linkSecret, 'email-ref', c.tenantId, m.id) };
    if (purpose === 'marketing') headers = { ...headers, ...listUnsubscribeHeaders(unsubscribeUrl(c.deps.publicBaseUrl, c.deps.linkSecret, c.tenantId, m.id)) };
  }
  return { kind: 'send', plan: { m: { ...m, status: 'dispatching', dispatchedAt }, channel: channel === 'email' ? 'email' : channel === 'web_chat' ? 'web_chat' : 'sms', emailFrom, replyTo, headers }, decision: { id: null, ...verdict } };
}

async function contactOwnership(tx: Tx, contactId: string): Promise<{ ownerUserId: string | null; periodSeq: number | null }> {
  const r = await sql<{ owner_user_id: string | null; ownership_period_seq: string | null }>`
    SELECT owner_user_id, ownership_period_seq FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const x = r.rows[0];
  return { ownerUserId: x?.owner_user_id ?? null, periodSeq: x?.ownership_period_seq == null ? null : Number(x.ownership_period_seq) };
}

/** Within-playbook assistant messages (R-GATE-4, R-AST-4): approval, live enrollment, owner, autonomy. */
async function playbookReasons(
  tx: Tx,
  m: msgs.MessageRow,
  a: auto.ActionFacts,
  owner: { ownerUserId: string | null },
  channel: Channel,
  autonomous: ReadonlySet<string>,
  tenant: g.TenantFacts,
  conversationId: string | null,
): Promise<DispatchDenyReason[]> {
  const pb = a.playbookVersionId ? await auto.playbookFacts(tx, a.playbookVersionId) : null;
  if (!pb || !approvalCurrent({ status: pb.versionStatus, contentSha256: pb.contentSha256 }, pb.latestApproval)) return ['PLAYBOOK_NOT_APPROVED'];
  const out: DispatchDenyReason[] = [];
  // an agent playbook speaks for its agent: it never messages a contact that agent no longer owns
  if (pb.scope === 'agent' && pb.ownerUserId !== owner.ownerUserId) out.push('PLAYBOOK_OWNER_NOT_CONTACT_OWNER');
  const run = m.playbookStepRunId ? await auto.stepRunFacts(tx, m.playbookStepRunId) : null;
  let parsedStep: PlaybookStep | null;
  if (run !== null && run.enrollmentId === null) {
    // module 26 (flagged, additive; R-NURT-1): a trigger firing has no enrollment. It sends only while its run is
    // still scheduled (inbound ingestion cancels it, R-NURT-5) and only as its step of the approved trigger content.
    if (run.status !== 'scheduled') return [...out, 'ENROLLMENT_NOT_ACTIVE'];
    const t = storedTriggerStep(pb.steps, run.stepKey);
    parsedStep = t === null ? null : triggerStepAsPlaybookStep(t);
  } else {
    if (!run || run.enrollmentState !== 'active') return [...out, 'ENROLLMENT_NOT_ACTIVE'];
    const raw = (Array.isArray(pb.steps) ? pb.steps : []).find((s) => (s as { stepKey?: string }).stepKey === run.stepKey);
    const parsed = raw === undefined ? null : PlaybookStepSchema.safeParse(raw);
    parsedStep = parsed?.success ? parsed.data : null;
  }
  if (parsedStep === null) return [...out, 'AUTONOMY_DOWNGRADED'];
  const step = stepForChannel(parsedStep, channel === 'email' ? 'email' : channel === 'web_chat' ? 'web_chat' : 'sms') ?? parsedStep;
  if (ALWAYS_HUMAN_CATEGORIES.has(m.actionCategory as never)) return [...out, 'AUTONOMY_DOWNGRADED'];
  const first = conversationId === null ? true : !(await msgs.hasPriorOutbound(tx, conversationId, m.id));
  const verdict = authorizeAutonomousAction({
    category: m.actionCategory as never,
    playbookVersion: { status: pb.versionStatus, contentSha256: pb.contentSha256 },
    latestApproval: pb.latestApproval,
    tenantAutonomous: autonomous as never,
    step,
    rendered: m.body,
    intentCheck: INTENT_RULES[step.intent].purpose === m.purpose ? 'match' : 'mismatch',
    identity: { brokerageLegalName: tenant.brokerageLegalName, teamName: tenant.teamName ?? tenant.brokerageLegalName, agentFirstName: pb.ownerFirstName, scope: pb.scope, allowedLinkHosts: [], brokeragePostalAddress: tenant.postalAddress },
    firstInThread: first,
  });
  if (!verdict.allow) out.push('AUTONOMY_DOWNGRADED');
  return out;
}

/** After a worker-side block: tell the sender, and offer an old owner's blocked text to the new owner (E15). */
async function afterSystemBlock(tx: Tx, c: Tx1Context, m: msgs.MessageRow, owner: { ownerUserId: string | null; periodSeq: number | null }, d: StoredDecision, now: Instant): Promise<void> {
  const notifyId = m.initiatedByUserId;
  if (notifyId) {
    await notifyUser(tx, c.deps.ids, { userId: notifyId, kind: SYSTEM_NOTICE, priority: 'normal', title: 'A scheduled message was not sent', body: d.explanation.slice(0, 240), subjectType: 'message', subjectId: m.id, dedupeKey: `blocked:${m.id}` }, now);
  }
  if (m.initiator === 'human' && d.reasons.includes('SENDER_NOT_AUTHORIZED') && owner.ownerUserId && owner.ownerUserId !== m.initiatedByUserId) {
    await auto.insertSuggestedDraft(tx, { id: c.deps.ids.next<'AssistantActionId'>(), contactId: m.contactId, ownerUserId: owner.ownerUserId, body: m.body, channel: m.channel, boundOwnershipSeq: owner.periodSeq, dedupeKey: `blocked_draft:${m.id}`, fromMessageId: m.id });
  }
}

type SendOutcome = { ok: true; provider: 'telephony' | 'email' | 'web_chat'; ref: string; rfcMessageId?: string } | { ok: false; kind: ProviderError['kind']; code: string | null };

async function providerSend(plan: SendPlan, deps: CommsDeps, tenantId: string): Promise<SendOutcome> {
  const m = plan.m;
  try {
    if (plan.channel === 'sms') {
      const account = await asSystem(deps, tenantId, 'worker', (tx) => telephonyAccount(tx, deps.envelope, tenantId));
      if (!account) return { ok: false, kind: 'not_configured', code: 'TELEPHONY_ACCOUNT_MISSING' };
      const r = await deps.providers.telephony.sendSms({
        account,
        from: m.fromAddress,
        to: m.toAddress,
        body: m.body,
        idempotencyKey: m.id,
        statusCallbackUrl: new URL(`/api/webhooks/telephony/status?m=${m.id}`, deps.publicBaseUrl).toString(),
      });
      return { ok: true, provider: 'telephony', ref: r.providerRef };
    }
    if (plan.channel === 'web_chat') {
      const transport = deps.providers.webChat;
      if (!transport || !m.integrationConnectionId) return { ok: false, kind: 'not_configured', code: 'WEBCHAT_NOT_CONFIGURED' };
      const r = await transport.deliverChannelMessage({ connectionId: m.integrationConnectionId, toAddress: m.toAddress, messageId: m.id, body: m.body });
      return { ok: true, provider: 'web_chat', ref: r.providerRef };
    }
    if (!plan.emailFrom) return { ok: false, kind: 'not_configured', code: 'EMAIL_IDENTITY_MISSING' };
    const r = await deps.providers.email.sendEmail({
      from: plan.emailFrom,
      to: m.toAddress,
      ...(plan.replyTo ? { replyTo: plan.replyTo } : {}),
      subject: m.subject ?? '',
      text: m.body,
      ...(plan.headers ? { headers: plan.headers } : {}),
      idempotencyKey: m.id,
    });
    return { ok: true, provider: 'email', ref: r.providerRef, ...(r.rfcMessageId ? { rfcMessageId: r.rfcMessageId } : {}) };
  } catch (e) {
    if (e instanceof ProviderError) return { ok: false, kind: e.kind, code: e.providerCode ?? null };
    return { ok: false, kind: 'timeout', code: 'UNEXPECTED_ERROR' }; // unknown whether it left: reconcile, never resend
  }
}

/** Provider codes that mean "the recipient opted out at the carrier/provider" (R-CONSENT-12). */
export const PROVIDER_OPT_OUT_CODES: ReadonlySet<string> = new Set(['RECIPIENT_OPTED_OUT', '21610']);

async function sendAndRecord(plan: SendPlan, decision: StoredDecision, deps: CommsDeps, tenantId: string): Promise<DispatchResult> {
  const m = plan.m;
  const view = decisionView(decision, 'send');
  const out = await providerSend(plan, deps, tenantId);
  return asSystem(deps, tenantId, 'provider', async (tx, now) => {
    await lockContact(tx, m.contactId as ContactId);
    if (out.ok) {
      // R-GMAIL-12: only the Message-ID the provider confirmed is hashed (TX2 runs as the system)
      await msgs.markSent(tx, m.id, out.provider, out.ref, out.provider === 'email' ? rfcMessageIdSha256(out.rfcMessageId ?? null) : null);
      if (m.playbookStepRunId) await auto.updateStepRun(tx, m.playbookStepRunId, { status: 'sent', decisionId: null, messageId: m.id });
      if (m.assistantActionId) await auto.markActionExecuted(tx, m.assistantActionId);
      return { kind: 'sent', messageId: m.id, decision: view, providerRef: out.ref } satisfies DispatchResult;
    }
    if (out.kind === 'timeout') {
      await msgs.markUnknown(tx, m.id, 'PROVIDER_TIMEOUT');
      await enqueueTyped(tx, COMMS_RECONCILE, { messageId: m.id }, { dedupeKey: COMMS_RECONCILE.dedupeKey({ messageId: m.id }), runAt: plusMs(now, 2 * MINUTE_MS) });
      return { kind: 'dispatch_unknown', messageId: m.id, decision: view } satisfies DispatchResult;
    }
    const optedOut = out.code !== null && PROVIDER_OPT_OUT_CODES.has(out.code);
    const reason = optedOut ? 'PROVIDER_OPTED_OUT' : out.kind === 'not_configured' ? (out.code ?? 'PROVIDER_NOT_CONFIGURED') : `PROVIDER_${out.kind.toUpperCase()}`;
    await msgs.markFailed(tx, m.id, reason, out.code);
    if (m.playbookStepRunId) await auto.updateStepRun(tx, m.playbookStepRunId, { status: 'failed', decisionId: null, messageId: m.id });
    if (optedOut) await recordProviderOptOut(tx, deps, tenantId, m, now);
    return { kind: 'failed', messageId: m.id, decision: view, reason } satisfies DispatchResult;
  });
}

/** R-CONSENT-12: a provider "recipient opted out" error is a provider_report revoke; never retried. */
async function recordProviderOptOut(tx: Tx, deps: CommsDeps, tenantId: string, m: msgs.MessageRow, now: Instant): Promise<void> {
  const env = deps.envelope.inTx(tx, tenantId as TenantId);
  const hmac = Buffer.from(await env.hmacAddress(tenantId as TenantId, m.toAddress)).toString('hex');
  const channel: Channel = m.channel === 'email' ? 'email' : 'sms';
  await recordConsentEvent(tx, {
    id: deps.ids.next<'ConsentEventId'>(),
    addressKind: channel === 'email' ? 'email' : 'phone',
    addressHmac: hmac,
    addressHint: hint(m.toAddress),
    channel,
    purpose: 'all',
    eventType: 'revoke',
    level: 'none',
    source: 'provider_report',
    occurredAt: now,
    contactId: m.contactId,
    actor: LEDGER_SYSTEM,
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: m.id,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: { providerCode: 'RECIPIENT_OPTED_OUT' },
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview: false,
  });
  if (channel === 'sms') await msgs.cancelQueuedSmsTo(tx, [m.toAddress], 'PROVIDER_OPTED_OUT');
  // R-AUDIT-5 "opt-out received", in the revoking transaction (R-AUDIT-3)
  await audit(tx, systemActor(tenantId, 'provider'), { action: 'consent.opt_out_received', entity: { type: 'message', id: m.id }, reason: 'PROVIDER_REPORT' });
}

/** A masked hint for consent/suppression rows ('•••-•••-4821', 'j•••@example.com'); never the full address. */
export function hint(address: string): string {
  if (address.includes('@')) {
    const [local, domain] = address.split('@') as [string, string];
    return `${local.slice(0, 1)}•••@${domain}`.slice(0, 40);
  }
  return `•••-•••-${address.slice(-4)}`;
}

// ---- reconciliation (R-GATE-8, E7) -------------------------------------------------------------------

/**
 * comms.reconcile: a dispatch_unknown message is looked up at the provider by its idempotency key.
 * Found ⇒ its real status. Not found ⇒ retried for up to 10 minutes after dispatch, then 'failed' with a
 * human Retry (a NEW message; the original is never re-sent blindly).
 */
export async function reconcileOutbound(messageId: string, deps: CommsDeps, tenantId: string): Promise<{ kind: 'resolved'; status: string } | { kind: 'retry'; at: Instant } | { kind: 'noop' }> {
  const m = await asSystem(deps, tenantId, 'worker', (tx) => msgs.messageById(tx, messageId));
  if (!m || m.status !== 'dispatch_unknown' || m.dispatchedAt === null) return { kind: 'noop' };
  let found: { providerRef: string; status: string } | null = null;
  try {
    if (m.channel === 'email') found = await deps.providers.email.lookupMessage(m.id);
    else if (m.channel === 'web_chat') found = null; // in-process transport: nothing to look up; never resent
    else {
      const account = await asSystem(deps, tenantId, 'worker', (tx) => telephonyAccount(tx, deps.envelope, tenantId));
      // vendors without submit idempotency keys (Twilio) find the submit by sender, recipient, body and time
      found = account ? await deps.providers.telephony.lookupMessage(account, m.id, { from: m.fromAddress, to: m.toAddress, body: m.body, dispatchedAt: m.dispatchedAt }) : null;
    }
  } catch {
    found = null;
  }
  return asSystem(deps, tenantId, 'provider', async (tx, now) => {
    await lockContact(tx, m.contactId as ContactId);
    const cur = await msgs.lockMessage(tx, m.id);
    if (!cur || cur.status !== 'dispatch_unknown') return { kind: 'noop' as const };
    if (found && found.status !== 'unknown') {
      const status = found.status === 'delivered' ? 'delivered' : found.status === 'failed' ? 'failed' : found.status === 'undelivered' ? 'undelivered' : 'sent';
      await msgs.markSent(tx, m.id, m.channel === 'email' ? 'email' : 'telephony', found.providerRef);
      if (status !== 'sent') await msgs.setStatus(tx, m.id, status, status === 'delivered' ? null : 'RECONCILED_FAILED', null);
      return { kind: 'resolved' as const, status };
    }
    const deadline = plusMs(m.dispatchedAt as Instant, MAX_RECONCILE_MS);
    if (now < deadline) return { kind: 'retry' as const, at: (Math.min(deadline, now + 2 * MINUTE_MS) as Instant) };
    await msgs.markFailed(tx, m.id, 'DISPATCH_UNKNOWN_UNRESOLVED', null);
    return { kind: 'resolved' as const, status: 'failed' };
  });
}

// ---- agent alert SMS (ARCHITECTURE §9 path 9; E60) ------------------------------------------------------

export type AlertResult = { kind: 'sent'; providerRef: string } | { kind: 'suppressed'; decisionId: string | null; reasons: string[] } | { kind: 'noop' } | { kind: 'failed'; reason: string };

/**
 * One SMS delivery of a notification to the agent's own verified alert phone. The agent is a recipient
 * like any other: canContact(recipient = user) at send time, so an agent's STOP is honoured (E60). A
 * blocked delivery writes its gate_decisions row; an allowed one writes none.
 * Called by the notification delivery job (api/workspace) for `sms` deliveries.
 */
export async function dispatchAgentAlertSms(deliveryId: string, deps: CommsDeps, tenantId: string): Promise<AlertResult> {
  type Plan = { kind: 'send'; to: string; from: string; body: string } | { kind: 'done'; result: AlertResult };
  const plan: Plan = await asSystem(deps, tenantId, 'worker', async (tx, now) => {
    const r = await sql<{ id: string; status: string; channel: string; user_id: string; title: string; alert_phone_e164: string | null; verified: boolean }>`
      SELECT d.id, d.status, d.channel, n.user_id, n.title, m.alert_phone_e164, m.alert_phone_verified_at IS NOT NULL AS verified
        FROM notification_deliveries d JOIN notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id
        JOIN memberships m ON m.tenant_id = n.tenant_id AND m.user_id = n.user_id
       WHERE d.tenant_id = app.tenant_id() AND d.id = ${deliveryId} FOR UPDATE OF d`.execute(tx);
    const d = r.rows[0];
    if (!d || d.channel !== 'sms' || d.status !== 'pending') return { kind: 'done', result: { kind: 'noop' } };
    if (!d.alert_phone_e164 || !d.verified) {
      await setDelivery(tx, deliveryId, 'suppressed', null, 'NO_VERIFIED_ALERT_PHONE');
      return { kind: 'done', result: { kind: 'suppressed', decisionId: null, reasons: ['NO_VERIFIED_ALERT_PHONE'] } };
    }
    const env = deps.envelope.inTx(tx, tenantId as TenantId);
    const hmac = Buffer.from(await env.hmacAddress(tenantId as TenantId, d.alert_phone_e164)).toString('hex');
    const nums = await g.candidateNumbers(tx, null);
    const body = `${d.title} Open the app for details. Reply STOP to stop alert texts.`;
    const intent: OutboundIntent = {
      contactId: null,
      recipient: { kind: 'user', addressHmac: hmac, channel: 'sms', pointId: null, userId: d.user_id },
      purpose: 'informational',
      initiator: 'system',
      category: 'agent_alert',
      sender: { phoneNumberId: nums.teamMain, emailIdentityId: null },
      body,
    };
    const evaluated = await evaluateGate(tx, intent, now);
    const verdict = verdictOf(evaluated.decision);
    if (verdict.outcome === 'deny') {
      const dec = await insertBlockedDecision(tx, { ids: deps.ids, intent, evaluated, verdict, actorUserId: null, now });
      await setDelivery(tx, deliveryId, 'suppressed', dec.id, dec.reasons[0] ?? 'DENIED');
      return { kind: 'done', result: { kind: 'suppressed', decisionId: dec.id, reasons: dec.reasons } };
    }
    const from = nums.teamMain ? (await g.numberFacts(tx, nums.teamMain))?.e164 ?? null : null;
    await setDelivery(tx, deliveryId, 'sending', null, null);
    return { kind: 'send', to: d.alert_phone_e164, from: from ?? '', body };
  });
  if (plan.kind === 'done') return plan.result;
  let result: AlertResult;
  try {
    const account = await asSystem(deps, tenantId, 'worker', (tx) => telephonyAccount(tx, deps.envelope, tenantId));
    if (!account) throw new ProviderError('not_configured', 'TELEPHONY_ACCOUNT_MISSING');
    const r = await deps.providers.telephony.sendSms({ account, from: plan.from, to: plan.to, body: plan.body, idempotencyKey: deliveryId });
    result = { kind: 'sent', providerRef: r.providerRef };
  } catch (e) {
    result = { kind: 'failed', reason: e instanceof ProviderError ? `PROVIDER_${e.kind.toUpperCase()}` : 'PROVIDER_ERROR' };
  }
  await asSystem(deps, tenantId, 'provider', (tx) =>
    result.kind === 'sent' ? setDelivery(tx, deliveryId, 'sent', null, null, result.providerRef) : setDelivery(tx, deliveryId, 'failed', null, result.kind === 'failed' ? result.reason : null),
  );
  return result;
}

async function setDelivery(tx: Tx, id: string, status: string, decisionId: string | null, error: string | null, providerRef?: string): Promise<void> {
  await sql`
    UPDATE notification_deliveries SET status = ${status}, gate_decision_id = COALESCE(${decisionId}::uuid, gate_decision_id), last_error = ${error},
           provider_ref = COALESCE(${providerRef ?? null}, provider_ref), next_attempt_at = NULL, attempts = attempts + 1
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}