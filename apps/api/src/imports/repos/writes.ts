// The rows a commit writes (BUILD_PLAN module 16; R-IMPORT-4, R-IMPORT-6, R-IMPORT-9, R-IMPORT-12,
// R-CONSENT-3). Contacts themselves are created only through the ownership engine (import_assign);
// these are the non-ownership columns and the children. Imported history is always `imported = true`
// with the original timestamps, so it never pauses, hands back, counts toward caps/SLAs/scoreboards or
// raises exceptions (R-IMPORT-6: every such path filters `imported`).
import type { Role } from '@realty/core/foundation';
import type { MembershipStatus } from '@realty/core/ownership';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface LiveContactRow {
  ownership_state: string;
  closed_reason: string | null;
  merged_into_contact_id: string | null;
  row_version: number;
  ownership_seq: string;
  deleted_at: Date | null;
}

export async function liveContact(tx: Tx, id: string): Promise<LiveContactRow | null> {
  const r = await sql<LiveContactRow>`
    SELECT ownership_state, closed_reason, merged_into_contact_id, row_version, ownership_seq, deleted_at FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

/** Batch 6 review F3: whether a person merged another contact into this one (a merged_in ledger event). */
export async function hasMergedIn(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM lead_ownership_events WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND type = 'merged_in') AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/** Non-guarded contact columns of a contact the import just created. */
export async function setImportedFields(tx: Tx, contactId: string, fields: Record<string, string>): Promise<void> {
  if (Object.keys(fields).length === 0) return;
  await sql`UPDATE contacts SET imported_fields = ${JSON.stringify(fields)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
}

/**
 * E41: fills an existing contact ONLY where it is empty (names, intent) and adds new imported_fields
 * keys (existing keys win). Tags go to the catalog and contact_tags (repos/parity.ts; R-PAR-10). row_version is not bumped (an import is not a human edit),
 * so a later human edit is detectable for revert (R-IMPORT-10).
 */
export async function fillContact(tx: Tx, contactId: string, f: { firstName?: string; lastName?: string; intent?: string; addImportedFields: Record<string, string> }): Promise<void> {
  await sql`
    UPDATE contacts SET
      first_name = COALESCE(first_name, ${f.firstName ?? null}),
      last_name = COALESCE(last_name, ${f.lastName ?? null}),
      intent = COALESCE(intent, ${f.intent ?? null}),
      imported_fields = ${JSON.stringify(f.addImportedFields)}::jsonb || imported_fields
     WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
}

/** Inserts several points of one contact in one statement; returns the ids actually inserted. */
export async function insertPoints(
  tx: Tx,
  contactId: string,
  batchId: string,
  pts: readonly { id: string; kind: 'phone' | 'email'; address: string; hmacHex: string; label: string; status: string; isPrimary: boolean }[],
): Promise<string[]> {
  if (pts.length === 0) return [];
  const rows = JSON.stringify(pts.map((p) => ({ id: p.id, kind: p.kind, address: p.address, hmac: p.hmacHex, label: p.label, status: p.status, is_primary: p.isPrimary })));
  const r = await sql<{ id: string }>`
    WITH x AS (SELECT * FROM jsonb_to_recordset(${rows}::jsonb) AS x(id uuid, kind text, address text, hmac text, label text, status text, is_primary boolean)),
         has AS (SELECT kind FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND is_primary AND removed_at IS NULL),
         ranked AS (SELECT x.*, row_number() OVER (PARTITION BY x.kind ORDER BY x.is_primary DESC) AS rn FROM x)
    INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, status, is_primary, import_batch_id, removed_at)
    SELECT app.tenant_id(), r.id, ${contactId}::uuid, r.kind, r.address, decode(r.hmac, 'hex'), r.label, r.status,
           r.is_primary AND r.rn = 1 AND NOT EXISTS (SELECT 1 FROM has WHERE has.kind = r.kind),
           ${batchId}::uuid, CASE WHEN r.status = 'removed' THEN now() ELSE NULL END
      FROM ranked r
    ON CONFLICT (tenant_id, contact_id, kind, address) DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

export async function insertAddress(
  tx: Tx,
  a: { id: string; contactId: string; kind: string; line1: string | null; line2: string | null; city: string | null; region: string | null; postalCode: string | null; country: string; batchId: string },
): Promise<void> {
  await sql`
    INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code, country, import_batch_id)
    VALUES (app.tenant_id(), ${a.id}, ${a.contactId}, ${a.kind}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region}, ${a.postalCode}, ${a.country}, ${a.batchId})`.execute(tx);
}

/** Other live contacts that hold one of these address HMACs now (a match that appeared after the dry run). */
export async function contactsWithHmacs(tx: Tx, hmacHex: readonly string[], exclude: string): Promise<{ contact_id: string; kind: 'phone' | 'email' }[]> {
  if (hmacHex.length === 0) return [];
  return (
    await sql<{ contact_id: string; kind: 'phone' | 'email' }>`
      SELECT DISTINCT p.contact_id, p.kind FROM contact_points p JOIN contacts c ON c.tenant_id = p.tenant_id AND c.id = p.contact_id
       WHERE p.tenant_id = app.tenant_id() AND p.address_hmac = ANY (${hmacHex.map((h) => Buffer.from(h, 'hex'))}::bytea[])
         AND p.contact_id <> ${exclude}::uuid AND p.status <> 'removed' AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL`.execute(tx)
  ).rows;
}

/** contact_duplicate_candidates (never a merge, R-IMPORT-7). */
export async function insertDuplicate(tx: Tx, id: string, a: string, b: string, reason: string): Promise<void> {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  await sql`INSERT INTO contact_duplicate_candidates (tenant_id, id, contact_a_id, contact_b_id, match_reason)
            VALUES (app.tenant_id(), ${id}, ${x}, ${y}, ${reason})
            ON CONFLICT (tenant_id, contact_a_id, contact_b_id) DO NOTHING`.execute(tx);
}

export async function insertExternalRef(tx: Tx, r: { system: 'fub' | 'csv'; entityType: string; externalId: string; entityId: string; batchId: string }): Promise<void> {
  await sql`INSERT INTO external_refs (tenant_id, system, entity_type, external_id, entity_id, import_batch_id)
            VALUES (app.tenant_id(), ${r.system}, ${r.entityType}, ${r.externalId}, ${r.entityId}, ${r.batchId})
            ON CONFLICT (tenant_id, system, entity_type, external_id) DO UPDATE
              -- the commit writes a ref only for an entity it just created, which the plan does only when the old
              -- ref's entity is gone (undone or deleted): the new entity takes the ref over (R-IMPORT-9 after R-IMPORT-10)
              SET entity_id = EXCLUDED.entity_id, import_batch_id = EXCLUDED.import_batch_id
              WHERE external_refs.entity_id IS DISTINCT FROM EXCLUDED.entity_id`.execute(tx);
}

export async function externalRef(tx: Tx, system: 'fub' | 'csv', entityType: string, externalId: string): Promise<string | null> {
  const r = await sql<{ entity_id: string }>`SELECT entity_id FROM external_refs WHERE tenant_id = app.tenant_id() AND system = ${system}
                                               AND entity_type = ${entityType} AND external_id = ${externalId}`.execute(tx);
  return r.rows[0]?.entity_id ?? null;
}

export async function ensureConversation(tx: Tx, id: string, contactId: string): Promise<string> {
  await sql`INSERT INTO conversations (tenant_id, id, contact_id) VALUES (app.tenant_id(), ${id}, ${contactId}) ON CONFLICT (tenant_id, contact_id) DO NOTHING`.execute(tx);
  const r = await sql<{ id: string }>`SELECT id FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  if (!r.rows[0]) throw new Error('CONVERSATION_NOT_VISIBLE');
  return r.rows[0].id;
}

export async function primaryAddress(tx: Tx, contactId: string, kind: 'phone' | 'email'): Promise<string | null> {
  const r = await sql<{ address: string }>`SELECT address FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = ${kind}
                                             AND status <> 'removed' ORDER BY is_primary DESC, created_at LIMIT 1`.execute(tx);
  return r.rows[0]?.address ?? null;
}

/** Active member ids (FK targets for authors / agents of imported history). */
export async function memberIds(tx: Tx): Promise<Set<string>> {
  return new Set((await sql<{ user_id: string }>`SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id()`.execute(tx)).rows.map((r) => r.user_id));
}

export interface MemberStatusRow {
  user_id: string;
  role: Role;
  status: MembershipStatus;
  accepting_leads: boolean;
}

/** A member's status and role now (why the engine refused an import assignment, owner decision B4, E230). */
export async function memberStatus(tx: Tx, userId: string): Promise<MemberStatusRow | null> {
  const r = await sql<MemberStatusRow>`SELECT user_id, role, status, accepting_leads FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * E232: the members a commit chunk assigned leads to, re-read and held FOR SHARE (sorted) until the chunk commits.
 * A suspension (PATCH /members locks the row FOR NO KEY UPDATE) either committed before this read, so it is seen
 * here and the chunk runs again, or it waits until the chunk has committed: no assignment ever commits after the
 * member's suspension did. Held only for the end of the chunk, so a suspension waits for a commit, not a chunk.
 */
export async function lockMembers(tx: Tx, userIds: readonly string[]): Promise<MemberStatusRow[]> {
  if (userIds.length === 0) return [];
  return (
    await sql<MemberStatusRow>`SELECT user_id, role, status, accepting_leads FROM memberships
                                WHERE tenant_id = app.tenant_id() AND user_id = ANY (${[...userIds]}::uuid[]) ORDER BY user_id FOR SHARE`.execute(tx)
  ).rows;
}

export async function insertNote(tx: Tx, n: { id: string; contactId: string; authorUserId: string | null; body: string; occurredAt: string; recordId: string }): Promise<void> {
  await sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, source, imported, import_record_id, created_at)
            VALUES (app.tenant_id(), ${n.id}, ${n.contactId}, ${n.authorUserId}, ${n.body}, 'import', true, ${n.recordId}, ${n.occurredAt}::timestamptz)`.execute(tx);
}

export async function insertMessage(
  tx: Tx,
  m: {
    id: string;
    conversationId: string;
    contactId: string;
    channel: 'sms' | 'email';
    direction: 'inbound' | 'outbound';
    from: string;
    to: string;
    subject: string | null;
    body: string;
    status: string;
    userId: string | null;
    occurredAt: string;
    recordId: string;
  },
): Promise<void> {
  await sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, subject, body, status,
                                  initiator, initiated_by_user_id, imported, import_record_id, occurred_at, created_at)
            VALUES (app.tenant_id(), ${m.id}, ${m.conversationId}, ${m.contactId}, ${m.channel}, ${m.direction}, ${m.from}, ${m.to}, ${m.subject},
                    ${m.body}, ${m.status}, 'import', ${m.userId}, true, ${m.recordId}, ${m.occurredAt}::timestamptz, ${m.occurredAt}::timestamptz)`.execute(tx);
}

export async function insertCall(
  tx: Tx,
  c: {
    id: string;
    conversationId: string;
    contactId: string;
    direction: 'inbound' | 'outbound';
    agentUserId: string | null;
    clientAddress: string;
    status: string;
    startedAt: string;
    durationS: number | null;
    outcome: string | null;
    hasRecording: boolean;
    recordId: string;
  },
): Promise<void> {
  const ended = c.durationS === null ? null : new Date(Date.parse(c.startedAt) + c.durationS * 1000).toISOString();
  await sql`INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, handled_by, status,
                               started_at, ended_at, duration_s, recording_mode, recording_decision, outcome, outcome_logged_at, imported, import_record_id)
            VALUES (app.tenant_id(), ${c.id}, ${c.conversationId}, ${c.contactId}, ${c.direction}, ${c.agentUserId}, ${c.clientAddress}, 'import',
                    ${c.status === 'voicemail' ? 'voicemail' : 'human'}, ${c.status}, ${c.startedAt}::timestamptz, ${ended}::timestamptz, ${c.durationS},
                    ${c.hasRecording ? 'one_party_no_announcement' : 'off'},
                    ${JSON.stringify(c.hasRecording ? { source: 'import_fub', notice: 'unknown', label: 'recording notice unknown' } : { source: 'import_fub' })}::jsonb,
                    ${c.outcome}, ${c.outcome === null ? null : c.startedAt}::timestamptz, true, ${c.recordId})`.execute(tx);
}

export async function insertRecording(
  tx: Tx,
  r: { id: string; callId: string; contactId: string; agentUserId: string | null; objectId: string | null; durationS: number | null; retainDays: number },
): Promise<void> {
  await sql`INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, object_id, duration_s, source, consent_basis, status, retain_until)
            VALUES (app.tenant_id(), ${r.id}, ${r.callId}, ${r.contactId}, ${r.agentUserId}, ${r.objectId}, ${r.durationS}, 'import_fub', 'unknown_imported',
                    ${r.objectId === null ? 'pending_copy' : 'stored'}, now() + make_interval(days => ${r.retainDays}))`.execute(tx);
}

/** Imported revocations (`revoke:<channel>:<hmac>`) and active import_dnc flags (`dnc:<sms|email>:<hmac>`) already on file for these addresses. */
export async function importedOptOutKeys(tx: Tx, hmacs: readonly string[]): Promise<Set<string>> {
  if (hmacs.length === 0) return new Set();
  const r = await sql<{ k: string }>`
    SELECT 'revoke:' || channel || ':' || encode(address_hmac, 'hex') AS k FROM consent_events
     WHERE tenant_id = app.tenant_id() AND imported AND event_type = 'revoke' AND address_hmac IN (SELECT decode(h, 'hex') FROM unnest(${[...hmacs]}::text[]) AS h)
    UNION
    SELECT 'dnc:' || CASE address_kind WHEN 'email' THEN 'email' ELSE 'sms' END || ':' || encode(address_hmac, 'hex') FROM suppressions
     WHERE tenant_id = app.tenant_id() AND reason = 'import_dnc' AND lifted_at IS NULL AND address_hmac IN (SELECT decode(h, 'hex') FROM unnest(${[...hmacs]}::text[]) AS h)`.execute(tx);
  return new Set(r.rows.map((x) => x.k));
}

export async function insertImportedSuppression(
  tx: Tx,
  s: { id: string; addressKind: string; addressHmac: string; addressHint: string; sourceRef: Record<string, unknown>; importRecordId: string },
): Promise<string | null> {
  const r = await sql<{ id: string }>`
    INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref, imported, import_record_id)
    VALUES (app.tenant_id(), ${s.id}, ${s.addressKind}, decode(${s.addressHmac}, 'hex'), ${s.addressHint}, 'all', 'import_dnc',
            ${JSON.stringify(s.sourceRef)}::jsonb, true, ${s.importRecordId})
    ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
  return r.rows[0]?.id ?? null;
}

/**
 * PARITY 65 (R-PAR-10): a person's tags and custom values are child rows now; the fingerprint folds them
 * in (tag ids and field values, sorted), so a human tagging or editing a value after the import is a touch.
 */
export const CHILD_FP = sql`(SELECT jsonb_build_array(
    COALESCE((SELECT jsonb_agg(ct.tag_id ORDER BY ct.tag_id) FROM contact_tags ct WHERE ct.tenant_id = c.tenant_id AND ct.contact_id = c.id), '[]'::jsonb),
    COALESCE((SELECT jsonb_agg(jsonb_build_array(v.field_id, v.value_text, v.value_number, v.value_date, v.value_options) ORDER BY v.field_id)
                FROM contact_field_values v WHERE v.tenant_id = c.tenant_id AND v.contact_id = c.id), '[]'::jsonb)))`;

/**
 * A fingerprint of the human-editable contact fields. The import stores the one it left; a different
 * one at revert time means someone edited the contact since (row_version also moves with ownership
 * changes, so it cannot tell an edit from the import's own ownership stage).
 */
export async function contactFingerprint(tx: Tx, id: string): Promise<string> {
  const r = await sql<{ fp: string }>`
    SELECT md5(jsonb_build_array(c.first_name, c.last_name, c.display_name, c.contact_type, c.intent, c.stage, c.imported_fields,
                                 ${CHILD_FP})::text) AS fp
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${id}`.execute(tx);
  return r.rows[0]?.fp ?? '';
}
