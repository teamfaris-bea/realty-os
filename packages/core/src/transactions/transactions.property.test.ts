// Property tests of the transaction decision functions (PHASE2_3_PLAN §5 critical module rules).
import fc from 'fast-check';
import { describe, it } from 'vitest';
import { type DealDateId, type LocalDate, type UserId, type Weekday, HOUR_MS, SECOND_MS, instant, localDate, localDateOf, zone } from '../foundation/index.js';
import { boundVersionStale, confirmDate } from './confirm.js';
import { addBusinessDays, addCalendarDays, businessDayCalendar, daysBetween, nonBusinessDay } from './dates.js';
import { DUE_SOON_MS, milestoneRisk } from './risk.js';
import type { DealDate, Responsible } from './types.js';

const ZONES = ['America/New_York', 'America/Los_Angeles', 'America/Phoenix', 'Pacific/Honolulu', 'Europe/London', 'America/Santiago', 'Australia/Lord_Howe', 'UTC'].map(zone);
const BASE = Date.UTC(2024, 0, 1);
const dateArb = fc.integer({ min: 0, max: 365 * 4 }).map((d) => localDate(new Date(BASE + d * 86_400_000).toISOString().slice(0, 10)));
const zoneArb = fc.constantFrom(...ZONES);
const nowArb = fc.integer({ min: BASE - 400 * 86_400_000, max: BASE + 365 * 5 * 86_400_000 }).map(instant);
const user = { kind: 'user', userId: 'u1' as UserId } as const;

function row(dueOn: LocalDate, over: Partial<DealDate> = {}): DealDate {
  return {
    id: 'dd' as DealDateId,
    kind: 'closing',
    label: null,
    dueOn,
    source: 'manual',
    status: 'confirmed',
    dueVersion: 1,
    dueAt: null,
    reminderAt: null,
    completedAt: null,
    responsible: null,
    basis: {},
    ...over,
  };
}

describe('confirmDate properties', () => {
  it('R-TXN-2 E143: due_at is the last second of the due date in the zone, for any date and zone', () => {
    fc.assert(
      fc.property(dateArb, zoneArb, nowArb, (d, z, now) => {
        const r = confirmDate(null, { actor: user, dueOn: d, source: 'manual', now }, z);
        if (!r.ok) return false;
        return localDateOf(r.dueAt, z) === d && localDateOf(instant(r.dueAt + SECOND_MS), z) === addCalendarDays(d, 1);
      }),
      { numRuns: 400 },
    );
  });

  it('R-OWN-27: a reminder is null or within [now, due_at]; never after the due day', () => {
    fc.assert(
      fc.property(dateArb, zoneArb, nowArb, fc.option(fc.integer({ min: 0, max: 60 }), { nil: null }), (d, z, now, days) => {
        const r = confirmDate(null, { actor: user, dueOn: d, source: 'manual', now, reminderDaysBefore: days }, z);
        if (!r.ok) return false;
        if (days === null || r.dueAt <= now) return r.reminderAt === null;
        return r.reminderAt !== null && r.reminderAt >= now && r.reminderAt <= r.dueAt;
      }),
      { numRuns: 400 },
    );
  });

  it('R-TXN-5: due_version bumps by exactly one iff a confirmed date moves', () => {
    fc.assert(
      fc.property(dateArb, dateArb, fc.integer({ min: 1, max: 50 }), fc.constantFrom('confirmed', 'proposed') as fc.Arbitrary<'confirmed' | 'proposed'>, nowArb, (a, b, v, status, now) => {
        const r = confirmDate(row(a, { dueVersion: v, status }), { actor: user, dueOn: b, source: 'manual', now }, zone('UTC'));
        if (!r.ok) return false;
        const expected = status === 'confirmed' && a !== b ? v + 1 : v;
        return r.dueVersion === expected && boundVersionStale({ dueVersion: v }, { status: 'confirmed', completedAt: null, dueAt: r.dueAt, dueVersion: r.dueVersion }) === (expected !== v);
      }),
      { numRuns: 300 },
    );
  });

  it('R-TXN-1: a non-person actor never gets instants, whatever the input', () => {
    fc.assert(
      fc.property(dateArb, zoneArb, nowArb, fc.constantFrom('manual', 'template', 'document', 'import') as fc.Arbitrary<'manual'>, (d, z, now, source) => {
        const r = confirmDate(null, { actor: { kind: 'system' }, dueOn: d, source, now }, z);
        return !r.ok && r.code === 'DATE_HUMAN_CONFIRMATION';
      }),
    );
  });
});

describe('business-day properties', () => {
  const weekdays = fc.uniqueArray(fc.integer({ min: 1, max: 7 }), { minLength: 1, maxLength: 7 }) as fc.Arbitrary<Weekday[]>;
  const holidays = fc.uniqueArray(dateArb, { maxLength: 20 });

  it('the n-th business day is a business day with exactly n-1 business days strictly between', () => {
    fc.assert(
      fc.property(weekdays, holidays, dateArb, fc.integer({ min: 1, max: 30 }), (days, hol, anchor, n) => {
        const cal = businessDayCalendar({ days, holidays: hol.map((h) => [h, 'H'] as const) });
        const d = addBusinessDays(anchor, n, cal);
        if (nonBusinessDay(d, cal) !== null) return false;
        let between = 0;
        for (let i = 1; i < daysBetween(anchor, d); i++) if (nonBusinessDay(addCalendarDays(anchor, i), cal) === null) between++;
        return between === n - 1;
      }),
      { numRuns: 300 },
    );
  });

  it('is strictly increasing in n', () => {
    fc.assert(
      fc.property(weekdays, dateArb, fc.integer({ min: 0, max: 40 }), (days, anchor, n) => {
        const cal = businessDayCalendar({ days });
        return addBusinessDays(anchor, n + 1, cal) > addBusinessDays(anchor, n, cal);
      }),
    );
  });
});

describe('R-ACC-6 risk properties', () => {
  it('R-ACC-6: a risk exists iff the date is confirmed, open and (overdue or due within 48 h with nobody responsible)', () => {
    const resp = fc.constantFrom<Responsible | null>(null, 'lender', 'tc');
    fc.assert(
      fc.property(
        fc.constantFrom('confirmed', 'proposed', 'waived') as fc.Arbitrary<'confirmed'>,
        fc.boolean(),
        fc.integer({ min: -200, max: 200 }),
        resp,
        (status, completed, hoursAhead, responsible) => {
          const now = instant(BASE);
          const dueAt = instant(BASE + hoursAhead * HOUR_MS);
          const r = milestoneRisk({ id: 'x' as DealDateId, status, completedAt: completed ? now : null, dueAt, dueVersion: 1, responsible }, now);
          const open = status === 'confirmed' && !completed;
          const overdue = dueAt < now;
          const soon = dueAt - now <= DUE_SOON_MS && responsible === null;
          if (!open || !(overdue || soon)) return r === null;
          return r !== null && r.predicates.includes('overdue') === overdue && r.predicates.includes('due_soon_unassigned') === soon;
        },
      ),
      { numRuns: 500 },
    );
  });
});
