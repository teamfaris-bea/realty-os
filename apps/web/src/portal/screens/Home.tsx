// module 46 (R-PORTALWEB-5, R-PORTALWEB-6; E125, E127, E711, E712): what the signed-in client sees. GET /me lists the
// live grants (a revoked one looks never granted). None: one sentence. One: it opens directly. Several: a one-tap list.
// The open grant and tab are URL state (?grant=<uuid>&view=documents, pushState/popstate); an id not in /me is ignored.
// Sign out posts /logout (CSRF). Only its 204 clears the HttpOnly portal cookie, so only then (or on a 401: the session
// had already ended) does the App clear the cache and tokens (not the team) and show SignedOut. A CSRF_INVALID refetches
// /me for a fresh token and retries once (E716); any other failure keeps the client signed in here, with the sentence
// and Sign out (b15 review B15R-PORTAL-1: "You're signed out" over a live session on a shared phone was dishonest).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { PortalError, noBody } from '../api.js';
import { COPY, sentenceFor } from '../copy.js';
import { usePortal } from '../context.js';
import { type GrantTab, type GrantView, type MeView, VIEW_WORDS, parseMe } from '../view/index.js';
import { H1, Page, primaryButton, secondaryButton, useFocusHeading } from './common.js';
import { Grant } from './Grant.js';

export const ME_KEY = ['portal', 'me'] as const;

interface UrlState {
  grant: string | null;
  view: GrantTab;
}

function readUrl(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const g = p.get('grant');
  return { grant: g && /^[0-9a-f-]{36}$/.test(g) ? g : null, view: p.get('view') === 'documents' ? 'documents' : 'timeline' };
}

function writeUrl(s: UrlState, replace = false) {
  const p = new URLSearchParams(window.location.search);
  if (s.grant) p.set('grant', s.grant);
  else p.delete('grant');
  if (s.grant && s.view === 'documents') p.set('view', 'documents');
  else p.delete('view');
  const q = p.toString();
  const url = window.location.pathname + (q ? `?${q}` : '');
  if (replace) window.history.replaceState(window.history.state, '', url);
  else window.history.pushState(null, '', url);
}

export function useMe() {
  const { api } = usePortal();
  const qc = useQueryClient();
  return useQuery<MeView, PortalError>({
    queryKey: ME_KEY,
    queryFn: async ({ signal }) => {
      const me = await api.request('GET', '/api/portal/me', parseMe, undefined, { signal });
      // E127, E705: another session on this device (a sign-in in another tab) leaves nothing of the old one cached
      const prev = qc.getQueryData<MeView>(ME_KEY);
      if (prev && prev.csrfToken !== me.csrfToken) qc.removeQueries({ predicate: (q) => q.queryKey[0] === 'portal' && q.queryKey[1] !== 'me' });
      api.setCsrf(me.csrfToken);
      return me;
    },
  });
}

export function Home({ onSignedOut, lead }: { onSignedOut(): void; lead: string | null }) {
  const { api, announce } = usePortal();
  const qc = useQueryClient();
  const me = useMe();
  const [url, setUrl] = useState<UrlState>(() => readUrl());
  const [leaving, setLeaving] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const [goneIds, setGoneIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const pop = () => setUrl(readUrl());
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    if (lead) announce(lead);
  }, [lead, announce]);

  const go = useCallback((s: UrlState) => {
    writeUrl(s);
    setUrl(s);
  }, []);

  const onGone = useCallback(
    (id: string) => {
      announce(VIEW_WORDS.noLongerShared);
      setGoneIds((s) => new Set([...s, id]));
      if (new URLSearchParams(window.location.search).has('grant')) writeUrl({ grant: null, view: 'timeline' }, true);
      setUrl({ grant: null, view: 'timeline' });
      void qc.invalidateQueries({ queryKey: ME_KEY });
    },
    [announce, qc],
  );

  const signOut = async () => {
    if (leaving) return;
    setLeaving(true);
    setSignOutError(null);
    const post = async (): Promise<unknown> => {
      try {
        await api.request('POST', '/api/portal/logout', noBody);
        return null;
      } catch (e) {
        return e;
      }
    };
    let failure = await post();
    if (failure instanceof PortalError && failure.code === 'CSRF_INVALID') {
      // E716 (a sign-in in another tab): /me for a fresh token (a 401 there signs out, through api.ts), then one retry
      await qc.refetchQueries({ queryKey: ME_KEY, exact: true });
      failure = api.hasCsrf() ? await post() : new PortalError('PORTAL_SESSION_REQUIRED', 401);
    }
    if (failure === null || (failure instanceof PortalError && failure.code === 'PORTAL_SESSION_REQUIRED')) {
      onSignedOut();
      return;
    }
    // not signed out: the session cookie may still be valid (offline, a 5xx during a deploy, 429, CSRF_INVALID twice)
    const text = failure instanceof PortalError && failure.code !== 'CSRF_INVALID' ? sentenceFor(failure.code) : COPY.generic;
    setSignOutError(text);
    announce(text);
    setLeaving(false);
  };

  const grants = (me.data?.grants ?? []).filter((g) => !goneIds.has(g.id));
  const only = grants.length === 1 ? grants[0]! : null;
  const chosen = url.grant ? (grants.find((g) => g.id === url.grant) ?? null) : null;
  const open: GrantView | null = chosen ?? only;

  const signOutButton = (
    <>
      <button type="button" onClick={() => void signOut()} disabled={leaving} className={secondaryButton}>
        {COPY.signOut}
      </button>
      {signOutError ? <p className="w-full rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{signOutError}</p> : null}
    </>
  );

  if (me.isPending) return <Loading />;
  // b15 audit F11: a /me refetch that fails after /me answered (a network error, an unreadable answer) offers Try again
  // beside Sign out; a first /me that fails is App's Checked's to show (no Sign out: signed in is not known)
  if (me.isError) return <HomeError sentence={sentenceFor(me.error.code)} onRetry={() => void me.refetch()} retrying={me.isFetching} failedAt={me.errorUpdatedAt} signOut={signOutButton} />;
  if (open) {
    return (
      <Grant
        key={open.id}
        grant={open}
        tab={url.view}
        onTab={(t) => go({ grant: open.id, view: t })}
        onBack={grants.length > 1 ? () => go({ grant: null, view: 'timeline' }) : null}
        onGone={onGone}
        signOut={signOutButton}
      />
    );
  }
  return <GrantList grants={grants} notice={goneIds.size > 0 ? VIEW_WORDS.noLongerShared : null} onOpen={(id) => go({ grant: id, view: 'timeline' })} signOut={signOutButton} />;
}

function Loading() {
  return (
    <Page>
      <p role="status" className="text-[16px] text-ink-muted">
        {COPY.loading}
      </p>
    </Page>
  );
}

/**
 * /me failed for another reason than the session: the sentence and Try again (Sign out only when signed in is known).
 * b15 review UI-2: the sentence is announced when the screen opens and after each failed retry (`failedAt`), and Try
 * again is marked busy while the retry runs (aria-disabled, so it keeps focus; a tap then asks nothing more).
 */
export function HomeError({ sentence, onRetry, signOut, retrying = false, failedAt = 0 }: { sentence: string; onRetry(): void; signOut: ReactNode | null; retrying?: boolean; failedAt?: number }) {
  const { announce } = usePortal();
  const h = useFocusHeading();
  useEffect(() => {
    announce(sentence);
  }, [announce, sentence, failedAt]);
  return (
    <Page>
      <H1 headingRef={h}>{VIEW_WORDS.portalTitle}</H1>
      <p className="text-[16px] text-ink">{sentence}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => (retrying ? undefined : onRetry())} aria-disabled={retrying || undefined} className={`${primaryButton} ${retrying ? 'opacity-60' : ''}`}>
          {COPY.tryAgain}
        </button>
        {signOut}
      </div>
    </Page>
  );
}

function GrantList({ grants, notice, onOpen, signOut }: { grants: readonly GrantView[]; notice: string | null; onOpen(id: string): void; signOut: ReactNode }) {
  const h = useFocusHeading();
  return (
    <Page>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <H1 headingRef={h}>{VIEW_WORDS.portalTitle}</H1>
        {signOut}
      </div>
      {notice ? <p className="rounded-lg bg-warn-soft px-3 py-2 text-[16px] text-ink">{notice}</p> : null}
      {grants.length === 0 ? (
        <p className="text-[16px] text-ink">{VIEW_WORDS.nothingShared}</p>
      ) : (
        <nav aria-label={COPY.chooseHome}>
          <ul className="flex flex-col gap-2">
            {grants.map((g) => (
              <li key={g.id}>
                <button type="button" onClick={() => onOpen(g.id)} className="flex min-h-tap w-full items-center rounded-2xl border border-line bg-surface px-4 py-3 text-left text-[17px] font-semibold text-accent">
                  <span dir="auto" className="[overflow-wrap:anywhere]">
                    {g.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </Page>
  );
}
