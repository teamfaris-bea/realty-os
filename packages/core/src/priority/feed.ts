// The Priority Feed (BUILD_PLAN module 5; ARCHITECTURE §1 "See what's due: 0 taps"; R-ACC-4 feed
// parts, R-AST-12, R-AST-15, R-IMPORT-6).
//
// scoreFeed is pure and deterministic: the same inputs in any order give the same items in the same
// order. Two bands:
//   pinned  ownership deadlines with a live countdown (lead offers, first-touch SLAs, re-inquiries
//           with an SLA, inactivity warnings), ordered by deadline;
//   scored  everything else, ordered by score (0..100, the sum of the reasons' points).
// Ties: deadline (earliest first, none last), score (highest first), createdAt, dedupeKey.
//
// Every item explains itself with ≥ 1 reason and offers one primary one-tap action. A blocked
// channel (gate summary) demotes an item and swaps its action to a channel that works (call or
// email instead of a blocked text); it never hides the item. Every send is still re-checked by
// canContact at send time; the summary here is only a hint.
//
// Only human touches answer a client or satisfy an SLA: assistant, system and imported messages
// never do (R-AST-15, R-IMPORT-6), and imported inbound history never creates an item.
import type { PhoneEmailChannel as Channel } from '../compliance/index.js'; // the feed's actions are Phase 1 channels
import { formatEvidence } from '../assistant/index.js';
import {
  type AssistantActionId,
  type ContactId,
  DAY_MS,
  HOUR_MS,
  type Instant,
  addLocalDays,
  instant,
  localTime,
  resolveLocal,
  startOfLocalDay,
  zoneOffsetMs,
} from '../foundation/index.js';
import { canonicalJson } from '../compliance/index.js';
import { CHANNEL_VERB, type LabelFormat, renderFeedLabel, templateLabels, textLabels } from './format.js';
import {
  apptOutcomeFeedKey,
  dealDateFeedKey,
  draftFeedKey,
  firstTouchFeedKey,
  handbackFeedKey,
  inactivityFeedKey,
  inboundFeedKey,
  offerFeedKey,
  pondFeedKey,
  reinquiryFeedKey,
  searchFeedKey,
  taskFeedKey,
} from './keys.js';
import { type FeedReasonCode, SCORE_VERSION, reason, scoreOf } from './reasons.js';
import type {
  ApptFacts,
  DealDateFacts,
  DraftFacts,
  FeedInputs,
  FeedItem,
  FeedReason,
  GateSummary,
  InboundFacts,
  OneTapAction,
  TaskFacts,
  TouchFacts,
} from './types.js';

export { SCORE_VERSION };

/** Open tasks and promises appear this long before their deadline. */
export const TASK_LOOKAHEAD_MS = 24 * HOUR_MS;
/** Contract dates appear this long before their day starts. */
export const DEAL_DATE_LOOKAHEAD_MS = 2 * DAY_MS;
/** Pond leads appear while they are this new. */
export const POND_NEW_WINDOW_MS = DAY_MS;
/** The missing-outcome feed item gains urgency after this (matches the exception, R-ACC-2). */
export const OUTCOME_LATE_MS = 2 * HOUR_MS;

// ---- touches (R-OWN-14, R-AST-15, R-IMPORT-6) ----------------------------------------------------

/**
 * A scoreboard / SLA touch: a gate-allowed human outbound call, text or email. Assistant, system and
 * imported messages never count; neither does an answered inbound call (touches are outbound).
 */
export function isHumanTouch(t: TouchFacts): boolean {
  return t.direction === 'outbound' && t.initiator === 'human' && !t.imported && t.gateAllowed;
}

/** Whether `t` answers a client who wrote or called at `since`: a human touch or a picked-up call. */
export function answersClient(t: TouchFacts, since: Instant): boolean {
  if (t.at <= since || t.initiator !== 'human' || t.imported) return false;
  return t.direction === 'inbound_answered' ? t.kind === 'call' : t.gateAllowed;
}

// ---- actions --------------------------------------------------------------------------------------

const BLOCK_CODE: Record<Channel, FeedReasonCode> = { sms: 'TEXT_BLOCKED', voice: 'CALL_BLOCKED', email: 'EMAIL_BLOCKED' };

function isBlocked(g: GateSummary | undefined, ch: Channel | 'web_chat'): boolean {
  return g?.[ch] !== undefined;
}

function channelAction(ch: Channel, contactId: ContactId, draft?: { channel: 'sms' | 'email'; actionId: AssistantActionId }): OneTapAction {
  switch (ch) {
    case 'voice':
      return { kind: 'call', label: 'Call', contactId };
    case 'sms':
      return draft?.channel === 'sms' ? { kind: 'text', label: 'Text', contactId, draftActionId: draft.actionId } : { kind: 'text', label: 'Text', contactId };
    case 'email':
      return draft?.channel === 'email' ? { kind: 'email', label: 'Email', contactId, draftActionId: draft.actionId } : { kind: 'email', label: 'Email', contactId };
  }
}

interface ContactPlan {
  /** Usable channel actions in preference order; empty when every channel is blocked. */
  usable: OneTapAction[];
  open: OneTapAction;
  /** Demotion reasons (none when the preferred channel works). */
  demotion: FeedReason[];
}

/**
 * Picks the channels an item can act on. `prefs` lists all three channels in preference order. A
 * blocked preferred channel demotes the item; when nothing works the card still shows, with the
 * contact as its action and the gate's explanations as the reason.
 */
function planContact(f: LabelFormat, contactId: ContactId, prefs: readonly Channel[], g: GateSummary | undefined, draft?: { channel: 'sms' | 'email'; actionId: AssistantActionId }): ContactPlan {
  const usable = prefs.filter((ch) => !isBlocked(g, ch)).map((ch) => channelAction(ch, contactId, draft));
  const open: OneTapAction = { kind: 'open_contact', label: 'Open', contactId };
  const first = prefs[0] as Channel;
  const demotion: FeedReason[] = [];
  if (usable.length === 0) {
    const why = [...new Set(prefs.map((ch) => g?.[ch]?.explanation).filter((s): s is string => s !== undefined && s.length > 0))];
    demotion.push(reason('CANT_CONTACT', why.length > 0 ? `Can't reach them right now: ${f.text(why.join(' · '), 200)}` : undefined));
  } else if (isBlocked(g, first)) {
    const why = g?.[first]?.explanation;
    demotion.push(reason(BLOCK_CODE[first], why ? `Can't ${CHANNEL_VERB[first]}: ${f.text(why, 160)}` : undefined));
  }
  return { usable, open, demotion };
}

/**
 * The client wrote last in the website chat (module 22): a Reply in the chat comes first, ahead of the other channels.
 * Such a lead often has no phone or email at all (the chat is its only identity), which is not "can't reach them":
 * the chat is how to answer, so the plan's demotion goes. Whether the chat is still open is the reachability
 * summary's to say on the button (the web disables it with the reason); the send-time check decides the rest. A chat
 * the gate summary blocks (the person asked not to be contacted, R-CHAN-2, or opted out of the chat) is no way to
 * answer: no Reply, and the plan keeps its demotion ("Can't reach them right now: …", review optouts/F1 of batch 6).
 */
function withChatReply(plan: ContactPlan, contactId: ContactId, chat: boolean, g: GateSummary | undefined): ContactPlan {
  if (!chat || isBlocked(g, 'web_chat')) return plan;
  return { usable: [{ kind: 'reply_chat', label: 'Reply', contactId }, ...plan.usable], open: plan.open, demotion: [] };
}

function contactCard(plan: ContactPlan, extra: OneTapAction[] = []): { primaryAction: OneTapAction; alternatives: OneTapAction[] } {
  const [primary, ...rest] = plan.usable;
  if (primary === undefined) return { primaryAction: plan.open, alternatives: extra };
  return { primaryAction: primary, alternatives: [...rest, ...extra, plan.open] };
}

const CALL_FIRST: readonly Channel[] = ['voice', 'sms', 'email'];
const TEXT_FIRST: readonly Channel[] = ['sms', 'voice', 'email'];
const EMAIL_FIRST: readonly Channel[] = ['email', 'voice', 'sms'];

function prefsFor(ch: InboundFacts['channel'] | null): readonly Channel[] {
  if (ch === 'email') return EMAIL_FIRST;
  if (ch === 'voice') return CALL_FIRST;
  if (ch === 'sms' || ch === 'mms') return TEXT_FIRST;
  return CALL_FIRST;
}

// ---- building blocks ------------------------------------------------------------------------------

type Draft = Omit<FeedItem, 'score' | 'scoreVersion'>;

function finish(d: Draft): FeedItem {
  return { ...d, score: scoreOf(d.reasons), scoreVersion: SCORE_VERSION };
}

function waitingReasons(now: Instant, since: Instant): FeedReason[] {
  const waited = now - since;
  if (waited > 4 * HOUR_MS) return [reason('WAITING_OVER_4H')];
  if (waited > HOUR_MS) return [reason('WAITING_OVER_1H')];
  return [];
}

function dueReasons(f: LabelFormat, now: Instant, deadline: Instant, promise: boolean): FeedReason[] {
  const [overdue, due, prefix]: [FeedReasonCode, FeedReasonCode, string] = promise ? ['PROMISE_OVERDUE', 'PROMISE_DUE', 'You promised this; '] : ['TASK_OVERDUE', 'TASK_DUE', ''];
  if (now >= deadline) {
    const late = f.since(deadline);
    const out = [reason(overdue, promise ? `${prefix}${late} overdue` : `Overdue by ${late}`)];
    if (now - deadline > DAY_MS) out.push(reason('OVERDUE_OVER_DAY'));
    return out;
  }
  const out = [reason(due, promise ? `${prefix}due ${f.in(deadline)}` : `Due ${f.in(deadline)}`)];
  if (deadline - now <= HOUR_MS) out.push(reason('DUE_WITHIN_HOUR'));
  return out;
}

/** The deadline of a task: its due instant, or the end of its local due day when all-day. */
export function taskDeadline(t: Pick<TaskFacts, 'dueAt' | 'dueAllDay' | 'dueTz'>): Instant | null {
  if (t.dueAt === null) return null;
  if (!t.dueAllDay) return t.dueAt;
  return t.dueTz === null ? instant(t.dueAt + DAY_MS) : addLocalDays(startOfLocalDay(t.dueAt, t.dueTz), 1, t.dueTz);
}

const MIDNIGHT = localTime('00:00');

/**
 * [start, end) of a deal date's calendar day in its zone. Fast path: when the zone's offset is the
 * same a day before and two days after local midnight (no DST change near the day), the window is
 * plain arithmetic; otherwise the exact DST-aware resolution is used.
 */
export function dealDateWindow(d: Pick<DealDateFacts, 'dueOn' | 'zone'>): { start: Instant; end: Instant } {
  const wall = Date.parse(`${d.dueOn}T00:00:00Z`);
  const o = zoneOffsetMs(d.zone, wall);
  if (zoneOffsetMs(d.zone, wall - o - DAY_MS) === o && zoneOffsetMs(d.zone, wall - o + 2 * DAY_MS) === o) {
    return { start: instant(wall - o), end: instant(wall - o + DAY_MS) };
  }
  const start = resolveLocal(d.dueOn, MIDNIGHT, d.zone, 'earlier');
  return { start, end: addLocalDays(start, 1, d.zone) };
}

const DEAL_DATE_NAME: Record<Exclude<DealDateFacts['kind'], 'custom'>, string> = {
  acceptance: 'Acceptance',
  inspection: 'Inspection',
  appraisal: 'Appraisal',
  financing: 'Financing',
  closing: 'Closing',
  possession: 'Possession',
};

const APPT_NAME: Record<ApptFacts['kind'], string> = {
  buyer_consult: 'Buyer consult',
  listing_appointment: 'Listing appointment',
  consult: 'Consult',
  other: 'Appointment',
};

/** Appointments still waiting for an outcome (R-ACC-2 missing_outcome uses the same test). */
export function awaitsOutcome(a: ApptFacts): boolean {
  return (a.status === 'scheduled' || a.status === 'held') && a.outcomeLoggedAt === null && a.createdByKind !== 'import';
}

// ---- the scorer ----------------------------------------------------------------------------------

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The feed order: pinned (deadline) then scored (score); ties deadline, score, createdAt, dedupeKey. */
export function compareFeedItems(a: FeedItem, b: FeedItem): number {
  if (a.band !== b.band) return a.band === 'pinned' ? -1 : 1;
  const byDue = (): number => {
    if (a.dueAt === b.dueAt) return 0;
    if (a.dueAt === null) return 1;
    if (b.dueAt === null) return -1;
    return a.dueAt - b.dueAt;
  };
  const byScore = b.score - a.score;
  const primary = a.band === 'pinned' ? byDue() || byScore : byScore || byDue();
  return primary || a.createdAt - b.createdAt || compareStr(a.dedupeKey, b.dedupeKey);
}

export interface ScoreFeedOptions {
  /**
   * 'text' (default): labels carry relative times as words ("They texted 3 h ago"). 'template': every relative
   * time is a token that renderFeedItem(item, at) turns into the same words for the instant `at`. The
   * incremental feed (lane perf-misses) stores templated cards and renders them when read, so a stored
   * card's wording is exactly what scoreFeed would say at read time (renderFeedItem(scoreFeed(i,
   * template), i.now) deep-equals scoreFeed(i); proved in incremental.test.ts).
   */
  labels?: 'text' | 'template';
}

/** Scores and orders the Priority Feed for `i.userId`. Pure; see the file header for the rules. */
export function scoreFeed(i: FeedInputs, opts: ScoreFeedOptions = {}): FeedItem[] {
  const { now, userId } = i;
  const f: LabelFormat = opts.labels === 'template' ? templateLabels : textLabels(now);
  const gateOf = (c: ContactId): GateSummary | undefined => i.blockedChannels.get(c);
  const out: Draft[] = [];

  // -- lead offers (pinned) ------------------------------------------------------------------------
  for (const o of i.offers) {
    if (o.offeredToUserId !== userId || o.expiresAt <= now) continue;
    const reasons = [reason('LEAD_OFFER'), reason('OFFER_ENDS', `Offer ends ${f.in(o.expiresAt)}`)];
    if (o.sourceName) reasons.push(reason('LEAD_SOURCE', `From ${f.text(o.sourceName, 60)}`));
    out.push({
      itemType: 'lead_offer',
      band: 'pinned',
      reasons,
      dueAt: o.expiresAt,
      dedupeKey: offerFeedKey(o.contactId, o.offerId),
      primaryAction: { kind: 'accept_offer', label: 'Accept', contactId: o.contactId, offerId: o.offerId },
      alternatives: [{ kind: 'decline_offer', label: 'Pass', contactId: o.contactId, offerId: o.offerId }],
      contactId: o.contactId,
      subjectType: 'contact',
      subjectId: o.contactId,
      assistantActionId: null,
      createdAt: o.offeredAt,
    });
  }

  // the contacts whose latest message waiting on this agent is in the website chat (a reply goes there first)
  const latestWaiting = new Map<ContactId, InboundFacts>();
  for (const m of i.unansweredInbound) {
    if (m.ownerUserId !== userId || m.imported || m.isAutoReply === true || m.isKeyword === true || m.laterTouches.some((t) => answersClient(t, m.at))) continue;
    const prev = latestWaiting.get(m.contactId);
    if (prev === undefined || m.at > prev.at || (m.at === prev.at && compareStr(m.id, prev.id) > 0)) latestWaiting.set(m.contactId, m);
  }
  const chatLatest = (c: ContactId) => latestWaiting.get(c)?.channel === 'web_chat';

  // -- first-touch SLAs (pinned) -------------------------------------------------------------------
  const firstTouchContacts = new Map<ContactId, Draft>();
  for (const s of i.slas) {
    if (s.ownerUserId !== userId || s.periodEndedAt !== null || s.firstTouchAt !== null) continue;
    const overdue = now >= s.firstTouchDueAt;
    const reasons = [
      overdue
        ? reason('FIRST_TOUCH_OVERDUE', `First contact ${f.since(s.firstTouchDueAt)} overdue`)
        : reason('FIRST_TOUCH_DUE', `First contact due ${f.in(s.firstTouchDueAt)}`),
    ];
    if (s.releaseDueAt != null && s.releaseDueAt > now) reasons.push(reason('RELEASE_SOON', `Goes back to the pond ${f.in(s.releaseDueAt)} if not contacted`));
    const plan = withChatReply(planContact(f, s.contactId, CALL_FIRST, gateOf(s.contactId)), s.contactId, chatLatest(s.contactId), gateOf(s.contactId));
    const d: Draft = {
      itemType: 'first_touch_due',
      band: 'pinned',
      reasons: [...reasons, ...plan.demotion],
      dueAt: s.firstTouchDueAt,
      dedupeKey: firstTouchFeedKey(s.contactId, s.periodSeq),
      ...contactCard(plan),
      contactId: s.contactId,
      subjectType: 'contact',
      subjectId: s.contactId,
      assistantActionId: null,
      createdAt: s.ownedAt,
    };
    const prev = firstTouchContacts.get(s.contactId);
    if (prev === undefined || prev.dedupeKey < d.dedupeKey) firstTouchContacts.set(s.contactId, d);
    out.push(d);
  }

  // -- re-inquiries (pinned with an SLA, else scored); folded into an open first-touch card ---------
  const latestAsk = new Map<ContactId, Instant>();
  for (const r of i.reinquiries ?? []) {
    if (r.ownerUserId !== userId || r.touchedSince || !firstTouchContacts.has(r.contactId)) continue;
    latestAsk.set(r.contactId, Math.max(latestAsk.get(r.contactId) ?? r.at, r.at) as Instant);
  }
  for (const [contactId, at] of latestAsk) {
    const ft = firstTouchContacts.get(contactId) as Draft;
    ft.reasons.splice(1, 0, reason('ASKED_AGAIN', `Asked again ${f.ago(at)}`));
  }
  for (const r of i.reinquiries ?? []) {
    if (r.ownerUserId !== userId || r.touchedSince || firstTouchContacts.has(r.contactId)) continue;
    const plan = planContact(f, r.contactId, CALL_FIRST, gateOf(r.contactId));
    const reasons = [reason('REINQUIRY', `Asked again ${f.ago(r.at)}`)];
    if (r.dueAt !== null) {
      reasons.push(
        now >= r.dueAt
          ? reason('FIRST_TOUCH_OVERDUE', `Reply ${f.since(r.dueAt)} overdue`)
          : reason('FIRST_TOUCH_DUE', `Reply due ${f.in(r.dueAt)}`),
      );
    }
    out.push({
      itemType: 'reinquiry',
      band: r.dueAt === null ? 'scored' : 'pinned',
      reasons: [...reasons, ...plan.demotion],
      dueAt: r.dueAt,
      dedupeKey: reinquiryFeedKey(r.contactId, r.inquiryId),
      ...contactCard(plan),
      contactId: r.contactId,
      subjectType: 'contact',
      subjectId: r.contactId,
      assistantActionId: null,
      createdAt: r.at,
    });
  }

  // -- inactivity warnings (pinned) ----------------------------------------------------------------
  for (const w of i.inactivityWarnings ?? []) {
    if (w.ownerUserId !== userId || w.releaseAt <= now) continue;
    const plan = planContact(f, w.contactId, CALL_FIRST, gateOf(w.contactId));
    out.push({
      itemType: 'inactivity_warning',
      band: 'pinned',
      reasons: [reason('INACTIVITY_WARNING', `No contact in a while; goes back to the pond ${f.in(w.releaseAt)}`), ...plan.demotion],
      dueAt: w.releaseAt,
      dedupeKey: inactivityFeedKey(w.contactId, w.periodSeq, w.warnAt),
      ...contactCard(plan),
      contactId: w.contactId,
      subjectType: 'contact',
      subjectId: w.contactId,
      assistantActionId: null,
      createdAt: w.warnAt,
    });
  }

  // -- handbacks -----------------------------------------------------------------------------------
  const handbackContacts = new Set<ContactId>();
  const handbackDrafts = new Set<string>();
  for (const h of i.handbacks) {
    if (h.ownerUserId !== userId) continue;
    handbackContacts.add(h.contactId);
    const g = gateOf(h.contactId);
    const prefs = prefsFor(h.inboundChannel);
    // the reply goes where they wrote: a chat reply is judged by the chat, never by the texts (review ui-compose/F3)
    const replyCh: 'sms' | 'email' | 'web_chat' | null = h.inboundChannel === 'email' ? 'email' : h.inboundChannel === 'voice' ? null : h.inboundChannel === 'web_chat' ? 'web_chat' : 'sms';
    const reasons: FeedReason[] = [reason('HANDBACK'), ...waitingReasons(now, h.receivedAt)];
    const review: OneTapAction = { kind: 'review_handback', label: 'See what they said', actionId: h.actionId };
    let primaryAction: OneTapAction;
    let alternatives: OneTapAction[];
    const draftId = h.replyDraftActionId ?? null;
    if (draftId !== null) handbackDrafts.add(draftId);
    if (draftId !== null && replyCh !== null && !isBlocked(g, replyCh)) {
      primaryAction = { kind: 'send_draft', label: 'Send', actionId: draftId };
      const plan = planContact(f, h.contactId, prefs, g);
      alternatives = [{ kind: 'edit_draft', label: 'Edit', actionId: draftId }, ...plan.usable.filter((a) => a.kind === 'call'), review, plan.open];
    } else {
      const plan = withChatReply(planContact(f, h.contactId, prefs, g), h.contactId, replyCh === 'web_chat', g);
      reasons.push(...plan.demotion);
      const extra: OneTapAction[] = draftId !== null ? [{ kind: 'edit_draft', label: 'Edit draft', actionId: draftId }, review] : [review];
      ({ primaryAction, alternatives } = contactCard(plan, extra));
    }
    out.push({
      itemType: 'handback',
      band: 'scored',
      reasons,
      dueAt: null,
      dedupeKey: handbackFeedKey(h.actionId),
      primaryAction,
      alternatives,
      contactId: h.contactId,
      subjectType: 'assistant_action',
      subjectId: h.actionId,
      assistantActionId: h.actionId,
      createdAt: h.createdAt,
    });
  }

  // -- clients waiting: unanswered messages and missed calls, one card per contact --------------------
  const waiting = new Map<ContactId, InboundFacts[]>();
  for (const m of i.unansweredInbound) {
    if (m.ownerUserId !== userId || m.imported || m.isAutoReply === true || m.isKeyword === true) continue;
    if (m.laterTouches.some((t) => answersClient(t, m.at))) continue;
    const list = waiting.get(m.contactId);
    if (list === undefined) waiting.set(m.contactId, [m]);
    else list.push(m);
  }
  // A pending reply draft for a waiting client rides on that card's Text/Email action (Text → Send,
  // A1) instead of being a second card for the same conversation.
  // Older drafts for the same conversation are folded too (the newest one is the reply on offer).
  const draftFor = new Map<ContactId, DraftFacts>();
  const foldedDrafts = new Set<string>();
  for (const d of i.drafts) {
    if (d.ownerUserId !== userId || handbackDrafts.has(d.actionId) || !waiting.has(d.contactId) || handbackContacts.has(d.contactId)) continue;
    foldedDrafts.add(d.actionId);
    const prev = draftFor.get(d.contactId);
    if (prev === undefined || d.createdAt > prev.createdAt || (d.createdAt === prev.createdAt && d.actionId > prev.actionId)) draftFor.set(d.contactId, d);
  }
  for (const [contactId, msgs] of waiting) {
    if (handbackContacts.has(contactId)) continue; // the handback card already covers this conversation
    const replyDraft = draftFor.get(contactId);
    msgs.sort((a, b) => a.at - b.at || compareStr(a.id, b.id));
    const first = msgs[0] as InboundFacts;
    const latest = msgs[msgs.length - 1] as InboundFacts;
    const missed = latest.kind === 'missed_call';
    // the client wrote (never "Texted …", which reads as if the agent had texted): "They texted 20 min ago; no reply yet";
    // in the website chat: "They wrote in the website chat 1 min ago; no reply yet" (finding UXA-3)
    const wrote = latest.channel === 'email' ? 'emailed' : latest.channel === 'web_chat' ? 'wrote in the website chat' : 'texted';
    const what = missed ? `Missed call ${f.ago(latest.at)}` : `They ${wrote} ${f.ago(latest.at)}; no reply yet`;
    const reasons: FeedReason[] = [missed ? reason('MISSED_CALL', what) : reason('CLIENT_WAITING', what)];
    if (msgs.length > 1) reasons.push(reason('MORE_WAITING', `${msgs.length} messages or calls waiting`));
    reasons.push(...waitingReasons(now, first.at));
    // a chat reply the assistant drafted (R-INBOX-4) is the chat's: Reply opens the thread on web chat, which adopts it
    const chatDraft = replyDraft?.channel === 'web_chat';
    if (replyDraft !== undefined) {
      reasons.push(reason('REPLY_DRAFTED', replyDraft.channel === 'email' ? 'Reply email drafted for you' : chatDraft ? 'Chat reply drafted for you' : 'Reply text drafted for you'));
      if (replyDraft.needsReview) reasons.push(reason('CHECK_THIS', 'Check this: a detail needs your OK'));
    }
    const textDraft = replyDraft !== undefined && replyDraft.channel !== 'web_chat' ? { channel: replyDraft.channel, actionId: replyDraft.actionId } : undefined;
    const replyPrefs = textDraft !== undefined ? (textDraft.channel === 'email' ? EMAIL_FIRST : TEXT_FIRST) : prefsFor(missed ? 'voice' : latest.channel);
    const plan = withChatReply(planContact(f, contactId, replyPrefs, gateOf(contactId), textDraft), contactId, !missed && (chatDraft || (replyDraft === undefined && latest.channel === 'web_chat')), gateOf(contactId));
    reasons.push(...plan.demotion);
    out.push({
      itemType: missed ? 'missed_call' : 'unanswered_inbound',
      band: 'scored',
      reasons,
      dueAt: null,
      dedupeKey: inboundFeedKey(contactId, latest.id),
      ...contactCard(plan),
      contactId,
      subjectType: missed ? 'call' : 'message',
      subjectId: latest.id,
      assistantActionId: replyDraft?.actionId ?? null,
      createdAt: first.at,
    });
  }

  // -- assistant drafts ----------------------------------------------------------------------------
  for (const d of i.drafts) {
    if (d.ownerUserId !== userId || handbackDrafts.has(d.actionId) || foldedDrafts.has(d.actionId)) continue;
    const g = gateOf(d.contactId);
    const reasons: FeedReason[] = [
      reason('DRAFT_READY', d.channel === 'email' ? 'Email drafted for you' : d.channel === 'web_chat' ? 'Chat reply drafted for you' : 'Text drafted for you'),
      reason('ASSISTANT_NOTE', f.text(d.explanation, 140)),
    ];
    if (d.needsReview) reasons.push(reason('CHECK_THIS', 'Check this: a detail needs your OK'));
    const edit: OneTapAction = { kind: 'edit_draft', label: d.needsReview ? 'Review' : 'Edit', actionId: d.actionId };
    let primaryAction: OneTapAction;
    let alternatives: OneTapAction[];
    if (!isBlocked(g, d.channel)) {
      const send: OneTapAction = { kind: 'send_draft', label: 'Send', actionId: d.actionId };
      // A draft with a detail to check opens for review first: needs-review claims are never sent unchecked (R-AST-5).
      primaryAction = d.needsReview ? edit : send;
      alternatives = d.needsReview ? [{ kind: 'open_contact', label: 'Open', contactId: d.contactId }] : [edit, { kind: 'open_contact', label: 'Open', contactId: d.contactId }];
    } else {
      // a blocked chat (the person asked not to be contacted, or opted out of the chat) is no way to send it
      const plan = planContact(f, d.contactId, d.channel === 'email' ? EMAIL_FIRST : d.channel === 'web_chat' ? CALL_FIRST : TEXT_FIRST, g);
      reasons.push(...plan.demotion);
      ({ primaryAction, alternatives } = contactCard(plan, [edit]));
    }
    out.push({
      itemType: 'assistant_draft',
      band: 'scored',
      reasons,
      dueAt: null,
      dedupeKey: draftFeedKey(d.actionId),
      primaryAction,
      alternatives,
      contactId: d.contactId,
      subjectType: 'assistant_action',
      subjectId: d.actionId,
      assistantActionId: d.actionId,
      createdAt: d.createdAt,
    });
  }

  // -- tasks and promises --------------------------------------------------------------------------
  for (const t of i.tasks) {
    if (t.assigneeUserId !== userId || t.status !== 'open') continue;
    const promise = t.kind === 'promise';
    const deadline = taskDeadline(t);
    let reasons: FeedReason[];
    if (deadline === null) {
      // R-AST-5: an unpinned promise date waits for the agent; other undated tasks live in Tasks.
      if (!(promise && t.needsReview)) continue;
      reasons = [reason('PROMISE_NEEDS_DATE')];
    } else {
      if (deadline - now > TASK_LOOKAHEAD_MS) continue;
      reasons = dueReasons(f, now, deadline, promise);
    }
    const ev = promise ? t.evidence?.[0] : undefined;
    if (ev !== undefined) reasons.push(reason('PROMISE_SOURCE', f.text(formatEvidence(ev), 200)));
    const done: OneTapAction = deadline === null ? { kind: 'open_task', label: 'Set the date', taskId: t.taskId } : { kind: 'complete_task', label: 'Done', taskId: t.taskId };
    let card: { primaryAction: OneTapAction; alternatives: OneTapAction[] };
    if (t.contactId !== null) {
      const plan = planContact(f, t.contactId, t.kind === 'document' ? EMAIL_FIRST : CALL_FIRST, gateOf(t.contactId));
      if (deadline === null) card = { primaryAction: done, alternatives: [...plan.usable, plan.open] };
      else {
        reasons.push(...plan.demotion);
        card = contactCard(plan, [done]);
      }
    } else {
      card = { primaryAction: done, alternatives: t.dealId !== null ? [{ kind: 'open_deal', label: 'Open deal', dealId: t.dealId }] : [] };
    }
    out.push({
      itemType: promise ? 'promise_due' : 'task_due',
      band: 'scored',
      reasons,
      dueAt: deadline,
      dedupeKey: taskFeedKey(t.taskId),
      ...card,
      contactId: t.contactId,
      subjectType: 'task',
      subjectId: t.taskId,
      assistantActionId: null,
      createdAt: t.createdAt,
    });
  }

  // -- contract dates ------------------------------------------------------------------------------
  // Zone math is the costly part, so far-future dates are dropped on a UTC bound first (local
  // midnight is never earlier than UTC midnight − 14 h) and windows are memoized per (zone, day).
  const windows = new Map<string, { start: Instant; end: Instant }>();
  for (const d of i.dealDates) {
    if (d.completedAt !== null || !d.userIds.includes(userId)) continue;
    if (Date.parse(`${d.dueOn}T00:00:00Z`) - 14 * HOUR_MS - now > DEAL_DATE_LOOKAHEAD_MS) continue;
    const wk = `${d.zone}|${d.dueOn}`;
    let w = windows.get(wk);
    if (w === undefined) {
      w = dealDateWindow(d);
      windows.set(wk, w);
    }
    const { start, end } = w;
    if (start - now > DEAL_DATE_LOOKAHEAD_MS) continue;
    const name = d.kind === 'custom' ? f.text(d.label ?? 'Contract', 60) : DEAL_DATE_NAME[d.kind];
    const r =
      now >= end
        ? reason('DEAL_DATE_PASSED', `${name} date passed ${f.ago(end)}`)
        : now >= start
          ? reason('DEAL_DATE_TODAY', `${name} date is today`)
          : reason('DEAL_DATE_SOON', `${name} date ${f.in(start)}`);
    const reasons = [r];
    if (now - end > DAY_MS) reasons.push(reason('OVERDUE_OVER_DAY'));
    out.push({
      itemType: 'deal_date',
      band: 'scored',
      reasons,
      dueAt: end,
      dedupeKey: dealDateFeedKey(d.dealDateId),
      primaryAction: { kind: 'open_deal', label: 'Open deal', dealId: d.dealId },
      alternatives: [{ kind: 'complete_deal_date', label: 'Mark done', dealDateId: d.dealDateId }],
      contactId: null,
      subjectType: 'deal_date',
      subjectId: d.dealDateId,
      assistantActionId: null,
      createdAt: d.createdAt,
    });
  }

  // -- appointment outcomes ------------------------------------------------------------------------
  for (const a of i.appointments) {
    if (a.userId !== userId || !awaitsOutcome(a) || a.endsAt > now) continue;
    const reasons = [reason('OUTCOME_MISSING', `${APPT_NAME[a.kind]} ended ${f.ago(a.endsAt)}; log how it went`)];
    if (now - a.endsAt > OUTCOME_LATE_MS) reasons.push(reason('OUTCOME_OVER_2H'));
    out.push({
      itemType: 'appointment_outcome',
      band: 'scored',
      reasons,
      dueAt: instant(a.endsAt + OUTCOME_LATE_MS),
      dedupeKey: apptOutcomeFeedKey(a.appointmentId),
      primaryAction: { kind: 'log_outcome', label: 'Log outcome', appointmentId: a.appointmentId },
      alternatives: a.contactId !== null ? [{ kind: 'open_contact', label: 'Open', contactId: a.contactId }] : [],
      contactId: a.contactId,
      subjectType: 'appointment',
      subjectId: a.appointmentId,
      assistantActionId: null,
      createdAt: a.endsAt,
    });
  }

  // -- pond leads ----------------------------------------------------------------------------------
  for (const p of i.pondLeads ?? []) {
    if (!p.userIds.includes(userId) || now - p.enteredAt > POND_NEW_WINDOW_MS) continue;
    out.push({
      itemType: 'pond_new',
      band: 'scored',
      reasons: [reason('POND_NEW', `New in the pond ${f.ago(p.enteredAt)}; first to claim gets it`)],
      dueAt: null,
      dedupeKey: pondFeedKey(p.contactId, p.enteredSeq),
      primaryAction: { kind: 'claim', label: 'Claim', contactId: p.contactId, pondId: p.pondId },
      alternatives: [],
      contactId: p.contactId,
      subjectType: 'contact',
      subjectId: p.contactId,
      assistantActionId: null,
      createdAt: p.enteredAt,
    });
  }

  // -- saved-search proposals ----------------------------------------------------------------------
  for (const s of i.searchProposals ?? []) {
    if (s.ownerUserId !== userId) continue;
    const reasons = [reason('SEARCH_PROPOSED')];
    if (s.uncheckedCount > 0) reasons.push(reason('CRITERIA_UNCHECKED', `${s.uncheckedCount} ${s.uncheckedCount === 1 ? 'criterion needs' : 'criteria need'} your check`));
    out.push({
      itemType: 'saved_search_review',
      band: 'scored',
      reasons,
      dueAt: null,
      dedupeKey: searchFeedKey(s.savedSearchId),
      primaryAction: { kind: 'review_search', label: 'Review', savedSearchId: s.savedSearchId },
      alternatives: [{ kind: 'open_contact', label: 'Open', contactId: s.contactId }],
      contactId: s.contactId,
      subjectType: 'saved_search',
      subjectId: s.savedSearchId,
      assistantActionId: null,
      createdAt: s.createdAt,
    });
  }

  const canon = opts.labels === 'template' ? (it: FeedItem) => canonicalJson(renderFeedItem(it, now)) : (it: FeedItem) => canonicalJson(it);
  return dedupeAndSort(out.map(finish), canon);
}

/** One item per dedupe key (the best by feed order; full ties by canonical content), then sorted. */
function dedupeAndSort(items: FeedItem[], canon: (it: FeedItem) => string): FeedItem[] {
  const best = new Map<string, FeedItem>();
  for (const it of items) {
    const prev = best.get(it.dedupeKey);
    if (prev === undefined) {
      best.set(it.dedupeKey, it);
      continue;
    }
    const c = compareFeedItems(it, prev);
    if (c < 0 || (c === 0 && canon(it) < canon(prev))) best.set(it.dedupeKey, it);
  }
  return [...best.values()].sort(compareFeedItems);
}

/** Feed items for one user, split by band (the GET /feed response shape). */
export function splitBands(items: readonly FeedItem[]): { pinned: FeedItem[]; scored: FeedItem[] } {
  return { pinned: items.filter((x) => x.band === 'pinned'), scored: items.filter((x) => x.band === 'scored') };
}


/** A templated item (scoreFeed labels: 'template') with its relative times rendered for `at`. */
export function renderFeedItem(item: FeedItem, at: Instant): FeedItem {
  return { ...item, reasons: item.reasons.map((r) => ({ ...r, label: renderFeedLabel(r.label, at) })) };
}
