// Reads and writes of api/people (PARITY_PLAN module 57). Every statement runs under the caller's RLS
// (the request transaction's actor): contact detail visibility decides what each child row set holds,
// and the DB guards (contact_points_immutable, contacts_stage_guard, notes_edit_guard, the relationship
// and collaborator policies) refuse what the API never attempts. Nothing here widens what anyone sees.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

// ---- contacts --------------------------------------------------------------------------------------

export interface EditRow {
  id: string;
  row_version: number;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  contact_type: string;
  intent: string | null;
  timezone: string | null;
  stage: string;
  pond_summary: string | null;
  ownership_state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  owner_user_id: string | null;
  first_touch_due_at: Date | null;
  first_touch_at: Date | null;
  do_not_contact_at: Date | null;
}

export async function editRow(tx: Tx, id: string): Promise<EditRow | null> {
  const r = await sql<EditRow>`
    SELECT id, row_version, display_name, first_name, last_name, contact_type, intent, timezone, stage, pond_summary,
           ownership_state, owner_user_id, first_touch_due_at, first_touch_at, do_not_contact_at
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export interface ContactColumns {
  display_name?: string;
  first_name?: string | null;
  last_name?: string | null;
  contact_type?: string;
  intent?: string | null;
  timezone?: string | null;
  timezone_source?: string | null;
  stage?: string;
  pond_summary?: string | null;
}

const COLUMN_SQL: Record<keyof ContactColumns, string> = {
  display_name: 'display_name',
  first_name: 'first_name',
  last_name: 'last_name',
  contact_type: 'contact_type',
  intent: 'intent',
  timezone: 'timezone',
  timezone_source: 'timezone_source',
  stage: 'stage',
  pond_summary: 'pond_summary',
};

/** Optimistic update: null when the row version moved (or the row is not writable under RLS). */
export async function updateContact(tx: Tx, id: string, rowVersion: number, cols: ContactColumns): Promise<number | null> {
  const sets = (Object.keys(cols) as (keyof ContactColumns)[]).filter((k) => cols[k] !== undefined).map((k) => sql`${sql.ref(COLUMN_SQL[k])} = ${cols[k] ?? null}`);
  if (sets.length === 0) return rowVersion;
  const r = await sql<{ row_version: number }>`
    UPDATE contacts SET ${sql.join(sets, sql`, `)}, row_version = row_version + 1, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND row_version = ${rowVersion}
     RETURNING row_version`.execute(tx);
  return r.rows[0]?.row_version ?? null;
}

export async function stageLabels(tx: Tx): Promise<Record<string, string>> {
  const r = await sql<{ stage_labels: Record<string, string> }>`SELECT stage_labels FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.stage_labels ?? {};
}

export async function setStageLabels(tx: Tx, labels: Record<string, string>): Promise<boolean> {
  const r = await sql<{ tenant_id: string }>`
    UPDATE tenant_settings SET stage_labels = ${JSON.stringify(labels)}::jsonb WHERE tenant_id = app.tenant_id() RETURNING tenant_id`.execute(tx);
  return r.rows.length > 0;
}

// ---- points ----------------------------------------------------------------------------------------

export interface PointRow {
  id: string;
  kind: 'phone' | 'email';
  address: string;
  hmac: string;
  label: 'mobile' | 'home' | 'work' | 'other';
  status: string;
  is_primary: boolean;
  removed_at: Date | null;
  removed_reason: 'replaced' | 'old' | 'wrong_number' | null;
  /** the address's SMS (phones) / email opt-out in consent_state (R-PAR-12 over-block explanation) */
  opted_out: boolean;
  /** the consent ledger holds a wrong_number report for the address: the remove route accepts reason wrong_number (R-PAR-12) */
  wrong_number_reported: boolean;
}

/** Every point of a contact, removed ones included (RLS: contact detail visible). */
export async function allPoints(tx: Tx, contactId: string): Promise<PointRow[]> {
  const r = await sql<PointRow>`
    SELECT p.id, p.kind, p.address, encode(p.address_hmac, 'hex') AS hmac, p.label, p.status, p.is_primary, p.removed_at, p.removed_reason,
           EXISTS (SELECT 1 FROM consent_state s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.status = 'revoked'
                      AND s.channel = CASE WHEN p.kind = 'phone' THEN 'sms' ELSE 'email' END) AS opted_out,
           -- hasWrongNumberRevoke's own test, per point
           EXISTS (SELECT 1 FROM consent_events e WHERE e.tenant_id = p.tenant_id AND e.address_hmac = p.address_hmac
                      AND e.source = 'wrong_number' AND e.event_type = 'revoke') AS wrong_number_reported
      FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ${contactId}::uuid
     ORDER BY p.kind, p.removed_at NULLS FIRST, p.is_primary DESC, p.created_at, p.id`.execute(tx);
  return r.rows;
}

export async function insertPoint(tx: Tx, p: { id: string; contactId: string; kind: 'phone' | 'email'; address: string; hmacHex: string; label: string; primary: boolean }): Promise<void> {
  await sql`
    INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary)
    VALUES (app.tenant_id(), ${p.id}::uuid, ${p.contactId}::uuid, ${p.kind}, ${p.address}, decode(${p.hmacHex}, 'hex'), ${p.label}, ${p.primary})`.execute(tx);
}

/** A removed point added again: back to active (a confirmed wrong number is refused by the DB). */
export async function restorePoint(tx: Tx, id: string, label: string, primary: boolean): Promise<void> {
  await sql`
    UPDATE contact_points SET removed_at = NULL, removed_reason = NULL, status = 'active', label = ${label}, is_primary = ${primary}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

export async function removePoint(tx: Tx, id: string, reason: 'replaced' | 'old' | 'wrong_number'): Promise<void> {
  await sql`
    UPDATE contact_points SET removed_at = now(), removed_reason = ${reason}, status = 'removed', is_primary = false, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND removed_at IS NULL`.execute(tx);
}

export async function setPointLabel(tx: Tx, id: string, label: string): Promise<void> {
  await sql`UPDATE contact_points SET label = ${label}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** Makes one live point the primary of its kind (clears the old primary first: one-primary index). */
export async function setPrimary(tx: Tx, contactId: string, id: string, kind: 'phone' | 'email'): Promise<void> {
  await sql`
    UPDATE contact_points SET is_primary = false, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND kind = ${kind} AND is_primary AND id <> ${id}::uuid`.execute(tx);
  await sql`UPDATE contact_points SET is_primary = true, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND removed_at IS NULL`.execute(tx);
}

export async function setPrimaryOff(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE contact_points SET is_primary = false, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
}

/** Whether the consent ledger holds a wrong-number revoke for the address (R-PAR-12, review S1). */
export async function hasWrongNumberRevoke(tx: Tx, hmacHex: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`
    SELECT EXISTS (SELECT 1 FROM consent_events WHERE tenant_id = app.tenant_id() AND address_hmac = decode(${hmacHex}, 'hex')
                     AND source = 'wrong_number' AND event_type = 'revoke') AS ok`.execute(tx);
  return r.rows[0]?.ok ?? false;
}

// ---- addresses -------------------------------------------------------------------------------------

export interface AddressRow {
  id: string;
  kind: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  country: string;
}

export async function addresses(tx: Tx, contactId: string): Promise<AddressRow[]> {
  const r = await sql<AddressRow>`
    SELECT id, kind, line1, line2, city, region, postal_code, country FROM contact_addresses
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid ORDER BY created_at, id`.execute(tx);
  return r.rows;
}

export interface AddressInput {
  kind: string;
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}

export async function insertAddress(tx: Tx, id: string, contactId: string, a: AddressInput): Promise<void> {
  await sql`
    INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code, country)
    VALUES (app.tenant_id(), ${id}::uuid, ${contactId}::uuid, ${a.kind}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region}, ${a.postalCode}, ${a.country})`.execute(tx);
}

export async function updateAddress(tx: Tx, contactId: string, id: string, a: AddressInput): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE contact_addresses SET kind = ${a.kind}, line1 = ${a.line1}, line2 = ${a.line2}, city = ${a.city}, region = ${a.region},
           postal_code = ${a.postalCode}, country = ${a.country}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND id = ${id}::uuid RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

/** Every stored column of an address (the generated search_line1 and updated_at aside): what a restore puts back. */
export interface AddressFullRow extends AddressRow {
  jurisdiction: string | null;
  import_batch_id: string | null;
  created_at: Date;
}

/**
 * Deletes one address of the contact (RLS: contact_addresses_delete): the deleted row as it was, or null when there
 * is none this caller may delete.
 */
export async function deleteAddress(tx: Tx, contactId: string, id: string): Promise<AddressFullRow | null> {
  const r = await sql<AddressFullRow>`
    DELETE FROM contact_addresses WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND id = ${id}::uuid
    RETURNING id, kind, line1, line2, city, region, postal_code, country, jurisdiction, import_batch_id, created_at`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * Puts a deleted address back verbatim, the same id included, under the caller's RLS (the contact_detail policy's
 * WITH CHECK). False when an address with that id exists already (restored before).
 */
export async function restoreAddress(tx: Tx, contactId: string, a: AddressFullRow): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, line2, city, region, postal_code, country, jurisdiction, import_batch_id, created_at)
    VALUES (app.tenant_id(), ${a.id}::uuid, ${contactId}::uuid, ${a.kind}, ${a.line1}, ${a.line2}, ${a.city}, ${a.region}, ${a.postal_code}, ${a.country},
            ${a.jurisdiction}, ${a.import_batch_id}::uuid, ${a.created_at.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, id) DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

// ---- collaborators ---------------------------------------------------------------------------------

export interface CollaboratorRow {
  user_id: string;
  display_name: string | null;
  role: 'isa' | 'tc' | 'co_agent';
  expires_at: Date | null;
  created_at: Date;
}

export async function collaborators(tx: Tx, contactId: string): Promise<CollaboratorRow[]> {
  const r = await sql<CollaboratorRow>`
    SELECT cc.user_id, u.display_name, cc.role, cc.expires_at, cc.created_at
      FROM contact_collaborators cc LEFT JOIN users u ON u.id = cc.user_id
     WHERE cc.tenant_id = app.tenant_id() AND cc.contact_id = ${contactId}::uuid AND cc.removed_at IS NULL
       AND (cc.expires_at IS NULL OR cc.expires_at > now())
     ORDER BY cc.created_at, cc.user_id`.execute(tx);
  return r.rows;
}

/** Adds (or re-adds) a collaborator; false when RLS refused the write. */
export async function upsertCollaborator(tx: Tx, contactId: string, userId: string, role: string, addedBy: string): Promise<boolean> {
  const existing = await sql<{ user_id: string }>`
    UPDATE contact_collaborators SET removed_at = NULL, expires_at = NULL, role = ${role}, added_by_user_id = ${addedBy}::uuid
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND user_id = ${userId}::uuid RETURNING user_id`.execute(tx);
  if (existing.rows.length > 0) return true;
  const r = await sql<{ user_id: string }>`
    INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, added_by_user_id)
    VALUES (app.tenant_id(), ${contactId}::uuid, ${userId}::uuid, ${role}, ${addedBy}::uuid) RETURNING user_id`.execute(tx);
  return r.rows.length > 0;
}

export async function removeCollaborator(tx: Tx, contactId: string, userId: string): Promise<boolean> {
  const r = await sql<{ user_id: string }>`
    UPDATE contact_collaborators SET removed_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND user_id = ${userId}::uuid AND removed_at IS NULL RETURNING user_id`.execute(tx);
  return r.rows.length > 0;
}

// ---- members ---------------------------------------------------------------------------------------

export interface MemberRow {
  user_id: string;
  display_name: string | null;
  role: 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
}

export async function activeMembers(tx: Tx, limit = 500): Promise<MemberRow[]> {
  const r = await sql<MemberRow>`
    SELECT m.user_id, u.display_name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active' ORDER BY u.display_name NULLS LAST, m.user_id LIMIT ${limit}`.execute(tx);
  return r.rows;
}

/** Read as the MENTIONED user (their own transaction): do they see the person's detail? (R-PAR-2) */
export async function seesDetail(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT COALESCE(app.contact_detail_visible(app.tenant_id(), ${contactId}::uuid), false) AS ok`.execute(tx);
  return r.rows[0]?.ok ?? false;
}

// ---- relationships ---------------------------------------------------------------------------------

export interface RelationshipRow {
  id: string;
  contact_id: string;
  related_contact_id: string;
  kind: string;
  label: string | null;
  other_id: string;
  other_name: string;
  created_at: Date;
}

/** Relationships of a contact the caller sees (RLS: BOTH people's detail visible, R-PAR-21). */
export async function relationships(tx: Tx, contactId: string): Promise<RelationshipRow[]> {
  const r = await sql<RelationshipRow>`
    SELECT r.id, r.contact_id, r.related_contact_id, r.kind, r.label, r.created_at,
           CASE WHEN r.contact_id = ${contactId}::uuid THEN r.related_contact_id ELSE r.contact_id END AS other_id, o.display_name AS other_name
      FROM contact_relationships r
      JOIN contacts o ON o.tenant_id = r.tenant_id AND o.id = CASE WHEN r.contact_id = ${contactId}::uuid THEN r.related_contact_id ELSE r.contact_id END
     WHERE r.tenant_id = app.tenant_id() AND (r.contact_id = ${contactId}::uuid OR r.related_contact_id = ${contactId}::uuid)
     ORDER BY r.created_at, r.id`.execute(tx);
  return r.rows;
}

export async function insertRelationship(tx: Tx, r: { id: string; contactId: string; relatedId: string; kind: string; label: string | null; userId: string }): Promise<void> {
  await sql`
    INSERT INTO contact_relationships (tenant_id, id, contact_id, related_contact_id, kind, label, created_by_user_id)
    VALUES (app.tenant_id(), ${r.id}::uuid, ${r.contactId}::uuid, ${r.relatedId}::uuid, ${r.kind}, ${r.label}, ${r.userId}::uuid)`.execute(tx);
}

export async function deleteRelationship(tx: Tx, contactId: string, id: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    DELETE FROM contact_relationships WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid
       AND (contact_id = ${contactId}::uuid OR related_contact_id = ${contactId}::uuid) RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

// ---- notes -----------------------------------------------------------------------------------------

export interface NoteRow {
  id: string;
  contact_id: string | null;
  author_user_id: string | null;
  author_name: string | null;
  body: string;
  pinned: boolean;
  source: 'manual' | 'call_summary' | 'import' | 'logged_activity';
  activity_kind: 'call' | 'text' | 'email' | null;
  activity_direction: 'outbound' | 'inbound' | null;
  activity_at: Date | null;
  activity_outcome: string | null;
  created_at: Date;
  edited_at: Date | null;
  /** created_at as text (keyset cursor keeps microseconds) */
  at_text: string;
}

const NOTE_SELECT = sql`
  SELECT n.id, n.contact_id, n.author_user_id, u.display_name AS author_name, n.body, n.pinned, n.source, n.activity_kind,
         n.activity_direction, n.activity_at, n.activity_outcome, n.created_at, n.edited_at, n.created_at::text AS at_text
    FROM notes n LEFT JOIN users u ON u.id = n.author_user_id`;

export async function note(tx: Tx, id: string): Promise<NoteRow | null> {
  const r = await sql<NoteRow>`${NOTE_SELECT} WHERE n.tenant_id = app.tenant_id() AND n.id = ${id}::uuid AND n.contact_id IS NOT NULL`.execute(tx);
  return r.rows[0] ?? null;
}

/** Notes of a contact: pinned first, then newest; keyset on (pinned, created_at, id). */
export async function notes(tx: Tx, contactId: string, limit: number, after: { pinned: boolean; at: string; id: string } | null): Promise<NoteRow[]> {
  const r = await sql<NoteRow>`${NOTE_SELECT}
     WHERE n.tenant_id = app.tenant_id() AND n.contact_id = ${contactId}::uuid
       AND (${after === null} OR (n.pinned::int, n.created_at, n.id) < (${after ? (after.pinned ? 1 : 0) : 0}::int, ${after?.at ?? null}::timestamptz, ${after?.id ?? null}::uuid))
     ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC LIMIT ${limit}`.execute(tx);
  return r.rows;
}

export interface NoteInsert {
  id: string;
  contactId: string;
  authorUserId: string;
  body: string;
  pinned: boolean;
  activity: { kind: string; direction: string; at: string; outcome: string | null } | null;
}

export async function insertNote(tx: Tx, n: NoteInsert): Promise<void> {
  await sql`
    INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body, pinned, source, activity_kind, activity_direction, activity_at, activity_outcome)
    VALUES (app.tenant_id(), ${n.id}::uuid, ${n.contactId}::uuid, ${n.authorUserId}::uuid, ${n.body}, ${n.pinned},
            ${n.activity ? 'logged_activity' : 'manual'}, ${n.activity?.kind ?? null}, ${n.activity?.direction ?? null},
            ${n.activity?.at ?? null}::timestamptz, ${n.activity?.outcome ?? null})`.execute(tx);
}

export interface NoteUpdate {
  body?: string;
  pinned?: boolean;
  activityAt?: string;
  activityDirection?: string;
  activityOutcome?: string | null;
}

export async function updateNote(tx: Tx, id: string, u: NoteUpdate): Promise<boolean> {
  const sets = [];
  if (u.body !== undefined) sets.push(sql`body = ${u.body}`);
  if (u.pinned !== undefined) sets.push(sql`pinned = ${u.pinned}`);
  if (u.activityAt !== undefined) sets.push(sql`activity_at = ${u.activityAt}::timestamptz`);
  if (u.activityDirection !== undefined) sets.push(sql`activity_direction = ${u.activityDirection}`);
  if (u.activityOutcome !== undefined) sets.push(sql`activity_outcome = ${u.activityOutcome}`);
  if (sets.length === 0) return true;
  const r = await sql<{ id: string }>`
    UPDATE notes SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

export async function deleteNote(tx: Tx, id: string): Promise<boolean> {
  const r = await sql<{ id: string }>`DELETE FROM notes WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

let savepointSeq = 0;

/**
 * A text-free mention notification (R-PAR-3), written in the author's transaction; in-app delivery.
 * No RETURNING and no ON CONFLICT: the row belongs to another user, whose notification the author's
 * SELECT policy does not show. A savepoint absorbs the per-note dedupe (unique dedupe_key).
 */
export async function insertMention(tx: Tx, n: { id: string; deliveryId: string; userId: string; title: string; noteId: string; contactId: string; dedupeKey: string }): Promise<boolean> {
  const name = sql.raw(`people_mention_${(savepointSeq = (savepointSeq + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    await sql`
      INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, body, subject_type, subject_id, dedupe_key)
      VALUES (app.tenant_id(), ${n.id}::uuid, ${n.userId}::uuid, 'mention', 'normal', ${n.title.slice(0, 120)}, NULL, 'contact', ${n.contactId}::uuid, ${n.dedupeKey})`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    if ((err as { code?: string }).code === '23505') return false;
    throw err;
  }
  await sql`
    INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status)
    VALUES (app.tenant_id(), ${n.deliveryId}::uuid, ${n.id}::uuid, 'in_app', 'in_app', 'delivered')`.execute(tx);
  return true;
}

/** The PII-minimized person label for a notification title (tenant notification_detail). */
export async function personLabel(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ first_name: string | null; last_name: string | null; detail: string }>`
    SELECT c.first_name, c.last_name, s.notification_detail AS detail FROM contacts c JOIN tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid`.execute(tx);
  const x = r.rows[0];
  if (!x || x.detail === 'none' || !x.first_name) return null;
  return x.last_name ? `${x.first_name} ${x.last_name.slice(0, 1).toUpperCase()}.` : x.first_name;
}

// ---- person-level do-not-contact ---------------------------------------------------------------------

/** Sets the person-level do-not-contact once (the DB guard requires a ledger revoke; it is never cleared here). */
export async function setDoNotContact(tx: Tx, contactId: string, eventId: string): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE contacts SET do_not_contact_at = now(), do_not_contact_event_id = ${eventId}::uuid, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${contactId}::uuid AND do_not_contact_at IS NULL RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

