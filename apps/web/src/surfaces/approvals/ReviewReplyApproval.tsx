// The review-reply card of the approvals inbox (PHASE2_3_PLAN module 55 item 11; R-STAFF-1, R-STAFF-2, R-STAFF-4,
// R-STAFF-5, R-STAFF-6; E663, E678). Google Business Profile reviews waiting with a draft reply (GET
// /gbp/reviews?filter=needs_reply, state draft_waiting): "n of 5 stars", the review text and the draft as React text,
// and what the privacy guard found, in words. "Post reply" is one tap (POST /gbp/reviews/:id/reply {actionId, text},
// useAction, never retried) and shows only when the guard found nothing; a refusal keeps Post off until the reply is
// edited or drafted again on the Google Business Profile page (Edit). Discard drops the draft. Owner and Admin only
// ('gbp.reply'): the reviews are never requested for another role, nor while GET /gbp/status says not cleared.
// The view types, the query keys, the guard words and the refusal words are the Google Business Profile page's own
// (surfaces/gbp), so the same answer reads the same on /gbp and here (batch 14 audit R6).
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice, Ratio, announce } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { useAction } from '../admin/lib/hooks.js';
import { GBP_REVIEWS_KEY, GBP_STATUS_KEY } from '../gbp/keys.js';
import type { GbpStatusView, ReviewView, ReviewsView } from '../gbp/types.js';
import { GUARD_NOTICE_TITLE, gbpPlain, guardWords, refusalWords } from '../gbp/words.js';

/** The reviews waiting with a draft, for an Owner or Admin (`enabled`), only once GET /gbp/status says cleared (E678). */
export function useReviewsToReply(enabled: boolean) {
  const api = useApi();
  const status = useQuery<{ status: GbpStatusView }, ApiError>({
    queryKey: [...GBP_STATUS_KEY],
    queryFn: ({ signal }) => api.get<{ status: GbpStatusView }>('/gbp/status', { signal }),
    enabled,
  });
  const cleared = status.data !== undefined && status.data.status.state !== 'not_cleared';
  const reviews = useQuery<{ reviews: ReviewsView }, ApiError>({
    queryKey: [...GBP_REVIEWS_KEY, 'needs_reply'],
    queryFn: ({ signal }) => api.get<{ reviews: ReviewsView }>('/gbp/reviews?filter=needs_reply', { signal }),
    enabled: enabled && cleared,
    refetchInterval: 60_000,
  });
  const list = reviews.data && reviews.data.reviews.state === 'ready' ? reviews.data.reviews.reviews.filter((r) => r.state === 'draft_waiting' && r.draft !== null) : [];
  return {
    pending: enabled && (status.isPending || (cleared && reviews.isPending)),
    error: status.error ?? reviews.error ?? null,
    list,
  };
}

export function ReviewReplyApproval({ review, onTapped }: { review: ReviewView; onTapped?: () => void }) {
  const titleId = useId();
  const post = useAction<{ actionId: string; text: string }, { outcome: 'replied' | 'failed' | 'unknown'; sentence: string }>('POST', { invalidate: [[...GBP_REVIEWS_KEY]] });
  const discard = useAction<{ actionId: string }, unknown>('POST', { invalidate: [[...GBP_REVIEWS_KEY]] });
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ sentence: string; items: string[] } | null>(null);
  const draft = review.draft;
  if (!draft) return null;
  const clean = draft.guard.length === 0;

  const doPost = async () => {
    onTapped?.();
    const r = await post.run(`/gbp/reviews/${review.id}/reply`, { actionId: draft.actionId, text: draft.text });
    if (r.ok) {
      setDone(gbpPlain(r.data.sentence));
      announce(gbpPlain(r.data.sentence));
    } else if (r.code === 'NETWORK_ERROR' || r.status >= 500) {
      setDone('We could not tell whether the reply reached the server. Nothing is posted again: the card shows what Google reports once it answers.');
    } else setRefused(refusalWords(r, draft.text.trim()));
  };
  const doDiscard = async () => {
    onTapped?.();
    const r = await discard.run(`/gbp/reviews/${review.id}/discard`, { actionId: draft.actionId });
    if (r.ok) {
      setDone('Draft discarded. The review still needs a reply.');
      announce('Draft discarded.');
    } else setRefused(refusalWords(r));
  };

  return (
    <Card as="article" aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">Google review reply</p>
        <h3 id={titleId} className="break-words text-[19px] font-semibold text-ink">
          {review.reviewerDisplay ? `Review from ${review.reviewerDisplay}` : 'A review'}
        </h3>
        {review.rating !== null ? <Ratio value={review.rating} of={5} label="stars" className="text-[15px] text-ink" /> : null}
      </div>
      {review.body ? <blockquote className="whitespace-pre-wrap break-words rounded-xl bg-surface-2 px-3.5 py-2.5 text-[16px] text-ink">{review.body}</blockquote> : null}
      <figure className="flex flex-col gap-1">
        <figcaption className="text-[13px] font-medium text-ink-muted">{draft.byAssistant ? 'Reply the assistant drafted' : 'Reply drafted by your team'}</figcaption>
        <p className="whitespace-pre-wrap break-words text-[16px] text-ink">{draft.text}</p>
      </figure>
      {!clean ? (
        <Notice tone="warn" title={GUARD_NOTICE_TITLE}>
          <ul className="list-disc pl-5">
            {draft.guard.map((c) => (
              <li key={c}>{guardWords(c)}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      {refused ? (
        <Notice tone="warn">
          <p>{refused.sentence}</p>
          {refused.items.length > 0 ? (
            <ul className="list-disc pl-5">
              {refused.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}
      {done ? <Notice tone="info">{done}</Notice> : null}
      {done ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {clean && !refused ? (
            <Button icon="check" pending={post.pending} pendingLabel="Posting" disabled={discard.pending} onClick={() => void doPost()}>
              Post reply
            </Button>
          ) : null}
          <Link to={`/gbp#review-${review.id}`} className="inline-flex min-h-tap items-center px-2 text-[17px] font-semibold text-accent">
            Edit
          </Link>
          <Button variant="quiet" pending={discard.pending} disabled={post.pending} onClick={() => void doDiscard()}>
            Discard
          </Button>
        </div>
      )}
    </Card>
  );
}
