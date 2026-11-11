import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, at, instant, zone } from '../foundation/index.js';
import { parseLicensePack } from './licence.js';
import { feedStale, isNewerModification, staleNotice } from './staleness.js';
import { REVIEWED_PACK } from './testing/fixtures.js';

const now = at('2026-11-11T15:00:00Z');
const ago = (ms: number) => instant(now - ms);

describe('feedStale', () => {
  it('R-MLS-3 E85: feed down for three days is stale and pauses MLS-sourced output', () => {
    expect(feedStale(ago(3 * DAY_MS), now, REVIEWED_PACK)).toBe(true);
    expect(feedStale(ago(3 * DAY_MS), now, parseLicensePack({ ...{ max_staleness_hours: 48 } }))).toBe(true);
  });

  it('R-MLS-3: exactly at the threshold is fresh; one millisecond over is stale', () => {
    expect(feedStale(ago(24 * HOUR_MS), now, REVIEWED_PACK)).toBe(false);
    expect(feedStale(ago(24 * HOUR_MS + 1), now, REVIEWED_PACK)).toBe(true);
    expect(feedStale(ago(HOUR_MS), now, REVIEWED_PACK)).toBe(false);
    expect(feedStale(instant(now + HOUR_MS), now, REVIEWED_PACK)).toBe(false); // clock skew: a sync "in the future" is not stale
  });

  it('R-MLS-3: a feed that never synced, or a pack without a staleness limit, is stale', () => {
    expect(feedStale(null, now, REVIEWED_PACK)).toBe(true);
    expect(feedStale(ago(1), now, parseLicensePack({}))).toBe(true);
    expect(feedStale(ago(30 * 60_000), now, parseLicensePack({ max_staleness_hours: 0.5 }))).toBe(false);
  });
});

describe('staleNotice', () => {
  it('R-MLS-3 E85: the UI says "MLS data as of …" in the team zone', () => {
    expect(staleNotice(ago(3 * DAY_MS), zone('America/Chicago'))).toBe('MLS data as of Nov 8, 2026, 9:00 AM CST');
    expect(staleNotice(at('2026-07-04T18:30:00Z'), zone('America/Los_Angeles'))).toBe('MLS data as of Jul 4, 2026, 11:30 AM PDT');
  });

  it('R-MLS-3: a feed that never synced says so', () => {
    expect(staleNotice(null, zone('America/Chicago'))).toBe('MLS data not received yet');
  });
});

describe('isNewerModification', () => {
  it('R-MLS-1 E141: an older modification never overwrites a newer one; an equal one is skipped', () => {
    const stored = at('2026-11-01T12:00:00Z');
    expect(isNewerModification(stored, at('2026-11-01T11:59:59Z'))).toBe(false);
    expect(isNewerModification(stored, stored)).toBe(false);
    expect(isNewerModification(stored, at('2026-11-01T12:00:00.001Z'))).toBe(true);
    expect(isNewerModification(null, stored)).toBe(true);
  });
});
