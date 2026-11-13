// module 46 (R-PORTALWEB-5, R-PORTALWEB-6; E125, E127, E691, E692): what the signed-in client sees. GET /me lists the
// live grants (a revoked one looks never granted). None: one sentence. One: it opens directly. Several: a one-tap list.
// The open grant and tab are URL state (?grant=<uuid>&view=documents, pushState/popstate); an id not in /me is ignored.
// Sign out posts /logout (CSRF), then the App clears the cache and tokens (not the team) and shows SignedOut.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type PortalError, noBody } from '../api.js';
import { COPY } from '../copy.js';
import { usePortal } from '../context.js';
import { type GrantTab, type GrantView, type MeView, VIEW_WORDS, parseMe } from '../view/index.js';
import { H1, Page, secondaryButton, useFocusHeading } from './common.js';
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
      // E127, E685: another session on this device (a sign-in in another tab) leaves nothing of the old one cached
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
    try {
      await api.request('POST', '/api/portal/logout', noBody, {});
    } catch {
      // a session already gone is signed out all the same
    }
    onSignedOut();
  };

  const grants = (me.data?.grants ?? []).filter((g) => !goneIds.has(g.id));
  const only = grants.length === 1 ? grants[0]! : null;
  const chosen = url.grant ? (grants.find((g) => g.id === url.grant) ?? null) : null;
  const open: GrantView | null = chosen ?? only;

  const signOutButton = (
    <button type="button" onClick={() => void signOut()} disabled={leaving} className={secondaryButton}>
      {COPY.signOut}
    </button>
  );

  if (me.isPending) return <Loading />;
  if (me.isError) return <HomeError signOut={signOutButton} />;
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

function HomeError({ signOut }: { signOut: ReactNode }) {
  const h = useFocusHeading();
  return (
    <Page>
      <H1 headingRef={h}>{VIEW_WORDS.portalTitle}</H1>
      <p className="text-[16px] text-ink">{COPY.generic}</p>
      <div>{signOut}</div>
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
