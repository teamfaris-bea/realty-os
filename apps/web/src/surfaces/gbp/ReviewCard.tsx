// One Google review (module 55; R-STAFF-2, R-STAFF-4, R-STAFF-5, R-STAFF-6, E663). The reviewer, the review text and
// the draft are React text only. Stars carry their denominator ("4 of 5 stars"). An Owner or Admin can ask the
// assistant for a draft, write one, edit it, post it (ONE tap: POST /gbp/reviews/:id/reply {actionId, text}) or
// discard it, each through useAction: strict bodies, no command id, never retried by itself. Every other role reads
// only and never requests a draft, reply or discard route. A refused post stays off until the text is edited or the
// reply is drafted again (E663); a lost answer says so and is never re-sent.
import { useEffect, useId, useState } from 'react';
import { Button, Notice } from '../../design/index.js';
import { useAction } from '../admin/lib/hooks.js';
import type { ReplyResult, ReviewView } from './types.js';
import { GBP_REVIEWS_KEY } from './keys.js';
import { GUARD_NOTICE_TITLE, REPLY_UNKNOWN, gbpPlain, guardWords, refusalWords, reviewDate, starsWords } from './words.js';

const INVALIDATE = [[...GBP_REVIEWS_KEY]];
const MAX_TEXT = 5000;

interface Shown {
  sentence: string;
  items: string[];
  /** the draft and text a refused post was for: Post stays off for exactly that (E663) */
  block: { actionId: string; text: string; redraft: boolean } | null;
}

export function ReviewCard({ review, canReply, locationName, onSaid }: { review: ReviewView; canReply: boolean; locationName: string | null; onSaid: (t: string) => void }) {
  const titleId = useId();
  const textId = useId();
  const writeId = useId();
  const drafter = useAction<{ mode: 'assistant' | 'manual'; text?: string }, { review: ReviewView }>('POST', { invalidate: INVALIDATE });
  const replier = useAction<{ actionId: string; text: string }, ReplyResult>('POST', { invalidate: INVALIDATE });
  const discarder = useAction<{ actionId: string }, { review: ReviewView }>('POST', { invalidate: INVALIDATE });
  const draft = review.draft;
  const [edit, setEdit] = useState<{ actionId: string; text: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const [manual, setManual] = useState('');
  const [shown, setShown] = useState<Shown | null>(null);
  const text = draft ? (edit?.actionId === draft.actionId ? edit.text : draft.text) : '';

  // a new draft replaces what this card said about the old one
  useEffect(() => {
    setShown((s) => (s?.block && s.block.actionId !== draft?.actionId ? null : s));
  }, [draft?.actionId]);

  const busy = drafter.pending || replier.pending || discarder.pending;
  const block = shown?.block ?? null;
  const refusedHere = !!draft && !!block && block.actionId === draft.actionId && (block.redraft || block.text === text);
  // a stored draft the privacy checks flagged cannot be posted until it is edited
  const flaggedUnedited = !!draft && draft.guard.length > 0 && text === draft.text;
  const postOff = refusedHere || flaggedUnedited || text.trim() === '' || text.length > MAX_TEXT;

  const makeDraft = async (body: { mode: 'assistant' } | { mode: 'manual'; text: string }) => {
    setShown(null);
    const r = await drafter.run(`/gbp/reviews/${review.id}/draft`, body);
    if (r.ok) {
      setWriting(false);
      setManual('');
      setEdit(null);
      onSaid('Draft saved. Read it, then post it.');
    } else setShown({ ...refusalWords(r), block: null });
  };

  const post = async () => {
    if (!draft || postOff) return;
    const sent = text.trim();
    const r = await replier.run(`/gbp/reviews/${review.id}/reply`, { actionId: draft.actionId, text: sent });
    if (r.ok) {
      setShown(null);
      onSaid(gbpPlain(r.data.sentence));
      return;
    }
    if (r.code === 'NETWORK_ERROR' || r.status >= 500) {
      setShown({ sentence: REPLY_UNKNOWN, items: [], block: null });
      return;
    }
    setShown({ ...refusalWords(r, sent), block: { actionId: draft.actionId, text, redraft: r.code === 'REPLY_STALE' || r.code === 'REPLY_IN_PROGRESS' } });
  };

  const discard = async () => {
    if (!draft) return;
    setShown(null);
    const r = await discarder.run(`/gbp/reviews/${review.id}/discard`, { actionId: draft.actionId });
    if (r.ok) onSaid('Draft discarded. Nothing was posted.');
    else setShown({ ...refusalWords(r), block: null });
  };

  const date = reviewDate(review.reviewedAt);
  return (
    <article id={`review-${review.id}`} tabIndex={-1} aria-labelledby={titleId} className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">
      <div className="flex flex-col gap-0.5">
        <h3 id={titleId} className="text-[17px] font-semibold text-ink">
          {review.reviewerDisplay ?? 'A Google reviewer'}
        </h3>
        <p className="text-[15px] text-ink">
          {starsWords(review.rating)}
          {date ? <span className="text-ink-muted"> · {date}</span> : null}
          {locationName ? <span className="text-ink-muted"> · {locationName}</span> : null}
        </p>
        <p className="text-[15px] font-medium text-ink" data-testid="review-state">
          {review.stateLabel}
        </p>
      </div>
      {review.body ? <p className="whitespace-pre-wrap break-words text-[15px] text-ink">{review.body}</p> : <p className="text-[15px] italic text-ink-muted">No text</p>}

      {draft && !canReply ? (
        <div className="rounded-xl bg-surface-2 px-3.5 py-3 text-[15px] text-ink">
          <p className="font-medium">Draft reply</p>
          <p className="whitespace-pre-wrap break-words">{draft.text}</p>
        </div>
      ) : null}

      {canReply && draft && review.state === 'draft_waiting' ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={textId} className="text-[15px] font-medium text-ink">
            {draft.byAssistant ? 'Reply drafted by the assistant (you can edit it)' : 'Your reply (you can edit it)'}
          </label>
          <textarea id={textId} value={text} rows={5} maxLength={MAX_TEXT} onChange={(e) => setEdit({ actionId: draft.actionId, text: e.target.value })} className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
          {draft.guard.length > 0 ? (
            <Notice tone="warn" title={GUARD_NOTICE_TITLE}>
              <ul className="list-disc pl-5">
                {draft.guard.map((c) => (
                  <li key={c}>{guardWords(c)}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
        </div>
      ) : null}

      {canReply && writing && review.state === 'needs_reply' ? (
        <div className="flex flex-col gap-2">
          <label htmlFor={writeId} className="text-[15px] font-medium text-ink">
            Your reply
          </label>
          <textarea id={writeId} value={manual} rows={5} maxLength={MAX_TEXT} onChange={(e) => setManual(e.target.value)} className="w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink" />
        </div>
      ) : null}

      {shown ? (
        <Notice tone="error">
          <p>{shown.sentence}</p>
          {shown.items.length > 0 ? (
            <ul className="list-disc pl-5">
              {shown.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          ) : null}
        </Notice>
      ) : null}

      {canReply && review.state === 'draft_waiting' && draft ? (
        <div className="flex flex-wrap gap-2">
          <Button icon="check" pending={replier.pending} pendingLabel="Posting" disabled={postOff || (busy && !replier.pending)} onClick={() => void post()}>
            Post reply
          </Button>
          <Button variant="secondary" pending={drafter.pending} pendingLabel="Drafting" disabled={busy && !drafter.pending} onClick={() => void makeDraft({ mode: 'assistant' })}>
            Draft again with the assistant
          </Button>
          <Button variant="quiet" pending={discarder.pending} pendingLabel="Discarding" disabled={busy && !discarder.pending} onClick={() => void discard()}>
            Discard
          </Button>
        </div>
      ) : null}

      {canReply && review.state === 'needs_reply' ? (
        <div className="flex flex-wrap gap-2">
          {writing ? (
            <>
              <Button pending={drafter.pending} pendingLabel="Saving" disabled={manual.trim() === '' || (busy && !drafter.pending)} onClick={() => void makeDraft({ mode: 'manual', text: manual.trim() })}>
                Save draft
              </Button>
              <Button variant="quiet" disabled={busy} onClick={() => setWriting(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button pending={drafter.pending} pendingLabel="Drafting" disabled={busy && !drafter.pending} onClick={() => void makeDraft({ mode: 'assistant' })}>
                Draft with the assistant
              </Button>
              <Button variant="secondary" disabled={busy} onClick={() => setWriting(true)}>
                Write a reply
              </Button>
            </>
          )}
        </div>
      ) : null}
    </article>
  );
}
