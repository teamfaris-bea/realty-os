// Queries for privacy erasure (R-DATA-4, E59). All run as the session actor under RLS (Owner/Admin: every
// contact of the tenant is visible to them, merged records included).
import type { Tx } from '@realty/db';
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
