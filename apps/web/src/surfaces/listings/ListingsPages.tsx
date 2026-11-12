// Listings (BUILD_PLAN module 17; A4 seller-update data): the team's listings, and one listing with
// its price history and showings. Showings and their feedback are logged here (Phase 1 captures the
// data; assembling seller updates is Phase 2). Counts show their denominator (R-ACC-4 display half):
// "3 of 5 completed showings have feedback".
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, Notice, Ratio } from '../../design/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { formatDateTime, formatLocalDate, formatMoney } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ListingDetailView, ListingView, ShowingView } from '../feed/lib/types.js';
import { MarketingLink } from '../marketing/MarketingLink.js';

const STATUS_LABEL: Record<string, string> = { coming_soon: 'Coming soon', active: 'Active', pending: 'Pending', sold: 'Sold', withdrawn: 'Withdrawn', expired: 'Expired' };

export function factsLine(l: Pick<ListingView, 'beds' | 'bathsX10' | 'sqft'>): string {
  return [l.beds !== null ? `${l.beds} bd` : null, l.bathsX10 !== null ? `${l.bathsX10 / 10} ba` : null, l.sqft !== null ? `${l.sqft.toLocaleString('en-US')} sq ft` : null].filter(Boolean).join(' · ');
}

export function ListingsPage() {
  const api = useApi();
  const [mine, setMine] = useState(false);
  const q = useQuery<{ listings: ListingView[] }, ApiError>({
    queryKey: ['listings', mine],
    queryFn: ({ signal }) => api.get<{ listings: ListingView[] }>(`/listings?limit=200${mine ? '&mine=true' : ''}`, { signal }),
  });
  return (
    <div className="mx-auto flex w-full max-w-4xl md:mx-0 flex-col gap-4">
      <div role="radiogroup" aria-label="Show" className="flex gap-1 self-start rounded-xl bg-surface-2 p-1">
        {[false, true].map((m) => (
          <button
            key={String(m)}
            type="button"
            role="radio"
            aria-checked={mine === m}
            onClick={() => setMine(m)}
            className={`min-h-tap rounded-lg px-3 text-[15px] font-medium ${mine === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
          >
            {m ? 'Mine' : 'Team'}
          </button>
        ))}
      </div>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {q.data && q.data.listings.length === 0 ? <EmptyState icon="listing" title="No listings" /> : null}
      {q.data && q.data.listings.length > 0 ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {q.data.listings.map((l) => (
            <li key={l.id}>
              <Link to={`/listings/${l.id}`} className="block h-full rounded-2xl border border-line bg-surface p-4 hover:bg-surface-2">
                <p className="text-[16px] font-semibold text-ink">{l.addressLine1}</p>
                <p className="text-[14px] text-ink-muted">
                  {l.city}, {l.region} · {STATUS_LABEL[l.status] ?? l.status}
                </p>
                <p className="text-[15px] text-ink">{[formatMoney(l.listPriceCents), factsLine(l)].filter(Boolean).join(' · ')}</p>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <Card aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      {children}
    </Card>
  );
}

export function ListingPage() {
  const { listingId = '' } = useParams();
  const api = useApi();
  const q = useQuery<{ listing: ListingDetailView }, ApiError>({
    queryKey: ['listing', listingId],
    queryFn: ({ signal }) => api.get<{ listing: ListingDetailView }>(`/listings/${listingId}`, { signal }),
  });
  const shows = useQuery<{ showings: ShowingView[] }, ApiError>({
    queryKey: ['listing', listingId, 'showings'],
    queryFn: ({ signal }) => api.get<{ showings: ShowingView[] }>(`/listings/${listingId}/showings`, { signal }),
  });
  usePageTitle(q.data?.listing.addressLine1 ?? null);
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const l = q.data.listing;
  return (
    <div className="mx-auto flex w-full max-w-3xl md:mx-0 flex-col gap-4">
      <Section title="Listing">
        <p className="text-[17px] font-semibold text-ink">
          {l.addressLine1}
          {l.addressLine2 ? `, ${l.addressLine2}` : ''}
        </p>
        <p className="text-[15px] text-ink-muted">
          {l.city}, {l.region} {l.postalCode} · {STATUS_LABEL[l.status] ?? l.status}
          {l.mlsNumber ? ` · MLS ${l.mlsNumber}` : ''}
          {l.listDate ? ` · Listed ${formatLocalDate(l.listDate)}` : ''}
        </p>
        <p className="text-[16px] text-ink">{[formatMoney(l.listPriceCents), factsLine(l)].filter(Boolean).join(' · ')}</p>
        {l.description ? <p className="whitespace-pre-wrap text-[15px] text-ink">{l.description}</p> : null}
        {l.priceHistory.length > 1 ? (
          <ul className="text-[14px] text-ink-muted" aria-label="Price history">
            {l.priceHistory.map((p, i) => (
              <li key={`${p.changedAt}:${i}`}>
                {formatMoney(p.priceCents)} · {formatDateTime(p.changedAt)}
              </li>
            ))}
          </ul>
        ) : null}
        <MarketingLink listingId={l.id} />
      </Section>
      <Section title="Showings">
        <p className="text-[15px] text-ink">
          <Ratio value={l.showings.completed} of={l.showings.total} label="showings completed" />
          {' · '}
          <Ratio value={l.showings.withFeedback} of={l.showings.completed} label="completed showings have feedback" />
        </p>
        {shows.isError ? <Notice tone="error">{messageFor(shows.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
        <ul className="flex flex-col gap-2">
          {(shows.data?.showings ?? []).map((s) => (
            <li key={s.id}>
              <ShowingRow showing={s} editable={l.editable} listingId={l.id} />
            </li>
          ))}
        </ul>
        {l.editable ? <NewShowing listingId={l.id} /> : null}
      </Section>
    </div>
  );
}

function ShowingRow({ showing, editable, listingId }: { showing: ShowingView; editable: boolean; listingId: string }) {
  const [open, setOpen] = useState(false);
  const [rating, setRating] = useState<number | null>(null);
  const [comments, setComments] = useState('');
  const m = useMutate<Record<string, unknown>>('POST', { invalidate: [['listing', listingId]] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const r = await m.run(`/showings/${showing.id}/feedback`, { ...(rating ? { rating } : {}), ...(comments.trim() ? { comments: comments.trim() } : {}) });
    if (r.ok) {
      setOpen(false);
      setComments('');
      setRating(null);
    }
  };
  return (
    <div className="rounded-xl border border-line px-3 py-2">
      <p className="text-[15px] text-ink">
        {formatDateTime(showing.startsAt)} · {showing.status.replace(/_/g, ' ')}
        {showing.buyerAgentName ? ` · ${showing.buyerAgentName}${showing.buyerAgentBrokerage ? ` (${showing.buyerAgentBrokerage})` : ''}` : ''}
      </p>
      {showing.feedback.map((f) => (
        <p key={f.id} className="text-[14px] text-ink-muted">
          {f.rating !== null ? `${f.rating} of 5 · ` : ''}
          {f.comments ?? ''}
        </p>
      ))}
      {editable && !open ? (
        <Button variant="quiet" onClick={() => setOpen(true)}>
          Add feedback
        </Button>
      ) : null}
      {open ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2 pt-1">
          <fieldset className="flex flex-wrap items-center gap-1">
            <legend className="mb-1 text-[15px] font-medium text-ink">Rating (optional)</legend>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                aria-pressed={rating === n}
                onClick={() => setRating(rating === n ? null : n)}
                className={`min-h-tap min-w-tap rounded-xl border text-[16px] ${rating === n ? 'border-accent bg-accent-soft text-ink' : 'border-line text-ink'}`}
              >
                {n}
              </button>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            What they said
            <textarea value={comments} onChange={(e) => setComments(e.target.value)} rows={2} maxLength={4000} className="rounded-xl border border-line bg-surface px-3.5 py-2 text-[17px] text-ink" />
          </label>
          <Button type="submit" className="self-start" pending={m.pending} disabled={rating === null && !comments.trim()}>
            Save feedback
          </Button>
          {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
        </form>
      ) : null}
    </div>
  );
}

function NewShowing({ listingId }: { listingId: string }) {
  const [when, setWhen] = useState('');
  const [agent, setAgent] = useState('');
  const m = useMutate<Record<string, unknown>>('POST', { invalidate: [['listing', listingId]] });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return;
    const r = await m.run(`/listings/${listingId}/showings`, { startsAt: at.toISOString(), ...(agent.trim() ? { buyerAgentName: agent.trim() } : {}) });
    if (r.ok) {
      setWhen('');
      setAgent('');
    }
  };
  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-2 border-t border-line pt-3 md:flex-row md:items-end" aria-label="Log a showing">
      <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
        Showing time
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
      </label>
      <label className="flex flex-1 flex-col gap-1 text-[15px] font-medium text-ink">
        Buyer's agent (optional)
        <input value={agent} onChange={(e) => setAgent(e.target.value)} maxLength={120} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
      </label>
      <Button type="submit" pending={m.pending} disabled={!when}>
        Log showing
      </Button>
      {m.error ? <Notice tone="error">{m.error.message}</Notice> : null}
    </form>
  );
}
