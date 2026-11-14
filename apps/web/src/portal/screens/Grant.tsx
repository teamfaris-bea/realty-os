// module 46 (R-PORTALWEB-5, R-PORTALWEB-7; E125, E712, E713): one grant. Phone (< 768 px): header, next steps, a
// compact contact card, then the "Timeline | Documents" tabs. Desktop: two columns, documents in view with no tap. A
// 404 means it is no longer shared: the sentence, and /me is refetched (no stale item stays on screen).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { PortalError } from '../api.js';
import { COPY } from '../copy.js';
import { usePortal } from '../context.js';
import { downloadDocument } from '../download.js';
import { type DocumentView, type DocumentsView, GrantBody, type GrantTab, type GrantView, type TimelineView, VIEW_WORDS, parseDocuments, parseTimeline } from '../view/index.js';
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

export function Grant({ grant, tab, onTab, onBack, onGone, signOut }: GrantProps) {
  const { api, announce, save } = usePortal();
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

  const failed = (timeline.isError && !gone(timeline.error)) || (documents.isError && !gone(documents.error));
  // b15 review UI-2: a read that failed says so in the live region (again after each failed retry) and offers Try again,
  // which reads the failed parts again (busy while they run; aria-disabled keeps focus)
  const failedAt = Math.max(timeline.errorUpdatedAt, documents.errorUpdatedAt);
  useEffect(() => {
    if (failed) announce(COPY.generic);
  }, [failed, failedAt, announce]);

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

  const retrying = timeline.isFetching || documents.isFetching;
  const retry = () => {
    if (retrying) return;
    if (timeline.isError) void timeline.refetch();
    if (documents.isError) void documents.refetch();
  };
  const placeholder = failed ? (
    <div className="flex flex-col items-start gap-2">
      <p className="text-[16px] text-ink">{COPY.generic}</p>
      <button type="button" onClick={retry} aria-disabled={retrying || undefined} className={`${secondaryButton} ${retrying ? 'opacity-60' : ''}`}>
        {COPY.tryAgain}
      </button>
    </div>
  ) : (
    <p className="text-[15px] text-ink-muted">{COPY.loading}</p>
  );

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
        placeholder={placeholder}
        documentsProps={{ onDownload: (d) => void download(d), busyId: busy, error: fileError }}
      />
    </Page>
  );
}
