import { describe, expect, it } from 'vitest';
import { type Box, type SettleHeights, centerHitsChrome, focusClears, scrollDeltaToClear, settleKey, shouldResettle, targetClears, unobscuredHeight } from './scrollClear.js';

const header: Box = { top: 0, right: 390, bottom: 52, left: 0 };
const whyAt = (top: number, height = 44, left = 300, width = 59.25): Box => ({ top, bottom: top + height, left, right: left + width });

describe('thread scroll clear of sticky chrome', () => {
  it('a Why button whose centre is under the 52px header, with 6px sticking out, is not a 24px target', () => {
    const why = whyAt(14);
    expect(unobscuredHeight(why, [header])).toBeCloseTo(6);
    expect(targetClears(why, [header])).toBe(false);
  });

  it('a 24px run above the header still hides the center, so the control must move', () => {
    const sliver = whyAt(-24);
    expect(unobscuredHeight(sliver, [header])).toBeCloseTo(24);
    expect(targetClears(sliver, [header])).toBe(true);
    expect(centerHitsChrome(sliver, [header], 844)).toBe(true);
    const delta = scrollDeltaToClear([sliver], [header], 24, 844);
    expect(delta).not.toBe(0);
    const moved = { ...sliver, top: sliver.top - delta, bottom: sliver.bottom - delta };
    expect(focusClears(moved, [header], 844)).toBe(true);
  });

  it('nudges a sliver under the header until its center is clear, and leaves a button that already is', () => {
    const sliver = whyAt(14);
    const clear = whyAt(120);
    const delta = scrollDeltaToClear([sliver, clear], [header], 24, 844);
    expect(delta).not.toBe(0);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(focusClears(moved(sliver), [header], 844)).toBe(true);
    expect(focusClears(moved(clear), [header], 844)).toBe(true);
  });

  it('a control fully under the header is moved until its center is clear', () => {
    expect(targetClears(whyAt(4, 40), [header])).toBe(true);
    const buried = whyAt(4, 40);
    const delta = scrollDeltaToClear([buried], [header], 24, 844);
    expect(delta).not.toBe(0);
    const moved = { ...buried, top: buried.top - delta, bottom: buried.bottom - delta };
    expect(centerHitsChrome(moved, [header], 844)).toBe(false);
    expect(focusClears(moved, [header], 844)).toBe(true);
  });

  it('pulls a Why button out from under the compose bar without parking another one under the header', () => {
    const composer: Box = { top: 700, right: 390, bottom: 844, left: 0 };
    const covers = [header, composer];
    const early = whyAt(80);
    const latest = whyAt(680);
    expect(centerHitsChrome(latest, covers, 844)).toBe(true);
    const delta = scrollDeltaToClear([early, latest], covers, 24, 844);
    expect(delta).not.toBe(0);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(focusClears(moved(early), covers, 844)).toBe(true);
    expect(focusClears(moved(latest), covers, 844)).toBe(true);
  });

  it('does not bury a control whose center is already clear', () => {
    const bar: Box = { top: 200, right: 390, bottom: 400, left: 0 };
    const covers = [header, bar];
    const sliver = whyAt(14);
    const keeper = whyAt(80);
    expect(focusClears(keeper, covers, 844)).toBe(true);
    expect(centerHitsChrome(sliver, covers, 844)).toBe(true);
    const delta = scrollDeltaToClear([sliver, keeper], covers, 24, 844);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(focusClears(moved(keeper), covers, 844)).toBe(true);
    if (delta !== 0) expect(focusClears(moved(sliver), covers, 844)).toBe(true);
  });

  it.each([664, 844])('a 44px Download Attachment whose center is under a grown compose bar moves at 390x%s', (vh) => {
    const tabTop = vh - 56;
    const barHeight = 280;
    const headerBox: Box = { top: 0, right: 390, bottom: 52, left: 0 };
    const tab: Box = { top: tabTop, right: 390, bottom: vh, left: 0 };
    const composer: Box = { top: tabTop - barHeight, right: 390, bottom: tabTop, left: 0 };
    const covers = [headerBox, tab, composer];
    // 10px of the link sticks out above the bar; the center is 12px inside it
    const link: Box = { top: composer.top - 10, bottom: composer.top - 10 + 44, left: 16, right: 220 };
    const other: Box = { top: 80, bottom: 124, left: 16, right: 120 };
    expect(centerHitsChrome(link, covers, vh)).toBe(true);
    expect(focusClears(other, covers, vh)).toBe(true);
    const delta = scrollDeltaToClear([link, other], covers, 24, vh, 390);
    expect(delta).not.toBe(0);
    const moved = (b: Box): Box => ({ ...b, top: b.top - delta, bottom: b.bottom - delta });
    expect(focusClears(moved(link), covers, vh)).toBe(true);
    expect(centerHitsChrome(moved(other), covers, vh)).toBe(false);
    expect(focusClears(moved(other), covers, vh)).toBe(true);
  });
});

describe('thread settle watch', () => {
  it('settles again when the compose bar grows, including after several changes above the list', () => {
    const seen = new Set<string>();
    let prev: SettleHeights = { above: 100, compose: 80 };
    seen.add(settleKey(prev));
    for (const above of [120, 140, 160, 180, 200]) {
      const next = { above, compose: 80 };
      expect(shouldResettle(prev, next, seen)).toBe(true);
      seen.add(settleKey(next));
      prev = next;
    }
    expect(shouldResettle(prev, { above: 200, compose: 80 }, seen)).toBe(false);
    expect(shouldResettle(prev, { above: 200, compose: 160 }, seen)).toBe(true);
  });
});
