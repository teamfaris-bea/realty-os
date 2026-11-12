// Reads behind the reachability summary and the "why wasn't this sent" lines (lane optout-visibility).
// A fixed number of queries per request, never one per point or per message (no N+1), all under the
// caller's RLS: consent_events are visible only for the caller's visible contact points or tenant-wide
// roles, import batches only where import_records are visible, user names only for members.
import type { ConsentStateRow, SuppressionReason } from '@realty/core/compliance';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, hmacBytes } from '@realty/db';
import { sql } from 'kysely';
import type { PointRow } from './gate.js';

/** consent_state rows for any of these addresses, every channel and purpose. */
export async function consentStateFor(tx: Tx, hmacs: readonly string[]): Promise<ConsentStateRow[]> {
  if (hmacs.length === 0) return [];
  const r = await sql<{ channel: ConsentStateRow['channel']; purpose: ConsentStateRow['purpose']; address_hmac: Buffer; status: ConsentStateRow['status']; consent_level: ConsentStateRow['level']; basis_event_id: string | null; expires_at: Date | null; ledger_event_count: number }>`
    SELECT channel, purpose, address_hmac, status, consent_level, basis_event_id, expires_at, ledger_event_count
      FROM consent_state WHERE tenant_id = app.tenant_id() AND address_hmac = ANY (${hmacs.map(hmacBytes)}::bytea[])`.execute(tx);
  return r.rows.map((x) => ({
    channel: x.channel,
    purpose: x.purpose,
    addressHmac: Buffer.from(x.address_hmac).toString('hex'),
    status: x.status,
    level: x.consent_level,
    basisEventId: x.basis_event_id,
    expiresAt: x.expires_at ? instantFromDate(x.expires_at) : null,
    ledgerEventCount: x.ledger_event_count,
  }));
}

/** What the ledger says about one opt-out event (the evidence behind a revoked row). */
export interface RevokeEventFacts {
  id: string;
  channel: 'sms' | 'voice' | 'email' | 'web_chat';
  purpose: 'marketing' | 'informational' | 'all';
  source: string;
  occurredAt: Date;
  addressHint: string;
  actorUserId: string | null;
  actorName: string | null;
  evidenceMessageId: string | null;
  /** the keyword the person texted (messages.opt_out_keyword of the evidence message), when visible */
  keyword: string | null;
  evidenceCallId: string | null;
  evidenceKind: string | null;
  callOutcome: string | null;
  imported: boolean;
  importBatchId: string | null;
}

export async function revokeEvents(tx: Tx, ids: readonly string[]): Promise<Map<string, RevokeEventFacts>> {
  const uniq = [...new Set(ids)];
  if (uniq.length === 0) return new Map();
  const r = await sql<{
    id: string;
    channel: RevokeEventFacts['channel'];
    purpose: RevokeEventFacts['purpose'];
    source: string;
    occurred_at: Date;
    address_hint: string;
    actor_user_id: string | null;
    actor_name: string | null;
    evidence_message_id: string | null;
    keyword: string | null;
    evidence_call_id: string | null;
    evidence_kind: string | null;
    call_outcome: string | null;
    imported: boolean;
    import_batch_id: string | null;
  }>`
    SELECT e.id, e.channel, e.purpose, e.source, e.occurred_at, e.address_hint, e.actor_user_id, u.display_name AS actor_name,
           e.evidence_message_id, im.opt_out_keyword AS keyword, e.evidence_call_id, e.evidence ->> 'kind' AS evidence_kind,
           e.evidence ->> 'call_outcome' AS call_outcome, e.imported, st.batch_id AS import_batch_id
      FROM consent_events e
      LEFT JOIN messages im ON im.tenant_id = e.tenant_id AND im.id = e.evidence_message_id
      LEFT JOIN users u ON u.id = e.actor_user_id
      LEFT JOIN import_records ir ON ir.tenant_id = e.tenant_id AND ir.id = e.import_record_id
      LEFT JOIN import_stages st ON st.tenant_id = ir.tenant_id AND st.id = ir.stage_id
     WHERE e.tenant_id = app.tenant_id() AND e.id = ANY (${uniq}::uuid[])`.execute(tx);
  return new Map(
    r.rows.map((x) => [
      x.id,
      {
        id: x.id,
        channel: x.channel,
        purpose: x.purpose,
        source: x.source,
        occurredAt: x.occurred_at,
        addressHint: x.address_hint,
        actorUserId: x.actor_user_id,
        actorName: x.actor_name,
        evidenceMessageId: x.evidence_message_id,
        keyword: x.keyword,
        evidenceCallId: x.evidence_call_id,
        evidenceKind: x.evidence_kind,
        callOutcome: x.call_outcome,
        imported: x.imported,
        importBatchId: x.import_batch_id,
      },
    ]),
  );
}

export interface SuppressionFacts {
  id: string;
  addressHmac: string;
  addressHint: string;
  channel: 'sms' | 'voice' | 'email' | 'all';
  reason: SuppressionReason;
  createdAt: Date;
  liftedAt: Date | null;
  createdByUserId: string | null;
  createdByName: string | null;
  importBatchId: string | null;
}

/** Every suppression (lifted ones included, flagged) of any of these addresses. */
export async function suppressionsFor(tx: Tx, hmacs: readonly string[]): Promise<SuppressionFacts[]> {
  if (hmacs.length === 0) return [];
  const r = await sql<{ id: string; address_hmac: Buffer; address_hint: string; channel: SuppressionFacts['channel']; reason: SuppressionReason; created_at: Date; lifted_at: Date | null; created_by_user_id: string | null; created_by_name: string | null; import_batch_id: string | null }>`
    SELECT s.id, s.address_hmac, s.address_hint, s.channel, s.reason, s.created_at, s.lifted_at, s.created_by_user_id,
           u.display_name AS created_by_name, st.batch_id AS import_batch_id
      FROM suppressions s
      LEFT JOIN users u ON u.id = s.created_by_user_id
      LEFT JOIN import_records ir ON ir.tenant_id = s.tenant_id AND ir.id = s.import_record_id
      LEFT JOIN import_stages st ON st.tenant_id = ir.tenant_id AND st.id = ir.stage_id
     WHERE s.tenant_id = app.tenant_id() AND s.address_hmac = ANY (${hmacs.map(hmacBytes)}::bytea[])
     ORDER BY s.created_at, s.id`.execute(tx);
  return r.rows.map((x) => ({
    id: x.id,
    addressHmac: Buffer.from(x.address_hmac).toString('hex'),
    addressHint: x.address_hint,
    channel: x.channel,
    reason: x.reason,
    createdAt: x.created_at,
    liftedAt: x.lifted_at,
    createdByUserId: x.created_by_user_id,
    createdByName: x.created_by_name,
    importBatchId: x.import_batch_id,
  }));
}

/** The stored gate inputs of these blocked messages (messages.gate_decision_id → gate_decisions). */
export async function blockedDecisionInputs(tx: Tx, messageIds: readonly string[]): Promise<Map<string, { inputs: unknown; evaluatedAt: Date }>> {
  if (messageIds.length === 0) return new Map();
  const r = await sql<{ message_id: string; inputs: unknown; evaluated_at: Date }>`
    SELECT m.id AS message_id, d.inputs, d.evaluated_at
      FROM messages m JOIN gate_decisions d ON d.tenant_id = m.tenant_id AND d.id = m.gate_decision_id
     WHERE m.tenant_id = app.tenant_id() AND m.id = ANY (${[...messageIds]}::uuid[])`.execute(tx);
  return new Map(r.rows.map((x) => [x.message_id, { inputs: x.inputs, evaluatedAt: x.evaluated_at }]));
}

/** Facts the thread needs about outbound messages: the reason, the sender, the held state. */
export interface MessageStatusFacts {
  id: string;
  status: string;
  statusReason: string | null;
  channel: string;
  initiator: string;
  initiatedByUserId: string | null;
  providerErrorCode: string | null;
}

export async function messageStatusFacts(tx: Tx, ids: readonly string[]): Promise<Map<string, MessageStatusFacts>> {
  if (ids.length === 0) return new Map();
  const r = await sql<{ id: string; status: string; status_reason: string | null; channel: string; initiator: string; initiated_by_user_id: string | null; provider_error_code: string | null }>`
    SELECT id, status, status_reason, channel, initiator, initiated_by_user_id, provider_error_code
      FROM messages WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return new Map(r.rows.map((x) => [x.id, { id: x.id, status: x.status, statusReason: x.status_reason, channel: x.channel, initiator: x.initiator, initiatedByUserId: x.initiated_by_user_id, providerErrorCode: x.provider_error_code }]));
}

/** The points of many contacts (removed ones excluded), in the order g.contactPoints gives for one. */
export async function pointsForContacts(tx: Tx, contactIds: readonly string[]): Promise<Map<string, PointRow[]>> {
  const out = new Map<string, PointRow[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return out;
  const r = await sql<{ id: string; contact_id: string; kind: 'phone' | 'email'; address: string; address_hmac: Buffer; status: PointRow['status']; line_type: PointRow['lineType']; timezone: string | null; is_primary: boolean }>`
    SELECT id, contact_id, kind, address, address_hmac, status, line_type, timezone, is_primary FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...contactIds]}::uuid[]) AND removed_at IS NULL
     ORDER BY contact_id, is_primary DESC, created_at, id`.execute(tx);
  for (const x of r.rows) out.get(x.contact_id)?.push({ id: x.id, contactId: x.contact_id, kind: x.kind, address: x.address, hmac: Buffer.from(x.address_hmac).toString('hex'), status: x.status, lineType: x.line_type, timezone: x.timezone, isPrimary: x.is_primary });
  return out;
}

/**
 * R-PAR-12: per contact, the HMACs of its REMOVED phones whose opt-out still counts (removed for any
 * reason but a confirmed wrong number). With the live phones of pointsForContacts this is exactly the
 * dispatch guards' fan-out set (`kind = 'phone' AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM
 * 'wrong_number')`, g.optOutFanoutPhoneHmacs for one contact). Only for the fan-out: never listed.
 */
export async function removedFanoutPhones(tx: Tx, contactIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return out;
  const r = await sql<{ contact_id: string; h: Buffer }>`
    SELECT DISTINCT contact_id, address_hmac AS h FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...contactIds]}::uuid[]) AND kind = 'phone'
       AND removed_at IS NOT NULL AND removed_reason IS DISTINCT FROM 'wrong_number'
     ORDER BY contact_id, address_hmac`.execute(tx);
  for (const x of r.rows) out.get(x.contact_id)?.push(Buffer.from(x.h).toString('hex'));
  return out;
}

/**
 * R-CHAN-2 (review optouts/F1 of batch 6): per contact, the person-level do-not-contact the send-time gate reads
 * (repos/gate.ts personDoNotContact: any record of the person, app.contact_person_ids, under the caller's RLS), with
 * the earliest one's ledger event and instant. Contacts whose person has none are absent. One query for the page.
 */
export async function personDoNotContactFor(tx: Tx, contactIds: readonly string[]): Promise<Map<string, { eventId: string | null; at: Date }>> {
  if (contactIds.length === 0) return new Map();
  const r = await sql<{ contact_id: string; event_id: string | null; at: Date }>`
    SELECT c.id AS contact_id, d.do_not_contact_event_id AS event_id, d.do_not_contact_at AS at
      FROM unnest(${[...contactIds]}::uuid[]) AS c(id)
      CROSS JOIN LATERAL (
        SELECT x.do_not_contact_event_id, x.do_not_contact_at FROM contacts x
         WHERE x.tenant_id = app.tenant_id() AND x.do_not_contact_at IS NOT NULL
           AND x.id = ANY ((SELECT app.contact_person_ids(app.tenant_id(), c.id))::uuid[])
         ORDER BY x.do_not_contact_at, x.id LIMIT 1) d`.execute(tx);
  return new Map(r.rows.map((x) => [x.contact_id, { eventId: x.event_id, at: x.at }]));
}

/**
 * R-CHAN-4 (review optouts/F4 of batch 6): per contact, the HMACs of the person's website-chat identities whose
 * opt-out blocks a chat reply (repos/gate.ts chatFanoutHmacs, the 0043 guard's `others` for web_chat): every record of
 * the person, live or removed, except one removed as a confirmed wrong number. Only for the fan-out: never listed.
 */
export async function chatFanoutFor(tx: Tx, contactIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return out;
  const r = await sql<{ contact_id: string; h: Buffer }>`
    SELECT DISTINCT c.id AS contact_id, p.address_hmac AS h
      FROM unnest(${[...contactIds]}::uuid[]) AS c(id)
      JOIN contact_points p ON p.tenant_id = app.tenant_id() AND p.kind = 'web_chat'
                           AND p.contact_id = ANY ((SELECT app.contact_person_ids(app.tenant_id(), c.id))::uuid[])
                           AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')
     ORDER BY 1, 2`.execute(tx);
  for (const x of r.rows) out.get(x.contact_id)?.push(Buffer.from(x.h).toString('hex'));
  return out;
}

/**
 * Of these contacts, the ones whose detail the caller sees, with what classifies a human message's purpose
 * now (repos/contacts.dealOrAppointmentContext and the conversation's last inbound, batched).
 */
export async function purposeFacts(tx: Tx, contactIds: readonly string[]): Promise<Map<string, { lastInboundAt: Date | null; dealOrAppointmentContext: boolean }>> {
  if (contactIds.length === 0) return new Map();
  const r = await sql<{ id: string; last_inbound_at: Date | null; ctx: boolean }>`
    SELECT c.id, cv.last_inbound_at,
           EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = c.tenant_id AND d.primary_contact_id = c.id AND d.stage NOT IN ('closed','lost'))
        OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                    WHERE dc.tenant_id = c.tenant_id AND dc.contact_id = c.id AND d.stage NOT IN ('closed','lost'))
        OR EXISTS (SELECT 1 FROM appointments a WHERE a.tenant_id = c.tenant_id AND a.contact_id = c.id
                    AND a.status NOT IN ('canceled') AND a.starts_at > now() - interval '7 days') AS ctx
      FROM contacts c LEFT JOIN conversations cv ON cv.tenant_id = c.tenant_id AND cv.contact_id = c.id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${[...contactIds]}::uuid[]) AND c.deleted_at IS NULL
       AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  return new Map(r.rows.map((x) => [x.id, { lastInboundAt: x.last_inbound_at, dealOrAppointmentContext: x.ctx }]));
}
