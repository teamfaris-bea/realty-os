// Saved buyer search review (A4, R-AST-10, R-AST-5). After a call the assistant proposes a search;
// each criterion it verified is listed checked, with the call evidence it came from. Criteria from
// claims it could NOT verify are shown prefilled but unchecked and flagged "Check this": they are
// used only if the agent checks them (R-AST-5: needs-review claims never enter search criteria on
// their own). Approve is the agent's own decision (a human acting as themselves; DB trigger), and
// alerts start only on a separate "Turn on alerts" tap: alerts are marketing and are gated at send.
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, ClaimLine, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { claimView, formatMoney } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ClaimApiView, SavedSearchView } from '../feed/lib/types.js';

/** The API previews at most this many matches (api/assistant previewSearch). */
export const MATCH_PREVIEW_CAP = 20;

const NAME: Record<string, string> = {
  postalCodes: 'ZIP codes',
  cities: 'Cities',
  priceMinCents: 'Lowest price',
  priceMaxCents: 'Highest price',
  bedsMin: 'Bedrooms',
  bathsMinX10: 'Bathrooms',
  sqftMin: 'Smallest size',
  sqftMax: 'Largest size',
  propertyTypes: 'Home types',
  keywords: 'Keywords',
};

/** A criterion value in words ("$400,000", "3+", "Condo, Townhouse"). */
export function criterionText(key: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/_/g, ' ')).join(', ');
  if (typeof v === 'number') {
    if (key.endsWith('Cents')) return formatMoney(v) ?? String(v);
    if (key === 'bathsMinX10') return `${v / 10}+`;
    if (key === 'bedsMin') return `${v}+`;
    if (key.startsWith('sqft')) return `${v.toLocaleString('en-US')} sq ft`;
    return String(v);
  }
  return String(v ?? '');
}

export function criterionName(key: string): string {
  return NAME[key] ?? key;
}

export function useContactSearches(contactId: string) {
  const api = useApi();
  return useQuery<{ searches: SavedSearchView[] }, ApiError>({
    queryKey: ['searches', contactId],
    queryFn: ({ signal }) => api.get<{ searches: SavedSearchView[] }>(`/contacts/${contactId}/saved-searches`, { signal }),
    enabled: contactId.length > 0,
  });
}

export function SavedSearchReview({ search, claims = [], onDone }: { search: SavedSearchView; claims?: ClaimApiView[]; onDone?: (s: SavedSearchView) => void }) {
  const proposed = search.status === 'proposed';
  const verified = Object.entries(search.criteria).filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0));
  const unverified = search.unchecked.filter((k) => Object.hasOwn(search.prefill, k));
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set()); // R-AST-5: none checked by default
  const approve = useMutate<Record<string, unknown>, { search: SavedSearchView }>('POST', { invalidate: [['searches', search.contactId], ['inbox'], ['feed']] });
  const activate = useMutate<Record<string, unknown>, { search: SavedSearchView }>('POST', { invalidate: [['searches', search.contactId], ['feed']] });
  const byId = new Map(claims.map((c) => [c.id, c]));

  const toggle = (set: Set<string>, k: string, update: (s: Set<string>) => void) => {
    const n = new Set(set);
    if (n.has(k)) n.delete(k);
    else n.add(k);
    update(n);
  };

  const evidenceFor = (key: string) => {
    const claimId = search.criterionEvidence[key];
    const c = claimId ? byId.get(claimId) : undefined;
    return c ? <ClaimLine claim={claimView(c, search.contactId)} /> : null;
  };

  const doApprove = async () => {
    const r = await approve.run(`/saved-searches/${search.id}/approve`, { checked: [...checked], ...(removed.size > 0 ? { removed: [...removed] } : {}) });
    if (r.ok) onDone?.(r.data.search);
  };
  const doActivate = async () => {
    const r = await activate.run(`/saved-searches/${search.id}/activate`);
    if (r.ok) onDone?.(r.data.search);
  };

  return (
    <div className="flex flex-col gap-3" data-testid="saved-search">
      <p className="text-[17px] font-semibold text-ink">{search.name}</p>
      {proposed ? <p className="text-[15px] text-ink-muted">The assistant proposed this search from your conversation. Check the criteria, then approve.</p> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="sr-only">Criteria</legend>
        {verified.map(([k, v]) => (
          <div key={k} className="flex flex-col gap-1 rounded-xl border border-line px-3 py-2">
            <label className="flex min-h-tap items-center gap-3 text-[16px] text-ink">
              <input type="checkbox" className="h-5 w-5" disabled={!proposed} checked={!removed.has(k)} onChange={() => toggle(removed, k, setRemoved)} />
              <span>
                <span className="font-medium">{criterionName(k)}:</span> {criterionText(k, v)}
              </span>
            </label>
            {evidenceFor(k)}
          </div>
        ))}
        {proposed
          ? unverified.map((k) => (
              <div key={k} className="flex flex-col gap-1 rounded-xl border border-warn/60 bg-warn-soft/40 px-3 py-2" data-needs-review="true">
                <label className="flex min-h-tap items-center gap-3 text-[16px] text-ink">
                  <input type="checkbox" className="h-5 w-5" checked={checked.has(k)} onChange={() => toggle(checked, k, setChecked)} />
                  <span>
                    <span className="font-medium">{criterionName(k)}:</span> {criterionText(k, search.prefill[k])} <span className="text-ink-muted">(check this: the assistant wasn't sure)</span>
                  </span>
                </label>
                {evidenceFor(k)}
              </div>
            ))
          : null}
      </fieldset>
      <p className="text-[15px] text-ink-muted">
        {search.matches.length === 0
          ? 'No team listings match yet.'
          : search.matches.length >= MATCH_PREVIEW_CAP
            ? `At least ${MATCH_PREVIEW_CAP} team listings match (the first ${Math.min(5, search.matches.length)} are shown).`
            : `${search.matches.length} team listing${search.matches.length === 1 ? '' : 's'} match${search.matches.length === 1 ? 'es' : ''}${search.matches.length > 5 ? ' (the first 5 are shown)' : ''}.`}
      </p>
      {search.matches.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[15px] text-ink">
          {search.matches.slice(0, 5).map((l) => (
            <li key={l.id}>
              {l.addressLine1}, {l.city} {formatMoney(l.listPriceCents) ? `· ${formatMoney(l.listPriceCents)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {approve.error ? <Notice tone="error">{approve.error.message}</Notice> : null}
      {activate.error ? <Notice tone="error">{activate.error.message}</Notice> : null}
      {proposed ? (
        <Button pending={approve.pending} onClick={() => void doApprove()} className="self-start">
          Approve search
        </Button>
      ) : search.status === 'approved' || search.status === 'paused' ? (
        <div className="flex flex-col gap-1">
          <p className="text-[15px] text-ink">Approved. Alerts are off until you turn them on.</p>
          <Button variant="secondary" pending={activate.pending} onClick={() => void doActivate()} className="self-start">
            Turn on alerts
          </Button>
        </div>
      ) : search.status === 'active' ? (
        <p className="text-[15px] text-ink">Alerts are on ({search.alertChannel === 'sms' ? 'text' : 'email'}, {search.alertFrequency}).</p>
      ) : null}
    </div>
  );
}

/** Every saved search of one contact, proposed ones first. */
export function ContactSearches({ contactId, claims }: { contactId: string; claims?: ClaimApiView[] }) {
  const q = useContactSearches(contactId);
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading saved searches</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const list = [...(q.data?.searches ?? [])].sort((a, b) => Number(b.status === 'proposed') - Number(a.status === 'proposed'));
  if (list.length === 0) return <p className="text-[15px] text-ink-muted">No saved searches yet.</p>;
  return (
    <div className="flex flex-col gap-4">
      {list.map((s) => (
        <SavedSearchReview key={s.id} search={s} {...(claims ? { claims } : {})} />
      ))}
    </div>
  );
}
