// The seller-update card (PHASE2_3_PLAN §5.4 "38 web/listing-marketing", 2B part; R-SELL-2…5, R-AST-17;
// E87, E88, E89).
//
// The listing agent reads this week's assembled update, writes their own recommendation and taps Send. From
// the feed that is three taps on a phone: the card's "Open listing", the recommendation box, Send.
//   - Every figure says where it came from and as of when: each section's sentence on where its data stands,
//     then "Sources" with each count's evidence and the time the data was read (assembledThrough).
//   - Who it goes to is shown BEFORE the tap: each seller with the channel, or why they cannot be reached
//     (an opt-out, do-not-contact, no address, another agent's contact) in one sentence. There is no
//     "send anyway". If nobody can receive it, Send is off and says why.
//   - The recommendation is required (at least 20 characters, as the database counts them) and is never
//     prefilled; it is saved as the agent types (on leaving the box) so a reload keeps it.
//   - Feedback is shown verbatim; each item can be removed before sending, and an item that names a person
//     is flagged (E89).
//   - Stale data says so and offers one tap to refresh the update; Send stays off until then.
// No confidence, no page views and no email opens appear anywhere.
import { type FormEvent, useEffect, useId, useState } from 'react';
import type { QueryKey } from '@tanstack/react-query';
import { Button, Card, Notice } from '../../design/index.js';
import { messageFor, useCommand } from '../../shell/index.js';
import { formatDateTime } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';

export interface SellerUpdateRecipient {
  contactId: string;
  name: string | null;
  role: 'seller' | 'co_seller';
  channel: 'email' | 'sms' | null;
  addressHint: string | null;
  visible: boolean;
  ownedByYou: boolean;
  sendable: boolean;
  personDoNotContact: boolean;
  whyNot: string | null;
}

export interface SellerUpdateSection {
  kind: string;
  title: string;
  state: string;
  statement: string;
  lines: { text: string; feedback: { feedbackId: string; namesPerson: boolean; excluded: boolean } | null }[];
  sources: { text: string; evidence: { sourceType: string; sourceId: string; label: string }[] }[];
}

export interface SellerUpdateView {
  id: string;
  listingId: string;
  address: string;
  status: string;
  canSend: boolean;
  period: { start: string; end: string; key: string; label: string; text: string };
  assembledThrough: string;
  stale: boolean;
  sections: SellerUpdateSection[];
  recommendation: string;
  excludedFeedbackIds: string[];
  recipients: SellerUpdateRecipient[];
  preview: { channel: 'email' | 'sms'; subject: string; body: string };
  sentAt: string | null;
  /** after the tap: each seller's message as it stands (null before) */
  delivery: { contactId: string; name: string | null; channel: 'email' | 'sms'; status: string }[] | null;
}

interface SendResponse {
  result: string;
  recipients: { contactId: string; messageId: string | null; result: string }[];
}

/** R-SELL-3: the shortest recommendation the database accepts (Unicode characters, trimmed). */
export const RECOMMENDATION_MIN = 20;
export const recommendationLength = (s: string): number => [...s.trim()].length;

export const SELLER_UPDATE_MESSAGES: Readonly<Record<string, string>> = {
  SELLER_UPDATE_NEEDS_RECOMMENDATION: 'Write your recommendation first (at least 20 characters). Nothing was sent.',
  SELLER_UPDATE_STALE: 'Something new was logged since this update was put together. Refresh it, check it, then send. Nothing was sent.',
  SELLER_UPDATE_RECIPIENTS_CHANGED: 'Who can receive this update changed since you opened it. Check the list again. Nothing was sent.',
  SELLER_UPDATE_NO_RECIPIENT: 'None of the sellers can receive this update. Nothing was sent.',
  SELLER_UPDATE_CONFIRM_RECIPIENTS: 'Send this from the seller update card, where you can see who it reaches. Nothing was sent.',
  DRAFT_INVALIDATED: 'This listing has a different agent now, so this update was withdrawn. Nothing was sent.',
  ACTION_NOT_PENDING: 'This update was already handled.',
};

const RESULT_WORDS: Record<string, string> = {
  sent: 'Sent',
  delivered: 'Delivered',
  dispatching: 'Sending, not confirmed yet',
  scheduled: 'Queued to send',
  canceled: 'Not sent: canceled',
  queued: 'Queued to send',
  noop: 'Sent',
  dispatch_unknown: 'Sending, not confirmed yet',
  blocked: 'Not sent: blocked when sending',
  failed: 'Not sent: the provider failed',
  not_queued: 'Not sent: no address to send to',
};

const CHANNEL_WORDS = { email: 'Email', sms: 'Text' } as const;

function Recipients({ recipients }: { recipients: SellerUpdateRecipient[] }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <h3 id={id} className="text-[15px] font-semibold text-ink">
        Goes to
      </h3>
      <ul aria-labelledby={id} className="flex flex-col gap-1">
        {recipients.map((r) => (
          <li key={r.contactId} className="text-[15px]">
            <span className="font-medium text-ink">{r.name ?? 'A seller you cannot see'}</span>
            {r.sendable && r.channel ? (
              <span className="text-ink-muted">
                {' · '}
                {CHANNEL_WORDS[r.channel]}
                {r.addressHint ? ` ${r.addressHint}` : ''}
              </span>
            ) : (
              <span className="block text-danger">{r.whyNot ?? 'Not sent.'}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SectionBlock({ s, asOf, canEdit, onToggle, busy }: { s: SellerUpdateSection; asOf: string; canEdit: boolean; onToggle: (feedbackId: string, exclude: boolean) => void; busy: boolean }) {
  const id = useId();
  return (
    // a group, not a labelled <section>: a region landmark here would repeat the page's own "Showings" card
    <div role="group" aria-labelledby={id} className="flex flex-col gap-1 border-t border-line pt-3">
      <h3 id={id} className="text-[16px] font-semibold text-ink">
        {s.title}
      </h3>
      <p className="text-[14px] text-ink-muted">{s.statement}</p>
      <ul className="flex flex-col gap-1.5">
        {s.lines
          .filter((l) => l.text !== s.statement)
          .map((l, i) =>
            l.feedback ? (
              <li key={l.feedback.feedbackId} className={`flex flex-col gap-1 rounded-xl border border-line px-3 py-2 ${l.feedback.excluded ? 'opacity-70' : ''}`}>
                <blockquote className={`text-[15px] text-ink ${l.feedback.excluded ? 'line-through' : ''}`}>“{l.text}”</blockquote>
                {l.feedback.namesPerson ? <p className="text-[14px] text-warn">Names a person. Check it before you send.</p> : null}
                {l.feedback.excluded ? <p className="text-[14px] text-ink-muted">Removed: the seller will not see this.</p> : null}
                {canEdit ? (
                  <Button variant="secondary" className="self-start" disabled={busy} onClick={() => onToggle(l.feedback!.feedbackId, !l.feedback!.excluded)}>
                    {l.feedback.excluded ? 'Put it back' : 'Remove from update'}
                  </Button>
                ) : null}
              </li>
            ) : (
              <li key={`${s.kind}:${i}`} className="text-[15px] text-ink">
                {l.text}
              </li>
            ),
          )}
      </ul>
      {s.sources.length > 0 ? (
        <details className="text-[14px] text-ink-muted">
          <summary className="flex min-h-tap cursor-pointer items-center text-[15px] font-medium text-accent">Sources · as of {formatDateTime(asOf)}</summary>
          <ul className="flex flex-col gap-1 pb-1">
            {s.sources.map((src, i) => (
              <li key={i}>
                <span className="text-ink">{src.text}</span>
                <ul className="pl-3">
                  {src.evidence.map((e, j) => (
                    <li key={`${e.sourceId}:${j}`}>{e.label}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <p className="text-[14px] text-ink-muted">As of {formatDateTime(asOf)}</p>
      )}
    </div>
  );
}

const NOT_OUT = new Set(['not_queued', 'failed', 'blocked', 'canceled']);

/** The card for one update; `invalidate` are the queries that hold it (the listing's or the approval's). */
export function SellerUpdateCard({ update, invalidate, headingLevel = 2, onSent }: { update: SellerUpdateView; invalidate: QueryKey[]; headingLevel?: 2 | 3; onSent?: () => void }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const titleId = useId();
  const recId = useId();
  const helpId = useId();
  const [text, setText] = useState(update.recommendation);
  const [savedText, setSavedText] = useState(update.recommendation);
  const [result, setResult] = useState<SendResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // the removed feedback as the agent last chose it (the server copy can lag behind a refetch)
  const [excluded, setExcluded] = useState<string[]>(update.excludedFeedbackIds);
  useEffect(() => setExcluded(update.excludedFeedbackIds), [update.excludedFeedbackIds]);
  const keys: QueryKey[] = [...invalidate, ['feed'], ['inbox']];
  const patch = useMutate<Record<string, unknown>>('PATCH', { invalidate: keys });
  const reassemble = useMutate<Record<string, unknown>>('POST', { invalidate: keys });
  const send = useCommand<Record<string, unknown>, SendResponse>(`/seller-updates/${update.id}/send`, { invalidate: [...keys, ['timeline']], onSuccess: () => onSent?.() });
  useEffect(() => {
    // a fresh copy from the server (another tab, a refresh) wins only when the box holds what was saved
    if (text === savedText) {
      setText(update.recommendation);
      setSavedText(update.recommendation);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [update.recommendation]);

  const reachable = update.recipients.filter((r) => r.sendable);
  const length = recommendationLength(text);
  const enough = length >= RECOMMENDATION_MIN;
  const sent = update.status === 'approved' || update.status === 'executed' || result !== null;
  // per seller, what actually happened: the send's own answer first, else the messages as they stand now
  const outcomes = result
    ? result.recipients.map((x) => ({ contactId: x.contactId, name: update.recipients.find((r) => r.contactId === x.contactId)?.name ?? null, status: x.result }))
    : (update.delivery ?? []).map((d) => ({ contactId: d.contactId, name: d.name, status: d.status }));
  const anyOut = outcomes.some((o) => !NOT_OUT.has(o.status));
  const retryable = outcomes.some((o) => o.status === 'not_queued');
  const blockedReason = !update.canSend ? null : update.stale ? 'Refresh the update first: new data was logged since it was put together.' : reachable.length === 0 ? 'None of the sellers can receive this update.' : !enough ? `Write your recommendation: ${RECOMMENDATION_MIN - length} more character${RECOMMENDATION_MIN - length === 1 ? '' : 's'} needed.` : null;

  const save = async () => {
    if (!update.canSend || text.trim() === savedText.trim()) return;
    const r = await patch.run(`/seller-updates/${update.id}`, { recommendation: text });
    if (r.ok) setSavedText(text);
  };
  const toggle = async (feedbackId: string, exclude: boolean) => {
    const prev = excluded;
    const next = exclude ? [...new Set([...excluded, feedbackId])] : excluded.filter((x) => x !== feedbackId);
    setExcluded(next);
    const r = await patch.run(`/seller-updates/${update.id}`, { excludedFeedbackIds: next, ...(text.trim() !== savedText.trim() ? { recommendation: text } : {}) });
    if (!r.ok) setExcluded(prev);
  };
  const doReassemble = async () => {
    setError(null);
    const r = await reassemble.run(`/seller-updates/${update.id}/reassemble`);
    if (!r.ok) setError(messageFor(r, { ...AGENT_ERROR_MESSAGES, ...SELLER_UPDATE_MESSAGES }));
  };
  const doSend = async (e: FormEvent) => {
    e.preventDefault();
    if (blockedReason !== null) return;
    setError(null);
    const r = await send.run({ recommendation: text.trim(), excludedFeedbackIds: excluded, recipientIds: reachable.map((x) => x.contactId) });
    if (r.ok) setResult(r.data);
    else setError(messageFor(r, { ...AGENT_ERROR_MESSAGES, ...SELLER_UPDATE_MESSAGES }));
  };

  const retry = async () => {
    setError(null);
    const r = await send.run({ recipientIds: (update.delivery ?? []).map((d) => d.contactId) });
    if (r.ok) setResult(r.data);
    else setError(messageFor(r, { ...AGENT_ERROR_MESSAGES, ...SELLER_UPDATE_MESSAGES }));
  };

  return (
    <Card aria-labelledby={titleId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <H id={titleId} className="text-[17px] font-semibold text-ink">
          Seller update {update.period.label}
        </H>
        <p className="text-[14px] text-ink-muted">
          {update.address} · {update.period.text} · data as of {formatDateTime(update.assembledThrough)}
        </p>
      </div>

      {sent ? (
        <Notice tone={anyOut ? 'ok' : 'warn'} title={anyOut ? `Sent${update.sentAt ? ` ${formatDateTime(update.sentAt)}` : ''}` : 'Not sent yet'}>
          {outcomes.length > 0 ? (
            <ul>
              {outcomes.map((x) => (
                <li key={x.contactId}>
                  {x.name ?? 'Seller'}: {RESULT_WORDS[x.status] ?? x.status}
                </li>
              ))}
            </ul>
          ) : (
            'Approved with your recommendation; the messages are being prepared.'
          )}
          {retryable ? (
            <Button variant="secondary" className="mt-2" pending={send.pending} pendingLabel="Sending" onClick={() => void retry()}>
              Try sending again
            </Button>
          ) : null}
          {error ? <p className="mt-1 text-danger">{error}</p> : null}
        </Notice>
      ) : null}

      {!sent && update.stale ? (
        <Notice tone="warn" title="New data since this was put together">
          <p>Showings, feedback, marketing or competing listings changed after {formatDateTime(update.assembledThrough)}. Refresh it before you send.</p>
          {update.canSend ? (
            <Button variant="secondary" className="mt-2" pending={reassemble.pending} pendingLabel="Refreshing" onClick={() => void doReassemble()}>
              Refresh the update
            </Button>
          ) : null}
        </Notice>
      ) : null}
      {!sent && update.stale && error ? <Notice tone="error">{error}</Notice> : null}

      {!sent ? <Recipients recipients={update.recipients} /> : null}

      {update.sections.map((s) => (
        <SectionBlock key={s.kind} s={{ ...s, lines: s.lines.map((l) => (l.feedback ? { ...l, feedback: { ...l.feedback, excluded: excluded.includes(l.feedback.feedbackId) } } : l)) }} asOf={update.assembledThrough} canEdit={update.canSend && !sent} busy={patch.pending} onToggle={(id, ex) => void toggle(id, ex)} />
      ))}

      {update.canSend && !sent ? (
        <form onSubmit={(e) => void doSend(e)} className="flex flex-col gap-2 border-t border-line pt-3" aria-label="Send the seller update">
          <label htmlFor={recId} className="text-[16px] font-semibold text-ink">
            Your recommendation (required)
          </label>
          <p id={helpId} className="text-[14px] text-ink-muted">
            In your own words: what you suggest the seller does next. At least {RECOMMENDATION_MIN} characters; the assistant never writes this for you.
          </p>
          <textarea
            id={recId}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => void save()}
            rows={4}
            maxLength={2000}
            required
            aria-describedby={helpId}
            className="min-h-[120px] rounded-xl border border-line bg-surface px-3.5 py-2 text-[17px] text-ink"
          />
          {blockedReason ? (
            <p className="text-[14px] text-ink-muted" aria-live="polite">
              {blockedReason}
            </p>
          ) : null}
          <Button type="submit" block disabled={blockedReason !== null} pending={send.pending} pendingLabel="Sending">
            {reachable.length === 1 ? `Send to ${reachable[0]!.name ?? 'the seller'}` : `Send to ${reachable.length} sellers`}
          </Button>
          {error && !update.stale ? <Notice tone="error">{error}</Notice> : null}
          {patch.error ? <Notice tone="error">{messageFor(patch.error, { ...AGENT_ERROR_MESSAGES, ...SELLER_UPDATE_MESSAGES })}</Notice> : null}
        </form>
      ) : null}
      {!update.canSend && !sent ? <p className="text-[14px] text-ink-muted">Only the listing agent can send this update.</p> : null}
    </Card>
  );
}
