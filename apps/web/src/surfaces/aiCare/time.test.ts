// R-ISA-29 E511: times in the viewer's zone with its short name; "their time" only for an explicit zone; a union says
// what its time means; never "UTC" from the API's sentences; DST handled by Intl.
import { describe, expect, it } from 'vitest';
import { capsWords, localTime, scheduledWords, zonesWords } from './time.js';

const NOW = Date.parse('2026-11-13T14:00:00Z');

describe('time words (R-ISA-29, E511)', () => {
  it('R-ISA-29 E511: an explicit zone shows the viewer time and their time', () => {
    const s = scheduledWords('2026-11-13T15:00:00Z', { zones: ['America/Chicago'], source: 'explicit' }, { tz: 'America/New_York', now: NOW });
    expect(s).toBe('Next AI message planned for 10:00 AM EST (9:00 AM CST, their time).');
  });

  it('R-ISA-29 E511 Q7: a union says the earliest time outside quiet hours, never "their time" (Pacific/Honolulu included)', () => {
    const s = scheduledWords('2026-11-13T17:00:00Z', { zones: ['America/New_York', 'Pacific/Honolulu'], source: 'union' }, { tz: 'America/New_York', now: NOW });
    expect(s).toBe('Next AI message planned for 12:00 PM EST, the earliest time outside quiet hours in every time zone they may be in.');
    expect(s).not.toMatch(/their time/);
    expect(s).toMatch(/outside quiet hours/);
  });

  it('R-ISA-29 E511: under a hold it adds ", if sending is allowed then"', () => {
    expect(scheduledWords('2026-11-13T15:00:00Z', { zones: ['America/Chicago'], source: 'explicit' }, { tz: 'America/New_York', now: NOW, hold: true })).toMatch(/their time\), if sending is allowed then\.$/);
  });

  it('R-ISA-29 E511: a scheduled reply across the DST change keeps each side in its own offset, and never says UTC', () => {
    // 2026-11-01 is the US fall-back; Phoenix has no DST
    const before = '2026-10-31T16:00:00Z';
    const after = '2026-11-02T16:00:00Z';
    const now = Date.parse('2026-10-30T12:00:00Z');
    const a = scheduledWords(before, { zones: ['America/Phoenix'], source: 'explicit' }, { tz: 'America/Los_Angeles', now });
    const b = scheduledWords(after, { zones: ['America/Phoenix'], source: 'explicit' }, { tz: 'America/Los_Angeles', now });
    expect(a).toMatch(/9:00 AM PDT .*9:00 AM MST, their time/);
    expect(b).toMatch(/8:00 AM PST .*9:00 AM MST, their time/);
    for (const s of [a, b]) expect(s).not.toMatch(/UTC/);
  });

  it('a time not today carries its day', () => {
    expect(localTime('2026-11-15T15:00:00Z', 'America/New_York', NOW)).toBe('Sun, Nov 15, 10:00 AM EST');
  });

  it('capsWords: "N of M today" is said as the rolling 24 hours it counts (V6); anything else passes through', () => {
    expect(capsWords('2 of 6 today')).toBe('2 of 6 AI messages in the last 24 hours');
    expect(capsWords('Something else')).toBe('Something else');
  });

  it("quiet hours in words never repeat the API's fixed window", () => {
    const u = zonesWords({ zones: ['America/New_York', 'America/Los_Angeles'], source: 'union' });
    expect(u).not.toMatch(/12:00|Eastern/);
    expect(zonesWords({ zones: ['America/Chicago'], source: 'explicit' })).toMatch(/America\/Chicago/);
  });
});
