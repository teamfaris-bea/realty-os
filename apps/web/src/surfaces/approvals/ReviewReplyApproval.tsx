// The review-reply card of the approvals inbox (PHASE2_3_PLAN module 55 item 11; R-STAFF-1, R-STAFF-2, R-STAFF-4,
// R-STAFF-5, R-STAFF-6; E663, E678). Google Business Profile reviews waiting with a draft reply (GET
// /gbp/reviews?filter=needs_reply, state draft_waiting): "n of 5 stars", the review text and the draft as React text,
// and what the privacy guard found, in words. "Post reply" is one tap (POST /gbp/reviews/:id/reply {actionId, text},
// useAction, never retried) and shows only when the guard found nothing; a refusal keeps Post off until the reply is
// edited or drafted again on the Google Business Profile page (Edit). Discard drops the draft. Owner and Admin only
// ('gbp.reply'): the reviews are never requested for another role, nor while GET /gbp/status says not cleared.
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Notice, Ratio, announce } from '../../design/index.js';
import { type ApiError, messageFor, useApi } from '../../shell/index.js';
import { packName } from '../admin/integrations/words.js';
import { useAction } from '../admin/lib/hooks.js';
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';

export const GBP_KEY = ['gbp'] as const;

/** apps/api/src/gbp/schemas.ts GuardCode */
export type GuardCode = 'REVIEWER_NAME' | 'MONEY' | 'ADDRESS' | 'DATE' | 'CONTACT' | 'DEAL' | 'FAIR_HOUSING' | 'LENGTH';

export interface ReviewView {
  id: string;
  connectionId: string;
  rating: number | null;
  body: string | null;
  reviewerDisplay: string | null;
  reviewedAt: string;
  state: 'needs_reply' | 'draft_waiting' | 'posting' | 'checking' | 'replied' | 'replied_outside' | 'removed';
  stateLabel: string;
  draft: { actionId: string; text: string; guard: GuardCode[]; byAssistant: boolean } | null;
}

export interface GbpStatusResponse {
  status: { state: 'not_cleared' | 'not_set_up' | 'not_connected' | 'connected'; sentence: string; locations: { connectionId: string; displayName: string; sentence: string }[] };
}

export interface ReviewsResponse {
  reviews: { state: 'not_cleared' | 'ready'; sentence: string; reviews: ReviewView[] };
}

export const GUARD_WORDS: Record<GuardCode, string> = {
  REVIEWER_NAME: 'it names the reviewer',
  MONEY: 'it mentions a price or an amount',
  ADDRESS: 'it mentions an address',
  DATE: 'it mentions a date',
  CONTACT: 'it includes contact details',
  DEAL: 'it mentions deal terms',
  FAIR_HOUSING: 'it may raise a fair-housing concern',
  LENGTH: 'it is empty or too long',
};

export function guardSentence(codes: readonly string[]): string {
  const words = [...new Set(codes.map((c) => (GUARD_WORDS as Record<string, string>)[c] ?? 'it needs another look'))];
  return `Can't post yet: ${words.join('; ')}. Edit the reply first.`;
}

/** Refusals of POST /gbp/reviews/:id/reply and /discard in words (E663); the pack through packName. */
const REPLY_MESSAGES: Record<string, string> = {
  ...ADMIN_MESSAGES,
  REPLY_STALE: 'The review changed at Google after this reply was drafted. Draft the reply again.',
  REPLY_IN_PROGRESS: 'This reply is being posted right now. The card updates once Google answers.',
  GBP_NOT_CLEARED: 'Google Business Profile stays off until counsel reviews it. Nothing was posted.',
  GBP_NOT_CONFIGURED: 'Google Business Profile is not set up on this platform yet. Nothing was posted.',
  CHANNEL_NOT_CONNECTED: 'This Business Profile location is not connected. Nothing was posted.',
  NOT_FOUND: 'This draft is no longer waiting. The list is up to date.',
};

export function replyRefusal(f: { code: string; details: Record<string, unknown> | null }): string {
  const d = f.details ?? {};
  if (f.code === 'REPLY_PRIVACY') return guardSentence(Array.isArray(d.codes) ? d.codes.filter((c): c is string => typeof c === 'string') : []);
  if (f.code === 'PLATFORM_NOT_CLEARED') return `Posting waits for counsel review of ${packName(typeof d.pack === 'string' ? d.pack : '').toLowerCase()}. Nothing was posted.`;
  return messageFor({ code: f.code, details: f.details }, REPLY_MESSAGES);
}

/** The reviews waiting with a draft, for an Owner or Admin (`enabled`), only once GET /gbp/status says cleared (E678). */
export function useReviewsToReply(enabled: boolean) {
  const api = useApi();
  const status = useQuery<GbpStatusResponse, ApiError>({
    queryKey: [...GBP_KEY, 'status'],
    queryFn: ({ signal }) => api.get<GbpStatusResponse>('/gbp/status', { signal }),
    enabled,
  });
  const cleared = status.data !== undefined && status.data.status.state !== 'not_cleared';
  const reviews = useQuery<ReviewsResponse, ApiError>({
    queryKey: [...GBP_KEY, 'reviews', 'needs_reply'],
    queryFn: ({ signal }) => api.get<ReviewsResponse>('/gbp/reviews?filter=needs_reply', { signal }),
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
  const post = useAction<{ actionId: string; text: string }, { outcome: 'replied' | 'failed' | 'unknown'; sentence: string }>('POST', { invalidate: [[...GBP_KEY, 'reviews']] });
  const discard = useAction<{ actionId: string }, unknown>('POST', { invalidate: [[...GBP_KEY, 'reviews']] });
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const draft = review.draft;
  if (!draft) return null;
  const clean = draft.guard.length === 0;

  const doPost = async () => {
    onTapped?.();
    const r = await post.run(`/gbp/reviews/${review.id}/reply`, { actionId: draft.actionId, text: draft.text });
    if (r.ok) {
      setDone(r.data.sentence);
      announce(r.data.sentence);
    } else if (r.code === 'NETWORK_ERROR' || r.status >= 500) {
      setDone('We could not tell whether the reply reached the server. Nothing is posted again: the card shows what Google reports once it answers.');
    } else setRefused(replyRefusal(r));
  };
  const doDiscard = async () => {
    onTapped?.();
    const r = await discard.run(`/gbp/reviews/${review.id}/discard`, { actionId: draft.actionId });
    if (r.ok) {
      setDone('Draft discarded. The review still needs a reply.');
      announce('Draft discarded.');
    } else setRefused(replyRefusal(r));
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
      {!clean ? <Notice tone="warn">{guardSentence(draft.guard)}</Notice> : null}
      {refused ? <Notice tone="warn">{refused}</Notice> : null}
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
