import { describe, expect, it } from 'vitest';
import { type DealDateId, type UserId, at, localDate, toIso, zone } from '../foundation/index.js';
import { boundVersionStale, confirmDate, drivesUpdates, endOfLocalDay, repairInstants } from './confirm.js';
import type { ConfirmInput, DealDate } from './types.js';

const NY = zone('America/New_York');
const LA = zone('America/Los_Angeles');
const tc = { kind: 'user', userId: 'u-tc' as UserId } as const;

function stored(over: Partial<DealDate> = {}): DealDate {
  return {
    id: 'dd-1' as DealDateId,
    kind: 'closing',
    label: null,
    dueOn: localDate('2026-06-30'),
    source: 'manual',
    status: 'confirmed',
    dueVersion: 1,
    dueAt: at('2026-07-01T03:59:59Z'),
    reminderAt: null,
    completedAt: null,
    responsible: 'title',
    basis: { kind: 'manual', zone: 'America/New_York', dueRule: 'end_of_local_day', reminderRule: null },
    ...over,
  };
}

function input(over: Partial<ConfirmInput> = {}): ConfirmInput {
  return { actor: tc, dueOn: localDate('2026-06-30'), source: 'manual', now: at('2026-06-01T15:00:00Z'), ...over };
}

describe('confirmDate', () => {
  it('R-TXN-2: due_at is the end of the due day in the tenant zone, recorded in basis', () => {
    const r = confirmDate(null, input(), NY);
    if (!r.ok) throw new Error(r.code);
    expect(toIso(r.dueAt)).toBe('2026-07-01T03:59:59.000Z'); // 23:59:59 EDT
    expect(r.dueVersion).toBe(1);
    expect(r.basis).toEqual({ kind: 'manual', zone: 'America/New_York', dueRule: 'end_of_local_day', reminderRule: null });
    expect(r.reminderAt).toBeNull();
  });

  it('E143 R-OWN-27: a deal spanning a DST change keeps its deadline at local end of day', () => {
    // Confirmed in summer (EDT), due after fall-back (EST): 23:59:59 EST = 04:59:59Z
    const r = confirmDate(null, input({ dueOn: localDate('2026-11-02'), now: at('2026-08-01T12:00:00Z') }), NY);
    if (!r.ok) throw new Error(r.code);
    expect(toIso(r.dueAt)).toBe('2026-11-03T04:59:59.000Z');
    // Spring-forward day itself: 23:59:59 EDT
    const s = confirmDate(null, input({ dueOn: localDate('2026-03-08'), now: at('2026-02-01T12:00:00Z') }), NY);
    if (!s.ok) throw new Error(s.code);
    expect(toIso(s.dueAt)).toBe('2026-03-09T03:59:59.000Z');
    // Fall-back day (25 h long): still the last second of that local day
    const f = confirmDate(null, input({ dueOn: localDate('2026-11-01'), now: at('2026-10-01T12:00:00Z') }), NY);
    if (!f.ok) throw new Error(f.code);
    expect(toIso(f.dueAt)).toBe('2026-11-02T04:59:59.000Z');
  });

  it('a zone whose midnight falls in a DST gap still ends the day one second before the next day starts', () => {
    // America/Santiago springs forward at 24:00 → 01:00 (2026-09-06 local). End of 2026-09-05.
    const r = confirmDate(null, input({ dueOn: localDate('2026-09-05'), now: at('2026-08-01T12:00:00Z') }), zone('America/Santiago'));
    if (!r.ok) throw new Error(r.code);
    expect(toIso(r.dueAt)).toBe('2026-09-06T03:59:59.000Z');
  });

  it('R-OWN-27: the reminder is a stored instant at the local reminder time', () => {
    const r = confirmDate(null, input({ reminderDaysBefore: 3 }), NY);
    if (!r.ok) throw new Error(r.code);
    expect(toIso(r.reminderAt as never)).toBe('2026-06-27T13:00:00.000Z'); // 09:00 EDT
    expect(r.basis.reminderRule).toEqual({ daysBefore: 3, localTime: '09:00' });
    const t = confirmDate(null, input({ reminderDaysBefore: 0, reminderLocalTime: '07:30' }), LA);
    if (!t.ok) throw new Error(t.code);
    expect(toIso(t.reminderAt as never)).toBe('2026-06-30T14:30:00.000Z');
  });

  it('a reminder time already passed while the date is ahead fires at the next pass (now); none after the due day', () => {
    const now = at('2026-06-29T20:00:00Z');
    const r = confirmDate(null, input({ reminderDaysBefore: 3, now }), NY);
    if (!r.ok) throw new Error(r.code);
    expect(r.reminderAt).toBe(now);
    const past = confirmDate(null, input({ reminderDaysBefore: 3, now: at('2026-07-02T12:00:00Z') }), NY);
    if (!past.ok) throw new Error(past.code);
    expect(past.reminderAt).toBeNull();
    // at the last second of the due day nothing is upcoming any more
    const atEnd = confirmDate(null, input({ reminderDaysBefore: 3, now: at('2026-07-01T03:59:59Z') }), NY);
    if (!atEnd.ok) throw new Error(atEnd.code);
    expect(atEnd.reminderAt).toBeNull();
  });

  it('R-TXN-1: only a person confirms, enters or moves a date', () => {
    expect(confirmDate(null, input({ actor: { kind: 'system' } }), NY)).toEqual({ ok: false, code: 'DATE_HUMAN_CONFIRMATION' });
    expect(confirmDate(stored(), input({ actor: { kind: 'system' }, dueOn: localDate('2026-07-02') }), NY)).toEqual({
      ok: false,
      code: 'DATE_HUMAN_CONFIRMATION',
    });
    expect(confirmDate(stored({ status: 'proposed', source: 'template' }), input({ actor: { kind: 'system' }, source: 'template' }), NY)).toMatchObject({
      ok: false,
    });
  });

  it('R-TXN-1: confirming a template proposal keeps its rule in the basis and starts at version 1', () => {
    const proposal = stored({
      status: 'proposed',
      source: 'template',
      dueAt: null,
      basis: {
        kind: 'template',
        templateId: 't',
        templateVersion: 2,
        templateReviewed: false,
        ruleKey: 'inspection',
        rule: '7 business days after acceptance (2026-06-01)',
        anchorDate: localDate('2026-06-01'),
        offsetDays: 7,
        dayCount: 'business',
      },
    });
    const r = confirmDate(proposal, input({ source: 'template', dueOn: localDate('2026-06-10') }), NY);
    if (!r.ok) throw new Error(r.code);
    expect(r.dueVersion).toBe(1);
    expect(r.basis).toMatchObject({ kind: 'template', ruleKey: 'inspection', zone: 'America/New_York' });
  });

  it('E96 R-TXN-5: moving a confirmed date bumps due_version; re-confirming the same day does not', () => {
    const moved = confirmDate(stored({ dueVersion: 4 }), input({ dueOn: localDate('2026-07-07') }), NY);
    if (!moved.ok) throw new Error(moved.code);
    expect(moved.dueVersion).toBe(5);
    expect(toIso(moved.dueAt)).toBe('2026-07-08T03:59:59.000Z');
    const same = confirmDate(stored({ dueVersion: 4 }), input(), NY);
    if (!same.ok) throw new Error(same.code);
    expect(same.dueVersion).toBe(4);
  });

  it('a completed milestone is not re-confirmed; a waived one is re-proposed instead', () => {
    expect(confirmDate(stored({ completedAt: at('2026-06-29T12:00:00Z') }), input(), NY)).toEqual({ ok: false, code: 'DATE_COMPLETED' });
    expect(confirmDate(stored({ status: 'waived' }), input(), NY)).toEqual({ ok: false, code: 'DATE_WAIVED' });
  });

  it('rejects a bad reminder', () => {
    expect(confirmDate(null, input({ reminderDaysBefore: -1 }), NY)).toEqual({ ok: false, code: 'REMINDER_INVALID' });
    expect(confirmDate(null, input({ reminderDaysBefore: 61 }), NY)).toEqual({ ok: false, code: 'REMINDER_INVALID' });
    expect(confirmDate(null, input({ reminderDaysBefore: 1.5 }), NY)).toEqual({ ok: false, code: 'REMINDER_INVALID' });
    expect(confirmDate(null, input({ reminderDaysBefore: 1, reminderLocalTime: '25:00' }), NY)).toEqual({ ok: false, code: 'REMINDER_INVALID' });
  });

  it('endOfLocalDay is one second before the next local midnight', () => {
    expect(toIso(endOfLocalDay(localDate('2026-01-15'), LA))).toBe('2026-01-16T07:59:59.000Z');
  });
});

describe('repairInstants (milestones.reconcile)', () => {
  it('R-TXN-2: a confirmed date typed on the Phase 1 screen with no due_at gets its instants', () => {
    const d = stored({ dueAt: null, basis: {} });
    const r = repairInstants(d, NY, at('2026-06-01T00:00:00Z'));
    expect(r && toIso(r.dueAt)).toBe('2026-07-01T03:59:59.000Z');
    expect(r?.reminderAt).toBeNull();
    expect(r?.basis).toEqual({ kind: 'manual', zone: 'America/New_York', dueRule: 'end_of_local_day', reminderRule: null });
  });

  it('R-OWN-27: the zone recorded at confirm time wins over a changed tenant zone', () => {
    const d = stored({ dueAt: null, basis: { kind: 'manual', zone: 'America/Los_Angeles', dueRule: 'end_of_local_day', reminderRule: { daysBefore: 1, localTime: '09:00' } } });
    const r = repairInstants(d, NY, at('2026-06-01T00:00:00Z'));
    expect(r && toIso(r.dueAt)).toBe('2026-07-01T06:59:59.000Z');
    expect(r && r.reminderAt !== null && toIso(r.reminderAt)).toBe('2026-06-29T16:00:00.000Z');
  });

  it('repairs nothing that already has instants, is unconfirmed or completed', () => {
    const now = at('2026-06-01T00:00:00Z');
    expect(repairInstants(stored(), NY, now)).toBeNull();
    expect(repairInstants(stored({ dueAt: null, status: 'proposed' }), NY, now)).toBeNull();
    expect(repairInstants(stored({ dueAt: null, completedAt: now }), NY, now)).toBeNull();
  });
});

describe('staleness', () => {
  it('R-TXN-2: only confirmed, uncompleted dates with stored instants drive updates', () => {
    expect(drivesUpdates(stored())).toBe(true);
    expect(drivesUpdates(stored({ status: 'proposed' }))).toBe(false);
    expect(drivesUpdates(stored({ status: 'waived' }))).toBe(false);
    expect(drivesUpdates(stored({ completedAt: at('2026-06-30T12:00:00Z') }))).toBe(false);
    expect(drivesUpdates(stored({ dueAt: null }))).toBe(false);
  });

  it('E142 R-TXN-5: a draft bound to the old due_version is stale after a TC moves the date', () => {
    const before = stored({ dueVersion: 2 });
    const bound = { dueVersion: before.dueVersion };
    expect(boundVersionStale(bound, before)).toBe(false);
    const moved = confirmDate(before, input({ dueOn: localDate('2026-07-03') }), NY);
    if (!moved.ok) throw new Error(moved.code);
    expect(boundVersionStale(bound, { ...before, dueVersion: moved.dueVersion, dueAt: moved.dueAt })).toBe(true);
    expect(boundVersionStale(bound, null)).toBe(true);
    expect(boundVersionStale(bound, { ...before, completedAt: at('2026-06-30T12:00:00Z') })).toBe(true);
  });
});
