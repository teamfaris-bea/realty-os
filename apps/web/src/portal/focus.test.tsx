// module 46 (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-11): b17, the portal's focus and its live region (b16 review).
// The browser half of each is in e2e/portal/announce.spec.ts: jsdom has no focus fix-up rule (a `disabled` focused
// button keeps focus here), and under act() React flushed the live region's clear and set apart, which hid FA-1. The
// FA-1 cases here therefore run outside act(), with a native click(), as a browser does (React's act environment
// off; userEvent and fireEvent wrap act).
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { COPY } from './copy.js';
import { resetLinkForTests } from './link.js';
import * as F from './test/fixtures.js';
import { portalApiError } from './test/portalContract.js';
import { renderPortal, signedIn } from './test/render.js';
import { VIEW_WORDS } from './view/index.js';

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
const pause = (ms = 30) => act(async () => void (await new Promise((res) => setTimeout(res, ms))));
const tl = () => screen.getByRole('region', { name: VIEW_WORDS.timeline });
const docs = () => screen.getByRole('region', { name: VIEW_WORDS.documents });
const panelHeading = (name: string) => screen.getByRole('heading', { level: 2, name });
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

describe('b17 FA-2, L16-2: a Try again that succeeds', () => {
  for (const wide of [false, true]) {
    it(`FA-2 (${wide ? 'desktop' : 'phone'}): focus moves to the panel's heading, and nothing is announced`, async () => {
      let down = true;
      renderPortal({
        wide,
        routes: {
          ...signedIn,
          'GET /portal/timeline': (x) => {
            if (down) throw new TypeError('Failed to fetch');
            return { status: 200, body: F.timeline(x.query.grantId) };
          },
        },
      });
      await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
      await waitFor(() => expect(live()).toHaveTextContent(COPY.generic));
      const seen = liveLog();
      down = false;
      await userEvent.click(within(tl()).getByRole('button', { name: COPY.tryAgain }));
      expect(await screen.findByText('Inspection')).toBeInTheDocument();
      await waitFor(() => expect(panelHeading(VIEW_WORDS.timeline)).toHaveFocus());
      expect(document.activeElement).not.toBe(document.body);
      expect(panelHeading(VIEW_WORDS.timeline)).toHaveAttribute('tabindex', '-1');
      await pause(200);
      expect(said(seen, COPY.generic)).toBe(0);
      // nothing stale: the live region no longer holds the failure either (a screen reader reading on would meet it)
      expect(live()).not.toHaveTextContent(COPY.generic);
    });
  }

  it("L16-2: HomeError's Try again that works: home opens and the live region no longer holds the failure", async () => {
    let down = true;
    renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => {
          if (down) throw new TypeError('Failed to fetch');
          return { status: 200, body: F.me() };
        },
      },
    });
    const again = await screen.findByRole('button', { name: COPY.tryAgain });
    await waitFor(() => expect(live()).toHaveTextContent(COPY.network));
    down = false;
    await userEvent.click(again);
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toHaveFocus();
    await pause(200);
    expect(live()).not.toHaveTextContent(COPY.network);
  });

  it('FA-2: a success that arrives while the client is elsewhere does not take focus', async () => {
    let down = true;
    const r = renderPortal({
      wide: true,
      routes: {
        ...signedIn,
        'GET /portal/timeline': (x) => {
          if (down) throw new TypeError('Failed to fetch');
          return { status: 200, body: F.timeline(x.query.grantId) };
        },
      },
    });
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    const out = screen.getByRole('button', { name: COPY.signOut });
    out.focus();
    down = false;
    await act(async () => {
      await r.queryClient.refetchQueries({ queryKey: ['portal', 'timeline'] });
    });
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    expect(out).toHaveFocus();
  });

  it('FA-6, L16-2: desktop, documents fail first and the timeline later; the timeline Try again succeeds: no failure is announced', async () => {
    let tlDown = true;
    renderPortal({
      wide: true,
      routes: {
        ...signedIn,
        'GET /portal/timeline': async (x) => {
          if (tlDown) {
            await new Promise((res) => setTimeout(res, 40)); // the later failure
            throw new TypeError('Failed to fetch');
          }
          return { status: 200, body: F.timeline(x.query.grantId) };
        },
        'GET /portal/documents': offline,
      },
    });
    await waitFor(() => expect(within(docs()).getByText(COPY.generic)).toBeInTheDocument());
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await pause(200);
    const seen = liveLog();
    tlDown = false;
    await userEvent.click(within(tl()).getByRole('button', { name: COPY.tryAgain }));
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    await pause(200);
    // b16: failedAt fell to the documents' older failure and the success was answered "Something went wrong"
    expect(seen).toEqual([]);
    expect(within(docs()).getByText(COPY.generic)).toBeInTheDocument();
    await waitFor(() => expect(panelHeading(VIEW_WORDS.timeline)).toHaveFocus());
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
