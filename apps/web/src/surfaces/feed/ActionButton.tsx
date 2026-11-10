// One button per OneTapAction (core/priority). One tap does the job the card names:
//
//   accept_offer / decline_offer / claim   ownership command (useCommand: commandId once per tap)
//   call                                   tap-to-call with the post-call outcome sheet
//   text / email / edit_draft              the thread with the compose box (assistant draft prefilled)
//   send_draft                             approve the assistant's draft as is → send (1 tap)
//   review_handback                        the approvals inbox at that handback
//   complete_task / complete_deal_date     mark done
//   log_outcome                            the appointment outcome sheet
//   open_* / review_search                 the page that holds it
//
// A `note` on an action is an optional hint shown under the button (core/priority no longer sets one:
// the send-time check never asks for a confirmation). Every send is checked again when it goes out,
// and a blocked one says why ("Not sent: Opted out of texts").
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, type ButtonVariant, type IconName } from '../../design/index.js';
import { useCommand } from '../../shell/index.js';
import { useAgentSheets } from './lib/AgentSheets.js';
import { useMutate } from './lib/hooks.js';
import type { ApproveResponse, FeedCard, OneTapAction, OwnershipResultResponse } from './lib/types.js';

export const ACTION_ICON: Partial<Record<OneTapAction['kind'], IconName>> = {
  accept_offer: 'check',
  claim: 'check',
  call: 'phone',
  text: 'message',
  email: 'message',
  send_draft: 'message',
  complete_task: 'checklist',
  complete_deal_date: 'check',
  log_outcome: 'checklist',
  review_handback: 'inbox',
};

export interface ActionButtonProps {
  action: OneTapAction;
  card?: Pick<FeedCard, 'contact' | 'itemType'> | undefined;
  variant?: ButtonVariant;
  /** disables actions whose deadline has passed (an ended offer), with the reason said in the card */
  expired?: boolean;
  block?: boolean;
  className?: string;
}

const FEED_KEYS = [['feed'], ['inbox']];

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
    default:
      return <NavButton {...p} />;
  }
}

function Note({ text }: { text?: string | undefined }) {
  return text ? <span className="block pt-1 text-[13px] leading-snug text-warn">{text}</span> : null;
}

function Wrap({ note, error, children, block }: { note?: string | undefined; error?: string | null | undefined; children: ReactNode; block?: boolean | undefined }) {
  return (
    <span className={`inline-flex flex-col ${block ? 'w-full' : ''}`}>
      {children}
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
    if (!r.ok) return;
    if (action.kind === 'decline_offer') announce('Declined. The lead goes to the next agent.');
    else announce(`${who} is yours now.`);
  };
  return (
    <Wrap error={cmd.error?.message} block={block}>
      <Button variant={variant} icon={ACTION_ICON[action.kind]} pending={cmd.pending} disabled={expired} block={block} className={className} onClick={() => void run()}>
        {action.label}
      </Button>
    </Wrap>
  );
}

function SendDraftButton({ action, card, variant = 'primary', block, className }: ActionButtonProps & { action: Extract<OneTapAction, { kind: 'send_draft' }> }) {
  const sheets = useAgentSheets();
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
    if (r.data.result === 'sent' || r.data.result === 'queued' || r.data.result === 'noop') sheets.announce(`Sent to ${name}.`);
    else if (r.data.result === 'acknowledged') sheets.announce('Marked as reviewed.');
    else sheets.announce(r.data.decision?.explanation ? `Not sent: ${r.data.decision.explanation}` : 'Not sent.');
  };
  return (
    <Wrap note={action.note} error={cmd.error && cmd.error.code !== 'DRAFT_STALE' ? cmd.error.message : null} block={block}>
      <Button variant={variant} icon="message" pending={cmd.pending} pendingLabel="Sending" block={block} className={className} onClick={() => void run()}>
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
  return (
    <Wrap note={action.note} block={block}>
      <Button variant={variant} icon="phone" block={block} className={className} onClick={() => call({ id: action.contactId, name: card?.contact?.name ?? 'this contact' })}>
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

/** Where a navigation action goes (pure; unit-tested). */
export function actionHref(a: OneTapAction, card?: Pick<FeedCard, 'contact'>): string | null {
  switch (a.kind) {
    case 'text':
      return `/contacts/${a.contactId}/thread?compose=sms${a.draftActionId ? `&draft=${a.draftActionId}` : ''}`;
    case 'email':
      return `/contacts/${a.contactId}/thread?compose=email${a.draftActionId ? `&draft=${a.draftActionId}` : ''}`;
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
    default:
      return null;
  }
}

function NavButton({ action, card, variant = 'primary', block, className }: ActionButtonProps) {
  const navigate = useNavigate();
  const href = actionHref(action, card);
  const note = 'note' in action ? action.note : undefined;
  return (
    <Wrap note={note} block={block}>
      <Button variant={variant} icon={ACTION_ICON[action.kind]} block={block} className={className} disabled={href === null} onClick={() => href && navigate(href)}>
        {action.label}
      </Button>
    </Wrap>
  );
}
