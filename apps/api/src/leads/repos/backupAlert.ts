// Reads and writes of the minute-three backup alert (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-14..17), all in
// the job's own transaction as the system actor of the inquiry's tenant. Indexes: lead_inquiries' primary key; the
// person's messages and calls by messages_contact_idx / calls_contact_idx (the same reads as the team work queue,
// accountability/repos/teamQueue.ts, whose human-attempt predicates are used word for word);
// lead_backup_alerts_inquiry_once; contact_collaborators' primary key; team_members_user_idx.
import type { MembershipStatus } from '@realty/core/ownership';
import type { AlertFallbackReason, AlertRecipient } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { ANSWERED_CALL, ANSWERED_FOR_INQUIRY, ARRIVAL, HUMAN_CALL, HUMAN_MESSAGE } from '../../accountability/repos/teamQueue.js';

export interface AlertInquiryRow {
  id: string;
  contact_id: string;
  lead_source_id: string;
  /** the time the source claims (kept as said; it decides nothing here) */
  received_at: Date;
  /** when the inquiry row was written: when the lead reached the team */
  created_at: Date;
  /** R-TEAMQ-19: THE arrival (accountability/repos/teamQueue.ts ARRIVAL), which every "since the arrival" below reads */
  arrived_at: Date;
  outcome: string;
  source_name: string;
  /** the source's coverage switch, now */
  covered: boolean;
  backup_user_id: string | null;
  backup_status: MembershipStatus | null;
}

export async function inquiryForAlert(tx: Tx, inquiryId: string): Promise<AlertInquiryRow | null> {
  const r = await sql<AlertInquiryRow>`
    SELECT i.id, i.contact_id, i.lead_source_id, i.received_at, i.created_at, ${ARRIVAL} AS arrived_at, i.outcome, s.name AS source_name, s.covered, s.backup_user_id, bm.status AS backup_status
      FROM lead_inquiries i
      JOIN lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
      LEFT JOIN memberships bm ON bm.tenant_id = s.tenant_id AND bm.user_id = s.backup_user_id
     WHERE i.tenant_id = app.tenant_id() AND i.id = ${inquiryId}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function alreadyDecided(tx: Tx, inquiryId: string): Promise<boolean> {
  const r = await sql`SELECT 1 FROM lead_backup_alerts WHERE tenant_id = app.tenant_id() AND inquiry_id = ${inquiryId}::uuid`.execute(tx);
  return r.rows.length > 0;
}

export interface PersonRow {
  id: string;
  ownership_state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  deleted: boolean;
  owner_user_id: string | null;
  owner_name: string | null;
  offered_to_user_id: string | null;
  offered_to_name: string | null;
  pond_id: string | null;
  pond_name: string | null;
}

/** The record the person lives on now (a merge is followed, at most 16 hops), with who has it. */
export async function personNow(tx: Tx, contactId: string): Promise<PersonRow | null> {
  const r = await sql<PersonRow>`
    WITH RECURSIVE up(id, next, depth) AS (
      SELECT c.id, c.merged_into_contact_id, 0 FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}::uuid
      UNION ALL
      SELECT c.id, c.merged_into_contact_id, up.depth + 1 FROM up JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = up.next
       WHERE up.depth < 16
    )
    SELECT c.id, c.ownership_state, c.deleted_at IS NOT NULL AS deleted, c.owner_user_id, ou.display_name AS owner_name,
           c.offered_to_user_id, fu.display_name AS offered_to_name, c.pond_id, p.name AS pond_name
      FROM up JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = up.id
      LEFT JOIN users ou ON ou.id = c.owner_user_id
      LEFT JOIN users fu ON fu.id = c.offered_to_user_id
      LEFT JOIN ponds p ON p.tenant_id = c.tenant_id AND p.id = c.pond_id
     WHERE up.next IS NULL
     ORDER BY up.depth DESC LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * Whether a person has made a human attempt on this person at or after `since`: exactly the team work queue's and
 * the scoreboard's touch (HUMAN_MESSAGE, HUMAN_CALL: never an assistant or system message, a bulk send, an invite,
 * imported history or a logged note).
 */
export async function humanAttemptSince(tx: Tx, contactId: string, since: Date): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${contactId}::uuid AND ${HUMAN_MESSAGE} AND m.dispatched_at >= ${since.toISOString()}::timestamptz)
        OR EXISTS (SELECT 1 FROM calls k WHERE k.tenant_id = app.tenant_id() AND k.contact_id = ${contactId}::uuid AND ${HUMAN_CALL} AND k.started_at >= ${since.toISOString()}::timestamptz) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/**
 * Whether a person answered the lead's own call since the inquiry arrived, or the call that IS the inquiry (they have
 * spoken: nobody needs alerting). The queue's and the report's own predicate (R-TEAMQ-22: ANSWERED_CALL and
 * ANSWERED_FOR_INQUIRY, which matches the call that created a call-in inquiry by the inquiry's own reference).
 */
export async function answeredCallSince(tx: Tx, contactId: string, inquiryId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM (SELECT i.external_id, ${ARRIVAL} AS arrived_at FROM lead_inquiries i WHERE i.tenant_id = app.tenant_id() AND i.id = ${inquiryId}::uuid) i
                     JOIN calls k ON k.tenant_id = app.tenant_id() AND k.contact_id = ${contactId}::uuid
                    WHERE ${ANSWERED_CALL} AND ${ANSWERED_FOR_INQUIRY}) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/** The active leads of the teams `userId` is in, not themself, in id order (the escalation order of R-OWN-13). */
export async function teamLeadsOf(tx: Tx, userId: string): Promise<{ user_id: string }[]> {
  const r = await sql<{ user_id: string }>`
    SELECT DISTINCT l.user_id
      FROM team_members tm
      JOIN team_members l ON l.tenant_id = tm.tenant_id AND l.team_id = tm.team_id AND l.is_lead
      JOIN memberships m ON m.tenant_id = l.tenant_id AND m.user_id = l.user_id AND m.status = 'active'
     WHERE tm.tenant_id = app.tenant_id() AND tm.user_id = ${userId}::uuid AND l.user_id <> ${userId}::uuid
     ORDER BY l.user_id`.execute(tx);
  return r.rows;
}

/** The team's active Owners and Admins, in id order (R-TEAMQ-21: who hears it when there is no team lead to tell). */
export async function ownersAndAdmins(tx: Tx): Promise<string[]> {
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND role IN ('owner', 'admin') AND status = 'active' ORDER BY user_id`.execute(tx);
  return r.rows.map((x) => x.user_id);
}

export interface AlertInsert {
  id: string;
  inquiryId: string;
  leadSourceId: string;
  arrivedAt: Date;
  dueAt: Date;
  decidedAt: Date;
  outcome: 'alerted' | 'human_attempt' | 'answered_call' | 'source_not_covered' | 'no_recipient' | 'lead_closed';
  /** the alerted member; the first of them (id order) when the Owners and Admins were alerted */
  alertedUserId: string | null;
  recipient: AlertRecipient | null;
  /** R-TEAMQ-21: why it was not the named backup (null when it was, or when nobody was alerted) */
  fallbackReason: AlertFallbackReason | null;
  /** R-TEAMQ-21: how many members were alerted */
  alertedCount: number;
  holder: 'owner' | 'on_offer' | 'pond' | 'unassigned' | null;
  holderUserId: string | null;
  holderPondId: string | null;
  grantExpiresAt: Date | null;
}

/** Writes the one row of an inquiry. false: another run already decided it (lead_backup_alerts_inquiry_once). */
export async function insertAlert(tx: Tx, a: AlertInsert): Promise<boolean> {
  const iso = (d: Date | null) => (d === null ? null : d.toISOString());
  const r = await sql`
    INSERT INTO lead_backup_alerts (tenant_id, id, inquiry_id, lead_source_id, arrived_at, due_at, decided_at, outcome, alerted_user_id, recipient, fallback_reason, alerted_count,
                                    holder, holder_user_id, holder_pond_id, grant_expires_at)
    VALUES (app.tenant_id(), ${a.id}::uuid, ${a.inquiryId}::uuid, ${a.leadSourceId}::uuid, ${iso(a.arrivedAt)}::timestamptz, ${iso(a.dueAt)}::timestamptz, ${iso(a.decidedAt)}::timestamptz,
            ${a.outcome}, ${a.alertedUserId}::uuid, ${a.recipient}, ${a.fallbackReason}, ${a.alertedCount}, ${a.holder}, ${a.holderUserId}::uuid, ${a.holderPondId}::uuid, ${iso(a.grantExpiresAt)}::timestamptz)
    ON CONFLICT ON CONSTRAINT lead_backup_alerts_inquiry_once DO NOTHING
    RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

/**
 * The alerted backup's time-boxed access to this one lead: a `backup` collaborator row until `expiresAt`. A member
 * who already collaborates on the lead in another role keeps that access exactly as it is (null is returned: no
 * grant was given); an ended or expired row, or an earlier backup grant, becomes a backup grant until `expiresAt`.
 */
export async function grantBackupAccess(tx: Tx, contactId: string, userId: string, expiresAt: Date): Promise<Date | null> {
  const r = await sql<{ expires_at: Date }>`
    INSERT INTO contact_collaborators (tenant_id, contact_id, user_id, role, expires_at)
    VALUES (app.tenant_id(), ${contactId}::uuid, ${userId}::uuid, 'backup', ${expiresAt.toISOString()}::timestamptz)
    ON CONFLICT (tenant_id, contact_id, user_id) DO UPDATE SET role = 'backup', expires_at = EXCLUDED.expires_at, removed_at = NULL, added_by_user_id = NULL
      WHERE contact_collaborators.role = 'backup' OR contact_collaborators.removed_at IS NOT NULL
         OR (contact_collaborators.expires_at IS NOT NULL AND contact_collaborators.expires_at <= now())
    RETURNING expires_at`.execute(tx);
  return r.rows[0]?.expires_at ?? null;
}

/**
 * R-TEAMQ-17 (review fix L2): the alert row is the claim on its inquiry, and a run that loses the claim commits
 * NOTHING. The backup's grant and the row are written inside one savepoint: when the row turns out to exist (a
 * concurrent run decided this inquiry first; this insert waited for its commit), the savepoint is rolled back, which
 * takes this run's write to the collaborator row with it. The row stores the grant actually given (null when the
 * member already collaborates on the lead in another role: their own access is left as it is).
 */
export async function claimAlert(tx: Tx, a: Omit<AlertInsert, 'grantExpiresAt'>, grant: { contactId: string; userId: string; expiresAt: Date } | null): Promise<{ won: boolean; granted: Date | null }> {
  await sql`SAVEPOINT backup_alert_claim`.execute(tx);
  const granted = grant === null ? null : await grantBackupAccess(tx, grant.contactId, grant.userId, grant.expiresAt);
  const won = await insertAlert(tx, { ...a, grantExpiresAt: granted });
  if (!won) {
    await sql`ROLLBACK TO SAVEPOINT backup_alert_claim`.execute(tx);
    await sql`RELEASE SAVEPOINT backup_alert_claim`.execute(tx);
    return { won: false, granted: null };
  }
  await sql`RELEASE SAVEPOINT backup_alert_claim`.execute(tx);
  return { won: true, granted };
}
