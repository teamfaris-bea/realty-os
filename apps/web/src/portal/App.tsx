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
import { Home, HomeError, ME_KEY, useMe } from './screens/Home.js';
import { LinkLanding } from './screens/LinkLanding.js';
import { Incomplete, SignIn, SignedOut, Unavailable } from './screens/SignIn.js';
import { COPY, sentenceFor } from './copy.js';

export function createPortalQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, retry: shouldRetry, refetchOnWindowFocus: true },
      mutations: { retry: false },
    },
  });
}

type Mode = 'landing' | 'incomplete' | 'check' | 'signedOut' | 'unavailable' | 'unavailableAtTap';

/**
 * How long the live region stays empty before it is given the sentence. b17 (b16 review FA-1): the clear and the set
 * must be separate commits. announce() is mostly called from passive effects, and React gave the clear and the
 * microtask's set one Default-lane render, so a region that already held the sentence never changed: a failed Try
 * again was never heard in a browser (act() in the unit tests flushed them apart). A timer is a later task, so the
 * empty region is committed first and a screen reader sees the sentence arrive again.
 */
export const ANNOUNCE_GAP_MS = 100;

export interface PortalAppProps {
  link: LinkRead;
  api?: PortalApi;
  queryClient?: QueryClient;
  save?: SaveDeps;
}

export function PortalApp({ link, api: given, queryClient, save }: PortalAppProps) {
  const api = useMemo(() => given ?? portalApi(), [given]);
  const qc = useMemo(() => queryClient ?? createPortalQueryClient(), [queryClient]);
  // `n` keys the region's text: each announcement is a new text node, even if a clear and a set were ever batched
  const [live, setLive] = useState<{ n: number; text: string }>({ n: 0, text: '' });
  const seq = useRef(0);
  const announce = useCallback((msg: string) => {
    // the same sentence twice is still announced: the region is emptied, then given the sentence a task later (FA-1);
    // a newer announcement replaces one still waiting, so only the last is said
    seq.current += 1;
    const n = seq.current;
    setLive({ n, text: '' });
    window.setTimeout(() => {
      if (seq.current === n) setLive({ n, text: msg });
    }, ANNOUNCE_GAP_MS);
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
          {live.text ? <span key={live.n}>{live.text}</span> : null}
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
    if (mode === 'signedOut' || mode === 'unavailable' || mode === 'unavailableAtTap') {
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
  const unavailableAtTap = useCallback(() => setMode('unavailableAtTap'), []);
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
        onUnavailable={unavailableAtTap}
      />
    );
  if (mode === 'incomplete') return <Incomplete onUnavailable={unavailable} />;
  if (mode === 'unavailable') return <Unavailable />;
  if (mode === 'unavailableAtTap') return <Unavailable atTap />;
  if (mode === 'signedOut') return <SignedOut onUnavailable={unavailable} />;
  return <Checked lead={lead} onIn={() => (wasIn.current = true)} onSignedOut={signedOut} onUnavailable={unavailable} />;
}

/** What a /me with no data last settled on: signed out (the sign-in form), or a failure and its sentence. */
type Settled = { signIn: true } | { signIn: false; sentence: string };

/** GET /me decides: home when signed in, else the sign-in form (or the no-team state). */
function Checked({ lead, onIn, onSignedOut, onUnavailable }: { lead: string | null; onIn(): void; onSignedOut(): void; onUnavailable(): void }) {
  const me = useMe();
  // b17 (found with b16 review FA-1's browser test): a read of /me with no data puts the query back to 'pending' and
  // clears its error (TanStack), so the screen /me had settled on was swapped for "Loading" while /me was read again:
  // on the error screen's Try again, and on the sign-in form each time the tab is shown again (refetchOnWindowFocus).
  // The focused Try again, or the field and what was typed, went, and focus fell to <body>. That screen now stays
  // until /me answers (Try again is aria-disabled meanwhile, as Grant's panels since b16). Set during render from the
  // query's own state, so a StrictMode second render sets the same value.
  const settled = useRef<Settled | null>(null);
  if (me.data !== undefined) settled.current = null;
  else if (me.isError) settled.current = me.error.code === 'PORTAL_SESSION_REQUIRED' ? { signIn: true } : { signIn: false, sentence: sentenceFor(me.error.code) };
  const shown = me.data === undefined && (me.isError || me.errorUpdateCount > 0) ? settled.current : null;
  useEffect(() => {
    if (me.data) onIn();
  }, [me.data, onIn]);
  if (shown?.signIn) return <SignIn lead={lead} onUnavailable={onUnavailable} />;
  // b15 audit F11: a first /me that fails for another reason (a network error, an unreadable answer) is shown here, with
  // Try again and no Sign out (whether the client is signed in is not known). Falling through to Home looped: Home's
  // observer refetched on mount, the query went back to pending, and this screen unmounted Home again.
  if (shown) return <HomeError sentence={shown.sentence} onRetry={() => void me.refetch()} retrying={me.isFetching} failedAt={me.errorUpdatedAt} signOut={null} />;
  if (me.isPending)
    return (
      <main id="main" className="mx-auto max-w-[640px] px-4 pt-6">
        <p className="text-[16px] text-ink-muted">{COPY.loading}</p>
      </main>
    );
  return <Home lead={lead} onSignedOut={onSignedOut} />;
}
