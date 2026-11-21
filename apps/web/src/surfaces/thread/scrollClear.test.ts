import { describe, expect, it } from 'vitest';
import { type Box, scrollDeltaToClear, targetClears, targetHasRoom, unobscuredHeight } from './scrollClear.js';

const header: Box = { top: 0, right: 390, bottom: 52, left: 0 };
const whyAt = (top: number, height = 44, left = 300, width = 59.25): Box => ({ top, bottom: top + height, left, right: left + width });

describe('thread scroll clear of sticky chrome', () => {
  it('a Why button whose centre is under the 52px header, with 6px sticking out, is not a 24px target', () => {
    const why = whyAt(14);
    expect(unobscuredHeight(why, [header])).toBeCloseTo(6);
    expect(targetClears(why, [header])).toBe(false);
  });

  it('the same button scrolled to y≈-34 keeps a 34px run above the header, so it already clears', () => {
    const why = whyAt(-34);
    expect(unobscuredHeight(why, [header])).toBeCloseTo(34);
    expect(targetClears(why, [header])).toBe(true);
    expect(scrollDeltaToClear([why], [header])).toBe(0);
  });

  it('nudges a sliver under the header until the unobscured run is at least 24px, and leaves a button that already clears', () => {
    const sliver = whyAt(14);
    const parked = whyAt(-34);
    const delta = scrollDeltaToClear([sliver, parked], [header]);
    expect(delta).not.toBe(0);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(targetHasRoom(moved(sliver), [header])).toBe(true);
    expect(targetHasRoom(moved(parked), [header])).toBe(true);
  });

  it('a Why button fully inside the header is not nudged (nothing of it can be hit)', () => {
    expect(targetClears(whyAt(0, 44), [header])).toBe(true);
    expect(scrollDeltaToClear([whyAt(4, 40)], [header])).toBe(0);
  });

  it('pulls a Why button out from under the compose bar without parking another one under the header', () => {
    const composer: Box = { top: 700, right: 390, bottom: 844, left: 0 };
    const early = whyAt(20);
    const latest = whyAt(680);
    expect(targetClears(latest, [header, composer])).toBe(false);
    const delta = scrollDeltaToClear([early, latest], [header, composer]);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(targetHasRoom(moved(early), [header, composer])).toBe(true);
    expect(targetHasRoom(moved(latest), [header, composer])).toBe(true);
  });
});
