// Provider status callbacks for outbound messages (R-GATE-8: status only moves forward; out-of-order
// safe), plus what a callback implies for consent and behaviour:
//   - every callback is stored once in message_status_events (unique provider_event_ref)
//   - dispatching/dispatch_unknown < sent < delivered < terminal (failed, undelivered, bounced): a late
//     'sent' after 'delivered' changes nothing; nothing leaves a terminal failure
//   - a carrier "recipient opted out" error is a provider_report revoke (R-CONSENT-12)
//   - an email hard bounce is a hard_bounce suppression (point marked bouncing); a complaint is a
//     spam_complaint suppression (never liftable, R-CONSENT-9)
//   - opens and clicks are behaviour SIGNALS, never facts (R-CONSENT-19: Apple MPP prefetches opens)
import type { ContactId, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, hmacBytes, lockContact, recordConsentEvent, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { emitSendResultInTx, isAiIsaMessage } from '../isa/send.js';
import { PROVIDER_OPT_OUT_CODES, hint } from './dispatch.js';
import * as msgs from './repos/messages.js';
import { LEDGER_SYSTEM, type CommsDeps } from './types.js';
import { SENDER_NOT_VERIFIED, isSenderNotVerified, markSenderNotVerified } from './telephonySafeguards.js';

export type MappedStatus = 'sent' | 'delivered' | 'failed' | 'undelivered' | 'bounced' | 'complained' | 'opened' | 'clicked';

const RANK: Record<string, number> = { dispatching: 0, dispatch_unknown: 0, sent: 1, delivered: 2, failed: 3, undelivered: 3, bounced: 3 };

/**
 * A provider message status → ours (null: ignored, nothing recorded). R-TWL-4 (lane telephony-safeguards): Twilio's
 * `canceled` (a scheduled message cancelled before it left) is a failure (reason PROVIDER_CANCELED); `scheduled` is
 * ignored (the platform never schedules at Twilio, so it says nothing new); `read` (WhatsApp/RCS read receipt) is
 * delivered.
 */
export function mapTelephonyStatus(s: string): MappedStatus | null {
  switch (s.toLowerCase()) {
    case 'sent':
    case 'queued':
    case 'accepted':
    case 'sending':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    case 'scheduled':
    default:
      return null;
  }
}

/** The status_reason of a failure the provider reported (R-TWL-4: a canceled message is PROVIDER_CANCELED). */
function failureReason(next: string, providerStatus: string, errorCode: string | null | undefined): string {
  if (isSenderNotVerified(errorCode)) return SENDER_NOT_VERIFIED;
  if (next === 'failed' && providerStatus.toLowerCase() === 'canceled') return 'PROVIDER_CANCELED';
  return `PROVIDER_${next.toUpperCase()}`;
}

export interface StatusEvent {
  providerEventRef: string;
  message: { id: string } | { providerRef: string };
  providerStatus: string;
  mapped: MappedStatus;
  errorCode?: string | null;
  occurredAt: Instant;
}

export type StatusResult = { kind: 'applied'; messageId: string; status: string } | { kind: 'recorded'; messageId: string; status: string } | { kind: 'duplicate' } | { kind: 'unknown_message' };

/** Forward-only status move (pure; exported for tests). */
export function nextStatus(current: string, mapped: MappedStatus): string | null {
  const to = RANK[mapped];
  const from = RANK[current];
  if (to === undefined || from === undefined) return null;
  if (from === 3) return null;
  return to > from ? mapped : null;
}

export async function applyMessageStatus(actor: SystemActor, e: StatusEvent, deps: CommsDeps): Promise<StatusResult> {
  return withTenantTx(actor, (tx, now) => applyInTx(tx, actor, e, now, deps), { db: deps.db, retries: 2 });
}

async function applyInTx(tx: Tx, actor: SystemActor, e: StatusEvent, now: Instant, deps: CommsDeps): Promise<StatusResult> {
  const peek = 'id' in e.message ? await msgs.messageById(tx, e.message.id) : await msgs.messageByProviderRef(tx, e.message.providerRef);
  if (!peek || peek.direction !== 'outbound') return { kind: 'unknown_message' };
  await lockContact(tx, peek.contactId as ContactId);
  const m = (await msgs.lockMessage(tx, peek.id))!;
  const inserted = await msgs.insertStatusEvent(tx, {
    id: deps.ids.next<'MessageStatusEventId'>(),
    messageId: m.id,
    providerStatus: e.providerStatus,
    mappedStatus: e.mapped,
    errorCode: e.errorCode ?? null,
    providerEventRef: e.providerEventRef,
    occurredAt: e.occurredAt,
  });
  if (!inserted) return { kind: 'duplicate' };

  const channel = m.channel === 'email' ? 'email' : 'sms';
  if (e.mapped === 'opened' || e.mapped === 'clicked') {
    await sql`
      INSERT INTO behavior_events (tenant_id, id, contact_id, event_type, reliability, source, occurred_at, dedupe_key, payload)
      VALUES (app.tenant_id(), ${deps.ids.next<'BehaviorEventId'>()}, ${m.contactId}, ${e.mapped === 'opened' ? 'email_opened' : 'email_clicked'}, 'signal',
              'email_provider', ${toIso(e.occurredAt)}::timestamptz, ${`email:${e.providerEventRef}`}, ${JSON.stringify({ messageId: m.id })}::jsonb)
      ON CONFLICT (tenant_id, dedupe_key) DO NOTHING`.execute(tx);
    return { kind: 'recorded', messageId: m.id, status: m.status };
  }
  if (e.mapped === 'complained') {
    await suppress(tx, deps, actor.tenantId, m, 'spam_complaint', e.providerEventRef);
    // a spam complaint is the person's opt-out (never liftable, R-CONSENT-9): audited (R-AUDIT-5)
    await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'message', id: m.id }, reason: 'SPAM_COMPLAINT' });
    return { kind: 'recorded', messageId: m.id, status: m.status };
  }
  const next = nextStatus(m.status, e.mapped);
  if (next) await msgs.setStatus(tx, m.id, next, next === 'delivered' || next === 'sent' ? null : failureReason(next, e.providerStatus, e.errorCode), e.errorCode ?? null);
  // R-ISA-14 (D12 proposed; b12 review B12X-5): a later carrier status of an AI ISA message reaches its machine (2
  // undelivered in a row end care delivery_problem, E518), once per message and status
  if (next && isAiIsaMessage(m.actionCategory)) await emitSendResultInTx(tx, m.id, next);
  // R-TWL-9: an unverified sender reported by the status callback marks the number's registration not ready in THIS
  // transaction (never an opt-out; the message is not retried or reconciled: a terminal failure)
  if (next && (e.mapped === 'failed' || e.mapped === 'undelivered') && channel === 'sms' && isSenderNotVerified(e.errorCode)) {
    await markSenderNotVerified(tx, actor, deps, m.phoneNumberId, e.errorCode!, m.id, now);
  }
  if ((e.mapped === 'failed' || e.mapped === 'undelivered') && e.errorCode && PROVIDER_OPT_OUT_CODES.has(e.errorCode)) {
    const env = deps.envelope.inTx(tx, actor.tenantId as TenantId);
    const hmac = Buffer.from(await env.hmacAddress(actor.tenantId as TenantId, m.toAddress)).toString('hex');
    await recordConsentEvent(tx, {
      id: deps.ids.next<'ConsentEventId'>(), addressKind: channel === 'email' ? 'email' : 'phone', addressHmac: hmac, addressHint: hint(m.toAddress),
      channel, purpose: 'all', eventType: 'revoke', level: 'none', source: 'provider_report', occurredAt: now, contactId: m.contactId,
      actor: LEDGER_SYSTEM, disclosureId: null, evidenceObjectId: null, evidenceMessageId: m.id, evidenceCallId: null, evidenceCallOffsetMs: null,
      evidence: { providerCode: e.errorCode }, imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
    });
    if (channel === 'sms') await msgs.cancelQueuedSmsTo(tx, [m.toAddress], 'PROVIDER_OPTED_OUT');
    await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'message', id: m.id }, reason: 'PROVIDER_REPORT' });
  }
  if (e.mapped === 'bounced' && channel === 'email') await suppress(tx, deps, actor.tenantId, m, 'hard_bounce', e.providerEventRef);
  return next ? { kind: 'applied', messageId: m.id, status: next } : { kind: 'recorded', messageId: m.id, status: m.status };
}

async function suppress(tx: Tx, deps: CommsDeps, tenantId: string, m: msgs.MessageRow, reason: 'hard_bounce' | 'spam_complaint', ref: string): Promise<void> {
  const env = deps.envelope.inTx(tx, tenantId as TenantId);
  const hmac = Buffer.from(await env.hmacAddress(tenantId as TenantId, m.toAddress)).toString('hex');
  await sql`
    INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref)
    VALUES (app.tenant_id(), ${deps.ids.next<'SuppressionId'>()}, 'email', ${hmacBytes(hmac)}, ${hint(m.toAddress)}, 'email', ${reason},
            ${JSON.stringify({ messageId: m.id, providerEventRef: ref })}::jsonb)
    ON CONFLICT (tenant_id, address_hmac, channel, reason) WHERE lifted_at IS NULL DO NOTHING`.execute(tx);
  if (reason === 'hard_bounce') {
    await sql`UPDATE contact_points SET status = 'bouncing' WHERE tenant_id = app.tenant_id() AND address_hmac = ${hmacBytes(hmac)} AND status = 'active'`.execute(tx);
  }
}
