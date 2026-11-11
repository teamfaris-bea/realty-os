// Enrollments and the playbook step runner (ARCHITECTURE §6 playbook.step, §11; R-AST-4, R-AST-8,
// R-AST-9, R-GATE-3, R-GATE-4; E26, E31, E32).
//
// executePlaybookStep runs as the system actor under the contact lock (the same lock inbound ingestion,
// dispatch and the ownership engine take, ARCHITECTURE §10), so a client reply and a step can never
// interleave: either ingestion paused the enrollment first (the step does nothing), or the step queued
// its message first (ingestion cancels it, or — if dispatch already committed — says so in the handback).
// Nothing is sent here: the queued message's comms.dispatch job authorizes and gates it at SEND time.
//
// One live enrollment per contact (DB unique). A human enrolling into another playbook must confirm the
// replacement (core.planEnroll); the system never replaces silently. Pause / stop / resume are human
// actions on the enrollment; resume is human-only (DB guard) and audited. A human never enrolls a person
// the plan cannot reach (B9): the stage entry's rule, through the same function (stageAutomation/reach.ts).
// Nothing ever enrolls a merged-away record (F2: the stage entry's person_removed): not the direct route, not
// the post-closing path, and the step runner stops one that is live anyway.
import { type PlaybookStep, PlaybookStepSchema, migrateEnrollment, planEnroll, planNextStep, type StopCondition } from '@realty/core/assistant';
import type { ContactId, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { plusMs } from '@realty/core/foundation';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { resumeAutomation } from '../comms/repos/automation.js';
import { visibleSurvivorOf } from '../comms/repos/contacts.js';
import { asSystem, asUser } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { reachableForVersion } from '../stageAutomation/reach.js';
import { PLAYBOOK_STEP } from '../worker/contracts.js';
import { enqueueTyped } from '../worker/registry.js';
import { contactCore } from './repos/context.js';
import * as P from './repos/playbooks.js';
import { type Anchor, CHECK_BACK_MS, anchorBelongsTo, anchorFacts, buildStep } from './steps.js';
import type { AssistantDeps, StepOutcome } from './types.js';

const RAN = new Set<P.StepRunRow['status']>(['sent', 'skipped_ineligible', 'converted_to_draft', 'failed', 'canceled_paused']);
const MESSAGE_DONE = new Set(['sent', 'delivered', 'failed', 'undelivered', 'bounced', 'blocked', 'canceled']);
const IN_FLIGHT = new Set(['queued', 'scheduled', 'dispatching', 'dispatch_unknown']);

/** Enqueues the playbook.step job for an enrollment at `dueAt` (the sweeper re-issues lost ones). */
export async function enqueueStep(tx: Tx, enrollmentId: string, dueAt: Instant): Promise<void> {
  const p = { enrollmentId, dueAt };
  await enqueueTyped(tx, PLAYBOOK_STEP, p, { dedupeKey: PLAYBOOK_STEP.dedupeKey(p), runAt: dueAt });
}

async function stopFacts(tx: Tx, contactId: string, enrolledAt: Instant, canceled: boolean): Promise<Set<StopCondition>> {
  const r = await sql<{ booked: boolean; opened: boolean; closed: boolean }>`
    SELECT EXISTS (SELECT 1 FROM appointments a WHERE a.tenant_id = app.tenant_id() AND a.contact_id = ${contactId} AND a.status IN ('scheduled','held')
                    AND a.created_at > ${new Date(enrolledAt).toISOString()}::timestamptz) AS booked,
           EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id = ${contactId} AND d.stage NOT IN ('closed','lost')) AS opened,
           EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id = ${contactId} AND d.stage = 'closed'
                    AND d.closed_at > ${new Date(enrolledAt).toISOString()}::timestamptz) AS closed`.execute(tx);
  const f = r.rows[0];
  const out = new Set<StopCondition>();
  if (f?.booked) out.add('appointment_booked');
  if (f?.opened) out.add('deal_opened');
  if (f?.closed) out.add('deal_closed');
  if (canceled) out.add('event_canceled');
  return out;
}

function parseSteps(raw: readonly unknown[]): PlaybookStep[] | null {
  const out: PlaybookStep[] = [];
  for (const s of raw) {
    const r = PlaybookStepSchema.safeParse(s);
    if (!r.success) return null;
    out.push(r.data);
  }
  return out;
}

/** Moves one live enrollment from a superseded version to the playbook's approved one (R-AST-4). */
export async function migrateOne(tx: Tx, e: P.EnrollmentRow, to: P.VersionRow, from: P.VersionRow, now: Instant): Promise<void> {
  const newSteps = parseSteps(to.steps) ?? [];
  const oldSteps = parseSteps(from.steps) ?? [];
  const runs = await P.stepRunsOf(tx, e.id);
  // A step of the old version whose message dispatch refused because the version had just been superseded
  // (dispatch ran before this migration) did not run: it is rebuilt from the new version (E31).
  const refused = (r: P.StepRunRow) => r.versionId === from.id && r.messageStatus === 'blocked' && r.messageStatusReason === 'PLAYBOOK_NOT_APPROVED';
  const pending = runs.filter((r) => !RAN.has(r.status) || refused(r));
  const canceled = await P.cancelStepMessages(tx, pending.map((r) => r.id), 'PLAYBOOK_VERSION_REPLACED');
  // a pending step whose message already left (dispatching or later) counts as run
  const flying = new Set(pending.filter((r) => r.messageId !== null && !canceled.includes(r.messageId) && !refused(r)).map((r) => r.stepKey));
  for (const r of pending) if (!flying.has(r.stepKey)) await P.updateStepRun(tx, r.id, { status: 'scheduled', messageId: null, actionId: null, versionId: to.id, scheduledFor: now });
  const m = migrateEnrollment({ newSteps, ranStepKeys: new Set([...runs.filter((r) => RAN.has(r.status) && !refused(r)).map((r) => r.stepKey), ...flying]), oldSteps });
  await P.migrateEnrollmentVersion(tx, e.id, to.id, m.currentStep, now);
  // the step boundary is now: a live, active enrollment continues on the new version without waiting for the sweeper
  if (e.state === 'active') await enqueueStep(tx, e.id, now);
}

/**
 * The step runner (job playbook.step). Caller is the system actor; this takes the contact lock.
 * Spec correction (reported): takes the transaction, the clock and the deps explicitly; the BUILD_PLAN
 * signature is `executePlaybookStep` below.
 */
export async function executePlaybookStepInTx(tx: Tx, deps: AssistantDeps, tenantId: string, enrollmentId: string, now: Instant): Promise<StepOutcome> {
  const peek = await P.enrollmentById(tx, enrollmentId);
  if (!peek) return { kind: 'noop', reason: 'ENROLLMENT_MISSING' };
  await lockContact(tx, peek.contactId as ContactId);
  let e = (await P.enrollmentById(tx, enrollmentId, { lock: true }))!;
  if (e.state !== 'active') return { kind: 'noop', reason: 'NOT_ACTIVE' };
  if (e.nextStepDueAt !== null && e.nextStepDueAt > now) return { kind: 'waiting', until: e.nextStepDueAt, reason: 'NOT_DUE' };
  const playbook = await P.playbookById(tx, e.playbookId);
  let version = await P.versionById(tx, e.versionId);
  if (!playbook || !version) return { kind: 'noop', reason: 'PLAYBOOK_MISSING' };
  if (version.status === 'superseded') {
    const to = await P.approvedVersionOf(tx, playbook.id);
    if (!to) return { kind: 'noop', reason: 'NO_APPROVED_VERSION' };
    await migrateOne(tx, e, to, version, now);
    e = (await P.enrollmentById(tx, enrollmentId, { lock: true }))!;
    version = to;
  }
  if (version.status !== 'approved') {
    // revoked: the revocation job pauses it; pausing here too keeps the sweeper from spinning
    await P.pauseEnrollment(tx, e.id, 'approval_revoked', now);
    return { kind: 'noop', reason: 'PLAYBOOK_NOT_APPROVED' };
  }
  const steps = parseSteps(version.steps);
  if (!steps) {
    await P.pauseEnrollment(tx, e.id, 'ineligible', now);
    return { kind: 'noop', reason: 'PLAYBOOK_INVALID' };
  }
  const contact = await contactCore(tx, e.contactId);
  if (!contact || contact.deleted) {
    await P.endEnrollment(tx, e.id, 'stopped', 'contact_removed', now);
    return { kind: 'stopped', reason: 'contact_removed' };
  }
  if (contact.merged) {
    // F2 (R-OWN-24): the person was merged away; the merge stops the loser's enrollment, and one that is live anyway
    // (a race the merge could not see) stops here the same way, before any step is built for the loser
    await P.endEnrollment(tx, e.id, 'stopped', 'merged', now);
    return { kind: 'stopped', reason: 'merged' };
  }
  if (playbook.scope === 'agent' && playbook.ownerUserId !== contact.ownerUserId) {
    // an agent playbook speaks for its agent only (R-AST-8 owner_change; dispatch would refuse it anyway)
    await P.pauseEnrollment(tx, e.id, 'owner_change', now);
    return { kind: 'noop', reason: 'PLAYBOOK_OWNER_NOT_CONTACT_OWNER' };
  }
  const anchor = await anchorFacts(tx, { anchorKind: e.anchorKind, anchorId: e.anchorId, enrolledBy: e.enrolledBy, contactId: e.contactId });
  const runs = await P.stepRunsOf(tx, e.id);
  let current = e.currentStep;
  let previousStepAt: Instant | null = null;
  for (const r of runs) if (RAN.has(r.status) && (previousStepAt === null || r.updatedAt > previousStepAt)) previousStepAt = r.updatedAt;
  const facts = await stopFacts(tx, e.contactId, e.createdAt, anchor.canceled);

  for (let guard = 0; guard <= steps.length + 1; guard++) {
    const step = steps[current];
    const run = step ? runs.find((r) => r.stepKey === step.stepKey) : undefined;
    let existingRunId: string | null = null;
    if (step && run) {
      const messageLeft = run.messageId !== null && run.messageStatus !== null && MESSAGE_DONE.has(run.messageStatus);
      if (RAN.has(run.status) || messageLeft) {
        current += 1;
        previousStepAt = run.updatedAt > (previousStepAt ?? 0) ? run.updatedAt : previousStepAt;
        continue;
      }
      if (run.messageId !== null && IN_FLIGHT.has(run.messageStatus ?? '')) {
        const until = plusMs(run.messageScheduledFor !== null && run.messageScheduledFor > now ? run.messageScheduledFor : now, CHECK_BACK_MS);
        await P.scheduleEnrollment(tx, e.id, until, current);
        return { kind: 'waiting', until, reason: 'MESSAGE_IN_FLIGHT' };
      }
      existingRunId = run.id; // rebuilt after a version migration
    }
    const plan = planNextStep({ state: 'active', steps, currentStep: current, now, anchors: { enrolledAt: e.createdAt, previousStepAt, eventAt: anchor.eventAt }, facts, capabilities: new Set() });
    switch (plan.action) {
      case 'none':
        return { kind: 'noop', reason: plan.reason };
      case 'complete':
        await P.endEnrollment(tx, e.id, 'completed', null, now);
        return { kind: 'completed' };
      case 'stop':
        await P.endEnrollment(tx, e.id, 'stopped', `stop_if:${plan.condition}`, now);
        return { kind: 'stopped', reason: `stop_if:${plan.condition}` };
      case 'wait':
        await P.scheduleEnrollment(tx, e.id, plan.until, current);
        await enqueueStep(tx, e.id, plan.until);
        return { kind: 'waiting', until: plan.until, reason: 'STEP_NOT_DUE' };
      case 'skip': {
        if (existingRunId) await P.updateStepRun(tx, existingRunId, { status: 'skipped_ineligible' });
        else await P.insertStepRun(tx, { id: deps.ids.next<'PlaybookStepRunId'>(), enrollmentId: e.id, versionId: version.id, stepKey: plan.step.stepKey, status: 'skipped_ineligible', scheduledFor: now, actionId: null });
        current += 1;
        previousStepAt = now;
        continue;
      }
      case 'run': {
        const out = await buildStep(tx, deps, tenantId, { enrollment: e, playbook, version, step: plan.step, existingRunId, contact, anchor, now });
        if (out.kind === 'queued') {
          await P.scheduleEnrollment(tx, e.id, plusMs(now, CHECK_BACK_MS), current);
          return out;
        }
        // drafted or skipped: the step is done; the next one is planned on the following pass
        await P.scheduleEnrollment(tx, e.id, now, current + 1);
        await enqueueStep(tx, e.id, plusMs(now, 1_000));
        return out;
      }
    }
  }
  await P.scheduleEnrollment(tx, e.id, plusMs(now, CHECK_BACK_MS), current);
  return { kind: 'waiting', until: plusMs(now, CHECK_BACK_MS), reason: 'LOOP_GUARD' };
}

/** BUILD_PLAN interface: authorize → queue → (comms.dispatch) dispatchOutbound. */
export async function executePlaybookStep(actor: SystemActor, enrollmentId: string, deps: AssistantDeps): Promise<StepOutcome> {
  return withTenantTx(actor, (tx, now) => executePlaybookStepInTx(tx, deps, actor.tenantId, enrollmentId, now), { db: deps.db, retries: 2 });
}

// ---- human enrollment commands ------------------------------------------------------------------------

export interface EnrollmentView {
  id: string;
  playbookId: string;
  versionId: string;
  contactId: string;
  state: string;
  pauseReason: string | null;
  currentStep: number;
  nextStepDueAt: string | null;
}

function viewOf(e: P.EnrollmentRow): EnrollmentView {
  return { id: e.id, playbookId: e.playbookId, versionId: e.versionId, contactId: e.contactId, state: e.state, pauseReason: e.pauseReason, currentStep: e.currentStep, nextStepDueAt: e.nextStepDueAt === null ? null : new Date(e.nextStepDueAt).toISOString() };
}

/** Cancels the not-yet-dispatched step messages of an enrollment the human paused / stopped / replaced (system). */
async function cancelPendingSteps(deps: AssistantDeps, tenantId: string, enrollmentId: string, reason: string): Promise<void> {
  await asSystem(deps, tenantId, 'assistant', async (tx) => {
    const e = await P.enrollmentById(tx, enrollmentId);
    if (!e) return;
    await lockContact(tx, e.contactId as ContactId);
    const runs = (await P.stepRunsOf(tx, enrollmentId)).filter((r) => r.status === 'scheduled');
    const canceled = await P.cancelStepMessages(tx, runs.map((r) => r.id), reason);
    for (const r of runs) if (r.messageId === null || canceled.includes(r.messageId)) await P.updateStepRun(tx, r.id, { status: 'canceled_paused' });
  });
}

export interface EnrollInput {
  playbookId: string;
  confirmReplace?: boolean | undefined;
  anchor?: Anchor | undefined;
}

/** POST /contacts/:id/enrollments */
export async function enrollContact(actor: UserActor, contactId: string, input: EnrollInput, deps: AssistantDeps): Promise<EnrollmentView> {
  const out = await asUser(deps, actor, async (tx, now) => {
    await lockContact(tx, contactId as ContactId);
    const c = await contactCore(tx, contactId);
    if (!c || c.deleted) throw new AppError('NOT_FOUND');
    // F2 (R-OWN-24, R-PAR-16): a merged-away record is never enrolled, as a stage entry skips it (decide.ts
    // person_removed) and the merge stops its own enrollment: one live plan per person, on the record they live on.
    // Refused before anything is read or written; the survivor is named only to whoever sees it.
    if (c.merged) {
      const survivor = await visibleSurvivorOf(tx, contactId);
      throw new AppError('CONTACT_MERGED', { reason: 'person_removed', ...(survivor ? { mergedInto: survivor } : {}) });
    }
    const pb = await P.playbookById(tx, input.playbookId);
    if (!pb || pb.status !== 'active') throw new AppError('NOT_FOUND');
    const v = await P.approvedVersionOf(tx, pb.id);
    // an agent playbook speaks for its agent: only for contacts that agent owns (dispatch re-checks)
    if (pb.scope === 'agent' && pb.ownerUserId !== c.ownerUserId) throw new AppError('PLAYBOOK_OWNER_MISMATCH');
    if (pb.kind === 'new_lead_response') throw new AppError('PLAYBOOK_INVALID', { issues: [{ code: 'NEW_LEAD_RESPONSE_IS_AUTOMATIC' }] });
    // the anchor's details go into this contact's messages: it must be this contact's own event (R-PERM-5: 404)
    if (input.anchor && !(await anchorBelongsTo(tx, contactId, input.anchor))) throw new AppError('NOT_FOUND');
    const live = await P.liveEnrollmentOf(tx, contactId);
    const plan = planEnroll({ live: live ? { enrollmentId: live.id, playbookId: live.playbookId } : null, target: { playbookId: pb.id, versionApproved: v !== null }, confirmedReplace: input.confirmReplace === true });
    if (!plan.ok) {
      if (plan.code === 'PLAYBOOK_INVALID') throw new AppError('PLAYBOOK_NOT_APPROVED');
      if (plan.code === 'ENROLLMENT_REPLACE_NEEDS_CONFIRMATION') throw new AppError('ENROLLMENT_REPLACE_NEEDS_CONFIRMATION', { currentEnrollmentId: plan.currentEnrollmentId, currentPlaybookId: plan.currentPlaybookId });
      throw new AppError('ALREADY_ENROLLED', { enrollmentId: live?.id ?? null });
    }
    // B9 (R-PAR-16, D1): exactly the rule of a stage entry (stageAutomation/decide.ts, skip cannot_be_reached),
    // decided by the same function: some channel this version messages on has an address that no opt-out blocks
    // (core canContact, the removed phones' STOPs included, R-PAR-12). A version with no text or email step is
    // reachable, as there. Checked before anything is written, so a refusal replaces and enrolls nothing.
    if (!(await reachableForVersion(tx, contactId, v!.id, now))) throw new AppError('CANNOT_BE_REACHED', { reason: 'cannot_be_reached', playbookId: pb.id });
    let replaced: string | null = null;
    if (plan.action === 'replace') {
      await P.endEnrollment(tx, plan.stopEnrollmentId, 'stopped', plan.stopReason, now);
      replaced = plan.stopEnrollmentId;
    }
    const id = deps.ids.next<'EnrollmentId'>();
    await P.insertEnrollment(tx, { id, playbookId: pb.id, versionId: v!.id, contactId, enrolledBy: 'user', userId: actor.userId, dueAt: now, anchor: input.anchor ?? null });
    await enqueueStep(tx, id, now);
    await audit(tx, actor, { action: 'enrollment.changed', entity: { type: 'playbook_enrollment', id }, reason: replaced ? `enrolled:replaced:${replaced}` : 'enrolled' });
    return { view: viewOf((await P.enrollmentById(tx, id))!), replaced };
  });
  if (out.replaced) await cancelPendingSteps(deps, actor.tenantId, out.replaced, 'ENROLLMENT_REPLACED');
  return out.view;
}

async function lockedEnrollment(tx: Tx, id: string): Promise<P.EnrollmentRow> {
  const peek = await P.enrollmentById(tx, id);
  if (!peek) throw new AppError('NOT_FOUND');
  await lockContact(tx, peek.contactId as ContactId);
  return (await P.enrollmentById(tx, id, { lock: true }))!;
}

/** POST /enrollments/:id/pause */
export async function pauseEnrollment(actor: UserActor, enrollmentId: string, deps: AssistantDeps): Promise<EnrollmentView> {
  const v = await asUser(deps, actor, async (tx, now) => {
    const e = await lockedEnrollment(tx, enrollmentId);
    if (e.state === 'paused') return viewOf(e);
    if (e.state !== 'active') throw new AppError('ENROLLMENT_NOT_LIVE', { state: e.state });
    await P.pauseEnrollment(tx, e.id, 'manual', now);
    await audit(tx, actor, { action: 'enrollment.changed', entity: { type: 'playbook_enrollment', id: e.id }, reason: 'paused' });
    return viewOf((await P.enrollmentById(tx, e.id))!);
  });
  await cancelPendingSteps(deps, actor.tenantId, enrollmentId, 'ENROLLMENT_PAUSED');
  return v;
}

/** POST /enrollments/:id/stop */
export async function stopEnrollment(actor: UserActor, enrollmentId: string, deps: AssistantDeps): Promise<EnrollmentView> {
  const v = await asUser(deps, actor, async (tx, now) => {
    const e = await lockedEnrollment(tx, enrollmentId);
    if (e.state === 'stopped' || e.state === 'completed') return viewOf(e);
    await P.endEnrollment(tx, e.id, 'stopped', 'manual', now);
    await audit(tx, actor, { action: 'enrollment.changed', entity: { type: 'playbook_enrollment', id: e.id }, reason: 'stopped' });
    return viewOf((await P.enrollmentById(tx, e.id))!);
  });
  await cancelPendingSteps(deps, actor.tenantId, enrollmentId, 'ENROLLMENT_STOPPED');
  return v;
}

/**
 * POST /enrollments/:id/resume: human-only (DB guard) and audited. A client-reply pause also lifts the
 * conversation pause (the agent read the reply). Opt-out, wrong-number and revoked-approval pauses are
 * not resumable here: they have their own paths (the person's own action; a new approval).
 */
export async function resumeEnrollment(actor: UserActor, enrollmentId: string, deps: AssistantDeps): Promise<EnrollmentView> {
  return asUser(deps, actor, async (tx, now) => {
    const e = await lockedEnrollment(tx, enrollmentId);
    if (e.state === 'active') return viewOf(e);
    if (e.state !== 'paused') throw new AppError('ENROLLMENT_NOT_LIVE', { state: e.state });
    const reason = e.pauseReason ?? '';
    if (!['manual', 'owner_change', 'client_reply'].includes(reason)) throw new AppError('ENROLLMENT_NOT_RESUMABLE', { pauseReason: reason });
    const pb = await P.playbookById(tx, e.playbookId);
    const c = await contactCore(tx, e.contactId);
    if (!pb || !c) throw new AppError('NOT_FOUND');
    if (pb.scope === 'agent' && pb.ownerUserId !== c.ownerUserId) throw new AppError('PLAYBOOK_OWNER_MISMATCH');
    if (!(await P.approvedVersionOf(tx, pb.id))) throw new AppError('PLAYBOOK_NOT_APPROVED');
    if (reason === 'client_reply') await resumeAutomation(tx, e.contactId, actor.userId);
    await P.resumeEnrollment(tx, e.id, actor.userId, now);
    await enqueueStep(tx, e.id, now);
    await audit(tx, actor, { action: 'automation.resumed', entity: { type: 'playbook_enrollment', id: e.id }, reason: `resumed:${reason}` });
    return viewOf((await P.enrollmentById(tx, e.id))!);
  });
}

export async function enrollmentContact(tx: Tx, enrollmentId: string): Promise<string | null> {
  return (await P.enrollmentById(tx, enrollmentId))?.contactId ?? null;
}

// ---- post-closing (A4: enrolled at deal close only when approved) ---------------------------------------

/**
 * Enrolls the closed deal's contacts in the owner's (else the team's) approved post_closing playbook,
 * once per deal (anchor), never replacing a live enrollment. Unapproved ⇒ nothing.
 */
export async function enrollOnDealClosedInTx(tx: Tx, deps: AssistantDeps, dealId: string, now: Instant): Promise<string[]> {
  const d = await sql<{ stage: string; primary_contact_id: string }>`SELECT stage, primary_contact_id FROM deals WHERE tenant_id = app.tenant_id() AND id = ${dealId}`.execute(tx);
  const deal = d.rows[0];
  if (!deal || deal.stage !== 'closed') return [];
  const others = await sql<{ contact_id: string }>`SELECT contact_id FROM deal_contacts WHERE tenant_id = app.tenant_id() AND deal_id = ${dealId} ORDER BY contact_id`.execute(tx);
  const contactIds = [...new Set([deal.primary_contact_id, ...others.rows.map((x) => x.contact_id)])].sort();
  const enrolled: string[] = [];
  for (const contactId of contactIds) {
    await lockContact(tx, contactId as ContactId);
    const c = await contactCore(tx, contactId);
    // F2: a merged-away record keeps its deals (a merge moves none) but is never enrolled (decide.ts person_removed)
    if (!c || c.deleted || c.merged) continue;
    const pb = await P.playbookForContact(tx, 'post_closing', c.ownerUserId);
    if (!pb || (pb.scope === 'agent' && pb.ownerUserId !== c.ownerUserId)) continue;
    const v = await P.approvedVersionOf(tx, pb.id);
    if (!v) continue;
    if (await P.hasEnrollmentFor(tx, contactId, { kind: 'deal', id: dealId })) continue;
    if (await P.liveEnrollmentOf(tx, contactId)) continue;
    const id = deps.ids.next<'EnrollmentId'>();
    await P.insertEnrollment(tx, { id, playbookId: pb.id, versionId: v.id, contactId, enrolledBy: 'deal_closed', userId: null, dueAt: now, anchor: { kind: 'deal', id: dealId } });
    await enqueueStep(tx, id, now);
    enrolled.push(id);
  }
  return enrolled;
}

/** BUILD_PLAN-adjacent interface: on deal `closed` (api/workspace enqueues assistant.deal_closed; a scan backs it up). */
export async function enrollOnDealClosed(actor: SystemActor, dealId: string, deps: AssistantDeps): Promise<string[]> {
  return withTenantTx(actor, (tx, now) => enrollOnDealClosedInTx(tx, deps, dealId, now), { db: deps.db, retries: 2 });
}

/** Deals closed in the last 2 days (the scan is idempotent: one enrollment per contact per deal). */
export async function recentlyClosedDeals(tx: Tx, now: Instant): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT id FROM deals WHERE tenant_id = app.tenant_id() AND stage = 'closed' AND closed_at > ${new Date(now).toISOString()}::timestamptz - interval '2 days'
     ORDER BY closed_at LIMIT 200`.execute(tx);
  return r.rows.map((x) => x.id);
}
