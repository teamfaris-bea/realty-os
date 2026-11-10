// Playbooks, versions, approvals, enrollments and step runs (DATA_MODEL §1.6). Versions are frozen once
// they leave draft and only approved versions run (DB triggers, R-AST-4); step runs are system-written.
import type { PlaybookStep, Tone } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface PlaybookRow {
  id: string;
  kind: string;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  name: string;
  templateKey: string | null;
  status: string;
}

export async function playbookById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<PlaybookRow | null> {
  const r = o.lock
    ? await sql<{ id: string; kind: string; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; template_key: string | null; status: string }>`
        SELECT id, kind, scope, owner_user_id, name, template_key, status FROM playbooks WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<{ id: string; kind: string; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; template_key: string | null; status: string }>`
        SELECT id, kind, scope, owner_user_id, name, template_key, status FROM playbooks WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const p = r.rows[0];
  return p ? { id: p.id, kind: p.kind, scope: p.scope, ownerUserId: p.owner_user_id, name: p.name, templateKey: p.template_key, status: p.status } : null;
}

export async function listPlaybooks(tx: Tx): Promise<PlaybookRow[]> {
  const r = await sql<{ id: string; kind: string; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; template_key: string | null; status: string }>`
    SELECT id, kind, scope, owner_user_id, name, template_key, status FROM playbooks WHERE tenant_id = app.tenant_id() ORDER BY created_at, id`.execute(tx);
  return r.rows.map((p) => ({ id: p.id, kind: p.kind, scope: p.scope, ownerUserId: p.owner_user_id, name: p.name, templateKey: p.template_key, status: p.status }));
}

export async function insertPlaybook(tx: Tx, p: { id: string; kind: string; scope: 'team' | 'agent'; ownerUserId: string | null; name: string; templateKey: string | null }): Promise<void> {
  await sql`
    INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name, template_key)
    VALUES (app.tenant_id(), ${p.id}, ${p.kind}, ${p.scope}, ${p.ownerUserId}, ${p.name}, ${p.templateKey})`.execute(tx);
}

export interface VersionRow {
  id: string;
  playbookId: string;
  versionNo: number;
  steps: unknown[];
  tone: Record<string, unknown>;
  contentSha256: string;
  status: 'draft' | 'approved' | 'superseded' | 'revoked';
  createdByUserId: string;
  createdAt: Instant;
}

type RawVersion = { id: string; playbook_id: string; version_no: number; steps: unknown[]; tone: Record<string, unknown>; content_sha256: string; status: VersionRow['status']; created_by_user_id: string; created_at: Date };
const version = (v: RawVersion): VersionRow => ({ id: v.id, playbookId: v.playbook_id, versionNo: v.version_no, steps: v.steps, tone: v.tone, contentSha256: v.content_sha256, status: v.status, createdByUserId: v.created_by_user_id, createdAt: instantFromDate(v.created_at) });

export async function versionById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<VersionRow | null> {
  const r = o.lock
    ? await sql<RawVersion>`SELECT id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id, created_at FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<RawVersion>`SELECT id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id, created_at FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? version(r.rows[0]) : null;
}

export async function versionsOf(tx: Tx, playbookIds: readonly string[]): Promise<VersionRow[]> {
  if (playbookIds.length === 0) return [];
  const r = await sql<RawVersion>`
    SELECT id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id, created_at FROM playbook_versions
     WHERE tenant_id = app.tenant_id() AND playbook_id = ANY (${playbookIds}::uuid[]) ORDER BY playbook_id, version_no`.execute(tx);
  return r.rows.map(version);
}

export async function approvedVersionOf(tx: Tx, playbookId: string): Promise<VersionRow | null> {
  const r = await sql<RawVersion>`
    SELECT id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id, created_at FROM playbook_versions
     WHERE tenant_id = app.tenant_id() AND playbook_id = ${playbookId} AND status = 'approved'`.execute(tx);
  return r.rows[0] ? version(r.rows[0]) : null;
}

export async function insertVersion(tx: Tx, v: { id: string; playbookId: string; versionNo: number; steps: readonly PlaybookStep[]; tone: Tone; sha: string; userId: string }): Promise<void> {
  await sql`
    INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
    VALUES (app.tenant_id(), ${v.id}, ${v.playbookId}, ${v.versionNo}, ${JSON.stringify(v.steps)}::jsonb, ${JSON.stringify(v.tone)}::jsonb, ${v.sha}, 'draft', ${v.userId})`.execute(tx);
}

export async function replaceDraft(tx: Tx, id: string, v: { steps: readonly PlaybookStep[]; tone: Tone; sha: string }): Promise<void> {
  await sql`
    UPDATE playbook_versions SET steps = ${JSON.stringify(v.steps)}::jsonb, tone = ${JSON.stringify(v.tone)}::jsonb, content_sha256 = ${v.sha}
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND status = 'draft'`.execute(tx);
}

export async function setVersionStatus(tx: Tx, id: string, status: VersionRow['status']): Promise<void> {
  await sql`UPDATE playbook_versions SET status = ${status} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function insertApproval(tx: Tx, a: { id: string; versionId: string; decision: 'approve' | 'revoke'; userId: string; role: string; sha: string; attestation: string; now: Instant }): Promise<void> {
  await sql`
    INSERT INTO playbook_approvals (tenant_id, id, playbook_version_id, decision, decided_by_user_id, decided_by_role, content_sha256, attestation, decided_at)
    VALUES (app.tenant_id(), ${a.id}, ${a.versionId}, ${a.decision}, ${a.userId}, ${a.role}, ${a.sha}, ${a.attestation}, ${toIso(a.now)}::timestamptz)`.execute(tx);
}

export async function latestApproval(tx: Tx, versionId: string): Promise<{ decision: 'approve' | 'revoke'; contentSha256: string } | null> {
  const r = await sql<{ decision: 'approve' | 'revoke'; content_sha256: string }>`
    SELECT decision, content_sha256 FROM playbook_approvals WHERE tenant_id = app.tenant_id() AND playbook_version_id = ${versionId}
     ORDER BY decided_at DESC, id DESC LIMIT 1`.execute(tx);
  return r.rows[0] ? { decision: r.rows[0].decision, contentSha256: r.rows[0].content_sha256 } : null;
}

/** The team playbook of a kind (new_lead_response is team-scoped by CHECK). */
export async function teamPlaybookOfKind(tx: Tx, kind: string): Promise<PlaybookRow | null> {
  const r = await sql<{ id: string }>`
    SELECT p.id FROM playbooks p WHERE p.tenant_id = app.tenant_id() AND p.kind = ${kind} AND p.scope = 'team' AND p.status = 'active'
     ORDER BY EXISTS (SELECT 1 FROM playbook_versions v WHERE v.tenant_id = p.tenant_id AND v.playbook_id = p.id AND v.status = 'approved') DESC, p.created_at
     LIMIT 1`.execute(tx);
  return r.rows[0] ? playbookById(tx, r.rows[0].id) : null;
}

/** The contact owner's own agent playbook of a kind, else the team's. */
export async function playbookForContact(tx: Tx, kind: string, ownerUserId: string | null): Promise<PlaybookRow | null> {
  const r = await sql<{ id: string }>`
    SELECT p.id FROM playbooks p
     WHERE p.tenant_id = app.tenant_id() AND p.kind = ${kind} AND p.status = 'active'
       AND ((p.scope = 'agent' AND p.owner_user_id = ${ownerUserId}) OR p.scope = 'team')
       AND EXISTS (SELECT 1 FROM playbook_versions v WHERE v.tenant_id = p.tenant_id AND v.playbook_id = p.id AND v.status = 'approved')
     ORDER BY (p.scope = 'agent') DESC, p.created_at LIMIT 1`.execute(tx);
  return r.rows[0] ? playbookById(tx, r.rows[0].id) : null;
}

// ---- enrollments ---------------------------------------------------------------------------------------

export interface EnrollmentRow {
  id: string;
  playbookId: string;
  versionId: string;
  contactId: string;
  enrolledBy: string;
  state: 'active' | 'paused' | 'completed' | 'stopped';
  pauseReason: string | null;
  currentStep: number;
  nextStepDueAt: Instant | null;
  createdAt: Instant;
  anchorKind: 'deal' | 'appointment' | 'task' | null;
  anchorId: string | null;
}

type RawEnrollment = { id: string; playbook_id: string; playbook_version_id: string; contact_id: string; enrolled_by: string; state: EnrollmentRow['state']; pause_reason: string | null; current_step: number; next_step_due_at: Date | null; created_at: Date; anchor_kind: EnrollmentRow['anchorKind']; anchor_id: string | null };
const enrollment = (e: RawEnrollment): EnrollmentRow => ({
  id: e.id,
  playbookId: e.playbook_id,
  versionId: e.playbook_version_id,
  contactId: e.contact_id,
  enrolledBy: e.enrolled_by,
  state: e.state,
  pauseReason: e.pause_reason,
  currentStep: e.current_step,
  nextStepDueAt: e.next_step_due_at ? instantFromDate(e.next_step_due_at) : null,
  createdAt: instantFromDate(e.created_at),
  anchorKind: e.anchor_kind,
  anchorId: e.anchor_id,
});
const ENR = sql`id, playbook_id, playbook_version_id, contact_id, enrolled_by, state, pause_reason, current_step, next_step_due_at, created_at, anchor_kind, anchor_id`;

export async function enrollmentById(tx: Tx, id: string, o: { lock?: boolean } = {}): Promise<EnrollmentRow | null> {
  const r = o.lock
    ? await sql<RawEnrollment>`SELECT ${ENR} FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx)
    : await sql<RawEnrollment>`SELECT ${ENR} FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ? enrollment(r.rows[0]) : null;
}

export async function liveEnrollmentOf(tx: Tx, contactId: string): Promise<EnrollmentRow | null> {
  const r = await sql<RawEnrollment>`SELECT ${ENR} FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND state IN ('active','paused')`.execute(tx);
  return r.rows[0] ? enrollment(r.rows[0]) : null;
}

export async function enrollmentsOnVersion(tx: Tx, versionId: string, limit: number): Promise<EnrollmentRow[]> {
  const r = await sql<RawEnrollment>`
    SELECT ${ENR} FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND playbook_version_id = ${versionId} AND state IN ('active','paused')
     ORDER BY contact_id LIMIT ${limit}`.execute(tx);
  return r.rows.map(enrollment);
}

/** Live enrollments on a revoked version not yet paused for the revocation (R-AST-4). */
export async function enrollmentsToRevoke(tx: Tx, versionId: string, limit: number): Promise<EnrollmentRow[]> {
  const r = await sql<RawEnrollment>`
    SELECT ${ENR} FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND playbook_version_id = ${versionId}
       AND (state = 'active' OR (state = 'paused' AND pause_reason IS DISTINCT FROM 'approval_revoked'))
     ORDER BY contact_id LIMIT ${limit}`.execute(tx);
  return r.rows.map(enrollment);
}

export async function insertEnrollment(tx: Tx, e: { id: string; playbookId: string; versionId: string; contactId: string; enrolledBy: 'user' | 'new_lead' | 'deal_closed'; userId: string | null; dueAt: Instant | null; anchor: { kind: 'deal' | 'appointment' | 'task'; id: string } | null }): Promise<void> {
  await sql`
    INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, enrolled_by_user_id, state, current_step, next_step_due_at,
      anchor_kind, anchor_id)
    VALUES (app.tenant_id(), ${e.id}, ${e.playbookId}, ${e.versionId}, ${e.contactId}, ${e.enrolledBy}, ${e.userId}, 'active', 0,
      ${e.dueAt === null ? null : toIso(e.dueAt)}::timestamptz, ${e.anchor?.kind ?? null}, ${e.anchor?.id ?? null})`.execute(tx);
}

export async function scheduleEnrollment(tx: Tx, id: string, dueAt: Instant | null, currentStep?: number): Promise<void> {
  await sql`
    UPDATE playbook_enrollments SET next_step_due_at = ${dueAt === null ? null : toIso(dueAt)}::timestamptz, current_step = COALESCE(${currentStep ?? null}::int, current_step)
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function endEnrollment(tx: Tx, id: string, state: 'completed' | 'stopped', reason: string | null, now: Instant): Promise<void> {
  await sql`
    UPDATE playbook_enrollments SET state = ${state}, stop_reason = ${reason}, ended_at = ${toIso(now)}::timestamptz, next_step_due_at = NULL,
           pause_reason = NULL, paused_at = NULL
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND state IN ('active','paused')`.execute(tx);
}

export async function pauseEnrollment(tx: Tx, id: string, reason: string, now: Instant): Promise<boolean> {
  const r = await sql`
    UPDATE playbook_enrollments SET state = 'paused', pause_reason = ${reason}, paused_at = ${toIso(now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND state = 'active'`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function resumeEnrollment(tx: Tx, id: string, userId: string, now: Instant): Promise<boolean> {
  const r = await sql`
    UPDATE playbook_enrollments SET state = 'active', pause_reason = NULL, paused_at = NULL, paused_by_message_id = NULL, resumed_by_user_id = ${userId},
           next_step_due_at = ${toIso(now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND state = 'paused'`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

export async function migrateEnrollmentVersion(tx: Tx, id: string, versionId: string, currentStep: number, dueAt: Instant | null): Promise<void> {
  await sql`
    UPDATE playbook_enrollments SET playbook_version_id = ${versionId}, current_step = ${currentStep},
           next_step_due_at = CASE WHEN state = 'active' THEN ${dueAt === null ? null : toIso(dueAt)}::timestamptz ELSE next_step_due_at END
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

// ---- step runs ----------------------------------------------------------------------------------------

export interface StepRunRow {
  id: string;
  enrollmentId: string;
  versionId: string;
  stepKey: string;
  status: 'scheduled' | 'sent' | 'converted_to_draft' | 'skipped_ineligible' | 'canceled_paused' | 'failed';
  scheduledFor: Instant;
  messageId: string | null;
  messageStatus: string | null;
  messageStatusReason: string | null;
  messageScheduledFor: Instant | null;
  actionId: string | null;
  updatedAt: Instant;
}

export async function stepRunsOf(tx: Tx, enrollmentId: string): Promise<StepRunRow[]> {
  const r = await sql<{ id: string; enrollment_id: string; playbook_version_id: string; step_key: string; status: StepRunRow['status']; scheduled_for: Date; message_id: string | null; m_status: string | null; m_reason: string | null; m_sched: Date | null; assistant_action_id: string | null; updated_at: Date }>`
    SELECT s.id, s.enrollment_id, s.playbook_version_id, s.step_key, s.status, s.scheduled_for, s.message_id, m.status AS m_status, m.status_reason AS m_reason, m.scheduled_for AS m_sched,
           s.assistant_action_id, s.updated_at
      FROM playbook_step_runs s LEFT JOIN messages m ON m.tenant_id = s.tenant_id AND m.id = s.message_id
     WHERE s.tenant_id = app.tenant_id() AND s.enrollment_id = ${enrollmentId} ORDER BY s.updated_at, s.id`.execute(tx);
  return r.rows.map((x) => ({
    id: x.id,
    enrollmentId: x.enrollment_id,
    versionId: x.playbook_version_id,
    stepKey: x.step_key,
    status: x.status,
    scheduledFor: instantFromDate(x.scheduled_for),
    messageId: x.message_id,
    messageStatus: x.m_status,
    messageStatusReason: x.m_reason,
    messageScheduledFor: x.m_sched ? instantFromDate(x.m_sched) : null,
    actionId: x.assistant_action_id,
    updatedAt: instantFromDate(x.updated_at),
  }));
}

export async function insertStepRun(tx: Tx, s: { id: string; enrollmentId: string; versionId: string; stepKey: string; status: StepRunRow['status']; scheduledFor: Instant; actionId: string | null }): Promise<void> {
  await sql`
    INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, assistant_action_id)
    VALUES (app.tenant_id(), ${s.id}, ${s.enrollmentId}, ${s.versionId}, ${s.stepKey}, ${s.status}, ${toIso(s.scheduledFor)}::timestamptz, ${s.actionId})`.execute(tx);
}

export async function updateStepRun(tx: Tx, id: string, u: { status: StepRunRow['status']; messageId?: string | null; actionId?: string | null; versionId?: string; scheduledFor?: Instant }): Promise<void> {
  await sql`
    UPDATE playbook_step_runs SET status = ${u.status},
           message_id = CASE WHEN ${u.messageId === undefined} THEN message_id ELSE ${u.messageId ?? null}::uuid END,
           assistant_action_id = CASE WHEN ${u.actionId === undefined} THEN assistant_action_id ELSE ${u.actionId ?? null}::uuid END,
           playbook_version_id = COALESCE(${u.versionId ?? null}::uuid, playbook_version_id),
           scheduled_for = COALESCE(${u.scheduledFor === undefined ? null : toIso(u.scheduledFor)}::timestamptz, scheduled_for), updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** Cancels the not-yet-dispatched assistant messages of these step runs (never one already dispatching). */
export async function cancelStepMessages(tx: Tx, stepRunIds: readonly string[], reason: string): Promise<string[]> {
  if (stepRunIds.length === 0) return [];
  const r = await sql<{ id: string }>`
    UPDATE messages SET status = 'canceled', status_reason = ${reason}
     WHERE tenant_id = app.tenant_id() AND playbook_step_run_id = ANY (${stepRunIds}::uuid[]) AND status IN ('queued','scheduled')
    RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

export async function hasEnrollmentFor(tx: Tx, contactId: string, anchor: { kind: string; id: string }): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM playbook_enrollments WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND anchor_kind = ${anchor.kind} AND anchor_id = ${anchor.id}) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}
