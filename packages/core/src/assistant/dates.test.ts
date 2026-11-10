import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, at, localDateOf } from '../foundation/index.js';
import { formatDue, resolveRelativeDate } from './dates.js';
import { CHI, LA, NY } from './testing/fixtures.js';

const ok = (phrase: string, said: Instant, z = LA) => {
  const r = resolveRelativeDate(phrase, said, z);
  if (!r.ok) throw new Error(`${phrase}: ${r.reason}`);
  return r;
};

// Tue 2026-11-10, 11:00 PT
const TUE = at('2026-11-10T11:00:00-08:00');

describe('resolveRelativeDate (R-AST-2, E34)', () => {
  it('R-AST-2 E34 "call me tomorrow" at 11:50 PM ET from a Pacific client is the next PACIFIC day', () => {
    const said = at('2026-11-10T23:50:00-05:00'); // 8:50 PM PT, Tue Nov 10
    const r = ok('call me tomorrow', said, LA);
    expect(r.allDay).toBe(true);
    expect(localDateOf(r.at, LA)).toBe('2026-11-11');
    expect(r.at).toBe(at('2026-11-11T00:00:00-08:00'));
  });

  it('R-AST-2 E34 across midnight the zone decides the day: 12:10 AM ET is still Nov 10 in Los Angeles', () => {
    const said = at('2026-11-11T00:10:00-05:00');
    expect(localDateOf(ok('tomorrow', said, LA).at, LA)).toBe('2026-11-11');
    expect(localDateOf(ok('tomorrow', said, NY).at, NY)).toBe('2026-11-12');
  });

  it('R-AST-2 "Thursday around four" said on a Tuesday is this Thursday at 4 PM local', () => {
    const r = ok('Thursday around four', TUE);
    expect(r).toEqual({ ok: true, at: at('2026-11-12T16:00:00-08:00'), allDay: false });
    expect(formatDue(r.at, false, LA)).toBe('Thu Nov 12, 4 PM');
  });

  it.each([
    ['today', '2026-11-10', true],
    ['this afternoon', '2026-11-10', true],
    ['tonight', '2026-11-10', true],
    ['tmrw', '2026-11-11', true],
    ['the day after tomorrow', '2026-11-12', true],
    ['in 3 days', '2026-11-13', true],
    ['in two weeks', '2026-11-24', true],
    ['on Friday', '2026-11-13', true],
    ['this Tuesday', '2026-11-10', true],
    ['coming tuesday', '2026-11-17', true],
    ['Mon', '2026-11-16', true],
    ['November 20th', '2026-11-20', true],
    ['Jan 5', '2027-01-05', true],
    ['11/30', '2026-11-30', true],
    ['12/1/2026', '2026-12-01', true],
    ['the 15th', '2026-11-15', true],
    ['the 5th', '2026-12-05', true],
  ])('R-AST-2 resolves %j to %s', (phrase, date, allDay) => {
    const r = ok(phrase, TUE);
    expect(localDateOf(r.at, LA)).toBe(date);
    expect(r.allDay).toBe(allDay);
  });

  it.each([
    ['tomorrow at 4pm', '2026-11-11T16:00:00-08:00'],
    ['tomorrow at 9:30 a.m.', '2026-11-11T09:30:00-08:00'],
    ['tomorrow around 10', '2026-11-11T10:00:00-08:00'],
    ['tomorrow at noon', '2026-11-11T12:00:00-08:00'],
    ['tomorrow at 12', '2026-11-11T12:00:00-08:00'],
    ['tonight at 8', '2026-11-10T20:00:00-08:00'],
    ['tomorrow at 8 in the morning', '2026-11-11T08:00:00-08:00'],
    ['tomorrow at four thirty', '2026-11-11T16:30:00-08:00'],
    ['Thursday half past three', '2026-11-12T15:30:00-08:00'],
    ['friday at 5 o\'clock', '2026-11-13T17:00:00-08:00'],
    ['Wednesday by 2:15', '2026-11-11T14:15:00-08:00'],
    ['at 3', '2026-11-10T15:00:00-08:00'],
    ['tomorrow at 17', '2026-11-11T17:00:00-08:00'],
    ['tomorrow at 7 in the evening', '2026-11-11T19:00:00-08:00'],
  ])('R-AST-2 resolves %j with its time', (phrase, iso) => {
    expect(ok(phrase, TUE)).toEqual({ ok: true, at: at(iso), allDay: false });
  });

  it('R-AST-2 "in an hour" / "in 30 minutes" are exact durations from when it was said', () => {
    expect(ok('in an hour', TUE).at).toBe(TUE + 3_600_000);
    expect(ok('in 30 minutes', TUE).at).toBe(TUE + 1_800_000);
  });

  it.each([
    'next Thursday', // this week's or next week's?
    'Tuesday', // said on a Tuesday
    'tomorrow at 8', // AM or PM?
    'next week',
    'this weekend',
    'in a couple of days',
    'in a day or two',
    'sometime soon',
    'end of the week',
    'at 10', // already past 10 AM
    'today at 9am', // in the past
    'midnight',
    '1/2/2020', // in the past
    'tomorrow morning at 7 in the evening',
  ])('R-AST-2 %j is AMBIGUOUS (needs the agent)', (phrase) => {
    expect(resolveRelativeDate(phrase, TUE, LA)).toEqual({ ok: false, reason: 'AMBIGUOUS' });
  });

  it.each(['', '   ', 'whenever works', 'sounds good', 'Feb 30', 'at 99', 'at 4:75pm'])('R-AST-2 %j is UNRECOGNIZED', (phrase) => {
    const r = resolveRelativeDate(phrase, TUE, LA);
    expect(r.ok).toBe(false);
  });

  it('R-AST-2 DST fall-back: "tomorrow at 4" on Sat Oct 31 2026 is 4 PM PST (UTC-8) on Nov 1', () => {
    expect(ok('tomorrow at 4', at('2026-10-31T10:00:00-07:00')).at).toBe(at('2026-11-01T16:00:00-08:00'));
  });

  it('R-AST-2 DST spring-forward: a time in the skipped hour moves to the transition', () => {
    expect(ok('tomorrow at 2:30am', at('2026-03-07T10:00:00-08:00')).at).toBe(at('2026-03-08T03:00:00-07:00'));
  });

  it('R-AST-2 the 31st skips months without one', () => {
    expect(localDateOf(ok('the 31st', at('2026-11-10T11:00:00-08:00')).at, LA)).toBe('2026-12-31');
    expect(localDateOf(ok('Feb 29', at('2027-03-01T11:00:00-08:00')).at, LA)).toBe('2028-02-29');
  });

  it('R-AST-2 property: deterministic, and a resolved instant is never before it was said', () => {
    const phrases = ['tomorrow', 'Thursday around four', 'in 3 days', 'tonight at 8', 'the 15th', 'Jan 5', 'at 3', 'friday at noon'];
    fc.assert(
      fc.property(fc.constantFrom(...phrases), fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }), fc.constantFrom(LA, NY, CHI), (p, t, z) => {
        const said = t as Instant;
        const a = resolveRelativeDate(p, said, z);
        expect(resolveRelativeDate(p, said, z)).toEqual(a);
        if (a.ok) {
          if (a.allDay) expect(localDateOf(a.at, z) >= localDateOf(said, z)).toBe(true);
          else expect(a.at).toBeGreaterThan(said);
        }
      }),
    );
  });
});

describe('formatDue', () => {
  it('formats in the given zone, with minutes only when needed', () => {
    const t = at('2026-11-12T16:30:00-08:00');
    expect(formatDue(t, false, LA)).toBe('Thu Nov 12, 4:30 PM');
    expect(formatDue(t, false, NY)).toBe('Thu Nov 12, 7:30 PM');
    expect(formatDue(t, true, LA)).toBe('Thu Nov 12');
    expect(formatDue(at('2026-11-12T00:05:00-08:00'), false, LA)).toBe('Thu Nov 12, 12:05 AM');
    expect(formatDue(at('2026-11-15T12:00:00-08:00'), false, LA)).toBe('Sun Nov 15, 12 PM');
  });
});

describe('resolveRelativeDate edge cases', () => {
  it('rejects impossible numeric dates and handles two-digit years', () => {
    expect(resolveRelativeDate('13/5', TUE, LA)).toEqual({ ok: false, reason: 'UNRECOGNIZED' });
    expect(resolveRelativeDate('11/0', TUE, LA)).toEqual({ ok: false, reason: 'UNRECOGNIZED' });
    expect(resolveRelativeDate('2/30/2027', TUE, LA)).toEqual({ ok: false, reason: 'UNRECOGNIZED' });
    expect(localDateOf(ok('12/1/26', TUE).at, LA)).toBe('2026-12-01');
    expect(resolveRelativeDate('the 45th', TUE, LA)).toEqual({ ok: false, reason: 'UNRECOGNIZED' });
  });

  it('Feb 29 said just after a leap day has no next occurrence next year: ambiguous', () => {
    expect(resolveRelativeDate('Feb 29', at('2028-03-01T11:00:00-08:00'), LA)).toEqual({ ok: false, reason: 'AMBIGUOUS' });
  });

  it('"four fifteen" and "four forty-five"; "tonight at 12" is ambiguous (noon or midnight)', () => {
    expect(ok('tomorrow at four fifteen', TUE).at).toBe(at('2026-11-11T16:15:00-08:00'));
    expect(ok('tomorrow at four forty-five', TUE).at).toBe(at('2026-11-11T16:45:00-08:00'));
    expect(resolveRelativeDate('tonight at 12', TUE, LA)).toEqual({ ok: false, reason: 'AMBIGUOUS' });
    expect(ok('tomorrow at 4:99', TUE).allDay).toBe(true); // an impossible time is dropped: the day still stands
  });
});
