// Deals (BUILD_PLAN module 17; A7d): the agent's open deals, and one deal with its stage, its milestone
// timeline (module 39), closed-loop attribution (the lead source copied from the contact when the deal was created,
// never changed afterwards) and commission. Commission is shown only to those the server lets read
// it (R-PERM-10: Owner/Admin, the deal owner, their Team Lead; never the assistant): a 404 on
// GET /deals/:id/financials hides the section instead of showing an empty one.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, EmptyState, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { STAGE_LABEL, STAGE_ORDER, formatLocalDate, formatMoney } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { DealDetailView, DealStage, DealView, FinancialsView } from '../feed/lib/types.js';
import { MilestoneTimeline } from './MilestoneTimeline.js';
import { DocumentsSection } from '../documents/DocumentsSection.js';
import { ClientPortalSection } from '../client-portal/index.js'; // module 46

/** The stage after `s` on the happy path, or null at the end (pure; unit-tested). */
export function nextStage(s: DealStage): DealStage | null {
  const i = STAGE_ORDER.indexOf(s);
  return i >= 0 && i < STAGE_ORDER.length - 1 ? STAGE_ORDER[i + 1]! : null;
}

export function DealsPage() {
  const api = useApi();
  const [showClosed, setShowClosed] = useState(false);
  const q = useQuery<{ deals: DealView[] }, ApiError>({
    queryKey: ['deals', 'list', showClosed],
    queryFn: ({ signal }) => api.get<{ deals: DealView[] }>(`/deals?open=${showClosed ? 'false' : 'true'}`, { signal }),
  });
  return (
    <div className="mx-auto flex w-full max-w-3xl md:mx-0 flex-col gap-4">
      <div role="radiogroup" aria-label="Show" className="flex gap-1 self-start rounded-xl bg-surface-2 p-1">
        {[false, true].map((closed) => (
          <button
            key={String(closed)}
            type="button"
            role="radio"
            aria-checked={showClosed === closed}
            onClick={() => setShowClosed(closed)}
            className={`min-h-tap rounded-lg px-3 text-[15px] font-medium ${showClosed === closed ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
          >
            {closed ? 'Closed and lost' : 'Open'}
          </button>
        ))}
      </div>
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {q.data && q.data.deals.length === 0 ? (
        <EmptyState icon="deal" title={showClosed ? 'No closed deals yet' : 'No open deals'}>
          Start a deal from a contact's page.
        </EmptyState>
      ) : null}
      {q.data && q.data.deals.length > 0 ? (
        <ul className="overflow-hidden rounded-2xl border border-line bg-surface">
          {q.data.deals.map((d) => (
            <li key={d.id} className="border-t border-line first:border-t-0">
              <Link to={`/deals/${d.id}`} className="flex min-h-[56px] flex-col justify-center px-4 py-2 hover:bg-surface-2">
                <span className="text-[16px] font-medium text-ink">{d.name}</span>
                <span className="text-[14px] text-ink-muted">
                  {[STAGE_LABEL[d.stage], formatMoney(d.priceCents), d.expectedCloseDate ? `Closes ${formatLocalDate(d.expectedCloseDate)}` : null, d.attribution.leadSourceName ? `From ${d.attribution.leadSourceName}` : null].filter(Boolean).join(' · ')}
                </span>
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

export function DealPage() {
  const { dealId = '' } = useParams();
  const api = useApi();
  const q = useQuery<{ deal: DealDetailView }, ApiError>({
    queryKey: ['deal', dealId],
    queryFn: ({ signal }) => api.get<{ deal: DealDetailView }>(`/deals/${dealId}`, { signal }),
  });
  usePageTitle(q.data?.deal.name ?? null);
  const stage = useMutate<{ rowVersion: number; stage: DealStage; lostReason?: string }, { deal: DealDetailView }>('POST', { invalidate: [['deal', dealId], ['deals'], ['feed']] });
  const [losing, setLosing] = useState(false);
  const [reason, setReason] = useState('');
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const d = q.data.deal;
  const next = d.stage === 'lost' ? null : nextStage(d.stage);
  const move = (s: DealStage, lostReason?: string) => void stage.run(`/deals/${d.id}/stage`, { rowVersion: d.rowVersion, stage: s, ...(lostReason ? { lostReason } : {}) });
  const lose = (e: FormEvent) => {
    e.preventDefault();
    if (reason.trim()) move('lost', reason.trim());
  };
  return (
    <div className="mx-auto flex w-full max-w-3xl md:mx-0 flex-col gap-4">
      <Section title="Stage">
        <ol className="flex flex-wrap gap-1" aria-label="Stages">
          {STAGE_ORDER.map((s) => (
            <li key={s} aria-current={s === d.stage ? 'step' : undefined} className={`rounded-lg px-2.5 py-1 text-[14px] ${s === d.stage ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-ink-muted'}`}>
              {STAGE_LABEL[s]}
            </li>
          ))}
          {d.stage === 'lost' ? <li className="rounded-lg bg-danger-soft px-2.5 py-1 text-[14px] text-ink">Lost{d.lostReason ? `: ${d.lostReason}` : ''}</li> : null}
        </ol>
        <p className="text-[15px] text-ink">
          {[d.side === 'buy' ? 'Buying' : d.side === 'sell' ? 'Selling' : d.side, formatMoney(d.priceCents), d.expectedCloseDate ? `Closes ${formatLocalDate(d.expectedCloseDate)}` : null].filter(Boolean).join(' · ')}
          {d.primaryContact ? (
            <>
              {' · '}
              <Link to={`/contacts/${d.primaryContact.id}`} className="text-accent underline">
                {d.primaryContact.name}
              </Link>
            </>
          ) : null}
        </p>
        <div className="flex flex-wrap gap-2">
          {next ? (
            <Button pending={stage.pending} onClick={() => move(next)}>
              Move to {STAGE_LABEL[next]}
            </Button>
          ) : null}
          {d.stage !== 'closed' && d.stage !== 'lost' && !losing ? (
            <Button variant="quiet" onClick={() => setLosing(true)}>
              Mark lost
            </Button>
          ) : null}
        </div>
        {losing ? (
          <form onSubmit={lose} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-1 flex-col gap-1 text-[15px] font-medium text-ink">
              Why was it lost?
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
            </label>
            <Button type="submit" variant="danger" disabled={!reason.trim()} pending={stage.pending}>
              Mark lost
            </Button>
          </form>
        ) : null}
        {stage.error ? <Notice tone="error">{stage.error.message}</Notice> : null}
      </Section>

      {/* module 39: the milestone timeline replaces Phase 1's "Contract dates" (Done is kept there) */}
      <MilestoneTimeline dealId={d.id} />
      <DocumentsSection kind="deal" id={d.id} ownerUserId={d.ownerUserId} memberUserIds={d.members.map((m) => m.userId)} />
      {/* module 46: the client portal (invite, what the client sees, stop sharing) */}
      <ClientPortalSection dealId={d.id} primaryContact={d.primaryContact} ownerUserId={d.ownerUserId} memberUserIds={d.members.map((m) => m.userId)} />

      <Section title="Where this deal came from">
        <p className="text-[15px] text-ink">
          {d.attribution.leadSourceName ? `Lead source: ${d.attribution.leadSourceName}` : 'No lead source recorded.'}
          {d.attribution.campaignRef ? ` · Campaign ${d.attribution.campaignRef}` : ''}
          {d.attribution.adRef ? ` · Ad ${d.attribution.adRef}` : ''}
        </p>
      </Section>

      <Financials dealId={d.id} />
    </div>
  );
}

function bps(v: number | null): string | null {
  return v === null ? null : `${(v / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

function Financials({ dealId }: { dealId: string }) {
  const api = useApi();
  const q = useQuery<{ financials: FinancialsView | null }, ApiError>({
    queryKey: ['deal', dealId, 'financials'],
    queryFn: ({ signal }) => api.get<{ financials: FinancialsView | null }>(`/deals/${dealId}/financials`, { signal }),
    retry: false,
  });
  const put = useMutate<Record<string, unknown>>('PUT', { invalidate: [['deal', dealId, 'financials']] });
  const [editing, setEditing] = useState(false);
  const [gross, setGross] = useState('');
  if (q.isError && q.error.code === 'NOT_FOUND') return null;
  if (q.isPending) return null;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const f = q.data.financials;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const dollars = Number(gross.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(dollars) || dollars < 0) return;
    const r = await put.run(`/deals/${dealId}/financials`, { grossCommissionCents: Math.round(dollars * 100) });
    if (r.ok) setEditing(false);
  };
  return (
    <Section title="Commission">
      {f ? (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[15px]">
          <dt className="text-ink-muted">Gross commission</dt>
          <dd className="text-ink">{formatMoney(f.grossCommissionCents) ?? 'Not set'}</dd>
          <dt className="text-ink-muted">Rate</dt>
          <dd className="text-ink">{bps(f.commissionRateBps) ?? 'Not set'}</dd>
          <dt className="text-ink-muted">Agent split</dt>
          <dd className="text-ink">{bps(f.agentSplitBps) ?? 'Not set'}</dd>
          <dt className="text-ink-muted">Status</dt>
          <dd className="text-ink">{f.commissionStatus}</dd>
        </dl>
      ) : (
        <p className="text-[15px] text-ink-muted">Not entered yet.</p>
      )}
      {editing ? (
        <form onSubmit={(e) => void save(e)} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
            Gross commission ($)
            <input inputMode="decimal" value={gross} onChange={(e) => setGross(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
          </label>
          <Button type="submit" pending={put.pending} disabled={!gross.trim()}>
            Save
          </Button>
        </form>
      ) : (
        <Button variant="quiet" className="self-start" onClick={() => setEditing(true)}>
          {f ? 'Edit' : 'Add commission'}
        </Button>
      )}
      {put.error ? <Notice tone="error">{put.error.message}</Notice> : null}
    </Section>
  );
}
