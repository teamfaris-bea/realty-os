// The playbook runner's planning as one pure walk (R-STG-4). The step runner (enrollments.ts executePlaybookStepInTx)
// acts on what this returns, and the read-only "what is next" of a contact's playbook status and of the stage preview
// (enrollmentStatus.ts) reads the same result and writes nothing. So the status can only ever name the step the
// runner would really take next: there is no second copy of "which step is next, and when".
//
// The walk starts at the enrollment's current step and goes forward:
//   - a step that already ran (its run row says so, or its message left: sent, delivered, failed, blocked, canceled …)
//     is passed, and the time it ran becomes the anchor of a `previous_step` delay;
//   - a step whose message is queued, scheduled, being sent, or could not be confirmed delivered is IN FLIGHT: the
//     walk ends there (the runner looks again after CHECK_BACK_MS; nothing is sent twice);
//   - otherwise core planNextStep decides for that step: wait until it is due, run it, skip it (a capability is off,
//     its event is missing or passed: the runner marks it skipped and the walk goes on), stop the plan (a stop
//     condition holds), or complete it (no step is left).
// Pure: the runs, stop facts and capabilities are read by the caller (the runner under the contact lock).
import { type Capability, type PlaybookStep, type StopCondition, planNextStep } from '@realty/core/assistant';
import { type Instant, plusMs } from '@realty/core/foundation';
import type { StepRunRow } from './repos/playbooks.js';
import { CHECK_BACK_MS } from './steps.js';

/** A step run in one of these states has run (whatever came of it). */
export const RAN = new Set<StepRunRow['status']>(['sent', 'skipped_ineligible', 'converted_to_draft', 'failed', 'canceled_paused']);
/** A step's message in one of these states has left the queue for good: the step counts as run. */
export const MESSAGE_DONE = new Set(['sent', 'delivered', 'failed', 'undelivered', 'bounced', 'blocked', 'canceled']);
/** A step's message in one of these states is on its way (or its delivery is not confirmed): the step is in flight. */
export const IN_FLIGHT = new Set(['queued', 'scheduled', 'dispatching', 'dispatch_unknown']);

export interface StepWalkInput {
  steps: readonly PlaybookStep[];
  /** the enrollment's step runs with their messages' statuses (repos/playbooks.ts stepRunsOf) */
  runs: readonly StepRunRow[];
  currentStep: number;
  now: Instant;
  enrolledAt: Instant;
  /** the event the plan hangs off (appointment start, closing date …), or null */
  eventAt: Instant | null;
  /** the stop conditions that hold now */
  facts: ReadonlySet<StopCondition>;
  capabilities: ReadonlySet<Capability>;
}

export type StepWalkEnd =
  /** the step's message is queued, scheduled, being sent or unconfirmed: look again at `until` */
  | { kind: 'in_flight'; step: PlaybookStep; run: StepRunRow; until: Instant }
  /** the step is not due yet */
  | { kind: 'wait'; step: PlaybookStep; until: Instant }
  /** the step is due: build it (`existingRunId`: its run row is rebuilt after a version change) */
  | { kind: 'run'; step: PlaybookStep; existingRunId: string | null }
  /** a stop condition of the step holds: the plan stops */
  | { kind: 'stop'; condition: StopCondition }
  /** no step is left */
  | { kind: 'complete' }
  | { kind: 'none'; reason: 'NOT_ACTIVE' }
  /** more steps were passed than the plan has (cannot happen; the runner checks back later) */
  | { kind: 'loop_guard' };

export interface StepWalk {
  /** steps the runner marks `skipped_ineligible` on the way, in order (`existingRunId`: the run row to mark) */
  skips: { step: PlaybookStep; existingRunId: string | null }[];
  /** the index the walk ended on (the enrollment's current step from here on) */
  current: number;
  end: StepWalkEnd;
}

export function walkSteps(i: StepWalkInput): StepWalk {
  const skips: StepWalk['skips'] = [];
  let current = i.currentStep;
  let previousStepAt: Instant | null = null;
  for (const r of i.runs) if (RAN.has(r.status) && (previousStepAt === null || r.updatedAt > previousStepAt)) previousStepAt = r.updatedAt;

  for (let guard = 0; guard <= i.steps.length + 1; guard++) {
    const step = i.steps[current];
    const run = step ? i.runs.find((r) => r.stepKey === step.stepKey) : undefined;
    let existingRunId: string | null = null;
    if (step && run) {
      const messageLeft = run.messageId !== null && run.messageStatus !== null && MESSAGE_DONE.has(run.messageStatus);
      if (RAN.has(run.status) || messageLeft) {
        current += 1;
        previousStepAt = run.updatedAt > (previousStepAt ?? 0) ? run.updatedAt : previousStepAt;
        continue;
      }
      if (run.messageId !== null && IN_FLIGHT.has(run.messageStatus ?? '')) {
        const until = plusMs(run.messageScheduledFor !== null && run.messageScheduledFor > i.now ? run.messageScheduledFor : i.now, CHECK_BACK_MS);
        return { skips, current, end: { kind: 'in_flight', step, run, until } };
      }
      existingRunId = run.id; // rebuilt after a version migration
    }
    const plan = planNextStep({ state: 'active', steps: i.steps, currentStep: current, now: i.now, anchors: { enrolledAt: i.enrolledAt, previousStepAt, eventAt: i.eventAt }, facts: i.facts, capabilities: i.capabilities });
    switch (plan.action) {
      case 'none':
        return { skips, current, end: { kind: 'none', reason: plan.reason } };
      case 'complete':
        return { skips, current, end: { kind: 'complete' } };
      case 'stop':
        return { skips, current, end: { kind: 'stop', condition: plan.condition } };
      case 'wait':
        // planNextStep waits only on a step that exists
        return { skips, current, end: { kind: 'wait', step: step!, until: plan.until } };
      case 'skip':
        skips.push({ step: plan.step, existingRunId });
        current += 1;
        previousStepAt = i.now;
        continue;
      case 'run':
        return { skips, current, end: { kind: 'run', step: plan.step, existingRunId } };
    }
  }
  return { skips, current, end: { kind: 'loop_guard' } };
}
