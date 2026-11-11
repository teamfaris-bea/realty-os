import { describe, expect, it } from 'vitest';
import { RUBRIC_V1, isRubricVersion } from './index.js';

describe('RUBRIC_V1', () => {
  it('R-COACH-2: version rubric/1 (call_scores.rubric_version CHECK) with about 8 stable snake_case items', () => {
    expect(RUBRIC_V1.version).toBe('rubric/1');
    expect(isRubricVersion(RUBRIC_V1.version)).toBe(true);
    expect(isRubricVersion('rubric/x')).toBe(false);
    expect(RUBRIC_V1.items.map((i) => i.key)).toEqual([
      'introduced_self',
      'asked_timeline',
      'asked_financing',
      'asked_motivation',
      'confirmed_contact_preference',
      'proposed_next_step',
      'set_follow_up',
      'recapped_call',
    ]);
    for (const i of RUBRIC_V1.items) {
      expect(i.key).toMatch(/^[a-z][a-z0-9_]*$/);
      for (const text of [i.label, i.good, i.tip]) expect(text.length).toBeGreaterThan(0);
    }
  });

  it('R-COACH-6: no voice-tone, sentiment, personality or grading items', () => {
    const text = JSON.stringify(RUBRIC_V1).toLowerCase();
    expect(text).not.toMatch(/tone|sentiment|personality|energy|enthusias|friendl|confiden|warmth|grade|score|rank|percent/);
  });

  it('is frozen (keys are stable; a change needs a new rubric version)', () => {
    expect(Object.isFrozen(RUBRIC_V1)).toBe(true);
    expect(Object.isFrozen(RUBRIC_V1.items)).toBe(true);
  });
});
