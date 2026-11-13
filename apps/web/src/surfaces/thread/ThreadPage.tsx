// Thread + compose (BUILD_PLAN module 17): the texts, emails and calls with one contact, oldest first,
// with the compose box at the bottom (thumb reach on a phone). Opened from a Text / Email / Reply / Edit tap
// with `?compose=sms|email|web_chat|draft&draft=<assistant action id>`, the box is focused and prefilled with
// the assistant's draft, so texting a lead is Text → Send (2 taps).
//
// Messages come from the contact timeline (GET /contacts/:id/timeline), which RLS scopes to what the
// caller may see; a pond or offer card has no thread until it is claimed or accepted (R-PERM-6).
// Outbound messages without a human sender are labelled "Sent automatically" (the assistant or the
// system sent them); nothing here pretends a person typed them.
//
// A message that did not simply go out says exactly why, in the words of reasons/sentences.ts ("Not
// sent: texted STOP on Nov 10", "Not delivered: the carrier rejected it"). A message held because the
// client replied after it was scheduled (E27) says "Held because Jane replied" and offers its sender
// Send anyway and Cancel (POST /messages/:id/send | /cancel, both audited); Send anyway is a human tap
// and is still checked at send time, so an opt-out still blocks it.
//
// Phase 2 (module 37): every bubble carries its channel tag (SMS, Email, Call, Web chat; R-INBOX-1: every
// channel lives in the one conversation per person). The compose box defaults to the channel the client
// wrote on last while it is open, and says why when it is on another (compose/channelChoice.ts). While a
// web chat is live the thread refreshes every few seconds, from the server only: there is no typing or
// presence indicator anywhere (genuineness). D2: no Messenger or Instagram channel, no messaging window.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button, Notice, useStickyBottom } from '../../design/index.js';
import { REACHABILITY_KEY, ReasonCaption, isHeld, messageStatus, useChannelState } from '../../reasons/index.js';
import { type ApiError, messageFor, useApi, usePageTitle, useSession } from '../../shell/index.js';
import { useInbox } from '../approvals/ApprovalsPage.js';
import { TemplatePicker } from '../templates/index.js';
import { ComposeBox } from '../compose/ComposeBox.js';
import type { ComposeChannel } from '../compose/channelApi.js';
import { composeChannelOf } from '../compose/channelChoice.js';
import { RowAttachments } from './Attachments.js';
import { MergedAwayNotice, isMergedAway } from '../contact/MergedAway.js';
import { GmailEntry, MailCoverage, type MailMessageView, lastInboundAcross, mergeByTime, useSyncedMail } from './gmail.js'; // module 69 (flagged edit)
import { ReactedWithChip, ReactionLine } from './Reactions.js';
import { useContact } from '../contact/useContact.js';
import { AgentSheetsProvider, sendOutcomeText, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { firstName, formatDateTime } from '../feed/lib/format.js';
import { useMutate } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ComposeResponse, ContactFullView, MessageView, TimelineItem, TimelineResponse } from '../feed/lib/types.js';
import { AiLabelsProvider, AiThreadBanner, useAiLabel } from '../aiCare/Thread.js'; // module 76 (flagged edit)
import { useUndoOpen } from '../aiCare/undoStore.js';

/** A web-chat message newer than this keeps the thread refreshing quickly (a visitor may still be on the page). */
export const LIVE_CHAT_MS = 30 * 60_000;

export function useTimeline(contactId: string, enabled = true) {
  const api = useApi();
  return useQuery<TimelineResponse, ApiError>({
    queryKey: ['timeline', contactId],
    queryFn: ({ signal }) => api.get<TimelineResponse>(`/contacts/${contactId}/timeline?limit=100`, { signal }),
    enabled,
    refetchInterval: (q) => (liveChat(q.state.data?.items ?? []) ? 4_000 : 20_000),
  });
}

/** The latest message is a web-chat message from the last 30 minutes (the timeline is newest first). */
export function liveChat(items: readonly TimelineItem[], now = Date.now()): boolean {
  const last = items.find((i) => i.type === 'message');
  return !!last && parseDetail(last.detail).channel === 'web_chat' && now - Date.parse(last.occurredAt) < LIVE_CHAT_MS;
}

/** The channel of the client's latest timeline message (newest first); null when they never wrote. The page itself uses gmail.ts lastInboundAcross, which also counts synced Gmail. */
export function lastInboundChannel(items: readonly TimelineItem[]): ComposeChannel | null {
  for (const i of items) if (i.type === 'message' && parseDetail(i.detail).direction === 'inbound') return composeChannelOf(i.detail);
  return null;
}

export default function ThreadPage() {
  return (
    <AgentSheetsProvider>
      <Thread />
    </AgentSheetsProvider>
  );
}

function Thread() {
  const { contactId = '' } = useParams();
  const [params] = useSearchParams();
  const c = useContact(contactId);
  const full = c.data?.contact.view === 'full' ? c.data.contact : null;
  usePageTitle(c.data?.contact.displayName ?? null);
  const t = useTimeline(contactId, full !== null);
  // module 69: synced Gmail (read-only), merged by time. Not on a merged-away record (batch 7 review ui/F6): its copies
  // move to the current record with the next sync pass, where the merged-away notice sends the agent.
  const mail = useSyncedMail(contactId, full !== null && !isMergedAway(full));
  // opened to write (Text / Email) without a named draft: a pending assistant reply for this
  // contact prefills the box, so Text → Send is 2 taps from anywhere
  const inbox = useInbox();
  const asked = params.get('compose');
  const draftChannel = asked === 'email' ? 'email' : asked === 'web_chat' ? 'web_chat' : 'sms';
  const pendingDraft = inbox.data?.items.find((a) => a.contactId === contactId && a.status === 'proposed' && a.primaryAction === 'send' && a.draft !== null && a.draft.channel === draftChannel)?.id ?? null;
  // the compose bar floats over a long conversation: its height is part of the scroll padding, so a
  // focused control is never left behind it (WCAG 2.4.11). On a short screen (a landscape phone, or
  // 200 % zoom: a 390 × 844 phone becomes 195 × 422) it would cover half the conversation, so there it
  // scrolls with the page instead, at the end of the conversation where the page opens.
  const composeBar = useStickyBottom<HTMLDivElement>();
  // module 76: the Undo toast of a Take over holds the box's focus until it closes (E496)
  const aiUndoOpen = useUndoOpen();

  if (c.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (c.isError || !c.data) return <Notice tone="error">{c.error ? messageFor(c.error, AGENT_ERROR_MESSAGES) : null}</Notice>;
  if (!full) {
    return (
      <Notice tone="info" title="Not your lead yet">
        Accept or claim this lead to see the conversation. <Link to={`/contacts/${contactId}`} className="font-medium text-accent underline">Open the lead</Link>
      </Notice>
    );
  }
  const compose = params.get('compose');
  const draft = params.get('draft');
  const newest = t.data?.items ?? [];
  const items = newest.filter((i) => i.type === 'message' || i.type === 'call').slice().reverse();
  const hasWebChat = newest.some((i) => i.type === 'message' && parseDetail(i.detail).channel === 'web_chat');
  const mailItems = mail.data?.items ?? [];
  // the mail has answered (or failed, or is not asked for): until then "no messages" may be false (review ui/F6)
  const mailSettled = mail.isSuccess || mail.isError; // never on a merged-away record: its notice says where the person went
  // a first-contact deadline is running: a Gmail reply does not stop it (R-GMAIL-14; review sends/F4)
  // only the owner's reply here stops it (core decideTouch also counts a collaborator, but the view does not say who
  // collaborates, so the line is not shown to them rather than risk telling a non-collaborator so)
  const firstContactOpen = full.ownership.ownedByMe && full.ownership.firstTouchDueAt !== null && full.ownership.firstTouchAt === null && full.ownership.firstTouchBreachedAt === null;
  return (
    <div className="mx-auto flex w-full max-w-2xl md:mx-0 flex-col gap-3">
      <ThreadHeader contact={full} />
      <MailCoverage data={mail.data} />
      <AiThreadBanner contact={full} />
      {t.isError ? <Notice tone="error">{messageFor(t.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {t.data && mailSettled && items.length === 0 && mailItems.length === 0 ? <p className="py-6 text-center text-[15px] text-ink-muted">No messages or calls yet.</p> : null}
      <AiLabelsProvider contact={full}>
        <Messages items={items} mail={mailItems} contact={{ id: full.id, name: full.displayName }} firstContactOpen={firstContactOpen} />
      </AiLabelsProvider>
      {/* review F7: nothing can be sent to a merged-away record (CONTACT_MERGED); say where the person went instead */}
      {isMergedAway(full) ? (
        <MergedAwayNotice to={full.mergedIntoContactId} />
      ) : (
      <div ref={composeBar} data-sticky className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] -mx-4 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:rounded-2xl md:border md:bg-surface [@media(max-height:559.98px)]:static">
        <ComposeBox
          key={draft ?? 'none'}
          suggestedDraftId={compose !== null && draft === null ? pendingDraft : null}
          contact={{ id: full.id, name: full.displayName, canText: full.phones.length > 0, canEmail: full.emails.length > 0, canWebChat: hasWebChat, typedInChat: full.typedInChat ?? [], ownedByMe: full.ownership.ownedByMe }}
          initialChannel={compose === 'email' ? 'email' : compose === 'sms' ? 'sms' : compose === 'web_chat' ? 'web_chat' : undefined}
          lastInboundChannel={t.data ? lastInboundAcross(newest, mailItems, full.emails.length > 0) : null}
          draftActionId={draft}
          autoFocus={compose !== null && !aiUndoOpen}
          ready={(t.data !== undefined || t.isError) && mailSettled}
          liveChat={liveChat(newest)}
          templatePicker={({ channel, insert }) => <TemplatePicker contactId={full.id} channel={channel} onInsert={insert} />}
        />
      </div>
      )}
    </div>
  );
}

function ThreadHeader({ contact }: { contact: ContactFullView }) {
  const { call } = useAgentSheets();
  const voice = useChannelState(contact.id, 'voice');
  const captionId = useId();
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Link to={`/contacts/${contact.id}`} className="inline-flex min-h-tap min-w-0 flex-1 items-center py-2 text-[15px] font-medium text-accent [overflow-wrap:anywhere]">
          View {contact.displayName}'s details
        </Link>
        {/* review R3: no Call on a merged-away record: the API refuses it (CONTACT_MERGED), and the notice says where to call */}
        {contact.phones.length > 0 && !isMergedAway(contact) ? (
          <Button variant="secondary" icon="phone" disabled={voice.blocked} aria-describedby={voice.blocked ? captionId : undefined} onClick={() => call({ id: contact.id, name: contact.displayName })}>
            Call
          </Button>
        ) : null}
      </div>
      {voice.blocked ? <ReasonCaption id={captionId} state={voice} className="self-end text-right" /> : null}
    </div>
  );
}

function Messages({ items, mail = [], contact, firstContactOpen = false }: { items: TimelineItem[]; mail?: MailMessageView[]; contact: { id: string; name: string }; firstContactOpen?: boolean }) {
  const rows = mergeByTime(items, mail); // module 69
  const end = useRef<HTMLLIElement>(null);
  const last = rows[rows.length - 1]?.item.id;
  const loaded = new Set(items.map((i) => i.id));
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last]);
  return (
    <ol className="flex flex-col gap-2" aria-label="Conversation">
      {rows.map((r) => (r.kind === 'gmail' ? <GmailEntry key={`gmail-${r.item.id}`} item={r.item} contact={contact} firstContactOpen={firstContactOpen} /> : <MessageRow key={r.item.id} item={r.item} contact={contact} loaded={loaded} />))}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

/** "sms:outbound" → { channel, direction } */
export function parseDetail(detail: string | null): { channel: string; direction: string } {
  const [channel = '', direction = ''] = (detail ?? '').split(':');
  return { channel, direction };
}

/** The tag on every bubble. D2: no Messenger or Instagram; a channel this app does not know says only "Message". */
const CHANNEL_TAG: Record<string, string> = { sms: 'SMS', mms: 'SMS', email: 'Email', web_chat: 'Web chat', call: 'Call' };
export const channelTag = (channel: string): string => CHANNEL_TAG[channel] ?? 'Message';

export function ChannelTag({ channel }: { channel: string }) {
  return (
    <span data-channel-tag={channel} className="rounded-md border border-line px-1.5 py-px text-[12px] font-medium leading-4 text-ink">
      {channelTag(channel)}
    </span>
  );
}

const CALL_OUTCOME_LABEL: Record<string, string> = {
  connected: 'Talked',
  left_voicemail: 'Left voicemail',
  no_answer: 'No answer',
  callback_requested: 'Asked for a call back',
  wrong_number: 'Wrong number',
  bad_number: 'Number not working',
  do_not_call_request: 'Asked not to be called',
};

/**
 * What happened to an outbound message, in plain words, when it did NOT simply go out (reasons/
 * sentences.ts). A blocked or failed text is never drawn like a sent one (honest UI): the bubble gets
 * an outline and this line, and so do the photos of a photo text, with words or without (RowAttachments `notSent`).
 */
export function outboundStatusLabel(item: Pick<TimelineItem, 'status' | 'statusReason' | 'providerErrorCode' | 'blockedBy' | 'detail'>, contactName = ''): { text: string; failed: boolean; held: boolean } | null {
  // module 22's refusal of a reply to an ended chat or a disconnected widget (E77, R-INBOX-7), in words
  if (item.status === 'blocked' && item.statusReason === 'CHANNEL_NOT_CONNECTED') return { text: 'Not sent: the chat had ended', failed: true, held: false };
  const line = messageStatus({ status: item.status, statusReason: item.statusReason, providerErrorCode: item.providerErrorCode, blockedBy: item.blockedBy, channel: parseDetail(item.detail).channel }, firstName(contactName));
  return line ? { text: line.text, failed: line.tone === 'failed', held: line.tone === 'held' } : null;
}

export function MessageRow({ item, contact, loaded }: { item: TimelineItem; contact?: { id: string; name: string }; loaded?: ReadonlySet<string> }) {
  // module 76 (R-ISA-7): an AI message the turns route covers says the AI assistant's, with a verb its status supports
  const ai = useAiLabel(item);
  if (item.reaction) return <ReactionLine item={{ ...item, reaction: item.reaction }} contact={contact} loaded={loaded} />;
  const { channel, direction } = parseDetail(item.detail);
  const imported = item.provenance === 'imported';
  if (item.type === 'call') {
    return (
      <li id={item.id} className="self-center rounded-xl bg-surface-2 px-3 py-2 text-center text-[14px] text-ink-muted">
        <ChannelTag channel="call" /> {direction === 'inbound' ? 'Call from them' : `Call${item.actor?.displayName ? ` by ${item.actor.displayName}` : ''}`}
        {item.preview ? ` · ${CALL_OUTCOME_LABEL[item.preview] ?? item.preview.replace(/_/g, ' ')}` : ''} · {formatDateTime(item.occurredAt)}
        {imported ? ' · Imported' : ''}
        {contact ? <RowAttachments contactId={contact.id} item={item} /> : null}
      </li>
    );
  }
  const outbound = direction === 'outbound';
  const by = outbound ? (ai?.label ?? item.actor?.displayName ?? 'Sent automatically') : null;
  const st = outbound ? outboundStatusLabel(item, contact?.name ?? '') : null;
  const bubble = !outbound ? 'bg-surface text-ink border border-line' : st?.failed ? 'border border-dashed border-danger bg-surface text-ink-muted' : st?.held ? 'border border-dashed border-warn bg-surface text-ink' : 'bg-accent-soft text-ink';
  return (
    <li id={item.id} className={`flex max-w-[85%] flex-col gap-0.5 ${outbound ? 'self-end items-end' : 'self-start items-start'}`}>
      {outbound && !item.preview ? null : <p className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[16px] ${bubble}`}>{item.preview ?? ''}</p>}
      {/* the photos sit with the words they belong to, above the meta, the status and any Send anyway / Cancel; a photo
          text that did not go out carries the same outline as its bubble, words or none (b8 texting ui/F5) */}
      {contact ? <RowAttachments contactId={contact.id} item={item} notSent={st?.failed ? 'failed' : st?.held ? 'held' : null} /> : null}
      {item.reactedWith ? <ReactedWithChip reactedWith={item.reactedWith} contactName={contact?.name} /> : null}
      <p className="flex flex-wrap items-center gap-x-1 px-1 text-[12px] text-ink-muted">
        <ChannelTag channel={channel} />
        <span>
          {by ? `${by} · ` : ''}
          {formatDateTime(item.occurredAt)}
          {imported ? ' · Imported' : ''}
        </span>
      </p>
      {outbound && ai ? ai.why : null}
      {st ? <p className={`px-1 text-[13px] font-medium ${st.failed ? 'text-danger' : st.held ? 'text-warn' : 'text-ink-muted'}`}>{st.text}</p> : null}
      {st?.held && contact ? <HeldActions item={item} contact={contact} /> : null}
    </li>
  );
}

/**
 * E27: a message the agent scheduled waits for their tap because the client replied since. Only its
 * sender can send or cancel it (the API answers 404 to anyone else). Send anyway is checked again at
 * send time: an opt-out still blocks it.
 */
function HeldActions({ item, contact }: { item: TimelineItem; contact: { id: string; name: string } }) {
  const { session } = useSession();
  const { announce } = useAgentSheets();
  const keys = [['timeline', contact.id], ['feed'], [...REACHABILITY_KEY]];
  const send = useMutate<Record<string, never>, ComposeResponse>('POST', { invalidate: keys });
  const cancel = useMutate<Record<string, never>, { message: MessageView }>('POST', { invalidate: keys });
  const mine = item.actor?.userId !== undefined && item.actor.userId === session?.user.id;
  if (!isHeld({ status: item.status ?? null, statusReason: item.statusReason ?? null })) return null;
  if (!mine) return <p className="px-1 text-[13px] text-ink-muted">Only {item.actor?.displayName ?? 'the sender'} can send or cancel it.</p>;
  const sendAnyway = async () => {
    const r = await send.run(`/messages/${item.id}/send`, {});
    if (r.ok) {
      const t = sendOutcomeText(r.data, contact.name);
      announce(r.data.decision?.outcome === 'deny' ? `Not sent: ${r.data.decision.explanation}` : t.title);
    }
  };
  const doCancel = async () => {
    const r = await cancel.run(`/messages/${item.id}/cancel`, {});
    if (r.ok) announce('Canceled. Nothing was sent.');
  };
  const busy = send.pending || cancel.pending;
  return (
    <div className="flex flex-col items-end gap-1 px-1">
      <div className="flex flex-wrap justify-end gap-2" role="group" aria-label="Held message">
        <Button variant="secondary" pending={send.pending} pendingLabel="Sending" disabled={busy} onClick={() => void sendAnyway()}>
          Send anyway
        </Button>
        <Button variant="quiet" pending={cancel.pending} disabled={busy} onClick={() => void doCancel()}>
          Cancel
        </Button>
      </div>
      {send.error ?? cancel.error ? (
        <p role="alert" className="text-[13px] font-medium text-danger">
          {(send.error ?? cancel.error)!.message}
        </p>
      ) : null}
    </div>
  );
}
