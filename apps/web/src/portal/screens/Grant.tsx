// module 46 (R-PORTALWEB-5, R-PORTALWEB-7; E125, E712, E713): one grant. Phone (< 768 px): header, next steps, a
// compact contact card, then the "Timeline | Documents" tabs. Desktop: two columns, documents in view with no tap. A
// 404 means it is no longer shared: the sentence, and /me is refetched (no stale item stays on screen).
import { type UseQueryResult, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PortalError } from '../api.js';
import { COPY } from '../copy.js';
import { usePortal } from '../context.js';
import { downloadDocument } from '../download.js';
import { type DocumentView, type DocumentsView, GrantBody, type GrantTab, type GrantView, PANEL_HEADING_ID, type TimelineView, VIEW_WORDS, parseDocuments, parseTimeline } from '../view/index.js';
import { Page, secondaryButton, useFocusHeading } from './common.js';
import { ME_KEY } from './Home.js';

const WIDE = '(min-width: 768px)';
function useWide(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const m = window.matchMedia(WIDE);
      m.addEventListener('change', fn);
      return () => m.removeEventListener('change', fn);
    },
    () => window.matchMedia(WIDE).matches,
    () => false,
  );
}

export interface GrantProps {
  grant: GrantView;
  tab: GrantTab;
  onTab(t: GrantTab): void;
  onBack: (() => void) | null;
  /** the grant answered 404: no longer shared (Home drops it and refetches /me) */
  onGone(id: string): void;
  signOut: ReactNode;
}

const gone = (e: unknown) => e instanceof PortalError && e.code === 'NOT_FOUND';

/**
 * A read that failed, and still does while Try again runs it again. b16 (b15 review new problem 1): TanStack puts a
 * query with no data back to 'pending' and clears its error when it refetches, so `isError` alone turned the failure
 * placeholder into "Loading" and unmounted the focused Try again; a query that has failed (errorUpdateCount) and still
 * has no data keeps the sentence and Try again (aria-disabled) until an answer comes.
 * b16 (b15 review new problem 2): only a read with no data shows the failure; a background refetch that fails while its
 * data is on screen leaves the data, and says nothing (no sentence, no Try again, no announcement).
 * b17 (b16 review FA-3): only a failure this screen saw counts (`before`: the query's errorUpdateCount when the grant
 * opened). errorUpdateCount lives on the cached query, so a grant reopened after its read failed showed and announced
 * "Something went wrong" while the fresh read (a query with no data is read again on mount) was still running.
 */
function failing(q: UseQueryResult<unknown, PortalError>, before: number): boolean {
  return q.data === undefined && q.errorUpdateCount > before && !gone(q.error);
}

export function Grant({ grant, tab, onTab, onBack, onGone, signOut }: GrantProps) {
  const { api, announce, forget, save } = usePortal();
  const qc = useQueryClient();
  const wide = useWide();
  const h = useFocusHeading(grant.id);
  const q = `?grantId=${encodeURIComponent(grant.id)}`;
  const timeline = useQuery<TimelineView, PortalError>({ queryKey: ['portal', 'timeline', grant.id], queryFn: ({ signal }) => api.request('GET', `/api/portal/timeline${q}`, parseTimeline, undefined, { signal }) });
  const documents = useQuery<DocumentsView, PortalError>({ queryKey: ['portal', 'documents', grant.id], queryFn: ({ signal }) => api.request('GET', `/api/portal/documents${q}`, parseDocuments, undefined, { signal }) });
  const [busy, setBusy] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const isGone = gone(timeline.error) || gone(documents.error);

  useEffect(() => {
    if (!isGone) return;
    qc.removeQueries({ queryKey: ['portal', 'timeline', grant.id] });
    qc.removeQueries({ queryKey: ['portal', 'documents', grant.id] });
    onGone(grant.id);
  }, [isGone, qc, grant.id, onGone]);

  // failures from before this grant opened (its cached queries') are not this screen's (FA-3)
  const before = useRef({ timeline: timeline.errorUpdateCount, documents: documents.errorUpdateCount });
  const tlFailed = failing(timeline, before.current.timeline);
  const docFailed = failing(documents, before.current.documents);
  // b15 review UI-2: a read that failed says so in the live region (again after each failed retry) and offers Try again,
  // which reads the failed parts again (busy while they run; aria-disabled keeps focus). Only a panel that shows the
  // failure counts (b16): a loaded panel's failed background refetch is not announced.
  // b17 (b16 review L16-2): only a failure newer than the last one announced is said. failedAt is a max over the panels
  // failing now, so it fell back to the other panel's older failure when a retried panel succeeded, and that success
  // was answered "Something went wrong".
  const failedAt = Math.max(tlFailed ? timeline.errorUpdatedAt : 0, docFailed ? documents.errorUpdatedAt : 0);
  const announcedAt = useRef(0);
  useEffect(() => {
    if (failedAt <= announcedAt.current) return;
    announcedAt.current = failedAt;
    announce(COPY.generic);
  }, [failedAt, announce]);
  // nothing fails any more (a Try again worked): the sentence is no longer true, and the live region drops it
  const anyFailed = tlFailed || docFailed;
  useEffect(() => {
    if (!anyFailed && announcedAt.current > 0) forget(COPY.generic);
  }, [anyFailed, forget]);
  // nor once the client leaves the grant (back to the list): its failure is not what is on screen
  useEffect(
    () => () => {
      if (announcedAt.current > 0) forget(COPY.generic);
    },
    [forget],
  );

  // b17 (b16 review FA-2): a Try again that succeeds replaces its placeholder, the focused button with it, by the
  // section's data; focus then moves to that section's heading (tabIndex -1), which a screen reader reads, instead of
  // falling to <body> in silence. Only after a Try again, and only when focus was lost: a client who moved on keeps it.
  const retried = useRef<Record<GrantTab, boolean>>({ timeline: false, documents: false });
  const tlLoaded = timeline.data !== undefined;
  const docLoaded = documents.data !== undefined;
  useLayoutEffect(() => {
    for (const [panel, loaded] of [
      ['timeline', tlLoaded],
      ['documents', docLoaded],
    ] as const) {
      if (!loaded || !retried.current[panel]) continue;
      retried.current[panel] = false;
      const lost = document.activeElement === null || document.activeElement === document.body;
      if (lost) document.getElementById(PANEL_HEADING_ID[panel])?.focus();
    }
  }, [tlLoaded, docLoaded]);

  if (isGone) return null;

  const download = async (d: DocumentView) => {
    if (busy) return;
    setBusy(d.itemId);
    setFileError(null);
    try {
      const r = await downloadDocument(
        api,
        d.itemId,
        async () => {
          await qc.refetchQueries({ queryKey: ME_KEY, exact: true });
          if (!api.hasCsrf()) throw new PortalError('PORTAL_SESSION_REQUIRED', 401);
        },
        save,
      );
      if (!r.ok && r.reason !== 'session') {
        const text = r.reason === 'csrf' ? COPY.generic : VIEW_WORDS.fileUnavailable;
        setFileError(text);
        announce(text);
        void qc.invalidateQueries({ queryKey: ['portal', 'documents', grant.id] });
        void qc.invalidateQueries({ queryKey: ME_KEY });
      }
    } finally {
      setBusy(null);
    }
  };

  // b16: each section has its own placeholder, and its Try again reads only that part again
  const placeholder = (panel: GrantTab, read: UseQueryResult<unknown, PortalError>, failedHere: boolean) => {
    if (!failedHere) return <p className="text-[15px] text-ink-muted">{COPY.loading}</p>;
    const retrying = read.isFetching;
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[16px] text-ink">{COPY.generic}</p>
        <button
          type="button"
          onClick={() => {
            if (retrying) return;
            retried.current[panel] = true;
            void read.refetch();
          }}
          aria-disabled={retrying || undefined}
          className={`${secondaryButton} ${retrying ? 'opacity-60' : ''}`}
        >
          {COPY.tryAgain}
        </button>
      </div>
    );
  };

  return (
    <Page wide={wide}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {onBack ? (
          <button type="button" onClick={onBack} className={secondaryButton}>
            {VIEW_WORDS.portalTitle}
          </button>
        ) : (
          <span />
        )}
        {signOut}
      </div>
      <GrantBody
        grant={grant}
        timeline={timeline.data ?? null}
        documents={documents.data?.documents ?? null}
        mode="client"
        layout={wide ? 'both' : 'tabs'}
        tab={tab}
        onTab={onTab}
        headingRef={h}
        placeholders={{ timeline: placeholder('timeline', timeline, tlFailed), documents: placeholder('documents', documents, docFailed) }}
        documentsProps={{ onDownload: (d) => void download(d), busyId: busy, error: fileError }}
      />
    </Page>
  );
}
