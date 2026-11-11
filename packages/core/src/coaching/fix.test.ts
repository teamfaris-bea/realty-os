import { describe, expect, it } from 'vitest';
import { NO_FIX_TEXT, RUBRIC_V1, coachingFixKey, dailyFix, dailyFixResult } from './index.js';
import { ME, TODAY, allMetExcept, callId, ref, scored } from './testing/fixtures.js';

const q = (n: number) => ref(`quote number ${n}`, 1, callId(n));

describe('R-COACH-4 daily fix', () => {
  it('E106 R-COACH-4: two scored calls in 14 days ⇒ no fix ("Not enough calls yet")', () => {
    const calls = [scored(1, 2, allMetExcept('asked_timeline')), scored(2, 9, allMetExcept('asked_timeline'))];
    const r = dailyFixResult(calls, [], TODAY);
    expect(r).toEqual({ fix: null, reason: 'not_enough_calls' });
    expect(NO_FIX_TEXT.not_enough_calls).toBe('Not enough calls yet');
    expect(dailyFix(calls, [], TODAY)).toBeNull();
    expect(dailyFixResult([], [], TODAY)).toEqual({ fix: null, reason: 'not_enough_calls' });
  });

  it('E106: a review with nothing scored (all needs_review) is not a scored call', () => {
    const calls = [scored(1, 1, allMetExcept('asked_timeline')), scored(2, 2, allMetExcept('asked_timeline')), scored(3, 3, { asked_timeline: 'needs_review' })];
    expect(dailyFixResult(calls, [], TODAY)).toEqual({ fix: null, reason: 'not_enough_calls' });
  });

  it('R-COACH-4: picks the item missed most often among the last 10 scored calls, with its tip and the miss count', () => {
    const calls = [
      scored(1, 1, allMetExcept('asked_financing'), { asked_financing: [q(1)] }),
      scored(2, 2, allMetExcept('asked_financing', 'recapped_call'), { asked_financing: [q(2), q(20)] }),
      scored(3, 3, allMetExcept('recapped_call')),
      scored(4, 4, allMetExcept('asked_financing'), { asked_financing: [q(4)] }),
    ];
    const fix = dailyFix(calls, [], TODAY);
    const item = RUBRIC_V1.items.find((i) => i.key === 'asked_financing');
    expect(fix).toEqual({
      localDate: TODAY,
      itemKey: 'asked_financing',
      label: item?.label,
      tip: item?.tip,
      missedIn: 3,
      callsConsidered: 4,
      text: 'Missed in 3 of the last 4 calls',
      quotes: [
        { callId: callId(1), ref: q(1) },
        { callId: callId(2), ref: q(2) },
      ],
    });
  });

  it('R-COACH-4: only the last 10 scored calls count (by call time, most recent first, whatever the input order)', () => {
    const recent = Array.from({ length: 10 }, (_, i) => scored(i + 1, i + 1, allMetExcept(i < 4 ? 'asked_timeline' : 'introduced_self')));
    // with the five older asked_timeline misses (outside the window) asked_timeline would have 9
    const old = Array.from({ length: 5 }, (_, i) => scored(100 + i, 30 + i, allMetExcept('asked_timeline')));
    const fix = dailyFix([...old, ...recent].reverse(), [], TODAY);
    expect(fix?.itemKey).toBe('introduced_self');
    expect(fix?.text).toBe('Missed in 6 of the last 10 calls');
    expect(fix?.callsConsidered).toBe(10);
  });

  it('R-COACH-4: never suggests an item dismissed in the last 7 days; falls to the next most-missed', () => {
    const calls = [
      scored(1, 1, allMetExcept('asked_financing', 'recapped_call')),
      scored(2, 2, allMetExcept('asked_financing')),
      scored(3, 3, allMetExcept('asked_financing', 'recapped_call')),
    ];
    expect(dailyFix(calls, new Set(['asked_financing']), TODAY)?.itemKey).toBe('recapped_call');
    expect(dailyFixResult(calls, ['asked_financing', 'recapped_call'], TODAY)).toEqual({ fix: null, reason: 'all_dismissed' });
  });

  it('R-COACH-4: nothing missed ⇒ no card', () => {
    const calls = [1, 2, 3].map((n) => scored(n, n, allMetExcept()));
    expect(dailyFixResult(calls, [], TODAY)).toEqual({ fix: null, reason: 'nothing_missed' });
  });

  it('R-COACH-4: ties break by the most recent miss, then rubric order', () => {
    const tieRecent = [scored(1, 1, allMetExcept('recapped_call')), scored(2, 2, allMetExcept('introduced_self')), scored(3, 3, allMetExcept())];
    expect(dailyFix(tieRecent, [], TODAY)?.itemKey).toBe('recapped_call');
    const tieSameCall = [scored(1, 1, allMetExcept('recapped_call', 'asked_timeline')), scored(2, 2, allMetExcept()), scored(3, 3, allMetExcept())];
    expect(dailyFix(tieSameCall, [], TODAY)?.itemKey).toBe('asked_timeline');
  });

  it('R-COACH-4: disabled items are never suggested; keys outside the rubric are ignored', () => {
    const calls = [1, 2, 3].map((n) => scored(n, n, allMetExcept('asked_timeline', n === 1 ? 'recapped_call' : 'asked_timeline')));
    expect(dailyFix(calls, [], TODAY, { disabledKeys: ['asked_timeline'] })?.itemKey).toBe('recapped_call');
  });

  it('R-COACH-4: quotes prefer one per recent miss, then fill from the same call; at most two', () => {
    const calls = [
      scored(1, 1, allMetExcept('asked_motivation'), { asked_motivation: [q(1), q(11)] }),
      scored(2, 2, allMetExcept('asked_motivation')),
      scored(3, 3, allMetExcept('asked_motivation'), { asked_motivation: [q(3)] }),
    ];
    expect(dailyFix(calls, [], TODAY)?.quotes).toEqual([
      { callId: callId(1), ref: q(1) },
      { callId: callId(3), ref: q(3) },
    ]);
    const one = [scored(1, 1, allMetExcept('asked_motivation'), { asked_motivation: [q(1), q(11), q(111)] }), scored(2, 2, allMetExcept()), scored(3, 3, allMetExcept())];
    expect(dailyFix(one, [], TODAY)?.quotes).toEqual([
      { callId: callId(1), ref: q(1) },
      { callId: callId(1), ref: q(11) },
    ]);
  });

  it('R-COACH-4: one fix per agent per local day (card key)', () => {
    expect(coachingFixKey(ME, TODAY)).toBe(`coaching_fix:${ME}:2026-11-11`);
  });
});
