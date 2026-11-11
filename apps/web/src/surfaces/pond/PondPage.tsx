// Pond cards (BUILD_PLAN module 17; R-PERM-6, R-OWN-16): leads waiting in a pond, as masked cards
// only (first name + last initial, intent, source, age, the PII-free summary), each with one-tap
// Claim. A claim race is settled by the server: the loser sees "Someone else claimed this lead just
// now" (in the agent toast and the live region, so it outlives the card) and the card disappears on the
// refetch (E1).
//
// Which ponds (journey bug: agents never saw a pond lead): Owner/Admin list every pond (GET /ponds) and
// assign rather than claim. Everyone else gets exactly the ponds they may claim from (GET /me/ponds: an
// eligible role, the pond open to all or naming them, claims allowed), with the leads they may claim there
// (a lead they released or lost recently is left out by the server: the claim cooldown). When their own
// totals block a claim (today's claims from every pond against this pond's daily limit, or new leads they
// have not reached against the cap) the pond says so, with its numbers, instead of listing leads they cannot take.
import { useQuery } from '@tanstack/react-query';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession } from '../../shell/index.js';
import { ActionButton } from '../feed/ActionButton.js';
import { AgentSheetsProvider } from '../feed/lib/AgentSheets.js';
import { intentLabel, relativeTime } from '../feed/lib/format.js';
import { useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ContactCardView, MyPondsResponse, PondCardsResponse } from '../feed/lib/types.js';

type MyPond = MyPondsResponse['ponds'][number];

/**
 * Why the member cannot claim from a pond right now, with the numbers it rests on (null: they can), counted the way
 * the claim rule counts them (R-OWN-16): today's claims are the member's claims from every pond, held against this
 * pond's own daily limit; a claim needs fewer waiting leads than the cap, and the count can be above the cap (a
 * lowered cap, accepted offers, re-inquiries), so it says how many to reach.
 */
export function blockedSentence(p: MyPond, me: Pick<MyPondsResponse, 'claimsToday' | 'uncontactedOwned' | 'capacityCap'>): string | null {
  if (p.blockedBy === 'CLAIM_LIMIT_REACHED') {
    const claimed = `${me.claimsToday} ${me.claimsToday === 1 ? 'lead' : 'leads'}`;
    return `You've claimed ${claimed} today (from any pond), and this pond lets you claim only until you reach ${p.claimsPerDay} a day. You can claim from it again tomorrow.`;
  }
  if (p.blockedBy === 'CAPACITY_REACHED') {
    const waiting = me.uncontactedOwned;
    const need = Math.max(1, waiting - me.capacityCap + 1);
    const reach = need === 1 ? (waiting === 1 ? 'it' : 'one of them') : `${need} of them`;
    return `${waiting} of your leads ${waiting === 1 ? 'is' : 'are'} still waiting for a first call, text or email (the most is ${me.capacityCap}). Reach ${reach} before claiming more.`;
  }
  return null;
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
  const mine = useQuery<MyPondsResponse, ApiError>({
    queryKey: ['pond', 'mine'],
    queryFn: ({ signal }) => api.get<MyPondsResponse>('/me/ponds', { signal }),
    enabled: !tenantWide,
    refetchInterval: 30_000,
  });
  const q = tenantWide ? all : mine;
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const ponds = tenantWide
    ? (all.data?.ponds ?? []).map((p) => ({ id: p.id, name: p.name, blocked: null as string | null }))
    : (mine.data?.ponds ?? []).map((p) => ({ id: p.id, name: p.name, blocked: blockedSentence(p, mine.data!) }));
  return (
    <div className="flex flex-col gap-6">
      {!tenantWide ? <p className="text-[15px] text-ink-muted">Leads waiting in the ponds you can claim from. The first to claim one gets it.</p> : null}
      {ponds.length === 0 ? (
        <EmptyState icon="pond" title="No pond leads to claim right now">
          When a lead lands in a pond you can claim from, it shows up in your feed and here.
        </EmptyState>
      ) : (
        ponds.map((p) => <PondSection key={p.id} pondId={p.id} name={p.name} blocked={p.blocked} />)
      )}
    </div>
  );
}

function PondSection({ pondId, name, blocked }: { pondId: string; name: string; blocked: string | null }) {
  const api = useApi();
  const hid = useId();
  const q = useQuery<PondCardsResponse, ApiError>({
    queryKey: ['pond', pondId],
    queryFn: ({ signal }) => api.get<PondCardsResponse>(`/ponds/${pondId}/cards?limit=50`, { signal }),
    refetchInterval: 30_000,
    enabled: blocked === null,
  });
  if (blocked !== null) {
    return (
      <section aria-labelledby={hid} className="flex flex-col gap-3">
        <h2 id={hid} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {name}
        </h2>
        <Notice tone="info">{blocked}</Notice>
      </section>
    );
  }
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const { pond, cards } = q.data;
  return (
    <section aria-labelledby={hid} className="flex flex-col gap-3">
      <h2 id={hid} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {pond.name} · {cards.length === 1 ? '1 lead' : `${cards.length} leads`}
        {q.data.nextCursor ? ' (more not shown)' : ''}
      </h2>
      {cards.length === 0 ? <p className="text-[15px] text-ink-muted">{pond.claimable ? 'No leads to claim here right now.' : 'Empty.'}</p> : null}
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
