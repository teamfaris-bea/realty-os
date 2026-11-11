// Compose (ARCHITECTURE §1 "Text a lead: Text → pre-filled assistant draft → Send", 2 taps).
//
// - With an assistant draft (`draftActionId`) the box opens prefilled with it, says plainly that the
//   assistant wrote it and why, and flags any claim the assistant could not verify ("Check this").
//   Send approves that draft (the human is the sender, ARCHITECTURE §9 path 4): unchanged → approve
//   as is; edited → approve with the edited text. The server checks again at send time.
// - Without a draft, Send is a human one-to-one message (path 1) with an idempotency key generated
//   once per tap (useCommand), so a retry after a dropped connection never sends twice.
// - Whether the chosen channel is blocked at all comes from the reachability summary: an opt-out or
//   suppression disables Send for that channel and says exactly why ("Texted STOP on Nov 10"); the
//   other channel stays available. Rules that depend on the words (payment instructions, the brokerage
//   name on marketing) are previewed against the real text while typing (useSendCheck). There is no
//   consent prompt, no quiet-hours wait and no way past an opt-out (owner decision,
//   core-compliance/2.0.0). Neither decides: the send-time decision does, and its outcome is shown as
//   it came back (sent, scheduled for the time the agent picked, or not sent and why).
// - DRAFT_STALE (R-AST-6): the client wrote since the draft was made. The box keeps the text, says
//   so, refreshes the thread, and the next Send carries the inbound seq the agent has now seen.
// - DRAFT_INVALIDATED (R-AST-7): the draft no longer applies; nothing was sent. The text stays, and
//   Send becomes the agent's own message.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Button, CheckThis, GateBadge, Notice } from '../../design/index.js';
import { REACHABILITY_KEY, ReasonCaption, channelState, useReachability } from '../../reasons/index.js';
import { type ApiError, useApi, useCommand } from '../../shell/index.js';
import { SendOutcome, sendOutcomeText, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { firstName } from '../feed/lib/format.js';
import { useSendCheck } from '../feed/lib/sendCheck.js';
import type { ActionView, ApproveResponse, ComposeResponse } from '../feed/lib/types.js';

export type Channel = 'sms' | 'email';

export interface ComposeContact {
  id: string;
  name: string;
  canText: boolean;
  canEmail: boolean;
  ownedByMe: boolean;
}

export interface ComposeBoxProps {
  contact: ComposeContact;
  initialChannel?: Channel;
  draftActionId?: string | null;
  /** a pending assistant draft for this contact, adopted only while the box is still empty */
  suggestedDraftId?: string | null;
  /** focus the message field on mount (opened from a Text / Edit tap) */
  autoFocus?: boolean;
  onSent?: () => void;
  /**
   * Parity module 64: a template picker rendered beside Send (e.g. templates' TemplatePicker). It only puts
   * text in the box (`insert`); Send and the send-time check are unchanged.
   */
  templatePicker?: (p: { channel: Channel; insert(t: { channel: Channel; subject: string | null; body: string }): void }) => ReactNode;
}

/** Debounce a value (ms). */
function useDebounced<T>(v: T, ms: number): T {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function ComposeBox({ contact, initialChannel, draftActionId: initialDraft = null, suggestedDraftId = null, autoFocus = false, onSent, templatePicker }: ComposeBoxProps) {
  const api = useApi();
  const qc = useQueryClient();
  const sheets = useAgentSheets();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [channel, setChannel] = useState<Channel>(initialChannel ?? (contact.canText ? 'sms' : 'email'));
  const [draftId, setDraftId] = useState<string | null>(initialDraft);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error' | 'ok'; text: string } | null>(null);
  const [outcome, setOutcome] = useState<ComposeResponse | null>(null);
  // parity module 64 (R-PAR-25): "Send later" exposes the existing scheduleAt (one-to-one only)
  const [later, setLater] = useState<string | null>(null);
  const loadedDraft = useRef<string | null>(null);

  const draftQ = useQuery<{ action: ActionView }, ApiError>({
    queryKey: ['action', draftId],
    queryFn: ({ signal }) => api.get<{ action: ActionView }>(`/assistant/actions/${draftId}`, { signal }),
    enabled: draftId !== null,
    staleTime: 60_000,
  });
  const draft = draftId !== null && draftQ.data?.action.status === 'proposed' ? draftQ.data.action : null;

  // prefill once per draft
  useEffect(() => {
    const a = draftQ.data?.action;
    if (!a || loadedDraft.current === a.id) return;
    loadedDraft.current = a.id;
    if (a.draft) {
      setBody(a.draft.body);
      setSubject(a.draft.subject ?? '');
      setChannel(a.draft.channel);
    }
    if (a.status !== 'proposed') setNotice({ tone: 'warn', text: 'This draft was already handled. You can still send your own message.' });
  }, [draftQ.data]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // grow with the text (up to about 12 lines) so a prefilled draft is readable without scrolling
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [body, channel]);

  // adopt a suggested draft only if the agent hasn't started writing or chosen one
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || suggestedDraftId === null || draftId !== null || body !== '') return;
    adopted.current = true;
    setDraftId(suggestedDraftId);
  }, [suggestedDraftId, draftId, body]);

  const original = draft?.draft ?? null;
  const edited = original !== null && (body !== original.body || (channel === 'email' && (subject || null) !== (original.subject ?? null)) || channel !== original.channel);

  // inline send check: from the moment the box opens (a probe body), then with the text as typed
  const previewBody = useDebounced(body.trim(), 500);
  const previewSubject = useDebounced(subject.trim(), 500);
  const reach = useReachability(contact.id);
  const blockedNow = channelState(reach, channel);
  // opened without a channel (Reply, a suggested draft) while texts are blocked and email is not: start on email
  const pickedFor = useRef(false);
  useEffect(() => {
    if (pickedFor.current || !reach || initialChannel !== undefined || initialDraft !== null) return;
    pickedFor.current = true;
    if (channel === 'sms' && channelState(reach, 'sms').blocked && contact.canEmail && !channelState(reach, 'email').blocked) setChannel('email');
  }, [reach, initialChannel, initialDraft, channel, contact.canEmail]);
  const preview = useSendCheck({ contactId: contact.id, channel, body: previewBody, subject: previewSubject, enabled: (channel === 'sms' ? contact.canText : contact.canEmail) && !blockedNow.blocked });

  const human = useCommand<Record<string, unknown>, ComposeResponse>(`/contacts/${contact.id}/messages`, { idKey: 'idempotencyKey', invalidate: [['feed'], ['timeline', contact.id], [...REACHABILITY_KEY]] });
  const approve = useCommand<Record<string, unknown>, ApproveResponse>(`/assistant/actions/${draftId ?? 'none'}/approve`, { invalidate: [['feed'], ['inbox'], ['timeline', contact.id], [...REACHABILITY_KEY]] });
  const pending = human.pending || approve.pending;

  const afterSend = (r: ComposeResponse) => {
    setOutcome(r);
    if (r.result === 'sent' || r.result === 'queued' || r.result === 'noop' || r.result === 'scheduled') {
      setBody('');
      setSubject('');
      setDraftId(null);
      setOutcome(null);
      setLater(null);
      sheets.announce(sendOutcomeText(r, contact.name).title);
      onSent?.();
    }
  };

  const send = async () => {
    setNotice(null);
    setOutcome(null);
    const text = body.trim();
    if (!text || blockedNow.blocked) return;
    if (draft) {
      const payload: Record<string, unknown> = {};
      if (edited) payload.editedPayload = { channel, body: text, ...(channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}) };
      if (seenSeq !== null) payload.reviewedInboundSeq = seenSeq;
      const r = await approve.run(payload);
      if (r.ok) {
        afterSend({ result: r.data.result, decision: r.data.decision, message: r.data.messageId ? { id: r.data.messageId, channel, status: r.data.status, statusReason: null, purpose: null, body: text, subject: null, scheduledFor: null, dispatchedAt: null } : null });
        return;
      }
      if (r.code === 'DRAFT_STALE') {
        const seq = r.details?.inboundSeq;
        if (typeof seq === 'number') setSeenSeq(seq);
        void qc.invalidateQueries({ queryKey: ['timeline', contact.id] });
        setNotice({ tone: 'warn', text: `${firstName(contact.name)} replied since this was drafted. Read the new message above, then send if it still fits.` });
        return;
      }
      if (r.code === 'DRAFT_INVALIDATED' || r.code === 'ACTION_NOT_PENDING') {
        setDraftId(null);
        setNotice({ tone: 'warn', text: `${r.message} Your text is still here; Send sends it as your own message.` });
        return;
      }
      setNotice({ tone: 'error', text: r.message });
      return;
    }
    const at = later ? new Date(later) : null;
    if (at && !(at.getTime() > Date.now())) {
      setNotice({ tone: 'error', text: 'Pick a time in the future, or turn off Send later.' });
      return;
    }
    const r = await human.run({ channel, body: text, ...(channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}), ...(at ? { scheduleAt: at.toISOString() } : {}) });
    if (r.ok) afterSend(r.data);
    else setNotice({ tone: 'error', text: r.message });
  };

  const askDraft = useCommand<Record<string, unknown>, { action: ActionView }>(`/contacts/${contact.id}/drafts`, {});
  const requestDraft = async () => {
    const r = await askDraft.run({});
    if (r.ok) setDraftId(r.data.action.id);
    else setNotice({ tone: 'error', text: r.message });
  };

  const decision = preview.decision;
  // once a send was tried, its outcome replaces the preview (both would repeat the same reason); a
  // preview of older text is not shown while the agent is still typing
  const showPreview = !blockedNow.blocked && decision !== null && decision.outcome === 'deny' && previewBody === body.trim() && outcome === null;
  const needsReview = draft?.claims.some((c) => c.needsReview) ?? false;
  const noChannel = !contact.canText && !contact.canEmail;

  if (noChannel) return <Notice tone="info">There's no phone number or email on file to message.</Notice>;

  return (
    <form
      aria-label={`Message ${contact.name}`}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {contact.canText && contact.canEmail ? (
        <div role="radiogroup" aria-label="Send as" className="flex gap-1 self-start rounded-xl bg-surface-2 p-1">
          {(['sms', 'email'] as const).map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={channel === c}
              onClick={() => setChannel(c)}
              className={`min-h-tap rounded-lg px-3 text-[15px] font-medium ${channel === c ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {c === 'sms' ? 'Text' : 'Email'}
            </button>
          ))}
        </div>
      ) : null}
      {draft ? (
        <div className="flex flex-col gap-1 rounded-xl bg-accent-soft px-3 py-2 text-[14px] text-ink">
          <p>
            <span className="font-semibold">Drafted by the assistant.</span> {draft.explanation}
          </p>
          {needsReview ? (
            <p className="flex flex-wrap items-center gap-2">
              <CheckThis reason="Part of this draft's reasoning couldn't be verified." /> Read it before sending.
            </p>
          ) : null}
        </div>
      ) : null}
      {draftId !== null && draftQ.isPending ? <p className="text-[14px] text-ink-muted">Loading the assistant's draft</p> : null}
      {channel === 'email' ? (
        <label className="flex flex-col gap-1 text-[15px] font-medium text-ink">
          Subject
          <input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[17px] text-ink" />
        </label>
      ) : null}
      <label htmlFor={`${id}-body`} className="sr-only">
        {channel === 'sms' ? 'Text message' : 'Email message'}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={`${id}-body`}
          ref={field}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={10_000}
          placeholder={channel === 'sms' ? `Text ${firstName(contact.name)}` : `Email ${firstName(contact.name)}`}
          className="min-h-tap flex-1 resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink placeholder:text-ink-muted"
        />
        <Button type="submit" pending={pending} pendingLabel="Sending" disabled={body.trim().length === 0 || blockedNow.blocked} aria-describedby={blockedNow.blocked || blockedNow.note ? `${id}-reason` : undefined}>
          {later ? 'Schedule' : 'Send'}
        </Button>
      </div>
      {templatePicker || !draft ? (
        <div className="flex flex-wrap items-center gap-2">
          {templatePicker
            ? templatePicker({
                channel,
                insert: (t) => {
                  setChannel(t.channel);
                  setBody(t.body);
                  if (t.channel === 'email') setSubject(t.subject ?? '');
                  setDraftId(null);
                  requestAnimationFrame(() => field.current?.focus());
                },
              })
            : null}
          {!draft ? (
            later === null ? (
              <Button type="button" variant="quiet" icon="clock" onClick={() => setLater(new Date(Date.now() + 3_600_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16))}>
                Send later
              </Button>
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                <label htmlFor={`${id}-later`} className="text-[15px] font-medium text-ink">
                  Send at
                </label>
                <input id={`${id}-later`} type="datetime-local" value={later} onChange={(e) => setLater(e.target.value || null)} className="min-h-tap rounded-xl border border-line bg-surface px-3 text-[17px] text-ink" />
                <Button type="button" variant="quiet" onClick={() => setLater(null)}>
                  Send now instead
                </Button>
              </span>
            )
          ) : null}
        </div>
      ) : null}
      {outcome === null ? <ReasonCaption id={`${id}-reason`} state={blockedNow} /> : null}
      {showPreview ? <GateBadge decision={decision} /> : null}
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}
      {outcome ? <SendOutcome result={outcome} contactName={contact.name} /> : null}
      {!draft && draftId === null && body.trim() === '' && contact.ownedByMe ? (
        <Button variant="quiet" className="self-start" pending={askDraft.pending} pendingLabel="Asking the assistant" onClick={() => void requestDraft()}>
          Ask the assistant for a draft
        </Button>
      ) : null}
    </form>
  );
}
