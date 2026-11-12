// One button per OneTapAction (core/priority). One tap does the job the card names:
//
//   accept_offer / decline_offer / claim   ownership command (useCommand: commandId once per tap)
//   call                                   tap-to-call with the post-call outcome sheet
//   text / email / edit_draft              the thread with the compose box (assistant draft prefilled)
//   reply_chat                             the thread with the box on web chat, where the client wrote last (module 22);
//                                          disabled before the tap once the chat ended, with the summary's reason, and
//                                          when the summary has no chat to answer (review ui-compose/F2)
//   send_draft                             approve the assistant's draft as is → send (1 tap)
//   review_handback                        the approvals inbox at that handback
//   complete_task / complete_deal_date     mark done
//   log_outcome                            the appointment outcome sheet
//   open_* / review_search                 the page that holds it (open_listing: the listing page)
//   open_plan                              the weekly plan page of that week (/plan/:week, module 40)
//   show_details                           opens the card's own details in place (Phase 2/3 cards whose
//                                          page does not exist yet)
//   open_coaching_fix                      the daily coaching fix page (module 40)
//
// An ownership command that fails is said through the app's announcer (the agent toast and the polite live
// region), not inside the card: the refresh the answer triggers usually takes the card away (someone else
// claimed the lead, the offer ended), and the reason must outlive it (journey J2: the late claimer's "Someone
// else claimed this lead just now." vanished with the pond card).
//
// A `note` on an action is an optional hint shown under the button (core/priority no longer sets one:
// the send-time check never asks for a confirmation). Text, Email, Call and Send are disabled before
// the tap when the contact cannot be reached on that channel, with the exact reason under the button
// ("Texted STOP on Nov 10"; reasons/useReachability, loaded once per feed). Every send is still checked
// again when it goes out, and a blocked one says why.
import { type ReactNode, useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, type ButtonVariant, type IconName } from '../../design/index.js';
import { type ChannelState, ReasonCaption, channelState, useChannelState, useReachability } from '../../reasons/index.js';
import { replyChatState } from '../compose/channelChoice.js';
import { useCommand } from '../../shell/index.js';
import { useInbox } from '../approvals/ApprovalsPage.js';
import { sendOutcomeText, sentResult, useAgentSheets } from './lib/AgentSheets.js';
import { useMutate } from './lib/hooks.js';
import type { ApproveResponse, FeedCard, OneTapAction, OwnershipResultResponse } from './lib/types.js';

export const ACTION_ICON: Partial<Record<OneTapAction['kind'], IconName>> = {
  accept_offer: 'check',
  claim: 'check',
  call: 'phone',
  text: 'message',
  email: 'message',
  reply_chat: 'message',
  send_draft: 'message',
  complete_task: 'checklist',
  complete_deal_date: 'check',
  log_outcome: 'checklist',
  review_handback: 'inbox',
  open_listing: 'listing',
  open_plan: 'checklist',
  show_details: 'info',
  open_coaching_fix: 'info',
};

export interface ActionButtonProps {
  action: OneTapAction;
  card?: Pick<FeedCard, 'contact' | 'itemType'> | undefined;
  variant?: ButtonVariant;
  /** disables actions whose deadline has passed (an ended offer), with the reason said in the card */
  expired?: boolean;
  /** show_details: the card's details panel (opened by the tap) */
  details?: { open: boolean; controls: string; onOpen: () => void } | undefined;
  block?: boolean;
  className?: string;
}

const FEED_KEYS = [['feed'], ['inbox']];

/** A draft on a channel the lead has no number or address for (the approval answers CONTACT_POINT_MISSING). */
const NO_ADDRESS: Readonly<Record<'sms' | 'email', string>> = { sms: "There's no phone number on file to text", email: "There's no email address on file" };

export function ActionButton(p: ActionButtonProps) {
  switch (p.action.kind) {
    case 'accept_offer':
    case 'decline_offer':
    case 'claim':
      return <OwnershipButton {...p} action={p.action} />;
    case 'send_draft':
      return <SendDraftButton {...p} action={p.action} />;
    case 'complete_task':
    case 'complete_deal_date':
      return <CompleteButton {...p} action={p.action} />;
    case 'call':
      return <CallButton {...p} action={p.action} />;
    case 'log_outcome':
      return <OutcomeButton {...p} action={p.action} />;
    case 'show_details':
      return <DetailsButton {...p} action={p.action} />;
    default:
      return <NavButton {...p} />;
  }
}

function Note({ text }: { text?: string | undefined }) {
  return text ? <span className="block pt-1 text-[13px] leading-snug text-warn">{text}</span> : null;
}

function Wrap({ note, error, children, block, reach, reasonId }: { note?: string | undefined; error?: string | null | undefined; children: ReactNode; block?: boolean | undefined; reach?: ChannelState; reasonId?: string }) {
  return (
    <span className={`inline-flex flex-col ${block ? 'w-full' : ''}`}>
      {children}
      {reach?.blocked ? <ReasonCaption id={reasonId} state={reach} className="pt-1" /> : null}
      <Note text={note} />
      {error ? (
        <span role="alert" className="block pt-1 text-[14px] font-medium text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

function OwnershipButton({ action, card, variant = 'primary', expired, block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'accept_offer' | 'decline_offer' | 'claim' }> }) {
  const { announce } = useAgentSheets();
  const verb = action.kind === 'accept_offer' ? 'accept' : action.kind === 'decline_offer' ? 'decline' : 'claim';
  const cmd = useCommand<Record<string, unknown>, OwnershipResultResponse>(`/leads/${action.contactId}/${verb}`, { invalidate: [...FEED_KEYS, ['contact', action.contactId], ['pond']] });
  const body = action.kind === 'claim' ? { pondId: action.pondId } : { offerId: action.offerId };
  const who = card?.contact?.name ?? 'This lead';
  const run = async () => {
    const r = await cmd.run(body);
    // the refresh this answer triggers usually removes the card: say why where it outlives the card
    if (!r.ok) return announce(r.message);
    if (action.kind === 'decline_offer') announce('Declined. The lead goes to the next agent.');
    else announce(`${who} is yours now.`);
  };
  return (
    <Wrap block={block}>
      <Button variant={variant} icon={ACTION_ICON[action.kind]} pending={cmd.pending} disabled={expired} block={block} className={className} onClick={() => void run()}>
        {action.label}
      </Button>
    </Wrap>
  );
}

function SendDraftButton({ action, card, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'send_draft' }> }) {
  const sheets = useAgentSheets();
  const draftChannel = useInbox().data?.items.find((a) => a.id === action.actionId)?.draft?.channel ?? null;
  // judged by the channel the draft goes out on: a web-chat draft by the chat (ended, turned off, opted out, the person's
  // do-not-contact: review ui-compose/F3), never by the texts; a text or email to a lead with no number or address on
  // file (a chat-only lead's suggested text) is refused CONTACT_POINT_MISSING, so it is disabled with that reason first
  // (review chat-R2 of batch 6)
  const summary = useReachability(card?.contact?.id);
  const reach: ChannelState =
    draftChannel === 'web_chat'
      ? replyChatState(summary)
      : draftChannel && summary && !summary.channels[draftChannel].hasAddress
        ? { blocked: true, sentence: NO_ADDRESS[draftChannel], note: null }
        : draftChannel
          ? channelState(summary, draftChannel)
          : { blocked: false, sentence: null, note: null };
  const reasonId = useId();
  const navigate = useNavigate();
  const cmd = useCommand<Record<string, unknown>, ApproveResponse>(`/assistant/actions/${action.actionId}/approve`, { invalidate: [...FEED_KEYS, ['timeline']] });
  const name = card?.contact?.name ?? 'them';
  const run = async () => {
    const r = await cmd.run({});
    if (!r.ok) {
      // the client wrote since the draft was made: read it first (R-AST-6), in the thread
      if (r.code === 'DRAFT_STALE' && card?.contact) navigate(`/contacts/${card.contact.id}/thread?compose=draft&draft=${action.actionId}`);
      return;
    }
    // a replay ('noop') went out only if its message did (finding F1)
    const did = sentResult(r.data);
    if (did === 'sent' || did === 'queued') sheets.announce(`Sent to ${name}.`);
    else if (did === 'acknowledged') sheets.announce('Marked as reviewed.');
    else if (did === 'noop') sheets.announce(sendOutcomeText({ result: did, decision: r.data.decision, message: null }, name).title);
    else sheets.announce(r.data.decision?.explanation ? `Not sent: ${r.data.decision.explanation}` : 'Not sent.');
  };
  return (
    <Wrap note={action.note} error={cmd.error && cmd.error.code !== 'DRAFT_STALE' ? cmd.error.message : null} block={block} reach={reach} reasonId={reasonId}>
      <Button variant={variant} icon="message" pending={cmd.pending} pendingLabel="Sending" block={block} className={className} disabled={reach.blocked} aria-describedby={reach.blocked ? reasonId : undefined} onClick={() => void run()}>
        {action.label}
      </Button>
    </Wrap>
  );
}

function CompleteButton({ action, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'complete_task' | 'complete_deal_date' }> }) {
  const { announce } = useAgentSheets();
  const m = useMutate<Record<string, unknown>>('PATCH', { invalidate: [...FEED_KEYS, ['tasks'], ['deal']] });
  const run = async () => {
    const r = action.kind === 'complete_task' ? await m.run(`/tasks/${action.taskId}`, { status: 'done' }) : await m.run(`/deal-dates/${action.dealDateId}`, { completed: true });
    if (r.ok) announce('Marked done.');
  };
  return (
    <Wrap error={m.error?.message} block={block}>
      <Button variant={variant} icon={ACTION_ICON[action.kind]} pending={m.pending} block={block} className={className} onClick={() => void run()}>
        {action.label}
      </Button>
    </Wrap>
  );
}

function CallButton({ action, card, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'call' }> }) {
  const { call } = useAgentSheets();
  const reach = useChannelState(action.contactId, 'voice');
  const reasonId = useId();
  return (
    <Wrap note={action.note} block={block} reach={reach} reasonId={reasonId}>
      <Button variant={variant} icon="phone" block={block} className={className} disabled={reach.blocked} aria-describedby={reach.blocked ? reasonId : undefined} onClick={() => call({ id: action.contactId, name: card?.contact?.name ?? 'this contact' })}>
        {action.label}
      </Button>
    </Wrap>
  );
}

function OutcomeButton({ action, card, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'log_outcome' }> }) {
  const { logAppointment } = useAgentSheets();
  return (
    <Button variant={variant} icon="checklist" block={block} className={className} onClick={() => logAppointment(action.appointmentId, card?.contact ? `How did it go with ${card.contact.name}?` : undefined)}>
      {action.label}
    </Button>
  );
}

function DetailsButton({ action, details, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'show_details' }> }) {
  return (
    <Button
      variant={variant}
      icon="info"
      block={block}
      className={className}
      disabled={details === undefined}
      aria-expanded={details?.open ?? false}
      aria-controls={details?.controls}
      onClick={() => details?.onOpen()}
    >
      {action.label}
    </Button>
  );
}

/** Where a navigation action goes (pure; unit-tested). */
export function actionHref(a: OneTapAction, card?: Pick<FeedCard, 'contact'>): string | null {
  switch (a.kind) {
    case 'text':
      return `/contacts/${a.contactId}/thread?compose=sms${a.draftActionId ? `&draft=${a.draftActionId}` : ''}`;
    case 'email':
      return `/contacts/${a.contactId}/thread?compose=email${a.draftActionId ? `&draft=${a.draftActionId}` : ''}`;
    case 'reply_chat':
      return `/contacts/${a.contactId}/thread?compose=web_chat`;
    case 'edit_draft':
      return card?.contact ? `/contacts/${card.contact.id}/thread?compose=draft&draft=${a.actionId}` : `/approvals#action-${a.actionId}`;
    case 'review_handback':
      return `/approvals#action-${a.actionId}`;
    case 'open_task':
      return `/tasks#task-${a.taskId}`;
    case 'open_deal':
      return `/deals/${a.dealId}`;
    case 'review_search':
      return card?.contact ? `/contacts/${card.contact.id}?review=searches#searches` : '/approvals';
    case 'open_contact':
      return `/contacts/${a.contactId}`;
    case 'open_listing':
      return `/listings/${a.listingId}`;
    case 'open_plan':
      return `/plan/${a.week}`;
    case 'open_coaching_fix':
      return '/coaching';
    default:
      return null;
  }
}

function NavButton({ action, card, variant = 'primary', block, className }: ActionButtonProps) {
  const navigate = useNavigate();
  const href = actionHref(action, card);
  const note = 'note' in action ? action.note : undefined;
  // Text / Email / Reply (web chat) open the composer: say before the tap when that channel is blocked
  const channel = action.kind === 'text' ? 'sms' : action.kind === 'email' ? 'email' : null;
  const chat = action.kind === 'reply_chat';
  const summary = useReachability((channel || chat) && 'contactId' in action ? action.contactId : null);
  const reach: ChannelState = chat ? replyChatState(summary) : channel ? channelState(summary, channel) : { blocked: false, sentence: null, note: null };
  const reasonId = useId();
  return (
    <Wrap note={note} block={block} reach={reach} reasonId={reasonId}>
      <Button variant={variant} icon={ACTION_ICON[action.kind]} block={block} className={className} disabled={href === null || reach.blocked} aria-describedby={reach.blocked ? reasonId : undefined} onClick={() => href && navigate(href)}>
        {action.label}
      </Button>
    </Wrap>
  );
}
