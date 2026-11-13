// The contact page's "Home value (CMA)" section (module 72, web/cma; F15, E373; contact/sections.ts, full view only).
// It lists the contact's CMAs (and its merged-away records') with their status, and "Prepare CMA" is the one tap: POST
// /contacts/:id/cma (the contact's property address, else home; a second tap on unchanged data opens the same draft),
// then the CMA screen. What the server cannot prepare is said in words: with no address, where to add one; with no
// property type or size in the MLS history, the type and size to enter, then the same tap again with them. Not shown
// to an ISA or a TC (no cma.prepare).
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi, useSession } from '../../shell/index.js';
import type { ContactFullView } from '../feed/lib/types.js';
import { CMA_PROPERTY_TYPES, CMA_ROLES, type CmaPropertyType, type CmaSummary, type CmaView, type SubjectFactsBody, cmaKey, cmaMessage, contactCmasKey, day, fetchContactCmas, money, useCall } from './lib.js';
import { PROPERTY_TYPE_WORDS, STATUS_WORDS, W } from './words.js';

const STATUS_CHIP: Record<string, string> = {
  draft: 'bg-accent-soft text-ink',
  shared: 'bg-ok-soft text-ink',
  superseded: 'bg-surface-2 text-ink-muted',
};

/** Scrolls to the contact page's Details section (people-edit's PeopleSections) and moves focus to its heading. */
function goToDetails() {
  const h = [...document.querySelectorAll('h2')].find((x) => x.textContent?.trim() === 'Details');
  if (!h) return;
  h.scrollIntoView?.({ block: 'start' });
  if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
  h.focus();
}

function Row({ c }: { c: CmaSummary }) {
  const address = c.address ?? W.someHome;
  const range = c.lowCents !== null && c.highCents !== null ? W.rangeLine(money(c.lowCents), money(c.highCents)) : W.noValueShort;
  return (
    <li>
      <Link to={`/cma/${c.id}`} aria-label={W.open(address)} className="flex min-h-tap items-center gap-3 rounded-xl px-3 py-2 hover:bg-surface-2">
        <span className="min-w-0 flex-1">
          <span className="block text-[15px] font-medium text-ink [overflow-wrap:anywhere]">{address}</span>
          <span className="block text-[14px] text-ink-muted">
            {[range, day(c.valuationDate), c.mine ? null : W.byOther, c.fromMergedRecord ? W.fromMerged : null].filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className={`shrink-0 rounded-lg px-2 py-0.5 text-[13px] font-medium ${STATUS_CHIP[c.status] ?? 'bg-surface-2 text-ink'}`}>{STATUS_WORDS[c.status] ?? c.status}</span>
      </Link>
    </li>
  );
}

export function HomeValueSection({ contact }: { contact: ContactFullView }) {
  const { session } = useSession();
  const role = session?.tenant?.role;
  if (!role || !(CMA_ROLES as readonly string[]).includes(role)) return null;
  return <Inner contact={contact} />;
}

function Inner({ contact }: { contact: ContactFullView }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const hid = useId();
  const groupId = useId();
  const q = useQuery<{ cmas: CmaSummary[] }, ApiError>({ queryKey: contactCmasKey(contact.id), queryFn: ({ signal }) => fetchContactCmas(api, contact.id, signal) });
  const tap = useCall<{ facts?: SubjectFactsBody }, { cma: CmaView }>('POST', { invalidate: [contactCmasKey(contact.id)] });
  const [type, setType] = useState<CmaPropertyType | null>(null);
  const [sqft, setSqft] = useState('');
  const [factsError, setFactsError] = useState<string | null>(null);

  const missing = tap.error?.error.code === 'CMA_SUBJECT_INCOMPLETE' && Array.isArray(tap.error.error.details?.missing) ? (tap.error.error.details.missing as unknown[]).map(String) : [];
  const needsAddress = missing.includes('address');
  const needsType = !needsAddress && missing.includes('propertyType');
  const needsSize = !needsAddress && missing.includes('sqft');
  const needsFacts = needsType || needsSize;

  const prepare = async (facts?: SubjectFactsBody) => {
    const r = await tap.run(`/contacts/${contact.id}/cma`, facts ? { facts } : {});
    if (r.ok) {
      setFactsError(null);
      // the screen opens on the answer already in hand
      qc.setQueryData(cmaKey(r.data.cma.id), { cma: r.data.cma });
      navigate(`/cma/${r.data.cma.id}`);
    }
  };
  const withFacts = (e: FormEvent) => {
    e.preventDefault();
    const facts: SubjectFactsBody = {};
    if (needsType) {
      if (!type) return setFactsError(W.chooseType);
      facts.propertyType = type;
    }
    if (needsSize) {
      const n = Number(sqft.trim());
      if (!Number.isInteger(n) || n < 100 || n > 100_000) return setFactsError(W.sizeHint);
      facts.sqft = n;
    }
    setFactsError(null);
    void prepare(facts);
  };

  const cmas = q.data?.cmas ?? [];
  return (
    <section aria-labelledby={hid} className="flex scroll-mt-20 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={hid} className="flex-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {W.homeValueHeading}
        </h2>
      </div>
      {q.isPending ? <p className="text-[15px] text-ink-muted">{W.loading}</p> : null}
      {q.isError ? (
        <Notice tone="error" action={<Button variant="secondary" onClick={() => void q.refetch()}>{W.tryAgain}</Button>}>
          {cmaMessage(q.error)}
        </Notice>
      ) : null}
      {q.data ? (
        cmas.length === 0 ? (
          <p className="text-[15px] text-ink-muted">{W.noCmas}</p>
        ) : (
          <ul aria-label={W.listLabel} className="flex flex-col rounded-2xl border border-line bg-surface p-1">
            {cmas.map((c) => (
              <Row key={c.id} c={c} />
            ))}
          </ul>
        )
      ) : null}

      {needsAddress ? (
        <Notice tone="warn" action={<Button variant="secondary" onClick={goToDetails}>{W.goToDetails}</Button>}>
          {W.addAddress}
        </Notice>
      ) : tap.error && !needsFacts ? (
        <Notice tone={tap.error.error.code === 'CMA_SUBJECT_INCOMPLETE' || tap.error.error.code === 'CMA_SUBJECT_TYPE_NOT_SUPPORTED' ? 'warn' : 'error'}>{tap.error.message}</Notice>
      ) : null}

      {needsFacts ? (
        <form className="flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4" onSubmit={withFacts} noValidate>
          <p className="text-[15px] text-ink">{tap.error?.message}</p>
          <p className="text-[14px] text-ink-muted">{W.factsIntro}</p>
          {needsType ? (
            <div role="group" aria-labelledby={groupId} className="flex flex-col gap-1.5">
              <p id={groupId} className="text-[15px] font-medium text-ink">
                {W.typeLabel}
              </p>
              <div className="flex flex-wrap gap-2">
                {CMA_PROPERTY_TYPES.map((t) => (
                  <Button key={t} variant={type === t ? 'primary' : 'secondary'} aria-pressed={type === t} onClick={() => setType(t)}>
                    {PROPERTY_TYPE_WORDS[t]}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
          {needsSize ? <TextField label={W.sqftLabel} inputMode="numeric" value={sqft} onChange={(e) => setSqft(e.target.value)} hint={W.sizeHint} /> : null}
          {factsError ? <Notice tone="error">{factsError}</Notice> : null}
          <Button type="submit" className="self-start" pending={tap.pending} pendingLabel={W.preparing}>
            {W.prepareWithFacts}
          </Button>
        </form>
      ) : (
        <Button variant="secondary" icon="home" className="self-start" pending={tap.pending} pendingLabel={W.preparing} onClick={() => void prepare()}>
          {W.prepare}
        </Button>
      )}
    </section>
  );
}
