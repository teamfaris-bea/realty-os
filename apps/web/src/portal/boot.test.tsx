// module 46 (R-PORTALWEB-3; E703), b15 audit P46-SEC-2: a sign-in link opened in a tab already on the portal is only a
// fragment change (no load). It is read in place, as a first load is: stripped from the address bar and from the history
// entry the fragment change made before anything renders, kept in memory only, and posted only on the Sign in tap.
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { portalApi } from './api.js';
import { bootPortal } from './boot.js';
import { linkToken, resetLinkForTests } from './link.js';
import { type PortalExchange, portalApiError, portalContractFetch } from './test/portalContract.js';
import { setViewport } from './test/render.js';
import * as F from './test/fixtures.js';

let stop: (() => void) | null = null;
let el: HTMLElement;
beforeEach(() => {
  resetLinkForTests();
  setViewport(false);
  window.history.replaceState(null, '', '/portal.html?team=harbor');
  el = document.createElement('div');
  document.body.append(el);
});
afterEach(() => {
  act(() => stop?.());
  stop = null;
  el.remove();
  resetLinkForTests();
  window.history.replaceState(null, '', '/');
});

function start() {
  const seen: PortalExchange[] = [];
  const problems: string[] = [];
  let signedIn = false;
  const fetchImpl = vi.fn(
    portalContractFetch(
      (x) => {
        if (x.key === 'GET /portal/me') return signedIn ? { status: 200, body: F.me() } : portalApiError('PORTAL_SESSION_REQUIRED');
        if (x.key === 'POST /portal/session') {
          signedIn = true;
          return { status: 200, body: F.session() };
        }
        if (x.key === 'GET /portal/timeline') return { status: 200, body: F.timeline(x.query.grantId) };
        if (x.key === 'GET /portal/documents') return { status: 200, body: F.documents(x.query.grantId) };
        throw new Error(`no fake answer for ${x.key}`);
      },
      seen,
      problems,
    ),
  );
  act(() => {
    stop = bootPortal(el, window, { api: portalApi(fetchImpl) });
  });
  return { seen, problems, keys: () => seen.map((x) => x.key) };
}

describe('b15 audit P46-SEC-2: a link opened in a tab already on the portal (hashchange)', () => {
  it('E703: the fragment is stripped from the address bar and that history entry at once, and the app restarts on it in place; Sign in shows; nothing is posted before the tap', async () => {
    const w = start();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeInTheDocument();
    const entries = window.history.length;
    act(() => {
      window.location.hash = `#token=${F.TOKEN}`;
    });
    // the hashchange handler runs before the next render: the entry the fragment change made no longer holds the token
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(window.location.href).not.toContain(F.TOKEN);
    expect(window.location.href).not.toContain('#');
    expect(window.location.search).toBe('?team=harbor');
    expect(window.history.length).toBe(entries + 1);
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(linkToken()).toBe(F.TOKEN);
    expect(w.keys()).not.toContain('POST /portal/session');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(w.keys().filter((k) => k === 'POST /portal/session')).toHaveLength(1));
    expect(w.seen.find((x) => x.key === 'POST /portal/session')!.body).toEqual({ token: F.TOKEN });
    expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
    expect(w.problems).toEqual([]);
  });

  it('E702: an incomplete link opened in place is stripped too and shows the incomplete state; a fragment that names no token (the skip link) changes nothing', async () => {
    const w = start();
    await screen.findByRole('heading', { level: 1, name: 'Sign in to your client portal' });
    act(() => {
      window.location.hash = '#main';
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(window.location.hash).toBe('#main');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeInTheDocument();
    act(() => {
      window.location.hash = `#token=${F.TOKEN.slice(0, 42)}`;
    });
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect(await screen.findByText(/This sign-in link is incomplete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(linkToken()).toBeNull();
    expect(w.keys()).not.toContain('POST /portal/session');
  });

  // b15 review B15R-PORTAL-2: the token is module state shared by every app generation. Link B opened while link A's
  // tap is in flight remounts the app on B; A's late answer (success or a refused link) must drop only A's token, so B's
  // Sign in still posts B (it used to find no token and do nothing under a live Sign in button)
  for (const aAnswer of ['200', 'PORTAL_LINK_INVALID'] as const) {
    it(`E703 (b15 review B15R-PORTAL-2): link B arrives while link A's tap is pending; A then answers ${aAnswer}; B's Sign in posts B`, async () => {
      const TOKEN_B = 'B'.repeat(43);
      window.history.replaceState(null, '', `/portal.html?team=harbor#token=${F.TOKEN}`);
      const seen: PortalExchange[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let signedIn = false;
      const fetchImpl = vi.fn(
        portalContractFetch(async (x) => {
          if (x.key === 'POST /portal/session') {
            if ((x.body as { token: string }).token === F.TOKEN) {
              await gate;
              if (aAnswer === 'PORTAL_LINK_INVALID') return portalApiError('PORTAL_LINK_INVALID');
            }
            signedIn = true;
            return { status: 200, body: F.session() };
          }
          if (x.key === 'GET /portal/me') return signedIn ? { status: 200, body: F.me() } : portalApiError('PORTAL_SESSION_REQUIRED');
          if (x.key === 'GET /portal/timeline') return { status: 200, body: F.timeline(x.query.grantId) };
          if (x.key === 'GET /portal/documents') return { status: 200, body: F.documents(x.query.grantId) };
          throw new Error(`no fake answer for ${x.key}`);
        }, seen),
      );
      // each app generation gets its own API client, as in production
      act(() => {
        stop = bootPortal(el, window, { api: portalApi(fetchImpl) });
      });
      await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
      act(() => {
        window.location.hash = `#token=${TOKEN_B}`;
      });
      await waitFor(() => expect(linkToken()).toBe(TOKEN_B));
      expect(await screen.findByRole('button', { name: 'Sign in' })).toBeEnabled();
      await act(async () => {
        release();
        await new Promise((r) => setTimeout(r, 20));
      });
      expect(linkToken()).toBe(TOKEN_B);
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      await waitFor(() => expect(seen.filter((x) => x.key === 'POST /portal/session').map((x) => (x.body as { token: string }).token)).toEqual([F.TOKEN, TOKEN_B]));
      expect(await screen.findByRole('heading', { level: 1, name: 'Your home purchase' })).toBeInTheDocument();
      expect(linkToken()).toBeNull();
    });
  }
});
