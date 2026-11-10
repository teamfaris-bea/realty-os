import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, type Instant, MINUTE_MS, at, businessCalendar, instant, plusMs, zone } from '../foundation/index.js';
import { decide } from './decide.js';
import { CAL, NY, SETTINGS, T0, U, candidate, ctx, member, offeredLead, rule, systemActor, userActor } from './testing/fixtures.js';
import { firstTouchDeadlines, inactivityApplies, inactivityDeadlines, offerExpiresAt, periodTimerKeys, rescheduleTimer, slaTimers } from './timers.js';
import { C1 } from './testing/fixtures.js';

const H24 = (z: string) => businessCalendar({ zone: z, open: '00:00', close: '24:00' });

describe('offer window in business time (R-OWN-9, E8, E9)', () => {
  it('R-OWN-9: 300 s inside routing hours is 300 s; near the close it continues at the next opening', () => {
    expect(offerExpiresAt(T0, 300, CAL)).toBe(plusMs(T0, 5 * MINUTE_MS));
    expect(offerExpiresAt(at('2026-11-10T20:58:00-05:00'), 300, CAL)).toBe(at('2026-11-11T08:03:00-05:00'));
  });

  it('E9: DST transitions inside an offer window count real elapsed time (New York, Los Angeles, Phoenix; 2026 and 2027)', () => {
    const cases: [string, string, number, string][] = [
      // spring forward 02:00 → 03:00: 01:58 + 5 min = 03:03 local
      ['America/New_York', '2026-03-08T01:58:00-05:00', 300, '2026-03-08T03:03:00-04:00'],
      ['America/Los_Angeles', '2027-03-14T01:58:00-08:00', 300, '2027-03-14T03:03:00-07:00'],
      // fall back 02:00 → 01:00: 01:58 EDT + 5 min = 01:03 EST
      ['America/New_York', '2026-11-01T01:58:00-04:00', 300, '2026-11-01T01:03:00-05:00'],
      ['America/Los_Angeles', '2027-11-07T01:58:00-07:00', 300, '2027-11-07T01:03:00-08:00'],
      // Phoenix has no DST
      ['America/Phoenix', '2026-03-08T01:58:00-07:00', 300, '2026-03-08T02:03:00-07:00'],
    ];
    for (const [z, start, secs, end] of cases) expect(offerExpiresAt(at(start), secs, H24(z))).toBe(at(end));
  });

  it('E8 E9: a night lead on the spring-forward date is offered at once and counts from 08:00 EDT', () => {
    const l = offeredLead(U.a, at('2026-03-08T01:30:00-05:00'));
    expect(l.p.offerExpiresAt).toBe(at('2026-03-08T08:05:00-04:00'));
  });
});

describe('first-touch deadlines (R-OWN-13)', () => {
  it('R-OWN-13: 15 business minutes from max(owned_at, next contactable instant); auto-release from the same base', () => {
    const contactableAt9 = (t: Instant) => (t < at('2026-11-10T09:00:00-05:00') ? at('2026-11-10T09:00:00-05:00') : t);
    expect(firstTouchDeadlines({ ownedAt: at('2026-11-10T08:10:00-05:00'), settings: SETTINGS, calendar: CAL, nextContactableAt: contactableAt9 })).toEqual({
      firstTouchDueAt: at('2026-11-10T09:15:00-05:00'),
      releaseDueAt: at('2026-11-10T09:30:00-05:00'),
    });
    expect(firstTouchDeadlines({ ownedAt: at('2026-11-10T20:50:00-05:00'), settings: { ...SETTINGS, firstTouchReleaseSeconds: null }, calendar: CAL, nextContactableAt: (t) => t })).toEqual({
      firstTouchDueAt: at('2026-11-11T08:05:00-05:00'),
      releaseDueAt: null,
    });
  });

  it('R-OWN-15 E9: the SLA across a fall-back transition counts elapsed time', () => {
    const d = firstTouchDeadlines({ ownedAt: at('2026-11-01T01:50:00-04:00'), settings: SETTINGS, calendar: H24('America/New_York'), nextContactableAt: (t) => t });
    expect(d.firstTouchDueAt).toBe(at('2026-11-01T01:05:00-05:00'));
  });

  it('R-OWN-15: deadlines are monotonic in the start instant (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: at('2026-01-01T00:00:00Z'), max: at('2027-12-31T00:00:00Z') }), fc.integer({ min: 0, max: 3 * 86_400_000 }), (a, delta) => {
        const s = { ...SETTINGS };
        const f = (t: number) => firstTouchDeadlines({ ownedAt: instant(t), settings: s, calendar: CAL, nextContactableAt: (x) => x });
        const x = f(a);
        const y = f(a + delta);
        expect(y.firstTouchDueAt).toBeGreaterThanOrEqual(x.firstTouchDueAt);
        expect(x.releaseDueAt as number).toBeGreaterThan(x.firstTouchDueAt);
      }),
      { numRuns: 300 },
    );
  });
});

describe('inactivity deadlines (R-OWN-23)', () => {
  it('R-OWN-23 E9: 30 tenant-zone calendar days keep the local wall time across DST; the warning is 72 elapsed hours before', () => {
    const from = at('2026-10-20T10:00:00-04:00');
    const d = inactivityDeadlines({ from, settings: SETTINGS, zone: NY, stage: 'attempting' });
    expect(d.releaseAt).toBe(at('2026-11-19T10:00:00-05:00'));
    expect(d.warnAt).toBe(plusMs(at('2026-11-19T10:00:00-05:00'), -72 * HOUR_MS));
    expect(inactivityDeadlines({ from, settings: SETTINGS, zone: zone('America/Phoenix') }).releaseAt).toBe(at('2026-11-19T10:00:00-04:00'));
  });

  it('R-OWN-23: none when disabled, with an open deal, or past new/attempting', () => {
    const none = { warnAt: null, releaseAt: null };
    expect(inactivityDeadlines({ from: T0, settings: { ...SETTINGS, inactivityReleaseDays: null }, zone: NY })).toEqual(none);
    expect(inactivityDeadlines({ from: T0, settings: SETTINGS, zone: NY, dealOpen: true })).toEqual(none);
    for (const stage of ['connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const) {
      expect(inactivityDeadlines({ from: T0, settings: SETTINGS, zone: NY, stage })).toEqual(none);
      expect(inactivityApplies(SETTINGS, stage, false)).toBe(false);
    }
    expect(inactivityApplies(SETTINGS, 'new', false)).toBe(true);
    expect(inactivityApplies(SETTINGS, undefined, undefined)).toBe(true);
  });
});

describe('stored deadlines never move (R-OWN-15, E10)', () => {
  it('R-OWN-15 E10: after a tenant timezone / hours change, an open offer still expires at its stored instant; new offers use the new calendar', () => {
    const l = offeredLead(U.a);
    const stored = l.p.offerExpiresAt as Instant;
    const la = businessCalendar({ zone: 'America/Los_Angeles', open: '10:00', close: '12:00' });
    const fence = { offerId: l.p.offerId as string };
    const early = decide(l.p, { kind: 'timer', deadline: 'offer_expiry', fence }, ctx({ now: plusMs(stored, -1), actor: systemActor('timer'), calendar: la, settings: { ...SETTINGS, offerWindowSeconds: 3600 } }));
    expect(early.ok && early.events).toEqual([]);
    expect(early.effects[0]).toMatchObject({ kind: 'enqueueTimer', runAt: stored });
    const accept = decide(l.p, { kind: 'accept', offerId: fence.offerId }, ctx({ now: plusMs(stored, -1), actor: userActor(U.a), actorMember: member(U.a), calendar: la }));
    expect(accept.ok).toBe(true);
    const fire = l.run({ kind: 'timer', deadline: 'offer_expiry', fence }, { now: stored, actor: systemActor('timer'), calendar: la, routing: { rule: rule(), candidates: [candidate(U.b)], cursor: {}, alreadyOffered: [U.a] } });
    expect(fire.ok && fire.events.map((e) => e.type)).toEqual(['offer_expired', 'offered']);
    // the new offer uses the calendar in force now: 10:00 LA opening
    expect(l.p.offerExpiresAt).toBe(at('2026-11-10T10:05:00-08:00'));
  });
});

describe('timer plumbing', () => {
  it('dedupe keys and fences are ids and instants only (R-TEN-7)', () => {
    const t = slaTimers(C1, { periodSeq: 3, firstTouchDueAt: T0, releaseDueAt: plusMs(T0, 1) });
    expect(t.map((e) => e.kind === 'enqueueTimer' && e.dedupeKey)).toEqual([`ownership.first_touch_breach:${C1}:3`, `ownership.auto_release:${C1}:3`]);
    expect(slaTimers(C1, { periodSeq: null, firstTouchDueAt: T0, releaseDueAt: null })).toEqual([]);
    expect(periodTimerKeys(C1, null)).toEqual([]);
    expect(periodTimerKeys(C1, 2, { warnAt: T0, releaseAt: null })).toHaveLength(3);
    for (const deadline of ['offer_expiry', 'first_touch_breach', 'auto_release', 'inactivity_warn', 'inactivity_release'] as const) {
      const fence = deadline === 'offer_expiry' ? { offerId: 'o1' } : { periodSeq: 4, dueAt: T0 };
      const e = rescheduleTimer(C1, deadline, fence, T0, plusMs(T0, -5));
      expect(e).toMatchObject({ kind: 'enqueueTimer', runAt: T0, fence: { contactId: C1, deadline } });
      if (e.kind === 'enqueueTimer') {
        expect(e.jobKind).toMatch(/^ownership\.[a-z_]+$/);
        expect(e.dedupeKey).toContain(':early:');
      }
    }
  });
});
