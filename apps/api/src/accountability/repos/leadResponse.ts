// Reads of the lead response report (b19 team-queue lane; DATA_MODEL R-TEAMQ-6..9). READ-ONLY, in the caller's
// transaction: RLS and the team scope of repos/teamQueue.ts decide which inquiries exist for them.
//
// One row per inbound inquiry that ARRIVED in [from, to) (repos/teamQueue.ts ARRIVAL, R-TEAMQ-19: the one arrival
// instant, never the source's claimed time alone; an ignored duplicate delivery is not an arrival; imports and people
// a member typed in never write lead_inquiries), with:
//   - the FIRST human attempt on the person at or after the arrival, by ANYONE: exactly the scoreboard's touch
//     (repos/teamQueue.ts HUMAN_MESSAGE / HUMAN_CALL, migration 0053), with who made it;
//   - that person's role to the lead AT THAT MOMENT: `owner` when the ledger's latest event at or before the
//     attempt names them as the owner (lead_ownership_events.owner_user_id is the owner AFTER the event),
//     `backup`, `team_lead` or `admin` when this inquiry's minute-three alert had gone to them, in that role, before
//     the attempt (lead_backup_alerts, b19 R-TEAMQ-18 and R-TEAMQ-25: `backup` only for the source's named backup;
//     read through its own policy, so a caller sees it exactly when they see the inquiry),
//     `collaborator` when contact_collaborators held them then, else `other`;
//   - the first automated message that went out after the arrival (reported apart, never an attempt);
//   - the first inbound call of the lead a PERSON answered since the arrival, or the call that is the inquiry itself
//     (R-TEAMQ-22: its own state, never an attempt).
// Indexes: see the header of repos/teamQueue.ts (inquiries by source and time; a person's messages and calls;
// the ledger's primary key; imports by loe_type_time_idx; an inquiry's backup alert by lead_backup_alerts_inquiry_once).
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { iso } from '../common.js';
import { ANSWERED_CALL, ANSWERED_FOR_INQUIRY, ARRIVAL, AUTOMATED_MESSAGE, HOLDER_COLUMNS, HOLDER_JOINS, HUMAN_CALL, HUMAN_MESSAGE, type HolderColumns, SEND_FAILED, TEAM_SCOPE } from './teamQueue.js';

/** Inquiries one report reads at most (the newest); a period that holds more says so (`truncated`). */
export const RESPONSE_READ_CAP = 5000;

export interface InquiryResponseRow extends HolderColumns {
  id: string;
  contact_id: string;
  /** the arrival (ARRIVAL) */
  arrived_at: Date;
  source_id: string;
  source_name: string;
  attempt_at: Date | null;
  attempt_kind: 'message' | 'call' | null;
  attempt_channel: string | null;
  attempt_by: string | null;
  attempt_by_name: string | null;
  /** R-TEAMQ-27: the provider reported that first attempt (a send) as failed, undelivered or bounced */
  attempt_failed: boolean | null;
  /** the lead's owner when the attempt was made (null: nobody owned it then, or the ledger is not the caller's to read) */
  owner_then: string | null;
  collaborator_then: boolean;
  /**
   * the attempt was made, at or after the alert, by someone this inquiry's alert went to (R-TEAMQ-25: in the role they
   * were alerted in: the alerted member for `backup` and `team_lead`; any Owner or Admin for `admins`)
   */
  alerted_then: boolean;
  /** this inquiry's backup alert, when one was raised: when, to whom (their name), and whether as the fallback */
  backup_alert_at: Date | null;
  backup_alert_user: string | null;
  backup_alert_name: string | null;
  backup_alert_recipient: 'backup' | 'team_lead' | 'admins' | null;
  automated_at: Date | null;
  /** R-TEAMQ-22: the first inbound call of the lead a person answered since the arrival (or the call that is this inquiry), and who answered */
  answered_call_at: Date | null;
  answered_call_by: string | null;
  answered_call_by_name: string | null;
}

/** The inquiries of [from, to), newest first, at most `cap` + 1 (the extra row says the cap was reached). */
export async function inquiryResponses(tx: Tx, from: Instant, to: Instant, cap: number): Promise<InquiryResponseRow[]> {
  const r = await sql<InquiryResponseRow>`
    WITH inq AS (
      SELECT i.id, i.contact_id, i.external_id, i.arrived_at, s.id AS source_id, s.name AS source_name
        FROM lead_sources s
        CROSS JOIN LATERAL (
          SELECT i.id, i.contact_id, i.external_id, ${ARRIVAL} AS arrived_at FROM lead_inquiries i
           WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id
             AND ${ARRIVAL} >= ${iso(from)}::timestamptz AND ${ARRIVAL} < ${iso(to)}::timestamptz
             AND i.outcome <> 'duplicate_ignored'
           ORDER BY ${ARRIVAL} DESC LIMIT ${cap + 1}) i
       WHERE s.tenant_id = app.tenant_id())
    SELECT i.id, i.contact_id, i.arrived_at, i.source_id, i.source_name, ${HOLDER_COLUMNS},
           h.at AS attempt_at, h.kind AS attempt_kind, h.channel AS attempt_channel, h.by_user AS attempt_by, hu.display_name AS attempt_by_name, h.failed AS attempt_failed,
           (SELECT e.owner_user_id FROM lead_ownership_events e
             WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.occurred_at <= h.at
             ORDER BY e.seq DESC LIMIT 1) AS owner_then,
           COALESCE((SELECT true FROM contact_collaborators k
                      WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND k.user_id = h.by_user
                        AND k.created_at <= h.at AND (k.removed_at IS NULL OR k.removed_at > h.at)
                        AND (k.expires_at IS NULL OR k.expires_at > h.at)), false) AS collaborator_then,
           COALESCE(h.at >= ba.decided_at AND (ba.alerted_user_id = h.by_user OR (ba.recipient = 'admins' AND hm.role IN ('owner', 'admin'))), false) AS alerted_then,
           ba.decided_at AS backup_alert_at, ba.alerted_user_id AS backup_alert_user, bau.display_name AS backup_alert_name, ba.recipient AS backup_alert_recipient,
           (SELECT min(m.dispatched_at) FROM messages m
             WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND ${AUTOMATED_MESSAGE} AND m.dispatched_at >= i.arrived_at) AS automated_at,
           ac.answered_at AS answered_call_at, ac.agent_user_id AS answered_call_by, acu.display_name AS answered_call_by_name
      FROM inq i
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = i.contact_id
      ${HOLDER_JOINS}
      LEFT JOIN LATERAL (
        SELECT x.at, x.kind, x.channel, x.by_user, x.failed FROM (
          (SELECT m.dispatched_at AS at, 'message' AS kind, m.channel, m.initiated_by_user_id AS by_user, ${SEND_FAILED} AS failed FROM messages m
            WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND ${HUMAN_MESSAGE} AND m.dispatched_at >= i.arrived_at
            ORDER BY m.dispatched_at ASC LIMIT 1)
          UNION ALL
          (SELECT k.started_at, 'call', 'voice', k.agent_user_id, false FROM calls k
            WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND ${HUMAN_CALL} AND k.started_at >= i.arrived_at
            ORDER BY k.started_at ASC LIMIT 1)) x
         ORDER BY x.at ASC LIMIT 1) h ON true
      LEFT JOIN users hu ON hu.id = h.by_user
      LEFT JOIN memberships hm ON hm.tenant_id = c.tenant_id AND hm.user_id = h.by_user
      -- R-TEAMQ-22: the first call of theirs a person answered (never an attempt; its own state)
      LEFT JOIN LATERAL (
        SELECT k.answered_at, k.agent_user_id FROM calls k
         WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND ${ANSWERED_CALL} AND ${ANSWERED_FOR_INQUIRY}
         ORDER BY k.answered_at ASC LIMIT 1) ac ON true
      LEFT JOIN users acu ON acu.id = ac.agent_user_id
      LEFT JOIN lead_backup_alerts ba ON ba.tenant_id = c.tenant_id AND ba.inquiry_id = i.id AND ba.outcome = 'alerted'
      LEFT JOIN users bau ON bau.id = ba.alerted_user_id
     WHERE c.deleted_at IS NULL AND ${TEAM_SCOPE}
     ORDER BY i.arrived_at DESC, i.id DESC
     LIMIT ${cap + 1}`.execute(tx);
  return r.rows;
}

/** People an import added in [from, to) (the ledger's `imported` events the caller may read). Never inquiries. */
export async function importedPeople(tx: Tx, from: Instant, to: Instant): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM lead_ownership_events e
     WHERE e.tenant_id = app.tenant_id() AND e.type = 'imported'
       AND e.occurred_at >= ${iso(from)}::timestamptz AND e.occurred_at < ${iso(to)}::timestamptz`.execute(tx);
  return r.rows[0]?.n ?? 0;
}
