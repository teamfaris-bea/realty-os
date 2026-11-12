// Needs review: lead emails that did not become leads automatically (Owner/Admin/Team Lead; module 22's
// lead-email slice, R-INBOX-9).
//
// - Each held email shows WHY in a sentence from the server (never the code), when it came, which lead
//   source and sender domain, the subject, what was read from it (name, phones, emails, property,
//   message) and, on request, the email text itself.
// - Accept is one tap when the email holds a phone or email the server can use. Otherwise Accept opens
//   a small form for the reviewer to type a phone or email (and a name); what they type is sent as the
//   overrides. Either way the server runs the same intake and never sends an automatic first response.
//   "Lead created" then links to the new contact.
// - Discard asks first: the email leaves the list and no lead is made.
// - "Decided" lists what was accepted or discarded. A header line after the Show control says how many are
//   waiting. When none are, the Needs review list's empty state says it instead (once, not twice) and the line
//   is not rendered at all; on Decided the line says it. As on Needs attention, the line sits under the control
//   on a phone (beside it on desktop), so its coming and going never moves the control.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, Dialog, EmptyState, Notice, TextField } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatStamp, plural } from '../admin/lib/format.js';
import { useAction, useAnnounce } from '../admin/lib/hooks.js';
import { Pill, Segmented, StatusLine } from '../admin/lib/ui.js';
import { LEAD_EMAIL_ERROR_MESSAGES, sentenceFor } from './messages.js';
import { REVIEWS_KEY, type ReviewDecisionResponse, type ReviewItem, type ReviewsResponse } from './types.js';

type View = 'needs_review' | 'decided';

/** The excerpt shown under "Show the email": long enough to judge, short enough for a phone. */
export const EXCERPT_CHARS = 4000;

export function newestFirst(items: readonly ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : a.receivedAt > b.receivedAt ? -1 : 0));
}

interface Created {
  contactId: string;
  name: string;
}

export default function NeedsReviewPage() {
  const api = useApi();
  const [view, setView] = useState<View>('needs_review');
  const [status, announce] = useAnnounce(6000);
  const [created, setCreated] = useState<Created | null>(null);
  // shown above the list: a conflict refetch can remove the card the failure belongs to
  const [failure, setFailure] = useState<string | null>(null);
  const q = useQuery<ReviewsResponse, ApiError>({
    queryKey: [...REVIEWS_KEY, view],
    queryFn: ({ signal }) => api.get<ReviewsResponse>(`/lead-email/reviews?status=${view}`, { signal }),
  });
  const items = newestFirst(q.data?.items ?? []);
  const pending = q.data?.pendingCount;
  // null while loading, and with none waiting on Needs review (its empty state says so): no blank line is left
  const countLine = pending === undefined ? null : pending > 0 ? `${plural(pending, 'email')} waiting for review` : view === 'decided' ? 'No emails are waiting for review.' : null;
  const onAccepted = (c: Created) => {
    setFailure(null);
    setCreated(c);
    announce(`Lead created: ${c.name}`);
  };
  const onDiscarded = () => {
    setFailure(null);
    setCreated(null);
    announce('Email discarded. No lead was made.');
  };
  return (
    <div className="flex w-full max-w-3xl flex-col gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center">
        <Segmented<View>
          label="Show"
          value={view}
          onChange={(v) => {
            setView(v);
            setFailure(null);
          }}
          options={[
            { value: 'needs_review', label: 'Needs review' },
            { value: 'decided', label: 'Decided' },
          ]}
        />
        {countLine ? (
          <p className="text-[16px] text-ink md:ml-auto" data-testid="pending-count">
            {countLine}
          </p>
        ) : null}
      </div>
      <StatusLine text={status} />
      {created ? (
        <Notice
          tone="ok"
          title="Lead created"
          action={
            <Button variant="quiet" onClick={() => setCreated(null)}>
              Dismiss
            </Button>
          }
        >
          <Link to={`/contacts/${created.contactId}`} className="inline-flex min-h-tap items-center font-semibold text-accent underline">
            Open {created.name}
          </Link>
        </Notice>
      ) : null}
      {failure ? (
        <Notice
          tone="error"
          action={
            <Button variant="quiet" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
          }
        >
          {failure}
        </Notice>
      ) : null}
      {q.isPending ? <p className="text-[15px] text-ink-muted">Loading</p> : null}
      {q.isError ? <Notice tone="error">{sentenceFor(q.error)}</Notice> : null}
      {q.data && items.length === 0 ? (
        <EmptyState icon="check" title={view === 'needs_review' ? 'Nothing needs review' : 'Nothing decided yet'}>
          {view === 'needs_review' ? 'Lead emails that could not be trusted or read automatically wait here until someone accepts or discards them.' : 'Emails you accept or discard are listed here.'}
        </EmptyState>
      ) : null}
      <ul className="flex flex-col gap-3">
        {items.map((i) => (
          <li key={i.id}>
            <ReviewCard item={i} onAccepted={onAccepted} onDiscarded={onDiscarded} onFailure={setFailure} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function displayName(item: ReviewItem, typed?: string): string {
  return typed?.trim() || item.fields?.name?.value || item.fields?.emails[0]?.value || item.fields?.phones[0]?.value || 'the new lead';
}

export function ReviewCard({ item, onAccepted, onDiscarded, onFailure }: { item: ReviewItem; onAccepted(c: Created): void; onDiscarded(): void; onFailure(message: string): void }) {
  const hid = useId();
  const qc = useQueryClient();
  const [form, setForm] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const opts = { invalidate: [[...REVIEWS_KEY]] };
  const accept = useAction<{ name?: string; phone?: string; email?: string }, ReviewDecisionResponse>('POST', opts);
  const discard = useAction<undefined, ReviewDecisionResponse>('POST', opts);
  const decided = item.status !== 'needs_review';
  const notALead = item.holdCode === 'FORWARDING_CONFIRMATION';
  // a decided email's content is deleted on the server, so its subject may be gone too
  const subject = item.subject?.trim() || (decided ? `Email from ${item.senderDomain ?? 'an unreadable sender'}` : 'No subject');

  const fail = (e: { code: string; details: Record<string, unknown> | null }) => {
    if (e.code === 'LEAD_EMAIL_NOT_PENDING') void qc.invalidateQueries({ queryKey: [...REVIEWS_KEY] });
    onFailure(sentenceFor(e));
  };
  const runAccept = async (overrides: { name?: string; phone?: string; email?: string }, typedName?: string): Promise<boolean> => {
    const r = await accept.run(`/lead-email/reviews/${item.id}/accept`, overrides);
    if (!r.ok) {
      if (r.code === 'LEAD_EMAIL_NO_CONTACT_POINT') setForm(true);
      fail(r);
      return false;
    }
    if (r.data.contactId) onAccepted({ contactId: r.data.contactId, name: displayName(item, typedName) });
    return true;
  };
  const runDiscard = async () => {
    setConfirmDiscard(false);
    const r = await discard.run(`/lead-email/reviews/${item.id}/discard`);
    if (!r.ok) fail(r);
    else onDiscarded();
  };

  return (
    <Card as="article" aria-labelledby={hid} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={hid} className="break-words text-[17px] font-semibold text-ink">
          {subject}
        </h2>
        <p className="text-[14px] text-ink-muted">
          Received {formatStamp(item.receivedAt)} · {item.leadSourceName} · from {item.senderDomain ?? 'an unreadable sender'}
        </p>
      </div>
      {decided ? (
        <p className="flex flex-wrap items-center gap-2 text-[15px] text-ink">
          {item.status === 'accepted' ? <Pill tone="ok">Accepted</Pill> : <Pill>Discarded</Pill>}
          <span>{item.decidedAt ? formatStamp(item.decidedAt) : null}</span>
          {item.status === 'accepted' && item.contactId ? (
            <Link to={`/contacts/${item.contactId}`} className="text-accent underline">
              Open the lead
            </Link>
          ) : null}
        </p>
      ) : (
        <Notice tone="warn" title="Why it is waiting">
          {item.holdSentence}
        </Notice>
      )}
      <Extracted item={item} />
      <Excerpt item={item} />
      {!decided && !form ? (
        <div className="flex flex-wrap gap-2">
          {/* R-LEM-12 (b9 ui/F6): a forwarding confirmation is never a lead (the API refuses LEAD_EMAIL_NOT_A_LEAD): Discard only */}
          {notALead ? null : (
            <Button pending={accept.pending} onClick={() => (item.canAccept ? void runAccept({}) : setForm(true))} aria-label={`Accept: ${subject}`}>
              Accept
            </Button>
          )}
          <Button variant="secondary" pending={discard.pending} onClick={() => setConfirmDiscard(true)} aria-label={`Discard: ${subject}`}>
            Discard
          </Button>
        </div>
      ) : null}
      {!decided && form && !notALead ? <AcceptForm item={item} pending={accept.pending} onCancel={() => setForm(false)} onSubmit={runAccept} /> : null}
      {confirmDiscard ? (
        <Dialog
          title="Discard this email?"
          description="It leaves Needs review and its content is deleted. No lead is made, and the sender is not told."
          onClose={() => setConfirmDiscard(false)}
          footer={
            <div className="flex flex-col gap-2 sm:flex-row-reverse">
              <Button variant="danger" onClick={() => void runDiscard()}>
                Discard email
              </Button>
              <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>
                Keep it
              </Button>
            </div>
          }
        >
          <p className="break-words text-[15px] text-ink">{subject}</p>
        </Dialog>
      ) : null}
    </Card>
  );
}

function Extracted({ item }: { item: ReviewItem }) {
  const f = item.fields;
  if (!f && item.status !== 'needs_review') return null;
  if (!f) return <p className="text-[15px] text-ink-muted">Nothing could be read from this email.</p>;
  const rows: [string, string][] = [];
  if (f.name) rows.push(['Name', f.name.value]);
  if (f.phones.length) rows.push([f.phones.length === 1 ? 'Phone' : 'Phones', f.phones.map((x) => x.value).join(', ')]);
  if (f.emails.length) rows.push([f.emails.length === 1 ? 'Email' : 'Emails', f.emails.map((x) => x.value).join(', ')]);
  if (f.property) rows.push(['Property', f.property.value]);
  if (f.message) rows.push(['Message', f.message.value]);
  if (rows.length === 0) return <p className="text-[15px] text-ink-muted">No name, phone or email could be read from this email.</p>;
  return (
    <dl className="flex flex-col gap-1.5" aria-label="Read from the email">
      {rows.map(([k, v]) => (
        <div key={k} className="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
          <dt className="text-[15px] text-ink-muted sm:w-28 sm:shrink-0">{k}</dt>
          <dd className="min-w-0 break-words text-[16px] text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Excerpt({ item }: { item: ReviewItem }) {
  const text = item.text ?? '';
  if (!text.trim()) return item.status !== 'needs_review' ? <p className="text-[14px] text-ink-muted">The email itself was deleted once it was decided.</p> : null;
  const cut = text.length > EXCERPT_CHARS;
  return (
    <details className="rounded-xl border border-line">
      <summary className="flex min-h-tap cursor-pointer items-center px-3.5 text-[15px] font-medium text-accent">Show the email</summary>
      <div className="border-t border-line px-3.5 py-3">
        <pre className="max-h-80 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[15px] text-ink">{cut ? `${text.slice(0, EXCERPT_CHARS)}…` : text}</pre>
        {cut ? <p className="mt-2 text-[14px] text-ink-muted">Showing the first {EXCERPT_CHARS.toLocaleString('en-US')} characters.</p> : null}
      </div>
    </details>
  );
}

function AcceptForm({ item, pending, onCancel, onSubmit }: { item: ReviewItem; pending: boolean; onCancel(): void; onSubmit(o: { name?: string; phone?: string; email?: string }, typedName?: string): Promise<boolean> }) {
  const [name, setName] = useState(item.fields?.name?.value ?? '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!phone.trim() && !email.trim() && !item.canAccept) {
      setProblem(LEAD_EMAIL_ERROR_MESSAGES.LEAD_EMAIL_NO_CONTACT_POINT!);
      return;
    }
    setProblem(null);
    const o: { name?: string; phone?: string; email?: string } = {};
    if (name.trim() && name.trim() !== (item.fields?.name?.value ?? '')) o.name = name.trim();
    if (phone.trim()) o.phone = phone.trim();
    if (email.trim()) o.email = email.trim();
    await onSubmit(o, name);
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3 rounded-xl border border-line p-3" aria-label="Accept as a lead">
      <p className="text-[15px] text-ink">{item.canAccept ? 'Check the details, then create the lead.' : 'This email has no phone or email we can use. Type one in to create the lead.'}</p>
      <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} autoComplete="off" />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <TextField label="Phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={40} autoComplete="off" />
        <TextField label="Email" type="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} autoComplete="off" autoCapitalize="none" />
      </div>
      {problem ? <Notice tone="error">{problem}</Notice> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" pending={pending}>
          Create lead
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
