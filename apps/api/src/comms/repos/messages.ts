// Message, conversation and status-event persistence of api/comms (caller's RLS applies).
import type { Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { type Tx, hmacBytes } from '@realty/db';
import { sql } from 'kysely';

export interface MessageRow {
  id: string;
  conversationId: string;
  contactId: string;
  channel: 'sms' | 'mms' | 'email' | 'web_chat';
  direction: 'inbound' | 'outbound';
  status: string;
  statusReason: string | null;
  initiator: 'human' | 'assistant' | 'system' | 'client' | 'import';
  initiatedByUserId: string | null;
  purpose: 'marketing' | 'informational' | null;
  actionCategory: string;
  assistantActionId: string | null;
  playbookStepRunId: string | null;
  phoneNumberId: string | null;
  emailIdentityId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  body: string;
  pinnedInboundSeq: number | null;
  scheduledFor: Instant | null;
  dispatchedAt: Instant | null;
  gateDecisionId: string | null;
  providerMessageRef: string | null;
  imported: boolean;
  /** the bulk action of a bulk send (parity module 63; never a touch, R-PAR-37); null otherwise */
  bulkActionId: string | null;
  /** module 29: the open-house invite this message is (R-MKT-8; a mass send: never a touch, R-OWN-14); null otherwise */
  marketingPieceId: string | null;
  /** module 22: the widget connection a web-chat message goes through (messages_platform_sender); null otherwise */
  integrationConnectionId: string | null;
}

interface Raw {
  id: string;
  conversation_id: string;
  contact_id: string;
  channel: MessageRow['channel'];
  direction: MessageRow['direction'];
  status: string;
  status_reason: string | null;
  initiator: MessageRow['initiator'];
  initiated_by_user_id: string | null;
  purpose: MessageRow['purpose'];
  action_category: string;
  assistant_action_id: string | null;
  playbook_step_run_id: string | null;
  phone_number_id: string | null;
  email_identity_id: string | null;
  from_address: string;
  to_address: string;
  subject: string | null;
  body: string;
  pinned_inbound_seq: string | null;
  scheduled_for: Date | null;
  dispatched_at: Date | null;
  gate_decision_id: string | null;
  provider_message_ref: string | null;
  imported: boolean;
  bulk_action_id: string | null;
  marketing_piece_id: string | null;
  integration_connection_id: string | null;
}

const COLS = sql`id, conversation_id, contact_id, channel, direction, status, status_reason, initiator, initiated_by_user_id, purpose,
  action_category, assistant_action_id, playbook_step_run_id, phone_number_id, email_identity_id, from_address, to_address, subject,
  body, pinned_inbound_seq, scheduled_for, dispatched_at, gate_decision_id, provider_message_ref, imported, bulk_action_id, marketing_piece_id, integration_connection_id`;

function row(x: Raw): MessageRow {
  return {
    id: x.id,
    conversationId: x.conversation_id,
    contactId: x.contact_id,
    channel: x.channel,
    direction: x.direction,
    status: x.status,
    statusReason: x.status_reason,
    initiator: x.initiator,
    initiatedByUserId: x.initiated_by_user_id,
    purpose: x.purpose,
    actionCategory: x.action_category,
    assistantActionId: x.assistant_action_id,
    playbookStepRunId: x.playbook_step_run_id,
    phoneNumberId: x.phone_number_id,
    emailIdentityId: x.email_identity_id,
    fromAddress: x.from_address,
    toAddress: x.to_address,
    subject: x.subject,
    body: x.body,
    pinnedInboundSeq: x.pinned_inbound_seq === null ? null : Number(x.pinned_inbound_seq),
    scheduledFor: x.scheduled_for ? instantFromDate(x.scheduled_for) : null,
    dispatchedAt: x.dispatched_at ? instantFromDate(x.dispatched_at) : null,
    gateDecisionId: x.gate_decision_id,
    providerMessageRef: x.provider_message_ref,
    imported: x.imported,
    bulkActionId: x.bulk_action_id,
    marketingPieceId: x.marketing_piece_id,
    integrationConnectionId: x.integration_connection_id,
  };
}

export async function messageById(tx: Tx, id: string): Promise<MessageRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM messages WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** The message row locked for TX1 (after app.lock_contact). Needs UPDATE visibility (own or system). */
export async function lockMessage(tx: Tx, id: string): Promise<MessageRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM messages WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function messageByIdempotencyKey(tx: Tx, key: string): Promise<MessageRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM messages WHERE tenant_id = app.tenant_id() AND idempotency_key = ${key}`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

/** The conversation of a contact, created when missing (one thread per person). */
export async function ensureConversation(tx: Tx, id: string, contactId: string, replyTokenHash: Buffer | null): Promise<string> {
  await sql`
    INSERT INTO conversations (tenant_id, id, contact_id, reply_token_hash) VALUES (app.tenant_id(), ${id}, ${contactId}, ${replyTokenHash})
    ON CONFLICT (tenant_id, contact_id) DO NOTHING`.execute(tx);
  const r = await sql<{ id: string }>`SELECT id FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  if (!r.rows[0]) throw new Error('conversation not visible');
  return r.rows[0].id;
}

export async function setReplyTokenIfMissing(tx: Tx, conversationId: string, hash: Buffer): Promise<void> {
  await sql`UPDATE conversations SET reply_token_hash = ${hash} WHERE tenant_id = app.tenant_id() AND id = ${conversationId} AND reply_token_hash IS NULL`.execute(tx);
}

export interface OutboundInsert {
  id: string;
  conversationId: string;
  contactId: string;
  channel: 'sms' | 'email' | 'web_chat';
  phoneNumberId: string | null;
  emailIdentityId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  body: string;
  status: 'queued' | 'scheduled';
  scheduledFor: Instant | null;
  initiator: 'human' | 'assistant' | 'system';
  initiatedByUserId: string | null;
  purpose: 'marketing' | 'informational';
  actionCategory: string;
  assistantActionId: string | null;
  playbookStepRunId: string | null;
  pinnedInboundSeq: number | null;
  idempotencyKey: string | null;
  occurredAt: Instant;
  /** parity module 63: a bulk send's action (messages_bulk_guard checks it); absent = none */
  bulkActionId?: string | null;
  /** module 22: a web-chat message's widget connection (messages_platform_sender); absent = none */
  integrationConnectionId?: string | null;
  /** module 29: an open-house invite recipient (R-MKT-8; the dispatch guard sends it only from an approved invite version) */
  marketingPieceId?: string | null;
}

/**
 * Inserts the outbound row; false when its idempotency key already exists (a concurrent or repeated
 * command). ON CONFLICT waits for a concurrent inserter, so the caller can then read the winner's row.
 */
export async function insertOutbound(tx: Tx, m: OutboundInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, email_identity_id, from_address,
      to_address, subject, body, status, initiator, initiated_by_user_id, purpose, action_category, assistant_action_id, playbook_step_run_id,
      pinned_inbound_seq, idempotency_key, scheduled_for, occurred_at, bulk_action_id, integration_connection_id, marketing_piece_id)
    VALUES (app.tenant_id(), ${m.id}, ${m.conversationId}, ${m.contactId}, ${m.channel}, 'outbound', ${m.phoneNumberId}, ${m.emailIdentityId},
      ${m.fromAddress}, ${m.toAddress}, ${m.subject}, ${m.body}, ${m.status}, ${m.initiator}, ${m.initiatedByUserId}, ${m.purpose},
      ${m.actionCategory}, ${m.assistantActionId}, ${m.playbookStepRunId}, ${m.pinnedInboundSeq}, ${m.idempotencyKey},
      ${m.scheduledFor === null ? null : toIso(m.scheduledFor)}::timestamptz, ${toIso(m.occurredAt)}::timestamptz, ${m.bulkActionId ?? null}::uuid,
      ${m.integrationConnectionId ?? null}::uuid, ${m.marketingPieceId ?? null}::uuid)
    ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

/**
 * TX1 allow: dispatching + dispatched_at (DB CHECK, F2). No gate decision is linked (0013: only a blocked
 * send writes one); the dispatch guard re-checks the opt-out and the assistant autonomy itself.
 */
export async function markDispatching(tx: Tx, id: string, now: Instant): Promise<void> {
  await sql`
    UPDATE messages SET status = 'dispatching', status_reason = NULL, gate_decision_id = NULL, dispatched_at = ${toIso(now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('scheduled','queued')`.execute(tx);
}

/** The send-time purpose of a human message (only ever tightened to marketing). */
export async function setPurpose(tx: Tx, id: string, purpose: 'marketing' | 'informational'): Promise<void> {
  await sql`UPDATE messages SET purpose = ${purpose} WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('scheduled','queued')`.execute(tx);
}

export async function markBlocked(tx: Tx, id: string, decisionId: string, reason: string): Promise<void> {
  await sql`
    UPDATE messages SET status = 'blocked', status_reason = ${reason.slice(0, 100)}, gate_decision_id = ${decisionId}
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('scheduled','queued')`.execute(tx);
}

export async function markCanceled(tx: Tx, id: string, reason: string, decisionId: string | null): Promise<void> {
  await sql`
    UPDATE messages SET status = 'canceled', status_reason = ${reason}, gate_decision_id = COALESCE(${decisionId}, gate_decision_id)
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('scheduled','queued')`.execute(tx);
}

/** A human send waits for a re-tap: the client replied since it was scheduled (E27). */
export async function markAwaitingTap(tx: Tx, id: string, reason: string, decisionId: string | null): Promise<void> {
  await sql`
    UPDATE messages SET status = 'queued', scheduled_for = NULL, status_reason = ${reason}, gate_decision_id = COALESCE(${decisionId}, gate_decision_id)
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('scheduled','queued')`.execute(tx);
}

/** The re-tap pins the conversation's current inbound sequence (the human has now seen the reply). */
export async function repin(tx: Tx, id: string, seq: number): Promise<void> {
  await sql`UPDATE messages SET pinned_inbound_seq = ${seq} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/**
 * TX2: dispatching → sent. The provider ref is stored even when a status callback already moved the
 * message on (out-of-order callbacks); the status itself only moves forward.
 */
export async function markSent(tx: Tx, id: string, provider: string, ref: string, rfcMessageIdSha256: Buffer | null = null): Promise<boolean> {
  // module 22 (R-GMAIL-12): the Message-ID hash the provider confirmed, set once, as the system (TX2): the
  // messages_rfc_guard trigger refuses it from anyone else and refuses any later change
  const r = await sql`
    UPDATE messages SET provider = COALESCE(provider, ${provider}), provider_message_ref = COALESCE(provider_message_ref, ${ref}),
           rfc_message_id_sha256 = COALESCE(rfc_message_id_sha256, ${rfcMessageIdSha256}),
           status = CASE WHEN status IN ('dispatching','dispatch_unknown') THEN 'sent' ELSE status END,
           status_reason = CASE WHEN status IN ('dispatching','dispatch_unknown') THEN NULL ELSE status_reason END
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND direction = 'outbound'`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function markFailed(tx: Tx, id: string, reason: string, code: string | null): Promise<boolean> {
  const r = await sql`
    UPDATE messages SET status = 'failed', status_reason = ${reason.slice(0, 100)}, provider_error_code = ${code}
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status IN ('dispatching','dispatch_unknown')`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function markUnknown(tx: Tx, id: string, reason: string): Promise<boolean> {
  const r = await sql`
    UPDATE messages SET status = 'dispatch_unknown', status_reason = ${reason}
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'dispatching'`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function touchConversationOutbound(tx: Tx, conversationId: string, phoneNumberId: string | null, now: Instant): Promise<void> {
  await sql`
    UPDATE conversations SET last_outbound_at = ${toIso(now)}::timestamptz,
           sticky_phone_number_id = COALESCE(sticky_phone_number_id, ${phoneNumberId})
     WHERE tenant_id = app.tenant_id() AND id = ${conversationId}`.execute(tx);
}

/** The first non-imported outbound of the conversation (the first assistant message adds STOP + brokerage, R-AST-11). */
export async function hasPriorOutbound(tx: Tx, conversationId: string, excludeId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM messages WHERE tenant_id = app.tenant_id() AND conversation_id = ${conversationId} AND direction = 'outbound'
                     AND NOT imported AND id <> ${excludeId} AND status IN ('dispatching','sent','delivered','dispatch_unknown')) AS x`.execute(tx);
  return r.rows[0]?.x ?? false;
}

// ---- status callbacks (out-of-order safe) -----------------------------------------------------------

export async function insertStatusEvent(tx: Tx, e: { id: string; messageId: string; providerStatus: string; mappedStatus: string; errorCode: string | null; providerEventRef: string; occurredAt: Instant }): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO message_status_events (tenant_id, id, message_id, provider_status, mapped_status, error_code, provider_event_ref, occurred_at)
    VALUES (app.tenant_id(), ${e.id}, ${e.messageId}, ${e.providerStatus.slice(0, 60)}, ${e.mappedStatus}, ${e.errorCode}, ${e.providerEventRef},
            ${toIso(e.occurredAt)}::timestamptz)
    ON CONFLICT (tenant_id, provider_event_ref) DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export async function messageByProviderRef(tx: Tx, ref: string): Promise<MessageRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM messages WHERE tenant_id = app.tenant_id() AND provider_message_ref = ${ref} FOR UPDATE`.execute(tx);
  return r.rows[0] ? row(r.rows[0]) : null;
}

export async function setStatus(tx: Tx, id: string, status: string, reason: string | null, code: string | null): Promise<void> {
  await sql`
    UPDATE messages SET status = ${status}, status_reason = COALESCE(${reason}, status_reason), provider_error_code = COALESCE(${code}, provider_error_code)
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** Cancel queued/scheduled outbound SMS to these addresses, tenant-wide (STOP, R-CONSENT-7). Returns ids. */
export async function cancelQueuedSmsTo(tx: Tx, addresses: readonly string[], reason: string): Promise<string[]> {
  if (addresses.length === 0) return [];
  const r = await sql<{ id: string }>`
    UPDATE messages SET status = 'canceled', status_reason = ${reason}
     WHERE tenant_id = app.tenant_id() AND direction = 'outbound' AND NOT imported AND channel IN ('sms','mms')
       AND status IN ('scheduled','queued') AND to_address = ANY (${addresses}::text[])
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Cancel queued assistant messages of these contacts (pause on reply, R-AST-9). Human-scheduled ones stay. */
export async function cancelQueuedAssistant(tx: Tx, contactIds: readonly string[], reason: string): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const r = await sql<{ id: string }>`
    UPDATE messages SET status = 'canceled', status_reason = ${reason}
     WHERE tenant_id = app.tenant_id() AND direction = 'outbound' AND NOT imported AND initiator = 'assistant'
       AND status IN ('scheduled','queued') AND contact_id = ANY (${contactIds}::uuid[])
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Last outbound messages of a contact (handback "what was sent" evidence). */
export async function lastOutbound(tx: Tx, contactId: string, limit: number): Promise<{ id: string; body: string; initiator: string; status: string; dispatchedAt: Instant | null }[]> {
  const r = await sql<{ id: string; body: string; initiator: string; status: string; dispatched_at: Date | null }>`
    SELECT id, body, initiator, status, dispatched_at FROM messages
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'outbound' AND NOT imported
       AND status IN ('dispatching','sent','delivered','dispatch_unknown')
     ORDER BY dispatched_at DESC NULLS LAST, id DESC LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, body: x.body, initiator: x.initiator, status: x.status, dispatchedAt: x.dispatched_at ? instantFromDate(x.dispatched_at) : null }));
}

export interface InboundInsert {
  id: string;
  conversationId: string;
  contactId: string;
  channel: 'sms' | 'mms' | 'email' | 'web_chat';
  phoneNumberId: string | null;
  fromAddress: string;
  toAddress: string;
  subject: string | null;
  body: string;
  isAutoReply: boolean;
  optOutKeyword: string | null;
  provider: string;
  providerRef: string;
  occurredAt: Instant;
  /** module 22: a web-chat message's widget connection */
  integrationConnectionId?: string | null;
  /** module 22 (R-GMAIL-12): platform inbound email's Message-ID hash, written by the system ingestion */
  rfcMessageIdSha256?: Buffer | null;
}

export async function insertInbound(tx: Tx, m: InboundInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, subject,
      body, status, initiator, is_auto_reply, opt_out_keyword, provider, provider_message_ref, occurred_at, integration_connection_id,
      rfc_message_id_sha256)
    VALUES (app.tenant_id(), ${m.id}, ${m.conversationId}, ${m.contactId}, ${m.channel}, 'inbound', ${m.phoneNumberId}, ${m.fromAddress},
      ${m.toAddress}, ${m.subject}, ${m.body.slice(0, 20000)}, 'received', 'client', ${m.isAutoReply}, ${m.optOutKeyword}, ${m.provider},
      ${m.providerRef}, ${toIso(m.occurredAt)}::timestamptz, ${m.integrationConnectionId ?? null}::uuid, ${m.rfcMessageIdSha256 ?? null})
    ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

/** inbound_seq + 1 and last_inbound_at (drafts pin inbound_seq; R-AST-6). Returns the new seq. */
export async function bumpInbound(tx: Tx, conversationId: string, contactId: string, at: Instant): Promise<number> {
  const r = await sql<{ inbound_seq: string }>`
    UPDATE conversations SET inbound_seq = inbound_seq + 1, last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${toIso(at)}::timestamptz), ${toIso(at)}::timestamptz)
     WHERE tenant_id = app.tenant_id() AND id = ${conversationId} RETURNING inbound_seq`.execute(tx);
  await sql`UPDATE contacts SET last_inbound_at = GREATEST(COALESCE(last_inbound_at, ${toIso(at)}::timestamptz), ${toIso(at)}::timestamptz)
             WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  return Number(r.rows[0]?.inbound_seq ?? 0);
}

export async function hmacPoints(tx: Tx, hmac: string): Promise<{ id: string; contactId: string; kind: string; address: string }[]> {
  const r = await sql<{ id: string; contact_id: string; kind: string; address: string }>`
    SELECT p.id, p.contact_id, p.kind, p.address FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
     WHERE p.tenant_id = app.tenant_id() AND p.address_hmac = ${hmacBytes(hmac)} AND p.removed_at IS NULL
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
     ORDER BY p.contact_id`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, contactId: x.contact_id, kind: x.kind, address: x.address }));
}

/** module 22: cancel queued/scheduled messages of one non-SMS channel to these addresses (web-chat opt-outs). */
export async function cancelQueuedTo(tx: Tx, channel: 'web_chat', addresses: readonly string[], reason: string): Promise<string[]> {
  if (addresses.length === 0) return [];
  const r = await sql<{ id: string }>`
    UPDATE messages SET status = 'canceled', status_reason = ${reason}
     WHERE tenant_id = app.tenant_id() AND direction = 'outbound' AND NOT imported AND channel = ${channel}
       AND status IN ('scheduled','queued') AND to_address = ANY (${addresses}::text[])
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** R-NURT-5 (module 22): an inbound message cancels the scheduled trigger runs of these contacts. */
export async function cancelScheduledTriggerRuns(tx: Tx, contactIds: readonly string[]): Promise<string[]> {
  if (contactIds.length === 0) return [];
  const r = await sql<{ id: string }>`
    UPDATE playbook_step_runs SET status = 'canceled_paused', updated_at = now()
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND contact_id = ANY (${contactIds}::uuid[]) AND status = 'scheduled'
       -- module 26 (flagged): a run whose message already left (dispatching, sent, dispatch_unknown) is not canceled
       AND (message_id IS NULL OR EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = playbook_step_runs.tenant_id AND m.id = playbook_step_runs.message_id
                                            AND m.status IN ('queued','scheduled','canceled')))
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}
