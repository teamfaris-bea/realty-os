import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HOUR_MS, type Instant, at, instant, localSecondsOf, weekdayOf } from '../foundation/index.js';
import { computeOffer, confirmationInTime, displayZones, formatSlot, matchSlotChoice, renderConfirmation, renderOffer, slotLine, zoneLabel, type OfferInput } from './slots.js';
import { CHI, LA, NY } from './testing/fixtures.js';
import type { IsaSlot } from './types.js';
import { CONTINENTAL_ZONES } from './zones.js';
import { runs } from './testing/runs.js';

// Thu 2026-11-12 14:00 UTC = 09:00 ET
const NOW = at('2026-11-12T14:00:00Z');
const WEEKDAYS = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startSec: 9 * 3600, endSec: 17 * 3600 }));
const input = (o: Partial<OfferInput> = {}): OfferInput => ({ now: NOW, agentZone: NY, availability: WEEKDAYS, busy: [], clientZones: [NY], inactivityReleaseAt: null, ...o });

describe('R-ISA-13 computeOffer', () => {
  it('up to 3 slots on different half-days, after the minimum notice, inside availability', () => {
    const o = computeOffer(input())!;
    expect(o.slots).toHaveLength(3);
    // first: Thu 13:00 ET (09:00 + 4 h notice), then Fri morning, Fri afternoon
    expect(o.slots[0]!.startsAt).toBe(at('2026-11-12T18:00:00Z'));
    expect(o.slots[1]!.startsAt).toBe(at('2026-11-13T14:00:00Z'));
    expect(o.slots[2]!.startsAt).toBe(at('2026-11-13T17:00:00Z'));
    for (const s of o.slots) expect(s.endsAt - s.startsAt).toBe(30 * 60_000);
    // expiry: the first slot's notice time (09:00 ET) is earlier than 24 h
    expect(o.expiresAt).toBe(NOW);
  });
  it('the busy set widened by the buffer, and nothing after inactivity_release_at', () => {
    const busy: IsaSlot[] = [{ startsAt: at('2026-11-12T18:00:00Z'), endsAt: at('2026-11-12T18:30:00Z') }];
    const o = computeOffer(input({ busy }))!;
    expect(o.slots[0]!.startsAt).toBe(at('2026-11-12T19:00:00Z'));
    const cut = computeOffer(input({ inactivityReleaseAt: at('2026-11-13T00:00:00Z') }))!;
    expect(cut.slots).toHaveLength(1);
    expect(computeOffer(input({ inactivityReleaseAt: NOW }))).toBeNull();
  });
  it('the client window applies in EVERY client zone (08:00–20:00): an LA client gets no 09:00 ET slot', () => {
    const o = computeOffer(input({ clientZones: [NY, LA], minNoticeHours: 0, now: at('2026-11-13T13:00:00Z') }))!;
    for (const s of o.slots) expect(localSecondsOf(s.startsAt, LA)).toBeGreaterThanOrEqual(8 * 3600);
    expect(o.slots[0]!.startsAt).toBe(at('2026-11-13T16:00:00Z'));
  });
  it('none fits: no availability, no zones, zero slots, or the horizon passed', () => {
    expect(computeOffer(input({ availability: [] }))).toBeNull();
    expect(computeOffer(input({ clientZones: [] }))).toBeNull();
    expect(computeOffer(input({ maxSlots: 0 }))).toBeNull();
    expect(computeOffer(input({ horizonDays: 0 }))).toBeNull();
  });
  it('the 24 h ttl when the first slot is far away', () => {
    const o = computeOffer(input({ availability: [{ weekday: 3, startSec: 9 * 3600, endSec: 10 * 3600 }] }))!;
    expect(o.expiresAt).toBe(instant(NOW + 24 * HOUR_MS));
  });
  it('property: every slot is free, inside the agent window, after notice, before the horizon, on distinct half-days', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 60 * 24 * 20 }), fc.array(fc.integer({ min: 0, max: 14 * 24 * 2 }), { maxLength: 6 }), (offsetMin, busyHalfHours) => {
        const now = instant(at('2026-03-02T05:00:00Z') + offsetMin * 60_000);
        const busy = busyHalfHours.map((h) => ({ startsAt: instant(now + h * 30 * 60_000), endsAt: instant(now + h * 30 * 60_000 + 60 * 60_000) }));
        const o = computeOffer(input({ now, busy, clientZones: CONTINENTAL_ZONES }));
        if (o === null) return;
        const halves = new Set<string>();
        for (const s of o.slots) {
          expect(s.startsAt >= now + 4 * HOUR_MS).toBe(true);
          expect(s.endsAt <= now + 14 * 24 * HOUR_MS).toBe(true);
          expect([1, 2, 3, 4, 5]).toContain(weekdayOf(s.startsAt, NY));
          const sec = localSecondsOf(s.startsAt, NY);
          expect(sec >= 9 * 3600 && sec + 1800 <= 17 * 3600).toBe(true);
          for (const b of busy) expect(s.startsAt < b.endsAt + 15 * 60_000 && b.startsAt - 15 * 60_000 < s.endsAt).toBe(false);
          halves.add(`${new Date(s.startsAt - 5 * HOUR_MS).toISOString().slice(0, 10)}${sec < 43200}`);
        }
        expect(halves.size).toBe(o.slots.length);
      }),
      { numRuns: runs(200) },
    );
  });
});

const S1: IsaSlot = { startsAt: at('2026-11-17T20:00:00Z'), endsAt: at('2026-11-17T20:30:00Z') }; // Tue 3:00 PM ET
const S2: IsaSlot = { startsAt: at('2026-11-18T15:00:00Z'), endsAt: at('2026-11-18T15:30:00Z') }; // Wed 10:00 AM ET
const S3: IsaSlot = { startsAt: at('2026-11-17T15:00:00Z'), endsAt: at('2026-11-17T15:30:00Z') }; // Tue 10:00 AM ET
const SLOTS = [S1, S2, S3];

describe('R-ISA-13 rendering', () => {
  it('formats with the zone label, both zones when they differ', () => {
    expect(formatSlot(S1, NY)).toBe('Tue Nov 17, 3:00–3:30 PM ET');
    expect(slotLine(0, S1, displayZones(NY, LA))).toBe('1) Tue Nov 17, 3:00–3:30 PM ET (12:00–12:30 PM PT)');
    expect(displayZones(NY, NY)).toEqual([NY]);
    expect(displayZones(NY, null)).toEqual([NY]);
    expect(zoneLabel(CHI, S1.startsAt)).toBe('CT');
    expect(zoneLabel('Pacific/Guam' as never, S1.startsAt)).toMatch(/GMT\+10|ChST/);
    const across: IsaSlot = { startsAt: at('2026-11-17T16:45:00Z'), endsAt: at('2026-11-17T17:15:00Z') };
    expect(formatSlot(across, NY)).toBe('Tue Nov 17, 11:45 AM–12:15 PM ET');
  });
  it('the offer and the confirmation are server text with no model text', () => {
    const body = renderOffer({ slots: SLOTS, agentFirstName: 'Avery', zones: [NY], kindLabel: 'buyer consultation' });
    expect(body).toBe('Here are times Avery is free for a buyer consultation:\n1) Tue Nov 17, 3:00–3:30 PM ET\n2) Wed Nov 18, 10:00–10:30 AM ET\n3) Tue Nov 17, 10:00–10:30 AM ET\nReply with the number that works for you.');
    expect(renderConfirmation({ slot: S1, agentFirstName: 'Avery', zones: [NY], kindLabel: 'buyer consultation' })).toBe("You're set with Avery on Tue Nov 17, 3:00–3:30 PM ET (buyer consultation). Avery will confirm the details.");
  });
  it('a confirmation must be sendable ahead of the slot\'s notice', () => {
    expect(confirmationInTime({ slot: S1, nextSendAt: at('2026-11-17T14:00:00Z') })).toBe(true);
    expect(confirmationInTime({ slot: S1, nextSendAt: at('2026-11-17T17:00:00Z') })).toBe(false);
    expect(confirmationInTime({ slot: S1, nextSendAt: null })).toBe(false);
  });
});

describe('R-ISA-13 E528 E529 matchSlotChoice', () => {
  const m = (t: string, o?: { reaction?: boolean }) => matchSlotChoice(t, SLOTS, [NY], o);
  it('E528 an index: "2", "#2", "option 2", "the second one", "2 works"', () => {
    for (const t of ['2', '#2', 'option 2', 'the second one', '2 works', '2 please', 'number 2', 'two']) expect(m(t)).toEqual({ kind: 'unique', index: 1 });
    expect(m('1.')).toEqual({ kind: 'unique', index: 0 });
  });
  it('a weekday AND a time, or a date AND a time', () => {
    expect(m('Wednesday at 10 works')).toEqual({ kind: 'unique', index: 1 });
    expect(m('tue 3pm')).toEqual({ kind: 'unique', index: 0 });
    expect(m('Nov 17 at 10:00 am')).toEqual({ kind: 'unique', index: 2 });
    expect(m('11/18 10:00')).toEqual({ kind: 'unique', index: 1 });
  });
  it('E529 not agreement: "Tuesday works" with two Tuesday slots, a reaction, "yes" with several open, a different time', () => {
    expect(m('Tuesday works')).toEqual({ kind: 'ambiguous', reason: 'weekday_only' });
    expect(m('👍', { reaction: true })).toEqual({ kind: 'ambiguous', reason: 'reaction' });
    expect(m('yes')).toEqual({ kind: 'ambiguous', reason: 'several_open' });
    expect(m('can we do Tuesday at 5?')).toEqual({ kind: 'ambiguous', reason: 'no_match' });
    expect(m('around 4pm')).toEqual({ kind: 'ambiguous', reason: 'no_match' });
    expect(m('sometime Tuesday')).toEqual({ kind: 'ambiguous', reason: 'weekday_only' });
    expect(m('1 or 2')).toEqual({ kind: 'ambiguous', reason: 'several_indexes' });
    expect(m('none of those work')).toEqual({ kind: 'ambiguous', reason: 'declined' });
    expect(m("2 doesn't work")).toEqual({ kind: 'ambiguous', reason: 'declined' });
    expect(m('5')).toEqual({ kind: 'ambiguous', reason: 'no_match' });
  });
  it('an index that disagrees with the named time is not agreement', () => {
    expect(m('option 1, Wednesday at 10')).toEqual({ kind: 'ambiguous', reason: 'several_match' });
  });
  it('"yes" with exactly one slot is agreement; unrelated text is none', () => {
    expect(matchSlotChoice('yes', [S1], [NY])).toEqual({ kind: 'unique', index: 0 });
    expect(m('what neighborhoods do you cover')).toEqual({ kind: 'none' });
    expect(matchSlotChoice('2', [], [NY])).toEqual({ kind: 'none' });
    expect(m('   ')).toEqual({ kind: 'none' });
  });
  it('the display zone matters: "Tue 12:00" matches slot 1 for a client shown PT', () => {
    expect(matchSlotChoice('tue 12:00 pm', SLOTS, [NY, LA])).toEqual({ kind: 'unique', index: 0 });
    expect(matchSlotChoice('tue 12:00 pm', SLOTS, [NY])).toEqual({ kind: 'ambiguous', reason: 'no_match' });
  });
  it('property: a unique match always names an offered slot index', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (t) => {
        const r = matchSlotChoice(t, SLOTS, [NY]);
        if (r.kind === 'unique') expect(r.index >= 0 && r.index < SLOTS.length).toBe(true);
      }),
      { numRuns: runs(500) },
    );
  });
  void ({} as Instant);
});
