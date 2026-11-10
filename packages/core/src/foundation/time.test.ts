import { describe, expect, it } from 'vitest';
import { assertNever, BASE_ERROR_CODES, fail, isErrorCode, ok } from './errors.js';
import {
  DAY_MS,
  at,
  fixedClock,
  instant,
  instantFromDate,
  instantFromIso,
  maxInstant,
  minInstant,
  plusMs,
  plusSeconds,
  steppingClock,
  toIso,
} from './time.js';

describe('instants', () => {
  it('parses ISO timestamps only when they carry an offset (no ambient process zone)', () => {
    expect(instantFromIso('2026-03-08T07:00:00Z')).toBe(Date.UTC(2026, 2, 8, 7));
    expect(instantFromIso('2026-03-08T02:00:00-05:00')).toBe(Date.UTC(2026, 2, 8, 7));
    expect(instantFromIso('2026-03-08T07:00:00.123456Z')).toBe(Date.UTC(2026, 2, 8, 7, 0, 0, 123));
    expect(instantFromIso('2026-03-08T07:00Z')).toBe(Date.UTC(2026, 2, 8, 7));
    for (const bad of ['2026-03-08T07:00:00', '2026-03-08', 'yesterday', '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z']) {
      expect(instantFromIso(bad)).toBeNull();
    }
    expect(() => at('2026-03-08T07:00:00')).toThrow(RangeError);
  });

  it('round-trips through ISO and Date', () => {
    const t = at('2027-11-07T06:30:00.250Z');
    expect(toIso(t)).toBe('2027-11-07T06:30:00.250Z');
    expect(instantFromDate(new Date(t))).toBe(t);
  });

  it('brands only integer epoch milliseconds', () => {
    expect(() => instant(1.5)).toThrow(RangeError);
    expect(() => instant(Number.NaN)).toThrow(RangeError);
    expect(() => instant(9e15)).toThrow(RangeError);
    expect(plusMs(instant(10), 5)).toBe(15);
    expect(plusSeconds(instant(0), 1.0004)).toBe(1000);
    expect(maxInstant(instant(1), instant(2))).toBe(2);
    expect(minInstant(instant(1), instant(2))).toBe(1);
    expect(maxInstant(instant(3), instant(2))).toBe(3);
    expect(minInstant(instant(3), instant(2))).toBe(2);
    // Matches the shape but is not a real time of day.
    expect(instantFromIso('2026-01-01T99:99:00Z')).toBeNull();
    expect(instantFromIso('2026-01-01T00:00:00+99:99')).toBeNull();
  });
});

describe('deterministic clocks', () => {
  it('fixedClock returns the same instant until moved', () => {
    const c = fixedClock('2026-11-10T00:00:00Z');
    expect(c.now()).toBe(c.now());
    c.advance(DAY_MS);
    expect(c.now()).toBe(at('2026-11-11T00:00:00Z'));
    c.set(42);
    expect(c.now()).toBe(42);
  });

  it('steppingClock advances by a fixed step on every read', () => {
    const c = steppingClock('2026-01-01T00:00:00Z', 250);
    expect([c.now(), c.now(), c.now()].map(toIso)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.250Z', '2026-01-01T00:00:00.500Z']);
    expect(c.reads).toBe(3);
    expect(steppingClock().now()).toBe(0);
    expect(() => steppingClock(0, -1)).toThrow(RangeError);
  });
});

describe('errors', () => {
  it('base codes are stable SCREAMING_SNAKE_CASE', () => {
    for (const c of BASE_ERROR_CODES) expect(isErrorCode(c)).toBe(true);
    expect(isErrorCode('notACode')).toBe(false);
    expect(isErrorCode('TRAILING_')).toBe(false);
  });

  it('ok/fail build result objects; the code always wins over extra fields', () => {
    expect(ok()).toEqual({ ok: true });
    expect(ok({ value: 1 })).toEqual({ ok: true, value: 1 });
    expect(fail('NOT_FOUND')).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(fail('LEAD_STATE_CHANGED', { code: 'X', fresh: 1 } as { fresh: number })).toEqual({ ok: false, code: 'LEAD_STATE_CHANGED', fresh: 1 });
    expect(() => assertNever('x' as never)).toThrow(TypeError);
  });
});
