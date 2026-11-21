import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { intentOf, nearestActionableCue, scannedSegments, timingCues, timingWindows } from './index.js';
import { CALL_AT, STEREO_CALL, scan, seg } from './testing/fixtures.js';

const months = (text: string, when = CALL_AT) => timingWindows(text, when).map((w) => w.months);

describe('timing windows (call on 21 Nov 2026)', () => {
  it('relative phrases', () => {
    expect(months('we want to move in 3 months')).toEqual([3]);
    expect(months('in a couple of months')).toEqual([2]);
    expect(months('in about two years')).toEqual([24]);
    expect(months('in a few weeks')).toEqual([0]);
    expect(months('as soon as possible')).toEqual([0]);
  });

  it('months and seasons count from the call, rolling into next year', () => {
    expect(months('by March')).toEqual([4]);
    expect(months('in December')).toEqual([1]);
    expect(months('around November')).toEqual([0]);
    expect(months('late June 2027')).toEqual([7]);
    expect(months('next spring')).toEqual([4]);
    expect(months('this summer')).toEqual([7]);
    expect(months('next year')).toEqual([2]);
    expect(months('end of the year')).toEqual([1]);
  });

  it('"next spring" said in spring means a year out', () => {
    expect(months('next spring', at('2026-03-10T12:00:00Z'))).toEqual([12]);
  });

  it('text with no timing has no window', () => {
    expect(months('call me back whenever')).toEqual([]);
    expect(months('the may flowers')).toEqual([]);
  });
});

describe('intent', () => {
  it('buy, sell, both, move, none and negation', () => {
    expect(intentOf('we want to buy a place')).toBe('buy');
    expect(intentOf('thinking about selling')).toBe('sell');
    expect(intentOf('sell ours and buy bigger')).toBe('both');
    expect(intentOf('we are moving for work')).toBe('unclear');
    expect(intentOf('the weather is nice')).toBeNull();
    expect(intentOf("we're not going to sell")).toBeNull();
  });
});

describe('timing cues from a call transcript', () => {
  it('reads only the client channel when the recording separates speakers', () => {
    expect(scannedSegments(STEREO_CALL).every((s) => s.speaker === 'client')).toBe(true);
    const mono = STEREO_CALL.map((s) => ({ ...s, speaker: null }));
    expect(scannedSegments(mono)).toHaveLength(STEREO_CALL.length);
  });

  it('pairs a timing phrase with the intent the same speaker stated just before', () => {
    const cues = timingCues(scan(STEREO_CALL));
    const sell = cues.find((c) => c.intent === 'sell');
    expect(sell).toMatchObject({ quote: 'Probably by March, once the orders come through.', startMs: 7_000, endMs: 10_000, horizonMonths: 4, withinSixMonths: true, leaseContext: false });
  });

  it('lease talk is flagged and never counts as an actionable buy cue (the pilot false positive)', () => {
    const cues = timingCues(scan(STEREO_CALL));
    const lease = cues.find((c) => c.leaseContext);
    expect(lease).toMatchObject({ intent: 'unclear', withinSixMonths: false });
    expect(nearestActionableCue(cues)?.intent).toBe('sell');
  });

  it("the agent's own words are not a cue when the client's channel is known", () => {
    const cues = timingCues(scan([seg('agent', 'Are you buying next month?'), seg('client', 'Maybe, not sure.')]));
    expect(cues).toEqual([]);
  });

  it('a mono recording is scanned whole and picks the nearest window', () => {
    const cues = timingCues(scan([seg(null, 'We are looking for a home, ideally in 2 months, at the latest by June.')]));
    expect(cues).toHaveLength(1);
    expect(cues[0]).toMatchObject({ intent: 'buy', horizonMonths: 2, withinSixMonths: true });
  });

  it('a window beyond six months is a cue but not actionable', () => {
    const cues = timingCues(scan([seg(null, 'We plan to sell in two years.')]));
    expect(cues[0]).toMatchObject({ intent: 'sell', horizonMonths: 24, withinSixMonths: false });
    expect(nearestActionableCue(cues)).toBeNull();
  });

  it('timing without any buy, sell or move statement is not a cue', () => {
    expect(timingCues(scan([seg(null, 'Call me back next month about the HOA meeting.')]))).toEqual([]);
  });

  it('an empty transcript has no cues', () => {
    expect(timingCues(scan([]))).toEqual([]);
    expect(nearestActionableCue([])).toBeNull();
  });
});
