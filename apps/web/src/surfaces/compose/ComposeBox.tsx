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
//   name on marketing) are previewed against the real text while typing (useSendCheck). When the send
//   adds to the typed words (the brokerage line on a marketing text, an email's signature and footer),
//   the box shows the text exactly as it will go out ("What Jane will get"), from the same preview; an
//   approved draft is rendered the same way, with the approving agent's signature. There is no
//   consent prompt, no quiet-hours wait and no way past an opt-out (owner decision,
//   core-compliance/2.0.0). Neither decides: the send-time decision does, and its outcome is shown as
//   it came back (sent, scheduled for the time the agent picked, or not sent and why).
// - DRAFT_STALE (R-AST-6): the client wrote since the draft was made. The box keeps the text, says
//   so, refreshes the thread, and the next Send carries the inbound seq the agent has now seen.
// - DRAFT_INVALIDATED (R-AST-7): the draft no longer applies; nothing was sent. The text stays, and
//   Send becomes the agent's own message.
// - Phase 2 (module 37): the box defaults to the client's last open channel (text, email or web chat) and
//   says in one line why it is on another (channelChoice.ts). A channel the person cannot be reached on is
//   never offered: its option is disabled and shows the reachability summary's reason instead of hiding the
//   block (D1, including a STOP from a removed phone, R-PAR-12). Web chat is offered while the reachability
//   summary's web_chat entry says the chat is open (module 22), and otherwise shown with its reason (the chat
//   ended, E77; the website chat was turned off, R-INBOX-7; an opt-out). Web-chat replies and approvals go through
//   channelApi.ts on the one send path, previewed like a text (never scheduled); a reply to a chat that ended
//   between the summary and the tap is not sent and says so. When the summary (asked again every 15 s while a chat is
//   live) says the chat ended, the box says so in a status message, as the preview path does (review ui-compose/F6). An assistant draft asked for while replying in an open chat loads in the chat
//   (review ui-compose/F5); a draft opened with ?compose=draft keeps the draft's channel even when every channel is
//   blocked (review ui-compose/F4).
//   D2: no Messenger or Instagram compose and no messaging-window copy.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, CheckThis, GateBadge, Notice } from '../../design/index.js';
import { REACHABILITY_KEY, ReasonCaption, channelState, useReachabilityQuery } from '../../reasons/index.js';
import { type ApiError, useApi, useCommand } from '../../shell/index.js';
import { SendOutcome, WENT_OUT, sendOutcomeText, sentResult, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { CHANNEL_NOT_CONNECTED, type ComposeChannel, useWebChatApprove, useWebChatSend } from './channelApi.js';
import { CHAT_NOT_HERE, chooseChannel, webChatState } from './channelChoice.js';
import { firstName, formatPhone } from '../feed/lib/format.js';
import { useSendCheck } from '../feed/lib/sendCheck.js';
import type { ActionView, ApproveResponse, ComposeResponse, TypedInChat } from '../feed/lib/types.js';
import { MediaTray } from './MediaTray.js';
import { SegmentCounter, plainQuotes, useCounterView } from './SegmentCounter.js';
import { mediaHold, mediaRefusal, useComposeMedia } from './useComposeMedia.js';

export type Channel = 'sms' | 'email';

export interface ComposeContact {
  id: string;
  name: string;
  canText: boolean;
  canEmail: boolean;
  /** the client has written by web chat (a web-chat message is in the thread); module 37 */
  canWebChat?: boolean;
  /** what they typed in the website chat (never a point): said when nothing else can reach them (E77, UXA-5) */
  typedInChat?: TypedInChat[];
  ownedByMe: boolean;
}

/**
 * Nothing can be sent to them (E77: a chat-only lead whose chat ended), but they typed a phone or email in the chat:
 * say so, unverified, and where the agent may add it by hand to call, text or email (finding UXA-5). Never for a person
 * who asked not to be contacted (R-CHAN-2/3, the summary's person-level do-not-contact, also one a merge carried):
 * nobody may call, text or email them, so the note says that instead (review optouts/F3 of batch 6).
 */
function TypedInChatNote({ contact, doNotContact }: { contact: ComposeContact; doNotContact: boolean }) {
  const typed = contact.typedInChat ?? [];
  if (typed.length === 0) return null;
  if (doNotContact)
    return (
      <p data-testid="typed-in-chat" className="text-[14px] leading-snug text-ink">
        {firstName(contact.name)} asked not to be contacted. Nobody on the team can text, email or call them.
      </p>
    );
  const shown = typed.map((t) => (t.kind === 'phone' ? formatPhone(t.address) : t.address)).join(' and ');
  return (
    <p data-testid="typed-in-chat" className="text-[14px] leading-snug text-ink">
      {firstName(contact.name)} typed {shown} in the website chat (not verified). Add it on{' '}
      <Link to={`/contacts/${contact.id}`} className="font-medium text-accent underline">
        their details
      </Link>{' '}
      to call, text or email.
    </p>
  );
}

export interface ComposeBoxProps {
  contact: ComposeContact;
  /** opened to write on this channel (a Text / Email / Reply tap): kept while it can be used */
  initialChannel?: ComposeChannel;
  /** the channel of the client's latest message: the box defaults to it while it is open (module 37) */
  lastInboundChannel?: ComposeChannel | null;
  draftActionId?: string | null;
  /** a pending assistant draft for this contact, adopted only while the box is still empty */
  suggestedDraftId?: string | null;
  /** focus the message field on mount (opened from a Text / Edit tap) */
  autoFocus?: boolean;
  /**
   * the thread's messages have loaded, so the channel the client wrote on last is known (default true). Until it and
   * the reachability summary are in, the box picks no channel and says nothing it may take back (finding UXA-8).
   */
  ready?: boolean;
  /** a web chat is live in the thread: the summary is asked again every 15 s, so a chat that ends is said at once */
  liveChat?: boolean;
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

export function ComposeBox({ contact, initialChannel, lastInboundChannel = null, draftActionId: initialDraft = null, suggestedDraftId = null, autoFocus = false, ready = true, liveChat = false, onSent, templatePicker }: ComposeBoxProps) {
  const api = useApi();
  const qc = useQueryClient();
  const sheets = useAgentSheets();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  // the agent's own channel tap (or the channel of a draft or template they chose); the box's channel is derived
  const [picked, setChannel] = useState<ComposeChannel | null>(null);
  const [webChatEnded, setWebChatEnded] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(initialDraft);
  const [body, setBody] = useState('');
  const [subject, setSubject] = useState('');
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'error' | 'ok'; text: string; link?: { to: string; label: string } } | null>(null);
  // review F7: a send refused because this record was merged meanwhile (CONTACT_MERGED) names the record the person lives
  // on now, when the caller may see it (details.mergedInto): link there, to write on the same channel
  const failed = (r: { code?: string; message: string; details?: Record<string, unknown> | null }, text?: string | null) => {
    const into = r.code === 'CONTACT_MERGED' && typeof r.details?.mergedInto === 'string' ? r.details.mergedInto : null;
    setNotice({ tone: 'error', text: text ?? r.message, ...(into ? { link: { to: `/contacts/${into}/thread?compose=${channel}`, label: 'Open their current record' } } : {}) });
  };
  const [outcome, setOutcome] = useState<ComposeResponse | null>(null);
  // parity module 64 (R-PAR-25): "Send later" exposes the existing scheduleAt (one-to-one only)
  const [later, setLater] = useState<string | null>(null);
  const loadedDraft = useRef<string | null>(null);
  // a draft the agent asked for while replying in an open web chat loads in the chat (review ui-compose/F5): the
  // assistant drafts a requested reply for texts or email only, and loading it must not move the box under the agent
  const keepChat = useRef(false);
  const media = useComposeMedia(contact.id);

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
      setChannel(keepChat.current ? 'web_chat' : a.draft.channel);
    }
    keepChat.current = false;
    if (a.status !== 'proposed') setNotice({ tone: 'warn', text: 'This draft was already handled. You can still send your own message.' });
  }, [draftQ.data]);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  // adopt a suggested draft only if the agent hasn't started writing or chosen one
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || suggestedDraftId === null || draftId !== null || body !== '' || media.count > 0) return;
    adopted.current = true;
    setDraftId(suggestedDraftId);
  }, [suggestedDraftId, draftId, body, media.count]);

  const reachQ = useReachabilityQuery(contact.id, { refetchMs: liveChat ? 15_000 : undefined });
  const reach = reachQ.summary;
  // the box decides its channel from the summary and the thread; until both are in it waits (UXA-8: it had said
  // "Replying in web chat" for a chat that had ended, and "no phone or email" for a chat-only lead, then taken it back)
  const settled = ready && !reachQ.pending;
  const choiceInput = {
    firstName: firstName(contact.name),
    canText: contact.canText,
    canEmail: contact.canEmail,
    sms: channelState(reach, 'sms'),
    email: channelState(reach, 'email'),
    // module 22: channels.web_chat says whether the chat can be answered; the thread decides only while it is unknown
    webChat: webChatState(reach, contact.canWebChat ?? false),
    webChatEnded,
    lastInbound: lastInboundChannel,
    requested: initialChannel ?? null,
    picked,
  };
  const choice = chooseChannel(choiceInput);
  // With no usable channel the box still names one, so its reason is shown and Send stays disabled: the agent's own
  // (or the opened draft's) channel, else the one it was opened on (a Text or Email tap), else the client's last
  // channel, else the first. Opened from Email for a person blocked on both, it says why email is blocked, never only
  // why texting is (e2e journeys M3.1); an email draft opened from Edit stays the Email box (review ui-compose/F4).
  const listed = (c: ComposeChannel | null | undefined): ComposeChannel | null => (c && choice.options.some((o) => o.channel === c) ? c : null);
  const channel: ComposeChannel = choice.channel ?? listed(picked) ?? listed(initialChannel) ?? listed(lastInboundChannel) ?? choice.options[0]?.channel ?? 'sms';
  const isChat = channel === 'web_chat';

  // grow with the text (up to about 12 lines) so a prefilled draft is readable without scrolling
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`;
  }, [body, channel]);

  const original = draft?.draft ?? null;
  const edited = original !== null && (body !== original.body || (channel === 'email' && (subject || null) !== (original.subject ?? null)) || channel !== original.channel);

  // inline send check: from the moment the box opens (a probe body), then with the text as typed
  const previewBody = useDebounced(body.trim(), 500);
  const previewSubject = useDebounced(subject.trim(), 500);
  const blockedNow = isChat ? { blocked: choice.channel === null, sentence: choice.options.find((o) => o.channel === 'web_chat')?.reason ?? null, note: null } : channelState(reach, channel);
  // the same preview for every channel, web chat included (module 22): what the send would decide for this text
  const preview = useSendCheck({ contactId: contact.id, channel, body: previewBody, subject: previewSubject, enabled: settled && (channel === 'sms' ? contact.canText : channel === 'email' ? contact.canEmail : choiceInput.webChat.offered) && !blockedNow.blocked, withMedia: channel === 'sms' && media.count > 0 });
  const counter = useCounterView({ typed: body, final: previewBody === body.trim() ? preview.final : null, sender: preview.textSender, media: channel === 'sms' && media.count > 0 ? media : null });
  const mediaWait = mediaHold(channel, media);
  const hold = mediaWait ? `${id}-media-hold` : channel === 'sms' && counter?.tooLong ? `${id}-counter-too-long` : null;
  const draftOpen = draft !== null || (draftId !== null && draftQ.isPending);
  // the chat ended while the agent was on the thread: the preview of the real text says so (CHANNEL_NOT_CONNECTED). The
  // box closes Web chat at once and asks the summary again, so it never offers what the preview and the send refuse
  const previewEnded = isChat && (preview.decision?.reasons.includes(CHANNEL_NOT_CONNECTED) ?? false);
  useEffect(() => {
    if (!previewEnded || webChatEnded) return;
    setWebChatEnded(true);
    setChannel(null);
    void qc.invalidateQueries({ queryKey: [...REACHABILITY_KEY] });
    // nothing was sent; the box moved, so it says where Send goes now
    const next = chooseChannel({ ...choiceInput, webChatEnded: true, picked: null }).channel;
    setNotice({ tone: 'warn', text: `The chat has ended (${firstName(contact.name)} left the page, or the chat was turned off), so this can't go there. Your text is still here.${next === 'sms' ? ' Send now sends it by text.' : next === 'email' ? ' Send now sends it by email.' : ''}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, when the preview first says the chat ended
  }, [previewEnded, webChatEnded, qc]);

  // The summary (asked again every 15 s while a chat is live) closed the chat the box was on: the box moves, so it says
  // where Send goes now in a status Notice (role="status", a live region: WCAG 4.1.3), exactly as the preview path above
  // does (review ui-compose/F6). The agent's own tap is no surprise and says nothing.
  const lastChannel = useRef<ComposeChannel | null>(null);
  useEffect(() => {
    const prev = lastChannel.current;
    if (!settled) return;
    lastChannel.current = channel;
    if (prev !== 'web_chat' || channel === 'web_chat' || webChatEnded || picked === channel) return;
    const chatOption = choice.options.find((o) => o.channel === 'web_chat');
    if (!chatOption || chatOption.open || !chatOption.reason) return;
    const next = choice.channel;
    const text = `${chatOption.reason}, so this can't go there.${body.trim() !== '' ? ' Your text is still here.' : ''}${next === 'sms' ? ' Send now sends it by text.' : next === 'email' ? ' Send now sends it by email.' : ''}`;
    setNotice({ tone: 'warn', text });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per move of the box's channel
  }, [channel, settled]);

  const human = useCommand<Record<string, unknown>, ComposeResponse>(`/contacts/${contact.id}/messages`, { idKey: 'idempotencyKey', invalidate: [['feed'], ['timeline', contact.id], [...REACHABILITY_KEY], ['attachments', contact.id]] });
  const approve = useCommand<Record<string, unknown>, ApproveResponse>(`/assistant/actions/${draftId ?? 'none'}/approve`, { invalidate: [['feed'], ['inbox'], ['timeline', contact.id], [...REACHABILITY_KEY]] });
  const chat = useWebChatSend(contact.id);
  const chatApprove = useWebChatApprove(contact.id, draftId);
  const pending = human.pending || approve.pending || chat.pending || chatApprove.pending;

  // E77 / R-INBOX-7: the chat ended (or the widget was disconnected); nothing was sent and the text stays
  const chatEnded = () => {
    setWebChatEnded(true);
    setChannel(null);
    const next = chooseChannel({ ...choiceInput, webChatEnded: true, picked: null }).channel;
    const name = firstName(contact.name);
    setNotice({ tone: 'warn', text: `Not sent: the chat has ended (${name} left the page, or the chat was turned off). Your text is still here.${next === 'sms' ? ' Send now sends it by text.' : next === 'email' ? ' Send now sends it by email.' : ''}` });
  };

  const afterSend = (r: ComposeResponse) => {
    setOutcome(r);
    if (r.message) media.sent();
    // a replay ('noop', after a lost answer) went out only if its message did (finding F1)
    if (WENT_OUT.has(sentResult(r))) {
      setBody('');
      setSubject('');
      setDraftId(null);
      setOutcome(null);
      setLater(null);
      sheets.announce(sendOutcomeText(r, contact.name).title);
      onSent?.();
    }
  };

  /** A draft the server would not send as approved (R-AST-6, R-AST-7): the text stays and the box says what to do. */
  const draftRefused = (code: string, message: string, details: Record<string, unknown> | null): boolean => {
    if (code === 'DRAFT_STALE') {
      const seq = details?.inboundSeq;
      if (typeof seq === 'number') setSeenSeq(seq);
      void qc.invalidateQueries({ queryKey: ['timeline', contact.id] });
      setNotice({ tone: 'warn', text: `${firstName(contact.name)} replied since this was drafted. Read the new message above, then send if it still fits.` });
      return true;
    }
    if (code === 'DRAFT_INVALIDATED' || code === 'ACTION_NOT_PENDING') {
      setDraftId(null);
      setNotice({ tone: 'warn', text: `${message} Your text is still here; Send sends it as your own message.` });
      return true;
    }
    return false;
  };

  const send = async () => {
    setNotice(null);
    setOutcome(null);
    const text = body.trim();
    if ((!text && media.count === 0) || !settled || blockedNow.blocked || hold !== null) return;
    if (isChat) {
      // a reply in web chat, or the draft approved as one (never scheduled)
      const o = draft ? await chatApprove.approve(text, seenSeq, edited) : await chat.send(text);
      if (o.kind === 'chat_ended') {
        // an approved draft was used up by that approval (it is approved, not sent): the next Send is the agent's own
        // message on the next channel, never a re-approval the API would answer as a replay of the blocked one (F1)
        if (draft) setDraftId(null);
        return chatEnded();
      }
      if (o.kind === 'done') return afterSend(o.response);
      if (draft && draftRefused(o.code, o.message, o.details)) return;
      failed(o);
      return;
    }
    if (draft) {
      const payload: Record<string, unknown> = {};
      if (edited) payload.editedPayload = { channel, body: text, ...(channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}) };
      if (seenSeq !== null) payload.reviewedInboundSeq = seenSeq;
      const r = await approve.run(payload);
      if (r.ok) {
        afterSend({ result: r.data.result, decision: r.data.decision, message: r.data.messageId ? { id: r.data.messageId, channel, status: r.data.messageStatus ?? r.data.result, statusReason: null, purpose: null, body: text, subject: null, scheduledFor: null, dispatchedAt: null } : null });
        return;
      }
      if (draftRefused(r.code, r.message, r.details)) return;
      failed(r);
      return;
    }
    const at = later ? new Date(later) : null;
    if (at && !(at.getTime() > Date.now())) {
      setNotice({ tone: 'error', text: 'Pick a time in the future, or turn off Send later.' });
      return;
    }
    const r = await human.run({ channel, body: text, ...(channel === 'email' && subject.trim() ? { subject: subject.trim() } : {}), ...(at ? { scheduleAt: at.toISOString() } : {}), ...(media.count > 0 ? { mediaIds: media.ids } : {}) });
    if (r.ok) afterSend(r.data);
    else failed(r, mediaRefusal(media, r));
  };

  const askDraft = useCommand<Record<string, unknown>, { action: ActionView }>(`/contacts/${contact.id}/drafts`, {});
  const requestDraft = async () => {
    const r = await askDraft.run({});
    if (r.ok) {
      keepChat.current = isChat && choice.channel === 'web_chat';
      setDraftId(r.data.action.id);
    } else setNotice({ tone: 'error', text: r.message });
  };

  const decision = preview.decision;
  // once a send was tried, its outcome replaces the preview (both would repeat the same reason); a
  // preview of older text is not shown while the agent is still typing
  const showPreview = !blockedNow.blocked && decision !== null && decision.outcome === 'deny' && previewBody === body.trim() && outcome === null;
  // the text exactly as it will go out, when the send adds to what was typed (never for older text)
  const finalText = !blockedNow.blocked && outcome === null && previewBody === body.trim() && preview.final !== null && preview.final.trim() !== body.trim() ? preview.final : null;
  const needsReview = draft?.claims.some((c) => c.needsReview) ?? false;
  // the reason under Send (ReasonCaption) is on the page (exactly its render condition): Send and the box's own closed
  // option point at it only then (review ui-compose/F9: an option's "not offered" line is not rendered for the box's own
  // channel, the reason is said once, under Send; after a send's outcome the caption gives way to it)
  const reasonShown = settled && outcome === null && ((blockedNow.blocked && !!blockedNow.sentence) || !!blockedNow.note);
  const noChannel = choice.options.length === 0;
  const fieldLabel = !settled ? 'Message' : channel === 'sms' ? 'Text message' : channel === 'email' ? 'Email message' : 'Web chat message';
  const placeholder = !settled ? `Message ${firstName(contact.name)}` : channel === 'sms' ? `Text ${firstName(contact.name)}` : channel === 'email' ? `Email ${firstName(contact.name)}` : `Reply to ${firstName(contact.name)} in web chat`;

  // nothing to write on at all, or nothing that can take a message now: no template and no draft (nothing could send them)
  const nothingSends = settled && choice.channel === null;
  // the person-level do-not-contact (R-CHAN-2): the summary names it once for the person (review optouts/F3)
  const personDnc = (reach?.doNotContact ?? null) !== null;
  // asked to reply in a chat the summary has nothing to reply to (review ui-compose/F2): said, never left out
  const chatNotHere = choiceInput.webChat.missing && [initialChannel, lastInboundChannel].includes('web_chat');
  if (settled && noChannel)
    return (
      <div className="flex flex-col gap-2">
        <Notice tone="info">There's no phone number or email on file to message.{chatNotHere ? ` ${CHAT_NOT_HERE}.` : ''}</Notice>
        <TypedInChatNote contact={contact} doNotContact={personDnc} />
      </div>
    );

  return (
    <form
      aria-label={`Message ${contact.name}`}
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      {settled && choice.options.length > 1 ? (
        <div role="radiogroup" aria-label="Send as" className="flex flex-wrap gap-1 self-start rounded-xl bg-surface-2 p-1">
          {choice.options.map((o) => (
            <button
              key={o.channel}
              type="button"
              role="radio"
              aria-checked={channel === o.channel}
              disabled={!o.open}
              aria-describedby={o.open ? undefined : o.channel !== channel ? (o.reason ? `${id}-not-${o.channel}` : undefined) : reasonShown ? `${id}-reason` : undefined}
              onClick={() => setChannel(o.channel)}
              className={`min-h-tap rounded-lg px-3 text-[15px] font-medium disabled:cursor-not-allowed disabled:line-through ${channel === o.channel ? 'bg-surface text-ink shadow-sm' : 'text-ink-muted'}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      ) : null}
      {settled && choice.options.length > 1
        ? choice.options
            .filter((o) => !o.open && o.reason && o.channel !== channel)
            .map((o) => (
              <p key={o.channel} id={`${id}-not-${o.channel}`} data-reason="not-offered" className="flex flex-wrap gap-1 text-[13px] leading-snug text-ink-muted">
                <span className="font-medium text-ink">{o.label} not offered:</span> <span>{o.reason}</span>
              </p>
            ))
        : null}
      {settled && choice.why ? (
        <p data-testid="channel-why" className="text-[13px] leading-snug text-ink-muted">
          {choice.why}
        </p>
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
        {fieldLabel}
      </label>
      <div className="flex items-end gap-2">
        <textarea
          id={`${id}-body`}
          ref={field}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          maxLength={10_000}
          placeholder={placeholder}
          aria-describedby={settled && channel === 'sms' && counter ? `${id}-counter` : undefined}
          className="min-h-tap flex-1 resize-y rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[17px] text-ink placeholder:text-ink-muted"
        />
        <Button type="submit" pending={pending} pendingLabel="Sending" disabled={!settled || (body.trim().length === 0 && media.count === 0) || blockedNow.blocked || hold !== null} aria-describedby={[reasonShown ? `${id}-reason` : null, hold].filter(Boolean).join(' ') || undefined}>
          {later ? 'Schedule' : 'Send'}
        </Button>
      </div>
      {settled && channel === 'sms' ? <SegmentCounter id={`${id}-counter`} view={counter} onPlainQuotes={() => { setBody(plainQuotes(body)); requestAnimationFrame(() => field.current?.focus()); }} /> : null}
      <MediaTray media={media} canAttach={settled && channel === 'sms' && contact.canText && !blockedNow.blocked && !draftOpen} hold={mediaWait} holdId={`${id}-media-hold`} />
      {settled && !nothingSends && (templatePicker || !draft) ? (
        <div className="flex flex-wrap items-center gap-2">
          {templatePicker
            ? templatePicker({
                channel: channel === 'email' ? 'email' : 'sms',
                insert: (t) => {
                  // a text template keeps a web-chat reply in web chat
                  setChannel(isChat && t.channel === 'sms' ? 'web_chat' : t.channel);
                  setBody(t.body);
                  if (t.channel === 'email') setSubject(t.subject ?? '');
                  setDraftId(null);
                  requestAnimationFrame(() => field.current?.focus());
                },
              })
            : null}
          {!draft && !isChat ? (
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
      {settled && outcome === null ? <ReasonCaption id={`${id}-reason`} state={blockedNow} /> : null}
      {nothingSends ? <TypedInChatNote contact={contact} doNotContact={personDnc} /> : null}
      {finalText !== null ? (
        <figure aria-label={`What ${firstName(contact.name)} will get`} className="flex flex-col gap-1 rounded-xl bg-surface-2 px-3 py-2 text-[14px] text-ink">
          <figcaption className="font-medium text-ink-muted">What {firstName(contact.name)} will get</figcaption>
          <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{finalText}</p>
        </figure>
      ) : null}
      {showPreview ? <GateBadge decision={decision} /> : null}
      {notice ? (
        <Notice tone={notice.tone}>
          {notice.text}
          {notice.link ? (
            <>
              {' '}
              <Link to={notice.link.to} className="font-medium text-accent underline">
                {notice.link.label}
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}
      {outcome ? <SendOutcome result={outcome} contactName={contact.name} /> : null}
      {settled && !nothingSends && !draft && draftId === null && body.trim() === '' && media.count === 0 && contact.ownedByMe ? (
        <Button variant="quiet" className="self-start" pending={askDraft.pending} pendingLabel="Asking the assistant" onClick={() => void requestDraft()}>
          Ask the assistant for a draft
        </Button>
      ) : null}
    </form>
  );
}
