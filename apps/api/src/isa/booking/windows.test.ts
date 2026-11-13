// Pure units of isa/booking/windows.ts (R-ISA-13; Q2). VERIFY: the defaults are engineering choices.
import { describe, expect, it } from 'vitest';
import type { IanaZone, Instant } from '@realty/core/foundation';
import { aiIsaSendWindow, confirmationInTime } from '../coreSeam.js';
import { capsClearAt, nextSendAt, offerWindows } from './windows.js';

const H = 3600;
describe('offerWindows (Q2)', () => {
  it('R-ISA-13: opt-in windows are clipped to routing hours; nothing outside survives', () => {
    expect(offerWindows([{ weekday: 2, start: '07:00', end: '22:00' }, { weekday: 3, start: '21:30', end: '23:00' }], { startSec: 8 * H, endSec: 21 * H }))
      .toEqual([{ weekday: 2, startSec: 8 * H, endSec: 21 * H }]);
  });
  it('R-ISA-13: with no opt-in windows, routing hours Monday to Friday', () => {
    expect(offerWindows([], { startSec: 9 * H, endSec: 17 * H }).map((w) => w.weekday)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('capsClearAt and nextSendAt (R-ISA-13: caps in confirmationInTime)', () => {
  const now = 1_800_000_000_000 as Instant;
  const ago = (m: number) => (now - m * 60_000) as Instant;
  it('R-ISA-13: below the cap → now; at the cap → when the oldest counted one ages out', () => {
    expect(capsClearAt([ago(60), ago(30)], 3, now)).toBe(now);
    expect(capsClearAt([ago(60), ago(30), ago(10)], 3, now)).toBe(ago(60) + 86_400_000);
  });
  it('R-ISA-13: the latest of the window, the caps and the gap', () => {
    const caps = { ai24h: 3, automated24h: 3, minGapSeconds: 120 };
    const open = (at: Instant) => at;
    expect(nextSendAt({ now, windowAt: open, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: ago(1) })).toBe(ago(1) + 120_000);
    expect(nextSendAt({ now, windowAt: (at) => Math.max(at, now + 3_600_000) as Instant, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBe(now + 3_600_000);
    expect(nextSendAt({ now, windowAt: open, aiSentAt: [ago(100), ago(90), ago(80)], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBe(ago(100) + 86_400_000);
    expect(nextSendAt({ now, windowAt: () => null, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBeNull();
  });

  // batch 13 audit ISA2B-02: the send window is checked at the instant the caps clear, not only at `now`
  it('R-ISA-13: caps that clear after the window closes wait for the next window opening, so a slot early the next morning is not in time', () => {
    const zone = 'America/New_York' as IanaZone;
    const caps = { ai24h: 3, automated24h: 3, minGapSeconds: 120 };
    const windowAt = (at: Instant) => aiIsaSendWindow({ at, zones: [zone], startSec: 8 * H, endSec: 20 * H, initiated: false, initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true });
    // Tuesday 2026-11-10 15:00 New York (UTC-5); three automated sends at 20:30 the evening before clear at 20:30 tonight
    const tue1500 = Date.parse('2026-11-10T20:00:00Z') as Instant;
    const mon2030 = Date.parse('2026-11-10T01:30:00Z') as Instant;
    const next = nextSendAt({ now: tue1500, windowAt, aiSentAt: [], automatedSentAt: [mon2030, mon2030, mon2030], caps, lastAiOutboundAt: null });
    // 20:30 is after the 20:00 close: the confirmation waits for 08:00 Wednesday (13:00Z)
    expect(new Date(next!).toISOString()).toBe('2026-11-11T13:00:00.000Z');
    // a 09:00 Wednesday slot needs a confirmation by 05:00: not in time (before the fix, 20:30 Tuesday said it was)
    const slot = { startsAt: Date.parse('2026-11-11T14:00:00Z') as Instant, endsAt: Date.parse('2026-11-11T14:30:00Z') as Instant };
    expect(confirmationInTime({ slot, nextSendAt: next, minNoticeHours: 4 })).toBe(false);
    // a 13:00 Wednesday slot is in time (08:00 + 4 h ≤ 13:00)
    expect(confirmationInTime({ slot: { startsAt: (slot.startsAt + 4 * 3_600_000) as Instant, endsAt: (slot.endsAt + 4 * 3_600_000) as Instant }, nextSendAt: next, minNoticeHours: 4 })).toBe(true);
  });

  it('R-ISA-13: a minimum gap that ends after the window closes also waits for the next opening', () => {
    const zone = 'America/New_York' as IanaZone;
    const caps = { ai24h: 3, automated24h: 3, minGapSeconds: 120 };
    const windowAt = (at: Instant) => aiIsaSendWindow({ at, zones: [zone], startSec: 8 * H, endSec: 20 * H, initiated: false, initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true });
    // Tuesday 19:59:30 New York; the last AI message went out a second ago, so the gap ends at 20:01:29
    const now = Date.parse('2026-11-11T00:59:30Z') as Instant;
    expect(new Date(nextSendAt({ now, windowAt, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: (now - 1000) as Instant })!).toISOString()).toBe('2026-11-11T13:00:00.000Z');
  });
});
