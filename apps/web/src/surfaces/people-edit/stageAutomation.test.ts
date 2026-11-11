// Parity module 67 (flagged edit in module 58): the stage toast says what the stage entry started, or why
// it did not, in plain words (never a raw code).
import { describe, expect, it } from 'vitest';
import { automationText } from './StagePill.js';

const REASONS = ['already_in_a_plan', 'plan_not_approved', 'cannot_be_reached', 'not_visible', 'stage_changed_again', 'person_removed', 'not_a_person_change'];

describe('R-PAR-16 the stage toast names the plan that started, or why it did not', () => {
  it('R-PAR-16 started / skipped / nothing', () => {
    expect(automationText({ started: 'Buyer plan' })).toBe('Started Buyer plan');
    expect(automationText({ skipped: 'already_in_a_plan', plan: 'Buyer plan' })).toBe("Buyer plan didn't start: they're already in a plan");
    expect(automationText({ skipped: 'cannot_be_reached', plan: 'Buyer plan' })).toBe("Buyer plan didn't start: they can't be messaged");
    expect(automationText(null)).toBe('');
    expect(automationText(undefined)).toBe('');
  });

  it('R-PAR-16 every skip reason of the closed set reads as words, never as its code', () => {
    for (const r of REASONS) {
      const t = automationText({ skipped: r, plan: 'P' });
      expect(t).not.toContain(r);
      expect(t).not.toContain('it could not start');
    }
    expect(automationText({ skipped: 'SOMETHING_NEW', plan: 'P' })).toBe("P didn't start: it could not start");
  });
});
