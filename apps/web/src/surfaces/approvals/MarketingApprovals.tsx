// The marketing approval card (module 38): drafts the person may approve (GET /marketing/approvals), each
// with its kind, the listing's address and headline, a preview, and why it can't be approved yet in words.
// Approving is ONE tap (Approve: POST /marketing-pieces/:id/approve with the contentSha256 shown). A draft
// the fair-housing or brokerage checks refuse shows the reasons and no Approve button.
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { APPROVALS_KEY, addressOf, errorText, headlineOf, kindLabel, useApprovePiece } from '../marketing/lib.js';
import { GuardNotes, PiecePreview } from '../marketing/PieceCard.js';
import type { PieceView } from '../marketing/types.js';

export function useMarketingApprovals() {
  const api = useApi();
  return useQuery<{ pieces: PieceView[] }, ApiError>({
    queryKey: APPROVALS_KEY,
    queryFn: ({ signal }) => api.get<{ pieces: PieceView[] }>('/marketing/approvals', { signal }),
    refetchInterval: 30_000,
  });
}

/**
 * The marketing drafts section of the approvals inbox. With no drafts it renders `whenEmpty` (the inbox's
 * own empty state, so "Nothing to approve" is only said when there is nothing of either kind). After a load
 * error it shows only its notice, never `whenEmpty` beside it (b14: unknown is not empty, as audit R3).
 */
export function MarketingApprovals({ whenEmpty = null }: { whenEmpty?: ReactNode }) {
  const q = useMarketingApprovals();
  const headingId = useId();
  // after an approval the card goes away: keyboard focus moves to the card now in its place (or the page heading)
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const pieces = q.data?.pieces;
  useEffect(() => {
    if (focusAt === null || !pieces) return;
    const next = pieces[Math.min(focusAt, pieces.length - 1)];
    const target = next ? document.getElementById(`marketing-title-${next.id}`) : document.querySelector<HTMLElement>('h1');
    if (target) {
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus();
      setFocusAt(null);
    }
  }, [focusAt, pieces]);
  if (q.isPending) return null;
  if (q.isError) return <Notice tone="error">{`Marketing drafts didn't load. ${messageFor(q.error, AGENT_ERROR_MESSAGES)}`}</Notice>;
  if (q.data.pieces.length === 0) return <>{whenEmpty}</>;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        Marketing to approve
      </h2>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {q.data.pieces.map((p, i) => (
          <li key={p.id} id={`marketing-${p.id}`} className="min-w-0 scroll-mt-20">
            <MarketingApprovalCard piece={p} onApproved={() => setFocusAt(i)} />
          </li>
        ))}
      </ul>
    </section>
  );
}

export function MarketingApprovalCard({ piece, onApproved }: { piece: PieceView; onApproved?: () => void }) {
  const titleId = `marketing-title-${piece.id}`;
  const sheets = useAgentSheets();
  const approve = useApprovePiece();
  const [failure, setFailure] = useState<string | null>(null);
  const address = addressOf(piece);
  const headline = headlineOf(piece);
  const doApprove = async () => {
    setFailure(null);
    const r = await approve.approve(piece);
    if (r.ok) {
      sheets.announce(`Approved: ${kindLabel(piece.kind).toLowerCase()}${address ? ` for ${address}` : ''}.`);
      onApproved?.();
    } else setFailure(errorText(r));
  };
  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {kindLabel(piece.kind)} · Version {piece.versionNo}
        </p>
        <h3 id={titleId} tabIndex={-1} className="text-[19px] font-semibold text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
          {address ? `${kindLabel(piece.kind)}: ${address}` : kindLabel(piece.kind)}
        </h3>
        {headline ? <p className="text-[15px] text-ink">{headline}</p> : null}
      </div>
      {/* the whole version is shown: Approve signs off on exactly this content (its contentSha256) */}
      <PiecePreview piece={piece} label={`${kindLabel(piece.kind)} preview`} />
      <GuardNotes piece={piece} />
      {failure ? <Notice tone="error">{failure}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        {piece.status === 'draft' && piece.guard.approvable ? (
          <Button icon="check" pending={approve.pending} pendingLabel="Approving" onClick={() => void doApprove()}>
            Approve
          </Button>
        ) : null}
        <Link to={`/listings/${piece.listingId}/marketing`} className="inline-flex min-h-tap items-center px-2 text-[17px] font-semibold text-accent">
          Open marketing
        </Link>
      </div>
    </Card>
  );
}
