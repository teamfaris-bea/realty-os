// Queries of the lead-email slice (module 22). Every write runs as the SYSTEM actor of one tenant (the webhook's
// resolved tenant, or the session's tenant after the person's role was re-read under the system actor); the 0040
// policies refuse any other writer. Reads of the review list also run as the person (RLS: Owner/Admin/Team Lead).
import type { Database, Tx } from '@realty/db';
import { withPreTenant } from '@realty/db';
import { sql } from 'kysely';

/** app.resolve_lead_email_key (pre-tenant definer; security review item in 0040). */
export async function resolveKey(db: Database, keyHash: Buffer): Promise<{ tenantId: string; connectionId: string; leadSourceId: string } | null> {
  return withPreTenant(
    async (tx) => {
      const r = await sql<{ tenant_id: string; connection_id: string; lead_source_id: string }>`SELECT * FROM app.resolve_lead_email_key(${keyHash})`.execute(tx);
      const row = r.rows[0];
      return row && r.rows.length === 1 ? { tenantId: row.tenant_id, connectionId: row.connection_id, leadSourceId: row.lead_source_id } : null;
    },
    { db },
  );
}

export interface InboxRow {
  id: string;
  lead_source_id: string;
  status: string;
  allowed_sender_domains: string[];
  connected_at: Date | null;
}

export async function inboxOfSource(tx: Tx, leadSourceId: string, o: { forUpdate?: boolean } = {}): Promise<InboxRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  return (
    await sql<InboxRow>`
      SELECT id, lead_source_id, status, allowed_sender_domains, connected_at FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'lead_email' AND lead_source_id = ${leadSourceId}::uuid AND status <> 'disconnected'
       ORDER BY created_at DESC LIMIT 1 ${lock}`.execute(tx)
  ).rows[0] ?? null;
}

export async function inboxById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<InboxRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  return (
    await sql<InboxRow>`
      SELECT id, lead_source_id, status, allowed_sender_domains, connected_at FROM integration_connections
       WHERE tenant_id = app.tenant_id() AND kind = 'lead_email' AND id = ${id}::uuid ${lock}`.execute(tx)
  ).rows[0] ?? null;
}

export async function leadSourceRow(tx: Tx, id: string): Promise<{ id: string; name: string; active: boolean } | null> {
  return (await sql<{ id: string; name: string; active: boolean }>`SELECT id, name, active FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx)).rows[0] ?? null;
}

export async function insertInbox(tx: Tx, c: { id: string; leadSourceId: string; displayName: string; domains: readonly string[]; userId: string }): Promise<void> {
  await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id, allowed_sender_domains)
            VALUES (app.tenant_id(), ${c.id}::uuid, 'lead_email', ${c.displayName}, ${c.leadSourceId}::uuid, ${[...c.domains]}::text[])`.execute(tx);
  // keyed kind: no external account; switched on at once (status machine `keyed_enabled`)
  await sql`UPDATE integration_connections SET status = 'connected', status_reason = NULL, connected_at = clock_timestamp(),
                   connected_by_user_id = ${c.userId}::uuid
             WHERE tenant_id = app.tenant_id() AND id = ${c.id}::uuid AND status = 'not_configured'`.execute(tx);
}

export async function setDomains(tx: Tx, id: string, domains: readonly string[]): Promise<void> {
  await sql`UPDATE integration_connections SET allowed_sender_domains = ${[...domains]}::text[]
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND kind = 'lead_email'`.execute(tx);
}

export interface KeyRow {
  id: string;
  key_enc: Buffer;
  created_at: Date;
}

export async function currentKey(tx: Tx, connectionId: string): Promise<KeyRow | null> {
  return (
    await sql<KeyRow>`SELECT id, key_enc, created_at FROM lead_email_inbox_keys
                       WHERE tenant_id = app.tenant_id() AND connection_id = ${connectionId}::uuid AND retired_at IS NULL`.execute(tx)
  ).rows[0] ?? null;
}

export async function retireKeys(tx: Tx, connectionId: string): Promise<number> {
  const r = await sql`UPDATE lead_email_inbox_keys SET retired_at = clock_timestamp()
                       WHERE tenant_id = app.tenant_id() AND connection_id = ${connectionId}::uuid AND retired_at IS NULL`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

export async function insertKey(tx: Tx, k: { id: string; connectionId: string; keyHash: Buffer; keyEnc: Uint8Array; userId: string }): Promise<void> {
  await sql`INSERT INTO lead_email_inbox_keys (tenant_id, id, connection_id, key_hash, key_enc, created_by_user_id)
            VALUES (app.tenant_id(), ${k.id}::uuid, ${k.connectionId}::uuid, ${k.keyHash}, ${Buffer.from(k.keyEnc)}, ${k.userId}::uuid)`.execute(tx);
}

export async function activeRole(tx: Tx, userId: string): Promise<string | null> {
  return (await sql<{ role: string }>`SELECT role FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}::uuid AND status = 'active'`.execute(tx)).rows[0]?.role ?? null;
}

/**
 * The team's own addresses (R-LEM-11 E344): active members' account emails and alert phones, and the tenant's live
 * numbers. As the system actor (memberships: members_read via app.is_member(); users: co-members; phone_numbers:
 * tenant isolation).
 */
export async function teamAddresses(tx: Tx): Promise<{ emails: string[]; phones: string[] }> {
  const members = (
    await sql<{ email: string | null; alert_phone_e164: string | null }>`
      SELECT u.email::text AS email, m.alert_phone_e164 FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = app.tenant_id() AND m.status = 'active'`.execute(tx)
  ).rows;
  const numbers = (await sql<{ e164: string }>`SELECT e164 FROM phone_numbers WHERE tenant_id = app.tenant_id() AND released_at IS NULL`.execute(tx)).rows;
  return {
    emails: members.map((m) => m.email).filter((e): e is string => typeof e === 'string' && e !== ''),
    phones: [...members.map((m) => m.alert_phone_e164).filter((p): p is string => typeof p === 'string' && p !== ''), ...numbers.map((n) => n.e164)],
  };
}

// ---- messages -------------------------------------------------------------------------------------------

export interface MessageInsert {
  id: string;
  connectionId: string;
  leadSourceId: string;
  messageKey: Buffer;
  providerFormat: string;
  status: 'lead_created' | 'needs_review';
  holdCode: string | null;
  parserKind: string | null;
  senderDomain: string | null;
  dkimPassDomains: readonly string[];
  contentEnc: Uint8Array | null;
  parsedEnc: Uint8Array | null;
  /** held only: the tenant-HMACs of the addresses the email names (migration 0041; erasure finds the person's held mail by them) */
  pointHmacs: readonly Buffer[];
  contactId: string | null;
  inquiryId: string | null;
}

/** Claims the (tenant, message key) slot. False: this message was already received (replay). */
export async function claimMessage(tx: Tx, m: MessageInsert): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO lead_email_messages (tenant_id, id, connection_id, lead_source_id, message_key_sha256, provider_format, received_at,
                                     status, hold_code, parser_kind, sender_domain, dkim_pass_domains, content_enc, parsed_enc,
                                     point_hmacs, contact_id, inquiry_id)
    VALUES (app.tenant_id(), ${m.id}::uuid, ${m.connectionId}::uuid, ${m.leadSourceId}::uuid, ${m.messageKey}, ${m.providerFormat},
            clock_timestamp(), ${m.status}, ${m.holdCode}, ${m.parserKind}, ${m.senderDomain}, ${[...m.dkimPassDomains]}::text[],
            ${m.contentEnc ? Buffer.from(m.contentEnc) : null}, ${m.parsedEnc ? Buffer.from(m.parsedEnc) : null},
            ${[...m.pointHmacs]}::bytea[], ${m.contactId}::uuid, ${m.inquiryId}::uuid)
    ON CONFLICT (tenant_id, message_key_sha256) DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.length === 1;
}

export async function messageExists(tx: Tx, key: Buffer): Promise<boolean> {
  return (await sql<{ ok: number }>`SELECT 1 AS ok FROM lead_email_messages WHERE tenant_id = app.tenant_id() AND message_key_sha256 = ${key}`.execute(tx)).rows.length > 0;
}

export interface MessageRow {
  id: string;
  connection_id: string;
  lead_source_id: string;
  lead_source_name: string;
  provider_format: string;
  received_at: Date;
  status: 'lead_created' | 'needs_review' | 'accepted' | 'discarded';
  hold_code: string | null;
  parser_kind: string | null;
  sender_domain: string | null;
  dkim_pass_domains: string[];
  content_enc: Buffer | null;
  parsed_enc: Buffer | null;
  contact_id: string | null;
  inquiry_id: string | null;
  decided_at: Date | null;
}

const MSG_COLS = sql`m.id, m.connection_id, m.lead_source_id, s.name AS lead_source_name, m.provider_format, m.received_at, m.status,
  m.hold_code, m.parser_kind, m.sender_domain, m.dkim_pass_domains, m.content_enc, m.parsed_enc, m.contact_id, m.inquiry_id, m.decided_at`;

export async function listMessages(tx: Tx, status: 'needs_review' | 'decided', limit: number): Promise<MessageRow[]> {
  const where = status === 'needs_review' ? sql`m.status = 'needs_review'` : sql`m.status IN ('accepted','discarded')`;
  return (
    await sql<MessageRow>`SELECT ${MSG_COLS} FROM lead_email_messages m
                            JOIN lead_sources s ON s.tenant_id = m.tenant_id AND s.id = m.lead_source_id
                           WHERE m.tenant_id = app.tenant_id() AND ${where}
                           ORDER BY m.received_at DESC, m.id DESC LIMIT ${limit}`.execute(tx)
  ).rows;
}

export async function countReview(tx: Tx): Promise<number> {
  return Number((await sql<{ n: string }>`SELECT count(*)::text AS n FROM lead_email_messages WHERE tenant_id = app.tenant_id() AND status = 'needs_review'`.execute(tx)).rows[0]?.n ?? 0);
}

/**
 * One lead email by id. An erased or expired one (migration 0041: its person was erased, or it was held past
 * retention) is not found: nothing of it is shown, accepted or discarded.
 */
export async function messageById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<MessageRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE OF m` : sql``;
  return (
    await sql<MessageRow>`SELECT ${MSG_COLS} FROM lead_email_messages m
                            JOIN lead_sources s ON s.tenant_id = m.tenant_id AND s.id = m.lead_source_id
                           WHERE m.tenant_id = app.tenant_id() AND m.id = ${id}::uuid
                             AND m.status IN ('lead_created','needs_review','accepted','discarded') ${lock}`.execute(tx)
  ).rows[0] ?? null;
}

/** The decision purges what the held email kept: its content, its parse and its address keys. */
export async function decide(tx: Tx, id: string, d: { status: 'accepted' | 'discarded'; userId: string; contactId: string | null; inquiryId: string | null }): Promise<void> {
  await sql`UPDATE lead_email_messages SET status = ${d.status}, decided_by_user_id = ${d.userId}::uuid, decided_at = clock_timestamp(),
                   contact_id = COALESCE(${d.contactId}::uuid, contact_id), inquiry_id = COALESCE(${d.inquiryId}::uuid, inquiry_id),
                   content_enc = NULL, parsed_enc = NULL, point_hmacs = '{}'
             WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND status = 'needs_review'`.execute(tx);
}
