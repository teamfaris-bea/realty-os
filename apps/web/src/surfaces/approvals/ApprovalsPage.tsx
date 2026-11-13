// Approvals inbox (BUILD_PLAN module 17): assistant drafts, handbacks and saved-search proposals that
// need the agent (GET /assistant/inbox). Approving a draft or handback reply is ONE tap (Send).
//
// Every card shows the assistant's one-line explanation and each claim with its evidence (source +
// locator + the verbatim snippet), and flags what it could not verify with "Check this" in words.
// There is no confidence anywhere (R-AST-13): the view types have no such field and nothing here
// renders a score or a percentage. Needs-review claims can be confirmed or rejected in place.
//
// A draft the send-time check would block (the contact opted out, the address is suppressed, ...) says
// so next to its Send button, in the server's words ("Won't send: Opted out of texts"). There is no
// consent prompt and no "send anyway" for an opt-out (owner decision, core-compliance/2.0.0).
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button, Card, ClaimLine, EmptyState, GateBadge, Notice } from '../../design/index.js';
import { type ChannelState, ReachabilityBatch, ReasonCaption, channelState, useReachability } from '../../reasons/index.js';
import { replyChatState } from '../compose/channelChoice.js';
import { type ApiError, messageFor, useApi, useCommand } from '../../shell/index.js';
import { AgentSheetsProvider, SendOutcome, sentResult, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { claimView, firstName, relativeTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES, dealDateStaleWords, homeValueRefusalWords } from '../feed/lib/messages.js';
import { useSendCheck } from '../feed/lib/sendCheck.js';
import type { ActionView, ApproveResponse, ClaimApiView } from '../feed/lib/types.js';
import { ContactSearches } from './SavedSearchReview.js';
import { MarketingApprovals } from './MarketingApprovals.js';
import { SellerUpdateApproval } from './SellerUpdateApproval.js';
import { AiApprovalExtras, withoutAiActions } from '../aiCare/Compose.js'; // module 76 (flagged edit)

export const INBOX_KEY = ['inbox'] as const;

export function useInbox() {
  const api = useApi();
  return useQuery<{ items: ActionView[] }, ApiError>({
    queryKey: INBOX_KEY,
    queryFn: ({ signal }) => api.get<{ items: ActionView[] }>('/assistant/inbox', { signal }),
    // module 76 (V1): AI ISA actions never reach an inbox consumer (approving one would withdraw it or close its handoff)
    select: withoutAiActions,
    refetchInterval: 30_000,
  });
}

const KIND_LABEL: Record<string, string> = {
  message_draft: 'Draft reply',
  handback: 'Replied to the assistant',
  call_summary: 'Call summary',
  promise_extraction: 'Promise found in a call',
  saved_search_proposal: 'Saved search proposal',
  next_step: 'Suggested next step',
  lead_summary: 'Lead summary',
  seller_update_draft: 'Seller update draft',
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? 'From the assistant';
}

/** What the assistant drafted, by the channel it goes out on (a web-chat reply is never captioned as an email, ui-compose/F3). */
export const DRAFT_CAPTION: Record<NonNullable<ActionView['draft']>['channel'], string> = {
  sms: 'Text the assistant drafted',
  email: 'Email the assistant drafted',
  web_chat: 'Chat reply the assistant drafted',
};

export default function ApprovalsPage() {
  return (
    <AgentSheetsProvider>
      <Approvals />
    </AgentSheetsProvider>
  );
}

function Approvals() {
  const q = useInbox();
  const { hash } = useLocation();
  // seller updates sent from this page stay on it with their outcome (they leave the pending inbox when sent)
  const [kept, setKept] = useState<ActionView[]>([]);
  useEffect(() => {
    if (!hash || !q.data) return;
    document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [hash, q.data]);
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const items = [...q.data.items, ...kept.filter((k) => !q.data.items.some((i) => i.id === k.id))];
  if (items.length === 0) {
    return (
      <MarketingApprovals
        whenEmpty={
          <EmptyState icon="inbox" title="Nothing to approve">
            Drafts and replies from the assistant that need you will show up here.
          </EmptyState>
        }
      />
    );
  }
  // one reachability request for every card's contact (not one per card)
  const contactIds = items.flatMap((a) => (a.contactId && a.primaryAction === 'send' && a.draft ? [a.contactId] : []));
  // a seller update (module 28) belongs to a listing, not a contact: its card loads its own recipients
  return (
    <ReachabilityBatch contactIds={contactIds}>
      <div className="flex flex-col gap-4">
        <MarketingApprovals />
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {items.map((a) => (
            <li key={a.id} id={`action-${a.id}`} className="scroll-mt-20">
              {a.kind === 'seller_update_draft' && a.contactId === null ? <SellerUpdateApproval actionId={a.id} onSent={() => setKept((k) => (k.some((x) => x.id === a.id) ? k : [...k, a]))} /> : <ActionCard action={a} />}
            </li>
          ))}
        </ul>
      </div>
    </ReachabilityBatch>
  );
}

export function ActionCard({ action, showContact = true, headingLevel = 2 }: { action: ActionView; showContact?: boolean; headingLevel?: 2 | 3 }) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  const now = useNow(60_000);
  const sheets = useAgentSheets();
  const navigate = useNavigate();
  const titleId = useId();
  const [seenSeq, setSeenSeq] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  // E142: the deal date this update cites changed; E624 (b13 audit V2B-2): a home-value note's estimate can no longer be
  // shown to clients. A re-tap does not clear either, so Send goes away and only Dismiss stays
  const [dateStale, setDateStale] = useState<string | null>(null);
  const [result, setResult] = useState<ApproveResponse | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const approve = useCommand<Record<string, unknown>, ApproveResponse>(`/assistant/actions/${action.id}/approve`, { invalidate: [['inbox'], ['feed'], ['timeline']] });
  const reject = useMutate<Record<string, unknown>>('POST', { invalidate: [['inbox'], ['feed']] });
  const name = action.contactName ?? 'this contact';
  const sendable = action.primaryAction === 'send' && action.draft !== null;
  const threadHref = action.contactId ? `/contacts/${action.contactId}/thread?compose=draft&draft=${action.id}` : null;
  // whether the draft's channel is blocked at all (an opt-out, a suppression) comes from the summary; a web-chat draft
  // is judged by the chat (ended, turned off, opted out, the person's do-not-contact; review ui-compose/F3), never by
  // the texts. The draft's own words are still previewed for the rules that depend on them
  const summary = useReachability(sendable ? action.contactId : null);
  const draftChannel = action.draft?.channel ?? null;
  const reach: ChannelState = draftChannel === 'web_chat' ? replyChatState(summary) : draftChannel ? channelState(summary, draftChannel) : { blocked: false, sentence: null, note: null };
  const reasonId = useId();
  const check = useSendCheck({ contactId: action.contactId ?? '', channel: action.draft?.channel ?? 'sms', body: action.draft?.body ?? '', subject: action.draft?.subject ?? '', enabled: sendable && action.contactId !== null && !reach.blocked });

  const doApprove = async () => {
    const r = await approve.run(seenSeq !== null ? { reviewedInboundSeq: seenSeq } : {});
    if (!r.ok) {
      const hv = homeValueRefusalWords(r.code, r.details);
      if (hv?.kind === 'not_displayable') {
        setDateStale(hv.text);
        return;
      }
      if (r.code === 'DRAFT_STALE') {
        const dated = dealDateStaleWords(r.details);
        if (dated !== null) {
          setDateStale(dated);
          return;
        }
        const seq = r.details?.inboundSeq;
        if (typeof seq === 'number') setSeenSeq(seq);
        setStale(true);
      }
      return;
    }
    setStale(false);
    // a replay ('noop') went out only if its message did (finding F1)
    const did = sentResult(r.data);
    if (did === 'sent' || did === 'queued') sheets.announce(`Sent to ${name}.`);
    else if (did === 'acknowledged') sheets.announce('Marked as handled.');
    setResult(r.data);
  };
  const doReject = async () => {
    const r = await reject.run(`/assistant/actions/${action.id}/reject`);
    if (r.ok) sheets.announce('Dismissed.');
  };

  return (
    <Card as="article" aria-labelledby={titleId} className="flex flex-col gap-3">
      <div>
        <p className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {kindLabel(action.kind)} · {relativeTime(Date.parse(action.createdAt), now)}
        </p>
        <H id={titleId} className="text-[19px] font-semibold text-ink">
          {showContact && action.contactId ? (
            <Link to={`/contacts/${action.contactId}`} className="inline-flex min-h-tap items-center hover:underline">
              {name}
            </Link>
          ) : (
            name
          )}
        </H>
        <p className="text-[15px] text-ink">{action.explanation}</p>
      </div>
      {action.draft ? (
        <figure className="flex flex-col gap-1">
          <figcaption className="text-[13px] font-medium text-ink-muted">{DRAFT_CAPTION[action.draft.channel]}</figcaption>
          {action.draft.subject ? <p className="text-[15px] font-semibold text-ink">{action.draft.subject}</p> : null}
          <blockquote className="whitespace-pre-wrap rounded-xl bg-surface-2 px-3.5 py-2.5 text-[16px] text-ink">{action.draft.body}</blockquote>
        </figure>
      ) : null}
      {action.claims.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label="What the assistant found">
          {action.claims.map((c) => (
            <li key={c.id}>
              <ClaimLine claim={claimView(c, action.contactId)} />
              {c.needsReview ? <ClaimReview claim={c} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {dateStale ? <Notice tone="warn">{dateStale}</Notice> : null}
      {stale && !dateStale ? (
        <Notice tone="warn" title={`${firstName(name)} replied since this was drafted`} action={threadHref ? <Link to={threadHref} className="font-medium text-accent underline">Read it</Link> : undefined}>
          Read the new message, then send if this still fits.
        </Notice>
      ) : null}
      {approve.error && approve.error.code !== 'DRAFT_STALE' ? <Notice tone="error">{homeValueRefusalWords(approve.error.code, approve.error.details)?.text ?? approve.error.message}</Notice> : null}
      {reject.error ? <Notice tone="error">{reject.error.message}</Notice> : null}
      {result && !['acknowledged', 'sent', 'queued'].includes(sentResult(result)) ? (
        <SendOutcome result={{ result: sentResult(result), decision: result.decision, message: null }} contactName={name} />
      ) : sendable && reach.blocked ? (
        <ReasonCaption id={reasonId} state={reach} />
      ) : sendable && check.decision?.outcome === 'deny' ? (
        <GateBadge decision={check.decision} />
      ) : null}
      <AiApprovalExtras action={action} />
      <div className="flex flex-wrap gap-2">
        {action.kind === 'saved_search_proposal' && action.contactId ? (
          <Button aria-expanded={searchOpen} onClick={() => setSearchOpen((o) => !o)}>
            {searchOpen ? 'Hide search' : 'Review search'}
          </Button>
        ) : sendable && dateStale ? null : sendable ? (
          <>
            <Button icon="message" pending={approve.pending} pendingLabel="Sending" disabled={reach.blocked} aria-describedby={reach.blocked ? reasonId : undefined} onClick={() => void doApprove()}>
              {stale ? 'Send anyway' : 'Send'}
            </Button>
            {threadHref ? (
              <Button variant="secondary" onClick={() => navigate(threadHref)}>
                Edit
              </Button>
            ) : null}
          </>
        ) : action.kind === 'handback' && action.contactId ? (
          <>
            <Button icon="message" onClick={() => navigate(`/contacts/${action.contactId}/thread?compose=sms`)}>
              Reply
            </Button>
            <Button variant="secondary" pending={approve.pending} onClick={() => void doApprove()}>
              Mark handled
            </Button>
          </>
        ) : (
          <Button pending={approve.pending} onClick={() => void doApprove()}>
            Got it
          </Button>
        )}
        <Button variant="quiet" pending={reject.pending} onClick={() => void doReject()}>
          Dismiss
        </Button>
      </div>
      {searchOpen && action.contactId ? (
        <div className="border-t border-line pt-3">
          <ContactSearches contactId={action.contactId} claims={action.claims} />
        </div>
      ) : null}
    </Card>
  );
}

/** Confirm or reject one needs-review claim (R-AST-5: until then it is used nowhere). */
function ClaimReview({ claim }: { claim: ClaimApiView }) {
  const m = useMutate<Record<string, unknown>>('POST', { invalidate: [['inbox'], ['tasks']] });
  const [done, setDone] = useState<string | null>(null);
  const review = async (status: 'confirmed' | 'rejected') => {
    const r = await m.run(`/assistant/claims/${claim.id}/review`, { status });
    if (r.ok) setDone(status === 'confirmed' ? 'Confirmed.' : 'Marked wrong. It will not be used.');
  };
  if (done) return <p className="pl-3 pt-1 text-[14px] text-ink-muted">{done}</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 pl-3 pt-1">
      <Button variant="secondary" className="min-h-tap text-[15px]" disabled={m.pending} onClick={() => void review('confirmed')}>
        Looks right
      </Button>
      <Button variant="quiet" className="min-h-tap text-[15px]" disabled={m.pending} onClick={() => void review('rejected')}>
        That's wrong
      </Button>
      {m.error ? <span className="text-[14px] text-danger">{m.error.message}</span> : null}
    </div>
  );
}
