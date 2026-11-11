// Contact facts for core.can() (R-PERM-1) established from RLS-visible rows inside the caller's transaction.
import type { ResourceFacts } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface ContactBasics {
  id: string;
  ownerUserId: string | null;
  ownershipState: string;
  periodSeq: number | null;
  displayName: string;
  firstName: string | null;
  stage: string;
}

/** The contact if the caller can see its DETAIL (phones, timeline); null otherwise (404, R-PERM-5). */
export async function detailVisibleContact(tx: Tx, contactId: string): Promise<ContactBasics | null> {
  const r = await sql<{ id: string; owner_user_id: string | null; ownership_state: string; ownership_period_seq: string | null; display_name: string; first_name: string | null; stage: string; v: boolean }>`
    SELECT id, owner_user_id, ownership_state, ownership_period_seq, display_name, first_name, stage,
           app.contact_detail_visible(tenant_id, id) AS v
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId} AND deleted_at IS NULL`.execute(tx);
  const c = r.rows[0];
  if (!c || !c.v) return null;
  return { id: c.id, ownerUserId: c.owner_user_id, ownershipState: c.ownership_state, periodSeq: c.ownership_period_seq === null ? null : Number(c.ownership_period_seq), displayName: c.display_name, firstName: c.first_name, stage: c.stage };
}

/** Relationship facts of the CURRENT user (the transaction's app.user_id()) to a contact. */
export async function contactFacts(tx: Tx, contactId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ own: boolean; collab: boolean; team: boolean; deal: boolean; offer: boolean; pond: boolean }>`
    SELECT c.owner_user_id IS NOT DISTINCT FROM app.user_id() AND c.owner_user_id IS NOT NULL AS own,
           c.id = ANY (app.my_collab_contact_ids()) AS collab,
           c.owner_user_id = ANY (app.my_team_member_ids()) AS team,
           c.id = ANY (app.my_deal_contact_ids()) AS deal,
           c.offered_to_user_id IS NOT DISTINCT FROM app.user_id() AND c.offered_to_user_id IS NOT NULL AS offer,
           (c.ownership_state = 'in_pond' AND (c.pond_id = ANY (app.my_pond_ids()) OR app.my_role() = 'team_lead')) AS pond
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId} AND c.deleted_at IS NULL
       AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  const f = r.rows[0];
  if (!f) return null;
  return { own: f.own === true, collaborator: f.collab === true, team: f.team === true, deal: f.deal === true, offer: f.offer === true, pond: f.pond === true };
}

/** Open deal or upcoming/recent appointment: a human free-form message is informational (R-CONSENT-5). */
export async function dealOrAppointmentContext(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id = ${contactId} AND d.stage NOT IN ('closed','lost'))
        OR EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                    WHERE dc.tenant_id = app.tenant_id() AND dc.contact_id = ${contactId} AND d.stage NOT IN ('closed','lost'))
        OR EXISTS (SELECT 1 FROM appointments a WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ${contactId}
                    AND a.status NOT IN ('canceled') AND a.starts_at > now() - interval '7 days') AS x`.execute(tx);
  return r.rows[0]?.x ?? false;
}

/**
 * The surviving record of a merged-away contact, followed along merge chains to the record the person lives on
 * now, when the caller's RLS shows that record's detail; null when it does not (R-PERM-5: a CONTACT_MERGED refusal
 * names the survivor only to whoever sees it, F1/F2).
 */
export async function visibleSurvivorOf(tx: Tx, contactId: string): Promise<string | null> {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE up(id, next, depth) AS (
      SELECT c.id, c.merged_into_contact_id, 0 FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}
      UNION ALL
      SELECT c.id, c.merged_into_contact_id, up.depth + 1 FROM up JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = up.next
       WHERE up.depth < 16
    )
    SELECT up.id FROM up JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = up.id
     WHERE up.depth > 0 AND up.next IS NULL AND c.deleted_at IS NULL AND app.contact_detail_visible(c.tenant_id, c.id)`.execute(tx);
  return r.rows[0]?.id ?? null;
}
