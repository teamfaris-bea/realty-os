// A bar that stays at the bottom of the screen while the page scrolls (the thread's compose bar).
// The browser keeps a control it scrolls to (keyboard focus, find-in-page, #anchors) clear of the
// page's scroll padding, so the bar's height has to be part of it, or a focused control can sit behind
// the bar (WCAG 2.2 2.4.11 Focus Not Obscured). useStickyBottom() measures the bar and publishes its
// height as --sticky-bottom-h on <html>; tokens.css adds it to scroll-padding-bottom on every width.
// Mark the bar data-sticky as well: the accessibility sweep (e2e/a11y/checks.ts) checks focus against
// every data-sticky bar and fails a sticky or fixed bar that is not marked. Several bars at once publish the sum of
// their heights (b13 review F3-ui); a bar others stack above publishes its own height too (`stackVar`).
import { type RefCallback, useCallback, useEffect, useRef } from 'react';

export const STICKY_BOTTOM_VAR = '--sticky-bottom-h';

// b13 review F3-ui: a page can carry more than one bottom bar (the person page's Note · Log bar and, while AI care is
// live, the AI care bar stacked above it). Every mounted bar is registered here and the variable is their SUM; a bar
// that goes removes only its own height, and the variable goes when the last bar does.
const heights = new Map<symbol, number>();
function publishSum(): void {
  if (heights.size === 0) document.documentElement.style.removeProperty(STICKY_BOTTOM_VAR);
  else document.documentElement.style.setProperty(STICKY_BOTTOM_VAR, `${[...heights.values()].reduce((a, b) => a + b, 0)}px`);
}

export interface StickyBottomOptions {
  /** also publish THIS bar's own height as this CSS variable on <html> (a bar stacked above it offsets by it) */
  stackVar?: string;
}

/** Ref callback for a bottom sticky bar; its height is in the scroll padding while it is mounted. */
export function useStickyBottom<T extends HTMLElement>(o: StickyBottomOptions = {}): RefCallback<T> {
  const key = useRef(Symbol('sticky-bar'));
  const observer = useRef<{ disconnect(): void } | null>(null);
  const stackVar = o.stackVar;
  const stop = useCallback(() => {
    observer.current?.disconnect();
    observer.current = null;
    if (heights.delete(key.current)) publishSum();
    if (stackVar) document.documentElement.style.removeProperty(stackVar);
  }, [stackVar]);
  useEffect(() => stop, [stop]);
  return useCallback((el: T | null) => {
    stop();
    if (!el) return;
    // a bar that is in the flow right now (a short screen or large zoom can turn sticky off) covers nothing
    const publish = () => {
      const floats = ['sticky', 'fixed'].includes(getComputedStyle(el).position);
      const h = floats ? Math.ceil(el.getBoundingClientRect().height) : 0;
      heights.set(key.current, h);
      publishSum();
      if (stackVar) document.documentElement.style.setProperty(stackVar, `${h}px`);
    };
    publish();
    window.addEventListener('resize', publish);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    observer.current = { disconnect: () => (ro?.disconnect(), window.removeEventListener('resize', publish)) };
  }, [stop, stackVar]);
}
