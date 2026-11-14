// module 46: the client portal app (R-PORTALWEB-1…11). Its own QueryClient with the staff retry rule (reads retry only
// on a network error or a 502-504, mutations never), its own API client and its one live region. The screen follows
// the link read before the first render (link.ts) and the API's answers; nothing here turns the portal "on": an
// uncleared deployment answers 401/503 and the client sees the honest signed-out or not-available state.
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type PortalApi, portalApi, shouldRetry } from './api.js';
import { PortalContext, usePortal } from './context.js';
import type { SaveDeps } from './download.js';
import { type LinkRead, dropToken } from './link.js';
import { Home, ME_KEY, useMe } from './screens/Home.js';
import { LinkLanding } from './screens/LinkLanding.js';
import { Incomplete, SignIn, SignedOut, Unavailable } from './screens/SignIn.js';
import { COPY } from './copy.js';

export function createPortalQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

type Mode = 'landing' | 'incomplete' | 'check' | 'signedOut' | 'unavailable';

export interface PortalAppProps {
  link: LinkRead;
  api?: PortalApi;
  queryClient?: QueryClient;
  save?: SaveDeps;
}

export function PortalApp({ link, api: given, queryClient, save }: PortalAppProps) {
  const api = useMemo(() => given ?? portalApi(), [given]);
  const qc = useMemo(() => queryClient ?? createPortalQueryClient(), [queryClient]);
  const [live, setLive] = useState('');
  const seq = useRef(0);
  const announce = useCallback((msg: string) => {
    // the same sentence twice is still announced (the region is cleared first)
    seq.current += 1;
    const n = seq.current;
    setLive('');
    queueMicrotask(() => {
      if (seq.current === n) setLive(msg);
    });
  }, []);
  const ctx = useMemo(() => ({ api, team: link.team, announce, ...(save ? { save } : {}) }), [api, link.team, announce, save]);
  return (
    <PortalContext.Provider value={ctx}>
      <QueryClientProvider client={qc}>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-surface focus:px-4 focus:py-3 focus:text-accent">
          Skip to content
        </a>
        <Screens link={link} />
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="portal-live">
          {live}
        </div>
      </QueryClientProvider>
    </PortalContext.Provider>
  );
}

function Screens({ link }: { link: LinkRead }) {
  const qc = useQueryClient();
  const { api } = usePortal();
  const initial: Mode = link.link === 'token' ? 'landing' : link.link === 'incomplete' ? 'incomplete' : 'check';
  const [mode, setMode] = useState<Mode>(initial);
  const [lead, setLead] = useState<string | null>(null);
  const wasIn = useRef(false);

  // R-PORTALWEB-9 (E705): a session 401 anywhere drops the CSRF and link tokens; a client who was in is signed out
  useEffect(
    () =>
      api.onSignedOut(() => {
        api.setCsrf(null);
        dropToken();
        if (wasIn.current) setMode('signedOut');
      }),
    [api],
  );
  // the cache is cleared once the signed-in screens are gone (never under a mounted query)
  useEffect(() => {
    if (mode === 'signedOut' || mode === 'unavailable') {
      qc.clear();
      wasIn.current = false;
    }
  }, [mode, qc]);

  // a page restored from the back-forward cache shows nothing stale: /me is asked again
  useEffect(() => {
    const show = (e: PageTransitionEvent) => {
      if (e.persisted) void qc.invalidateQueries({ queryKey: ME_KEY });
    };
    window.addEventListener('pageshow', show);
    return () => window.removeEventListener('pageshow', show);
  }, [qc]);

  const unavailable = useCallback(() => setMode('unavailable'), []);
  const signedOut = useCallback(() => {
    api.setCsrf(null);
    dropToken();
    setLead(null);
    setMode('signedOut');
  }, [api]);

  if (mode === 'landing')
    return (
      <LinkLanding
        onSignedIn={() => {
          qc.clear();
          setLead(null);
          setMode('check');
        }}
        onLinkRefused={(sentence) => {
          setLead(sentence);
          setMode('check');
        }}
        onUnavailable={unavailable}
      />
    );
  if (mode === 'incomplete') return <Incomplete onUnavailable={unavailable} />;
  if (mode === 'unavailable') return <Unavailable />;
  if (mode === 'signedOut') return <SignedOut onUnavailable={unavailable} />;
  return <Checked lead={lead} onIn={() => (wasIn.current = true)} onSignedOut={signedOut} onUnavailable={unavailable} />;
}

/** GET /me decides: home when signed in, else the sign-in form (or the no-team state). */
function Checked({ lead, onIn, onSignedOut, onUnavailable }: { lead: string | null; onIn(): void; onSignedOut(): void; onUnavailable(): void }) {
  const me = useMe();
  useEffect(() => {
    if (me.data) onIn();
  }, [me.data, onIn]);
  if (me.isError && me.error.code === 'PORTAL_SESSION_REQUIRED') return <SignIn lead={lead} onUnavailable={onUnavailable} />;
  if (me.isPending)
    return (
      <main id="main" className="mx-auto max-w-[640px] px-4 pt-6">
        <p className="text-[16px] text-ink-muted">{COPY.loading}</p>
      </main>
    );
  return <Home lead={lead} onSignedOut={onSignedOut} />;
}
