// Module 48 item 3: offered slots (product defaults; E151).
import { at, businessCalendar } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { MAX_OFFERED_SLOTS, freeSlots } from './slots.js';

const HOURS = businessCalendar({ zone: 'America/New_York', open: '08:00', close: '21:00' });

describe('E151 R-VOICE-4: the slots an AI call may offer', () => {
  it('E151: up to 6 half-hour slots, 2 h ahead at the earliest, inside routing hours, skipping busy times', () => {
    const now = at('2026-11-10T14:10:00-05:00');
    const busy = [{ start: '2026-11-10T21:00:00Z', end: '2026-11-10T22:00:00Z' }];
    const s = freeSlots(now, HOURS, busy);
    expect(s).toHaveLength(MAX_OFFERED_SLOTS);
    expect(new Date(s[0]!.start).toISOString()).toBe('2026-11-10T22:00:00.000Z'); // 17:00 local: the 16:30 slot is busy
    for (const x of s) {
      expect(x.end - x.start).toBe(30 * 60_000);
      expect(x.start).toBeGreaterThanOrEqual(now + 2 * 3600_000);
      expect(busy.some((b) => Date.parse(b.start) < x.end && Date.parse(b.end) > x.start)).toBe(false);
    }
  });

  it('R-VOICE-4: late in the evening the first slots are the next morning; never a 3 a.m. slot', () => {
    const s = freeSlots(at('2026-11-10T20:00:00-05:00'), HOURS, []);
    expect(new Date(s[0]!.start).toISOString()).toBe('2026-11-11T13:00:00.000Z'); // 08:00 local
    for (const x of s) expect(new Date(x.start).getUTCHours()).not.toBe(8); // 03:00 local
  });
});
