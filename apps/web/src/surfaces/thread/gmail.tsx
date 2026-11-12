// Synced Gmail in the contact's conversation (module 69, D2; R-GMAIL-5, -6, -7). Everything the thread shows
// of module 68's copies lives here; ThreadPage.tsx only calls the hook, renders the coverage line and merges
// the entries by time (one flagged edit).
//
//   GET  /contacts/:id/mail-messages?limit=100  the copies the caller may see (RLS), newest first
//   POST /me/mail-threads/:threadId/exclude     the mailbox owner removes a thread from Realty OS (final)
//
// An entry is tagged "Gmail (read-only)". It names the contact's role and how many others were on the message
// ("and 2 others"), never their addresses; says "Older messages stay in Gmail" past the per-thread limit;
// lists attachment names only ("open in Gmail"); and has NO reply button (replying is the normal compose box,
// platform email, or Gmail itself). Only the mailbox owner sees "Remove this thread from Realty OS".
// When the route is not there (or answers an error), the thread shows no Gmail and nothing else changes.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Button, Dialog } from '../../design/index.js';
import { type ApiError, useApi } from '../../shell/index.js';
import { formatDateTime } from '../feed/lib/format.js';
import { useAgentSheets } from '../feed/lib/AgentSheets.js';
import { useMutate } from '../feed/lib/hooks.js';
import type { TimelineItem } from '../feed/lib/types.js';

export interface MailAttachmentView {
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MailMessageView {
  id: string;
  threadId: string;
  internalAt: string;
  sender: 'contact' | 'mailbox' | 'other';
  contactRole: 'from' | 'to' | 'cc' | 'bcc';
  otherRecipientCount: number;
  subject: string | null;
  body: string;
  bodyTruncated: boolean;
  attachments: MailAttachmentView[];
  origin: 'live' | 'backfill';
  mine: boolean;
  mailboxOwnerName: string;
  threadCapped: boolean;
}

export interface MailMessagesResponse {
  items: MailMessageView[];
  coverage: { address: string; since: string }[];
  nextBefore: string | null;
}

export const mailMessagesKey = (contactId: string) => ['mail-messages', contactId] as const;

export const GMAIL_TAG = 'Gmail (read-only)';
export const REMOVE_THREAD = 'Remove this thread from Realty OS';
export const REMOVE_THREAD_CONSEQUENCE = "This can't be undone: its copies leave Realty OS and later messages in it are never copied.";
export const NO_TEXT = 'No text to show; open it in Gmail.';
export const THREAD_CAPPED = 'Older messages stay in Gmail.';
export const THREAD_REMOVED = 'Thread removed from Realty OS';
export const OLDER_GMAIL = 'Older Gmail stays in Gmail.';

/** The synced Gmail copies of one contact (newest first, as the API sends them). Disabled with enabled=false. */
export function useSyncedMail(contactId: string, enabled = true) {
  const api = useApi();
  return useQuery<MailMessagesResponse, ApiError>({
    queryKey: mailMessagesKey(contactId),
    queryFn: ({ signal }) => api.get<MailMessagesResponse>(`/contacts/${encodeURIComponent(contactId)}/mail-messages?limit=100`, { signal }),
    enabled: enabled && contactId !== '',
    retry: false,
    refetchInterval: 60_000,
  });
}

export type ThreadEntry = { kind: 'timeline'; at: number; item: TimelineItem } | { kind: 'gmail'; at: number; item: MailMessageView };

/**
 * One conversation, oldest first: the timeline items (in the order given, already oldest first) and the
 * Gmail copies (any order), by time. Ties keep timeline items first, then Gmail in internal-date order;
 * an unparseable time sorts as the oldest.
 */
export function mergeByTime(timelineItems: readonly TimelineItem[], mailItems: readonly MailMessageView[]): ThreadEntry[] {
  const t = (iso: string) => {
    const n = Date.parse(iso);
    return Number.isNaN(n) ? -Infinity : n;
  };
  const all: (ThreadEntry & { seq: number })[] = [
    ...timelineItems.map((item, i) => ({ kind: 'timeline' as const, at: t(item.occurredAt), item, seq: i })),
    ...mailItems.map((item, i) => ({ kind: 'gmail' as const, at: t(item.internalAt), item, seq: timelineItems.length + (mailItems.length - 1 - i) })),
  ];
  all.sort((a, b) => a.at - b.at || a.seq - b.seq);
  return all.map(({ seq: _seq, ...e }) => e as ThreadEntry);
}

const ROLE_SUFFIX: Record<MailMessageView['contactRole'], string> = { from: '', to: '', cc: ' (Cc)', bcc: ' (Bcc)' };

const others = (n: number) => (n <= 0 ? '' : n === 1 ? ' and 1 other' : ` and ${n} others`);

/** Who wrote to whom, in words: names of the contact and the mailbox owner only, and a count for anyone else. */
export function participantsWords(m: Pick<MailMessageView, 'sender' | 'contactRole' | 'otherRecipientCount' | 'mailboxOwnerName'>, contactName: string): string {
  const owner = m.mailboxOwnerName || 'the mailbox owner';
  if (m.sender === 'contact') return `From ${contactName} to ${owner}${others(m.otherRecipientCount)}`;
  const from = m.sender === 'mailbox' ? owner : 'someone else';
  return `From ${from} to ${contactName}${ROLE_SUFFIX[m.contactRole]}${others(m.otherRecipientCount)}`;
}

/**
 * What the coverage line may claim: the API's `since` is the oldest copy overall, but the thread shows only the
 * first page (limit=100). While more pages exist (nextBefore), "since" is the oldest copy SHOWN (never earlier
 * than the API's own date) and the line adds that older Gmail stays in Gmail.
 */
export function coverageLines(data: Pick<MailMessagesResponse, 'coverage' | 'items' | 'nextBefore'> | undefined): { lines: { address: string; since: string }[]; older: boolean } {
  if (!data || data.coverage.length === 0) return { lines: [], older: false };
  const older = data.nextBefore !== null;
  if (!older) return { lines: data.coverage, older };
  const shown = data.items.map((m) => Date.parse(m.internalAt)).filter((n) => !Number.isNaN(n));
  const oldestShown = shown.length > 0 ? Math.min(...shown) : null;
  return {
    lines: data.coverage.map((c) => {
      const since = Date.parse(c.since);
      return oldestShown !== null && (Number.isNaN(since) || oldestShown > since) ? { address: c.address, since: new Date(oldestShown).toISOString() } : c;
    }),
    older,
  };
}

/** "Showing Gmail with {address} since {date}; other mail stays in Gmail." per confirmed address. */
export function MailCoverage({ data }: { data: Pick<MailMessagesResponse, 'coverage' | 'items' | 'nextBefore'> | undefined }) {
  const { lines, older } = coverageLines(data);
  if (lines.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5" aria-label="Synced Gmail">
      {lines.map((c) => (
        <li key={`${c.address}:${c.since}`} className="text-[13px] text-ink-muted break-words">
          Showing Gmail with {c.address} since {formatSince(c.since)}; other mail stays in Gmail.
        </li>
      ))}
      {older ? <li className="text-[13px] text-ink-muted">{OLDER_GMAIL}</li> : null}
    </ul>
  );
}

function formatSince(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown date';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** One synced Gmail message in the conversation (an <li> of the "Conversation" list). Read-only: no reply. */
export function GmailEntry({ item, contact }: { item: MailMessageView; contact: { id: string; name: string } }) {
  const fromMailbox = item.sender === 'mailbox';
  return (
    <li id={`gmail-${item.id}`} data-gmail-entry={item.id} className={`flex max-w-[85%] flex-col gap-0.5 ${fromMailbox ? 'self-end items-end' : 'self-start items-start'}`}>
      <div className="flex min-w-0 flex-col gap-1 rounded-2xl border border-line bg-surface px-3.5 py-2 text-ink">
        {item.subject ? <p className="text-[15px] font-semibold [overflow-wrap:anywhere]">{item.subject}</p> : null}
        {item.body === '' ? <p className="text-[15px] italic text-ink-muted">{NO_TEXT}</p> : <p className="whitespace-pre-wrap break-words text-[16px]">{item.body}</p>}
        {item.body !== '' && item.bodyTruncated ? <p className="text-[13px] text-ink-muted">The rest of this message is in Gmail.</p> : null}
        {item.attachments.length > 0 ? (
          <div className="text-[13px] text-ink-muted">
            <p>Attachments, open in Gmail:</p>
            <ul className="list-disc pl-5">
              {item.attachments.map((a, i) => (
                <li key={`${i}:${a.name}`} className="[overflow-wrap:anywhere]">
                  {a.name}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      <p className="flex flex-wrap items-center gap-x-1 px-1 text-[12px] text-ink-muted">
        <span data-gmail-tag className="rounded-md border border-line px-1.5 py-px text-[12px] font-medium leading-4 text-ink">
          {GMAIL_TAG}
        </span>
        <span>
          {participantsWords(item, contact.name)} · {formatDateTime(item.internalAt)}
        </span>
      </p>
      {item.threadCapped ? <p className="px-1 text-[13px] text-ink-muted">{THREAD_CAPPED}</p> : null}
      {item.mine ? <RemoveThread threadId={item.threadId} contactId={contact.id} /> : null}
    </li>
  );
}

/** The mailbox owner's "Remove this thread from Realty OS" → confirm (2 taps). Final while the link lives. */
function RemoveThread({ threadId, contactId }: { threadId: string; contactId: string }) {
  const qc = useQueryClient();
  const { announce } = useAgentSheets();
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const exclude = useMutate<Record<string, never>, { excluded: true }>('POST', { invalidate: [mailMessagesKey(contactId)] });
  const remove = async () => {
    const r = await exclude.run(`/me/mail-threads/${encodeURIComponent(threadId)}/exclude`, {});
    if (r.ok) {
      // the entry (the dialog's opener) unmounts with the thread: focus goes to the conversation list, not <body>
      const list = opener.current?.closest<HTMLElement>('ol[aria-label="Conversation"]') ?? null;
      setOpen(false);
      // drop the thread at once; the refetch the mutation started confirms it
      qc.setQueryData<MailMessagesResponse>(mailMessagesKey(contactId), (old) => (old ? { ...old, items: old.items.filter((m) => m.threadId !== threadId) } : old));
      announce(THREAD_REMOVED);
      setTimeout(() => {
        if (!list || !list.isConnected) return;
        if (!list.hasAttribute('tabindex')) list.setAttribute('tabindex', '-1');
        list.focus();
      }, 0);
    }
  };
  return (
    <>
      <Button ref={opener} variant="quiet" className="text-[14px]" onClick={() => setOpen(true)}>
        {REMOVE_THREAD}
      </Button>
      {open ? (
        <Dialog
          title="Remove this thread from Realty OS?"
          description={REMOVE_THREAD_CONSEQUENCE}
          onClose={() => setOpen(false)}
          footer={
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Go back
              </Button>
              <Button variant="danger" pending={exclude.pending} pendingLabel="Removing" onClick={() => void remove()}>
                Remove thread
              </Button>
            </div>
          }
        >
          <p className="text-[16px] text-ink">Nothing changes in Gmail.</p>
          {exclude.error ? (
            <p role="alert" className="mt-2 text-[14px] font-medium text-danger">
              {exclude.error.message}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </>
  );
}
