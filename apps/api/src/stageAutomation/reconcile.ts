// The stage-entry reconcile (PARITY_PLAN module 67; R-PAR-16, E172, R-PAR-12, D1).
//
// One contact_stage_events row → at most one decision row (stage_automation_decisions, PK per event) and
// at most one enrollment. Called twice for the common case, and both are safe:
//   1. the request path: POST /contacts/:id/stage calls stageChangeAutomation after its transaction commits,
//      so the person who changed the stage is told at once ("Started Buyer plan" or why not);
//   2. the worker: stage_automation.scan finds recent user-made stage events with no decision (a stage set
//      by PATCH /contacts/:id or a bulk stage action, or a request-path crash) and enqueues one
//      stage_automation.reconcile job per event. A bulk action's change carries the action's id (migration
//      0041), and starts no plan while that action's audience is protected (R-PAR-8, protected_audience).
// Under the contact lock (the lock every enrollment path takes) the decision row is read first: when it
// exists, it is the answer; otherwise the facts are read, core-style decideStageEntry decides, and the
// decision and the enrollment are written in the SAME transaction. Two stage changes of one person, two
// playbooks, the request path racing the job: the lock serializes them and the second finds a live
// enrollment (already_in_a_plan) or a later stage (stage_changed_again). The DB backs this up:
// enrollment_one_live (one live enrollment per contact) and playbook_enrollments_guard (approved only).
//
// The enrollment is the existing playbook path: P.insertEnrollment + enqueueStep (as enrollOnDealClosedInTx
// and the bulk enroll do) with enrolled_by = 'stage_change' and a derived id. Nothing is sent here: the
// first step runs as the playbook.step job and its message goes through comms/dispatch.ts at send time,
// where the opt-out gate and the DB dispatch guards decide again.
import type { Actor, ContactId, Instant, Role, SystemActor } from '@realty/core/foundation';
import { type Database, type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import * as P from '../assistant/repos/playbooks.js';
import { enqueueStep } from '../assistant/enrollments.js';
import { stageAudienceProtected } from '../bulk/audience.js';
import { systemActor } from '../worker/systemActor.js';
import { type AutomationOutcome, decideStageEntry, outcomeOf } from './decide.js';
import { stageEnrollmentId } from './ids.js';
import { reachableForVersion } from './reach.js';
import * as R from './repos.js';

export interface StageAutomationDeps {
  db: Database;
}

  return withTenantTx(
    asUser,
    async (tx) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      const r = await sql<{ v: boolean }>`
        SELECT app.contact_detail_visible(c.tenant_id, c.id) AS v FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${who.contactId}`.execute(tx);
      const protectedAudience = who.bulkActionId !== null && (await stageAudienceProtected(tx, who.bulkActionId));
      return { sees: r.rows[0]?.v === true, protectedAudience };
    },
    { db: deps.db },
  );
}

export interface ReconcileResult {
  /** what the person who changed the stage is told */
  automation: AutomationOutcome;
  /** this call wrote the decision (false: it existed, or nothing applied) */
  decided: boolean;
  enrollmentId: string | null;
}

/**
 * Decides one stage event in `tx` (the tenant's system actor). `view` is what the stage-changer sees, read BEFORE
 * this transaction took the contact lock (a separate read-only transaction as that user).
 */
export async function reconcileStageEventInTx(tx: Tx, actor: SystemActor, eventId: string, view: ChangerView, now: Instant): Promise<ReconcileResult> {
  const e = await R.stageEvent(tx, eventId);
  if (!e) return { automation: null, decided: false, enrollmentId: null };
  await lockContact(tx, e.contactId as ContactId);
  const prior = await R.decisionOf(tx, eventId);
  if (prior) return { automation: outcomeOf(prior), decided: false, enrollmentId: prior.enrollmentId };
  if (e.actorKind === 'user' && (await R.isMergeCopy(tx, e.id))) return { automation: null, decided: false, enrollmentId: null };

  const contact = await R.contactRow(tx, e.contactId);
  const candidates = await R.candidatePlaybooks(tx, e.id, contact.ownerUserId);
  if (candidates.length === 0) return { automation: null, decided: false, enrollmentId: null };
  const live = (await P.liveEnrollmentOf(tx, e.contactId)) !== null;
  const sees = view.sees;
  // R-PAR-8 (batch 5 review F1): a change a bulk action made is judged on that action's audience as it is now
  const protectedAudience = e.bulkActionId !== null && view.protectedAudience;
  // reachability is read for the playbook decide would choose (the same choice, computed first)
  const pre = decideStageEntry({ actorKind: e.actorKind, protectedAudience, toStage: e.toStage, contact, changerSeesDetail: sees, candidates, liveEnrollment: live, reachable: true });
  const reachable = pre.kind === 'start' ? await reachableForVersion(tx, e.contactId, pre.versionId, now) : true;
  const d = decideStageEntry({ actorKind: e.actorKind, protectedAudience, toStage: e.toStage, contact, changerSeesDetail: sees, candidates, liveEnrollment: live, reachable });

  if (d.kind === 'none') return { automation: null, decided: false, enrollmentId: null };
  if (d.kind === 'skip') {
    await R.insertDecision(tx, { stageEventId: e.id, contactId: e.contactId, toStage: e.toStage, outcome: 'skipped', reason: d.reason, playbookId: d.playbook.id, enrollmentId: null });
    return { automation: { skipped: d.reason, plan: d.playbook.name }, decided: true, enrollmentId: null };
  }
  const id = stageEnrollmentId(e.id);
  await P.insertEnrollment(tx, { id, playbookId: d.playbook.id, versionId: d.versionId, contactId: e.contactId, enrolledBy: 'stage_change', userId: e.actorUserId, dueAt: now, anchor: null });
  await enqueueStep(tx, id, now);
  await R.insertDecision(tx, { stageEventId: e.id, contactId: e.contactId, toStage: e.toStage, outcome: 'started', reason: null, playbookId: d.playbook.id, enrollmentId: id });
  await audit(tx, actor, { action: 'enrollment.changed', entity: { type: 'playbook_enrollment', id }, reason: `enrolled:stage_change:${e.id}` });
  return { automation: { started: d.playbook.name }, decided: true, enrollmentId: id };
}

/** Who changed the stage, as the system reads it (null: no person made it, or the member is gone). */
export async function stageChangerOf(tx: Tx, eventId: string): Promise<{ userId: string; role: string; contactId: string; bulkActionId: string | null } | null> {
  const e = await R.stageEvent(tx, eventId);
  if (!e || e.actorKind !== 'user' || e.actorUserId === null) return null;
  const m = await R.memberOf(tx, e.actorUserId);
  return m && m.active ? { userId: e.actorUserId, role: m.role, contactId: e.contactId, bulkActionId: e.bulkActionId } : null;
}

/**
 * Decides one stage event in three SEQUENTIAL transactions, never nested (a nested second connection
 * per call would starve the pool under load): (1) the system reads who changed the stage, (2) a read-only
 * transaction as that person reads whether they still see the person (and, for their bulk action's change,
 * whether its audience is protected), (3) the system decides under the contact lock. `withTx` opens a
 * transaction as the tenant's system actor (the worker's ctx.withTx).
 */
export async function reconcileWith(deps: StageAutomationDeps, actor: SystemActor, withTx: <T>(fn: (tx: Tx, now: Instant) => Promise<T>) => Promise<T>, eventId: string): Promise<ReconcileResult> {
  const who = await withTx((tx) => stageChangerOf(tx, eventId));
  // nobody to ask (no person made it, or they are gone): nothing is seen, so no plan starts (not_visible)
  const view: ChangerView = who ? await changerView(deps, actor.tenantId, who) : { sees: false, protectedAudience: false };
  return withTx((tx, now) => reconcileStageEventInTx(tx, actor, eventId, view, now));
}

/** Decides one stage event (the request path after its commit). */
export async function reconcileStageEvent(deps: StageAutomationDeps, tenantId: string, eventId: string): Promise<ReconcileResult> {
  const actor = systemActor(tenantId, 'assistant');
  return reconcileWith(deps, actor, (fn) => withTenantTx(actor, fn, { db: deps.db, retries: 2 }), eventId);
}
