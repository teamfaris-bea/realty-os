// useStickyBottom: a bottom sticky bar's height is part of the page's scroll padding (WCAG 2.4.11).
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STICKY_BOTTOM_VAR, useStickyBottom } from './index.js';

function Bar({ position = 'sticky', stackVar, h }: { position?: 'sticky' | 'static'; stackVar?: string; h?: number }) {
  const ref = useStickyBottom<HTMLDivElement>(stackVar ? { stackVar } : {});
  return (
    <div ref={ref} data-sticky data-h={h} style={{ position }}>
      compose
    </div>
  );
}

const value = () => document.documentElement.style.getPropertyValue(STICKY_BOTTOM_VAR);

describe('useStickyBottom', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publishes the bar height as --sticky-bottom-h while mounted and removes it on unmount', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 131.4, width: 390, top: 0, left: 0, right: 390, bottom: 131.4, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const { unmount } = render(<Bar />);
    expect(value()).toBe('132px');
    unmount();
    expect(value()).toBe('');
  });


  it('b13 review F3-ui: two bars at once (the person page\'s Note · Log bar and the AI care bar) publish the sum; the one that goes keeps the other\'s height; a stack variable carries one bar\'s own height', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const h = Number(this.getAttribute('data-h') ?? 0);
      return { height: h, width: 390, top: 0, left: 0, right: 390, bottom: h, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const note = render(<Bar position="sticky" stackVar="--person-bar-h" h={56} />);
    expect(value()).toBe('56px');
    expect(document.documentElement.style.getPropertyValue('--person-bar-h')).toBe('56px');
    const ai = render(<Bar position="sticky" h={60} />);
    expect(value()).toBe('116px');
    ai.unmount();
    // the AI bar goes (Pause, End, Undo): the Note · Log bar is still there, so is its height
    expect(value()).toBe('56px');
    note.unmount();
    expect(value()).toBe('');
    expect(document.documentElement.style.getPropertyValue('--person-bar-h')).toBe('');
  });

  it('a bar that is in the flow (short screen, large zoom) adds nothing to the scroll padding', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 131.4, width: 390, top: 0, left: 0, right: 390, bottom: 131.4, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    const { unmount } = render(<Bar position="static" />);
    expect(value()).toBe('0px');
    unmount();
  });
});
