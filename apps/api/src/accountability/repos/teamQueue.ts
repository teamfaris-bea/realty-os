// Reads of the team work queue and the lead response report (b19 team-queue lane; DATA_MODEL R-TEAMQ-1..9).
//
// READ-ONLY: every statement here is a SELECT in the CALLER's transaction, so row-level security decides which
// people exist for them (contacts_select; lead_inquiries, messages and calls follow the contact's detail; tasks and
// appointments their own policies). Nothing is written, enqueued, sent or notified.
//
// Team scope (R-TEAMQ-6), the same idea as the exception queue (an item's owner in a team the caller leads):
//   Owner / Admin   every lead of the tenant
//   Team Lead       leads owned by, or on offer to, themself or a member of a team they lead, and leads in a pond
//                   (contacts_select shows a Team Lead every pond lead); an unassigned lead is tenant-wide only
// RLS admits a superset for a Team Lead (collaborations, deal contacts): TEAM_SCOPE narrows to the above. The task
// and appointment groups are scoped by the member the item is on (MEMBERS), and their person must be visible.
//
// A HUMAN ATTEMPT is exactly the scoreboard's touch (migration 0053 app.scoreboard_activity), per person:
//   calls     direction = 'outbound' AND initiator = 'human' AND NOT imported               at started_at, by agent_user_id
//   messages  direction = 'outbound' AND initiator = 'human' AND NOT imported
//             AND dispatched_at IS NOT NULL AND bulk_action_id IS NULL AND marketing_piece_id IS NULL
//                                                                                          at dispatched_at, by initiated_by_user_id
// An AUTOMATED REPLY is an outbound message with initiator 'assistant' or 'system' that was sent or delivered. It
// is reported apart and is never an attempt.
//
// ARRIVAL (R-TEAMQ-19, review fix M3): one instant per inquiry, the SQL twin of core arrivalInstant: the moment the
// inquiry reached the team (lead_inquiries.created_at). The time its source claims (received_at) can be minutes
// ahead or days behind and never decides anything counted "from arrival": the window an inquiry falls in, "a human
// attempt since the arrival", the wait, the report's times. The backup alert job reads the same fragment.
//
// Bounded reads and the index that serves each:
//   inquiries of a window        lead_inquiries_source_arrival_idx (tenant_id, lead_source_id, created_at DESC)
//                                (migration 0109), one range scan per lead source (LATERAL), capped
//   a person's human messages    messages_contact_idx (tenant_id, contact_id, occurred_at DESC), its
//                                (tenant_id, contact_id) prefix; dispatched_at is filtered
//   a person's human calls       calls_contact_idx (tenant_id, contact_id, started_at DESC)
//   a person's automated reply   messages_caps_idx (tenant_id, contact_id, channel, dispatched_at)
//                                WHERE direction = 'outbound' AND initiator IN ('assistant','system')
//   people who wrote lately      contacts_list_activity_idx (tenant_id, GREATEST(last_human_touch_at,
//                                last_inbound_at) DESC NULLS LAST, id) WHERE deleted_at IS NULL AND
//                                merged_into_contact_id IS NULL; then messages_contact_idx / calls_contact_idx per person
//   a member's past-due tasks    tasks_assignee_idx (tenant_id, assignee_user_id, status, due_at), one range per member
//   a member's ended appointments appointments_user_idx (tenant_id, user_id, starts_at), one range per member
//   who owned the lead then      lead_ownership_events primary key (tenant_id, contact_id, seq)
//   imports of a period          loe_type_time_idx (tenant_id, type, occurred_at DESC)
//   an inquiry's backup alert    lead_backup_alerts_inquiry_once (tenant_id, inquiry_id) (b19 step 2, migration 0108)
// messages and calls have no (tenant_id, time) index for inbound rows, which is why the unanswered-reply read
// starts from the people whose last inbound is recent instead of scanning the tenant's messages.
import type { ApptFacts, QueueInboundFacts, TaskFacts, TouchFacts } from '@realty/core/priority';
import type { ContactId, Instant, UserId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { type RawBuilder, sql } from 'kysely';
import { iso, ms } from '../common.js';

/** Rows one read returns at most (longest waiting first); a group that hits it says "at least". */
export const QUEUE_READ_CAP = 500;
/** Waiting messages or calls read per person (the newest; one row per person). */
const PER_PERSON_CAP = 50;

/** The members whose leads a Team Lead answers for: the teams they lead, and themself. */
const MY_MEMBERS = sql`(SELECT app.my_team_member_ids() || app.user_id())::uuid[]`;

/** R-TEAMQ-6 for a contacts row aliased `c` (see the file header). */
export const TEAM_SCOPE: RawBuilder<unknown> = sql`((SELECT app.is_tenant_wide())
        OR c.owner_user_id = ANY (${MY_MEMBERS})
        OR c.offered_to_user_id = ANY (${MY_MEMBERS})
        OR c.ownership_state = 'in_pond')`;

/**
 * R-TEAMQ-19: THE arrival of a lead_inquiries row aliased `i` (core arrivalInstant: the later of the source's claim
 * and the reach, a claim ahead of the reach counting as the reach, which is the reach). Every "since arrival" in the
 * queue, the report and the backup alert job is written with this fragment.
 */
export const ARRIVAL: RawBuilder<Date> = sql<Date>`i.created_at`;

/** The scoreboard's human text, email or chat reply, for a messages row aliased `m` (0053). */
export const HUMAN_MESSAGE: RawBuilder<unknown> = sql`(m.direction = 'outbound' AND m.initiator = 'human' AND NOT m.imported
        AND m.dispatched_at IS NOT NULL AND m.bulk_action_id IS NULL AND m.marketing_piece_id IS NULL)`;
/** The scoreboard's human call, for a calls row aliased `k` (0053). */
export const HUMAN_CALL: RawBuilder<unknown> = sql`(k.direction = 'outbound' AND k.initiator = 'human' AND NOT k.imported)`;
/** An automated message that went out, for a messages row aliased `m`. Never an attempt. */
export const AUTOMATED_MESSAGE: RawBuilder<unknown> = sql`(m.direction = 'outbound' AND m.initiator IN ('assistant','system')
        AND m.dispatched_at IS NOT NULL AND m.status IN ('sent','delivered'))`;

export interface HolderColumns {
  contact_name: string;
  ownership_state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  owner_user_id: string | null;
  owner_name: string | null;
  offered_to_user_id: string | null;
  offered_to_name: string | null;
  pond_id: string | null;
  pond_name: string | null;
}

/** Who has the lead, for a contacts row aliased `c` joined to ou / fu (users) and p (ponds). */
export const HOLDER_COLUMNS: RawBuilder<unknown> = sql`c.display_name AS contact_name, c.ownership_state, c.owner_user_id, ou.display_name AS owner_name,
           c.offered_to_user_id, fu.display_name AS offered_to_name, c.pond_id, p.name AS pond_name`;
export const HOLDER_JOINS: RawBuilder<unknown> = sql`LEFT JOIN users ou ON ou.id = c.owner_user_id
      LEFT JOIN users fu ON fu.id = c.offered_to_user_id
      LEFT JOIN ponds p ON p.tenant_id = c.tenant_id AND p.id = c.pond_id`;

// ---- staffed hours ----------------------------------------------------------------------------------------

export interface StaffedHoursRow {
  zone: string;
  open: string;
  close: string;
}

/** The team's staffed hours: the tenant's routing hours in its zone (one window, every day). */
export async function staffedHours(tx: Tx): Promise<StaffedHoursRow> {
  const r = await sql<StaffedHoursRow>`
    SELECT default_timezone AS zone, to_char(routing_hours_start, 'HH24:MI') AS open, to_char(routing_hours_end, 'HH24:MI') AS close
      FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const row = r.rows[0];
  if (!row) throw new Error('teamQueue: the tenant has no settings row');
  return row;
}

// ---- new leads with no human attempt -------------------------------------------------------------------------

export interface WaitingInquiryRow extends HolderColumns {
  id: string;
  contact_id: string;
  /** the arrival (ARRIVAL) */
  arrived_at: Date;
  source_name: string;
  automated_at: Date | null;
  /** b19 R-TEAMQ-18: this inquiry's backup decision when it alerted someone or found nobody to alert (else null) */
  backup_alert_at: Date | null;
  backup_alert_outcome: 'alerted' | 'no_recipient' | null;
  backup_alert_name: string | null;
  backup_alert_recipient: 'backup' | 'team_lead' | 'admins' | null;
  /** R-TEAMQ-21: why it was not the named backup, and how many members were alerted */
  backup_alert_reason: 'backup_unavailable' | 'backup_is_holder' | null;
  backup_alert_count: number | null;
}

/**
 * Inbound inquiries that arrived in (since, now] (ARRIVAL) whose person has had no human attempt at or after the
 * arrival, longest waiting first, at most `cap` + 1 (the extra row says the cap was reached). An ignored duplicate
 * (a replayed delivery) is not an arrival. Imports and people a member typed in never write lead_inquiries.
 */
export async function waitingInquiries(tx: Tx, since: Instant, now: Instant, cap: number): Promise<WaitingInquiryRow[]> {
  const r = await sql<WaitingInquiryRow>`
    SELECT i.id, i.contact_id, i.arrived_at, s.name AS source_name, ${HOLDER_COLUMNS},
           (SELECT min(m.dispatched_at) FROM messages m
             WHERE m.tenant_id = s.tenant_id AND m.contact_id = i.contact_id AND ${AUTOMATED_MESSAGE} AND m.dispatched_at >= i.arrived_at) AS automated_at,
           ba.decided_at AS backup_alert_at, ba.outcome AS backup_alert_outcome, bau.display_name AS backup_alert_name, ba.recipient AS backup_alert_recipient,
           ba.fallback_reason AS backup_alert_reason, ba.alerted_count AS backup_alert_count
      FROM lead_sources s
      CROSS JOIN LATERAL (
        SELECT i.id, i.contact_id, ${ARRIVAL} AS arrived_at FROM lead_inquiries i
         WHERE i.tenant_id = s.tenant_id AND i.lead_source_id = s.id
           AND ${ARRIVAL} > ${iso(since)}::timestamptz AND ${ARRIVAL} <= ${iso(now)}::timestamptz
           AND i.outcome <> 'duplicate_ignored'
           -- no LIMIT here: the window is the bound, and the longest-waiting rows are the oldest ones
        ) i
      JOIN contacts c ON c.tenant_id = s.tenant_id AND c.id = i.contact_id
      ${HOLDER_JOINS}
      -- b19 R-TEAMQ-18: the inquiry's backup alert (lead_backup_alerts_inquiry_once; read through its own policy)
      LEFT JOIN lead_backup_alerts ba ON ba.tenant_id = s.tenant_id AND ba.inquiry_id = i.id AND ba.outcome IN ('alerted', 'no_recipient')
      LEFT JOIN users bau ON bau.id = ba.alerted_user_id
     WHERE s.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.ownership_state <> 'closed' AND ${TEAM_SCOPE}
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = s.tenant_id AND m.contact_id = i.contact_id AND ${HUMAN_MESSAGE} AND m.dispatched_at >= i.arrived_at)
       AND NOT EXISTS (SELECT 1 FROM calls k WHERE k.tenant_id = s.tenant_id AND k.contact_id = i.contact_id AND ${HUMAN_CALL} AND k.started_at >= i.arrived_at)
     ORDER BY i.arrived_at ASC, i.id ASC
     LIMIT ${cap + 1}`.execute(tx);
  return r.rows;
}

// ---- unanswered replies ---------------------------------------------------------------------------------------

export interface WaitingPersonRow extends HolderColumns {
  contact_id: string;
  source_name: string | null;
}

export interface WaitingInbound {
  people: WaitingPersonRow[];
  inbound: QueueInboundFacts[];
  /** more people wrote lately than one read takes */
  capped: boolean;
}

/**
 * The people who wrote or called since `since` (contacts.last_inbound_at, which every inbound message and call
 * moves), with their inbound messages and missed calls after their last human touch and every later touch: the
 * feed's own reads (workspace/repos/feedInputs.ts), for a team instead of one agent. Core decides who is waiting.
 */
export async function waitingInbound(tx: Tx, since: Instant, now: Instant, cap: number): Promise<WaitingInbound> {
  const sinceIso = iso(since);
  const people = await sql<WaitingPersonRow & { since: Date }>`
    SELECT c.id AS contact_id, ls.name AS source_name, ${HOLDER_COLUMNS},
           GREATEST(${sinceIso}::timestamptz, COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)) AS since
      FROM contacts c
      LEFT JOIN lead_sources ls ON ls.tenant_id = c.tenant_id AND ls.id = c.original_lead_source_id
      ${HOLDER_JOINS}
     WHERE c.tenant_id = app.tenant_id() AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
       AND GREATEST(c.last_human_touch_at, c.last_inbound_at) > ${sinceIso}::timestamptz
       AND c.last_inbound_at > ${sinceIso}::timestamptz
       AND c.ownership_state <> 'closed' AND ${TEAM_SCOPE}
     ORDER BY GREATEST(c.last_human_touch_at, c.last_inbound_at) DESC NULLS LAST, c.id
     LIMIT ${cap + 1}`.execute(tx);
  const capped = people.rows.length > cap;
  const rows = people.rows.slice(0, cap);
  if (rows.length === 0) return { people: [], inbound: [], capped };
  const ids = rows.map((p) => p.contact_id);
  const sinces = rows.map((p) => iso(p.since));
  const [messages, missed] = await Promise.all([
    sql<{ id: string; channel: 'sms' | 'mms' | 'email' | 'web_chat'; contact_id: string; occurred_at: Date; is_auto_reply: boolean; opt_out_keyword: string | null }>`
      SELECT m.id, m.channel, m.contact_id, m.occurred_at, m.is_auto_reply, m.opt_out_keyword
        FROM unnest(${ids}::uuid[], ${sinces}::timestamptz[]) AS w(contact_id, since)
        CROSS JOIN LATERAL (
          SELECT m.id, m.channel, m.contact_id, m.occurred_at, m.is_auto_reply, m.opt_out_keyword FROM messages m
           WHERE m.tenant_id = app.tenant_id() AND m.contact_id = w.contact_id AND m.occurred_at > w.since
             AND m.direction = 'inbound' AND NOT m.imported
           ORDER BY m.occurred_at DESC LIMIT ${PER_PERSON_CAP}) m`.execute(tx),
    sql<{ id: string; contact_id: string; started_at: Date }>`
      SELECT k.id, k.contact_id, k.started_at
        FROM unnest(${ids}::uuid[], ${sinces}::timestamptz[]) AS w(contact_id, since)
        CROSS JOIN LATERAL (
          SELECT k.id, k.contact_id, k.started_at FROM calls k
           WHERE k.tenant_id = app.tenant_id() AND k.contact_id = w.contact_id AND k.started_at > w.since
             AND k.direction = 'inbound' AND NOT k.imported AND k.answered_at IS NULL
             AND k.status IN ('no_answer','busy','voicemail','canceled','failed','completed')
           ORDER BY k.started_at DESC LIMIT ${PER_PERSON_CAP}) k`.execute(tx),
  ]);
  const waiting = [...new Set([...messages.rows.map((m) => m.contact_id), ...missed.rows.map((k) => k.contact_id)])];
  const touches = new Map<string, TouchFacts[]>();
  if (waiting.length > 0) {
    // the feed's touches read: a bulk send or an invite never answers a waiting client (R-PAR-37, R-MKT-8)
    const t = await sql<{ contact_id: string; kind: 'message' | 'call'; direction: 'outbound' | 'inbound_answered'; initiator: TouchFacts['initiator']; imported: boolean; gate_allowed: boolean; at: Date; by_user: string | null }>`
      SELECT m.contact_id, 'message' AS kind, 'outbound' AS direction,
             CASE WHEN m.initiator IN ('human','assistant','system','import') THEN m.initiator ELSE 'system' END AS initiator,
             m.imported, m.status NOT IN ('scheduled','queued','blocked','canceled') AS gate_allowed,
             COALESCE(m.dispatched_at, m.occurred_at) AS at, m.initiated_by_user_id AS by_user
        FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ANY (${waiting}::uuid[]) AND m.direction = 'outbound'
         AND m.bulk_action_id IS NULL AND m.marketing_piece_id IS NULL
         AND m.occurred_at > ${sinceIso}::timestamptz
      UNION ALL
      SELECT k.contact_id, 'call', CASE WHEN k.direction = 'outbound' THEN 'outbound' ELSE 'inbound_answered' END,
             CASE WHEN k.initiator = 'client' THEN 'human' ELSE k.initiator END,
             k.imported, (k.direction = 'inbound' OR NOT k.imported), COALESCE(k.answered_at, k.started_at), k.agent_user_id
        FROM calls k
       WHERE k.tenant_id = app.tenant_id() AND k.contact_id = ANY (${waiting}::uuid[])
         AND (k.direction = 'outbound' OR (k.answered_at IS NOT NULL AND k.handled_by = 'human'))
         AND k.started_at > ${sinceIso}::timestamptz`.execute(tx);
    for (const x of t.rows) {
      const list = touches.get(x.contact_id) ?? [];
      list.push({ kind: x.kind, direction: x.direction, initiator: x.initiator, imported: x.imported, gateAllowed: x.gate_allowed, at: ms(x.at), byUserId: x.by_user as UserId | null });
      touches.set(x.contact_id, list);
    }
  }
  const inbound: QueueInboundFacts[] = [
    ...messages.rows.map((m) => ({
      id: m.id as never,
      kind: 'message' as const,
      channel: m.channel,
      contactId: m.contact_id as ContactId,
      at: ms(m.occurred_at),
      imported: false,
      isAutoReply: m.is_auto_reply,
      isKeyword: m.opt_out_keyword !== null,
      laterTouches: touches.get(m.contact_id) ?? [],
    })),
    ...missed.rows.map((k) => ({
      id: k.id as never,
      kind: 'missed_call' as const,
      channel: 'voice' as const,
      contactId: k.contact_id as ContactId,
      at: ms(k.started_at),
      imported: false,
      laterTouches: touches.get(k.contact_id) ?? [],
    })),
  ];
  return { people: rows, inbound, capped };
}

// ---- past-due tasks and ended appointments, by the member they are on ------------------------------------------

/** The members whose items the caller answers for (R-TEAMQ-6): everyone for a tenant-wide caller, else the caller's teams and themself. */
const MEMBERS: RawBuilder<unknown> = sql`(SELECT mb.tenant_id, mb.user_id FROM memberships mb
        WHERE mb.tenant_id = app.tenant_id() AND ((SELECT app.is_tenant_wide()) OR mb.user_id = ANY (${MY_MEMBERS})))`;

export interface PastDueTaskRow {
  id: string;
  contact_id: string;
  kind: TaskFacts['kind'];
  title: string;
  due_at: Date;
  due_all_day: boolean;
  due_tz: string | null;
  created_by_kind: TaskFacts['createdByKind'];
  assignee_user_id: string;
  assignee_name: string | null;
}

/**
 * Open tasks about a person that came due in (since, now], longest overdue first: the promises, or every other
 * kind. A task an import created is never read (R-IMPORT-6). At most `cap` + 1 rows.
 */
export async function pastDueTasks(tx: Tx, promises: boolean, since: Instant, now: Instant, cap: number): Promise<PastDueTaskRow[]> {
  const r = await sql<PastDueTaskRow>`
    SELECT t.id, t.contact_id, t.kind, t.title, t.due_at, t.due_all_day, t.due_tz, t.created_by_kind, t.assignee_user_id, au.display_name AS assignee_name
      FROM ${MEMBERS} mb
      CROSS JOIN LATERAL (
        SELECT t.id, t.contact_id, t.kind, t.title, t.due_at, t.due_all_day, t.due_tz, t.created_by_kind, t.assignee_user_id FROM tasks t
         WHERE t.tenant_id = mb.tenant_id AND t.assignee_user_id = mb.user_id AND t.status = 'open'
           AND t.due_at > ${iso(since)}::timestamptz AND t.due_at <= ${iso(now)}::timestamptz
           AND t.contact_id IS NOT NULL AND t.created_by_kind <> 'import' AND (t.kind = 'promise') = ${promises}
         ORDER BY t.due_at ASC LIMIT ${cap + 1}) t
      LEFT JOIN users au ON au.id = t.assignee_user_id
     ORDER BY t.due_at ASC, t.id ASC
     LIMIT ${cap + 1}`.execute(tx);
  return r.rows;
}

export interface EndedAppointmentRow {
  id: string;
  contact_id: string;
  kind: ApptFacts['kind'];
  starts_at: Date;
  ends_at: Date;
  status: ApptFacts['status'];
  created_by_kind: ApptFacts['createdByKind'];
  user_id: string;
  member_name: string | null;
}

/** Appointments with a person that ended in (since, now] with no outcome logged, longest ago first. */
export async function endedAppointments(tx: Tx, since: Instant, now: Instant, cap: number): Promise<EndedAppointmentRow[]> {
  const r = await sql<EndedAppointmentRow>`
    SELECT a.id, a.contact_id, a.kind, a.starts_at, a.ends_at, a.status, a.created_by_kind, a.user_id, au.display_name AS member_name
      FROM ${MEMBERS} mb
      CROSS JOIN LATERAL (
        SELECT a.id, a.contact_id, a.kind, a.starts_at, a.ends_at, a.status, a.created_by_kind, a.user_id FROM appointments a
         WHERE a.tenant_id = mb.tenant_id AND a.user_id = mb.user_id
           -- the index range is on starts_at: an appointment that ended in the window started within a week before it at most
           AND a.starts_at > ${iso(since)}::timestamptz - interval '7 days' AND a.starts_at < ${iso(now)}::timestamptz
           AND a.ends_at > ${iso(since)}::timestamptz AND a.ends_at <= ${iso(now)}::timestamptz
           AND a.status IN ('scheduled','held') AND a.outcome_logged_at IS NULL AND a.created_by_kind <> 'import'
           AND a.contact_id IS NOT NULL
         ORDER BY a.starts_at ASC LIMIT ${cap + 1}) a
      LEFT JOIN users au ON au.id = a.user_id
     ORDER BY a.ends_at ASC, a.id ASC
     LIMIT ${cap + 1}`.execute(tx);
  return r.rows;
}

// ---- the people behind task and appointment rows ----------------------------------------------------------------

export interface PersonRow extends HolderColumns {
  contact_id: string;
  source_name: string | null;
}

/** The given people as the caller's RLS shows them (an invisible, deleted or closed person is simply absent). */
export async function peopleByIds(tx: Tx, contactIds: readonly string[]): Promise<PersonRow[]> {
  if (contactIds.length === 0) return [];
  const r = await sql<PersonRow>`
    SELECT c.id AS contact_id, ls.name AS source_name, ${HOLDER_COLUMNS}
      FROM contacts c
      LEFT JOIN lead_sources ls ON ls.tenant_id = c.tenant_id AND ls.id = c.original_lead_source_id
      ${HOLDER_JOINS}
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${[...new Set(contactIds)]}::uuid[])
       AND c.deleted_at IS NULL AND c.ownership_state <> 'closed'`.execute(tx);
  return r.rows;
}
