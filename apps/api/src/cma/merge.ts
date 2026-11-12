// api/cma's merge step (R-CMA-8, F15; batch 10 review ownership-data/F4), run by the ownership engine in the merge's
// move transaction as a tenant-wide actor (packages/db ownership/merge.ts MergeStep: inline for the system, Owner or
// Admin; in the ownership.followup for a Team Lead).
//
// A merge moves no CMA: the survivor lists the merged-away record's CMAs and api/cma refuses their edits
// (CONTACT_MERGED). But one creator keeps one open draft per home across the person: a merged-away record's open
// draft whose creator already holds an open draft for the same home (address key) on another record of the person is
// superseded, as S0's guard supersedes a draft whose address deletion collides with an open no-address draft. Every
// other draft stays as it was. draft -> superseded is a transition 0061's guard allows; 0061's update policy admits a
// tenant-wide actor; app.contact_person_ids (0043) sees every record of the person for one. Idempotent. No SECURITY
// DEFINER is involved (0061's smoke test holds that none names cma_reports).
import type { MergeStep } from '@realty/db';
import { sql } from 'kysely';

export const cmaMergeStep: MergeStep = async (tx, survivorId, loserId) => {
  await sql`
    UPDATE cma_reports l SET status = 'superseded'
     WHERE l.tenant_id = app.tenant_id() AND l.contact_id = ${loserId}::uuid AND l.status = 'draft' AND l.subject #>> '{resolved,addressKey}' IS NOT NULL
       AND EXISTS (SELECT 1 FROM cma_reports s
                    WHERE s.tenant_id = l.tenant_id AND s.status = 'draft' AND s.created_by_user_id = l.created_by_user_id AND s.contact_id <> l.contact_id
                      AND s.contact_id = ANY (app.contact_person_ids(l.tenant_id, ${survivorId}::uuid))
                      AND s.subject #>> '{resolved,addressKey}' = l.subject #>> '{resolved,addressKey}')`.execute(tx);
};
