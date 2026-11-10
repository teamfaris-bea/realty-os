// Consent capture and the human side of consent (R-CONSENT-1…4, -8, -9, -10, -11; R-AUDIT-5; R-AST-9 resume).
//
// - recordStaffConsent: an agent records consent they obtained (agent_entry, or verbal_on_call citing
//   the call) — at most `express` (R-CONSENT-4; DB CHECK), or records a revocation the person asked for
//   (agent_revoke). Staff can never reinstate an opt-out (R-CONSENT-10): the fold ignores a staff grant
//   after a revoke, and the response says so plainly.
// - markNotOptOut: R-CONSENT-8 review of an opt-out-LANGUAGE revoke (core.planNotAnOptOut); restores the
//   prior level only if its basis still exists; audited with the reason.
// - liftSuppression: Owner/Admin, as themselves, once, with a reason; never a spam complaint (DB trigger).
// - resumeAutomation: a human resumes paused automation (DB guard RESUME_REQUIRES_HUMAN), audited.
// - unsubscribeByLink: the person's one-click List-Unsubscribe (their own action) revokes marketing email.
// - logCallOutcome: the post-call outcome; "wrong number" and "do not call" have consent effects.
// Every change is audited in its own transaction (R-AUDIT-3); diffs carry codes only (R-AUDIT-4).
import { type ConsentEventSpec, type Channel, type EventPurpose, planNotAnOptOut, validateConsentEventSpec } from '@realty/core/compliance';
import type { ContactId, Instant, TenantId, UserActor } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, hmacBytes, lockAddress, lockContact, recordConsentEvent, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { hint } from './dispatch.js';
import { verifySignedRef } from './render.js';
import * as auto from './repos/automation.js';
import { detailVisibleContact } from './repos/contacts.js';
import * as g from './repos/gate.js';
import * as msgs from './repos/messages.js';
import { handlerOf } from './repos/notify.js';
import { asUser } from './runtime.js';
import { LEDGER_SYSTEM, type CommsDeps } from './types.js';

export interface StaffConsentInput {
  kind: 'record' | 'revoke';
  pointId: string;
  channel: Channel;
  purpose: 'marketing' | 'informational' | 'all';
  /** record only; staff entries are capped at `express` */
  level?: 'express' | undefined;
  evidence: { note?: string | undefined; callId?: string | undefined; callOffsetMs?: number | undefined };
}

export interface ConsentStateView {
  channel: string;
  purpose: string;
  status: string;
  level: string;
}

function baseSpec(id: string, p: g.PointRow, channel: Channel, now: Instant, contactId: string, actor: UserActor): Omit<ConsentEventSpec, 'purpose' | 'eventType' | 'level' | 'source'> {
  return {
    id,
    addressKind: p.kind,
    addressHmac: p.hmac,
    addressHint: hint(p.address),
    channel,
    occurredAt: now,
    contactId,
    actor: { kind: 'user', userId: actor.userId },
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: null,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    evidence: {},
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview: false,
  };
}

export async function recordStaffConsent(actor: UserActor, contactId: string, input: StaffConsentInput, deps: CommsDeps): Promise<{ eventId: string; state: ConsentStateView[]; explanation: string }> {
  return asUser(deps, actor, async (tx, now) => {
    if (!(await detailVisibleContact(tx, contactId))) throw new AppError('NOT_FOUND');
    const p = (await g.contactPoints(tx, contactId)).find((x) => x.id === input.pointId);
    if (!p) throw new AppError('NOT_FOUND');
    if ((p.kind === 'email') !== (input.channel === 'email')) throw new AppError('CONSENT_ENTRY_INVALID', { issues: ['CHANNEL_KIND_MISMATCH'] });
    const id = deps.ids.next<'ConsentEventId'>();
    let callId: string | null = null;
    if (input.evidence.callId) {
      const c = await sql<{ id: string }>`SELECT id FROM calls WHERE tenant_id = app.tenant_id() AND id = ${input.evidence.callId} AND contact_id = ${contactId}`.execute(tx);
      if (!c.rows[0]) throw new AppError('CONSENT_ENTRY_INVALID', { issues: ['CALL_NOT_FOUND'] });
      callId = c.rows[0].id;
    }
    const spec: ConsentEventSpec =
      input.kind === 'record'
        ? {
            ...baseSpec(id, p, input.channel, now, contactId, actor),
            purpose: input.purpose as EventPurpose,
            eventType: 'grant',
            level: input.level ?? 'express',
            source: callId ? 'verbal_on_call' : 'agent_entry',
            evidenceCallId: callId,
            evidenceCallOffsetMs: input.evidence.callOffsetMs ?? null,
            evidence: { entered_by: 'staff', ...(input.evidence.note ? { note_present: true } : {}) },
          }
        : { ...baseSpec(id, p, input.channel, now, contactId, actor), purpose: input.purpose as EventPurpose, eventType: 'revoke', level: 'none', source: 'agent_revoke', evidence: { entered_by: 'staff' } };
    const issues = validateConsentEventSpec(spec);
    // verbal_on_call by staff is capped like agent_entry: never above express (R-CONSENT-4)
    if (spec.source === 'verbal_on_call' && spec.level !== 'express') issues.push('AGENT_ENTRY_ABOVE_EXPRESS');
    if (issues.length > 0) throw new AppError('CONSENT_ENTRY_INVALID', { issues });
    const rows = await recordConsentEvent(tx, spec);
    if (input.kind === 'revoke' && input.channel === 'sms') await msgs.cancelQueuedSmsTo(tx, [p.address], 'OPTED_OUT');
    await audit(tx, actor, {
      action: 'consent.recorded',
      entity: { type: 'contact_point', id: p.id },
      changes: redactSnapshot({ kind: input.kind, channel: input.channel, purpose: input.purpose, level: spec.level, source: spec.source }, { entity: 'consent_event' }),
      reason: input.kind === 'record' ? 'STAFF_CONSENT_ENTRY' : 'STAFF_REVOKE',
    });
    const stillRevoked = input.kind === 'record' && rows.some((r) => r.status === 'revoked');
    return {
      eventId: id,
      state: rows.map((r) => ({ channel: r.channel, purpose: r.purpose, status: r.status, level: r.level })),
      explanation: stillRevoked
        ? 'Recorded, but this address opted out. Only the person can opt back in (for example by texting START or submitting a new form).'
        : input.kind === 'record'
          ? 'Consent recorded.'
          : 'Opt-out recorded. Nothing more will be sent on this channel.',
    };
  });
}

interface EventRow {
  id: string;
  address_kind: 'phone' | 'email';
  address_hmac: Buffer;
  address_hint: string;
  channel: Channel;
  purpose: EventPurpose;
  event_type: ConsentEventSpec['eventType'];
  consent_level: ConsentEventSpec['level'];
  source: ConsentEventSpec['source'];
  occurred_at: Date;
  contact_id: string | null;
  actor_kind: 'user' | 'system';
  actor_user_id: string | null;
  disclosure_id: string | null;
  evidence_object_id: string | null;
  evidence_message_id: string | null;
  evidence_call_id: string | null;
  evidence_call_offset_ms: number | null;
  evidence: Record<string, unknown>;
  imported: boolean;
  import_record_id: string | null;
  original_provenance: Record<string, unknown> | null;
  reverts_event_id: string | null;
  expires_at: Date | null;
  needs_review: boolean;
}

function toSpec(r: EventRow): ConsentEventSpec {
  return {
    id: r.id,
    addressKind: r.address_kind,
    addressHmac: r.address_hmac.toString('hex'),
    addressHint: r.address_hint,
    channel: r.channel,
    purpose: r.purpose,
    eventType: r.event_type,
    level: r.consent_level,
    source: r.source,
    occurredAt: instantFromDate(r.occurred_at),
    contactId: r.contact_id,
    actor: r.actor_kind === 'user' && r.actor_user_id ? { kind: 'user', userId: r.actor_user_id } : LEDGER_SYSTEM,
    disclosureId: r.disclosure_id,
    evidenceObjectId: r.evidence_object_id,
    evidenceMessageId: r.evidence_message_id,
    evidenceCallId: r.evidence_call_id,
    evidenceCallOffsetMs: r.evidence_call_offset_ms,
    evidence: r.evidence,
    imported: r.imported,
    importRecordId: r.import_record_id,
    originalProvenance: r.original_provenance,
    revertsEventId: r.reverts_event_id,
    expiresAt: r.expires_at ? instantFromDate(r.expires_at) : null,
    needsReview: r.needs_review,
  };
}

/** R-CONSENT-8: "not an opt-out" (an agent reviews an opt-out-language revoke). */
export async function markNotOptOut(actor: UserActor, consentEventId: string, reason: string, deps: CommsDeps): Promise<{ restored: ConsentStateView[] }> {
  return asUser(deps, actor, async (tx, now) => {
    const t = await sql<EventRow>`SELECT * FROM consent_events WHERE tenant_id = app.tenant_id() AND id = ${consentEventId}`.execute(tx);
    const target = t.rows[0];
    if (!target || !target.contact_id || !(await detailVisibleContact(tx, target.contact_id))) throw new AppError('NOT_FOUND');
    const related = await sql<EventRow>`
      SELECT * FROM consent_events WHERE tenant_id = app.tenant_id()
         AND ((channel = ${target.channel} AND address_hmac = ${target.address_hmac})
              OR (${target.evidence_message_id}::uuid IS NOT NULL AND evidence_message_id = ${target.evidence_message_id}::uuid)
              OR evidence ->> 'voids_revoke_event_id' IS NOT NULL)
       ORDER BY occurred_at, id`.execute(tx);
    const events = related.rows.map(toSpec);
    // the sibling revokes' own keys must be in the fold too (other phones of the same inbound)
    const keys = new Set(events.filter((e) => e.evidenceMessageId === target.evidence_message_id).map((e) => `${e.channel}:${e.addressHmac}`));
    for (const k of keys) {
      const [ch, h] = k.split(':') as [Channel, string];
      const more = await sql<EventRow>`SELECT * FROM consent_events WHERE tenant_id = app.tenant_id() AND channel = ${ch} AND address_hmac = ${hmacBytes(h)}`.execute(tx);
      for (const r of more.rows) if (!events.some((e) => e.id === r.id)) events.push(toSpec(r));
    }
    const plan = planNotAnOptOut({ events, revokeEventId: consentEventId, userId: actor.userId, now, ids: deps.ids });
    if (!plan.ok) throw new AppError(plan.code === 'CONSENT_EVENT_NOT_FOUND' ? 'NOT_FOUND' : plan.code);
    for (const ev of plan.events) await recordConsentEvent(tx, ev);
    await audit(tx, actor, { action: 'consent.not_opt_out_marked', entity: { type: 'consent_event', id: consentEventId }, reason: reason.slice(0, 200) });
    return { restored: plan.restored.map((r) => ({ channel: r.channel, purpose: r.purpose, status: r.status, level: r.level })) };
  });
}

export async function liftSuppression(actor: UserActor, suppressionId: string, reason: string, deps: CommsDeps): Promise<{ id: string; liftedAt: string }> {
  return asUser(deps, actor, async (tx, now) => {
    const r = await sql<{ id: string; reason: string; lifted_at: Date | null; address_hmac: Buffer }>`
      SELECT id, reason, lifted_at, address_hmac FROM suppressions WHERE tenant_id = app.tenant_id() AND id = ${suppressionId}`.execute(tx);
    const s = r.rows[0];
    if (!s) throw new AppError('NOT_FOUND');
    if (s.reason === 'spam_complaint') throw new AppError('SUPPRESSION_NOT_LIFTABLE');
    if (s.lifted_at) throw new AppError('ALREADY_REVIEWED');
    await sql`
      UPDATE suppressions SET lifted_at = ${new Date(now).toISOString()}::timestamptz, lifted_by_user_id = ${actor.userId}, lift_reason = ${reason.slice(0, 500)}
       WHERE tenant_id = app.tenant_id() AND id = ${suppressionId} AND lifted_at IS NULL`.execute(tx);
    if (s.reason === 'hard_bounce') {
      // the mailbox was fixed: the address may be used again (the gate still checks everything else)
      await sql`UPDATE contact_points SET status = 'active' WHERE tenant_id = app.tenant_id() AND address_hmac = ${s.address_hmac} AND status = 'bouncing'`.execute(tx);
    }
    await audit(tx, actor, { action: 'suppression.lifted', entity: { type: 'suppression', id: suppressionId }, changes: redactSnapshot({ reason: s.reason }, { entity: 'suppression' }), reason: 'SUPPRESSION_LIFTED' });
    return { id: suppressionId, liftedAt: new Date(now).toISOString() };
  });
}

export async function resumeAutomation(actor: UserActor, contactId: string, deps: CommsDeps): Promise<{ resumedEnrollments: number }> {
  return asUser(deps, actor, async (tx) => {
    if (!(await detailVisibleContact(tx, contactId))) throw new AppError('NOT_FOUND');
    await lockContact(tx, contactId as ContactId);
    const conv = await g.conversationOf(tx, contactId);
    if (!conv?.pausedAt) throw new AppError('AUTOMATION_NOT_PAUSED');
    if (conv.pauseReason === 'opt_out' || conv.pauseReason === 'wrong_number') throw new AppError('AUTOMATION_NOT_PAUSED', { reason: conv.pauseReason });
    const r = await auto.resumeAutomation(tx, contactId, actor.userId);
    await audit(tx, actor, { action: 'automation.resumed', entity: { type: 'contact', id: contactId }, changes: redactSnapshot({ enrollments: r.resumed }, { entity: 'conversation' }), reason: 'HUMAN_RESUME' });
    return { resumedEnrollments: r.resumed };
  });
}

/** One-click unsubscribe (the person's own action, RFC 8058): revokes marketing email for the address. */
export async function unsubscribeByLink(token: string, deps: CommsDeps): Promise<'unsubscribed' | 'invalid'> {
  const ref = verifySignedRef(deps.linkSecret, 'unsubscribe', token);
  if (!ref) return 'invalid';
  const actor = systemActor(ref.tenantId, 'provider');
  return withTenantTx(actor, async (tx, now) => {
    const m = await msgs.messageById(tx, ref.id);
    if (!m || m.channel !== 'email' || m.direction !== 'outbound') return 'invalid' as const;
    const tenantId = ref.tenantId as TenantId;
    const hmac = Buffer.from(await deps.envelope.inTx(tx, tenantId).hmacAddress(tenantId, m.toAddress)).toString('hex');
    await lockAddress(tx, hmac);
    const st = await g.consentRows(tx, 'email', [hmac]);
    if (st.some((r) => r.purpose === 'marketing' && r.status === 'revoked')) return 'unsubscribed' as const;
    await recordConsentEvent(tx, {
      id: deps.ids.next<'ConsentEventId'>(), addressKind: 'email', addressHmac: hmac, addressHint: hint(m.toAddress), channel: 'email', purpose: 'marketing',
      eventType: 'revoke', level: 'none', source: 'web_form', occurredAt: now, contactId: m.contactId, actor: LEDGER_SYSTEM, disclosureId: null,
      evidenceObjectId: null, evidenceMessageId: m.id, evidenceCallId: null, evidenceCallOffsetMs: null, evidence: { kind: 'list_unsubscribe' },
      imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
    });
    await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'message', id: m.id }, reason: 'EMAIL_UNSUBSCRIBE' });
    return 'unsubscribed' as const;
  }, { db: deps.db, retries: 2 });
}

export const CALL_OUTCOMES = ['connected', 'left_voicemail', 'no_answer', 'wrong_number', 'bad_number', 'do_not_call_request', 'callback_requested'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/**
 * POST /calls/:id/outcome: the agent on the call logs it (1 tap); wrong number / do-not-call act on consent.
 * E14: when the lead moved to someone else during the call, the agent can no longer write the contact's
 * call row (RLS), so the outcome becomes a "log outcome" task for whoever handles the contact now
 * (written by the system after checking the call really was this agent's, ended within 24 h).
 */
export async function logCallOutcome(actor: UserActor, callId: string, outcome: CallOutcome, deps: CommsDeps): Promise<{ callId: string; outcome: CallOutcome; recordedAs: 'call' | 'task_for_current_owner' }> {
  const direct = await asUser(deps, actor, async (tx, now) => {
    const r = await sql<{ id: string; contact_id: string; agent_user_id: string | null; client_address: string; direction: string }>`
      SELECT id, contact_id, agent_user_id, client_address, direction FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    const c = r.rows[0];
    if (!c) return null;
    if (c.agent_user_id !== actor.userId) throw new AppError('CALL_NOT_ACTIVE');
    await lockContact(tx, c.contact_id as ContactId);
    await sql`
      UPDATE calls SET outcome = ${outcome}, outcome_logged_by_user_id = ${actor.userId}, outcome_logged_at = ${new Date(now).toISOString()}::timestamptz
       WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    if (outcome === 'wrong_number' || outcome === 'bad_number' || outcome === 'do_not_call_request') {
      const p = (await g.contactPoints(tx, c.contact_id)).find((x) => x.kind === 'phone' && x.address === c.client_address);
      if (p) await callConsentEffects(tx, actor, deps, c.contact_id, p, outcome, callId, now);
    }
    return { callId, outcome, recordedAs: 'call' as const };
  });
  if (direct) return direct;
  // E14: not visible any more. Only the agent who was on this (recent) call may hand its outcome over.
  return withTenantTx(systemActor(actor.tenantId, 'worker'), async (tx, now) => {
    const r = await sql<{ contact_id: string; agent_user_id: string | null; recent: boolean; outcome: string | null }>`
      SELECT contact_id, agent_user_id, started_at > ${new Date(now).toISOString()}::timestamptz - interval '24 hours' AS recent, outcome
        FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    const c = r.rows[0];
    if (!c || c.agent_user_id !== actor.userId || !c.recent || c.outcome !== null) throw new AppError('NOT_FOUND');
    await lockContact(tx, c.contact_id as ContactId);
    const handler = await handlerOf(tx, c.contact_id);
    if (!handler.userId) throw new AppError('NOT_FOUND');
    // one handover per call: a repeated tap (or a network retry) finds the task it already created
    // (serialized by the contact lock above). The note names the call so the new owner can open it.
    const note = `From the call ${callId}`;
    const existing = await sql<{ id: string }>`
      SELECT id FROM tasks WHERE tenant_id = app.tenant_id() AND contact_id = ${c.contact_id} AND kind = 'follow_up'
         AND created_by_kind = 'system' AND notes = ${note} LIMIT 1`.execute(tx);
    if (existing.rows.length === 0) {
      await sql`
        INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, notes, created_by_kind)
        VALUES (app.tenant_id(), ${deps.ids.next<'TaskId'>()}, ${handler.userId}, ${c.contact_id}, 'follow_up',
                ${`Log the outcome of a call that happened while the lead moved to you (reported: ${outcome.replace(/_/g, ' ')})`}, ${note}, 'system')`.execute(tx);
    }
    return { callId, outcome, recordedAs: 'task_for_current_owner' as const };
  }, { db: deps.db, retries: 2 });
}

async function callConsentEffects(tx: Tx, actor: UserActor, deps: CommsDeps, contactId: string, p: g.PointRow, outcome: 'wrong_number' | 'bad_number' | 'do_not_call_request', callId: string, now: Instant): Promise<void> {
  if (outcome === 'bad_number') {
    await sql`UPDATE contact_points SET status = 'invalid' WHERE tenant_id = app.tenant_id() AND id = ${p.id}`.execute(tx);
    return;
  }
  const channels: Channel[] = outcome === 'wrong_number' ? ['sms', 'voice'] : ['voice'];
  // outbound-3: "do not call me" is the person's request, so it revokes voice on every phone of the
  // contact (as inbound opt-out language does); a wrong number is about this number only
  const targets = outcome === 'do_not_call_request' ? [p, ...(await g.contactPoints(tx, contactId)).filter((x) => x.kind === 'phone' && x.hmac !== p.hmac)] : [p];
  for (const ch of channels) for (const t of targets) {
    await recordConsentEvent(tx, {
      ...baseSpec(deps.ids.next<'ConsentEventId'>(), t, ch, now, contactId, actor),
      purpose: 'all',
      eventType: 'revoke',
      level: 'none',
      source: outcome === 'wrong_number' ? 'wrong_number' : 'agent_revoke',
      evidenceCallId: callId,
      evidence: { call_outcome: outcome },
    });
  }
  if (outcome === 'wrong_number') {
    // R-CONSENT-11: mark the point and stop (not just pause) the enrollment
    await sql`UPDATE contact_points SET status = 'wrong_number' WHERE tenant_id = app.tenant_id() AND address_hmac = ${hmacBytes(p.hmac)} AND removed_at IS NULL`.execute(tx);
    await auto.pauseEnrollments(tx, [contactId], 'wrong_number', null, now, { stepRuns: false });
    await msgs.cancelQueuedSmsTo(tx, [p.address], 'WRONG_NUMBER');
  }
  await audit(tx, actor, { action: 'consent.recorded', entity: { type: 'contact_point', id: p.id }, changes: redactSnapshot({ kind: 'revoke', source: outcome }, { entity: 'consent_event' }), reason: 'CALL_OUTCOME' });
}
