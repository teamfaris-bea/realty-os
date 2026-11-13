// A listing's marketing tab (module 38, /listings/:listingId/marketing): one card per piece kind, newest
// version first, older versions collapsed under it. Reads GET /listings/:id/marketing; every word about
// where a piece went is the server's (statusLabel, publication labels; see lib.ts for the "Posted" rule).
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ListingDetailView } from '../feed/lib/types.js';
import { KIND_ORDER, errorText, kindLabel, marketingKey, usePieceCommand } from './lib.js';
import { PieceCard } from './PieceCard.js';
import type { ListingMarketingView, PieceKind, PieceView } from './types.js';

/** Pieces grouped by kind: [newest, ...older] per kind, in KIND_ORDER. */
export function groupPieces(pieces: PieceView[]): { kind: PieceKind; newest: PieceView; older: PieceView[] }[] {
  const by = new Map<PieceKind, PieceView[]>();
  for (const p of pieces) by.set(p.kind, [...(by.get(p.kind) ?? []), p]);
  const kinds = [...by.keys()].sort((a, b) => (KIND_ORDER.indexOf(a) + 1 || 99) - (KIND_ORDER.indexOf(b) + 1 || 99));
  return kinds.map((kind) => {
    const all = [...(by.get(kind) ?? [])].sort((a, b) => b.versionNo - a.versionNo);
    return { kind, newest: all[0]!, older: all.slice(1) };
  });
}

export default function MarketingPage() {
  const { listingId = '' } = useParams();
  const api = useApi();
  const listing = useQuery<{ listing: ListingDetailView }, ApiError>({
    queryKey: ['listing', listingId],
    queryFn: ({ signal }) =>
      api.get<{ listing: ListingDetailView }>(`/listings/${listingId}`, {
        signal,
      }),
  });
  const q = useQuery<ListingMarketingView, ApiError>({
    queryKey: marketingKey(listingId),
    queryFn: ({ signal }) =>
      api.get<ListingMarketingView>(`/listings/${listingId}/marketing`, {
        signal,
      }),
  });
  const l = listing.data?.listing;
  return (
    <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-col gap-4 md:mx-0">
      <p className="text-[15px] text-ink-muted">
        {l ? (
          <Link to={`/listings/${listingId}`} className="inline-flex min-h-tap items-center font-medium text-accent underline">
            {l.addressLine1}, {l.city}
          </Link>
        ) : (
          <Link to={`/listings/${listingId}`} className="inline-flex min-h-tap items-center font-medium text-accent underline">
            Back to the listing
          </Link>
        )}
      </p>
      {q.isPending ? <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {q.data ? <Marketing listingId={listingId} data={q.data} canMake={l?.editable ?? false} /> : null}
    </div>
  );
}

function Marketing({ listingId, data, canMake }: { listingId: string; data: ListingMarketingView; canMake: boolean }) {
  const groups = groupPieces(data.pieces);
  return (
    <>
      {!data.publishingCleared ? <Notice tone="info">{data.fairHousingReviewSentence}</Notice> : null}
      {groups.length === 0 ? (
        <MakeMarketing listingId={listingId} canMake={canMake} />
      ) : (
        <>
          {canMake && !groups.some((g) => g.kind === 'gbp_post') ? <MakeGooglePost listingId={listingId} /> : null}
          <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {groups.map((g) => (
              <li key={g.kind} className="flex min-w-0 flex-col gap-2" data-piece-kind={g.kind} data-piece-status={g.newest.status}>
                <PieceCard piece={g.newest} publishingCleared={data.publishingCleared} />
                {g.older.length > 0 ? (
                  <details className="rounded-2xl border border-line bg-surface px-4">
                    <summary className="flex min-h-tap cursor-pointer items-center text-[15px] font-medium text-accent">
                      Earlier versions of the {kindLabel(g.kind).toLowerCase()} ({g.older.length})
                    </summary>
                    <ul className="flex flex-col gap-2 pb-4">
                      {g.older.map((p) => (
                        <li key={p.id}>
                          <PieceCard piece={p} publishingCleared={data.publishingCleared} headingLevel={3} />
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function MakeMarketing({ listingId, canMake }: { listingId: string; canMake: boolean }) {
  const m = usePieceCommand<Record<string, unknown>, { pieces: PieceView[] }>();
  const [failure, setFailure] = useState<string | null>(null);
  const make = async () => {
    setFailure(null);
    const r = await m.run(`/listings/${listingId}/marketing/generate`, {});
    if (!r.ok) setFailure(errorText(r));
  };
  return (
    <div className="flex flex-col items-center gap-3">
      <EmptyState icon="listing" title="No marketing yet">
        {canMake ? 'Make a listing page, a social post, an open house invite, a flyer and a Marketplace listing for you to review.' : 'The listing agent can make marketing for this listing.'}
      </EmptyState>
      {canMake ? (
        <Button pending={m.pending} pendingLabel="Making drafts" onClick={() => void make()}>
          Make marketing
        </Button>
      ) : null}
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      {canMake ? <MakeGooglePost listingId={listingId} /> : null}
    </div>
  );
}

/**
 * Module 55 (owner question 8): a Business Profile post is made only on request, one draft for the listing
 * (POST generate {kinds: ['gbp_post']}). Publishing it stays with PieceCard's server options (gbp_location).
 */
function MakeGooglePost({ listingId }: { listingId: string }) {
  const m = usePieceCommand<{ kinds: PieceKind[] }, { pieces: PieceView[] }>();
  const [failure, setFailure] = useState<string | null>(null);
  const make = async () => {
    setFailure(null);
    const r = await m.run(`/listings/${listingId}/marketing/generate`, { kinds: ['gbp_post'] });
    if (!r.ok) setFailure(errorText(r));
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-[15px] text-ink-muted">A short post for your Google Business Profile, for you to review before it goes anywhere.</p>
      <Button variant="secondary" pending={m.pending} pendingLabel="Making the draft" onClick={() => void make()}>
        Make a Google post
      </Button>
      {failure ? <Notice tone="error">{failure}</Notice> : null}
    </div>
  );
}
