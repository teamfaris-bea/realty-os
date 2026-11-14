// module 46 (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-11): b17, the portal's focus and its live region (b16 review).
// The browser half of each is in e2e/portal/announce.spec.ts: jsdom has no focus fix-up rule (a `disabled` focused
// button keeps focus here), and under act() React flushed the live region's clear and set apart, which hid FA-1. The
// FA-1 cases here therefore run outside act(), with a native click(), as a browser does (React's act environment
// off; userEvent and fireEvent wrap act).
import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY } from './copy.js';
import { resetLinkForTests } from './link.js';
import { renderPortal, signedIn } from './test/render.js';

beforeEach(() => resetLinkForTests());
afterEach(() => resetLinkForTests());

const live = () => screen.getByTestId('portal-live');
/** Every text the live region holds from now on (one entry per batch of mutations, as a screen reader is told). */
const liveLog = () => {
  const seen: string[] = [];
  const mo = new MutationObserver(() => seen.push(live().textContent ?? ''));
  mo.observe(live(), { childList: true, characterData: true, subtree: true });
  return seen;
};
const said = (seen: readonly string[], sentence: string) => seen.filter((t) => t === sentence).length;
const offline = () => {
  throw new TypeError('Failed to fetch');
};
const count = (r: { keys(): string[] }, key: string) => r.keys().filter((k) => k === key).length;

describe('b17 FA-1: the same sentence is announced again after each failed Try again (outside act, as a browser runs it)', () => {
  let prev: unknown;
  const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown };
  beforeEach(() => {
    prev = g.IS_REACT_ACT_ENVIRONMENT;
    g.IS_REACT_ACT_ENVIRONMENT = false;
  });
  afterEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = prev;
  });

  it('FA-1: a Grant panel whose Try again fails again: two failures, two announcements', async () => {
    const r = renderPortal({ routes: { ...signedIn, 'GET /portal/timeline': offline } });
    const seen = liveLog();
    const again = await screen.findByRole('button', { name: COPY.tryAgain });
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
    again.focus();
    again.click(); // native: no act()
    await waitFor(() => expect(count(r, 'GET /portal/timeline')).toBe(2));
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(2));
    expect(again).toHaveFocus();
    expect(live()).toHaveTextContent(COPY.generic);
  });

  it('FA-1: HomeError (a first /me that fails): two failures, two announcements', async () => {
    const r = renderPortal({ routes: { ...signedIn, 'GET /portal/me': offline } });
    const seen = liveLog();
    const again = await screen.findByRole('button', { name: COPY.tryAgain });
    await waitFor(() => expect(said(seen, COPY.network)).toBe(1));
    again.focus();
    again.click();
    await waitFor(() => expect(count(r, 'GET /portal/me')).toBe(2));
    await waitFor(() => expect(said(seen, COPY.network)).toBe(2));
    expect(again).toHaveFocus();
  });
});
