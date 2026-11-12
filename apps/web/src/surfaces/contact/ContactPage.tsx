// Contact (BUILD_PLAN module 17): one person, phone first.
//
// - Card view (R-PERM-6): a contact the caller sees only as a pond or offer card shows exactly the
//   card (first name + last initial for pond cards, intent, source, area/summary, age) and the one
//   action that makes it theirs: Accept (with the live offer countdown) / Decline, or Claim. No
//   phone, email, timeline, task, deal or search is requested or shown until it is theirs.
// - Full view: Call / Text / Email in one tap each (the send-time check runs at the tap), what the
//   assistant has for this contact, saved searches, open tasks, deals (+ Start a deal, which copies
//   the lead's attribution server-side, A7d), and the recent timeline. If texts or email to this
//   contact would be blocked (they texted STOP, unsubscribed, asked not to be contacted, or the address
//   is suppressed), that button is disabled and the exact reason shows under it before any tap
//   ("Texted STOP on Nov 10", "Asked not to be called (recorded by Avery Brooks on Oct 3)"), from the
//   reachability summary (GET /contacts/:id/reachability). A text STOP does not block email or calls.
//   The send or call is still checked at the moment it goes out. Nobody can override an opt-out.
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button, ButtonLink, Card, Notice } from '../../design/index.js';
import { type ChannelState, ReasonCaption, channelState, useReachability } from '../../reasons/index.js';
import { type ApiError, messageFor, useApi, usePageTitle } from '../../shell/index.js';
import { ActionCard, useInbox } from '../approvals/ApprovalsPage.js';
import { ContactSearches } from '../approvals/SavedSearchReview.js';
import { ActionButton } from '../feed/ActionButton.js';
import { Countdown } from '../feed/FeedPage.js';
import { AgentSheetsProvider, useAgentSheets } from '../feed/lib/AgentSheets.js';
import { STAGE_LABEL, formatDateTime, formatMoney, formatPhone, intentLabel, relativeTime } from '../feed/lib/format.js';
import { useMutate, useNow } from '../feed/lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from '../feed/lib/messages.js';
import type { ContactCardView, ContactFullView, DealSide, DealView, TaskView, TimelineItem } from '../feed/lib/types.js';
import { MessageRow, useTimeline } from '../thread/ThreadPage.js';
import { MergedAwayNotice } from './MergedAway.js';
import { ContactSections } from './sections.js';
import { useContact } from './useContact.js';
import { renderMentions } from '@realty/core/parity/people';

export default function ContactPage() {
  return (
    <AgentSheetsProvider>
      <Contact />
    </AgentSheetsProvider>
  );
}

function Contact() {
  const { contactId = '' } = useParams();
  const q = useContact(contactId);
  usePageTitle(q.data?.contact.displayName ?? null);
  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading</p>;
  if (q.isError || !q.data) return <Notice tone="error">{q.error ? messageFor(q.error, AGENT_ERROR_MESSAGES) : null}</Notice>;
  const c = q.data.contact;
  return c.view === 'card' ? <CardView contact={c} /> : <FullView contact={c} />;
}

// ---- card view (R-PERM-6) ---------------------------------------------------------------------

function CardView({ contact }: { contact: ContactCardView }) {
  const now = useNow(60_000);
  const o = contact.ownership;
  const card = { contact: { id: contact.id, name: contact.displayName }, itemType: o.state === 'offered' ? 'lead_offer' : 'pond_new' };
  return (
    <div className="mx-auto flex w-full max-w-2xl md:mx-0 flex-col gap-4">
      <Card className="flex flex-col gap-2" aria-labelledby="lead-card">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="lead-card" className="text-[22px] font-semibold text-ink">
              {contact.displayName}
            </h2>
            <p className="text-[15px] text-ink-muted">
              {[intentLabel(contact.intent), contact.source?.name ? `From ${contact.source.name}` : null, `Came in ${relativeTime(Date.parse(contact.createdAt), now)}`].filter(Boolean).join(' · ')}
            </p>
          </div>
          {o.state === 'offered' && o.offeredToMe && o.offerExpiresAt ? <Countdown dueAt={o.offerExpiresAt} kind="offer" label={`Offer for ${contact.displayName}`} /> : null}
        </div>
        {contact.pondSummary ? <p className="text-[16px] text-ink">{contact.pondSummary}</p> : null}
        {o.state === 'in_pond' && o.pondName ? <p className="text-[15px] text-ink-muted">In the {o.pondName} pond</p> : null}
        <p className="text-[14px] text-ink-muted">Phone, email and history show once the lead is yours.</p>
        <div className="flex flex-wrap gap-2 pt-1">
          {o.state === 'offered' && o.offeredToMe && o.offerId ? (
            <>
              <ActionButton action={{ kind: 'accept_offer', label: 'Accept', contactId: contact.id, offerId: o.offerId }} card={card} expired={o.offerExpiresAt !== null && Date.parse(o.offerExpiresAt) <= Date.now()} />
              <ActionButton action={{ kind: 'decline_offer', label: 'Decline', contactId: contact.id, offerId: o.offerId }} card={card} variant="secondary" />
            </>
          ) : null}
          {o.state === 'in_pond' && o.pondId ? <ActionButton action={{ kind: 'claim', label: 'Claim', contactId: contact.id, pondId: o.pondId }} card={card} /> : null}
        </div>
      </Card>
    </div>
  );
}

// ---- full view --------------------------------------------------------------------------------

function Section({ title, children, id, action }: { title: string; children: ReactNode; id?: string; action?: ReactNode }) {
  const hid = useId();
  return (
    <section id={id} aria-labelledby={hid} className="flex scroll-mt-20 flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={hid} className="flex-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const POINT_STATUS: Record<string, string> = { invalid: 'not a working number', wrong_number: 'wrong number', bounced: 'emails bounce', unverified: 'not verified' };

/** One of Call / Text / Email: disabled with the exact reason under it when the channel is blocked. */
function ChannelAction({ label, icon, variant = 'secondary', missing, state, onClick }: { label: string; icon: 'phone' | 'message'; variant?: 'primary' | 'secondary'; missing: boolean; state: ChannelState; onClick: () => void }) {
  const id = useId();
  const say = !missing && (state.blocked || state.note);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Button variant={variant} icon={icon} disabled={missing || state.blocked} aria-describedby={say ? id : undefined} onClick={onClick}>
        {label}
      </Button>
      {say ? <ReasonCaption id={id} state={state} /> : null}
    </div>
  );
}

function FullView({ contact }: { contact: ContactFullView }) {
  const { call } = useAgentSheets();
  const navigate = useNavigate();
  const { hash } = useLocation();
  const now = useNow(1000);
  const o = contact.ownership;
  const inbox = useInbox();
  const forContact = (inbox.data?.items ?? []).filter((a) => a.contactId === contact.id);
  const proposalClaims = forContact.filter((a) => a.kind === 'saved_search_proposal').flatMap((a) => a.claims);
  const firstTouchDue = o.state === 'owned' && o.ownedByMe && o.firstTouchDueAt && !o.firstTouchAt ? o.firstTouchDueAt : null;
  const reach = useReachability(contact.id);
  const text = channelState(reach, 'sms');
  const email = channelState(reach, 'email');
  const voice = channelState(reach, 'voice');

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [hash]);

  const inquiry = contact.inquiries[0];
  return (
    <div className="mx-auto flex w-full max-w-3xl md:mx-0 flex-col gap-5">
      <Card className="flex flex-col gap-3" aria-labelledby="contact-name">
        <div>
          <h2 id="contact-name" className="text-[22px] font-semibold text-ink">
            {contact.displayName}
          </h2>
          <p className="text-[15px] text-ink-muted">
            {[intentLabel(contact.intent), contact.stage.replace(/_/g, ' '), o.ownedByMe ? 'Yours' : contact.owner?.displayName ? `Owner: ${contact.owner.displayName}` : null, contact.source?.name ? `From ${contact.source.name}` : null]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        {firstTouchDue ? (
          <p className="flex flex-wrap items-center gap-2 text-[15px] text-ink">
            First contact due: <Countdown dueAt={firstTouchDue} kind="deadline" label={`First contact with ${contact.displayName}`} />
          </p>
        ) : null}
        {o.state === 'offered' && o.offeredToMe && o.offerId ? (
          <div className="flex flex-wrap gap-2">
            <ActionButton action={{ kind: 'accept_offer', label: 'Accept', contactId: contact.id, offerId: o.offerId }} card={{ contact: { id: contact.id, name: contact.displayName }, itemType: 'lead_offer' }} expired={o.offerExpiresAt !== null && Date.parse(o.offerExpiresAt) <= now} />
          </div>
        ) : null}
        {contact.mergedIntoContactId ? (
          // review F7: the API refuses every send and call to a merged-away record; say where the person went instead
          <MergedAwayNotice to={contact.mergedIntoContactId} />
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <ChannelAction label="Call" icon="phone" variant="primary" missing={contact.phones.length === 0} state={voice} onClick={() => call({ id: contact.id, name: contact.displayName })} />
            <ChannelAction label="Text" icon="message" missing={contact.phones.length === 0} state={text} onClick={() => navigate(`/contacts/${contact.id}/thread?compose=sms`)} />
            <ChannelAction label="Email" icon="message" missing={contact.emails.length === 0} state={email} onClick={() => navigate(`/contacts/${contact.id}/thread?compose=email`)} />
          </div>
        )}
        <ul className="flex flex-col gap-1 text-[15px] text-ink">
          {contact.phones.map((p) => (
            <li key={p.id}>
              {formatPhone(p.address)} <span className="text-ink-muted">· {p.label}{POINT_STATUS[p.status] ? ` · ${POINT_STATUS[p.status]}` : ''}</span>
            </li>
          ))}
          {contact.emails.map((p) => (
            <li key={p.id} className="break-all">
              {p.address} <span className="text-ink-muted">· {p.label}{POINT_STATUS[p.status] ? ` · ${POINT_STATUS[p.status]}` : ''}</span>
            </li>
          ))}
          {contact.phones.length === 0 && contact.emails.length === 0 ? <li className="text-ink-muted">No phone or email on file.</li> : null}
          {/* E77, E154: what the visitor typed in the website chat; never a point, so nothing calls, texts or emails it */}
          {(contact.typedInChat ?? []).map((t) => (
            <li key={`${t.kind}:${t.address}`} className="break-all">
              {t.kind === 'phone' ? formatPhone(t.address) : t.address} <span className="text-ink-muted">· typed in chat, not verified</span>
            </li>
          ))}
        </ul>
        {inquiry && (inquiry.message || inquiry.propertyText) ? (
          <p className="rounded-xl bg-surface-2 px-3 py-2 text-[15px] text-ink">
            {inquiry.propertyText ? <span className="font-medium">{inquiry.propertyText}. </span> : null}
            {inquiry.message ? `“${inquiry.message}”` : null} <span className="text-ink-muted">· {inquiry.source ?? 'Inquiry'}, {formatDateTime(inquiry.receivedAt)}</span>
          </p>
        ) : null}
      </Card>

      <ContactSections contact={contact} />

      {forContact.length > 0 ? (
        <Section title="From the assistant">
          <ul className="flex flex-col gap-3">
            {forContact.map((a) => (
              <li key={a.id}>
                <ActionCard action={a} showContact={false} headingLevel={3} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="Conversation" action={<ButtonLink to={`/contacts/${contact.id}/thread`} variant="quiet">Open</ButtonLink>}>
        <RecentTimeline contactId={contact.id} contact={{ id: contact.id, name: contact.displayName }} />
      </Section>

      <Section title="Tasks">
        <ContactTasks contactId={contact.id} />
      </Section>

      <Section title="Deals">
        <ContactDeals contactId={contact.id} name={contact.displayName} />
      </Section>

      <Section title="Saved searches" id="searches">
        <ContactSearches contactId={contact.id} claims={proposalClaims} />
      </Section>
    </div>
  );
}

const STAGE_WORD: Record<string, string> = { new: 'New', attempting: 'Attempting', connected: 'Connected', nurture: 'Nurture', active: 'Active', under_contract: 'Under contract', closed: 'Closed', lost: 'Lost' };

const TIMELINE_LABEL: Record<string, string> = {
  note: 'Note',
  ownership: 'Lead history',
  appointment: 'Appointment',
  behavior: 'Website activity',
};

const OWNERSHIP_LABEL: Record<string, string> = {
  created: 'Added',
  offered: 'Offered',
  offer_rescinded: 'Offer withdrawn',
  reinquiry: 'Asked again',
  sla_waived: 'First-contact deadline waived',
  inactivity_warned: 'No contact in a while: warning sent',
  merged_away: 'Merged into another contact',
  merged_in: 'Merged with a duplicate',
  offer_accepted: 'Accepted',
  offer_declined: 'Declined',
  offer_expired: 'Offer ended',
  claimed: 'Claimed',
  assigned: 'Assigned',
  reassigned: 'Reassigned',
  released: 'Released',
  auto_released: 'Released (no first contact in time)',
  inactivity_released: 'Released (no contact in a while)',
  sent_to_pond: 'Sent to the pond',
  first_touch_recorded: 'First contact',
  first_touch_breached: 'First contact was late',
  closed: 'Closed',
  reopened: 'Reopened',
  imported: 'Imported',
};

function RecentTimeline({ contactId, contact }: { contactId: string; contact: { id: string; name: string } }) {
  const t = useTimeline(contactId);
  if (t.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (t.isError) return <Notice tone="error">{messageFor(t.error, AGENT_ERROR_MESSAGES)}</Notice>;
  const items = t.data.items.slice(0, 12);
  if (items.length === 0) return <p className="text-[15px] text-ink-muted">Nothing yet.</p>;
  return (
    <ol className="flex flex-col gap-2">
      {items.map((i) => (i.type === 'message' || i.type === 'call' ? <MessageRow key={i.id} item={i} contact={contact} /> : <OtherItem key={i.id} item={i} />))}
    </ol>
  );
}

function OtherItem({ item }: { item: TimelineItem }) {
  // FUB parity: an outside activity is always labelled as logged (R-PAR-30); a stage change says from → to
  const logged = item.type === 'note' && item.detail?.startsWith('logged_activity:') ? `Logged ${item.detail.slice('logged_activity:'.length)}` : null;
  const stage = item.type === 'stage' && item.detail ? `Stage: ${item.detail.split('>').map((s) => STAGE_WORD[s] ?? s.replace(/_/g, ' ')).filter(Boolean).join(' → ')}` : null;
  const what = logged ?? stage ?? (item.type === 'ownership' ? (OWNERSHIP_LABEL[item.detail ?? ''] ?? (item.detail ?? '').replace(/_/g, ' ')) : (TIMELINE_LABEL[item.type] ?? item.type));
  return (
    <li className="rounded-xl border border-line bg-surface px-3 py-2 text-[15px] text-ink">
      <span className="font-medium">{what}</span>
      {item.type === 'note' && item.preview ? <span>: {renderMentions(item.preview)}</span> : null}
      {item.type === 'ownership' && item.note ? <span>: {item.note}</span> : null}
      <span className="text-ink-muted">
        {' '}
        · {logged ? 'by ' : ''}{item.actor?.displayName ? `${item.actor.displayName}, ` : ''}
        {formatDateTime(item.occurredAt)}
        {item.provenance === 'imported' ? ' · Imported' : ''}
      </span>
    </li>
  );
}

function ContactTasks({ contactId }: { contactId: string }) {
  const api = useApi();
  const q = useQuery<{ tasks: TaskView[] }, ApiError>({
    queryKey: ['tasks', 'contact', contactId],
    queryFn: ({ signal }) => api.get<{ tasks: TaskView[] }>(`/tasks?contactId=${contactId}&scope=visible&status=open`, { signal }),
  });
  if (q.isPending) return <p className="text-[15px] text-ink-muted">Loading</p>;
  if (q.isError) return <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice>;
  if (q.data.tasks.length === 0) return <p className="text-[15px] text-ink-muted">No open tasks.</p>;
  return (
    <ul className="flex flex-col gap-1 text-[15px] text-ink">
      {q.data.tasks.map((t) => (
        <li key={t.id}>
          <Link to={`/tasks#task-${t.id}`} className="inline-flex min-h-tap items-center hover:underline">
            {t.title}
          </Link>
          <span className="text-ink-muted"> · {t.dueAt ? formatDateTime(t.dueAt) : t.needsReview ? 'needs a date' : 'no date'}</span>
        </li>
      ))}
    </ul>
  );
}

function ContactDeals({ contactId, name }: { contactId: string; name: string }) {
  const api = useApi();
  const navigate = useNavigate();
  const [picking, setPicking] = useState(false);
  const q = useQuery<{ deals: DealView[] }, ApiError>({
    queryKey: ['deals', 'contact', contactId],
    queryFn: ({ signal }) => api.get<{ deals: DealView[] }>(`/deals?contactId=${contactId}`, { signal }),
  });
  const create = useMutate<{ primaryContactId: string; side: DealSide }, { deal: DealView }>('POST', { invalidate: [['deals']] });
  const start = async (side: DealSide) => {
    const r = await create.run('/deals', { primaryContactId: contactId, side });
    if (r.ok) navigate(`/deals/${r.data.deal.id}`);
  };
  return (
    <div className="flex flex-col gap-2">
      {q.isError ? <Notice tone="error">{messageFor(q.error, AGENT_ERROR_MESSAGES)}</Notice> : null}
      {q.data && q.data.deals.length > 0 ? (
        <ul className="flex flex-col gap-1 text-[15px]">
          {q.data.deals.map((d) => (
            <li key={d.id}>
              <Link to={`/deals/${d.id}`} className="inline-flex min-h-tap items-center text-ink hover:underline">
                {d.name}
              </Link>
              <span className="text-ink-muted">
                {' '}
                · {STAGE_LABEL[d.stage]}
                {formatMoney(d.priceCents) ? ` · ${formatMoney(d.priceCents)}` : ''}
              </span>
            </li>
          ))}
        </ul>
      ) : q.data ? (
        <p className="text-[15px] text-ink-muted">No deals yet.</p>
      ) : null}
      {picking ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={`Start a deal with ${name}`}>
          <Button pending={create.pending} onClick={() => void start('buy')}>
            Buying
          </Button>
          <Button variant="secondary" disabled={create.pending} onClick={() => void start('sell')}>
            Selling
          </Button>
          <Button variant="quiet" onClick={() => setPicking(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" className="self-start" onClick={() => setPicking(true)}>
          Start a deal
        </Button>
      )}
      {create.error ? <Notice tone="error">{create.error.message}</Notice> : null}
    </div>
  );
}
