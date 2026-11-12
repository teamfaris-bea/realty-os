// SQL of api/documents. Every query runs in the caller's transaction, so RLS (documents_select + the RESTRICTIVE
// documents_clean_only, objects_select + objects_documents) decides which rows exist (R-DOC-1, R-DOC-3, R-PERM-5).
// No query here writes deal_dates: dates go through module 31's confirmInTx (R-TXN-2, R-DOC-8).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { DocumentKind, DocumentScope } from './types.js';

export interface DocRow {
  id: string;
  deal_id: string | null;
  listing_id: string | null;
  contact_id: string | null;
  object_id: string;
  kind: DocumentKind;
  display_name: string;
  version_no: number;
  supersedes_id: string | null;
  shared_to_portal: boolean;
  scan_status: 'pending' | 'clean' | 'infected';
  uploaded_by_user_id: string;
  retention_until: Date | null;
  legal_hold: boolean;
  created_at: Date;
  /** null when the caller cannot read the object row (never for a clean document they can read) */
  content_type: string | null;
  byte_size: string | null;
}

const COLS = sql`d.id, d.deal_id, d.listing_id, d.contact_id, d.object_id, d.kind, d.display_name, d.version_no, d.supersedes_id,
  d.shared_to_portal, d.scan_status, d.uploaded_by_user_id, d.retention_until, d.legal_hold, d.created_at, o.content_type, o.byte_size::text AS byte_size`;
const FROM = sql`documents d LEFT JOIN stored_objects o ON o.tenant_id = d.tenant_id AND o.id = d.object_id`;

export function scopeOf(d: Pick<DocRow, 'deal_id' | 'listing_id' | 'contact_id'>): DocumentScope {
  if (d.deal_id) return { kind: 'deal', id: d.deal_id };
  if (d.listing_id) return { kind: 'listing', id: d.listing_id };
  return { kind: 'contact', id: d.contact_id! };
}

export async function docById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<DocRow | null> {
  const r = await sql<DocRow>`SELECT ${COLS} FROM ${FROM} WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}
    ${o.lock ? sql`FOR UPDATE OF d` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * Every visible document of a scope, oldest first. A contact's: its whole merge tree, read with the definer
 * app.contact_merge_tree_ids (0075; contacts RLS hides a merged-away record from the survivor's agent and Team Lead,
 * so the invoker app.contact_merge_tree stops at the survivor); documents_select still decides each row, and it
 * admits a merged-away record's document to whoever sees its root survivor in detail (b11 ownership-data/F1).
 */
export async function docsOfScope(tx: Tx, scope: DocumentScope): Promise<DocRow[]> {
  const where =
    scope.kind === 'deal'
      ? sql`d.deal_id = ${scope.id}`
      : scope.kind === 'listing'
        ? sql`d.listing_id = ${scope.id}`
        : sql`d.contact_id = ANY (app.contact_merge_tree_ids(app.tenant_id(), ${scope.id}::uuid))`;
  const r = await sql<DocRow>`SELECT ${COLS} FROM ${FROM} WHERE d.tenant_id = app.tenant_id() AND ${where} ORDER BY d.created_at, d.id`.execute(tx);
  return r.rows;
}

/** The visible chain of a document: its visible predecessors and successors through supersedes_id. */
export async function chainOf(tx: Tx, id: string): Promise<DocRow[]> {
  const r = await sql<DocRow>`
    WITH RECURSIVE up(id) AS (
        SELECT d.id FROM documents d WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}
        UNION SELECT d.supersedes_id FROM up JOIN documents d ON d.tenant_id = app.tenant_id() AND d.id = up.id WHERE d.supersedes_id IS NOT NULL
      ), down(id) AS (
        SELECT d.id FROM documents d WHERE d.tenant_id = app.tenant_id() AND d.id = ${id}
        UNION SELECT d.id FROM down JOIN documents d ON d.tenant_id = app.tenant_id() AND d.supersedes_id = down.id
      )
    SELECT ${COLS} FROM ${FROM}
     WHERE d.tenant_id = app.tenant_id() AND d.id IN (SELECT id FROM up UNION SELECT id FROM down)
     ORDER BY d.version_no, d.id`.execute(tx);
  return r.rows;
}

/** A clean newer version of `id` exists (visible to the caller). */
export async function hasCleanSuccessor(tx: Tx, id: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    WITH RECURSIVE down(id) AS (
      SELECT d.id FROM documents d WHERE d.tenant_id = app.tenant_id() AND d.supersedes_id = ${id}
      UNION SELECT d.id FROM down JOIN documents d ON d.tenant_id = app.tenant_id() AND d.supersedes_id = down.id)
    SELECT EXISTS (SELECT 1 FROM documents d JOIN down ON down.id = d.id WHERE d.tenant_id = app.tenant_id() AND d.scan_status = 'clean') AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/**
 * The bytes' key material of a CLEAN document the caller can read (R-DOC-3, R-DOC-7): the join itself requires
 * scan_status 'clean' and a live document object, so a pending or blocked document never streams, whoever asks.
 */
export async function cleanObjectOf(tx: Tx, id: string): Promise<{ object_id: string; storage_key: string; dek_wrapped: Buffer; content_type: string; byte_size: string; display_name: string } | null> {
  const r = await sql<{ object_id: string; storage_key: string; dek_wrapped: Buffer; content_type: string; byte_size: string; display_name: string }>`
    SELECT o.id AS object_id, o.storage_key, o.dek_wrapped, o.content_type, o.byte_size::text AS byte_size, d.display_name
      FROM documents d JOIN stored_objects o ON o.tenant_id = d.tenant_id AND o.id = d.object_id
     WHERE d.tenant_id = app.tenant_id() AND d.id = ${id} AND d.scan_status = 'clean'
       AND o.purpose = 'document' AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL`.execute(tx);
  return r.rows[0] ?? null;
}

export async function portalCleared(tx: Tx): Promise<boolean> {
  const r = await sql<{ c: boolean }>`SELECT app.platform_cleared('platform:portal') AS c`.execute(tx);
  return r.rows[0]?.c === true;
}

/** A contact the caller sees in detail, with its merge state (null: invisible). */
export async function visibleContact(tx: Tx, id: string): Promise<{ id: string; mergedIntoContactId: string | null } | null> {
  const r = await sql<{ id: string; merged_into_contact_id: string | null }>`
    SELECT id, merged_into_contact_id FROM contacts
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND deleted_at IS NULL AND app.contact_detail_visible(tenant_id, id)`.execute(tx);
  const c = r.rows[0];
  return c ? { id: c.id, mergedIntoContactId: c.merged_into_contact_id } : null;
}

/**
 * The root survivor of a merged-away record when the caller sees the survivor in detail but not the record itself
 * (contacts RLS hides a closed, unowned loser; documents_select still shows its documents, 0075), else null.
 */
export async function visibleMergeRootOf(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ root: string }>`
    SELECT root FROM (SELECT app.contact_merge_root(app.tenant_id(), ${contactId}::uuid) AS root) x
     WHERE root <> ${contactId}::uuid AND app.contact_detail_visible(app.tenant_id(), root)`.execute(tx);
  return r.rows[0]?.root ?? null;
}

export async function scopeVisible(tx: Tx, scope: DocumentScope): Promise<boolean> {
  if (scope.kind === 'contact') return (await visibleContact(tx, scope.id)) !== null;
  const r =
    scope.kind === 'deal'
      ? await sql<{ x: boolean }>`SELECT EXISTS (SELECT 1 FROM deals WHERE tenant_id = app.tenant_id() AND id = ${scope.id}) AS x`.execute(tx)
      : await sql<{ x: boolean }>`SELECT EXISTS (SELECT 1 FROM listings WHERE tenant_id = app.tenant_id() AND id = ${scope.id}) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/** The newest blocked reason the caller may read (audit rows: Owner/Admin only); null otherwise. */
export async function blockedReasonOf(tx: Tx, id: string): Promise<'malware' | 'unscannable' | null> {
  const r = await sql<{ reason: string | null }>`
    SELECT changes->'blocked_reason_code'->>'to' AS reason FROM audit_log
     WHERE tenant_id = app.tenant_id() AND action = 'document.scanned' AND entity_type = 'document' AND entity_id = ${id}
     ORDER BY occurred_at DESC LIMIT 1`.execute(tx);
  const v = r.rows[0]?.reason;
  return v === 'malware' || v === 'unscannable' ? v : null;
}
