// Queries for privacy erasure (R-DATA-4, E59). All run as the session actor under RLS.
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

/** Every deal this contact is on: as the primary contact and/or a party (deal_contacts). */
export async function dealLinks(tx: Tx, contactId: string): Promise<DealLinkRow[]> {
  const r = await sql<DealLinkRow>`
    SELECT d.id, d.name, d.stage,
           d.primary_contact_id IS NOT DISTINCT FROM ${contactId}::uuid AS is_primary,
           EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${contactId}::uuid) AS is_party
      FROM deals d
     WHERE d.tenant_id = app.tenant_id()
       AND (d.primary_contact_id = ${contactId}::uuid
            OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${contactId}::uuid))
     ORDER BY d.created_at, d.id`.execute(tx);
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

export async function removeParty(tx: Tx, dealId: string, contactId: string): Promise<number> {
  const r = await sql`DELETE FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId} AND contact_id = ${contactId}`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}
