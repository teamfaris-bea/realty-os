// The weekly budget proposal card (module 55 items 10 and 11; R-STAFF-2, R-STAFF-3, R-STAFF-4; E668, E669). Shared by
// the Google Ads page and the Approvals inbox: the only decision path for an ad shift is POST /ads/proposals/:id/approve
// or /reject, ONE tap each through useAction (no body, no command id, never retried automatically).
//
// - The explanation always shows. The payload is read defensively (proposal.ts): each row's sentence and its from → to,
//   and the daily total against the cap's daily ceiling. Any other payload shows only the explanation and no Approve.
// - After Approve, each row's outcome in words; a pending one says "Waiting for Google Ads to confirm; checked hourly"
//   and is never sent again (E669). A failure whose outcome is unknown (network, 5xx) is said as such, never re-sent.
// - A refusal (stale, superseded, cap changed or exceeded) is said in words; the page's data refetches (useAction's
//   invalidate) and no retry control is offered (E668).
// `ProposalSlot` keeps a tapped card on screen after the refetch drops it, so its outcome stays readable.
import { useId, useState } from 'react';
import { Button, Card, Notice, announce } from '../../design/index.js';
import { formatStamp } from '../admin/lib/format.js';
import { useAction } from '../admin/lib/hooks.js';
import { parseHold, parseProposal } from './proposal.js';
import { ADS_KEY, type DecisionResponse, type RunResponse, type ShownAction } from './types.js';
import { PENDING_WORDS, dollars, refusalWords, runOutcomeWords } from './words.js';

type Named = { id: string; name: string };

const nameOf = (campaigns: readonly Named[], id: string) => campaigns.find((c) => c.id === id)?.name ?? 'A campaign no longer listed';

type Outcome =
  | { kind: 'approved'; run: RunResponse }
  | { kind: 'rejected' }
  | { kind: 'refused'; sentence: string }
  | { kind: 'unknown' };

const UNKNOWN_WORDS = 'We could not tell whether your tap reached the server. Nothing is sent again: the page shows the proposal as the server has it once it answers.';

export function ProposalCard({ proposal, campaigns, headingLevel = 2, onTapped }: { proposal: ShownAction; campaigns: readonly Named[]; headingLevel?: 2 | 3; onTapped?: () => void }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const titleId = useId();
  const parsed = parseProposal(proposal.payload);
  const approve = useAction<undefined, RunResponse>('POST', { invalidate: [ADS_KEY] });
  const reject = useAction<undefined, DecisionResponse>('POST', { invalidate: [ADS_KEY] });
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = approve.pending || reject.pending;

  const failed = (f: { code: string; status: number; details: Record<string, unknown> | null }): Outcome =>
    f.code === 'NETWORK_ERROR' || f.status >= 500 ? { kind: 'unknown' } : { kind: 'refused', sentence: refusalWords(f) };

  const doApprove = async () => {
    onTapped?.();
    const r = await approve.run(`/ads/proposals/${proposal.id}/approve`);
    if (r.ok) {
      setOutcome({ kind: 'approved', run: r.data });
      announce(r.data.rows.some((x) => x.outcome === 'pending') ? `Approved. ${PENDING_WORDS}.` : 'Approved.');
    } else setOutcome(failed(r));
  };
  const doReject = async () => {
    onTapped?.();
    const r = await reject.run(`/ads/proposals/${proposal.id}/reject`);
    if (r.ok) {
      setOutcome({ kind: 'rejected' });
      announce('Rejected. No budget changes.');
    } else setOutcome(failed(r));
  };

  const decidable = parsed !== null && proposal.status === 'proposed' && outcome === null;
  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Google Ads · {formatStamp(proposal.createdAt)}</p>
        <H id={titleId} className="text-[19px] font-semibold text-ink">
          Budget proposal
        </H>
        <p className="text-[15px] text-ink">{proposal.explanation}</p>
      </div>
      {parsed ? (
        <>
          <ul className="flex flex-col gap-2" aria-label="Campaigns in this proposal">
            {parsed.rows.map((r) => (
              <li key={r.campaignId} className="rounded-xl bg-surface-2 px-3.5 py-2.5">
                <p className="text-[16px] font-semibold text-ink">{nameOf(campaigns, r.campaignId)}</p>
                <p className="text-[15px] text-ink">
                  {r.changed ? `${dollars(r.fromDailyCents)} → ${dollars(r.toDailyCents)} a day` : `${dollars(r.fromDailyCents)} a day, unchanged`}
                </p>
                {r.sentence ? <p className="text-[14px] text-ink-muted">{r.sentence}</p> : null}
              </li>
            ))}
          </ul>
          <p className="text-[15px] text-ink" data-testid="proposal-total">
            {`Daily budgets total ${dollars(parsed.totals.proposedDailyCents)} (now ${dollars(parsed.totals.currentDailyCents)}) against your ${dollars(parsed.totals.ceilingDailyCents)} daily ceiling.`}
          </p>
        </>
      ) : null}
      <OutcomeView outcome={outcome} campaigns={campaigns} />
      {decidable ? (
        <div className="flex flex-wrap gap-2">
          <Button icon="check" pending={approve.pending} pendingLabel="Approving" disabled={busy && !approve.pending} onClick={() => void doApprove()}>
            Approve
          </Button>
          <Button variant="secondary" pending={reject.pending} pendingLabel="Rejecting" disabled={busy && !reject.pending} onClick={() => void doReject()}>
            Reject
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function OutcomeView({ outcome, campaigns }: { outcome: Outcome | null; campaigns: readonly Named[] }) {
  if (!outcome) return null;
  if (outcome.kind === 'rejected') return <Notice tone="ok">Rejected. No budget changes.</Notice>;
  if (outcome.kind === 'refused') return <Notice tone="warn">{outcome.sentence}</Notice>;
  if (outcome.kind === 'unknown') return <Notice tone="warn">{UNKNOWN_WORDS}</Notice>;
  const pending = outcome.run.rows.some((r) => r.outcome === 'pending');
  return (
    <div className="flex flex-col gap-2">
      <Notice tone={pending ? 'info' : 'ok'}>{pending ? `Approved. ${PENDING_WORDS}.` : 'Approved.'}</Notice>
      {outcome.run.rows.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="What Google Ads did">
          {outcome.run.rows.map((r) => (
            <li key={r.campaignId} className="text-[15px] text-ink">
              <span className="font-semibold">{nameOf(campaigns, r.campaignId)}</span>
              {`: ${dollars(r.fromDailyCents)} → ${dollars(r.toDailyCents)} a day. ${runOutcomeWords(r)}.`}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The pending proposal, kept on screen once tapped: the refetch after a decision or refusal drops it from GET /ads, and
 * its card (same key, same place) stays to say what happened. A newer proposal shows beside it. A hook, so the caller
 * holds the kept card above any section that may disappear with the refetch.
 */
export function useKeptProposals(pending: ShownAction | null): { shown: ShownAction[]; keep(p: ShownAction): void } {
  const [kept, setKept] = useState<ShownAction | null>(null);
  const shown = [...(kept && kept.id !== pending?.id ? [kept] : []), ...(pending ? [pending] : [])];
  return { shown, keep: setKept };
}

export function ProposalList({ shown, keep, campaigns, headingLevel = 2 }: { shown: readonly ShownAction[]; keep(p: ShownAction): void; campaigns: readonly Named[]; headingLevel?: 2 | 3 }) {
  return (
    <>
      {shown.map((p) => (
        <div key={p.id} className="min-w-0">
          <ProposalCard proposal={p} campaigns={campaigns} headingLevel={headingLevel} onTapped={() => keep(p)} />
        </div>
      ))}
    </>
  );
}

/** The latest weekly hold: its explanation and its counts, each with its window (R-STAFF-3). */
export function HoldCard({ hold, campaigns }: { hold: ShownAction; campaigns: readonly Named[] }) {
  const titleId = useId();
  const parsed = parseHold(hold.payload);
  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-2">
      <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Google Ads · {formatStamp(hold.createdAt)}</p>
      <h3 id={titleId} className="text-[19px] font-semibold text-ink">
        No budget change this week
      </h3>
      <p className="text-[15px] text-ink">{hold.explanation}</p>
      {parsed && parsed.campaigns.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label="Counts behind the hold">
          {parsed.campaigns.map((c) => (
            <li key={c.campaignId} className="text-[15px] text-ink">
              <span className="font-semibold">{nameOf(campaigns, c.campaignId)}</span>
              {`: ${c.agreements} ${c.agreements === 1 ? 'agreement' : 'agreements'}${parsed.minAgreements !== null ? ` (${parsed.minAgreements} needed)` : ''} and ${c.closings} ${c.closings === 1 ? 'closing' : 'closings'} on ${dollars(c.spendCents)} in ${parsed.windowDays} days.`}
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
