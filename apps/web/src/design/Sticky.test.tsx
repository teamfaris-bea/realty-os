// useStickyBottom: a bottom sticky bar's height is part of the page's scroll padding (WCAG 2.4.11).
import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STICKY_BOTTOM_VAR, useStickyBottom } from './index.js';

function Bar() {
  const ref = useStickyBottom<HTMLDivElement>();
  return (
    <div ref={ref} data-sticky>
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

});
