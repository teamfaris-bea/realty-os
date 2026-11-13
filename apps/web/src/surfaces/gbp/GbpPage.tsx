// Google Business Profile (module 55, /gbp; module 53's API). Every state and sentence comes from the API:
// GET /gbp/status says why Google Business Profile is off or when each location was read. While it is not cleared
// the page shows that sentence and nothing else, and requests no reviews (E678, R-STAFF-1). Otherwise
// GET /gbp/reviews lists the reviews (every staff role reads them); only an Owner or Admin drafts, posts or discards
// a reply (R-STAFF-6), each a single tap through useAction (ReviewCard.tsx). Google posts are made from a listing's
// Marketing tab; this page points there.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button, ButtonLink, Card, EmptyState, Notice, announce } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { GBP_REVIEWS_KEY, GBP_STATUS_KEY } from './keys.js';
import { ReviewCard } from './ReviewCard.js';
import type { GbpStatusView, ReviewFilter, ReviewsView } from './types.js';
import { REVIEW_LIMIT, gbpPlain } from './words.js';

const REPLY_ROLES = new Set(['owner', 'admin']);

export default function GbpPage() {
  const api = useApi();
  const status = useQuery<{ status: GbpStatusView }, ApiError>({
    queryKey: GBP_STATUS_KEY,
    queryFn: ({ signal }) => api.get<{ status: GbpStatusView }>('/gbp/status', { signal }),
  });
  const s = status.data?.status;
  return (
    <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-5 md:mx-0">
      {status.isPending ? <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p> : null}
      {status.isError ? <Notice tone="error">{messageFor(status.error)}</Notice> : null}
      {s ? (
        s.state === 'not_cleared' ? (
          // dark: the sentence only, no review request and no reply control (E678)
          <Notice tone="info" title="Google Business Profile is off">
            {gbpPlain(s.sentence)}
          </Notice>
        ) : (
          <>
            <StatusPanel status={s} />
            <Reviews status={s} />
            <Posts />
          </>
        )
      ) : null}
    </div>
  );
}

function StatusPanel({ status }: { status: GbpStatusView }) {
  return (
    <section aria-labelledby="gbp-status" className="flex flex-col gap-2">
      <h2 id="gbp-status" className="text-[19px] font-semibold text-ink">
        Status
      </h2>
      <p className="text-[15px] text-ink">{gbpPlain(status.sentence)}</p>
      {status.locations.length > 0 ? (
        <ul aria-label="Locations" className="flex flex-col gap-1 text-[15px]">
          {status.locations.map((l) => (
            <li key={l.connectionId} className="rounded-lg border border-line px-3 py-2">
              <span className="font-medium text-ink">{l.displayName}</span>
              <span className="text-ink-muted"> · {gbpPlain(l.sentence)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

const FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: 'needs_reply', label: 'Needs a reply' },
  { value: 'all', label: 'All reviews' },
];

function Reviews({ status }: { status: GbpStatusView }) {
  const api = useApi();
  const { session } = useSession();
  const canReply = REPLY_ROLES.has(session?.tenant?.role ?? '');
  const [filter, setFilter] = useState<ReviewFilter>('needs_reply');
  const [connectionId, setConnectionId] = useState('');
  const [said, setSaid] = useState<string | null>(null);
  const locationId = useId();
  const q = useQuery<{ reviews: ReviewsView }, ApiError>({
    queryKey: [...GBP_REVIEWS_KEY, filter, connectionId],
    queryFn: ({ signal }) => {
      const p = new URLSearchParams({ filter });
      if (connectionId) p.set('connectionId', connectionId);
      return api.get<{ reviews: ReviewsView }>(`/gbp/reviews?${p.toString()}`, { signal });
    },
  });
  const data = q.data?.reviews;

  // Approvals links to /gbp#review-{id}: bring that review into view once it is on the page
  const { hash } = useLocation();
  const loaded = data !== undefined;
  useEffect(() => {
    if (!loaded || !hash.startsWith('#review-')) return;
    const el = document.getElementById(decodeURIComponent(hash.slice(1)));
    el?.scrollIntoView?.({ block: 'start' });
    el?.focus({ preventScroll: true });
  }, [loaded, hash]);

  const tell = (t: string) => {
    setSaid(t);
    announce(t);
  };
  const names = new Map(status.locations.map((l) => [l.connectionId, l.displayName]));

  return (
    <section aria-labelledby="gbp-reviews" className="flex flex-col gap-3">
      <h2 id="gbp-reviews" className="text-[19px] font-semibold text-ink">
        Reviews
      </h2>
      <div className="flex flex-wrap items-end gap-3">
        <div role="group" aria-label="Show" className="flex gap-2">
          {FILTERS.map((f) => (
            <Button key={f.value} variant={filter === f.value ? 'primary' : 'secondary'} aria-pressed={filter === f.value} onClick={() => setFilter(f.value)}>
              {f.label}
            </Button>
          ))}
        </div>
        {status.locations.length > 1 ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={locationId} className="text-[15px] font-medium text-ink">
              Location
            </label>
            <select id={locationId} className="min-h-tap rounded-lg border border-line bg-surface px-3 text-[16px] text-ink" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
              <option value="">All locations</option>
              {status.locations.map((l) => (
                <option key={l.connectionId} value={l.connectionId}>
                  {l.displayName}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>
      {!canReply ? <p className="text-[15px] text-ink-muted">Only an Owner or Admin can reply.</p> : null}
      {said ? (
        <div aria-hidden="true">
          <Notice tone="ok">{said}</Notice>
        </div>
      ) : null}
      {q.isPending ? <p className="py-6 text-center text-[15px] text-ink-muted">Loading reviews</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error)}</Notice> : null}
      {data && data.state === 'not_cleared' ? <Notice tone="info">{gbpPlain(data.sentence)}</Notice> : null}
      {data && data.state === 'ready' ? (
        data.reviews.length === 0 ? (
          <EmptyState icon="message" title={gbpPlain(data.sentence)} />
        ) : (
          <>
            <p className="text-[15px] text-ink-muted">
              {gbpPlain(data.sentence)} Showing up to {REVIEW_LIMIT}, newest first.
            </p>
            <ul className="flex flex-col gap-3">
              {data.reviews.map((r) => (
                <li key={r.id}>
                  <ReviewCard review={r} canReply={canReply} locationName={status.locations.length > 1 ? (names.get(r.connectionId) ?? null) : null} onSaid={tell} />
                </li>
              ))}
            </ul>
          </>
        )
      ) : null}
    </section>
  );
}

function Posts() {
  return (
    <Card aria-labelledby="gbp-posts" className="flex flex-col gap-2">
      <h2 id="gbp-posts" className="text-[19px] font-semibold text-ink">
        Posts
      </h2>
      <p className="text-[15px] text-ink">
        Google posts are made from a listing's Marketing tab: open the listing, tap Marketing, then Make a Google post. You approve each post there before it goes anywhere.
      </p>
      <ButtonLink to="/listings" variant="secondary" className="self-start">
        Open listings
      </ButtonLink>
    </Card>
  );
}
