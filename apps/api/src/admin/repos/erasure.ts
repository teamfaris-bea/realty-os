// Queries for privacy erasure (R-DATA-4, E59). All run as the session actor under RLS (Owner/Admin: every
// contact of the tenant is visible to them, merged records included).
import { type Tx, lockAddresses } from '@realty/db';
import { sql } from 'kysely';

export interface DealLinkRow {
  id: string;
  name: string;
  stage: string;
  is_primary: boolean;
  is_party: boolean;
}

export async function contactExists(tx: Tx, contactId: string): Promise<{ display_name: string } | null> {
  const r = await sql<{ display_name: string }>`SELECT display_name FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * The person's records: the contact and every contact merged into it, along merge chains (the same set
 * app.contact_merge_tree gives app.erase_contact, migration 0037). Erasing the person erases all of them, so the
 * deal checks below cover all of them. UNION (not UNION ALL) ends even on a corrupt cycle.
 */
export async function mergeTree(tx: Tx, contactId: string): Promise<string[]> {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE tree(id) AS (
      SELECT c.id FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid
      UNION
      SELECT l.id FROM contacts l JOIN tree t ON l.tenant_id = app.tenant_id() AND l.merged_into_contact_id = t.id
    )
    SELECT id FROM tree`.execute(tx);
  return r.rows.map((x) => x.id);
}

/**
 * Locks the person before their do-not-contact is carried and they are erased (batch 5 review F1-ERASE-DNC-TOCTOU;
 * migration 0041), in the global lock order (packages/db/src/locks.ts):
 *   1. app.lock_address on the HMAC of every point of every record of the person (`records`, from mergeTree), live or
 *      removed, sorted: an intake, accept or import that matched the person by one of their addresses holds one of
 *      these until it commits, so it is waited for whole, the phone it attaches included;
 *   2. the records themselves FOR UPDATE, sorted by id: any other transaction that inserted a point (or any child row)
 *      of one of them holds FOR KEY SHARE on it through the foreign key, so it is waited for too (POST
 *      /contacts/:id/points locks only the NEW address); one that comes later waits for the erasure, then fails its
 *      foreign key.
 * The carry that follows reads after both, so it sees every point those writers added. A point committed while this
 * waited has an address this did not lock; the carry's recordConsentEvent takes that lock after the row locks (out of
 * order: a rare window that Postgres resolves as a deadlock, and the request is retried). app.purge_contact_internal
 * takes the same row locks before its own check, so a write this missed still fails closed.
 */
export async function lockPerson(tx: Tx, records: readonly string[]): Promise<void> {
  const ids = [...records];
  const r = await sql<{ h: string }>`
    SELECT DISTINCT encode(address_hmac, 'hex') AS h FROM contact_points
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${ids}::uuid[])`.execute(tx);
  await lockAddresses(tx, r.rows.map((x) => x.h));
  await sql`SELECT id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[]) ORDER BY id FOR UPDATE`.execute(tx);
}

/** Every deal one of the person's records (`ids`, from mergeTree) is on: as the primary contact and/or a party (deal_contacts). */
export async function dealLinks(tx: Tx, ids: readonly string[]): Promise<DealLinkRow[]> {
  const r = await sql<DealLinkRow>`
    SELECT d.id, d.name, d.stage,
           COALESCE(d.primary_contact_id = ANY (${[...ids]}::uuid[]), false) AS is_primary,
           EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ANY (${[...ids]}::uuid[])) AS is_party
      FROM deals d
     WHERE d.tenant_id = app.tenant_id()
       AND (d.primary_contact_id = ANY (${[...ids]}::uuid[])
            OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ANY (${[...ids]}::uuid[])))
     ORDER BY d.created_at, d.id`.execute(tx);
  return r.rows;
}

export interface RetainedDocumentRow {
  id: string;
  contact_id: string;
  legal_hold: boolean;
  /** only while it is still in the future (a past date no longer blocks) */
  retention_until: Date | null;
  /** what tells two blocking documents apart on the page (b11 ownership-data/F4); the preview is Owner/Admin only */
  kind: string;
  display_name: string;
  version_no: number;
  created_at: Date;
}

/**
 * The contact documents of the person's records (`ids`, from mergeTree) that the database's erasure refuses on
 * (0041 app.purge_contact_internal: DOCUMENT_RETAINED): on legal hold, or inside a retention period. Owner/Admin see
 * every document, pending and blocked included (documents_clean_only lets tenant-wide roles read them). Sorted by id.
 */
export async function retainedDocuments(tx: Tx, ids: readonly string[]): Promise<RetainedDocumentRow[]> {
  const r = await sql<RetainedDocumentRow>`
    SELECT id, contact_id, legal_hold, CASE WHEN retention_until > now() THEN retention_until END AS retention_until,
           kind, display_name, version_no, created_at
      FROM documents
     WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[]) AND (legal_hold OR retention_until > now())
     ORDER BY id`.execute(tx);
  return r.rows;
}

export interface ErasedWithRow {
  call_recordings: number;
  documents: number;
  cma_reports: number;
}

/**
 * What erasing the person's records (`ids`, from mergeTree) deletes that a merge left on them (b11 ownership-data/F2).
 * A merge moves a record's calls to the survivor (packages/db ownership/merge.ts), but no merge path moves a call's
 * recording: it keeps the merged-away record's contact_id, and its transcript cascades with it. A record's documents
 * and CMA reports never move either (0069, 0061; the survivor lists them through 0075 and 0077).
 * app.purge_contact_internal shreds the objects of each record's recordings and documents, and the contact's delete
 * cascades the rows. A recording already shredded (no audio left) is not counted. Owner/Admin read every row
 * (tenant-wide: recording scope 'all', every document, every CMA report).
 */
export async function erasedWith(tx: Tx, ids: readonly string[]): Promise<ErasedWithRow> {
  const r = await sql<ErasedWithRow>`
    SELECT (SELECT count(*)::int FROM recordings
             WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[]) AND status <> 'shredded') AS call_recordings,
           (SELECT count(*)::int FROM documents WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[])) AS documents,
           (SELECT count(*)::int FROM cma_reports WHERE tenant_id = app.tenant_id() AND contact_id = ANY (${[...ids]}::uuid[])) AS cma_reports`.execute(tx);
  return r.rows[0]!;
}

/** The record a merged-away contact's merge chain ends at (null when it was never merged away; 0075 helper). */
export async function mergedIntoRoot(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ root: string }>`SELECT app.contact_merge_root(app.tenant_id(), ${contactId}::uuid) AS root`.execute(tx);
  const root = r.rows[0]?.root ?? contactId;
  return root === contactId ? null : root;
}

export interface ListingDocumentsRow {
  listing_id: string;
  address_line1: string;
  documents: number;
}

/**
 * The listings one of the person's records is a seller or co-seller on that hold documents (a listing agreement names
 * the seller). Erasure removes the person's listing role, but the listing's documents are the listing's records and
 * stay (R-DATA-7; VERIFY WITH COUNSEL), so the preview says so (b11 ownership-data/F5).
 */
export async function listingDocuments(tx: Tx, ids: readonly string[]): Promise<ListingDocumentsRow[]> {
  const r = await sql<ListingDocumentsRow>`
    SELECT l.id AS listing_id, l.address_line1, count(d.id)::int AS documents
      FROM listings l JOIN documents d ON d.tenant_id = l.tenant_id AND d.listing_id = l.id
     WHERE l.tenant_id = app.tenant_id()
       AND EXISTS (SELECT 1 FROM listing_contacts lc WHERE lc.tenant_id = l.tenant_id AND lc.listing_id = l.id
                     AND lc.contact_id = ANY (${[...ids]}::uuid[]) AND lc.role IN ('seller','co_seller'))
     GROUP BY l.id, l.address_line1
     ORDER BY l.id`.execute(tx);
  return r.rows;
}

export interface UncarriedOptOutRow {
  kind: string;
  address: string;
  /** hex */
  hmac: string;
  channel: string;
  do_not_contact_event_id: string;
}

/**
 * Every (address, channel) of the person on which their person-level do-not-contact is not in the consent ledger
 * yet (app.person_optout_uncarried, migration 0037: the predicate app.purge_contact_internal refuses on), ordered by
 * HMAC and channel so concurrent writers take the address locks in one order. Runs under the caller's RLS: the
 * Owner/Admin and the system see every record of the person.
 */
export async function uncarriedOptOut(tx: Tx, contactId: string): Promise<UncarriedOptOutRow[]> {
  const r = await sql<UncarriedOptOutRow>`
    SELECT kind, address, encode(address_hmac, 'hex') AS hmac, channel, do_not_contact_event_id
      FROM app.person_optout_uncarried(app.tenant_id(), ${contactId}::uuid)
     ORDER BY address_hmac, channel, point_id`.execute(tx);
  return r.rows;
}

export async function eraseContact(tx: Tx, contactId: string, auditId: string, reason: string): Promise<void> {
  await sql`SELECT app.erase_contact(${contactId}::uuid, ${auditId}::uuid, ${reason})`.execute(tx);
}

export async function lockDeal(tx: Tx, dealId: string): Promise<{ stage: string; primary_contact_id: string | null } | null> {
  const r = await sql<{ stage: string; primary_contact_id: string | null }>`
    SELECT stage, primary_contact_id FROM deals WHERE tenant_id = app.tenant_id() AND id = ${dealId} FOR UPDATE`.execute(tx);
  return r.rows[0] ?? null;
}

export async function clearPrimary(tx: Tx, dealId: string): Promise<void> {
  await sql`UPDATE deals SET primary_contact_id = NULL, row_version = row_version + 1 WHERE tenant_id = app.tenant_id() AND id = ${dealId}`.execute(tx);
}

/** Takes the person's records (`ids`) off the deal as parties; the removed contact ids. */
export async function removeParty(tx: Tx, dealId: string, ids: readonly string[]): Promise<string[]> {
  const r = await sql<{ contact_id: string }>`
    DELETE FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId} AND contact_id = ANY (${[...ids]}::uuid[])
    RETURNING contact_id`.execute(tx);
  return r.rows.map((x) => x.contact_id);
}
