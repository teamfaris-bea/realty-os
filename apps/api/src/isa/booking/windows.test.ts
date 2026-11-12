// Pure units of isa/booking/windows.ts (R-ISA-13; Q2). VERIFY: the defaults are engineering choices.
import { describe, expect, it } from 'vitest';
import type { Instant } from '@realty/core/foundation';
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
    expect(nextSendAt({ now, windowStart: now, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: ago(1) })).toBe(ago(1) + 120_000);
    expect(nextSendAt({ now, windowStart: (now + 3_600_000) as Instant, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBe(now + 3_600_000);
    expect(nextSendAt({ now, windowStart: now, aiSentAt: [ago(100), ago(90), ago(80)], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBe(ago(100) + 86_400_000);
    expect(nextSendAt({ now, windowStart: null, aiSentAt: [], automatedSentAt: [], caps, lastAiOutboundAt: null })).toBeNull();
  });
});
