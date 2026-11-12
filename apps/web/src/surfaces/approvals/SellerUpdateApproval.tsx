// The approval card type for a seller update (module 38 is the Phase 2 owner of approval card types): the
// approvals inbox shows the same card as the listing page (SellerUpdateCard), loaded by the update's id, so
// the recommendation, the sources, who it reaches and the staleness check are the same wherever it is sent.
// After a send the update leaves the pending inbox; the page keeps its card (onSent) so the per-seller outcome
// stays readable instead of the card vanishing.
import { useQuery } from '@tanstack/react-query';
import { Card, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import { SellerUpdateCard, type SellerUpdateView } from '../listings/SellerUpdateCard.js';

export function SellerUpdateApproval({ actionId, onSent }: { actionId: string; onSent?: () => void }) {
  const api = useApi();
  const q = useQuery<{ update: SellerUpdateView }, ApiError>({
    queryKey: ['seller-update', 'id', actionId],
    queryFn: ({ signal }) => api.get<{ update: SellerUpdateView }>(`/seller-updates/${actionId}`, { signal }),
  });
  if (q.isPending) return <Card className="text-[15px] text-ink-muted">Loading the seller update</Card>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  return <SellerUpdateCard update={q.data.update} invalidate={[['seller-update'], ['listing', q.data.update.listingId]]} onSent={onSent} />;
}
