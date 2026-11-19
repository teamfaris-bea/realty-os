// The Priority Feed (ARCHITECTURE §1 "See what's due": open the app → the feed, 0 taps).
//
// - "Due now" is the pinned band: live deadlines (lead offers, first contact due) in deadline order,
//   each with a live countdown that ticks once a second from one shared clock. When an offer's
//   countdown ends its Accept is disabled and the card says so; the feed refetches at that moment
//   so the card is replaced by what the server decided (no grace period is invented here: E3).
// - "Next up" is the scored band, in the server's order. The order is explained by reasons, never by
//   a number: the API sends no score (R-AST-13 display half) and the card shows its first reason,
//   with every reason one tap away ("Why this").
// - One-tap actions: the primary action is the big button; alternatives sit beside it.
// - Counts show their denominator ("Showing 50 of 63", R-ACC-4 display half).
// - Nothing on this page animates to look busy: "Updated 10:42 AM" is the real fetch time.
// - Phase 2/3 cards (seller update, marketing, weekly plan, coaching tip, likely to move; module 18a) are
//   written by their own modules and arrive with a label and one primary action like any other card. A
//   card whose page does not exist yet (the weekly plan, the daily tip) opens its own lines in place
//   ("See the plan"): one tap, and nothing pretends a page is there.
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Card, EmptyState, Notice, Ratio, useCountdownAnnouncement } from '../../design/index.js';
import { ApiError, messageFor, useApi } from '../../shell/index.js';
import { ReachabilityBatch } from '../../reasons/index.js';
import { ActionButton, LogButton } from './ActionButton.js';
import { OnePassProvider } from './OnePass.js';
import { AgentSheetsProvider, useAgentSheets } from './lib/AgentSheets.js';
import { automaticLine, lastLine, nextPromiseLine } from './lib/followUp.js';
import { countdownWords, formatCountdown, formatTime, itemLabel, relativeTime } from './lib/format.js';
import { useMutate, useNow } from './lib/hooks.js';
import { AGENT_ERROR_MESSAGES } from './lib/messages.js';
import type { FeedCard, FeedResponse, FollowUpTodayCard } from './lib/types.js';
import { AiFeedItem } from '../aiCare/Feed.js'; // module 76 (flagged edit)
import type { CardTask } from '../people-edit/StageStep.js';

export const FEED_KEY = ['feed'] as const;

/**
 * How far the daily plan's bounded read looks (R-TODAY-13): pages of candidates the server checks. The first read uses
 * the server's own default; each "Look further" asks for the next of these, up to the server's maximum (10).
 */
export const FOLLOW_UP_DEPTHS: readonly (number | undefined)[] = [undefined, 4, 8, 10];

export function useFeed(followUpDepth?: number) {
  const api = useApi();
  return useQuery<FeedResponse, ApiError>({
    // (every ['feed'] invalidation still matches a deeper read's key)
    queryKey: followUpDepth === undefined ? FEED_KEY : [...FEED_KEY, { followUpDepth }],
    // never resolves without a feed (react-query refuses undefined data): an empty or malformed answer is an error
    queryFn: async ({ signal }) => {
      const r = await api.get<FeedResponse | undefined>(followUpDepth === undefined ? '/feed' : `/feed?followUpDepth=${followUpDepth}`, { signal });
      if (!r || !Array.isArray(r.pinned) || !Array.isArray(r.scored)) throw new ApiError('BAD_RESPONSE', 200);
      return r;
    },
    // the page stays as it is while a deeper read is on its way
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    staleTime: 10_000,
  });
}

export default function FeedPage() {
  return (
    <AgentSheetsProvider>
      <OnePassProvider>
        <Feed />
      </OnePassProvider>
    </AgentSheetsProvider>
  );
}

function Feed() {
  // R-TODAY-13: how far the daily plan has been asked to look (an index into FOLLOW_UP_DEPTHS)
  const [look, setLook] = useState(0);
  const q = useFeed(FOLLOW_UP_DEPTHS[look]);
  const data = q.data;

  // refetch the moment the earliest pinned deadline passes: the server decides what happens next
  const nextDeadline = data?.pinned.map((c) => (c.dueAt ? Date.parse(c.dueAt) : Number.NaN)).filter((t) => Number.isFinite(t) && t > Date.now()).sort((a, b) => a - b)[0];
  const { refetch } = q;
  useEffect(() => {
    if (nextDeadline === undefined) return;
    const t = setTimeout(() => void refetch(), Math.min(nextDeadline - Date.now() + 250, 2_147_000_000));
    return () => clearTimeout(t);
  }, [nextDeadline, refetch]);

  if (q.isPending) return <p className="py-10 text-center text-[15px] text-ink-muted">Loading your feed</p>;
  if (!data) {
    return (
      <Notice tone="error" title="Can't load your feed" action={<Button variant="secondary" onClick={() => void q.refetch()}>Try again</Button>}>
        {q.error ? messageFor(q.error, AGENT_ERROR_MESSAGES) : null}
      </Notice>
    );
  }
  const shown = data.pinned.length + data.scored.length;
  // R-TODAY-6: the daily plan. A person due by a task is shown once, in the plan: that task's own card leaves "Next up"
  // (it is still one of the cards shown, so the count under the page does not change).
  const plan = data.followUpToday;
  // The same goes for any other task card of a person in the plan (the follow-up just set for tomorrow comes into the
  // feed a day ahead): their row is where their tasks are followed. Cards that are other work (a reply waiting, a
  // draft to review) stay.
  // R-TODAY-15: a PROMISE is never hidden this way. Its card leaves "Next up" only when the row itself shows that
  // promise: as the task it leads with, or named in its "Also due" line.
  const rows = plan?.people ?? [];
  const shownInRow = new Set(rows.flatMap((p) => [...(p.task ? [p.task.id] : []), ...(p.alsoDue ?? []).map((t) => t.taskId)]));
  const planPeople = new Set(rows.map((p) => p.contact?.id));
  const inPlan = new Set(rows.flatMap((p) => p.taskIds));
  const foldedIntoRow = (c: FeedCard) => {
    if (c.subjectType !== 'task') return false;
    if (c.itemType === 'promise_due') return shownInRow.has(c.subjectId);
    return inPlan.has(c.subjectId) || (c.contact !== null && planPeople.has(c.contact.id));
  };
  const nextUp = data.scored.filter((c) => !foldedIntoRow(c));
  // one reachability request for every card whose one-tap action contacts someone (lane optout-visibility)
  const contactIds = [...new Set([...data.pinned, ...data.scored, ...(plan?.people ?? [])].flatMap((c) => (c.contact && [c.primaryAction, ...c.alternatives].some((a) => CONTACTING.has(a.kind)) ? [c.contact.id] : [])))];
  return (
    <ReachabilityBatch contactIds={contactIds}>
    <div className="flex flex-col gap-6">
      {q.isError ? <Notice tone="warn">Couldn't refresh just now. This is your feed as of {formatTime(data.generatedAt)}.</Notice> : null}
      {/* (never "caught up" while the plan's read was not complete: somebody may still be due) */}
      {shown === 0 && (plan?.people.length ?? 0) === 0 && (plan === undefined || planComplete(plan)) ? (
        <EmptyState icon="check" title="You're caught up">
          New leads, replies and anything due will show up here.
        </EmptyState>
      ) : null}
      {data.pinned.length > 0 ? <Band title="Due now" cards={data.pinned} pinned /> : null}
      {plan ? <FollowUpToday plan={plan} looking={q.isPlaceholderData} onLookFurther={look < FOLLOW_UP_DEPTHS.length - 1 ? () => setLook((n) => Math.min(n + 1, FOLLOW_UP_DEPTHS.length - 1)) : null} /> : null}
      {nextUp.length > 0 ? <Band title="Next up" cards={nextUp} pinned={false} /> : null}
      <p className="flex flex-wrap gap-x-3 text-[13px] text-ink-muted">
        {data.total > shown ? <Ratio value={shown} of={data.total} label="items shown" /> : null}
        <span>Updated {formatTime(data.generatedAt)}</span>
      </p>
    </div>
    </ReachabilityBatch>
  );
}

const CONTACTING: ReadonlySet<string> = new Set(['text', 'email', 'call', 'send_draft', 'reply_chat']);

function Band({ title, cards, pinned }: { title: string; cards: FeedCard[]; pinned: boolean }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
        {title}
      </h2>
      <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {cards.map((c) => (
          <li key={c.id}>
            <AiFeedItem card={c} render={(card) => <FeedCardView card={card} pinned={pinned} />} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** What the group is, in one line under its heading. */
export const FOLLOW_UP_TODAY_WHAT = 'People you promised to get back to, and people you have talked with who have gone quiet.';
/** What the group says when nobody is due (R-TODAY-8): plain words, no tutorial. */
export const NOBODY_DUE = 'Nobody is due today. People you promise to follow up with will show here.';

type Plan = NonNullable<FeedResponse['followUpToday']>;

/** True when the plan's read looked at every candidate (R-TODAY-13). An older server says only whether the total is a lower bound. */
export function planComplete(plan: Plan): boolean {
  return plan.complete ?? !plan.totalIsMinimum;
}

/**
 * What an INCOMPLETE read may say (R-TODAY-13): how many people it checked, never "nobody is due". `more`: the screen
 * can still ask the server to look further.
 */
export function incompleteWords(plan: Plan, more: boolean): string {
  const found = plan.people.length > 0;
  if (plan.checked === undefined) return found ? 'More people may be due than are shown.' : 'Nobody is due among the people checked so far. There are more to check.';
  if (found) return `Checked ${plan.checked} of your people so far. More may be due.`;
  return more
    ? `Checked ${plan.checked} of your people so far, and nobody is due yet. There are more to check.`
    : `Checked ${plan.checked} of your people, and nobody is due yet. That is as far as Today looks; your People list has everyone.`;
}

/**
 * "Follow up today" (R-TODAY-6): the people the agent owns who are due by a promise or task today or earlier, or who
 * have gone quiet in "Connected" or "Long-term follow-up". A list of people with a reason each, most overdue first.
 * A row is drawn like a card and offers the same one-pass actions; it is not a stored card, so it has nothing to
 * snooze or dismiss: it leaves when the person is followed up with, or the task is done.
 *
 * R-TODAY-13: "Nobody is due today." is said only of a complete read that found nobody. A read that stopped at its
 * bound says how many people it checked and offers "Look further" (`onLookFurther`; null: it is at the deepest read).
 */
function FollowUpToday({ plan, onLookFurther, looking }: { plan: Plan; onLookFurther: (() => void) | null; looking: boolean }) {
  const id = useId();
  const complete = planComplete(plan);
  // a capped list says its count ("Showing 20 of at least 31"); looking further would not show more people
  const capped = plan.total > plan.people.length;
  return (
    <section aria-labelledby={id} aria-describedby={plan.people.length > 0 ? `${id}-what` : undefined} className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id={id} className="text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
          Follow up today
        </h2>
        {/* R-TODAY-8: what the group is, said where it is (no tour): the empty state says the same another way */}
        {plan.people.length > 0 ? (
          <p id={`${id}-what`} className="text-[14px] text-ink-muted">
            {FOLLOW_UP_TODAY_WHAT}
          </p>
        ) : null}
      </div>
      {plan.people.length === 0 ? (
        complete ? (
          <p className="rounded-xl border border-line bg-surface px-4 py-3 text-[15px] text-ink-muted">{NOBODY_DUE}</p>
        ) : null
      ) : (
        <ul className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {plan.people.map((p: FollowUpTodayCard) => (
            <li key={p.id}>
              <FeedCardView card={p} pinned={false} plan />
            </li>
          ))}
        </ul>
      )}
      {capped ? (
        <p className="text-[13px] text-ink-muted">
          Showing {plan.people.length} of {plan.totalIsMinimum ? 'at least ' : ''}
          {plan.total} people due
        </p>
      ) : !complete ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-line bg-surface px-4 py-2">
          <p role="status" className="min-w-0 flex-1 basis-56 text-[15px] text-ink [overflow-wrap:anywhere]">
            {incompleteWords(plan, onLookFurther !== null)}
          </p>
          {onLookFurther ? (
            <Button variant="secondary" pending={looking} onClick={onLookFurther}>
              Look further
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The live countdown of a pinned card. It ticks visibly every second; role="timer" is not a live
 * region, so screen-reader users hear it only at milestones (5, 2 and 1 minutes, 30 and 10 seconds,
 * and the end), politely, through the app's one announcer. `label` names what is counting down
 * ("Offer for Pat L.") so the announcement makes sense on its own.
 */
export function Countdown({ dueAt, kind, label }: { dueAt: string; kind: 'offer' | 'deadline'; label?: string }) {
  const now = useNow(1000);
  const due = Date.parse(dueAt);
  const left = formatCountdown(due, now);
  useCountdownAnnouncement(label ?? (kind === 'offer' ? 'Lead offer' : 'First contact'), due - now);
  if (left === null) {
    return (
      <span className="text-[15px] font-semibold text-danger">
        {kind === 'offer' ? 'Offer ended' : `Overdue · due ${relativeTime(due, now)}`}
      </span>
    );
  }
  return (
    <span role="timer" aria-label={countdownWords(due, now)} className={`text-[15px] font-semibold tabular-nums ${due - now < 60_000 ? 'text-danger' : 'text-warn'}`}>
      {left} left
    </span>
  );
}

/** What a pinned card's countdown is for, in words: "Offer for Pat L.", "Due now for Jane Doe". */
export function countdownLabel(card: Pick<FeedCard, 'itemType' | 'contact'>): string {
  const what = card.itemType === 'lead_offer' ? 'Offer' : itemLabel(card.itemType);
  return card.contact ? `${what} for ${card.contact.name}` : what;
}

export function FeedCardView({ card, pinned, plan = false }: { card: FeedCard; pinned: boolean; /** a row of the daily plan: not a stored card, so no Later or Dismiss */ plan?: boolean }) {
  const now = useNow(pinned ? 1000 : 60_000);
  const [why, setWhy] = useState(false);
  const whyId = useId();
  const isOffer = card.itemType === 'lead_offer';
  const expired = isOffer && card.dueAt !== null && Date.parse(card.dueAt) <= now;
  const lead = card.reasons[0];
  // a task or promise card is about the task: its title is said on the card (journey copy bug: a task card
  // named only the person and "Due today", never what to do)
  const taskTitle = card.task?.title.trim() ? card.task.title : null;
  const titleId = `${whyId}-title`;
  // R-TODAY-1: a follow-up card about a person says why they are due, what was last discussed and the next promise
  const follow = card.contact !== null && Array.isArray(card.why) && card.why.length > 0;
  // the Next line already says the card's own task when that task is the person's next promise
  const taskSaidBelow = follow && card.task != null && card.nextPromise?.taskId === card.task.id;
  // R-TODAY-7: a follow-up card's Call, Text and Log are one pass, here (the sheets of the person's page)
  const onePass = follow ? { cardTask: cardTaskOf(card), alsoDue: ((card as Partial<FollowUpTodayCard>).alsoDue ?? []).map((t) => t.title) } : undefined;
  // a card whose one tap IS its details shows them in the same panel, under its own name
  const detailsFirst = card.primaryAction.kind === 'show_details';
  const details = { open: why, controls: whyId, onOpen: () => setWhy((w) => !w) };
  return (
    <Card as="article" aria-labelledby={titleId} className={`flex flex-col gap-3 ${pinned ? 'border-accent/50' : ''}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {/* the kind of card and, on a follow-up card, the person's stage: two elements, so each reads (and is found) whole */}
          <div className="flex flex-wrap gap-x-1.5 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
            <p>{itemLabel(card.itemType)}</p>
            {follow && card.stage ? (
              <p className="[overflow-wrap:anywhere]">
                <span aria-hidden="true">· </span>
                <span data-testid="card-stage">{card.stage.label}</span>
              </p>
            ) : null}
          </div>
          {/* a name stays on one line; a card without a contact is headed by its first line, which wraps (it is the content) */}
          <h3 id={titleId} className={`text-[19px] font-semibold text-ink ${card.contact ? 'truncate' : 'break-words'}`}>
            {card.contact ? (
              <Link to={`/contacts/${card.contact.id}`} className="inline-flex min-h-tap items-center hover:underline">
                {card.contact.name}
              </Link>
            ) : (
              (taskTitle ?? lead?.label ?? itemLabel(card.itemType))
            )}
          </h3>
          {taskTitle !== null && card.contact && !taskSaidBelow ? <p className="break-words text-[16px] font-medium text-ink">{taskTitle}</p> : null}
          {!follow && lead && (card.contact || taskTitle !== null) && lead.label !== itemLabel(card.itemType) ? <p className="text-[15px] text-ink">{lead.label}</p> : null}
        </div>
        {pinned && card.dueAt ? <Countdown dueAt={card.dueAt} kind={isOffer ? 'offer' : 'deadline'} label={countdownLabel(card)} /> : null}
      </div>
      {expired ? <p className="text-[15px] text-ink-muted">This offer ended. The lead is going to the next agent.</p> : null}
      {follow ? <FollowUpLines card={card} now={now} /> : null}
      <div className="flex flex-wrap items-start gap-2">
        <ActionButton action={card.primaryAction} card={card} expired={expired} details={details} className="min-w-[8rem]" onePass={onePass} />
        {/* beside the primary action: "I already called from my phone" is as close as Call */}
        {follow && card.contact ? <LogButton contact={card.contact} onePass={onePass} /> : null}
        {inlineAlternatives(card).map((a, i) => (
          <ActionButton key={`${a.kind}:${i}`} action={a} card={card} variant="secondary" details={details} expired={expired && (a.kind === 'accept_offer' || a.kind === 'decline_offer')} onePass={onePass} />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-1">
        {detailsFirst ? null : (
          <button
            type="button"
            aria-expanded={why}
            aria-controls={whyId}
            onClick={() => setWhy((w) => !w)}
            className="inline-flex min-h-tap items-center rounded-lg px-1 text-[15px] font-medium text-accent"
          >
            {why ? 'Hide why' : 'Why this'}
          </button>
        )}
        {!pinned && !plan ? <LaterButtons card={card} /> : null}
      </div>
      {why ? (
        <ul id={whyId} className="flex flex-col gap-1 border-t border-line pt-2 text-[15px] text-ink" aria-label={detailsFirst ? 'Details' : 'Why this is in your feed'}>
          {card.reasons.map((r, i) => (
            <li key={`${r.code}:${i}`} className="flex gap-2">
              <span aria-hidden="true" className="text-ink-muted">
                ·
              </span>
              <span>{r.label}</span>
            </li>
          ))}
          {moreAlternatives(card).length > 0
            ? moreAlternatives(card).map((a, i) => (
                <li key={`more:${a.kind}:${i}`} className="pt-1">
                  <ActionButton action={a} card={card} variant="quiet" onePass={onePass} />
                </li>
              ))
            : null}
        </ul>
      ) : null}
    </Card>
  );
}

/**
 * Why the person is due, what was last discussed and the next promise (R-TODAY-1), each on its own labelled line.
 * An automated message is never the Last line: it is its own line under it (R-TODAY-2). The Due line of a quiet row
 * and the Last line are worded from one story (R-TODAY-14, lib/followUp.ts lastLine), so they cannot disagree. Everything wraps; nothing is
 * cut off (a team's own 24-character stage label, a 140-character snippet).
 */
export function FollowUpLines({ card, now }: { card: FeedCard; now: number }) {
  const line = 'flex gap-2';
  const term = 'w-11 shrink-0 text-[13px] font-semibold uppercase leading-[22px] tracking-wide text-ink-muted';
  const said = 'min-w-0 flex-1 [overflow-wrap:anywhere]';
  const last = lastLine(card, now);
  const named = (card as Partial<FollowUpTodayCard>).alsoDue ?? [];
  const more = (card as Partial<FollowUpTodayCard>).alsoDueMore ?? 0;
  const also = named.length > 0 ? `Also due: ${named.map((t) => t.title).join(', ')}${more > 0 ? ` and ${more} more` : ''}` : null;
  return (
    <dl data-testid="follow-up-lines" className="flex flex-col gap-1 text-[15px] leading-[22px] text-ink">
      <div className={line}>
        <dt className={term}>Due</dt>
        <dd className={said}>{card.why?.[0]}</dd>
      </div>
      {/* R-TODAY-15: the person's other due tasks, in one line under the reason the row leads with */}
      {also ? (
        <div className={line}>
          <dt className="sr-only">Also due</dt>
          <dd className={`${said} pl-[3.25rem]`}>{also}</dd>
        </div>
      ) : null}
      {/* R-TODAY-14: worded from the same story as the Due line; absent when the Due line already says there is none */}
      {last !== null ? (
        <div className={line}>
          <dt className={term}>Last</dt>
          <dd className={said}>{last}</dd>
        </div>
      ) : null}
      {card.lastAutomatic ? (
        <div className={line}>
          <dt className="sr-only">Also</dt>
          <dd className={`${said} pl-[3.25rem] text-ink-muted`}>{automaticLine(card.lastAutomatic, now)}</dd>
        </div>
      ) : null}
      <div className={line}>
        <dt className={term}>Next</dt>
        <dd className={`${said} ${card.nextPromise?.overdue ? 'font-medium text-danger' : ''}`}>{nextPromiseLine(card.nextPromise, now)}</dd>
      </div>
    </dl>
  );
}

/**
 * The task a follow-up card or row is ABOUT, for its one-pass sheets (R-TODAY-7, R-TODAY-11): the person's next task
 * when the card's own task is that very task (or, on a row of the plan, one of the row's due tasks). Whether a new
 * follow-up then replaces it is not decided here: the sheet asks core's rule (decideTaskReplacement), which closes only
 * a follow-up or callback whose deadline has passed, and says what it will do before the tap. Null: the card is about
 * no task of the person's, so the sheet closes nothing.
 */
export function cardTaskOf(card: FeedCard): CardTask | null {
  const next = card.nextPromise;
  if (!next) return null;
  const about = card.task?.id === next.taskId || ((card as Partial<FollowUpTodayCard>).taskIds ?? []).includes(next.taskId);
  return about ? { taskId: next.taskId, title: next.text, kind: next.kind, dueAt: next.dueAt, dueAllDay: next.dueAllDay, dueZone: next.dueZone ?? null, deadlineAt: next.deadlineAt ?? null } : null;
}

/** Alternatives shown as buttons: at most 3, without "Open" when the contact's name is already a link. */
export function inlineAlternatives(card: FeedCard): FeedCard['alternatives'] {
  return card.alternatives.filter((a) => !(a.kind === 'open_contact' && card.contact && a.contactId === card.contact.id)).slice(0, 3);
}

/** The rest, listed under "Why this". */
export function moreAlternatives(card: FeedCard): FeedCard['alternatives'] {
  const inline = new Set(inlineAlternatives(card));
  return card.alternatives.filter((a) => !inline.has(a) && !(a.kind === 'open_contact' && card.contact && a.contactId === card.contact.id));
}

/** "Later" (snooze 3 h) and "Dismiss" for scored cards; deadline cards close only by acting. */
function LaterButtons({ card }: { card: FeedCard }) {
  const { announce } = useAgentSheets();
  const m = useMutate<Record<string, unknown>>('POST', { invalidate: [FEED_KEY] });
  const later = async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const r = await m.run(`/feed/${card.id}/snooze`, { until });
    if (r.ok) announce('Snoozed for 3 hours.');
  };
  const dismiss = async () => {
    const r = await m.run(`/feed/${card.id}/dismiss`);
    if (r.ok) announce('Dismissed.');
  };
  return (
    <>
      <button type="button" disabled={m.pending} onClick={() => void later()} className="inline-flex min-h-tap items-center rounded-lg px-2 text-[15px] font-medium text-ink-muted">
        Later
      </button>
      <button type="button" disabled={m.pending} onClick={() => void dismiss()} className="inline-flex min-h-tap items-center rounded-lg px-2 text-[15px] font-medium text-ink-muted">
        Dismiss
      </button>
      {m.error ? (
        <span role="alert" className="text-[14px] text-danger">
          {m.error.message}
        </span>
      ) : null}
    </>
  );
}
