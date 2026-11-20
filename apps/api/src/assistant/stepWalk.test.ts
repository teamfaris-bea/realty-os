// The playbook runner's planning walk as a pure function (R-STG-4): the step runner and the read-only "what is next"
// of a contact's playbook status both use it, so the status can only name the step the runner would really take.
import { type PlaybookStep, PlaybookStepSchema } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import type { StepRunRow } from './repos/playbooks.js';
import { walkSteps } from './stepWalk.js';
import { CHECK_BACK_MS } from './steps.js';
import { smsStep } from './testing.js';

const NOW = 1_800_000_000_000 as Instant;
const DAY = 86_400_000;
const at = (ms: number) => (NOW + ms) as Instant;

function step(key: string, o: { anchor?: 'enrollment' | 'previous_step' | 'event'; offsetSeconds?: number; stopIf?: string[]; requires?: string[] } = {}): PlaybookStep {
  const raw = { ...smsStep({ key, category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in.', slots: ['first_name'], anchor: o.anchor ?? 'previous_step', offsetSeconds: o.offsetSeconds ?? 0, stopIf: o.stopIf ?? [] }), ...(o.requires ? { requires: o.requires } : {}) };
  return PlaybookStepSchema.parse(raw);
}
function run(stepKey: string, o: Partial<StepRunRow> = {}): StepRunRow {
  return { id: `run-${stepKey}`, enrollmentId: 'e1', versionId: 'v1', stepKey, status: 'sent', scheduledFor: at(-DAY), messageId: null, messageStatus: null, messageStatusReason: null, messageScheduledFor: null, actionId: null, updatedAt: at(-DAY), ...o };
}
const base = { now: NOW, enrolledAt: at(-2 * DAY), eventAt: null, facts: new Set<never>(), capabilities: new Set<never>(), currentStep: 0 };

describe('walkSteps: the runner\'s planning, with no writes (R-STG-4)', () => {
  it('R-STG-4 a first step that is due runs; nothing is skipped on the way', () => {
    const w = walkSteps({ ...base, steps: [step('a'), step('b', { offsetSeconds: 3 * 86_400 })], runs: [] });
    expect(w.skips).toEqual([]);
    expect(w.current).toBe(0);
    expect(w.end).toMatchObject({ kind: 'run', existingRunId: null, step: { stepKey: 'a' } });
  });

  it('R-STG-4 after a step ran, the next real step is the following one, due its delay after the step before it (not the runner\'s check-back)', () => {
    const steps = [step('a'), step('b', { offsetSeconds: 3 * 86_400 })];
    const w = walkSteps({ ...base, steps, runs: [run('a', { updatedAt: at(-DAY) })] });
    expect(w.current).toBe(1);
    expect(w.end).toEqual({ kind: 'wait', step: steps[1], until: at(-DAY + 3 * DAY) });
  });

  it('R-STG-4 a step whose message is queued or being sent is the next step: in flight, looked at again after the check-back', () => {
    const steps = [step('a'), step('b', { offsetSeconds: 3 * 86_400 })];
    const queued = run('a', { status: 'scheduled', messageId: 'm1', messageStatus: 'queued', messageScheduledFor: null });
    const w = walkSteps({ ...base, steps, runs: [queued] });
    expect(w.current).toBe(0);
    expect(w.end).toEqual({ kind: 'in_flight', step: steps[0], run: queued, until: at(CHECK_BACK_MS) });
    // a message scheduled for later is checked after its own time
    const later = run('a', { status: 'scheduled', messageId: 'm1', messageStatus: 'scheduled', messageScheduledFor: at(3_600_000) });
    expect(walkSteps({ ...base, steps, runs: [later] }).end).toMatchObject({ kind: 'in_flight', until: at(3_600_000 + CHECK_BACK_MS) });
    // one whose delivery could not be confirmed is still in flight (never counted as sent)
    const unknown = run('a', { status: 'scheduled', messageId: 'm1', messageStatus: 'dispatch_unknown' });
    expect(walkSteps({ ...base, steps, runs: [unknown] }).end).toMatchObject({ kind: 'in_flight' });
  });

  it('R-STG-4 a step whose message left counts as run even while its run row still says scheduled', () => {
    const steps = [step('a'), step('b', { offsetSeconds: 60 })];
    const w = walkSteps({ ...base, steps, runs: [run('a', { status: 'scheduled', messageId: 'm1', messageStatus: 'delivered', updatedAt: at(-30_000) })] });
    expect(w.current).toBe(1);
    expect(w.end).toMatchObject({ kind: 'wait', until: at(30_000) });
  });

  it('R-STG-4 a step that cannot run (its capability is off, its event is missing) is skipped and the walk goes on to the next one', () => {
    const steps = [step('a', { requires: ['review_requests'] }), step('b', { anchor: 'event', offsetSeconds: -3600 }), step('c')];
    const w = walkSteps({ ...base, steps, runs: [] });
    expect(w.skips.map((s) => [s.step.stepKey, s.existingRunId])).toEqual([['a', null], ['b', null]]);
    expect(w.current).toBe(2);
    expect(w.end).toMatchObject({ kind: 'run', step: { stepKey: 'c' } });
  });

  it('R-STG-4 a stop condition that holds ends the walk; past the last step the plan is complete; a run rebuilt after a version change keeps its row', () => {
    const steps = [step('a', { stopIf: ['deal_opened'] }), step('b')];
    expect(walkSteps({ ...base, steps, runs: [], facts: new Set(['deal_opened'] as const) }).end).toEqual({ kind: 'stop', condition: 'deal_opened' });
    expect(walkSteps({ ...base, steps, runs: [run('a'), run('b')] })).toMatchObject({ current: 2, end: { kind: 'complete' } });
    const rebuilt = run('a', { status: 'scheduled', messageId: null });
    expect(walkSteps({ ...base, steps, runs: [rebuilt] }).end).toMatchObject({ kind: 'run', existingRunId: rebuilt.id });
  });
});
