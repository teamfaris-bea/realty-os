// GET /contacts/:id/playbook-status (R-STG-4): the automated plan a person is in (or was last in), what it does next,
// why it is not moving, who may pause, resume or stop it, and what the last stage change did. Read-only: both
// transactions are READ ONLY, and nothing is enqueued.
//
//   plan             the live enrollment (active or paused), else the most recent ended one, so a plan that stopped
//                    is still shown with why. `next` is the runner's own next step (assistant/enrollmentStatus.ts:
//                    the planning walk the step runner acts on), never its wake-up time; null when the plan is not
//                    active or the runner would not take a step next. `blocked` is why a paused or stopped plan is
//                    not moving. canPause, canResume and canStop are the pause, resume and stop routes' own
//                    authorization (comms.send on the person, as a marketing send) AND their own state checks
//                    (assistant/enrollments.ts pauseCheck, resumeCheck, stopCheck), read in the viewer's own
//                    transaction: a button is offered exactly when the viewer's request to that route would act.
//   lastStageChange  the person's most recent stage event and its decision row. `pending`: the worker's backup scan
//                    will still decide it (repos.ts pendingStageEvents, the scan's own query): a change made by PATCH
//                    or a bulk action, or one the request path could not decide. A pending change is never reported
//                    as started and never as "nothing happened".
//
// Who sees what: the caller sees the person's detail (the route's permission), and enrollments, stage events and
// decision rows are visible exactly then (their RLS policies). A plan's NAME is shown only when the viewer's own RLS
// shows that playbook (an agent's private plan is "the owner's plan" to a collaborator; planNames.ts).
import { type UserActor, plusMs } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { pauseCheck, resumeCheck, stopCheck } from '../assistant/enrollments.js';
import { enrollmentSendFacts, mayChangeEnrollment, nextStepOf } from '../assistant/enrollmentStatus.js';
import * as P from '../assistant/repos/playbooks.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { SCAN_WINDOW_MS } from './contract.js';
import { HIDDEN_PLAN } from './planNames.js';
import * as R from './repos.js';
import { decisionSentence, pausedSentence, stoppedSentence } from './sentences.js';

export interface PlaybookStatus {
  plan: {
    enrollmentId: string;
    name: string;
    state: 'active' | 'paused' | 'completed' | 'stopped';
    /** how the plan started, and who started it when a person did (a stage change, or enrolling by hand) */
    startedBy: { how: string; userId: string | null; displayName: string | null };
    startedAt: string;
    next: { kind: 'message'; channel: string; dueAt: string } | null;
    blocked: { code: string; sentence: string } | null;
    canPause: boolean;
    canResume: boolean;
    canStop: boolean;
  } | null;
  lastStageChange: {
    eventId: string;
    to: string;
    at: string;
    pending: boolean;
    decision: { outcome: 'started' | 'skipped'; plan: string; reason: string | null; sentence: string } | null;
  } | null;
}

interface ShownEnrollment {
  id: string;
  name: string | null;
  stopReason: string | null;
  enrolledByUserId: string | null;
  startedByName: string | null;
}

/** The enrollment the status shows: the live one, else the most recent. Its playbook's name only as RLS shows it. */
async function shownEnrollment(tx: Tx, contactId: string): Promise<ShownEnrollment | null> {
  const r = await sql<{ id: string; name: string | null; stop_reason: string | null; enrolled_by_user_id: string | null; display_name: string | null }>`
    SELECT e.id, p.name, e.stop_reason, e.enrolled_by_user_id, u.display_name
      FROM playbook_enrollments e
      LEFT JOIN playbooks p ON p.tenant_id = e.tenant_id AND p.id = e.playbook_id
      LEFT JOIN users u ON u.id = e.enrolled_by_user_id
     WHERE e.tenant_id = app.tenant_id() AND e.contact_id = ${contactId}
     ORDER BY (e.state IN ('active','paused')) DESC, e.created_at DESC, e.id DESC LIMIT 1`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, name: x.name, stopReason: x.stop_reason, enrolledByUserId: x.enrolled_by_user_id, startedByName: x.display_name } : null;
}

export async function playbookStatus(db: Database, viewer: UserActor, contactId: string): Promise<PlaybookStatus> {
  // 1. as the viewer (their RLS): the enrollment, what they may do with it, the last stage event and its decision
  const mine = await withTenantTx(
    viewer,
    async (tx) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      const sees = await sql<{ v: boolean }>`SELECT app.contact_detail_visible(c.tenant_id, c.id) AS v FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${contactId}`.execute(tx);
      if (sees.rows[0]?.v !== true) throw new AppError('NOT_FOUND');
      const shown = await shownEnrollment(tx, contactId);
      const e = shown ? await P.enrollmentById(tx, shown.id) : null;
      const may = e ? mayChangeEnrollment(viewer, await enrollmentSendFacts(tx, contactId)) : false;
      const can = e
        ? { pause: may && pauseCheck(e).kind === 'acts', stop: may && stopCheck(e).kind === 'acts', resume: may && (await resumeCheck(tx, e)).kind === 'acts' }
        : { pause: false, stop: false, resume: false };
      const event = await R.latestStageEvent(tx, contactId);
      const decision = event ? await R.decisionOf(tx, event.id) : null;
      return { shown, e, can, event, decision };
    },
    { db },
  );
  // 2. as the system (what the runner and the scan read): the next real step, and whether the scan will still decide
  const sys = await withTenantTx(
    systemActor(viewer.tenantId, 'assistant'),
    async (tx, now) => {
      await sql`SET LOCAL transaction_read_only = on`.execute(tx);
      const next = mine.e ? await nextStepOf(tx, mine.e, now) : null;
      // no decision row for the viewer: either the scan will still write one, or one was written since step 1 (shown
      // on the next read); in both cases the change is not reported as decided
      const undecided = mine.event !== null && mine.decision === null;
      const pending = undecided && ((await R.decisionOf(tx, mine.event!.id)) !== null || (await R.pendingStageEvents(tx, plusMs(now, -SCAN_WINDOW_MS), 1, { eventId: mine.event!.id })).length > 0);
      return { next, pending };
    },
    { db },
  );
  const { shown, e, can, event, decision } = mine;
  const blocked = (): { code: string; sentence: string } | null => {
    if (!e || !shown) return null;
    if (e.state === 'paused') return { code: e.pauseReason ?? 'paused', sentence: pausedSentence(e.pauseReason ?? '') };
    if (e.state === 'stopped') return { code: shown.stopReason ?? 'stopped', sentence: stoppedSentence(shown.stopReason ?? '') };
    return null;
  };
  const decisionPlan = decision?.playbookName ?? HIDDEN_PLAN;
  return {
    plan:
      e && shown
        ? {
            enrollmentId: e.id,
            name: shown.name ?? HIDDEN_PLAN,
            state: e.state,
            startedBy: { how: e.enrolledBy, userId: shown.enrolledByUserId, displayName: shown.startedByName },
            startedAt: new Date(e.createdAt).toISOString(),
            next: sys.next ? { kind: sys.next.kind, channel: sys.next.channel, dueAt: new Date(sys.next.dueAt).toISOString() } : null,
            blocked: blocked(),
            canPause: can.pause,
            canResume: can.resume,
            canStop: can.stop,
          }
        : null,
    lastStageChange: event
      ? {
          eventId: event.id,
          to: event.toStage,
          at: new Date(event.occurredAt).toISOString(),
          pending: sys.pending,
          decision: decision && decision.playbookId !== null ? { outcome: decision.outcome, plan: decisionPlan, reason: decision.reason, sentence: decisionSentence(decision, decisionPlan) } : null,
        }
      : null,
  };
}
