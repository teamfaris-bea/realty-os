// module 46 (R-PORTALWEB-5, E690): a LocalDate is its calendar date in every zone, exactly as the staff formatter.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatLocalDate as staffFormat } from '../../surfaces/feed/lib/format.js';
import { formatLocalDate, formatShared } from './dates.js';

const ZONES = ['Pacific/Honolulu', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC', 'Pacific/Kiritimati'];
const realDTF = Intl.DateTimeFormat;

afterEach(() => {
  vi.restoreAllMocks();
});

/** Runs fn as if the viewer's default zone were `zone` (Intl without a timeZone option). */
function inZone<T>(zone: string, fn: () => T): T {
  const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (this: unknown, locale?: string | string[], o?: Intl.DateTimeFormatOptions) {
    return new realDTF(locale, { timeZone: zone, ...o });
  } as never);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

describe('view/dates.ts (E690)', () => {
  it('E690: 2026-12-18 reads "Dec 18, 2026" under Honolulu, Los Angeles and Tokyo, and equals the staff formatter', () => {
    for (const z of ZONES) {
      expect(inZone(z, () => formatLocalDate('2026-12-18')), z).toBe('Dec 18, 2026');
      expect(inZone(z, () => formatLocalDate('2026-01-01')), z).toBe('Jan 1, 2026');
      expect(inZone(z, () => formatLocalDate('2026-12-18')), z).toBe(inZone(z, () => staffFormat('2026-12-18')));
    }
    expect(formatLocalDate('not a date')).toBe('not a date');
    // the zone switch is real: an instant moves with it (so the LocalDate above held in each zone)
    expect(inZone('Asia/Tokyo', () => formatShared('2026-11-13T03:00:00.000Z'))).toBe('Nov 13, 2026');
    expect(inZone('Pacific/Honolulu', () => formatShared('2026-11-13T03:00:00.000Z'))).toBe('Nov 12, 2026');
  });

  it('"Shared {date}" is the instant in the viewer\'s zone', () => {
    expect(formatShared('2026-11-13T03:00:00.000Z', 'America/Los_Angeles')).toBe('Nov 12, 2026');
    expect(formatShared('2026-11-13T03:00:00.000Z', 'Asia/Tokyo')).toBe('Nov 13, 2026');
    expect(formatShared('nope')).toBe('nope');
  });
});
