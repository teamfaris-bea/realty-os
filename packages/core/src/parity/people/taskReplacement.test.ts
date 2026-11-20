// b19 Today fix 1 (H1, M2, M3; R-TODAY-11): the ONE rule for when a one-pass sheet's new follow-up replaces (marks
// done) a task the agent already had. Stated once, here, and read by every sheet; tested as a table.
import { describe, expect, it } from 'vitest';
import { REPLACEABLE_TASK_KINDS, type TaskReplacement, decideTaskReplacement } from './index.js';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 19, 17, 0, 0);
const task = (over: Partial<{ isCardTask: boolean; kind: string; deadline: number | null }> = {}) => ({ isCardTask: true, kind: 'follow_up', deadline: NOW - HOUR, ...over });

describe('R-TODAY-11: decideTaskReplacement, the replace-a-task rule', () => {
  const TABLE: [string, Parameters<typeof decideTaskReplacement>[0], TaskReplacement][] = [
    ['the card’s own follow-up, past its deadline, and the new one is later: replaced', { task: task(), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: true }],
    ['a callback is replaced the same way', { task: task({ kind: 'callback' }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: true }],
    ['a deadline that passes exactly now has passed', { task: task({ deadline: NOW }), newDueAt: NOW + HOUR, now: NOW }, { replace: true }],
    ['no task on the card: nothing to replace', { task: null, newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'no_task', twoFollowUps: false }],
    ['no new follow-up (None): nothing is closed', { task: task(), newDueAt: null, now: NOW }, { replace: false, why: 'no_new_follow_up', twoFollowUps: false }],
    ['a task that is not the card’s own is never closed', { task: task({ isCardTask: false }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'not_the_cards_task', twoFollowUps: false }],
    ['a promise is never closed for the agent', { task: task({ kind: 'promise' }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'not_a_follow_up', twoFollowUps: false }],
    ['a plain to-do is never closed', { task: task({ kind: 'todo' }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'not_a_follow_up', twoFollowUps: false }],
    ['M3: a follow-up due tomorrow 10:48 is not due: left open, and the person will have two', { task: task({ deadline: NOW + 17 * HOUR + 48 * 60_000 }), newDueAt: NOW + 16 * HOUR, now: NOW }, { replace: false, why: 'not_due', twoFollowUps: true }],
    ['M3: a callback that is not due is left open too', { task: task({ kind: 'callback', deadline: NOW + HOUR }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'not_due', twoFollowUps: true }],
    ['an undated follow-up has no deadline to pass: left open', { task: task({ deadline: null }), newDueAt: NOW + 24 * HOUR, now: NOW }, { replace: false, why: 'not_due', twoFollowUps: true }],
    ['a new follow-up that is not later than the old one (a picked date in the past) replaces nothing', { task: task({ deadline: NOW - HOUR }), newDueAt: NOW - 2 * HOUR, now: NOW }, { replace: false, why: 'new_not_later', twoFollowUps: true }],
    ['… nor one at the very same instant', { task: task({ deadline: NOW - HOUR }), newDueAt: NOW - HOUR, now: NOW }, { replace: false, why: 'new_not_later', twoFollowUps: true }],
  ];
  it.each(TABLE)('%s', (_n, input, want) => {
    expect(decideTaskReplacement(input)).toEqual(want);
  });

  it('only "follow_up" and "callback" are ever replaceable', () => {
    expect([...REPLACEABLE_TASK_KINDS]).toEqual(['follow_up', 'callback']);
    for (const kind of ['promise', 'todo', 'appointment_prep', 'milestone', 'review', '', 'FOLLOW_UP']) {
      expect(decideTaskReplacement({ task: task({ kind }), newDueAt: NOW + HOUR, now: NOW }).replace).toBe(false);
    }
  });

  it('every one of the four conditions is needed: dropping any one of them leaves the task open', () => {
    const all = { task: task(), newDueAt: NOW + HOUR, now: NOW };
    expect(decideTaskReplacement(all).replace).toBe(true);
    expect(decideTaskReplacement({ ...all, task: task({ isCardTask: false }) }).replace).toBe(false);
    expect(decideTaskReplacement({ ...all, task: task({ kind: 'promise' }) }).replace).toBe(false);
    expect(decideTaskReplacement({ ...all, task: task({ deadline: NOW + 1 }) }).replace).toBe(false);
    expect(decideTaskReplacement({ ...all, newDueAt: NOW - HOUR }).replace).toBe(false);
  });
});
