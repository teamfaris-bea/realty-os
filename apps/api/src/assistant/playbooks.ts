// Playbooks: "approve rules, not every message" (ARCHITECTURE §11; R-AST-3, R-AST-4, R-CONSENT-5,
// R-AUDIT-5 playbook approve/revoke; E31, E32).
//
// - A version is born a draft and frozen once it leaves draft (DB trigger). Editing an approved playbook
//   creates a NEW draft; the old approved version keeps running until the new one is approved.
// - Approve: core.validatePlaybook must report nothing (a marketing intent declared informational, an
//   always-human topic, a human claim, ... block approval), the approver taps an attestation bound to the
//   version's exact content hash (append-only playbook_approvals; the DB checks the hash, the approver's
//   own identity and role: agent playbooks by their agent, team playbooks by Owner/Admin). The previous
//   approved version becomes `superseded`, and an assistant.playbook_migrate job moves its live
//   enrollments to the new version at their next step boundary (by stepKey, core.migrateEnrollment).
// - Revoke: the version becomes `revoked` at once, so the dispatch guard refuses any of its messages from
//   that instant (R-GATE-4); assistant.playbook_revoked then pauses every enrollment on it
//   (`approval_revoked`) and cancels their queued step messages, 500 per run under per-contact locks.
import { type PlaybookContent, type PlaybookKind, type PlaybookStep, PlaybookStepSchema, type Tone, ToneSchema, contentSha256, storedContent, validatePlaybookContent } from '@realty/core/assistant';
import type { ContactId, Instant, UserActor } from '@realty/core/foundation';
import { type Tx, enqueueJob, lockContact } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { asUser } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { migrateOne } from './enrollments.js';
import { identityFacts } from './repos/context.js';
import * as P from './repos/playbooks.js';
import { templateByKey } from './templates.js';
import { ASSISTANT_JOBS, type AssistantDeps } from './types.js';

export interface VersionView {
  id: string;
  versionNo: number;
  status: string;
  contentSha256: string;
  /** a step playbook's PlaybookStep[]; a trigger or voice playbook's one PlaybookContent object (module 26) */
  steps: unknown[] | Record<string, unknown>;
  tone: Record<string, unknown>;
  /** what blocks approval (empty when the version can be approved) */
  issues: { index: number; stepKey?: string | undefined; code: string; detail?: string | undefined }[];
  createdAt: string;
}

export interface PlaybookView {
  id: string;
  kind: string;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  name: string;
  templateKey: string | null;
  approvedVersionId: string | null;
  versions: VersionView[];
}

export const MIGRATE_BATCH = 500;

async function issuesFor(tx: Tx, p: P.PlaybookRow, content: unknown): Promise<VersionView['issues']> {
  const identity = await identityFacts(tx, { scope: p.scope, agentUserId: p.ownerUserId });
  // module 26: one validator for every content kind (steps, triggers, voice), so PLAYBOOK_INVALID never fires
  // for valid trigger or voice content (R-NURT-1)
  return validatePlaybookContent(content, { kind: p.kind as PlaybookKind, identity });
}

async function view(tx: Tx, p: P.PlaybookRow): Promise<PlaybookView> {
  const versions = await P.versionsOf(tx, [p.id]);
  const out: VersionView[] = [];
  for (const v of versions) out.push({ id: v.id, versionNo: v.versionNo, status: v.status, contentSha256: v.contentSha256, steps: v.steps, tone: v.tone, issues: v.status === 'draft' ? await issuesFor(tx, p, v.steps) : [], createdAt: new Date(v.createdAt).toISOString() });
  return { id: p.id, kind: p.kind, scope: p.scope, ownerUserId: p.ownerUserId, name: p.name, templateKey: p.templateKey, approvedVersionId: versions.find((v) => v.status === 'approved')?.id ?? null, versions: out };
}

export async function listPlaybooks(actor: UserActor, deps: AssistantDeps): Promise<PlaybookView[]> {
  return asUser(deps, actor, async (tx) => {
    const out: PlaybookView[] = [];
    for (const p of await P.listPlaybooks(tx)) out.push(await view(tx, p));
    return out;
  });
}

export async function playbookView(actor: UserActor, playbookId: string, deps: AssistantDeps): Promise<PlaybookView> {
  return asUser(deps, actor, async (tx) => {
    const p = await P.playbookById(tx, playbookId);
    if (!p) throw new AppError('NOT_FOUND');
    return view(tx, p);
  });
}

function parseSteps(raw: readonly unknown[]): PlaybookStep[] {
  const out: PlaybookStep[] = [];
  for (const s of raw) {
    const r = PlaybookStepSchema.safeParse(s);
    if (!r.success) throw new AppError('PLAYBOOK_INVALID', { issues: r.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), code: i.code })) });
    out.push(r.data);
  }
  if (out.length === 0) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'NO_STEPS' }] });
  return out;
}

/** Kinds whose stored content is one PlaybookContent object rather than a step array (0018, module 26). */
const OBJECT_CONTENT: ReadonlySet<string> = new Set(['trigger', 'voice_answering']);

/**
 * The content to store for a version of `kind`: a step array (Phase 1) or, for trigger and voice
 * playbooks, one content object of the right kind. Shape only: everything else is validatePlaybookContent's
 * job (it lists the issues on the draft and blocks approval).
 */
function parseContent(kind: string, raw: unknown): PlaybookStep[] | PlaybookContent {
  if (!OBJECT_CONTENT.has(kind)) {
    if (!Array.isArray(raw)) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'CONTENT_KIND_MISMATCH' }] });
    return parseSteps(raw);
  }
  const c = storedContent(raw);
  if (c === null || Array.isArray(raw) || c.kind !== (kind === 'trigger' ? 'triggers' : 'voice')) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'CONTENT_KIND_MISMATCH' }] });
  return raw as PlaybookContent;
}

function parseTone(raw: unknown): Tone {
  const r = ToneSchema.safeParse(raw ?? {});
  if (!r.success) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'TONE' }] });
  return r.data;
}

export interface CreatePlaybookInput {
  templateKey?: string | undefined;
  kind?: PlaybookKind | undefined;
  scope?: 'team' | 'agent' | undefined;
  name?: string | undefined;
  steps?: unknown[] | Record<string, unknown> | undefined;
  tone?: unknown;
}

/** POST /playbooks: a playbook with its first (draft) version, from a built-in template or given steps. */
export async function createPlaybook(actor: UserActor, input: CreatePlaybookInput, deps: AssistantDeps): Promise<PlaybookView> {
  const t = input.templateKey ? templateByKey(input.templateKey) : null;
  if (input.templateKey && !t) throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'UNKNOWN_TEMPLATE' }] });
  const kind = (input.kind ?? t?.kind) as PlaybookKind | undefined;
  const scope = input.scope ?? t?.scope;
  if (!kind || !scope) throw new AppError('VALIDATION_FAILED');
  if (kind === 'new_lead_response' && scope !== 'team') throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'NEW_LEAD_RESPONSE_IS_TEAM' }] });
  if (kind === 'voice_answering' && scope !== 'team') throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'VOICE_ANSWERING_IS_TEAM' }] });
  const steps = parseContent(kind, input.steps ?? t?.content ?? t?.steps ?? []);
  const tone = parseTone(input.tone);
  return asUser(deps, actor, async (tx) => {
    const id = deps.ids.next<'PlaybookId'>();
    await P.insertPlaybook(tx, { id, kind, scope, ownerUserId: scope === 'agent' ? actor.userId : null, name: (input.name ?? t?.name ?? 'Playbook').slice(0, 120), templateKey: t?.key ?? null });
    await P.insertVersion(tx, { id: deps.ids.next<'PlaybookVersionId'>(), playbookId: id, versionNo: 1, steps, tone, sha: contentSha256(steps, tone), userId: actor.userId });
    return view(tx, (await P.playbookById(tx, id))!);
  });
}

/**
 * POST /playbooks/:id/versions: edit = a new draft (the approved version keeps running, E31). An
 * existing draft is replaced in place (drafts are not frozen yet).
 */
export async function createVersion(actor: UserActor, playbookId: string, input: { steps: unknown[] | Record<string, unknown>; tone?: unknown }, deps: AssistantDeps): Promise<PlaybookView> {
  const tone = parseTone(input.tone);
  return asUser(deps, actor, async (tx) => {
    const p = await P.playbookById(tx, playbookId, { lock: true });
    if (!p) throw new AppError('NOT_FOUND');
    const steps = parseContent(p.kind, input.steps);
    const versions = await P.versionsOf(tx, [p.id]);
    const last = versions[versions.length - 1];
    const sha = contentSha256(steps, tone);
    if (last && last.status === 'draft') await P.replaceDraft(tx, last.id, { steps, tone, sha });
    else await P.insertVersion(tx, { id: deps.ids.next<'PlaybookVersionId'>(), playbookId: p.id, versionNo: (last?.versionNo ?? 0) + 1, steps, tone, sha, userId: actor.userId });
    return view(tx, p);
  });
}

export interface DecisionInput {
  attestation: string;
  contentSha256: string;
}

/** POST /playbook-versions/:id/approve */
export async function approveVersion(actor: UserActor, versionId: string, input: DecisionInput, deps: AssistantDeps): Promise<PlaybookView> {
  return asUser(deps, actor, async (tx, now) => {
    const peek = await P.versionById(tx, versionId);
    if (!peek) throw new AppError('NOT_FOUND');
    const p = (await P.playbookById(tx, peek.playbookId, { lock: true }))!; // serializes approvals of one playbook
    const v = (await P.versionById(tx, versionId, { lock: true }))!;
    if (v.status === 'approved' && (await P.latestApproval(tx, v.id))?.contentSha256 === input.contentSha256) return view(tx, p); // idempotent re-tap
    if (v.status !== 'draft') throw new AppError('PLAYBOOK_VERSION_NOT_DRAFT', { status: v.status });
    if (v.contentSha256 !== input.contentSha256) throw new AppError('PLAYBOOK_HASH_MISMATCH');
    const issues = await issuesFor(tx, p, v.steps);
    if (issues.length > 0) throw new AppError('PLAYBOOK_INVALID', { issues: issues.slice(0, 20) });
    const previous = await P.approvedVersionOf(tx, p.id);
    await P.insertApproval(tx, { id: deps.ids.next<'PlaybookApprovalId'>(), versionId: v.id, decision: 'approve', userId: actor.userId, role: actor.role, sha: v.contentSha256, attestation: input.attestation, now });
    if (previous) await P.setVersionStatus(tx, previous.id, 'superseded');
    await P.setVersionStatus(tx, v.id, 'approved');
    await audit(tx, actor, { action: 'playbook.approved', entity: { type: 'playbook_version', id: v.id }, reason: previous ? `supersedes:${previous.id}` : 'first_approval' });
    if (previous) {
      await enqueueJob(tx, { queue: 'default', kind: ASSISTANT_JOBS.playbookMigrate, payload: { fromVersionId: previous.id, toVersionId: v.id }, dedupeKey: `${ASSISTANT_JOBS.playbookMigrate}:${previous.id}` });
    }
    return view(tx, p);
  });
}

/** POST /playbook-versions/:id/revoke */
export async function revokeVersion(actor: UserActor, versionId: string, input: DecisionInput, deps: AssistantDeps): Promise<PlaybookView> {
  return asUser(deps, actor, async (tx, now) => {
    const peek = await P.versionById(tx, versionId);
    if (!peek) throw new AppError('NOT_FOUND');
    const p = (await P.playbookById(tx, peek.playbookId, { lock: true }))!;
    const v = (await P.versionById(tx, versionId, { lock: true }))!;
    if (v.status === 'revoked') return view(tx, p);
    if (v.status !== 'approved') throw new AppError('PLAYBOOK_NOT_APPROVED', { status: v.status });
    if (v.contentSha256 !== input.contentSha256) throw new AppError('PLAYBOOK_HASH_MISMATCH');
    await P.insertApproval(tx, { id: deps.ids.next<'PlaybookApprovalId'>(), versionId: v.id, decision: 'revoke', userId: actor.userId, role: actor.role, sha: v.contentSha256, attestation: input.attestation, now });
    await P.setVersionStatus(tx, v.id, 'revoked');
    await audit(tx, actor, { action: 'playbook.revoked', entity: { type: 'playbook_version', id: v.id } });
    await enqueueJob(tx, { queue: 'default', kind: ASSISTANT_JOBS.playbookRevoked, payload: { versionId: v.id }, dedupeKey: `${ASSISTANT_JOBS.playbookRevoked}:${v.id}` });
    return view(tx, p);
  });
}

/** Facts for core.can('playbook.approve'): own (agent playbook of the caller) or a team playbook. */
export async function playbookFacts(tx: Tx, playbookId: string): Promise<{ own: boolean; teamPlaybook: boolean } | null> {
  const r = await sql<{ scope: string; mine: boolean }>`
    SELECT scope, owner_user_id IS NOT DISTINCT FROM app.user_id() AS mine FROM playbooks WHERE tenant_id = app.tenant_id() AND id = ${playbookId}`.execute(tx);
  const x = r.rows[0];
  return x ? { own: x.scope === 'agent' && x.mine, teamPlaybook: x.scope === 'team' } : null;
}

export async function versionPlaybookId(tx: Tx, versionId: string): Promise<string | null> {
  const r = await sql<{ playbook_id: string }>`SELECT playbook_id FROM playbook_versions WHERE tenant_id = app.tenant_id() AND id = ${versionId}`.execute(tx);
  return r.rows[0]?.playbook_id ?? null;
}

// ---- jobs (system actor) ----------------------------------------------------------------------------

/**
 * assistant.playbook_migrate (R-AST-4, E31): live enrollments on the superseded version move to the new
 * approved version at their next step boundary (enrollments.migrateOne): a step message of the old
 * version that has not been dispatched yet is canceled and that step is rebuilt from the new version; a
 * step already sent stays sent. Returns whether more enrollments remain (the handler re-runs at once).
 */
export async function migrateVersionEnrollments(tx: Tx, p: { fromVersionId: string; toVersionId: string }, now: Instant, batch = MIGRATE_BATCH): Promise<{ moved: number; more: boolean }> {
  const to = await P.versionById(tx, p.toVersionId);
  const from = await P.versionById(tx, p.fromVersionId);
  if (!to || !from || to.status !== 'approved') return { moved: 0, more: false };
  // module 26 (R-NURT-1, R-AST-4): a trigger playbook has no enrollments; its firings not built yet move to the
  // new approved version when it still has their step (they are built from the new content), and are skipped
  // visibly otherwise. A firing already built (queued or drafted) stays as it is.
  if (!Array.isArray(to.steps)) return { moved: await migrateTriggerRuns(tx, from.id, to), more: false };
  const list = await P.enrollmentsOnVersion(tx, from.id, batch);
  let moved = 0;
  for (const e of list) {
    await lockContact(tx, e.contactId as ContactId);
    const cur = await P.enrollmentById(tx, e.id, { lock: true });
    if (!cur || cur.versionId !== from.id || (cur.state !== 'active' && cur.state !== 'paused')) continue;
    await migrateOne(tx, cur, to, from, now);
    moved += 1;
  }
  return { moved, more: list.length === batch };
}

/**
 * assistant.playbook_revoked (R-AST-4, E32): every enrollment on the revoked version is paused
 * (`approval_revoked`) and its queued step messages are canceled, under per-contact locks.
 */
async function migrateTriggerRuns(tx: Tx, fromVersionId: string, to: P.VersionRow): Promise<number> {
  const keys = (storedContent(to.steps)?.kind === 'triggers' ? ((to.steps as unknown as { triggers: { stepKey?: unknown }[] }).triggers ?? []) : []).map((t) => String(t.stepKey));
  const moved = await sql`
    UPDATE playbook_step_runs SET playbook_version_id = ${to.id}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND playbook_version_id = ${fromVersionId} AND status = 'scheduled'
       AND message_id IS NULL AND assistant_action_id IS NULL AND step_key = ANY (${keys}::text[])`.execute(tx);
  await sql`
    UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
           trigger_ref = trigger_ref || '{"skip":{"reason":"STEP_REMOVED","text":"The approved playbook no longer has this alert."}}'::jsonb
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND playbook_version_id = ${fromVersionId} AND status = 'scheduled'
       AND message_id IS NULL AND assistant_action_id IS NULL`.execute(tx);
  return Number(moved.numAffectedRows ?? 0n);
}

/**
 * module 26 (R-AST-4, R-GATE-4): the scheduled firings of a revoked trigger version are skipped visibly and
 * their queued messages canceled (the dispatch guard already refuses them from the revoke instant), under the
 * contact lock dispatch takes.
 */
async function stopRevokedTriggerRuns(tx: Tx, versionId: string, batch: number): Promise<number> {
  const r = await sql<{ id: string; contact_id: string; message_id: string | null }>`
    SELECT id, contact_id, message_id FROM playbook_step_runs
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND playbook_version_id = ${versionId} AND status = 'scheduled'
     ORDER BY contact_id, id LIMIT ${batch}`.execute(tx);
  for (const x of r.rows) {
    await lockContact(tx, x.contact_id as ContactId);
    if (x.message_id) await sql`UPDATE messages SET status = 'canceled', status_reason = 'PLAYBOOK_APPROVAL_REVOKED' WHERE tenant_id = app.tenant_id() AND id = ${x.message_id} AND status IN ('queued','scheduled')`.execute(tx);
    await sql`
      UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
             trigger_ref = trigger_ref || '{"skip":{"reason":"APPROVAL_NOT_CURRENT","text":"The playbook approval is no longer current."}}'::jsonb
       WHERE tenant_id = app.tenant_id() AND id = ${x.id} AND status = 'scheduled'`.execute(tx);
  }
  return r.rows.length;
}

export async function pauseRevokedEnrollments(tx: Tx, versionId: string, now: Instant, batch = MIGRATE_BATCH): Promise<{ paused: number; more: boolean }> {
  const triggerRuns = await stopRevokedTriggerRuns(tx, versionId, batch);
  if (triggerRuns > 0) return { paused: triggerRuns, more: triggerRuns === batch };
  const list = await P.enrollmentsToRevoke(tx, versionId, batch);
  let paused = 0;
  for (const e of list) {
    await lockContact(tx, e.contactId as ContactId);
    const cur = await P.enrollmentById(tx, e.id, { lock: true });
    if (!cur || cur.versionId !== versionId) continue;
    const runs = await P.stepRunsOf(tx, cur.id);
    const pending = runs.filter((r) => r.status === 'scheduled');
    await P.cancelStepMessages(tx, pending.map((r) => r.id), 'PLAYBOOK_APPROVAL_REVOKED');
    for (const r of pending) await P.updateStepRun(tx, r.id, { status: 'canceled_paused' });
    if (cur.state === 'active') await P.pauseEnrollment(tx, cur.id, 'approval_revoked', now);
    else await sql`UPDATE playbook_enrollments SET pause_reason = 'approval_revoked' WHERE tenant_id = app.tenant_id() AND id = ${cur.id}`.execute(tx);
    paused += 1;
  }
  return { paused, more: list.length === batch };
}
