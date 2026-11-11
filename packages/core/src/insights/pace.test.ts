import { describe, expect, it } from 'vitest';
import { at, instant, localDate } from '../foundation/index.js';
import { ME, NY, goalId } from './testing/fixtures.js';
import { goalPace, periodEnd, type AgentGoal, type GoalMetric, type GoalPeriodKind } from './index.js';

const goal = (kind: GoalPeriodKind, start: string, target: number, metric: GoalMetric = 'closings'): AgentGoal => ({
  id: goalId(1),
  userId: ME,
  periodKind: kind,
  periodStart: localDate(start),
  metric,
  target,
});

describe('goalPace (counts come from the scoreboard definers via the API; pace from the calendar)', () => {
  it('goal pace: period ends are calendar arithmetic on local dates (week, month, quarter, year; month-end clamps)', () => {
    expect(periodEnd('week', localDate('2026-11-09'))).toBe('2026-11-16');
    expect(periodEnd('month', localDate('2026-11-01'))).toBe('2026-12-01');
    expect(periodEnd('quarter', localDate('2026-10-01'))).toBe('2027-01-01');
    expect(periodEnd('year', localDate('2026-01-01'))).toBe('2027-01-01');
    expect(periodEnd('month', localDate('2026-01-31'))).toBe('2026-02-28');
  });

  it('goal pace: expected-by-now is target × elapsed fraction of the period in the user zone', () => {
    // November 2026 in New York: 30 days; noon local on Nov 16 = 15.5 days elapsed (DST ended Nov 1, before the period).
    const p = goalPace(goal('month', '2026-11-01', 30), { actual: 10 }, at('2026-11-16T17:00:00Z'), NY);
    expect(p.expectedByNow).toBe(15.5);
    expect(p.behindBy).toBe(6);
    expect(p.status).toBe('behind');
    expect(p).toMatchObject({ actual: 10, target: 30, remaining: 20, daysLeft: 15, periodEndExclusive: '2026-12-01' });
    expect(p.words).toBe('10 of 30 closings; 15.5 expected by now; 20 to go in 15 days');
  });

  it('goal pace: on_track within one whole unit of a fractional pace; ahead above it; done at target', () => {
    const now = at('2026-11-16T17:00:00Z'); // E = 15.5
    const g = goal('month', '2026-11-01', 30);
    expect(goalPace(g, { actual: 15 }, now, NY).status).toBe('on_track');
    expect(goalPace(g, { actual: 16 }, now, NY).status).toBe('on_track');
    expect(goalPace(g, { actual: 17 }, now, NY).status).toBe('ahead');
    expect(goalPace(g, { actual: 14 }, now, NY).status).toBe('behind');
    const done = goalPace(g, { actual: 31 }, now, NY);
    expect(done).toMatchObject({ status: 'done', remaining: 0, behindBy: 0 });
    expect(done.words).toBe('31 of 30 closings: goal reached');
  });

  it('goal pace: before the period starts nothing is expected yet; after it ends the whole target is expected and daysLeft is 0', () => {
    const before = goalPace(goal('week', '2026-11-16', 10, 'touches'), { actual: 0 }, at('2026-11-11T17:00:00Z'), NY);
    expect(before).toMatchObject({ expectedByNow: 0, status: 'on_track', daysLeft: 7, behindBy: 0 });
    const after = goalPace(goal('week', '2026-11-02', 10, 'touches'), { actual: 4 }, at('2026-11-11T17:00:00Z'), NY);
    expect(after).toMatchObject({ expectedByNow: 10, status: 'behind', daysLeft: 0, behindBy: 6, remaining: 6 });
  });

  it('goal pace: a week spanning the DST change uses real elapsed time (the fall-back week has 169 hours)', () => {
    // US DST ends 2026-11-01 02:00 local; the week Oct 29 – Nov 5 has 169 hours.
    const p = goalPace(goal('week', '2026-10-29', 169, 'touches'), { actual: 0 }, instant(at('2026-10-29T04:00:00Z') + 3_600_000), NY);
    expect(p.expectedByNow).toBe(1); // one hour of 169 → 1 touch of 169
  });

  it('goal pace: a target of 0 is done immediately', () => {
    expect(goalPace(goal('month', '2026-11-01', 0), { actual: 0 }, at('2026-11-02T12:00:00Z'), NY).status).toBe('done');
  });
});
