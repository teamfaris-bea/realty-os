// module 46 (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-11): b17, the portal's focus and its live region (b16 review).
// The browser half of each is in e2e/portal/announce.spec.ts: jsdom has no focus fix-up rule (a `disabled` focused
// button keeps focus here), and under act() React flushed the live region's clear and set apart, which hid FA-1. The
// FA-1 cases here therefore run outside act(), with a native click(), as a browser does (React's act environment
// off; userEvent and fireEvent wrap act).
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { API_SENTENCES, COPY } from './copy.js';
import type { SaveDeps } from './download.js';
import { readLink, resetLinkForTests } from './link.js';
import * as F from './test/fixtures.js';
import { portalApiError } from './test/portalContract.js';
import { renderPortal, signedIn, signedOutRoutes } from './test/render.js';
import { VIEW_WORDS } from './view/index.js';

// the open grant and tab are URL state (Home): each test starts with none
const resetUrl = () => window.history.replaceState(null, '', window.location.pathname);
beforeEach(() => {
  resetLinkForTests();
  resetUrl();
});
afterEach(() => {
  resetLinkForTests();
  resetUrl();
});

const live = () => screen.getByTestId('portal-live');
const IGN = { ignore: '[data-testid="portal-live"], script, style' };
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

describe('b17 FA-3: reopening a grant whose read failed', () => {
  it('FA-3: shows Loading, not the failure, and announces nothing until the fresh read settles', async () => {
    let mode: 'down' | 'gated' = 'down';
    const g = gate();
    const r = renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => ({ status: 200, body: F.me([F.grant(), F.grant({ id: F.GRANT_2, title: 'Your home sale', scope: 'sale' })]) }),
        'GET /portal/timeline': async (x) => {
          if (mode === 'down') throw new TypeError('Failed to fetch');
          await g.held;
          return { status: 200, body: F.timeline(x.query.grantId) };
        },
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Your home purchase' }));
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: VIEW_WORDS.portalTitle }));
    await screen.findByRole('navigation', { name: COPY.chooseHome });
    mode = 'gated';
    const seen = liveLog();
    await userEvent.click(screen.getByRole('button', { name: 'Your home purchase' }));
    await screen.findByRole('heading', { level: 1, name: 'Your home purchase' });
    await waitFor(() => expect(count(r, 'GET /portal/timeline')).toBe(2));
    // the fresh read is running: Loading, no sentence, no Try again, nothing said
    expect(within(tl()).getByText(COPY.loading)).toBeInTheDocument();
    expect(screen.queryByText(COPY.generic, IGN)).toBeNull();
    expect(screen.queryByRole('button', { name: COPY.tryAgain })).toBeNull();
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(0);
    await act(async () => g.release());
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(0);
  });

  it('FA-3: a fresh read that fails again on the reopened grant shows the failure and announces it once', async () => {
    renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/me': () => ({ status: 200, body: F.me([F.grant(), F.grant({ id: F.GRANT_2, title: 'Your home sale', scope: 'sale' })]) }),
        'GET /portal/timeline': offline,
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Your home purchase' }));
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: VIEW_WORDS.portalTitle }));
    await screen.findByRole('navigation', { name: COPY.chooseHome });
    const seen = liveLog();
    await userEvent.click(screen.getByRole('button', { name: 'Your home purchase' }));
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(1);
  });
});

describe('b17 FA-4, L16-5: busy buttons are aria-disabled, never disabled (a disabled button drops focus in a browser)', () => {
  it('FA-4: the sign-in submit keeps focus while it runs and after a 429; a tap while busy posts nothing more', async () => {
    const g = gate();
    const r = renderPortal({
      routes: {
        ...signedOutRoutes,
        'POST /portal/login': async () => {
          await g.held;
          return portalApiError('RATE_LIMITED');
        },
      },
    });
    await userEvent.type(await screen.findByLabelText(COPY.emailLabel), 'jane@example.test');
    const send = screen.getByRole('button', { name: COPY.sendLink });
    await userEvent.click(send);
    await waitFor(() => expect(count(r, 'POST /portal/login')).toBe(1));
    const busy = screen.getByRole('button', { name: COPY.sending });
    expect(busy).toBe(send);
    expect(send).toHaveAttribute('aria-disabled', 'true');
    expect(send).not.toHaveAttribute('disabled');
    expect(send).toHaveFocus();
    await userEvent.click(send); // a tap while busy posts nothing more
    await act(async () => g.release());
    expect(await screen.findByText(API_SENTENCES.RATE_LIMITED, IGN)).toBeInTheDocument();
    expect(send).not.toHaveAttribute('aria-disabled');
    expect(send).not.toHaveAttribute('disabled');
    expect(send).toHaveFocus();
    expect(count(r, 'POST /portal/login')).toBe(1);
  });

  it("FA-4: the link's Sign in keeps focus while it runs and after a 429", async () => {
    readLink({ pathname: '/portal.html', search: '', hash: `#token=${F.TOKEN}` }, { state: null, replaceState: () => undefined }, null);
    const g = gate();
    const r = renderPortal({
      link: { link: 'token' },
      routes: {
        'POST /portal/session': async () => {
          await g.held;
          return portalApiError('RATE_LIMITED');
        },
      },
    });
    const signIn = screen.getByRole('button', { name: COPY.signInButton });
    await userEvent.click(signIn);
    await waitFor(() => expect(count(r, 'POST /portal/session')).toBe(1));
    expect(signIn).toHaveAttribute('aria-disabled', 'true');
    expect(signIn).not.toHaveAttribute('disabled');
    expect(signIn).toHaveFocus();
    await userEvent.click(signIn);
    await act(async () => g.release());
    expect(await screen.findByText(API_SENTENCES.RATE_LIMITED, IGN)).toBeInTheDocument();
    expect(signIn).not.toHaveAttribute('aria-disabled');
    expect(signIn).not.toHaveAttribute('disabled');
    expect(signIn).toHaveFocus();
    expect(count(r, 'POST /portal/session')).toBe(1);
  });

  it('FA-4: Download keeps focus while it runs, after a failed download and after one that worked', async () => {
    let fail = true;
    const g = gate();
    const saved: string[] = [];
    const save: SaveDeps = { createObjectURL: () => 'blob:portal-1', revokeObjectURL: () => undefined, clickDownload: (_h, name) => saved.push(name), later: (fn) => fn() };
    const r = renderPortal({
      wide: true,
      save,
      routes: {
        ...signedIn,
        'POST /portal/documents/:itemId/stream-token': async () => {
          await g.held;
          return fail ? portalApiError('NOT_FOUND') : { status: 200, body: F.streamToken() };
        },
        'GET /portal/files/:token': () => ({ status: 200, raw: new Response(F.PDF, { headers: { 'content-type': 'application/pdf', 'content-length': '8' } }) }),
      },
    });
    const dl = await screen.findByRole('button', { name: 'Download Purchase contract.pdf' });
    await userEvent.click(dl);
    await waitFor(() => expect(count(r, 'POST /portal/documents/:itemId/stream-token')).toBe(1));
    expect(dl).toHaveAttribute('aria-disabled', 'true');
    expect(dl).not.toHaveAttribute('disabled');
    expect(dl).toHaveFocus();
    await userEvent.click(dl); // a tap while busy asks for nothing more
    await act(async () => g.release());
    expect(await screen.findByText(VIEW_WORDS.fileUnavailable, IGN)).toBeInTheDocument();
    expect(dl).not.toHaveAttribute('aria-disabled');
    expect(dl).toHaveFocus();
    expect(count(r, 'POST /portal/documents/:itemId/stream-token')).toBe(1);
    fail = false;
    await userEvent.click(dl);
    await waitFor(() => expect(saved).toEqual(['Purchase contract.pdf']));
    await waitFor(() => expect(dl).not.toHaveAttribute('aria-disabled'));
    expect(dl).not.toHaveAttribute('disabled');
    expect(dl).toHaveFocus();
  });
});

describe('b17 review F1 (E713): a Download of a document no longer shared', () => {
  for (const wide of [true, false]) {
    it(`${wide ? 'desktop' : 'phone'}: the refetched list drops the item and its focused button; focus moves to the failure sentence, never <body>, and it is said once`, async () => {
      let retracted = false;
      const r = renderPortal({
        wide,
        routes: {
          ...signedIn,
          'GET /portal/documents': (x) => ({ status: 200, body: retracted ? { ...F.documents(x.query.grantId), documents: [] } : F.documents(x.query.grantId) }),
          'POST /portal/documents/:itemId/stream-token': () => {
            retracted = true; // the agent took it back: the API answers 404 for an item the client can no longer see
            return portalApiError('NOT_FOUND');
          },
        },
      });
      if (!wide) await userEvent.click(await screen.findByRole('tab', { name: VIEW_WORDS.documents }));
      const seen = liveLog();
      const dl = await screen.findByRole('button', { name: 'Download Purchase contract.pdf' });
      await userEvent.click(dl);
      await waitFor(() => expect(count(r, 'GET /portal/documents')).toBe(2));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Download Purchase contract.pdf' })).toBeNull());
      expect(await within(docs()).findByText(VIEW_WORDS.noDocuments)).toBeInTheDocument();
      const sentence = within(docs()).getByText(VIEW_WORDS.fileUnavailable);
      expect(sentence).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
      await waitFor(() => expect(said(seen, VIEW_WORDS.fileUnavailable)).toBe(1));
    });
  }

  it('a client who moved on keeps focus where they put it when the item goes', async () => {
    let retracted = false;
    const g = gate();
    renderPortal({
      wide: true,
      routes: {
        ...signedIn,
        'GET /portal/documents': async (x) => {
          if (retracted) await g.held;
          return { status: 200, body: retracted ? { ...F.documents(x.query.grantId), documents: [] } : F.documents(x.query.grantId) };
        },
        'POST /portal/documents/:itemId/stream-token': () => {
          retracted = true;
          return portalApiError('NOT_FOUND');
        },
      },
    });
    const dl = await screen.findByRole('button', { name: 'Download Purchase contract.pdf' });
    await userEvent.click(dl);
    expect(await within(docs()).findByText(VIEW_WORDS.fileUnavailable)).toBeInTheDocument();
    const heading = panelHeading(VIEW_WORDS.timeline);
    heading.focus();
    await act(async () => g.release());
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Download Purchase contract.pdf' })).toBeNull());
    expect(heading).toHaveFocus();
  });
});

describe('b17 FA-5, L16-3: phone, a failure behind the hidden tab', () => {
  it('FA-5: is announced only once its tab shows it, and once only', async () => {
    const r = renderPortal({ routes: { ...signedIn, 'GET /portal/documents': offline } });
    const seen = liveLog();
    expect(await screen.findByText('Inspection')).toBeInTheDocument();
    await waitFor(() => expect(r.queryClient.getQueryState(['portal', 'documents', F.GRANT_ID])?.status).toBe('error'));
    await pause(200);
    // the timeline tab is open: nothing on screen says the documents failed, so nothing is said
    expect(screen.queryByText(COPY.generic, IGN)).toBeNull();
    expect(said(seen, COPY.generic)).toBe(0);
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.documents }));
    expect(await screen.findByText(COPY.generic, IGN)).toBeInTheDocument();
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
    expect(screen.getByRole('tab', { name: VIEW_WORDS.documents })).toHaveFocus();
    // back and forth: the same failure is not said again
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.timeline }));
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.documents }));
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(1);
  });

  it('FA-5: a failure in the open tab is announced at once', async () => {
    renderPortal({ routes: { ...signedIn, 'GET /portal/timeline': offline } });
    const seen = liveLog();
    expect(await screen.findByText(COPY.generic, IGN)).toBeInTheDocument();
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
  });
});

describe('b17 FA-6: each announcement is keyed to its panel', () => {
  it('FA-6: phone, the documents fail behind Timeline, then the timeline fails: opening Documents still says its failure', async () => {
    renderPortal({
      routes: {
        ...signedIn,
        'GET /portal/documents': offline,
        'GET /portal/timeline': async () => {
          await new Promise((res) => setTimeout(res, 40)); // after the documents
          throw new TypeError('Failed to fetch');
        },
      },
    });
    const seen = liveLog();
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
    // b17 item 5 kept one "newest failure announced" time for both panels: the documents' failure is older than the
    // timeline's, so opening its tab said nothing
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.documents }));
    expect(within(docs()).getByText(COPY.generic)).toBeInTheDocument();
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(2));
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.timeline }));
    await userEvent.click(screen.getByRole('tab', { name: VIEW_WORDS.documents }));
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(2);
  });

  it('FA-6: desktop, both fail at once: one announcement; a failed retry of either is said again', async () => {
    const r = renderPortal({ wide: true, routes: { ...signedIn, 'GET /portal/documents': offline, 'GET /portal/timeline': offline } });
    const seen = liveLog();
    await waitFor(() => expect(within(docs()).getByText(COPY.generic)).toBeInTheDocument());
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    await pause(200);
    expect(said(seen, COPY.generic)).toBe(1);
    await userEvent.click(within(docs()).getByRole('button', { name: COPY.tryAgain }));
    await waitFor(() => expect(count(r, 'GET /portal/documents')).toBe(2));
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(2));
  });

  it("FA-6: each panel's announcement is its own: a loaded panel's failed background refetch says nothing, and the other panel's failure is not said again", async () => {
    let docDown = false;
    const r = renderPortal({
      wide: true,
      routes: {
        ...signedIn,
        'GET /portal/timeline': offline,
        'GET /portal/documents': (x) => {
          if (docDown) throw new TypeError('Failed to fetch');
          return { status: 200, body: F.documents(x.query.grantId) };
        },
      },
    });
    const seen = liveLog();
    await waitFor(() => expect(within(tl()).getByText(COPY.generic)).toBeInTheDocument());
    expect(await screen.findByText('Purchase contract.pdf')).toBeInTheDocument();
    await waitFor(() => expect(said(seen, COPY.generic)).toBe(1));
    // a loaded panel's background refetch that fails says nothing (b16), and the timeline's failure is not said again
    docDown = true;
    await act(async () => {
      await r.queryClient.invalidateQueries({ queryKey: ['portal', 'documents'] });
    });
    await waitFor(() => expect(r.queryClient.getQueryState(['portal', 'documents', F.GRANT_ID])?.status).toBe('error'));
    await pause(200);
    expect(screen.getByText('Purchase contract.pdf')).toBeInTheDocument();
    expect(said(seen, COPY.generic)).toBe(1);
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
