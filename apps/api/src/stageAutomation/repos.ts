// SQL of api/stage-automation (PARITY_PLAN module 67). Every query runs in the caller's transaction under
// RLS (the reconcile and the scans as the tenant's system actor; the settings route as the user).
import { type Instant, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { StagePlaybook } from './decide.js';

export interface StageEventRow {
  id: string;
  contactId: string;
  fromStage: string | null;
  toStage: string;
  actorKind: 'user' | 'system' | 'support' | 'none';
  actorUserId: string | null;
  occurredAt: Instant;
  /** the bulk stage action that made this change (migration 0041: recorded by the history definer), else null */
  bulkActionId: string | null;
}

export async function stageEvent(tx: Tx, id: string): Promise<StageEventRow | null> {
  const r = await sql<{ id: string; contact_id: string; from_stage: string | null; to_stage: string; actor_kind: StageEventRow['actorKind']; actor_user_id: string | null; occurred_at: Date; bulk_action_id: string | null }>`
    SELECT id, contact_id, from_stage, to_stage, actor_kind, actor_user_id, occurred_at, bulk_action_id
      FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const x = r.rows[0];
  return x
    ? { id: x.id, contactId: x.contact_id, fromStage: x.from_stage, toStage: x.to_stage, actorKind: x.actor_kind, actorUserId: x.actor_user_id, occurredAt: x.occurred_at.getTime() as Instant, bulkActionId: x.bulk_action_id }
    : null;
}

/**
 * The stage event the caller's own stage change just wrote (same transaction, read under the caller's RLS):
 * the newest event of this contact by this user from → to.
 */
export async function ownLatestStageEvent(tx: Tx, contactId: string, from: string, to: string): Promise<string | null> {
  const r = await sql<{ id: string }>`
    SELECT id FROM contact_stage_events
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND actor_kind = 'user' AND actor_user_id = app.user_id()
       AND from_stage IS NOT DISTINCT FROM ${from} AND to_stage = ${to}
     ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx);
  return r.rows[0]?.id ?? null;
}

export interface DecisionRow {
  outcome: 'started' | 'skipped';
  reason: string | null;
  playbookId: string | null;
  playbookName: string | null;
  enrollmentId: string | null;
}

export async function decisionOf(tx: Tx, stageEventId: string): Promise<DecisionRow | null> {
  const r = await sql<{ outcome: DecisionRow['outcome']; reason: string | null; playbook_id: string | null; name: string | null; enrollment_id: string | null }>`
    SELECT d.outcome, d.reason, d.playbook_id, p.name, d.enrollment_id
      FROM stage_automation_decisions d
      LEFT JOIN playbooks p ON p.tenant_id = d.tenant_id AND p.id = d.playbook_id
     WHERE d.tenant_id = app.tenant_id() AND d.stage_event_id = ${stageEventId}`.execute(tx);
  const x = r.rows[0];
  return x ? { outcome: x.outcome, reason: x.reason, playbookId: x.playbook_id, playbookName: x.name, enrollmentId: x.enrollment_id } : null;
}

export async function insertDecision(tx: Tx, d: { stageEventId: string; contactId: string; toStage: string; outcome: 'started' | 'skipped'; reason: string | null; playbookId: string; enrollmentId: string | null }): Promise<boolean> {
  const r = await sql`
    INSERT INTO stage_automation_decisions (tenant_id, stage_event_id, contact_id, to_stage, outcome, reason, playbook_id, enrollment_id)
    VALUES (app.tenant_id(), ${d.stageEventId}, ${d.contactId}, ${d.toStage}, ${d.outcome}, ${d.reason}, ${d.playbookId}, ${d.enrollmentId})
    ON CONFLICT (tenant_id, stage_event_id) DO NOTHING`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export interface ContactRow {
  exists: boolean;
  deleted: boolean;
  merged: boolean;
  stage: string;
  ownerUserId: string | null;
}

export async function contactRow(tx: Tx, contactId: string): Promise<ContactRow> {
  const r = await sql<{ deleted: boolean; merged: boolean; stage: string; owner_user_id: string | null }>`
    SELECT deleted_at IS NOT NULL AS deleted, merged_into_contact_id IS NOT NULL AS merged, stage, owner_user_id
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const x = r.rows[0];
  return x ? { exists: true, deleted: x.deleted, merged: x.merged, stage: x.stage, ownerUserId: x.owner_user_id } : { exists: false, deleted: false, merged: false, stage: '', ownerUserId: null };
}

/**
 * Active playbooks naming the event's stage that could cover a contact owned by `ownerUserId` (team playbooks,
 * and the owner's own agent playbook), as they were configured when the stage was entered: a playbook
 * changed after the event (its stage set later, renamed, retired) does not reach back to it.
 */
export async function candidatePlaybooks(tx: Tx, stageEventId: string, ownerUserId: string | null): Promise<StagePlaybook[]> {
  const r = await sql<{ id: string; name: string; scope: 'team' | 'agent'; owner_user_id: string | null; approved: string | null }>`
    SELECT p.id, p.name, p.scope, p.owner_user_id,
           (SELECT v.id FROM playbook_versions v WHERE v.tenant_id = p.tenant_id AND v.playbook_id = p.id AND v.status = 'approved') AS approved
      FROM contact_stage_events e
      JOIN playbooks p ON p.tenant_id = e.tenant_id AND p.auto_enroll_stage = e.to_stage AND p.updated_at <= e.occurred_at
     WHERE e.tenant_id = app.tenant_id() AND e.id = ${stageEventId} AND p.status = 'active' AND p.kind <> 'new_lead_response'
       AND (p.scope = 'team' OR (p.scope = 'agent' AND p.owner_user_id = ${ownerUserId}::uuid))
     ORDER BY p.id`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, name: x.name, scope: x.scope, ownerUserId: x.owner_user_id, approvedVersionId: x.approved }));
}

export async function versionSteps(tx: Tx, versionId: string): Promise<unknown> {
  const r = await sql<{ steps: unknown }>`SELECT steps FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${versionId}`.execute(tx);
  return r.rows[0]?.steps ?? null;
}

export async function memberOf(tx: Tx, userId: string): Promise<{ role: string; active: boolean } | null> {
  const r = await sql<{ role: string; status: string }>`SELECT role, status FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  const x = r.rows[0];
  return x ? { role: x.role, active: x.status === 'active' } : null;
}

/**
 * Recent user-made stage events with no decision yet that some active playbook could cover (the backup
 * scan: the request path decides the common case at once). A merge's copy of the loser's history onto the
 * survivor (0027, append-only copies with the original instant and actor) is not a stage entry and is
 * never reconciled.
 */
export async function pendingStageEvents(tx: Tx, since: Instant, limit: number): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT e.id FROM contact_stage_events e
      JOIN contacts c ON c.tenant_id = e.tenant_id AND c.id = e.contact_id
     WHERE e.tenant_id = app.tenant_id() AND e.actor_kind = 'user' AND e.occurred_at > ${toIso(since)}::timestamptz
       AND NOT EXISTS (SELECT 1 FROM stage_automation_decisions d WHERE d.tenant_id = e.tenant_id AND d.stage_event_id = e.id)
       AND EXISTS (SELECT 1 FROM playbooks p WHERE p.tenant_id = e.tenant_id AND p.status = 'active' AND p.auto_enroll_stage = e.to_stage
                     AND p.updated_at <= e.occurred_at AND (p.scope = 'team' OR p.owner_user_id = c.owner_user_id))
       AND NOT EXISTS (SELECT 1 FROM contact_stage_events o JOIN contacts l ON l.tenant_id = o.tenant_id AND l.id = o.contact_id
                        WHERE o.tenant_id = e.tenant_id AND l.merged_into_contact_id = e.contact_id AND o.occurred_at = e.occurred_at
                          AND o.to_stage = e.to_stage AND o.from_stage IS NOT DISTINCT FROM e.from_stage
                          AND o.actor_kind = e.actor_kind AND o.actor_user_id IS NOT DISTINCT FROM e.actor_user_id)
     ORDER BY e.occurred_at, e.id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/**
 * A merge copy (see pendingStageEvents): the request path never meets one, the job re-checks it. Compared
 * in SQL against the event row itself (timestamps keep their microseconds; a JS Date would not).
 */
export async function isMergeCopy(tx: Tx, eventId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM contact_stage_events e
                     JOIN contact_stage_events o ON o.tenant_id = e.tenant_id AND o.id <> e.id AND o.occurred_at = e.occurred_at
                      AND o.to_stage = e.to_stage AND o.from_stage IS NOT DISTINCT FROM e.from_stage
                      AND o.actor_kind = e.actor_kind AND o.actor_user_id IS NOT DISTINCT FROM e.actor_user_id
                     JOIN contacts l ON l.tenant_id = o.tenant_id AND l.id = o.contact_id AND l.merged_into_contact_id = e.contact_id
                    WHERE e.tenant_id = app.tenant_id() AND e.id = ${eventId}) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

// ---- settings ---------------------------------------------------------------------------------------

export interface PlaybookSettingRow {
  id: string;
  kind: string;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  name: string;
  status: string;
  autoEnrollStage: string | null;
}

export async function playbookSetting(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<PlaybookSettingRow | null> {
  const lock = o.lock ? sql` FOR UPDATE` : sql``;
  const r = await sql<{ id: string; kind: string; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; status: string; auto_enroll_stage: string | null }>`
    SELECT id, kind, scope, owner_user_id, name, status, auto_enroll_stage FROM playbooks WHERE tenant_id = app.tenant_id() AND id = ${id}${lock}`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, kind: x.kind, scope: x.scope, ownerUserId: x.owner_user_id, name: x.name, status: x.status, autoEnrollStage: x.auto_enroll_stage } : null;
}

export async function setAutoEnrollStage(tx: Tx, id: string, stage: string | null): Promise<void> {
  await sql`UPDATE playbooks SET auto_enroll_stage = ${stage}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** The other active playbook already holding (scope, owner, stage), if any (the DB unique index decides). */
export async function stageHolder(tx: Tx, p: { id: string; scope: 'team' | 'agent'; ownerUserId: string | null }, stage: string): Promise<string | null> {
  const r = await sql<{ id: string }>`
    SELECT id FROM playbooks WHERE tenant_id = app.tenant_id() AND status = 'active' AND auto_enroll_stage = ${stage} AND scope = ${p.scope}
       AND owner_user_id IS NOT DISTINCT FROM ${p.ownerUserId}::uuid AND id <> ${p.id} LIMIT 1`.execute(tx);
  return r.rows[0]?.id ?? null;
}

// ---- annual reminders ---------------------------------------------------------------------------------

export async function tenantTimezone(tx: Tx): Promise<string> {
  const r = await sql<{ tz: string }>`SELECT default_timezone AS tz FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.tz ?? 'UTC';
}

export interface AnnualValueRow {
  contactId: string;
  fieldId: string;
  label: string;
  date: string;
  ownerUserId: string;
}

/**
 * Live, owned people whose annual date falls on one of `monthDays` ("MM-DD"), keyset-paged by
 * (contact, field). The owner must be an active member (a task is assigned to them).
 */
export async function annualValues(tx: Tx, monthDays: readonly string[], after: { contactId: string; fieldId: string } | null, limit: number): Promise<AnnualValueRow[]> {
  const cursor = after ? sql`AND (v.contact_id, v.field_id) > (${after.contactId}::uuid, ${after.fieldId}::uuid)` : sql``;
  const r = await sql<{ contact_id: string; field_id: string; label: string; d: string; owner_user_id: string }>`
    SELECT v.contact_id, v.field_id, f.label, to_char(v.value_date, 'YYYY-MM-DD') AS d, c.owner_user_id
      FROM contact_field_values v
      JOIN custom_field_defs f ON f.tenant_id = v.tenant_id AND f.id = v.field_id AND f.annual AND f.archived_at IS NULL
      JOIN contacts c ON c.tenant_id = v.tenant_id AND c.id = v.contact_id
      JOIN memberships m ON m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id AND m.status = 'active'
     WHERE v.tenant_id = app.tenant_id() AND v.value_date IS NOT NULL
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL AND c.owner_user_id IS NOT NULL
       AND to_char(v.value_date, 'MM-DD') = ANY (${[...monthDays]}::text[])
       ${cursor}
     ORDER BY v.contact_id, v.field_id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => ({ contactId: x.contact_id, fieldId: x.field_id, label: x.label, date: x.d, ownerUserId: x.owner_user_id }));
}

/** One reminder task; the derived id is the dedupe key (a rerun finds it and inserts nothing). */
export async function insertAnnualTask(tx: Tx, t: { id: string; assigneeUserId: string; contactId: string; title: string; dueAt: Instant; dueTz: string }): Promise<boolean> {
  const r = await sql`
    INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, due_all_day, due_tz, status, created_by_kind)
    VALUES (app.tenant_id(), ${t.id}, ${t.assigneeUserId}, ${t.contactId}, 'todo', ${t.title}, ${toIso(t.dueAt)}::timestamptz, true, ${t.dueTz}, 'open', 'system')
    ON CONFLICT (tenant_id, id) DO NOTHING`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}
