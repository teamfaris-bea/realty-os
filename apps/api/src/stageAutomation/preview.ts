// The plan part of GET /contacts/:id/stage/preview (R-STG-3): what entering a stage would start, not start or leave
// running, for the person asking, BEFORE they save the change. Read-only, and it cannot disagree with the change:
//
//   - the decision is reconcile.ts decideEntry (here with its cause, decideEntryWithCause: E787), the one function
//     the reconcile decides a real stage event with
//     (readEntryFacts, then the pure decideStageEntry). The preview only describes an entry that has not happened: a
//     person would make it (never an import or a bulk action), now, so the playbooks are the ones naming the stage
//     now and the person is read as already in that stage. Everything else (who sees the person, the live
//     enrollment, AI care, the source restrictions, opt-outs and reachability, approval) is read exactly as the
//     reconcile reads it, as the tenant's system actor;
//   - the system transaction is READ ONLY (the database refuses a write in it), and nothing is enqueued: no decision
//     row, no enrollment, no job, no message, no audit row;
//   - a plan's name is shown only to a viewer whose own RLS shows that playbook (planNames.ts);
//   - `canStop` is the stop route's own authorization (assistant/enrollmentStatus.ts).
//
// A stage change never stops a plan (reconcile.ts only ever inserts), so a running plan is reported as kept, with
// whether this viewer may stop it themselves. Nothing here is a touch.
import type { UserActor } from '@realty/core/foundation';
import { type Database, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { enrollmentSendFacts, firstStepOfVersion, mayChangeEnrollment } from '../assistant/enrollmentStatus.js';
import * as P from '../assistant/repos/playbooks.js';
import { systemActor } from '../worker/systemActor.js';
import type { SkipReason, StageDecision } from './decide.js';
import { HIDDEN_PLAN, visiblePlaybookIds } from './planNames.js';
import { changerView, decideEntryWithCause } from './reconcile.js';
import { skipSentence } from './sentences.js';

export interface EntryPreview {
  /** the plan the entry would start, and its first step (null: the plan has no step it would run for this person) */
  starts: { plan: string; firstStep: { channel: string; dueAt: string } | null } | null;
  /**
   * The plan the entry names but would not start, and why (the reason the decision row would carry). `alreadyIn`:
   * when the reason is that the person is already in a plan, that plan (its name as the viewer may see it); the
   * sentence then names it and says the new plan will not start. Null for every other reason.
   */
  wontStart: { plan: string; reason: SkipReason; sentence: string; alreadyIn: { enrollmentId: string; plan: string } | null } | null;
  /** the plan the person is in now: a stage change leaves it running (or paused) */
  keepsRunning: { enrollmentId: string; plan: string; state: 'active' | 'paused'; canStop: boolean } | null;
}

/**
 * `to`: the stage the viewer would enter, or null when the change itself would not happen (the stage rule refuses
 * it, or the person is already in that stage): then no entry is decided and only the running plan is reported.
 */
export async function previewStageEntry(db: Database, viewer: UserActor, contactId: string, to: string | null): Promise<EntryPreview> {
  // what the person asking sees by their own RLS (the reconcile asks the same of whoever changed the stage)
  const view = to === null ? null : await changerView({ db }, viewer.tenantId, { userId: viewer.userId, role: viewer.role, contactId, bulkActionId: null });
  const read = await withTenantTx(
    systemActor(viewer.tenantId, 'assistant'),
    async (tx, now) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      // E787: with the cause of a "cannot be reached", read with these same facts
      const { d, cause }: { d: StageDecision; cause: string | null } =
        to === null || view === null ? { d: { kind: 'none' }, cause: null } : await decideEntryWithCause(tx, { contactId, toStage: to, actorKind: 'user', bulk: false, undo: false, playbooksOf: { stage: to }, assumeEntered: true }, view, now);
      const firstStep = d.kind === 'start' ? await firstStepOfVersion(tx, contactId, d.versionId, now) : null;
      const live = await P.liveEnrollmentOf(tx, contactId);
      const livePlan = live ? await P.playbookById(tx, live.playbookId) : null;
      return { d, cause, firstStep, live, livePlan };
    },
    { db },
  );
  const { d, cause, firstStep, live, livePlan } = read;
  const ids = [...(d.kind === 'none' ? [] : [d.playbook.id]), ...(live ? [live.playbookId] : [])];
  const mine = await withTenantTx(
    viewer,
    async (tx) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      return { visible: await visiblePlaybookIds(tx, ids), canStop: live ? mayChangeEnrollment(viewer, await enrollmentSendFacts(tx, contactId)) : false };
    },
    { db },
  );
  const nameOf = (p: { id: string; name: string } | null) => (p !== null && mine.visible.has(p.id) ? p.name : HIDDEN_PLAN);
  // E763: the plan that keeps the new one from starting is the live enrollment the decision itself read
  const alreadyIn = d.kind === 'skip' && d.reason === 'already_in_a_plan' && live ? { enrollmentId: live.id, plan: nameOf(livePlan) } : null;
  return {
    starts: d.kind === 'start' ? { plan: nameOf(d.playbook), firstStep: firstStep ? { channel: firstStep.channel, dueAt: new Date(firstStep.dueAt).toISOString() } : null } : null,
    wontStart: d.kind === 'skip' ? { plan: nameOf(d.playbook), reason: d.reason, sentence: skipSentence(d.reason, nameOf(d.playbook), 'will', alreadyIn?.plan, cause), alreadyIn } : null,
    keepsRunning: live && (live.state === 'active' || live.state === 'paused') ? { enrollmentId: live.id, plan: nameOf(livePlan), state: live.state, canStop: mine.canStop } : null,
  };
}

/**
 * The plan the person is in now, for this viewer (R-STG-5: what an undo leaves as it was): its enrollment, its name as
 * the viewer may see it, its state (E782: a paused plan is not "still running"), and whether the stop route would let
 * them stop it. Null: no live plan. Read-only.
 */
export async function runningPlan(db: Database, viewer: UserActor, contactId: string): Promise<{ enrollmentId: string; plan: string; state: 'active' | 'paused'; canStop: boolean } | null> {
  const k = (await previewStageEntry(db, viewer, contactId, null)).keepsRunning;
  return k ? { enrollmentId: k.enrollmentId, plan: k.plan, state: k.state, canStop: k.canStop } : null;
}
