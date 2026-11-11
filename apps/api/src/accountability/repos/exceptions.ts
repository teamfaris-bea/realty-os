// exception_items / exception_events queries of api/accountability (BUILD_PLAN module 15; R-ACC-1…3).
//
// Recompute inputs are read by the SYSTEM actor (the exceptionRecompute job: exception_items is written
// only by tenant-wide actors, RLS exceptions_write). Queue reads and human events run under the caller's
// RLS: exception_items is visible tenant-wide, to its owner, and to the Team Lead of the owner's team;
// exception_events follow their item.
//
// Imported history never raises an exception (R-IMPORT-6): imported messages, import-created tasks and
// appointments, and import ledger events are excluded here as well as in core.
//
// Module 18a: open-house invite rows (messages.marketing_piece_id) are not failed_send inputs (R-MKT-8:
// blocked recipients are counted on the send); milestone dates (deal_dates with their Phase 2 columns,
// joined to the deal owner) feed R-ACC-6 milestone_at_risk.
import type {
  ApptFacts,
  ExceptionEvidence,
  ExceptionItemSpec,
  ExceptionType,
  MilestoneDateFacts,
  OutboundStatusFacts,
  SlaFacts,
  TaskFacts,
} from '@realty/core/priority';
import type { ContactId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { iso, ms, msOrNull } from '../common.js';

// ---- stored items ------------------------------------------------------------------------------------

export interface StoredItemRow {
  id: string;
  item_type: ExceptionType;
  subject_type: ExceptionItemSpec['subjectType'];
  subject_id: string;
  contact_id: string | null;
  owner_user_id: string | null;
  detected_at: Date;
  due_at: Date | null;
  evidence: ExceptionEvidence[];
  condition_cleared_at: Date | null;
  rule_version: number;
  dedupe_key: string;
  computed_at: Date;
}

const ITEM_COLUMNS = sql`e.id, e.item_type, e.subject_type, e.subject_id, e.contact_id, e.owner_user_id, e.detected_at, e.due_at,
  e.evidence, e.condition_cleared_at, e.rule_version, e.dedupe_key, e.computed_at`;

/** A stored row as core's ExceptionItemSpec (for the idempotent recompute diff). */
export function specOf(r: StoredItemRow): ExceptionItemSpec {
  return {
    itemType: r.item_type,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    contactId: r.contact_id as ContactId | null,
    ownerUserId: r.owner_user_id as UserId | null,
    detectedAt: ms(r.detected_at),
    dueAt: msOrNull(r.due_at),
    evidence: r.evidence,
    conditionClearedAt: msOrNull(r.condition_cleared_at),
    ruleVersion: r.rule_version,
    dedupeKey: r.dedupe_key,
  };
}

/** Stored rows whose condition still holds (tenant scope), or every stored row of one contact. */
export async function storedRowsForScope(tx: Tx, contactId: string | null): Promise<StoredItemRow[]> {
  const r = contactId === null
    ? await sql<StoredItemRow>`SELECT ${ITEM_COLUMNS} FROM exception_items e
         WHERE e.tenant_id = app.tenant_id() AND e.condition_cleared_at IS NULL`.execute(tx)
    : await sql<StoredItemRow>`SELECT ${ITEM_COLUMNS} FROM exception_items e
         WHERE e.tenant_id = app.tenant_id() AND e.contact_id = ${contactId}::uuid`.execute(tx);
  return r.rows;
}

export async function storedRowsByKeys(tx: Tx, keys: readonly string[]): Promise<StoredItemRow[]> {
  if (keys.length === 0) return [];
  const r = await sql<StoredItemRow>`SELECT ${ITEM_COLUMNS} FROM exception_items e
     WHERE e.tenant_id = app.tenant_id() AND e.dedupe_key = ANY (${[...keys]}::text[])`.execute(tx);
  return r.rows;
}

// ---- recompute inputs ---------------------------------------------------------------------------------

/** What one recompute reads: one contact's whole history, or the tenant's recent window plus open items. */
export interface InputScope {
  contactId: string | null;
  now: Instant;
  /** tenant scope: conditions that started holding after this instant (older ones only via `extra`) */
  windowStart: Instant;
  /** subjects of stored open items, always re-read so a vanished or fixed condition clears */
  extra: { periods: { contactId: string; seq: number }[]; taskIds: string[]; messageIds: string[]; appointmentIds: string[]; dealDateIds: string[] };
}

const PERIOD_END_TYPES = ['reassigned', 'released', 'auto_released', 'inactivity_released', 'sent_to_pond', 'closed', 'merged_away', 'claimed', 'assigned', 'offer_accepted'];

/**
 * SLA ownership periods from the LEDGER (R-ACC-2: a later auto-release never erases a miss): accept,
 * claim, assign and reassign with a first-touch deadline, plus a re-inquiry that started a new SLA period
 * on an owned lead (R-OWN-20, E68: a new period, so a new item key).
 *
 * A period's first touch is the first first_touch_recorded before its window ends: when the lead left the
 * agent (`ended_at`, PERIOD_END_TYPES) or when a re-inquiry started a new period of theirs (`next_period_at`,
 * payload.newPeriod, as fold's startsPeriod). A touch after the re-inquiry is the later period's first touch,
 * never the earlier one's late fix (owner decision 2026-11-11, DATA_MODEL R-ACC-2). `ended_at` keeps meaning
 * "the lead left this agent": core says so in the item's evidence, which would be false for a re-inquiry.
 */
export async function slaFacts(tx: Tx, s: InputScope): Promise<SlaFacts[]> {
  const nowIso = iso(s.now);
  const winIso = iso(s.windowStart);
  const r = await sql<{ contact_id: string; seq: string; owner_user_id: string; owned_at: Date; due: Date; ended_at: Date | null; next_period_at: Date | null; first_touch_at: Date | null }>`
    WITH p AS (
      SELECT e.tenant_id, e.contact_id, e.seq, e.owner_user_id, e.occurred_at AS owned_at, e.deadline_at AS due
        FROM lead_ownership_events e
       WHERE e.tenant_id = app.tenant_id()
         AND e.type IN ('offer_accepted','claimed','assigned','reassigned','reinquiry') AND e.deadline_at IS NOT NULL
         AND e.owner_user_id IS NOT NULL AND e.actor_kind <> 'import'
         AND (CASE WHEN ${s.contactId}::uuid IS NOT NULL THEN e.contact_id = ${s.contactId}::uuid
                   ELSE e.deadline_at <= ${nowIso}::timestamptz AND e.deadline_at > ${winIso}::timestamptz
                        AND e.occurred_at > ${winIso}::timestamptz - interval '14 days' END)
      UNION
      SELECT e.tenant_id, e.contact_id, e.seq, e.owner_user_id, e.occurred_at, e.deadline_at
        FROM lead_ownership_events e
        JOIN unnest(${s.extra.periods.map((p) => p.contactId)}::uuid[], ${s.extra.periods.map((p) => p.seq)}::bigint[]) AS x(contact_id, seq)
          ON x.contact_id = e.contact_id AND x.seq = e.seq
       WHERE e.tenant_id = app.tenant_id() AND e.deadline_at IS NOT NULL AND e.owner_user_id IS NOT NULL)
    SELECT p.contact_id, p.seq::text AS seq, p.owner_user_id, p.owned_at, p.due, pe.occurred_at AS ended_at,
           np.occurred_at AS next_period_at,
           (SELECT f.occurred_at FROM lead_ownership_events f
             WHERE f.tenant_id = p.tenant_id AND f.contact_id = p.contact_id AND f.seq > p.seq
               AND f.type = 'first_touch_recorded' AND (pe.seq IS NULL OR f.seq < pe.seq) AND (np.seq IS NULL OR f.seq < np.seq)
             ORDER BY f.seq LIMIT 1) AS first_touch_at
      FROM p
      LEFT JOIN LATERAL (
        SELECT x.seq, x.occurred_at FROM lead_ownership_events x
         WHERE x.tenant_id = p.tenant_id AND x.contact_id = p.contact_id AND x.seq > p.seq
           AND x.type = ANY (${PERIOD_END_TYPES}::text[])
         ORDER BY x.seq LIMIT 1) pe ON true
      -- the first new period of the same owner while they still hold the lead (before it left them)
      LEFT JOIN LATERAL (
        SELECT x.seq, x.occurred_at FROM lead_ownership_events x
         WHERE x.tenant_id = p.tenant_id AND x.contact_id = p.contact_id AND x.seq > p.seq
           AND x.type = 'reinquiry' AND x.payload @> '{"newPeriod": true}'::jsonb
           AND (pe.seq IS NULL OR x.seq < pe.seq)
         ORDER BY x.seq LIMIT 1) np ON true`.execute(tx);
  return r.rows.map((x) => ({
    contactId: x.contact_id as ContactId,
    ownerUserId: x.owner_user_id as UserId,
    periodSeq: Number(x.seq),
    ownedAt: ms(x.owned_at),
    firstTouchDueAt: ms(x.due),
    firstTouchAt: msOrNull(x.first_touch_at),
    periodEndedAt: msOrNull(x.ended_at),
    nextPeriodAt: msOrNull(x.next_period_at),
  }));
}

/** Promise tasks (never import-created) that are, or were, past their deadline. */
export async function promiseFacts(tx: Tx, s: InputScope): Promise<TaskFacts[]> {
  const nowIso = iso(s.now);
  const winIso = iso(s.windowStart);
  const r = await sql<{ id: string; assignee_user_id: string; contact_id: string | null; deal_id: string | null; due_at: Date | null; due_all_day: boolean; due_tz: string | null; status: TaskFacts['status']; completed_at: Date | null; needs_review: boolean; created_by_kind: TaskFacts['createdByKind']; created_at: Date }>`
    SELECT t.id, t.assignee_user_id, t.contact_id, t.deal_id, t.due_at, t.due_all_day, t.due_tz, t.status, t.completed_at,
           t.needs_review, t.created_by_kind, t.created_at
      FROM tasks t
     WHERE t.tenant_id = app.tenant_id() AND t.kind = 'promise' AND t.created_by_kind <> 'import'
       AND (t.id = ANY (${s.extra.taskIds}::uuid[])
            OR (CASE WHEN ${s.contactId}::uuid IS NOT NULL THEN t.contact_id = ${s.contactId}::uuid
                     ELSE t.due_at IS NOT NULL AND t.due_at <= ${nowIso}::timestamptz + interval '2 days'
                          AND t.due_at > ${winIso}::timestamptz - interval '2 days'
                          AND (t.status = 'open' OR (t.status = 'done' AND t.completed_at > t.due_at)) END))`.execute(tx);
  return r.rows.map((t) => ({
    taskId: t.id as never,
    assigneeUserId: t.assignee_user_id as UserId,
    contactId: t.contact_id as ContactId | null,
    dealId: t.deal_id as never,
    kind: 'promise',
    dueAt: msOrNull(t.due_at),
    dueAllDay: t.due_all_day,
    dueTz: t.due_tz as never,
    status: t.status,
    completedAt: msOrNull(t.completed_at),
    needsReview: t.needs_review,
    createdByKind: t.created_by_kind,
    createdAt: ms(t.created_at),
    // No quotes here: a stored item is readable by its owner even after the lead moved on, so evidence
    // snippets are added at READ time under the viewer's own rights (exceptions.ts, R-PERM-7/8).
  }));
}

const FAILING = ['blocked', 'failed', 'undelivered', 'bounced', 'dispatch_unknown', 'dispatching'];

/** Outbound messages (never imported) whose delivery failed, is unknown, or is stuck. */
export async function outboundFacts(tx: Tx, s: InputScope): Promise<OutboundStatusFacts[]> {
  const winIso = iso(s.windowStart);
  const r = await sql<{ id: string; contact_id: string; channel: OutboundStatusFacts['channel']; initiator: OutboundStatusFacts['initiator']; imported: boolean; status: OutboundStatusFacts['status']; status_reason: string | null; dispatched_at: Date | null; status_at: Date; owner: string | null }>`
    SELECT m.id, m.contact_id, m.channel, m.initiator, m.imported, m.status, m.status_reason, m.dispatched_at,
           COALESCE((SELECT max(se.occurred_at) FROM message_status_events se
                      WHERE se.tenant_id = m.tenant_id AND se.message_id = m.id AND se.mapped_status = m.status), m.updated_at) AS status_at,
           COALESCE(m.initiated_by_user_id, a.owner_user_id, c.owner_user_id) AS owner
      FROM messages m
      LEFT JOIN assistant_actions a ON a.tenant_id = m.tenant_id AND a.id = m.assistant_action_id
      LEFT JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
     WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound' AND NOT m.imported AND m.initiator <> 'import'
       AND m.marketing_piece_id IS NULL   -- R-MKT-8: invite recipients are counted on the send, never queued
       AND m.bulk_action_id IS NULL       -- R-PAR-41 (parity module 63): bulk recipients are counted on bulk_finished, never queued
       AND (m.id = ANY (${s.extra.messageIds}::uuid[])
            OR (m.status = ANY (${FAILING}::text[])
                AND (CASE WHEN ${s.contactId}::uuid IS NOT NULL THEN m.contact_id = ${s.contactId}::uuid
                          ELSE m.occurred_at > ${winIso}::timestamptz END)))`.execute(tx);
  return r.rows.map((m) => ({
    messageId: m.id as never,
    contactId: m.contact_id as ContactId,
    ownerUserId: m.owner as UserId | null,
    channel: m.channel,
    initiator: m.initiator,
    imported: m.imported,
    status: m.status,
    statusAt: ms(m.status_at),
    dispatchedAt: msOrNull(m.dispatched_at),
    statusReason: m.status_reason,
    marketingPieceId: null,
  }));
}

/**
 * R-ACC-6 inputs: confirmed milestone dates of open deals, with the deal owner. Tenant scope reads the
 * dates whose stored due instant is within 48 h ahead or passed inside the window (uncompleted, or done
 * after it passed), plus every date of a stored open item so a completed, waived or moved date clears.
 * A contact-scoped recompute reads none: these items have no contact, so it neither raises nor clears them.
 */
export async function milestoneFacts(tx: Tx, s: InputScope): Promise<MilestoneDateFacts[]> {
  if (s.contactId !== null) return [];
  const nowIso = iso(s.now);
  const winIso = iso(s.windowStart);
  const r = await sql<{ id: string; deal_id: string; owner_user_id: string; kind: NonNullable<MilestoneDateFacts['kind']>; status: MilestoneDateFacts['status']; due_at: Date | null; due_version: number; responsible: MilestoneDateFacts['responsible']; completed_at: Date | null }>`
    SELECT dd.id, dd.deal_id, d.owner_user_id, dd.kind, dd.status, dd.due_at, dd.due_version, dd.responsible, dd.completed_at
      FROM deal_dates dd JOIN deals d ON d.tenant_id = dd.tenant_id AND d.id = dd.deal_id
     WHERE dd.tenant_id = app.tenant_id() AND d.stage NOT IN ('closed','lost')
       AND (dd.id = ANY (${s.extra.dealDateIds}::uuid[])
            OR (dd.status = 'confirmed' AND dd.due_at IS NOT NULL
                AND dd.due_at <= ${nowIso}::timestamptz + interval '48 hours' AND dd.due_at > ${winIso}::timestamptz
                AND (dd.completed_at IS NULL OR dd.completed_at > dd.due_at)))`.execute(tx);
  return r.rows.map((x) => ({
    dealDateId: x.id as never,
    dealId: x.deal_id as never,
    ownerUserId: x.owner_user_id as UserId,
    dueAt: msOrNull(x.due_at),
    dueVersion: Number(x.due_version),
    responsible: x.responsible,
    completedAt: msOrNull(x.completed_at),
    status: x.status,
    kind: x.kind,
  }));
}

/** Appointments (never imported) that ended more than `hours` ago without an outcome (or got one late). */
export async function appointmentFacts(tx: Tx, s: InputScope, hours: number): Promise<ApptFacts[]> {
  const nowIso = iso(s.now);
  const winIso = iso(s.windowStart);
  const r = await sql<{ id: string; contact_id: string | null; user_id: string; kind: ApptFacts['kind']; starts_at: Date; ends_at: Date; status: ApptFacts['status']; outcome_logged_at: Date | null; created_by_kind: ApptFacts['createdByKind'] }>`
    SELECT p.id, p.contact_id, p.user_id, p.kind, p.starts_at, p.ends_at, p.status, p.outcome_logged_at, p.created_by_kind
      FROM appointments p
     WHERE p.tenant_id = app.tenant_id() AND p.created_by_kind <> 'import'
       AND (p.id = ANY (${s.extra.appointmentIds}::uuid[])
            OR (CASE WHEN ${s.contactId}::uuid IS NOT NULL THEN p.contact_id = ${s.contactId}::uuid
                     ELSE p.status IN ('scheduled','held')
                          AND p.ends_at <= ${nowIso}::timestamptz - make_interval(hours => ${hours})
                          AND p.ends_at > ${winIso}::timestamptz
                          AND (p.outcome_logged_at IS NULL OR p.outcome_logged_at > p.ends_at + make_interval(hours => ${hours})) END))`.execute(tx);
  return r.rows.map((a) => ({
    appointmentId: a.id as never,
    contactId: a.contact_id as ContactId | null,
    userId: a.user_id as UserId,
    kind: a.kind,
    startsAt: ms(a.starts_at),
    endsAt: ms(a.ends_at),
    status: a.status,
    outcomeLoggedAt: msOrNull(a.outcome_logged_at),
    createdByKind: a.created_by_kind,
  }));
}

// ---- recompute writes ----------------------------------------------------------------------------------

/** All recomputes of one tenant serialize (a tenant scan and a contact-scoped run never interleave). */
export async function lockRecompute(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('exception_recompute:' || app.tenant_id()::text, 0))`.execute(tx);
}

/** Rows per upsert statement: bounds the statement's parameter size (a first fill of a 250k tenant is ~12k rows). */
export const UPSERT_CHUNK = 1000;

/**
 * Upserts derived items by dedupe key (core sorts them by key, so concurrent writers lock in one order).
 * One multi-row INSERT ... ON CONFLICT per UPSERT_CHUNK specs, rows in the given order (WITH ORDINALITY),
 * with the same per-row values and conflict rule as one statement per row (lane perf-misses: the per-row
 * round trips were 18 s of a first fill of the large tenant). Core returns each dedupe key at most once,
 * so no statement touches a row twice. An id is drawn for every spec, in order, inserted or not.
 */
export async function upsertItems(tx: Tx, specs: readonly ExceptionItemSpec[], ids: IdGenerator, now: Instant): Promise<void> {
  const nowIso = iso(now);
  for (let i = 0; i < specs.length; i += UPSERT_CHUNK) {
    const chunk = specs.slice(i, i + UPSERT_CHUNK);
    const idCol = chunk.map(() => ids.next() as string);
    await sql`
      INSERT INTO exception_items (tenant_id, id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, due_at,
                                   evidence, condition_cleared_at, rule_version, dedupe_key, computed_at)
      SELECT app.tenant_id(), x.id, x.item_type, x.subject_type, x.subject_id, x.contact_id, x.owner_user_id, x.detected_at, x.due_at,
             x.evidence, x.condition_cleared_at, x.rule_version, x.dedupe_key, ${nowIso}::timestamptz
        FROM unnest(${idCol}::uuid[], ${chunk.map((x) => x.itemType)}::text[], ${chunk.map((x) => x.subjectType)}::text[],
                    ${chunk.map((x) => x.subjectId)}::uuid[], ${chunk.map((x) => x.contactId)}::uuid[], ${chunk.map((x) => x.ownerUserId)}::uuid[],
                    ${chunk.map((x) => iso(x.detectedAt))}::timestamptz[], ${chunk.map((x) => (x.dueAt === null ? null : iso(x.dueAt)))}::timestamptz[],
                    ${chunk.map((x) => JSON.stringify(x.evidence))}::jsonb[],
                    ${chunk.map((x) => (x.conditionClearedAt === null ? null : iso(x.conditionClearedAt)))}::timestamptz[],
                    ${chunk.map((x) => x.ruleVersion)}::smallint[], ${chunk.map((x) => x.dedupeKey)}::text[])
             WITH ORDINALITY AS x(id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, due_at, evidence,
                                  condition_cleared_at, rule_version, dedupe_key, ord)
       ORDER BY x.ord
      ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
        item_type = EXCLUDED.item_type, subject_type = EXCLUDED.subject_type, subject_id = EXCLUDED.subject_id,
        contact_id = EXCLUDED.contact_id, owner_user_id = EXCLUDED.owner_user_id, detected_at = EXCLUDED.detected_at,
        due_at = EXCLUDED.due_at, evidence = EXCLUDED.evidence,
        -- a stored clear instant is kept while the derivation also says cleared (core compares open/cleared only)
        condition_cleared_at = CASE WHEN EXCLUDED.condition_cleared_at IS NULL THEN NULL
                                    ELSE COALESCE(exception_items.condition_cleared_at, EXCLUDED.condition_cleared_at) END,
        rule_version = EXCLUDED.rule_version, computed_at = EXCLUDED.computed_at`.execute(tx);
  }
}

/** Keys whose condition stopped holding: condition_cleared_at = now where still open. Rows are never deleted. */
export async function clearItems(tx: Tx, keys: readonly string[], now: Instant): Promise<number> {
  if (keys.length === 0) return 0;
  const r = await sql`
    UPDATE exception_items SET condition_cleared_at = ${iso(now)}::timestamptz, computed_at = ${iso(now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND dedupe_key = ANY (${[...keys]}::text[]) AND condition_cleared_at IS NULL`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

// ---- the queue (caller's RLS) ----------------------------------------------------------------------------

export type QueueState = 'live' | 'handled' | 'all';

export interface QueueRow extends StoredItemRow {
  contact_visible: boolean;
  contact_detail_visible: boolean;
  contact_first_name: string | null;
  contact_last_name: string | null;
  contact_display_name: string | null;
  owner_name: string | null;
  owner_in_my_team: boolean;
  last_action: 'resolved' | 'reassigned' | 'verified' | 'reopened' | null;
  last_note: string | null;
  last_actor_user_id: string | null;
  last_actor_name: string | null;
  last_at: Date | null;
  /** the item contact's live ownership facts (null when the contact is not visible): the reassign fence */
  contact_ownership_state: string | null;
  contact_owner_user_id: string | null;
  contact_offered_to_user_id: string | null;
  contact_ownership_seq: string | null;
  contact_period_seq: string | null;
}

export interface QueueFilter {
  type?: ExceptionType | undefined;
  ownerUserId?: string | undefined;
  state: QueueState;
  dedupeKey?: string | undefined;
  limit: number;
}

/** The live queue = items whose latest human event is not resolved/verified (R-ACC-1), oldest first. */
export async function queueRows(tx: Tx, f: QueueFilter): Promise<QueueRow[]> {
  const r = await sql<QueueRow>`
    SELECT ${ITEM_COLUMNS},
           (c.id IS NOT NULL) AS contact_visible,
           -- app.contact_detail_row is the inlinable twin of contact_detail_visible (migration 0031): its InitPlans
           -- run once per statement, not once per queue row (lane perf-misses-2; lane perf-misses §7 item 2)
           COALESCE(c.id IS NOT NULL AND EXISTS (SELECT 1 FROM app.contact_detail_row(c.tenant_id, c.id)), false) AS contact_detail_visible,
           c.first_name AS contact_first_name, c.last_name AS contact_last_name, c.display_name AS contact_display_name,
           c.ownership_state AS contact_ownership_state, c.owner_user_id AS contact_owner_user_id,
           c.offered_to_user_id AS contact_offered_to_user_id, c.ownership_seq AS contact_ownership_seq,
           c.ownership_period_seq AS contact_period_seq,
           ou.display_name AS owner_name,
           COALESCE(e.owner_user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]), false) AS owner_in_my_team,
           le.action AS last_action, le.note AS last_note, le.actor_user_id AS last_actor_user_id,
           au.display_name AS last_actor_name, le.occurred_at AS last_at
      FROM exception_items e
      LEFT JOIN contacts c ON c.tenant_id = e.tenant_id AND c.id = e.contact_id
      LEFT JOIN users ou ON ou.id = e.owner_user_id
      LEFT JOIN LATERAL (
        SELECT ev.action, ev.note, ev.actor_user_id, ev.occurred_at FROM exception_events ev
         WHERE ev.tenant_id = e.tenant_id AND ev.exception_dedupe_key = e.dedupe_key
         ORDER BY ev.occurred_at DESC, ev.id DESC LIMIT 1) le ON true
      LEFT JOIN users au ON au.id = le.actor_user_id
     WHERE e.tenant_id = app.tenant_id()
       AND (${f.dedupeKey ?? null}::text IS NULL OR e.dedupe_key = ${f.dedupeKey ?? null}::text)
       AND (${f.type ?? null}::text IS NULL OR e.item_type = ${f.type ?? null}::text)
       AND (${f.ownerUserId ?? null}::uuid IS NULL OR e.owner_user_id = ${f.ownerUserId ?? null}::uuid)
       AND (CASE ${f.state}::text
              WHEN 'live' THEN le.action IS NULL OR le.action NOT IN ('resolved','verified')
              WHEN 'handled' THEN le.action IN ('resolved','verified')
              ELSE true END)
     ORDER BY (e.condition_cleared_at IS NULL) DESC, e.detected_at ASC, e.id ASC
     LIMIT ${f.limit}`.execute(tx);
  return r.rows;
}

/**
 * Live items by type for the queue header (scale-250k): the same rows queueRows returns for
 * { ownerUserId, state: 'live' } (its contact/user joins are LEFT joins and never drop a row), counted
 * without building each row's view, so a 10k-item tenant does not run 10k contact visibility checks.
 */
export async function liveCounts(tx: Tx, ownerUserId: string | undefined): Promise<{ item_type: ExceptionType; n: number }[]> {
  const r = await sql<{ item_type: ExceptionType; n: number }>`
    SELECT e.item_type, count(*)::int AS n
      FROM exception_items e
      LEFT JOIN LATERAL (
        SELECT ev.action FROM exception_events ev
         WHERE ev.tenant_id = e.tenant_id AND ev.exception_dedupe_key = e.dedupe_key
         ORDER BY ev.occurred_at DESC, ev.id DESC LIMIT 1) le ON true
     WHERE e.tenant_id = app.tenant_id()
       AND (${ownerUserId ?? null}::uuid IS NULL OR e.owner_user_id = ${ownerUserId ?? null}::uuid)
       AND (le.action IS NULL OR le.action NOT IN ('resolved','verified'))
     GROUP BY e.item_type`.execute(tx);
  return r.rows;
}

export interface EventRow {
  id: string;
  action: 'resolved' | 'reassigned' | 'verified' | 'reopened';
  note: string | null;
  actor_user_id: string;
  actor_role: string;
  actor_name: string | null;
  ownership_command_id: string | null;
  occurred_at: Date;
}

export async function eventsOf(tx: Tx, dedupeKey: string): Promise<EventRow[]> {
  const r = await sql<EventRow>`
    SELECT ev.id, ev.action, ev.note, ev.actor_user_id, ev.actor_role, u.display_name AS actor_name, ev.ownership_command_id, ev.occurred_at
      FROM exception_events ev LEFT JOIN users u ON u.id = ev.actor_user_id
     WHERE ev.tenant_id = app.tenant_id() AND ev.exception_dedupe_key = ${dedupeKey}
     ORDER BY ev.occurred_at, ev.id`.execute(tx);
  return r.rows;
}

/** Serializes human actions on one item (two Team Leads tapping at once: one wins, the other sees the result). */
export async function lockItem(tx: Tx, dedupeKey: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('exception_item:' || app.tenant_id()::text || ':' || ${dedupeKey}, 0))`.execute(tx);
}

export async function eventById(tx: Tx, id: string): Promise<{ exception_dedupe_key: string; action: string } | null> {
  const r = await sql<{ exception_dedupe_key: string; action: string }>`
    SELECT exception_dedupe_key, action FROM exception_events WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return r.rows[0] ?? null;
}

export async function insertEvent(
  tx: Tx,
  e: { id: string; dedupeKey: string; action: EventRow['action']; note: string | null; actorUserId: string; actorRole: string; ownershipCommandId: string | null },
): Promise<void> {
  await sql`
    INSERT INTO exception_events (tenant_id, id, exception_dedupe_key, action, note, actor_user_id, actor_role, ownership_command_id, occurred_at)
    VALUES (app.tenant_id(), ${e.id}::uuid, ${e.dedupeKey}, ${e.action}, ${e.note}, ${e.actorUserId}::uuid, ${e.actorRole},
            ${e.ownershipCommandId}::uuid, clock_timestamp())`.execute(tx);
}

/** A promise task's source claim (for read-time evidence quotes under the viewer's rights). */
export async function taskClaims(tx: Tx, taskIds: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (taskIds.length === 0) return out;
  const r = await sql<{ id: string; source_claim_id: string }>`
    SELECT id, source_claim_id FROM tasks WHERE tenant_id = app.tenant_id() AND id = ANY (${[...taskIds]}::uuid[]) AND source_claim_id IS NOT NULL`.execute(tx);
  for (const t of r.rows) out.set(t.id, t.source_claim_id);
  return out;
}

export interface LoggedActivityRow {
  dedupe_key: string;
  id: string;
  kind: 'call' | 'text' | 'email';
  direction: 'outbound' | 'inbound' | null;
  outcome: string | null;
  at: Date;
  author_name: string | null;
}

/**
 * R-PAR-32: the activities people logged (notes with source logged_activity, R-PAR-30) inside each untouched
 * lead's ownership period, from its start event to the event that ended it (or now), read under the VIEWER's
 * RLS: the period's ledger rows and the notes are visible only to whoever may see them. Context only: nothing
 * here feeds the derivation, so a logged activity never satisfies, delays or clears the first touch.
 */
export async function loggedActivitiesInPeriods(tx: Tx, periods: readonly { key: string; contactId: string; seq: number }[]): Promise<LoggedActivityRow[]> {
  if (periods.length === 0) return [];
  const r = await sql<LoggedActivityRow>`
    SELECT x.k AS dedupe_key, n.id, n.activity_kind AS kind, n.activity_direction AS direction, n.activity_outcome AS outcome,
           n.activity_at AS at, u.display_name AS author_name
      FROM unnest(${periods.map((p) => p.key)}::text[], ${periods.map((p) => p.contactId)}::uuid[], ${periods.map((p) => p.seq)}::bigint[]) AS x(k, contact_id, seq)
      JOIN lead_ownership_events s ON s.tenant_id = app.tenant_id() AND s.contact_id = x.contact_id AND s.seq = x.seq
      LEFT JOIN LATERAL (
        SELECT e.occurred_at FROM lead_ownership_events e
         WHERE e.tenant_id = s.tenant_id AND e.contact_id = s.contact_id AND e.seq > s.seq AND e.type = ANY (${PERIOD_END_TYPES}::text[])
         ORDER BY e.seq LIMIT 1) pe ON true
      -- a logged time has minute precision (the log sheet's time field): an activity logged in the minute the period
      -- began belongs to it
      JOIN notes n ON n.tenant_id = s.tenant_id AND n.contact_id = s.contact_id AND n.source = 'logged_activity'
                  AND n.activity_at >= date_trunc('minute', s.occurred_at) AND (pe.occurred_at IS NULL OR n.activity_at < pe.occurred_at)
      LEFT JOIN users u ON u.id = n.author_user_id
     ORDER BY x.k, n.activity_at, n.id`.execute(tx);
  return r.rows;
}
