// Erase a contact (R-DATA-4 privacy erasure, E59; api/admin erasure.ts). VERIFY WITH COUNSEL.
//
// - Owner and Admin only; every call needs a password confirmation within 15 minutes (R-PERM-13):
//   a REAUTH_REQUIRED answer opens the shell's prompt once and the same request is sent again.
// - A person on any deal can't be erased: the deal is a transaction record and stays. The page says
//   so, lists the deals by name and stage, and lets the Owner (only the Owner: an Admin may erase but
//   not edit transaction records) take the person off each deal. As the primary contact of an open
//   deal they can't be taken off here (DEAL_STILL_OPEN): the page says so up front instead of
//   offering a removal that would be refused.
// - Erasing is irreversible, so it takes an explicit second step that names the person. A deal that
//   appears meanwhile (CONTACT_ON_DEAL from the erase) is worded and the deal list reloads.
// - Deep link: /admin/erasure?contact=<id> (e.g. from a contact page). Without it, a search field
//   finds the contact (GET /search, read-only reuse of the search surface's endpoint).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Button, ButtonLink, Card, Notice, TextField } from '../../design/index.js';
import { type ApiError, messageFor, useApi, useSession, useWithReauth } from '../../shell/index.js';
import { STAGE_LABEL } from '../feed/lib/format.js';
import type { DealStage, SearchResponse } from '../feed/lib/types.js';
import { plural } from './lib/format.js';
import { useAction, useAnnounce } from './lib/hooks.js';
import { ADMIN_MESSAGES } from './lib/messages.js';
import type { Role } from './lib/types.js';
import { ErrorLine, Loading, Section, SelectField, StatusLine } from './lib/ui.js';

export type ErasureReason = 'PRIVACY_REQUEST' | 'DUPLICATE_RECORD' | 'ENTERED_IN_ERROR' | 'OTHER';
export interface ErasureDeal {
  id: string;
  name: string;
  stage: string;
  link: 'primary' | 'party' | 'primary_and_party';
  closed: boolean;
}
export interface ErasurePreview {
  contactId: string;
  erasable: boolean;
  deals: ErasureDeal[];
}

const REASONS: readonly { value: ErasureReason; label: string }[] = [
  { value: 'PRIVACY_REQUEST', label: 'The person asked to be erased' },
  { value: 'DUPLICATE_RECORD', label: 'Duplicate record' },
  { value: 'ENTERED_IN_ERROR', label: 'Entered by mistake' },
  { value: 'OTHER', label: 'Other' },
];

const LINK_LABEL: Record<ErasureDeal['link'], string> = {
  primary: 'primary contact',
  party: 'on the deal',
  primary_and_party: 'primary contact and on the deal',
};

const MIN_QUERY = 2;
const DEBOUNCE_MS = 150;

const erasureKey = (id: string) => ['admin', 'erasure', id] as const;

/** Whether this viewer can take the person off this deal here (the server decides; this avoids offering a sure refusal). */
export function canRemoveFromDeal(viewer: Role | undefined, d: ErasureDeal): boolean {
  if (viewer !== 'owner') return false;
  return d.closed || d.link === 'party';
}

export default function ErasurePage() {
  const [params, setParams] = useSearchParams();
  const contactId = params.get('contact');
  const [erased, setErased] = useState<string | null>(null);
  const [status, announce] = useAnnounce();
  const pick = (id: string | null) => {
    setParams(id ? { contact: id } : {}, { replace: false });
  };
  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <p className="text-[16px] text-ink">
        Erasing deletes a contact and what Realty OS holds about them. Someone who is on a deal can't be erased until they are taken off it; the deal itself stays as a record.
      </p>
      <Notice tone="warn" title="Not yet confirmed with counsel">
        When a privacy law requires erasure for your team, and what a deal's record must keep, still has to be confirmed by a lawyer.
      </Notice>
      <StatusLine text={status} />
      {erased ? <Notice tone="ok">{erased} was erased.</Notice> : null}
      {contactId ? (
        <ContactErasure
          key={contactId}
          contactId={contactId}
          onPickAnother={() => pick(null)}
          onErased={(name) => {
            setErased(name);
            pick(null);
          }}
          announce={announce}
        />
      ) : (
        <FindContact
          onPick={(id) => {
            setErased(null);
            pick(id);
          }}
        />
      )}
    </div>
  );
}

function FindContact({ onPick }: { onPick(id: string): void }) {
  const api = useApi();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  const res = useQuery<SearchResponse, ApiError>({
    queryKey: ['search', q],
    queryFn: ({ signal }) => api.get<SearchResponse>(`/search?q=${encodeURIComponent(q)}`, { signal }),
    enabled: q.length >= MIN_QUERY,
    staleTime: 15_000,
  });
  const contacts = q.length >= MIN_QUERY ? (res.data?.contacts ?? []) : [];
  return (
    <Section title="Who should be erased?">
      <form role="search" onSubmit={(e) => e.preventDefault()}>
        <TextField
          label="Find the contact"
          hint="Name, phone, email or address"
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
      </form>
      {res.isError && q.length >= MIN_QUERY ? <Notice tone="error">{messageFor(res.error, ADMIN_MESSAGES)}</Notice> : null}
      {res.data && q.length >= MIN_QUERY && contacts.length === 0 ? <p className="text-[15px] text-ink-muted">No contacts match “{q}”.</p> : null}
      {contacts.length > 0 ? (
        <ul className="flex flex-col gap-2" aria-label="Matching contacts">
          {contacts.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => onPick(c.id)}
                className="flex min-h-tap w-full flex-col items-start justify-center rounded-xl border border-line bg-surface px-3.5 py-2 text-left active:bg-surface-2"
              >
                <span className="text-[16px] font-semibold text-ink">{c.name}</span>
                <span className="text-[14px] text-ink-muted">Matched on {c.matchedOn}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );
}

function ContactErasure({ contactId, onPickAnother, onErased, announce }: { contactId: string; onPickAnother(): void; onErased(name: string): void; announce(t: string): void }) {
  const api = useApi();
  const withReauth = useWithReauth();
  const { session } = useSession();
  const viewer = session?.tenant?.role as Role | undefined;
  const [reason, setReason] = useState<ErasureReason>('PRIVACY_REQUEST');
  // an erase refused because a deal appeared meanwhile: said here, since the erase step makes way for the deal list
  const [refusal, setRefusal] = useState<string | null>(null);
  const onRemoved = (t: string) => {
    setRefusal(null);
    announce(t);
  };
  const person = useQuery<{ contact: { displayName: string } }, ApiError>({
    queryKey: ['admin', 'erasure-contact', contactId],
    queryFn: ({ signal }) => withReauth(() => api.get(`/contacts/${contactId}`, { signal })),
  });
  const preview = useQuery<ErasurePreview, ApiError>({
    queryKey: erasureKey(contactId),
    queryFn: ({ signal }) => withReauth(() => api.get<ErasurePreview>(`/contacts/${contactId}/erasure`, { signal })),
  });
  const loadingName = person.isPending;
  const name = person.data?.contact.displayName ?? 'this contact';
  const p = preview.data;
  const canAct = p ? p.erasable || p.deals.some((d) => canRemoveFromDeal(viewer, d)) : false;

  return (
    <Section title={loadingName ? 'Contact' : name} actions={<Button variant="secondary" onClick={onPickAnother}>Pick someone else</Button>}>
      {preview.isPending || loadingName ? <Loading /> : null}
      {preview.isError ? (
        <Notice tone="error" action={<Button variant="secondary" onClick={() => void preview.refetch()}>Try again</Button>}>
          {messageFor(preview.error, ADMIN_MESSAGES)}
        </Notice>
      ) : null}
      <ErrorLine message={refusal} />
      {p && !loadingName ? (
        <>
          {canAct ? (
            <SelectField label="Reason" hint="Kept in the audit log as a choice from this list, never as free text." value={reason} onChange={(e) => setReason(e.target.value as ErasureReason)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </SelectField>
          ) : null}
          {p.deals.length > 0 ? (
            <OnDeals contactId={contactId} name={name} deals={p.deals} viewer={viewer} reason={reason} announce={onRemoved} />
          ) : p.erasable ? (
            <EraseStep contactId={contactId} name={name} reason={reason} onErased={() => onErased(name)} onRefused={setRefusal} />
          ) : null}
        </>
      ) : null}
    </Section>
  );
}

function OnDeals({ contactId, name, deals, viewer, reason, announce }: { contactId: string; name: string; deals: ErasureDeal[]; viewer: Role | undefined; reason: ErasureReason; announce(t: string): void }) {
  return (
    <div className="flex flex-col gap-3">
      <Notice tone="info">
        {name} is on {plural(deals.length, 'deal')}, so they can't be erased yet. A deal is a transaction record and stays; {name} has to be taken off {deals.length === 1 ? 'it' : 'each one'} first.
      </Notice>
      {viewer !== 'owner' ? <p className="text-[15px] text-ink">Only the account Owner can remove someone from a deal. Ask the Owner to do it, then come back here to erase {name}.</p> : null}
      <ul className="flex flex-col gap-2" aria-label={`Deals ${name} is on`}>
        {deals.map((d) => (
          <DealRow key={d.id} contactId={contactId} name={name} deal={d} viewer={viewer} reason={reason} announce={announce} />
        ))}
      </ul>
    </div>
  );
}

function DealRow({ contactId, name, deal, viewer, reason, announce }: { contactId: string; name: string; deal: ErasureDeal; viewer: Role | undefined; reason: ErasureReason; announce(t: string): void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useAction<{ reason: ErasureReason }, { removed: true }>('POST', { invalidate: [[...erasureKey(contactId)]] });
  const stage = STAGE_LABEL[deal.stage as DealStage] ?? deal.stage;
  const primaryOnOpen = !deal.closed && deal.link !== 'party';
  const removable = canRemoveFromDeal(viewer, deal);
  const titleId = useId();
  return (
    <Card as="li" className="flex flex-col gap-3" aria-labelledby={titleId}>
      <div>
        <p id={titleId} className="text-[16px] font-semibold text-ink">
          {deal.name}
        </p>
        <p className="text-[14px] text-ink-muted">
          {stage} · {LINK_LABEL[deal.link]}
        </p>
      </div>
      {primaryOnOpen && viewer === 'owner' ? (
        <>
          <p className="text-[15px] text-ink">This deal is still open and {name} is its primary contact. Change the primary contact on the deal first, then remove them here.</p>
          <ButtonLink variant="secondary" to={`/deals/${deal.id}`} className="self-start">
            Open {deal.name}
          </ButtonLink>
        </>
      ) : null}
      {removable && !confirming ? (
        <Button
          variant="secondary"
          className="self-start"
          onClick={() => {
            remove.reset();
            setConfirming(true);
          }}
        >
          Remove from this deal
        </Button>
      ) : null}
      {removable && confirming ? (
        <div className="flex flex-col gap-3 rounded-xl bg-surface-2 p-3">
          <p className="text-[15px] text-ink">
            {name} is taken off {deal.name}. The deal and its history stay, and the change is noted in the audit log.
          </p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="secondary" onClick={() => setConfirming(false)} disabled={remove.pending}>
              Keep on deal
            </Button>
            <Button
              pending={remove.pending}
              pendingLabel="Removing"
              onClick={async () => {
                const r = await remove.run(`/contacts/${contactId}/deals/${deal.id}/remove`, { reason });
                if (r.ok) announce(`${name} was removed from ${deal.name}. The deal record stays.`);
                else setConfirming(false);
              }}
            >
              {`Remove ${name} from ${deal.name}`}
            </Button>
          </div>
        </div>
      ) : null}
      <ErrorLine message={remove.error?.message} />
    </Card>
  );
}

function EraseStep({ contactId, name, reason, onErased, onRefused }: { contactId: string; name: string; reason: ErasureReason; onErased(): void; onRefused(message: string): void }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const erase = useAction<{ reason: ErasureReason }, { erased: true }>('POST');
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) heading.current?.focus();
  }, [confirming]);
  const cancel = () => {
    setConfirming(false);
    setTimeout(() => opener.current?.focus(), 0);
  };
  return (
    <div className="flex flex-col gap-3">
      <p className="text-[15px] text-ink">
        {name} is on no deals, so they can be erased. This deletes {name} and what Realty OS holds about them, such as messages and call recordings. An opt-out they gave is kept without their
        details, so they aren't contacted again by mistake. The audit log notes that an erasure happened and why.
      </p>
      {!confirming ? (
        <Button
          ref={opener}
          variant="danger"
          className="self-start"
          onClick={() => {
            erase.reset();
            setConfirming(true);
          }}
        >
          {`Erase ${name}`}
        </Button>
      ) : (
        <div role="group" aria-labelledby={headingId} className="flex flex-col gap-3 rounded-xl border border-danger p-3">
          <h3 id={headingId} ref={heading} tabIndex={-1} className="text-[17px] font-semibold text-ink">
            {`Erase ${name} permanently?`}
          </h3>
          <p className="text-[15px] text-ink">This can't be undone. Their details can't be brought back afterwards.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="secondary" onClick={cancel} disabled={erase.pending}>
              Cancel
            </Button>
            <Button
              variant="danger"
              pending={erase.pending}
              pendingLabel="Erasing"
              onClick={async () => {
                const r = await erase.run(`/contacts/${contactId}/erase`, { reason });
                if (r.ok) {
                  onErased();
                  return;
                }
                setConfirming(false);
                if (r.code === 'CONTACT_ON_DEAL') {
                  // a deal appeared meanwhile: say so where it stays visible, and show what erasing needs now
                  onRefused(r.message);
                  erase.reset();
                  void qc.invalidateQueries({ queryKey: erasureKey(contactId) });
                }
              }}
            >
              {`Yes, erase ${name}`}
            </Button>
          </div>
        </div>
      )}
      <ErrorLine message={erase.error?.message} />
    </div>
  );
}
