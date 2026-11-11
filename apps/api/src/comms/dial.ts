// Tap-to-call (ARCHITECTURE §9 path 3; R-GATE-9, R-CONSENT-16; R-OWN-14; E47; core-compliance/2.0.0).
// With dispatch.ts the only module allowed to call a provider dial (lint + architecture test).
//
//   startCall (one transaction as the calling agent): contact detail visible, core.can('comms.call'),
//     the agent's verified phone (the bridge rings the agent first), the sender number, then the
//     DIAL-TIME gate (voice, initiator human: opt-out / do-not-call, suppression, sender, tenant).
//     allow ⇒ the calls row (the calls dispatch guard re-checks the do-not-call block) + the recording
//     decision (core.decideRecording; announce unless every party is one-party and the Owner attested)
//     + the touch in the same transaction (R-OWN-14). deny ⇒ a gate_decisions row (the blocked-call
//     evidence), the decision is returned and no call exists. If the guard refuses a call the gate
//     allowed (RECIPIENT_OPTED_OUT / RECIPIENT_NOT_A_CONTACT_POINT: defence in depth, as in dispatch.ts),
//     the transaction rolls back and a NEW one records it as that deny; nothing is dialed, never a 500.
//   dialOutbound (after commit): provider.dialCall(idempotencyKey = call id) with the announcement;
//     'ringing' + provider ref, or 'failed'. Never re-dials a call that already has a provider ref.
//   applyCallStatus (provider callbacks): forward-only status; an announcement that failed to play
//     turns recording OFF for the call before it can be marked in progress (E47, DB CHECK).
import { classifyHumanPurpose, decideRecording, recordingMayStart } from '@realty/core/compliance';
import type { ContactId, Instant, SystemActor, TenantId, UserActor } from '@realty/core/foundation';
import { MINUTE_MS, can, toIso } from '@realty/core/foundation';
import { applyOwnershipCommandInTx, derivedCommandId, lockContact, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { type GuardDenyReason, decisionView, evaluateGate, guardOptOutRefusal, insertBlockedDecision, resolvedPolicy, verdictOf } from './gateInput.js';
import { contactFacts, dealOrAppointmentContext, detailVisibleContact } from './repos/contacts.js';
import { telephonyAccount } from './repos/credentials.js';
import * as g from './repos/gate.js';
import * as msgs from './repos/messages.js';
import { signedRef } from './render.js';
import { asSystem, asUser, linkMac } from './runtime.js';
import type { CommsDeps, DecisionView, DialResult, OutboundIntent } from './types.js';

/** Played to every party before an announced recording starts (VERIFY WITH COUNSEL: wording per state). */
export const RECORDING_ANNOUNCEMENT = 'This call may be recorded for quality and training.';

export type StartCallResult = { kind: 'dialing'; callId: string; bridgeToken: string; decision: DecisionView } | { kind: 'gate'; decision: DecisionView } | { kind: 'failed'; callId: string; reason: string; decision: DecisionView };

export async function startCall(actor: UserActor, contactId: string, input: { toPointId?: string | undefined }, deps: CommsDeps): Promise<StartCallResult> {
  type Out = { kind: 'gate'; decision: DecisionView } | { kind: 'created'; callId: string; decision: DecisionView };
  // guardDeny: the calls guard's refusal of a call this gate allowed, as a deny reason of the second run
  const attempt = (guardDeny: readonly GuardDenyReason[]): Promise<Out> => asUser(deps, actor, async (tx, txNow) => {
    void txNow;
    if (!(await detailVisibleContact(tx, contactId))) throw new AppError('NOT_FOUND');
    await lockContact(tx, contactId as ContactId);
    const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime() as Instant;
    const facts = await contactFacts(tx, contactId);
    const conv0 = await g.conversationOf(tx, contactId);
    const purpose = classifyHumanPurpose({ lastInboundAt: conv0?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now });
    if (!facts || !can(actor, 'comms.call', { ...facts, purpose }).ok) throw new AppError('NOT_FOUND');
    const point = (await g.contactPoints(tx, contactId)).find((p) => p.kind === 'phone' && (input.toPointId ? p.id === input.toPointId : true));
    if (!point) throw new AppError('CONTACT_POINT_MISSING');
    const me = await sql<{ alert_phone_e164: string | null; verified: boolean; home_jurisdiction: string | null }>`
      SELECT alert_phone_e164, alert_phone_verified_at IS NOT NULL AS verified, home_jurisdiction FROM memberships
       WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}`.execute(tx);
    const agent = me.rows[0];
    if (!agent?.alert_phone_e164 || !agent.verified) throw new AppError('AGENT_PHONE_MISSING');
    const conversationId = await msgs.ensureConversation(tx, deps.ids.next<'ConversationId'>(), contactId, null);
    const conv = await g.conversationOf(tx, contactId);
    const nums = await g.candidateNumbers(tx, actor.userId);
    const numberId = [conv?.stickyPhoneNumberId ?? null, nums.direct, nums.teamMain].find((x) => x !== null) ?? null;
    const n = numberId ? await g.numberFacts(tx, numberId) : null;
    const callId = deps.ids.next<'CallId'>();
    const intent: OutboundIntent = {
      contactId,
      recipient: { kind: 'contact', addressHmac: point.hmac, channel: 'voice', pointId: point.id },
      purpose,
      initiator: 'human',
      category: 'none',
      sender: { phoneNumberId: n?.id ?? null, emailIdentityId: null },
      body: null,
    };
    const evaluated = await evaluateGate(tx, intent, now);
    const verdict = verdictOf(evaluated.decision, guardDeny);
    if (verdict.outcome === 'deny') {
      const blocked = await insertBlockedDecision(tx, { ids: deps.ids, intent, evaluated, verdict, actorUserId: actor.userId, callId, now, extraDeny: guardDeny });
      return { kind: 'gate', decision: decisionView(blocked, 'send') };
    }
    if (!n) return { kind: 'gate', decision: decisionView({ id: null, ...verdict }, 'send') };

    const { policy, packs } = await resolvedPolicy(tx);
    const juris = await sql<{ jurisdiction: string | null }>`
      SELECT jurisdiction FROM contact_addresses WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
    const rec = decideRecording({
      ...(agent.home_jurisdiction ? { agentJurisdiction: agent.home_jurisdiction } : {}),
      clientJurisdictions: juris.rows.map((r) => r.jurisdiction).filter((j): j is string => !!j),
      packs,
      mode: policy.recordingMode,
      direction: 'outbound',
      enabled: policy.recordingEnabled,
    });
    await sql`
      INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator, status,
        started_at, recording_mode, recording_decision)
      VALUES (app.tenant_id(), ${callId}, ${conversationId}, ${contactId}, 'outbound', ${n.id}, ${actor.userId}, ${point.address}, 'human', 'initiated',
        ${toIso(now)}::timestamptz, ${rec.mode}, ${JSON.stringify(rec)}::jsonb)`.execute(tx);
    if (facts.own === true || facts.collaborator === true) {
      await applyOwnershipCommandInTx(tx, actor, contactId as ContactId, { kind: 'touch', via: 'call', refId: callId, at: now }, { commandId: derivedCommandId('comms.touch', callId), ids: deps.ids });
      await setOwnershipCommand(tx, null);
    }
    await msgs.touchConversationOutbound(tx, conversationId, n.id, now);
    return { kind: 'created', callId, decision: decisionView({ id: null, ...verdict }, 'send') };
  });
  let out: Out;
  try {
    out = await attempt([]);
  } catch (e) {
    // the calls guard refused the row the gate allowed: that transaction is rolled back and gone (no calls
    // row, no touch); a fresh one records the refusal as a deny. Nothing is dialed; any other error propagates.
    const refused = guardOptOutRefusal(e);
    if (refused === null) throw e;
    out = await attempt([refused]);
  }
  if (out.kind === 'gate') return out;
  const r = await dialOutbound(out.callId, deps, actor.tenantId);
  if (r.kind === 'failed') return { kind: 'failed', callId: out.callId, reason: r.reason, decision: out.decision };
  return { kind: 'dialing', callId: out.callId, bridgeToken: bridgeToken(deps, out.callId), decision: out.decision };
}

/** The client's handle on a live call (status polling / hang-up); stateless and bound to the call id. */
export function bridgeToken(deps: Pick<CommsDeps, 'linkSecret'>, callId: string): string {
  return `${callId}.${linkMac(deps.linkSecret, 'bridge', callId)}`;
}

/** BUILD_PLAN interface: places the provider dial of a gate-allowed call (idempotent). */
export async function dialOutbound(callId: string, deps: CommsDeps, tenantId: string): Promise<DialResult> {
  type Plan = { kind: 'dial'; from: string; agentPhone: string; to: string; record: boolean; announce: boolean } | { kind: 'done'; r: DialResult };
  const plan: Plan = await asSystem(deps, tenantId, 'worker', async (tx, now) => {
    const r = await sql<{ status: string; provider_call_ref: string | null; client_address: string; e164: string; alert_phone_e164: string | null; recording_decision: { mode: string; announce: boolean }; started_at: Date }>`
      SELECT c.status, c.provider_call_ref, c.client_address, n.e164, m.alert_phone_e164, c.recording_decision, c.started_at
        FROM calls c JOIN phone_numbers n ON n.tenant_id = c.tenant_id AND n.id = c.phone_number_id
        JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.agent_user_id
       WHERE c.tenant_id = app.tenant_id() AND c.id = ${callId} AND c.direction = 'outbound' FOR UPDATE OF c`.execute(tx);
    const c = r.rows[0];
    if (!c || c.status !== 'initiated' || c.provider_call_ref !== null) return { kind: 'done', r: { kind: 'noop', callId } };
    // A call row is written only after the dial-time gate allowed it, in the same transaction, and is dialed
    // right after: one left 'initiated' for more than 10 minutes (a crash in between) is never dialed late.
    if (now - c.started_at.getTime() > 10 * MINUTE_MS || !c.alert_phone_e164) {
      await sql`UPDATE calls SET status = 'failed', ended_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
      return { kind: 'done', r: { kind: 'failed', callId, reason: c.alert_phone_e164 ? 'CALL_REQUEST_EXPIRED' : 'AGENT_PHONE_MISSING' } };
    }
    return { kind: 'dial', from: c.e164, agentPhone: c.alert_phone_e164, to: c.client_address, record: c.recording_decision.mode !== 'off', announce: c.recording_decision.announce === true };
  });
  if (plan.kind === 'done') return plan.r;
  let ref: string | null = null;
  let reason = 'PROVIDER_ERROR';
  try {
    const account = await asSystem(deps, tenantId, 'worker', (tx) => telephonyAccount(tx, deps.envelope, tenantId));
    if (!account) throw new ProviderError('not_configured', 'TELEPHONY_ACCOUNT_MISSING');
    const res = await deps.providers.telephony.dialCall({
      account,
      from: plan.from,
      agentPhone: plan.agentPhone,
      to: plan.to,
      idempotencyKey: callId,
      record: plan.record,
      ...(plan.announce ? { recordingAnnouncement: RECORDING_ANNOUNCEMENT } : {}),
      statusCallbackUrl: new URL('/api/webhooks/telephony/voice', deps.publicBaseUrl).toString(),
      // fetched when the client answers: plays the announcement and records that it played (R-CONSENT-16)
      answerUrl: new URL(`/api/webhooks/telephony/answer?c=${signedRef(deps.linkSecret, 'call-answer', tenantId, callId)}`, deps.publicBaseUrl).toString(),
      recordingStatusCallbackUrl: new URL('/api/webhooks/telephony/recording', deps.publicBaseUrl).toString(),
    });
    ref = res.providerRef;
  } catch (e) {
    reason = e instanceof ProviderError ? (e.providerCode ?? `PROVIDER_${e.kind.toUpperCase()}`) : 'PROVIDER_ERROR';
  }
  return asSystem(deps, tenantId, 'provider', async (tx) => {
    if (ref) {
      await sql`UPDATE calls SET provider_call_ref = ${ref}, status = 'ringing' WHERE tenant_id = app.tenant_id() AND id = ${callId} AND status = 'initiated'`.execute(tx);
      return { kind: 'dialing', callId, bridgeToken: bridgeToken(deps, callId), decision: { id: null, outcome: 'allow', reasons: [], explanation: 'OK to send', phase: 'send' } } satisfies DialResult;
    }
    await sql`UPDATE calls SET status = 'failed', ended_at = clock_timestamp() WHERE tenant_id = app.tenant_id() AND id = ${callId} AND status = 'initiated'`.execute(tx);
    return { kind: 'failed', callId, reason } satisfies DialResult;
  });
}

const CALL_RANK: Record<string, number> = { initiated: 0, ringing: 1, in_progress: 2, completed: 3, no_answer: 3, busy: 3, failed: 3, canceled: 3, voicemail: 3 };

export interface CallStatusEvent {
  providerCallRef: string;
  status: 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled' | 'voicemail';
  /** the announcement finished playing (announced mode: recording may start) */
  announcement?: 'played' | 'failed';
  durationS?: number;
  occurredAt: Instant;
}

/** Provider call-status callback (forward-only; E47). Returns the call id or null when unknown. */
export async function applyCallStatus(actor: SystemActor, e: CallStatusEvent, deps: CommsDeps): Promise<string | null> {
  return withTenantTx(actor, async (tx) => {
    const r = await sql<{ id: string; contact_id: string; status: string; recording_mode: string; recording_decision: Record<string, unknown>; recording_announced_at: Date | null; answered_at: Date | null }>`
      SELECT id, contact_id, status, recording_mode, recording_decision, recording_announced_at, answered_at FROM calls
       WHERE tenant_id = app.tenant_id() AND provider_call_ref = ${e.providerCallRef}`.execute(tx);
    const c = r.rows[0];
    if (!c) return null;
    await lockContact(tx, c.contact_id as ContactId);
    const at = toIso(e.occurredAt);
    if (e.announcement === 'played' && c.recording_mode === 'announced_all_parties' && !c.recording_announced_at) {
      await sql`UPDATE calls SET recording_announced_at = ${at}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    }
    if (e.announcement === 'failed' && c.recording_mode !== 'off' && !c.recording_announced_at) {
      // E47: the announcement did not play ⇒ this call is never recorded
      await sql`UPDATE calls SET recording_mode = 'off', recording_decision = recording_decision || ${JSON.stringify({ mode: 'off', announce: false, announcement: 'failed' })}::jsonb
                 WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    }
    if ((CALL_RANK[e.status] ?? 0) > (CALL_RANK[c.status] ?? 0)) {
      const announcedNeeded = await sql<{ mode: string; announced: boolean }>`
        SELECT recording_mode AS mode, recording_announced_at IS NOT NULL AS announced FROM calls WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
      const st = announcedNeeded.rows[0]!;
      if ((e.status === 'in_progress' || e.status === 'completed') && st.mode === 'announced_all_parties' && !st.announced) {
        // answered before any announcement result: the provider must not record; the call goes on unrecorded
        await sql`UPDATE calls SET recording_mode = 'off', recording_decision = recording_decision || '{"mode":"off","announcement":"missing"}'::jsonb
                   WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
      }
      await sql`
        UPDATE calls SET status = ${e.status},
               answered_at = CASE WHEN ${e.status} = 'in_progress' AND answered_at IS NULL THEN ${at}::timestamptz ELSE answered_at END,
               ended_at = CASE WHEN ${CALL_RANK[e.status] === 3} THEN COALESCE(ended_at, ${at}::timestamptz) ELSE ended_at END,
               duration_s = COALESCE(${e.durationS ?? null}::int, duration_s)
         WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
    }
    return c.id;
  }, { db: deps.db, retries: 2 });
}

/** Whether a recording of this call may be kept (core.recordingMayStart on the stored decision). */
export function mayKeepRecording(c: { recording_mode: string; recording_decision: { announce?: boolean }; recording_announced_at: Date | null }): boolean {
  return recordingMayStart({ mode: c.recording_mode as 'off', announce: c.recording_decision.announce === true, basis: '' }, c.recording_announced_at ? (c.recording_announced_at.getTime() as Instant) : null);
}

export type { TenantId };
