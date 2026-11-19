// What a playbook enrollment will do next and who may change it, read-only (R-STG-3, R-STG-4). Used by the stage
// preview (the first step of a plan that would start) and by the contact's playbook status (the next step of the
// running plan, and whether Pause, Resume and Stop are offered). Nothing here writes, sends, queues or enrolls.
//
// "Next" is never the runner's wake-up time (playbook_enrollments.next_step_due_at: after a step is queued that is a
// two-minute check-back). It is the step the runner's own planning ends on: stepWalk.ts walkSteps, the walk the step
// runner acts on, over the same reads (the version's steps, the step runs with their messages, the stop conditions,
// the capabilities). There is no second copy of the planning here.
//
// "May change it" is the pause, resume and stop routes' own authorization: comms.send on the person, as a marketing
// send (assistant/routes.ts enrollmentAuth calls enrollmentSendFacts below), so a TC, who may only send
// informational messages on a deal, is offered none of them.
import { type PlaybookStep, stepDueAt } from '@realty/core/assistant';
import { type Instant, type ResourceFacts, type UserActor, can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { contactFacts } from '../comms/repos/contacts.js';
import { stepCapabilities } from '../nurture/capabilities.js';
import { parseSteps, stopFacts } from './enrollments.js';
import * as P from './repos/playbooks.js';
import { walkSteps } from './stepWalk.js';

/**
 * The facts POST /enrollments/:id/{pause,resume,stop} authorize `comms.send` on: the caller's relation to the
 * enrollment's person (by their own RLS), for a marketing send. Null: the person is not visible to them (404).
 */
export async function enrollmentSendFacts(tx: Tx, contactId: string | null): Promise<ResourceFacts | null> {
  if (!contactId) return null;
  const f = await contactFacts(tx, contactId);
  return f ? { ...f, purpose: 'marketing' } : null;
}

/** Whether those routes would let `actor` through (the same can() on the same facts). */
export function mayChangeEnrollment(actor: UserActor, facts: ResourceFacts | null): boolean {
  return facts !== null && can(actor, 'comms.send', facts).ok;
}

/** The next real step of a plan: what it sends on, and when it is due. */
export interface NextStep {
  /** every playbook step is a message (a text or an email) that is sent, or handed to the agent as a draft */
  kind: 'message';
  channel: PlaybookStep['channel'];
  dueAt: Instant;
}

/**
 * The first step a version would take for this person if a stage entry started it now (enrolled now, no step run
 * yet, no event anchor: reconcile.ts enrolls with `anchor: null`). Null: the walk ends without a step (no step is
 * left after the ones it would skip, or a stop condition already holds). Reads only.
 */
export async function firstStepOfVersion(tx: Tx, contactId: string, versionId: string, now: Instant): Promise<NextStep | null> {
  const version = await P.versionById(tx, versionId);
  const steps = version ? parseSteps(version.steps) : null;
  if (!steps) return null;
  const walk = walkSteps({ steps, runs: [], currentStep: 0, now, enrolledAt: now, eventAt: null, facts: await stopFacts(tx, contactId, now, false), capabilities: await stepCapabilities(tx) });
  if (walk.end.kind === 'wait') return { kind: 'message', channel: walk.end.step.channel, dueAt: walk.end.until };
  // due at once: the planner's own due time for the step (enrolled now, so now or its delay from now)
  if (walk.end.kind === 'run') return { kind: 'message', channel: walk.end.step.channel, dueAt: stepDueAt(walk.end.step, { enrolledAt: now, previousStepAt: walk.skips.length > 0 ? now : null, eventAt: null }) ?? now };
  return null;
}
