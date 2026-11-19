// Reads of the lead response report (b19 team-queue lane; DATA_MODEL R-TEAMQ-6..9). READ-ONLY, in the caller's
// transaction: RLS and the team scope of repos/teamQueue.ts decide which inquiries exist for them.
//
// One row per inbound inquiry received in [from, to) (lead_inquiries; an ignored duplicate delivery is not an
// arrival; imports and people a member typed in never write lead_inquiries), with:
//   - the FIRST human attempt on the person at or after the arrival, by ANYONE: exactly the scoreboard's touch
//     (repos/teamQueue.ts HUMAN_MESSAGE / HUMAN_CALL, migration 0053), with who made it;
//   - that person's role to the lead AT THAT MOMENT: `owner` when the ledger's latest event at or before the
//     attempt names them as the owner (lead_ownership_events.owner_user_id is the owner AFTER the event),
//     `backup` when this inquiry's minute-three alert had gone to them before the attempt (lead_backup_alerts, b19
//     R-TEAMQ-18: read through its own policy, so a caller sees it exactly when they see the inquiry),
//     `collaborator` when contact_collaborators held them then, else `other`;
//   - the first automated message that went out after the arrival (reported apart, never an attempt).
// Indexes: see the header of repos/teamQueue.ts (inquiries by source and time; a person's messages and calls;
// the ledger's primary key; imports by loe_type_time_idx; an inquiry's backup alert by lead_backup_alerts_inquiry_once).
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { iso } from '../common.js';
import { AUTOMATED_MESSAGE, HOLDER_COLUMNS, HOLDER_JOINS, HUMAN_CALL, HUMAN_MESSAGE, type HolderColumns, TEAM_SCOPE } from './teamQueue.js';

/** Inquiries one report reads at most (the newest); a period that holds more says so (`truncated`). */
export const RESPONSE_READ_CAP = 5000;

export interface InquiryResponseRow extends HolderColumns {
  id: string;
  contact_id: string;
  received_at: Date;
  source_id: string;
  source_name: string;
  attempt_at: Date | null;
  attempt_kind: 'message' | 'call' | null;
  attempt_channel: string | null;
  attempt_by: string | null;
  attempt_by_name: string | null;
  /** the lead's owner when the attempt was made (null: nobody owned it then, or the ledger is not the caller's to read) */
  owner_then: string | null;
  collaborator_then: boolean;
  /** the attempt was made by the person this inquiry's backup alert went to, at or after the alert */
  backup_then: boolean;
  /** this inquiry's backup alert, when one was raised: when, to whom (their name), and whether as the fallback */
  backup_alert_at: Date | null;
  backup_alert_user: string | null;
  backup_alert_name: string | null;
  backup_alert_recipient: 'backup' | 'team_lead' | null;
  automated_at: Date | null;
}

/** The inquiries of [from, to), newest first, at most `cap` + 1 (the extra row says the cap was reached). */
export async function inquiryResponses(tx: Tx, from: Instant, to: Instant, cap: number): Promise<InquiryResponseRow[]> {
  const r = await sql<InquiryResponseRow>`
    WITH inq AS (
      SELECT i.id, i.contact_id, i.received_at, s.id AS source_id, s.name AS source_name
        FROM lead_sources s
        CROSS JOIN LATERAL (
          SELECT i.id, i.contact_id, i.received_at FROM lead_inquiries i
           WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id
             AND i.received_at >= ${iso(from)}::timestamptz AND i.received_at < ${iso(to)}::timestamptz
             AND i.outcome <> 'duplicate_ignored'
           ORDER BY i.received_at DESC LIMIT ${cap + 1}) i
       WHERE s.tenant_id = app.tenant_id())
    SELECT i.id, i.contact_id, i.received_at, i.source_id, i.source_name, ${HOLDER_COLUMNS},
           h.at AS attempt_at, h.kind AS attempt_kind, h.channel AS attempt_channel, h.by_user AS attempt_by, hu.display_name AS attempt_by_name,
           (SELECT e.owner_user_id FROM lead_ownership_events e
             WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.occurred_at <= h.at
             ORDER BY e.seq DESC LIMIT 1) AS owner_then,
           COALESCE((SELECT true FROM contact_collaborators k
                      WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND k.user_id = h.by_user
                        AND k.created_at <= h.at AND (k.removed_at IS NULL OR k.removed_at > h.at)
                        AND (k.expires_at IS NULL OR k.expires_at > h.at)), false) AS collaborator_then,
           COALESCE(ba.alerted_user_id = h.by_user AND h.at >= ba.decided_at, false) AS backup_then,
           ba.decided_at AS backup_alert_at, ba.alerted_user_id AS backup_alert_user, bau.display_name AS backup_alert_name, ba.recipient AS backup_alert_recipient,
           (SELECT min(m.dispatched_at) FROM messages m
             WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND ${AUTOMATED_MESSAGE} AND m.dispatched_at >= i.received_at) AS automated_at
      FROM inq i
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = i.contact_id
      ${HOLDER_JOINS}
      LEFT JOIN LATERAL (
        SELECT x.at, x.kind, x.channel, x.by_user FROM (
          (SELECT m.dispatched_at AS at, 'message' AS kind, m.channel, m.initiated_by_user_id AS by_user FROM messages m
            WHERE m.tenant_id = c.tenant_id AND m.contact_id = c.id AND ${HUMAN_MESSAGE} AND m.dispatched_at >= i.received_at
            ORDER BY m.dispatched_at ASC LIMIT 1)
          UNION ALL
          (SELECT k.started_at, 'call', 'voice', k.agent_user_id FROM calls k
            WHERE k.tenant_id = c.tenant_id AND k.contact_id = c.id AND ${HUMAN_CALL} AND k.started_at >= i.received_at
            ORDER BY k.started_at ASC LIMIT 1)) x
         ORDER BY x.at ASC LIMIT 1) h ON true
      LEFT JOIN users hu ON hu.id = h.by_user
      LEFT JOIN lead_backup_alerts ba ON ba.tenant_id = c.tenant_id AND ba.inquiry_id = i.id AND ba.outcome = 'alerted'
      LEFT JOIN users bau ON bau.id = ba.alerted_user_id
     WHERE c.deleted_at IS NULL AND ${TEAM_SCOPE}
     ORDER BY i.received_at DESC, i.id DESC
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
