// module 46 (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-11): b17, the portal's focus and its live region (b16 review).
// The browser half of each is in e2e/portal/announce.spec.ts: jsdom has no focus fix-up rule (a `disabled` focused
// button keeps focus here), and under act() React flushed the live region's clear and set apart, which hid FA-1. The
// FA-1 cases here therefore run outside act(), with a native click(), as a browser does (React's act environment
// off; userEvent and fireEvent wrap act).
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY } from './copy.js';
import { resetLinkForTests } from './link.js';
import * as F from './test/fixtures.js';
import { portalApiError } from './test/portalContract.js';
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
const gate = () => {
  let release!: () => void;
  const held = new Promise<void>((res) => (release = res));
  return { held, release: () => release() };
};

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

// b17 (found with FA-1's browser test): a read of /me with no data puts the query back to 'pending' and clears its error
// (TanStack), so the screen /me had settled on (the sign-in form, or the first /me's error screen) was swapped for
// "Loading" while /me was read again: on Try again, and each time the tab is shown again (refetchOnWindowFocus). The
// focused Try again, or the field and what was typed, went, and focus fell to <body>.
describe('b17: the screen /me settled on stays while /me is read again', () => {
  it("the first /me's error screen keeps its Try again (aria-disabled, focused) while /me is read again, and after it fails again", async () => {
    let mode: 'down' | 'gated' = 'down';
    const g = gate();
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': async () => {
          if (mode === 'gated') await g.held;
          throw new TypeError('Failed to fetch');
        },
      },
    });
    const again = await screen.findByRole('button', { name: COPY.tryAgain });
    mode = 'gated';
    await userEvent.click(again);
    await waitFor(() => expect(count(r, 'GET /portal/me')).toBe(2));
    expect(again).toBeInTheDocument();
    expect(again).toHaveAttribute('aria-disabled', 'true');
    expect(again).toHaveFocus();
    expect(screen.queryByText(COPY.loading)).toBeNull();
    await act(async () => g.release());
    await waitFor(() => expect(again).not.toHaveAttribute('aria-disabled'));
    expect(again).toBeInTheDocument();
    expect(again).toHaveFocus();
    expect(screen.getByText(COPY.network, { ignore: '[data-testid="portal-live"]' })).toBeInTheDocument();
  });

  it('the sign-in form stays, with what was typed and focus, while /me is read again (the tab shown again)', async () => {
    const g = gate();
    let n = 0;
    const r = renderPortal({
      routes: {
        'GET /portal/me': async () => {
          n += 1;
          if (n > 1) await g.held;
          return portalApiError('PORTAL_SESSION_REQUIRED');
        },
      },
    });
    const field = await screen.findByLabelText(COPY.emailLabel);
    await userEvent.type(field, 'jane@example.test');
    expect(field).toHaveFocus();
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await waitFor(() => expect(count(r, 'GET /portal/me')).toBe(2));
    expect(screen.queryByText(COPY.loading)).toBeNull();
    expect(field).toBeInTheDocument();
    expect(field).toHaveValue('jane@example.test');
    expect(field).toHaveFocus();
    await act(async () => g.release());
    await act(async () => void (await new Promise((res) => setTimeout(res, 20))));
    expect(field).toBeInTheDocument();
    expect(field).toHaveValue('jane@example.test');
    expect(field).toHaveFocus();
    focusManager.setFocused(undefined);
  });

  it('a read of /me that then answers signed in opens home', async () => {
    let n = 0;
    renderPortal({ routes: { ...signedIn, 'GET /portal/me': () => (++n === 1 ? portalApiError('PORTAL_SESSION_REQUIRED') : { status: 200, body: F.me() }) } });
    await screen.findByLabelText(COPY.emailLabel);
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    focusManager.setFocused(undefined);
  });
});
