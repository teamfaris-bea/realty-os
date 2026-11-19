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
import { type AutomationOutcome, type StageDecision, type StageEntryFacts, type UnreachableCause, decideStageEntry, outcomeOf } from './decide.js';
import { stageEnrollmentId } from './ids.js';
import { aiIsaLive } from '../isa/liveCare.js';
import { noAutomatedContact } from '../leads/automatedContact.js';
import { reachOfVersion } from './reach.js';
import * as R from './repos.js';

export interface StageAutomationDeps {
  db: Database;
}

/** What the person who changed the stage sees now, by THEIR OWN RLS. */
export interface ChangerView {
  /** they still see the person's detail (R-PAR-16) */
  sees: boolean;
  /** the change was made by their bulk action, and its audience is built from a protected tag now (R-PAR-8) */
  protectedAudience: boolean;
}

/**
 * Read-only, as the person who changed the stage: do they still see this person (R-PAR-16)? And for a change their
 * bulk stage action made (the history names it only for its own creator, migration 0041), is that action's audience
 * protected now (R-PAR-8, batch 5 review F1: the tags its draft recorded and its saved list's plan, read as the
 * creator, who can read their own personal list; bulk/audience.ts)?
 */
export async function changerView(deps: StageAutomationDeps, tenantId: string, who: { userId: string; role: string; contactId: string; bulkActionId: string | null }): Promise<ChangerView> {
  const asUser: Actor = { kind: 'user', userId: who.userId as never, tenantId: tenantId as never, role: who.role as Role, sessionId: 'stage-automation-check' };
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

/** What a stage entry is decided about: a stage event that happened (the reconcile), or one that would (the preview). */
export interface EntrySubject {
  contactId: string;
  toStage: string;
  /** who changed the stage (contact_stage_events.actor_kind); a preview is always a person asking */
  actorKind: R.StageEventRow['actorKind'];
  /** the change was made by a bulk action (judged on that action's audience, R-PAR-8); never true of a preview */
  bulk: boolean;
  /** the stage event is marked as an undo (R-STG-5; repos.ts StageEventRow.undoOfEventId); never true of a preview */
  undo: boolean;
  /**
   * Which playbooks could cover the entry: for an event, the active ones naming its stage as they were configured
   * when the stage was entered; for a preview, the active ones naming the stage now (the entry would happen now).
   */
  playbooksOf: { eventId: string } | { stage: string };
  /**
   * Preview only: the person is read as already in `toStage`, because the change has not happened yet. For an event
   * this is false and the person's stored stage decides (an Undo or a later change wins: stage_changed_again).
   */
  assumeEntered: boolean;
}

/**
 * The facts of one stage entry, read in `tx` as the tenant's system actor: THE one reader (R-STG-3). `view` is what
 * the person who changed (or would change) the stage sees by their own RLS (changerView). Null: no active playbook
 * names the stage, so nothing applies and nothing else is read. This function only reads.
 */
export async function readEntryFacts(tx: Tx, s: EntrySubject, view: ChangerView, now: Instant): Promise<StageEntryFacts | null> {
  const row = await R.contactRow(tx, s.contactId);
  const candidates = await R.candidatePlaybooks(tx, s.playbooksOf, row.ownerUserId);
  if (candidates.length === 0) return null;
  const contact = s.assumeEntered && row.exists ? { ...row, stage: s.toStage } : row;
  const live = (await P.liveEnrollmentOf(tx, s.contactId)) !== null;
  // R-ISA-2 (b12 review B12X-4): under live AI care the plan is skipped and the decision recorded, so the stage change
  // says so and the scan stops retrying (0080's enrollment guard would roll the whole decision back)
  const aiIsaActive = await aiIsaLive(tx, s.contactId);
  // b18 review B18S-5: a person a source marked "No automated contact for leads from this source" sent gets no plan;
  // R-LSRC-9: nor does an imported person whose source the Owner has not reviewed yet (the skip names which)
  const sourceRefusal = await noAutomatedContact(tx, s.contactId);
  const sees = view.sees;
  // R-PAR-8 (batch 5 review F1): a change a bulk action made is judged on that action's audience as it is now
  const protectedAudience = s.bulk && view.protectedAudience;
  // reachability is read for the playbook decide would choose (the same choice, computed first)
  const undo = s.undo;
  const pre = decideStageEntry({ actorKind: s.actorKind, undo, protectedAudience, toStage: s.toStage, contact, changerSeesDetail: sees, candidates, liveEnrollment: live, reachable: true, aiIsaActive, sourceRefusal });
  // E787: with why, when the answer is no (kept with the decision; the decision itself reads only `reachable`)
  const reach = pre.kind === 'start' ? await reachOfVersion(tx, s.contactId, pre.versionId, now) : { reachable: true, cause: null };
  return { actorKind: s.actorKind, undo, protectedAudience, toStage: s.toStage, contact, changerSeesDetail: sees, candidates, liveEnrollment: live, reachable: reach.reachable, unreachableCause: reach.cause, aiIsaActive, sourceRefusal };
}

/**
 * THE decision of one stage entry (R-STG-3): the facts from readEntryFacts, decided by the pure decideStageEntry. The
 * reconcile calls it under the contact lock and then writes what it says; the preview calls it in a read-only
 * transaction and writes nothing. Neither decides any other way, so a preview cannot disagree with the change on the
 * same facts. It only reads.
 */
export async function decideEntry(tx: Tx, s: EntrySubject, view: ChangerView, now: Instant): Promise<StageDecision> {
  return (await decideEntryWithCause(tx, s, view, now)).d;
}

/**
 * decideEntry, with the detail of a `cannot_be_reached` skip (E787): which cause the facts showed. The cause is null
 * for every other decision. The reconcile stores it with the decision row; the preview words it. It is read with the
 * facts the decision was made on, never afterwards.
 */
export async function decideEntryWithCause(tx: Tx, s: EntrySubject, view: ChangerView, now: Instant): Promise<{ d: StageDecision; cause: UnreachableCause | null }> {
  const f = await readEntryFacts(tx, s, view, now);
  if (f === null) return { d: { kind: 'none' }, cause: null };
  const d = decideStageEntry({ actorKind: f.actorKind, undo: f.undo === true, protectedAudience: f.protectedAudience, toStage: f.toStage, contact: f.contact, changerSeesDetail: f.changerSeesDetail, candidates: f.candidates, liveEnrollment: f.liveEnrollment, reachable: f.reachable, aiIsaActive: f.aiIsaActive, sourceRefusal: f.sourceRefusal });
  return { d, cause: d.kind === 'skip' && d.reason === 'cannot_be_reached' ? (f.unreachableCause ?? null) : null };
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

  // decided by the one function the preview decides with (decideEntry: readEntryFacts, then the pure
  // decideStageEntry), so a preview cannot disagree with what the change then does (R-STG-3)
  const { d, cause } = await decideEntryWithCause(tx, { contactId: e.contactId, toStage: e.toStage, actorKind: e.actorKind, bulk: e.bulkActionId !== null, undo: e.undoOfEventId !== null, playbooksOf: { eventId: e.id }, assumeEntered: false }, view, now);

  if (d.kind === 'none') return { automation: null, decided: false, enrollmentId: null };
  if (d.kind === 'skip') {
    await R.insertDecision(tx, { stageEventId: e.id, contactId: e.contactId, toStage: e.toStage, outcome: 'skipped', reason: d.reason, playbookId: d.playbook.id, enrollmentId: null, unreachableCause: cause });
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
