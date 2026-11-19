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
import { noAutomatedContact } from '../leads/automatedContact.js';
import { parseSteps, stopFacts } from './enrollments.js';
import { contactCore } from './repos/context.js';
import * as P from './repos/playbooks.js';
import { walkSteps } from './stepWalk.js';
import { anchorFacts } from './steps.js';

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

/**
 * The next real step of a running enrollment, by the runner's own planning walk over the runner's own reads, or null
 * when the runner would not take a step next: the plan is not active, its steps are done, a stop condition holds, or
 * one of the checks the runner makes before planning would end, pause or move the plan first (the person is gone or
 * merged, a source restriction applies, the version is no longer the approved one, the plan no longer speaks for the
 * person's owner). In those cases this says nothing rather than guess. Read as the system actor (as the runner
 * reads), in a transaction the caller made read-only. Reads only.
 */
export async function nextStepOf(tx: Tx, e: P.EnrollmentRow, now: Instant): Promise<NextStep | null> {
  if (e.state !== 'active') return null;
  if ((await noAutomatedContact(tx, e.contactId)) !== null) return null;
  const playbook = await P.playbookById(tx, e.playbookId);
  const version = await P.versionById(tx, e.versionId);
  if (!playbook || !version || version.status !== 'approved') return null;
  const steps = parseSteps(version.steps);
  if (!steps) return null;
  const contact = await contactCore(tx, e.contactId);
  if (!contact || contact.deleted || contact.merged) return null;
  if (playbook.scope === 'agent' && playbook.ownerUserId !== contact.ownerUserId) return null;
  const anchor = await anchorFacts(tx, { anchorKind: e.anchorKind, anchorId: e.anchorId, enrolledBy: e.enrolledBy, contactId: e.contactId });
  const runs = await P.stepRunsOf(tx, e.id);
  const walk = walkSteps({ steps, runs, currentStep: e.currentStep, now, enrolledAt: e.createdAt, eventAt: anchor.eventAt, facts: await stopFacts(tx, e.contactId, e.createdAt, anchor.canceled), capabilities: await stepCapabilities(tx) });
  const end = walk.end;
  // its message is queued, scheduled, being sent or unconfirmed: that step is what is next, due when the message is
  if (end.kind === 'in_flight') return { kind: 'message', channel: end.step.channel, dueAt: end.run.messageScheduledFor ?? end.run.scheduledFor };
  if (end.kind === 'wait') return { kind: 'message', channel: end.step.channel, dueAt: end.until };
  // due now: the runner builds it on its next pass
  if (end.kind === 'run') return { kind: 'message', channel: end.step.channel, dueAt: now };
  return null;
}
