// R-TODAY-6: the daily plan for warm people ("Follow up today"). Pure table tests of who is due, why, in what order,
// who is left out, and what the row offers. Nothing here creates a message, a task or a touch.
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, at, zone } from '../foundation/index.js';
import type { GateSummary } from './types.js';
import { FOLLOW_UP_TODAY_CAP, type FollowUpPersonFacts, type PromiseTask, WARM_FOLLOW_UP_DAYS, followUpActions, followUpTodayReasons, optedOutOfEveryChannel, planFollowUpToday, startOfTomorrow } from './followUp.js';

const NY = zone('America/New_York');
const NOW = at('2026-11-19T15:00:00Z'); // Thu 10:00 AM in New York
const ago = (ms: number) => (NOW - ms) as typeof NOW;
const ahead = (ms: number) => (NOW + ms) as typeof NOW;

const task = (o: Partial<PromiseTask> = {}): PromiseTask => ({ taskId: 't1', title: 'Send lender intro', kind: 'promise', dueAt: ahead(7 * HOUR_MS), dueAllDay: false, dueTz: null, createdAt: ago(3 * DAY_MS), ...o });
const person = (o: Partial<FollowUpPersonFacts> = {}): FollowUpPersonFacts => ({ contactId: 'c1', stage: 'connected', tasks: [], lastContactAt: ago(2 * DAY_MS), sinceAt: ago(40 * DAY_MS), gate: undefined, ...o });
const plan = (people: FollowUpPersonFacts[], cap?: number) => planFollowUpToday({ now: NOW, zone: NY, people, ...(cap === undefined ? {} : { cap }) });
const DENY = { outcome: 'deny', explanation: 'Opted out of texts' } as const;
const NONE = { outcome: 'unavailable', explanation: 'No working phone number' } as const;

describe('R-TODAY-6: the thresholds are constants an owner can read', () => {
  it('7 days for Connected, 30 for Long-term follow-up, and no other stage', () => {
    expect(WARM_FOLLOW_UP_DAYS).toEqual({ connected: 7, nurture: 30 });
    expect(FOLLOW_UP_TODAY_CAP).toBe(20);
  });
});

describe('R-TODAY-6: who is due by a promise or a task', () => {
  it('a promise due later today is in the plan, with the task; one due tomorrow is not', () => {
    expect(startOfTomorrow(NOW, NY)).toBe(at('2026-11-20T05:00:00Z'));
    const r = plan([person({ tasks: [task()] }), person({ contactId: 'c2', tasks: [task({ taskId: 't2', dueAt: at('2026-11-20T05:00:00Z') })] })]);
    expect(r.people).toEqual([{ contactId: 'c1', reason: 'promise', dueAt: ahead(7 * HOUR_MS), taskIds: ['t1'], quietDays: null, neverContacted: false }]);
    expect(r.total).toBe(1);
  });
  it('"today" is the team’s day: 11:30 PM New York time is still today there though the UTC date changed', () => {
    const lateTask = task({ dueAt: at('2026-11-20T04:30:00Z') });
    expect(plan([person({ tasks: [lateTask] })]).people).toHaveLength(1);
    // the same instant read by a team in London is tomorrow there
    expect(planFollowUpToday({ now: NOW, zone: zone('Europe/London'), people: [person({ tasks: [lateTask] })] }).people).toHaveLength(0);
  });
  it('an overdue task counts, any kind; the earliest due task names the reason and every due task is folded into the one row', () => {
    const r = plan([person({ tasks: [task({ taskId: 'b', kind: 'todo', title: 'Send the comps', dueAt: ago(3 * DAY_MS) }), task({ taskId: 'a' }), task({ taskId: 'later', dueAt: ahead(5 * DAY_MS) })] })]);
    expect(r.people).toEqual([{ contactId: 'c1', reason: 'task', dueAt: ago(3 * DAY_MS), taskIds: ['b', 'a'], quietDays: null, neverContacted: false }]);
  });
  it('an all-day task due today is due until the end of the team’s day, and an undated task makes nobody due', () => {
    const allDay = task({ dueAt: at('2026-11-19T05:00:00Z'), dueAllDay: true });
    expect(plan([person({ tasks: [allDay] })]).people[0]).toMatchObject({ reason: 'promise', dueAt: at('2026-11-20T05:00:00Z') });
    expect(plan([person({ tasks: [task({ dueAt: null })] })]).people).toEqual([]);
  });
});

describe('R-TODAY-6 E850: who is warm and quiet (and not someone whose next step is already dated)', () => {
  const WARM: [string, FollowUpPersonFacts, boolean][] = [
    ['Connected, last contact 8 days ago', person({ lastContactAt: ago(8 * DAY_MS) }), true],
    ['Connected, last contact exactly 7 days ago (not longer than the threshold)', person({ lastContactAt: ago(7 * DAY_MS) }), false],
    ['Connected, last contact 7 days and a minute ago', person({ lastContactAt: ago(7 * DAY_MS + MINUTE_MS) }), true],
    ['Connected, last contact 2 days ago', person(), false],
    ['Long-term follow-up, 31 days', person({ stage: 'nurture', lastContactAt: ago(31 * DAY_MS) }), true],
    ['Long-term follow-up, 29 days', person({ stage: 'nurture', lastContactAt: ago(29 * DAY_MS) }), false],
    ['Connected and never contacted, theirs for 40 days', person({ lastContactAt: null }), true],
    ['Connected and never contacted, theirs for 3 days', person({ lastContactAt: null, sinceAt: ago(3 * DAY_MS) }), false],
    ['Trying to reach, 60 days (no threshold for that stage)', person({ stage: 'attempting', lastContactAt: ago(60 * DAY_MS) }), false],
    ['Active client, 60 days', person({ stage: 'active', lastContactAt: ago(60 * DAY_MS) }), false],
    ['Not moving forward, 60 days', person({ stage: 'lost', lastContactAt: ago(60 * DAY_MS) }), false],
    ['Connected, 60 days, but a next step is already set for next week', person({ lastContactAt: ago(60 * DAY_MS), tasks: [task({ dueAt: ahead(6 * DAY_MS) })] }), false],
    ['Connected, 60 days, with only an undated task', person({ lastContactAt: ago(60 * DAY_MS), tasks: [task({ dueAt: null })] }), true],
  ];
  it.each(WARM)('%s', (_n, p, due) => {
    expect(plan([p]).people.length === 1).toBe(due);
  });
  it('the row says how long it has been quiet and since when it is due', () => {
    expect(plan([person({ lastContactAt: ago(9 * DAY_MS + HOUR_MS) })]).people).toEqual([{ contactId: 'c1', reason: 'warm', dueAt: ago(2 * DAY_MS + HOUR_MS), taskIds: [], quietDays: 9, neverContacted: false }]);
    expect(plan([person({ lastContactAt: null })]).people[0]).toMatchObject({ reason: 'warm', quietDays: 40, neverContacted: true });
  });
});

describe('R-TODAY-6 E847: who is never in the plan', () => {
  const sms: GateSummary = { sms: DENY };
  const everyChannel: GateSummary = { sms: DENY, voice: { outcome: 'deny', explanation: 'Asked not to be called' }, email: { outcome: 'deny', explanation: 'Unsubscribed from email' } };
  it('someone who opted out of every channel the agent could use (a promise due included)', () => {
    expect(optedOutOfEveryChannel(everyChannel)).toBe(true);
    expect(plan([person({ tasks: [task()], gate: everyChannel }), person({ contactId: 'c2', lastContactAt: ago(30 * DAY_MS), gate: everyChannel })]).people).toEqual([]);
  });
  it('opted out of texts and with no email on file: the one channel left is the phone, so they stay', () => {
    const g: GateSummary = { sms: DENY, email: NONE };
    expect(optedOutOfEveryChannel(g)).toBe(false);
    expect(plan([person({ tasks: [task()], gate: g })]).people).toHaveLength(1);
  });
  it('opted out of the only channels they have (texts and calls; no email on file): left out', () => {
    expect(optedOutOfEveryChannel({ sms: DENY, voice: { outcome: 'deny', explanation: 'Asked not to be called' }, email: NONE })).toBe(true);
  });
  it('no phone and no email at all is not an opt-out: they stay, and the row offers the person’s page', () => {
    const g: GateSummary = { sms: NONE, voice: NONE, email: NONE };
    expect(optedOutOfEveryChannel(g)).toBe(false);
    expect(optedOutOfEveryChannel(undefined)).toBe(false);
    expect(optedOutOfEveryChannel(sms)).toBe(false);
    expect(followUpActions('c1' as never, g, null).primaryAction).toEqual({ kind: 'open_contact', label: 'Open', contactId: 'c1' });
  });
});

describe('R-TODAY-6 E859: order and cap', () => {
  it('most overdue first, whatever the reason; ties by person', () => {
    const r = plan([
      person({ contactId: 'warm-2d', lastContactAt: ago(9 * DAY_MS) }),
      person({ contactId: 'today', tasks: [task()] }),
      person({ contactId: 'task-5d', tasks: [task({ taskId: 'x', kind: 'todo', dueAt: ago(5 * DAY_MS) })] }),
      person({ contactId: 'b-tie', tasks: [task({ taskId: 'y', dueAt: ago(DAY_MS) })] }),
      person({ contactId: 'a-tie', tasks: [task({ taskId: 'z', dueAt: ago(DAY_MS) })] }),
    ]);
    expect(r.people.map((p) => p.contactId)).toEqual(['task-5d', 'warm-2d', 'a-tie', 'b-tie', 'today']);
  });
  it('capped, and the total says how many are due in all', () => {
    const many = Array.from({ length: 27 }, (_, i) => person({ contactId: `c${String(i).padStart(2, '0')}`, lastContactAt: ago((10 + i) * DAY_MS) }));
    const r = plan(many);
    expect(r.people).toHaveLength(20);
    expect(r.total).toBe(27);
    expect(r.people[0]!.contactId).toBe('c26');
    expect(plan(many, 5).people).toHaveLength(5);
  });
  it('the same people in any order give the same plan', () => {
    const people = [person({ contactId: 'a', lastContactAt: ago(9 * DAY_MS) }), person({ contactId: 'b', tasks: [task()] }), person({ contactId: 'c', lastContactAt: ago(12 * DAY_MS) })];
    expect(plan([...people].reverse())).toEqual(plan(people));
  });
});

describe('R-TODAY-6: the reason, in words', () => {
  const say = (p: FollowUpPersonFacts, stageLabel = 'Connected') => followUpTodayReasons(plan([p]).people[0]!, { now: NOW, stageLabel }).map((r) => r.label);
  it('a promise: the words the feed already uses for one', () => {
    expect(say(person({ tasks: [task()] }))).toEqual(['You promised this; due in 7 h']);
    expect(say(person({ tasks: [task({ dueAt: ago(2 * DAY_MS) })] }))).toEqual(['You promised this; 2 d overdue']);
  });
  it('a task, and how many are due when there are several', () => {
    expect(say(person({ tasks: [task({ kind: 'follow_up', dueAt: ago(3 * HOUR_MS) })] }))).toEqual(['Overdue by 3 h']);
    expect(say(person({ tasks: [task({ taskId: 'a', kind: 'todo', dueAt: ahead(HOUR_MS) }), task({ taskId: 'b' })] }))).toEqual(['Due in 1 h', '2 tasks due today or earlier']);
  });
  it('warm: the team’s own stage label, and how long without a conversation', () => {
    expect(say(person({ lastContactAt: ago(9 * DAY_MS) }))).toEqual(['Connected: no conversation for 9 days']);
    expect(say(person({ stage: 'nurture', lastContactAt: ago(41 * DAY_MS) }), 'Long-term follow-up')).toEqual(['Long-term follow-up: no conversation for 41 days']);
    expect(say(person({ lastContactAt: null }))).toEqual(['Connected: no conversation yet']);
  });
  it('codes are stable and never scored (no points)', () => {
    const reasons = followUpTodayReasons(plan([person({ lastContactAt: ago(9 * DAY_MS) })]).people[0]!, { now: NOW, stageLabel: 'Connected' });
    expect(reasons).toEqual([{ code: 'WARM_NO_CONTACT', label: 'Connected: no conversation for 9 days' }]);
  });
});

describe('R-TODAY-6: what the row offers: the agent’s own one-to-one follow-up, never a send', () => {
  it('call first, then text and email; Done for the due task; the person’s page last', () => {
    expect(followUpActions('c1' as never, undefined, 't1')).toEqual({
      primaryAction: { kind: 'call', label: 'Call', contactId: 'c1' },
      alternatives: [
        { kind: 'text', label: 'Text', contactId: 'c1' },
        { kind: 'email', label: 'Email', contactId: 'c1' },
        { kind: 'complete_task', label: 'Done', taskId: 't1' },
        { kind: 'open_contact', label: 'Open', contactId: 'c1' },
      ],
    });
  });
  it('a blocked channel is not offered', () => {
    const a = followUpActions('c1' as never, { voice: { outcome: 'deny', explanation: 'Asked not to be called' }, email: NONE }, null);
    expect(a.primaryAction).toEqual({ kind: 'text', label: 'Text', contactId: 'c1' });
    expect(a.alternatives.map((x) => x.kind)).toEqual(['open_contact']);
  });
  it('no action is one that sends by itself', () => {
    const kinds = [followUpActions('c1' as never, undefined, 't1'), followUpActions('c1' as never, { sms: DENY }, null)].flatMap((a) => [a.primaryAction, ...a.alternatives]).map((x) => x.kind);
    expect(kinds).not.toContain('send_draft');
  });
});
