// Pond cards (BUILD_PLAN module 17; R-PERM-6, R-OWN-16): leads waiting in a pond, as masked cards
// only (first name + last initial, intent, source, age, the PII-free summary), each with one-tap
// Claim. A claim race is settled by the server: the loser sees "Someone else claimed this lead just
// now" and the card disappears on the refetch (E1).
//
// Which ponds: Owner/Admin list every pond (GET /ponds). Other roles have no "my ponds" endpoint in
// Phase 1, so their ponds are the ones the feed names in its "new in the pond" claim actions; the
// page says so plainly instead of implying it lists everything (reported as an API gap).
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { ActionButton } from '../feed/ActionButton.js';
import { useFeed } from '../feed/FeedPage.js';
import { AgentSheetsProvider } from '../feed/lib/AgentSheets.js';
import { intentLabel, relativeTime } from '../feed/lib/format.js';
import { useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ContactCardView, FeedResponse, PondCardsResponse } from '../feed/lib/types.js';

/** Pond ids named by the feed's claim actions (pure; unit-tested). */
export function pondIdsFromFeed(feed: FeedResponse | undefined): string[] {
  if (!feed) return [];
  const ids = new Set<string>();
  for (const c of [...feed.pinned, ...feed.scored]) for (const a of [c.primaryAction, ...c.alternatives]) if (a.kind === 'claim') ids.add(a.pondId);
  return [...ids];
}

export default function PondPage() {
  return (
    <AgentSheetsProvider>
      <Ponds />
    </AgentSheetsProvider>
  );
}

function Ponds() {
  const api = useApi();
  const { session } = useSession();
  const role = session?.tenant?.role;
  const tenantWide = role === 'owner' || role === 'admin';
  const all = useQuery<{ ponds: { id: string; name: string }[] }, ApiError>({
    queryKey: ['pond', 'list'],
    queryFn: ({ signal }) => api.get<{ ponds: { id: string; name: string }[] }>('/ponds', { signal }),
    enabled: tenantWide,
  });
  const feed = useFeed();
  const ids = tenantWide ? (all.data?.ponds.map((p) => p.id) ?? []) : pondIdsFromFeed(feed.data);
  const loading = tenantWide ? all.isPending : feed.isPending;
  if (loading) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (tenantWide && all.isError) return <Notice tone="error">{messageFor(all.error, AGENT_ERROR_MESSAGES)}</Notice>;
  return (
    <div className="flex flex-col gap-6">
      {!tenantWide ? <p className="text-[15px] text-ink-muted">Ponds with new leads you can claim, from your feed.</p> : null}
      {ids.length === 0 ? (
        <EmptyState icon="pond" title="No pond leads to claim right now">
          When a lead lands in a pond you can claim from, it shows up in your feed and here.
        </EmptyState>
      ) : (
        ids.map((id) => <PondSection key={id} pondId={id} />)
      )}
    </div>
  );
}

function PondSection({ pondId }: { pondId: string }) {
  const api = useApi();
  const hid = useId();
  const q = useQuery<PondCardsResponse, ApiError>({
    queryKey: ['pond', pondId],
    queryFn: ({ signal }) => api.get<PondCardsResponse>(`/ponds/${pondId}/cards?limit=50`, { signal }),
    refetchInterval: 30_000,
  });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const { pond, cards } = q.data;
  return (
    <section aria-labelledby={hid} className="flex flex-col gap-3">
      <h2 id={hid} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {pond.name} · {cards.length === 1 ? '1 lead' : `${cards.length} leads`}
        {q.data.nextCursor ? ' (more not shown)' : ''}
      </h2>
      {cards.length === 0 ? <p className="text-[15px] text-ink-muted">Empty.</p> : null}
      <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((c) => (
          <li key={c.id}>
            <PondCard card={c} claimable={pond.claimable} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PondCard({ card, claimable }: { card: ContactCardView; claimable: boolean }) {
  const now = useNow(60_000);
  const tid = useId();
  return (
    <Card as="article" aria-labelledby={tid} className="flex h-full flex-col gap-2">
      <h3 id={tid} className="text-[19px] font-semibold text-ink">
        <Link to={`/contacts/${card.id}`} className="inline-flex min-h-tap items-center hover:underline">
          {card.displayName}
        </Link>
      </h3>
      <p className="text-[15px] text-ink-muted">{[intentLabel(card.intent), card.source?.name ? `From ${card.source.name}` : null, `Came in ${relativeTime(Date.parse(card.createdAt), now)}`].filter(Boolean).join(' · ')}</p>
      {card.pondSummary ? <p className="text-[15px] text-ink">{card.pondSummary}</p> : null}
      <div className="mt-auto pt-1">
        {claimable && card.ownership.pondId ? (
          <ActionButton action={{ kind: 'claim', label: 'Claim', contactId: card.id, pondId: card.ownership.pondId }} card={{ contact: { id: card.id, name: card.displayName }, itemType: 'pond_new' }} />
        ) : (
          <p className="text-[14px] text-ink-muted">You can't claim from this pond.</p>
        )}
      </div>
    </Card>
  );
}
