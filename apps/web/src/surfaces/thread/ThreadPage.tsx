// Thread + compose (BUILD_PLAN module 17): the texts, emails and calls with one contact, oldest first,
// with the compose box at the bottom (thumb reach on a phone). Opened from a Text / Email / Edit tap
// with `?compose=sms|email|draft&draft=<assistant action id>`, the box is focused and prefilled with
// the assistant's draft, so texting a lead is Text → Send (2 taps).
//
// Messages come from the contact timeline (GET /contacts/:id/timeline), which RLS scopes to what the
// caller may see; a pond or offer card has no thread until it is claimed or accepted (R-PERM-6).
// Outbound messages without a human sender are labelled "Sent automatically" (the assistant or the
// system sent them); nothing here pretends a person typed them.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Button, Notice } from '../../design/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { useInbox } from '../approvals/ApprovalsPage.js';
import { ComposeBox } from '../compose/ComposeBox.js';
import { useContact } from '../contact/useContact.js';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { formatDateTime } from '../feed/lib/format.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ContactFullView, TimelineItem, TimelineResponse } from '../feed/lib/types.js';

export function useTimeline(contactId: string, enabled = true) {
  const api = useApi();
  return useQuery<TimelineResponse, ApiError>({
    queryKey: ['timeline', contactId],
    queryFn: ({ signal }) => api.get<TimelineResponse>(`/contacts/${contactId}/timeline?limit=100`, { signal }),
    enabled,
    refetchInterval: 20_000,
  });
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
  // opened to write (Text / Email) without a named draft: a pending assistant reply for this
  // contact prefills the box, so Text → Send is 2 taps from anywhere
  const inbox = useInbox();
  const pendingDraft = inbox.data?.items.find((a) => a.contactId === contactId && a.status === 'proposed' && a.primaryAction === 'send' && a.draft !== null && (params.get('compose') === 'email' ? a.draft.channel === 'email' : a.draft.channel === 'sms'))?.id ?? null;

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
  const items = (t.data?.items ?? []).filter((i) => i.type === 'message' || i.type === 'call').slice().reverse();
  return (
    <div className="mx-auto flex w-full max-w-2xl md:mx-0 flex-col gap-3">
      <ThreadHeader contact={full} />
      {t.isError ? <Notice tone="error">{messageFor(t.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {t.data && items.length === 0 ? <p className="py-6 text-center text-[15px] text-ink-muted">No messages or calls yet.</p> : null}
      <Messages items={items} />
      <div className="sticky bottom-[calc(var(--tabbar-h)+env(safe-area-inset-bottom))] -mx-4 border-t border-line bg-canvas/95 px-4 py-3 backdrop-blur md:bottom-0 md:mx-0 md:rounded-2xl md:border md:bg-surface">
        <ComposeBox
          key={draft ?? 'none'}
          suggestedDraftId={compose !== null && draft === null ? pendingDraft : null}
          contact={{ id: full.id, name: full.displayName, canText: full.phones.length > 0, canEmail: full.emails.length > 0, ownedByMe: full.ownership.ownedByMe }}
          initialChannel={compose === 'email' ? 'email' : compose === 'sms' ? 'sms' : undefined}
          draftActionId={draft}
          autoFocus={compose !== null}
        />
      </div>
    </div>
  );
}

function ThreadHeader({ contact }: { contact: ContactFullView }) {
  const { call } = useAgentSheets();
  return (
    <div className="flex items-center gap-2">
      <Link to={`/contacts/${contact.id}`} className="inline-flex min-h-tap min-w-0 flex-1 items-center truncate text-[15px] font-medium text-accent">
        View {contact.displayName}'s details
      </Link>
      {contact.phones.length > 0 ? (
        <Button variant="secondary" icon="phone" onClick={() => call({ id: contact.id, name: contact.displayName })}>
          Call
        </Button>
      ) : null}
    </div>
  );
}

function Messages({ items }: { items: TimelineItem[] }) {
  const end = useRef<HTMLLIElement>(null);
  const last = items[items.length - 1]?.id;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [last]);
  return (
    <ol className="flex flex-col gap-2" aria-label="Conversation">
      {items.map((i) => (
        <MessageRow key={i.id} item={i} />
      ))}
      <li ref={end} aria-hidden="true" />
    </ol>
  );
}

/** "sms:outbound" → { channel, direction } */
export function parseDetail(detail: string | null): { channel: string; direction: string } {
  const [channel = '', direction = ''] = (detail ?? '').split(':');
  return { channel, direction };
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
 * What happened to an outbound message, in plain words, when it did NOT simply go out. A blocked or
 * failed text is never drawn like a sent one (honest UI): the bubble gets an outline and this line.
 */
export function outboundStatusLabel(status: string | null | undefined): { text: string; failed: boolean } | null {
  switch (status) {
    case 'blocked':
      return { text: 'Not sent: stopped by the send-time check', failed: true };
    case 'failed':
    case 'undelivered':
      return { text: 'Not delivered', failed: true };
    case 'bounced':
      return { text: 'Bounced', failed: true };
    case 'canceled':
      return { text: 'Canceled, not sent', failed: true };
    case 'scheduled':
      return { text: 'Scheduled', failed: false };
    case 'queued':
    case 'dispatching':
      return { text: 'Sending', failed: false };
    case 'dispatch_unknown':
      return { text: 'Checking whether it went out', failed: false };
    default:
      return null;
  }
}

export function MessageRow({ item }: { item: TimelineItem }) {
  const { channel, direction } = parseDetail(item.detail);
  const imported = item.provenance === 'imported';
  if (item.type === 'call') {
    return (
      <li id={item.id} className="self-center rounded-xl bg-surface-2 px-3 py-2 text-center text-[14px] text-ink-muted">
        {direction === 'inbound' ? 'Call from them' : `Call${item.actor?.displayName ? ` by ${item.actor.displayName}` : ''}`}
        {item.preview ? ` · ${CALL_OUTCOME_LABEL[item.preview] ?? item.preview.replace(/_/g, ' ')}` : ''} · {formatDateTime(item.occurredAt)}
        {imported ? ' · Imported' : ''}
      </li>
    );
  }
  const outbound = direction === 'outbound';
  const by = outbound ? (item.actor?.displayName ?? 'Sent automatically') : null;
  const st = outbound ? outboundStatusLabel(item.status) : null;
  const bubble = !outbound ? 'bg-surface text-ink border border-line' : st?.failed ? 'border border-dashed border-danger bg-surface text-ink-muted' : 'bg-accent-soft text-ink';
  return (
    <li id={item.id} className={`flex max-w-[85%] flex-col gap-0.5 ${outbound ? 'self-end items-end' : 'self-start items-start'}`}>
      <p className={`whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-[16px] ${bubble}`}>{item.preview ?? ''}</p>
      <p className="px-1 text-[12px] text-ink-muted">
        {channel === 'email' ? 'Email · ' : ''}
        {by ? `${by} · ` : ''}
        {formatDateTime(item.occurredAt)}
        {imported ? ' · Imported' : ''}
      </p>
      {st ? <p className={`px-1 text-[13px] font-medium ${st.failed ? 'text-danger' : 'text-ink-muted'}`}>{st.text}</p> : null}
    </li>
  );
}
