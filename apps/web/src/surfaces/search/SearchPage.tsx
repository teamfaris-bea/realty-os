// Search (ARCHITECTURE §1 "Find a contact": type-ahead over name, phone digits, email, address).
//
// One field; results appear as you type (from 2 characters, 150 ms debounce; a newer query aborts
// the older request so results never arrive out of order). GET /search runs the entity queries in
// parallel under the caller's RLS with a 300 ms limit each; a group that hit the limit is marked
// "may be incomplete" instead of pretending the list is complete. Pond/offer-card contacts appear
// by name only and are labelled (R-PERM-6; they never match on phone or email server-side).
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { STAGE_LABEL, formatDateTime, formatMoney } from '../feed/lib/format.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { DealStage, SearchGroup, SearchResponse } from '../feed/lib/types.js';

export const MIN_QUERY = 2;
export const DEBOUNCE_MS = 150;

const MATCHED: Record<string, string> = { name: 'name', phone: 'phone', email: 'email', address: 'address' };
const GROUP_LABEL: Record<SearchGroup, string> = { contacts: 'Contacts', listings: 'Listings', deals: 'Deals', notes: 'Notes', messages: 'Messages' };

export default function SearchPage() {
  const api = useApi();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [params] = useSearchParams();
  const [text, setText] = useState(() => params.get('q') ?? '');
  const [q, setQ] = useState(text.trim());
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    // desktop: ready to type; a phone opens the keyboard only when the person taps the field
    if (window.matchMedia?.('(min-width: 768px)').matches) input.current?.focus();
  }, []);
  const res = useQuery<SearchResponse, ApiError>({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.length >= MIN_QUERY,
    staleTime: 15_000,
    placeholderData: (prev) => prev,
  });
  const data = q.length >= MIN_QUERY ? res.data : undefined;
  const total = data ? data.contacts.length + data.listings.length + data.deals.length + data.notes.length + data.messages.length : 0;

  return (
    <div className="mx-auto flex w-full max-w-2xl md:mx-0 flex-col gap-4">
      <form role="search" onSubmit={(e) => e.preventDefault()} className="relative">
        <label htmlFor={`${id}-q`} className="sr-only">
          Search contacts, listings, deals and messages
        </label>
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
          <Icon name="search" size={20} />
        </span>
        <input
          ref={input}
          id={`${id}-q`}
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name, phone, email or address"
          className="min-h-[48px] w-full rounded-xl border border-line bg-surface pl-10 pr-3.5 text-[17px] text-ink placeholder:text-ink-muted"
        />
      </form>
      {res.isError && q.length >= MIN_QUERY ? <Notice tone="error">{messageFor(res.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {text.trim().length > 0 && text.trim().length < MIN_QUERY ? <p className="text-[15px] text-ink-muted">Type at least {MIN_QUERY} characters.</p> : null}
      {data && total === 0 && data.incomplete.length === 0 ? <p className="text-[15px] text-ink-muted">No matches for “{q}”.</p> : null}
      {data && data.incomplete.length > 0 ? (
        <Notice tone="warn">Some results may be missing: {data.incomplete.map((g) => GROUP_LABEL[g].toLowerCase()).join(', ')} took too long to search.</Notice>
      ) : null}
      {data ? (
        <div className="flex flex-col gap-5" aria-live="polite" aria-busy={res.isFetching || undefined}>
          {data.contacts.length > 0 ? (
            <Group title="Contacts">
              {data.contacts.map((c) => (
                <Row key={c.id} to={`/contacts/${c.id}`} title={c.name} detail={c.view === 'card' ? 'Pond or offer lead · claim or accept to see details' : `Matched on ${MATCHED[c.matchedOn] ?? c.matchedOn}`} />
              ))}
            </Group>
          ) : null}
          {data.listings.length > 0 ? (
            <Group title="Listings">
              {data.listings.map((l) => (
                <Row key={l.id} to={`/listings/${l.id}`} title={l.address} detail={[l.city, l.status.replace(/_/g, ' '), formatMoney(l.listPriceCents)].filter(Boolean).join(' · ')} />
              ))}
            </Group>
          ) : null}
          {data.deals.length > 0 ? (
            <Group title="Deals">
              {data.deals.map((d) => (
                <Row key={d.id} to={`/deals/${d.id}`} title={d.name} detail={STAGE_LABEL[d.stage as DealStage] ?? d.stage} />
              ))}
            </Group>
          ) : null}
          {data.messages.length > 0 ? (
            <Group title="Messages">
              {data.messages.map((m) => (
                <Row key={m.id} to={`/contacts/${m.contactId}/thread#${m.id}`} title={m.snippet} detail={`${m.channel === 'email' ? 'Email' : 'Text'} · ${formatDateTime(m.occurredAt)}`} />
              ))}
            </Group>
          ) : null}
          {data.notes.length > 0 ? (
            <Group title="Notes">
              {data.notes.map((n) => (
                <Row key={n.id} to={n.contactId ? `/contacts/${n.contactId}` : n.dealId ? `/deals/${n.dealId}` : '/search'} title={n.snippet} detail={formatDateTime(n.createdAt)} />
              ))}
            </Group>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id}>
      <h2 id={id} className="pb-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      <ul className="overflow-hidden rounded-2xl border border-line bg-surface">{children}</ul>
    </section>
  );
}

function Row({ to, title, detail }: { to: string; title: string; detail: string }) {
  return (
    <li className="border-t border-line first:border-t-0">
      <Link to={to} className="flex min-h-[52px] items-center gap-3 px-4 py-2 hover:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-medium text-ink">{title}</span>
          <span className="block truncate text-[14px] text-ink-muted">{detail}</span>
        </span>
        <span className="text-ink-muted">
          <Icon name="chevron" size={18} />
        </span>
      </Link>
    </li>
  );
}
