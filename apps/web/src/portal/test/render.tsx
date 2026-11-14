// module 46 test harness: the portal App on a contract-checked fake of module 45 (portalContractFetch), in jsdom.
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { portalApi } from '../api.js';
import { PortalApp, createPortalQueryClient } from '../App.js';
import type { SaveDeps } from '../download.js';
import type { LinkRead } from '../link.js';
import { type PortalAnswer, type PortalExchange, portalApiError, portalContractFetch } from './portalContract.js';
import * as F from './fixtures.js';

export type Routes = Partial<Record<string, (x: PortalExchange) => PortalAnswer>>;

/** A matchMedia that answers `wide` for (min-width: 768px). */
export function setViewport(wide: boolean) {
  window.matchMedia = ((q: string) => ({
    matches: /min-width:\s*768px/.test(q) ? wide : false,
    media: q,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** The default signed-in world: one grant, its timeline and documents. */
export const signedIn: Routes = {
  'GET /portal/me': () => ({ status: 200, body: F.me() }),
  'GET /portal/timeline': (x) => ({ status: 200, body: F.timeline(x.query.grantId) }),
  'GET /portal/documents': (x) => ({ status: 200, body: F.documents(x.query.grantId) }),
  'POST /portal/logout': () => ({ status: 204 }),
};
export const signedOutRoutes: Routes = { 'GET /portal/me': () => portalApiError('PORTAL_SESSION_REQUIRED') };

export function renderPortal(o: { link?: Partial<LinkRead>; routes?: Routes; save?: SaveDeps; wide?: boolean } = {}) {
  setViewport(o.wide ?? false);
  const seen: PortalExchange[] = [];
  const problems: string[] = [];
  const routes: Routes = { ...o.routes };
  const fetchImpl = vi.fn(
    portalContractFetch(
      (x) => {
        const r = routes[x.key];
        if (!r) throw new Error(`no fake answer for ${x.key}`);
        return r(x);
      },
      seen,
      problems,
    ),
  );
  const api = portalApi(fetchImpl);
  const queryClient = createPortalQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
  const link: LinkRead = { link: 'none', team: 'harbor', ...o.link };
  const view = render(<PortalApp link={link} api={api} queryClient={queryClient} {...(o.save ? { save: o.save } : {})} />);
  return { ...view, seen, problems, routes, api, queryClient, fetchImpl, keys: () => seen.map((x) => x.key) };
}

/** Text that looks like an API code (never shown to a client). */
export const CODE_IN_TEXT = /\b[A-Z]{2,}_[A-Z_]{2,}\b/;
