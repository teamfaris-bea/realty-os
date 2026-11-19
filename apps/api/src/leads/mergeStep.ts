// What a merge does to a person's inquiries and to a backup's time-boxed access (b19 team-queue lane, review fix L5;
// DATA_MODEL R-TEAMQ-26, E891). A merge step (packages/db ownership/merge.ts MergeStep, listed in ../mergeSteps.ts):
// it runs in the merge's move transaction, after the communication move, as the same tenant-wide actor (inline for
// the system, an Owner or an Admin; in the ownership.followup for a Team Lead), like the messages and calls it
// follows (R-OWN-24).
//
// Before this step a merge moved the person's messages and calls and left their inquiries on the merged-away record,
// which is closed: a waiting inquiry dropped out of the team work queue and the response report, and a backup alerted
// for it kept access to the old record only, so they could not open the person they had been alerted about.
//   1. the inquiries of every record the merge brings in (the merged-away record and the records merged into it
//      before, along chains) are re-pointed to the survivor: lead_inquiries.contact_id only. The inquiry keeps its
//      id, its source, its times and its outcome, so its minute-three job, its lead_backup_alerts row (keyed on the
//      inquiry) and its place in the queue and the report follow it;
//   2. a LIVE `backup` grant on one of those records is carried to the survivor with the same expiry (never longer),
//      and ended on the old record. A member who already collaborates on the survivor in another role keeps exactly
//      that access; an expired, ended or removed grant is not revived.
// It changes no owner, sends nothing and notifies nobody. Idempotent: a re-delivered follow-up finds nothing to move.
import type { MergeStep } from '@realty/db';
import { sql } from 'kysely';

export const teamQueueMergeStep: MergeStep = async (tx, survivorId, loserId) => {
  // 1. the inquiries (lead_inquiries_contact_idx per brought record)
  await sql`
    WITH RECURSIVE brought(id) AS (
      SELECT ${loserId}::uuid
      UNION
      SELECT c.id FROM brought b JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.merged_into_contact_id = b.id
    )
    UPDATE lead_inquiries i SET contact_id = ${survivorId}::uuid
     WHERE i.tenant_id = app.tenant_id() AND i.contact_id IN (SELECT id FROM brought WHERE id <> ${survivorId}::uuid)`.execute(tx);
  // 2. live backup grants (contact_collaborators' primary key): to the survivor with the same expiry, unless the
  //    member holds another role there; then ended on the old record
  await sql`
    WITH RECURSIVE brought(id) AS (
      SELECT ${loserId}::uuid
      UNION
      SELECT c.id FROM brought b JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.merged_into_contact_id = b.id
    ),
    live AS (
      SELECT k.user_id, max(k.expires_at) AS expires_at FROM contact_collaborators k
       WHERE k.tenant_id = app.tenant_id() AND k.contact_id IN (SELECT id FROM brought WHERE id <> ${survivorId}::uuid)
         AND k.role = 'backup' AND k.removed_at IS NULL AND k.expires_at IS NOT NULL AND k.expires_at > now()
       GROUP BY k.user_id
    )
    INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, expires_at)
    SELECT app.tenant_id(), ${survivorId}::uuid, live.user_id, 'backup', live.expires_at FROM live
    ON CONFLICT (tenant_id, contact_id, user_id) DO UPDATE
       SET role = 'backup', expires_at = GREATEST(EXCLUDED.expires_at, CASE WHEN contact_collaborators.role = 'backup' AND contact_collaborators.removed_at IS NULL THEN contact_collaborators.expires_at END),
           removed_at = NULL, added_by_user_id = NULL
     WHERE contact_collaborators.role = 'backup' OR contact_collaborators.removed_at IS NOT NULL
        OR (contact_collaborators.expires_at IS NOT NULL AND contact_collaborators.expires_at <= now())`.execute(tx);
  await sql`
    WITH RECURSIVE brought(id) AS (
      SELECT ${loserId}::uuid
      UNION
      SELECT c.id FROM brought b JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.merged_into_contact_id = b.id
    )
    UPDATE contact_collaborators k SET expires_at = now()
     WHERE k.tenant_id = app.tenant_id() AND k.contact_id IN (SELECT id FROM brought WHERE id <> ${survivorId}::uuid)
       AND k.role = 'backup' AND k.removed_at IS NULL AND k.expires_at IS NOT NULL AND k.expires_at > now()`.execute(tx);
};
