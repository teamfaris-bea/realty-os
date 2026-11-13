// api/cma's merge rules for open drafts (R-CMA-8, F15; batch 10 review and re-review ownership-data/F4).
//
// A merge moves no CMA: the survivor lists the merged-away records' CMAs and api/cma refuses their edits
// (CONTACT_MERGED). But one creator keeps one open draft per home (address key) across the person's records (within one
// record, per address row: F15, b11 merge review F2). Three passes keep it:
//   - cmaMergeStep (below), the merge step (packages/db ownership/merge.ts MergeStep: inline for the system, Owner or
//     Admin; in the ownership.followup for a Team Lead), in the merge's move transaction, as the tenant-wide actor;
//   - service.ts supersedeMergedAwayDrafts, in the caller's own transaction after a one-tap or prepare: the caller's own
//     drafts on the records merged into the contact, along chains through 0075's definer tree (app.contact_merge_tree_ids),
//     so past a closed middle record too since the batch 11 merge; 0061's update policy admits their creator;
//   - supersedeCreatorsDraftsAcrossPerson (below), right after that transaction (routes.ts), as the tenant's system
//     actor: independent of the caller's policies, and it also sees a merge that committed before it starts.
// The two here: only draft -> superseded, which 0061's guard allows; 0061's update policy admits a tenant-wide actor;
// app.contact_person_ids (0043) sees every record of the person for one. Every other draft stays as it was (a
// merged-away record's only draft for a home stays open: V2-A may share it to the survivor). Idempotent. No SECURITY
// DEFINER names cma_reports (0061's smoke test, rls_smoke_cma.sql, holds that none does; 0075's helpers, which the
// caller's pass reads, return contact ids only).
import type { MergeStep, Tx } from '@realty/db';
import { sql } from 'kysely';

/**
 * The merge step. The records the merge brings into the survivor's person are the loser and every record merged into
 * it before, along chains (re-review ownership-data/F4: not the loser row alone). An open draft on one of them is
 * superseded when its creator holds another open draft for the same home on another record that wins: any record of the
 * survivor's side (the survivor, and records merged into it before), else a newer draft on another brought record. So
 * the survivor's side keeps its draft, and among brought drafts with none there the newest stays.
 */
export const cmaMergeStep: MergeStep = async (tx, survivorId, loserId) => {
  await sql`
    WITH RECURSIVE brought(id) AS (
      SELECT ${loserId}::uuid
      UNION
      SELECT c.id FROM brought b JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.merged_into_contact_id = b.id
    ),
    kept(id) AS (
      SELECT p.id FROM unnest(app.contact_person_ids(app.tenant_id(), ${survivorId}::uuid)) AS p(id)
       WHERE p.id NOT IN (SELECT id FROM brought)
    )
    UPDATE cma_reports l SET status = 'superseded'
     WHERE l.tenant_id = app.tenant_id() AND l.contact_id IN (SELECT id FROM brought) AND l.status = 'draft'
       AND l.subject #>> '{resolved,addressKey}' IS NOT NULL
       AND EXISTS (SELECT 1 FROM cma_reports s
                    WHERE s.tenant_id = l.tenant_id AND s.status = 'draft' AND s.created_by_user_id = l.created_by_user_id AND s.contact_id <> l.contact_id
                      AND s.subject #>> '{resolved,addressKey}' = l.subject #>> '{resolved,addressKey}'
                      AND (s.contact_id IN (SELECT id FROM kept)
                           OR (s.contact_id IN (SELECT id FROM brought) AND (s.created_at, s.id) > (l.created_at, l.id))))`.execute(tx);
};

/**
 * After a one-tap or prepare stored or kept the open draft `draftId` of a live contact: its creator's other open drafts
 * for the same home on the other records of that contact's person (records merged into it, along chains) are
 * superseded (re-review ownership-data/F4). Run as the tenant's system actor (routes.ts), after the caller's own pass
 * (service.ts supersedeMergedAwayDrafts, inside their transaction, over 0075's definer tree since the batch 11 merge), so
 * the rule does not rest on the caller's policies and also covers a merge that committed after that pass read. Keyed on
 * the draft alone: only that draft's creator's drafts are touched, only while the draft is open and its contact live,
 * and nothing is read back to the caller.
 */
export async function supersedeCreatorsDraftsAcrossPerson(tx: Tx, draftId: string): Promise<void> {
  await sql`
    UPDATE cma_reports l SET status = 'superseded'
      FROM cma_reports k
     WHERE k.tenant_id = app.tenant_id() AND k.id = ${draftId}::uuid AND k.status = 'draft' AND k.contact_id IS NOT NULL
       AND k.subject #>> '{resolved,addressKey}' IS NOT NULL
       AND EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = k.tenant_id AND c.id = k.contact_id AND c.merged_into_contact_id IS NULL AND c.deleted_at IS NULL)
       AND l.tenant_id = k.tenant_id AND l.status = 'draft' AND l.created_by_user_id = k.created_by_user_id AND l.contact_id <> k.contact_id
       AND l.contact_id = ANY (app.contact_person_ids(k.tenant_id, k.contact_id))
       AND l.subject #>> '{resolved,addressKey}' = k.subject #>> '{resolved,addressKey}'`.execute(tx);
}
