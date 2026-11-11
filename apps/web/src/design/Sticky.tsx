// A bar that stays at the bottom of the screen while the page scrolls (the thread's compose bar).
// The browser keeps a control it scrolls to (keyboard focus, find-in-page, #anchors) clear of the
// page's scroll padding, so the bar's height has to be part of it, or a focused control can sit behind
// the bar (WCAG 2.2 2.4.11 Focus Not Obscured). useStickyBottom() measures the bar and publishes its
// height as --sticky-bottom-h on <html>; tokens.css adds it to scroll-padding-bottom on every width.
// Mark the bar data-sticky as well: the accessibility sweep (e2e/a11y/checks.ts) checks focus against
// every data-sticky bar and fails a sticky or fixed bar that is not marked.
import { type RefCallback, useCallback, useEffect, useRef } from 'react';

export const STICKY_BOTTOM_VAR = '--sticky-bottom-h';

/** Ref callback for one bottom sticky bar; its height is in the scroll padding while it is mounted. */
export function useStickyBottom<T extends HTMLElement>(): RefCallback<T> {
  const observer = useRef<{ disconnect(): void } | null>(null);
  const stop = () => {
    observer.current?.disconnect();
    observer.current = null;
    document.documentElement.style.removeProperty(STICKY_BOTTOM_VAR);
  };
  useEffect(() => stop, []);
  return useCallback((el: T | null) => {
    stop();
    if (!el) return;
    // a bar that is in the flow right now (a short screen or large zoom can turn sticky off) covers nothing
    const publish = () => {
      const floats = ['sticky', 'fixed'].includes(getComputedStyle(el).position);
      document.documentElement.style.setProperty(STICKY_BOTTOM_VAR, `${floats ? Math.ceil(el.getBoundingClientRect().height) : 0}px`);
    };
    publish();
    window.addEventListener('resize', publish);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null;
    ro?.observe(el);
    observer.current = { disconnect: () => (ro?.disconnect(), window.removeEventListener('resize', publish)) };
  }, []);
}
