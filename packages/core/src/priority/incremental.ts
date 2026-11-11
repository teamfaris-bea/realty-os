// The incremental Priority Feed's pure parts (lane perf-misses; docs/PERFORMANCE.md "Priority Feed").
//
// The API materializes the feed instead of recomputing a whole book on every GET. Three facts about
// scoreFeed make that exact, and each is proved by a property test in incremental.test.ts:
//
// 1. Groups are independent. Every input belongs to one group: its contact (`c:<contact>`), or, for an
//    input with no contact, its own subject (`t:<task>`, `a:<appointment>`, `d:<deal date>`). scoreFeed
//    never lets one group's inputs change another group's cards (the folds, the one-card-per-conversation
//    rule and the gate hints are all per contact), so
//        scoreFeed(i) == sort(⋃ over groups g of scoreFeed(i restricted to g)).
//    A write therefore needs only its groups re-scored.
// 2. Wording is the only thing that changes continuously with time. Which cards exist, their band, score,
//    due instant and actions change only at instants nextFeedChange() names; between two such instants
//    only relative-time wording moves ("3 h ago"), and scoreFeed(i, { labels: 'template' }) stores that
//    wording as tokens rendered at read time (renderFeedItem).
// 3. nextFeedChange(i) is the first instant after i.now at which scoreFeed's structure can differ from its
//    structure at i.now (conservative: it may name an instant where nothing changes, never a late one).
import { DAY_MS, HOUR_MS, type Instant } from '../foundation/index.js';
import { DEAL_DATE_LOOKAHEAD_MS, OUTCOME_LATE_MS, POND_NEW_WINDOW_MS, TASK_LOOKAHEAD_MS, dealDateWindow, taskDeadline } from './feed.js';
import type { FeedInputs, FeedItem } from './types.js';

/** The group of a card: its contact, or its own subject when it has no contact. */
export function feedGroupOfItem(item: Pick<FeedItem, 'contactId' | 'subjectType' | 'subjectId'>): string {
  if (item.contactId !== null) return `c:${item.contactId}`;
  switch (item.subjectType) {
    case 'task':
      return `t:${item.subjectId}`;
    case 'appointment':
      return `a:${item.subjectId}`;
    case 'deal_date':
      return `d:${item.subjectId}`;
    default:
      return `x:${item.subjectType}:${item.subjectId}`;
  }
}

export const contactGroup = (contactId: string): string => `c:${contactId}`;
export const taskGroup = (taskId: string): string => `t:${taskId}`;
export const appointmentGroup = (appointmentId: string): string => `a:${appointmentId}`;
export const dealDateGroup = (dealDateId: string): string => `d:${dealDateId}`;

/** The inputs of one group (the same `now` and `userId`; empty lists elsewhere). */
function emptyLike(i: FeedInputs): FeedInputs {
  return {
    now: i.now,
    userId: i.userId,
    offers: [],
    slas: [],
    unansweredInbound: [],
    handbacks: [],
    drafts: [],
    tasks: [],
    dealDates: [],
    appointments: [],
    blockedChannels: new Map(),
    reinquiries: [],
    inactivityWarnings: [],
    pondLeads: [],
    searchProposals: [],
  };
}

/** Splits feed inputs by group (fact 1 above). Every input lands in exactly one group. */
export function splitFeedInputs(i: FeedInputs): Map<string, FeedInputs> {
  const out = new Map<string, FeedInputs>();
  const of = (g: string): FeedInputs => {
    let x = out.get(g);
    if (x === undefined) {
      x = emptyLike(i);
      out.set(g, x);
    }
    return x;
  };
  for (const o of i.offers) of(contactGroup(o.contactId)).offers.push(o);
  for (const s of i.slas) of(contactGroup(s.contactId)).slas.push(s);
  for (const m of i.unansweredInbound) of(contactGroup(m.contactId)).unansweredInbound.push(m);
  for (const h of i.handbacks) of(contactGroup(h.contactId)).handbacks.push(h);
  for (const d of i.drafts) of(contactGroup(d.contactId)).drafts.push(d);
  for (const t of i.tasks) of(t.contactId !== null ? contactGroup(t.contactId) : taskGroup(t.taskId)).tasks.push(t);
  for (const d of i.dealDates) of(dealDateGroup(d.dealDateId)).dealDates.push(d);
  for (const a of i.appointments) of(a.contactId !== null ? contactGroup(a.contactId) : appointmentGroup(a.appointmentId)).appointments.push(a);
  for (const r of i.reinquiries ?? []) of(contactGroup(r.contactId)).reinquiries!.push(r);
  for (const w of i.inactivityWarnings ?? []) of(contactGroup(w.contactId)).inactivityWarnings!.push(w);
  for (const p of i.pondLeads ?? []) of(contactGroup(p.contactId)).pondLeads!.push(p);
  for (const s of i.searchProposals ?? []) of(contactGroup(s.contactId)).searchProposals!.push(s);
  for (const [g, x] of out) {
    if (!g.startsWith('c:')) continue;
    const gate = i.blockedChannels.get(g.slice(2) as never);
    if (gate !== undefined) x.blockedChannels.set(g.slice(2) as never, gate);
  }
  return out;
}

/**
 * The first instant after `i.now` at which scoreFeed(i at that instant) can differ from scoreFeed(i) in
 * anything but relative-time wording, or null when only a write can change it. Every time comparison in
 * scoreFeed has its instant here (`x <= now`, `now >= x` change at x; `now - x > d` at x + d + 1 ms).
 */
export function nextFeedChange(i: FeedInputs): Instant | null {
  const now = i.now;
  let best = Infinity;
  const at = (t: number | null | undefined) => {
    if (t !== null && t !== undefined && Number.isFinite(t) && t > now && t < best) best = t;
  };
  for (const o of i.offers) at(o.expiresAt);
  for (const s of i.slas) {
    at(s.firstTouchDueAt);
    at(s.releaseDueAt);
  }
  for (const r of i.reinquiries ?? []) at(r.dueAt);
  for (const w of i.inactivityWarnings ?? []) at(w.releaseAt);
  for (const h of i.handbacks) {
    at(h.receivedAt + HOUR_MS + 1);
    at(h.receivedAt + 4 * HOUR_MS + 1);
  }
  for (const m of i.unansweredInbound) {
    at(m.at + HOUR_MS + 1);
    at(m.at + 4 * HOUR_MS + 1);
  }
  for (const t of i.tasks) {
    const d = taskDeadline(t);
    if (d === null) continue;
    at(d - TASK_LOOKAHEAD_MS);
    at(d - HOUR_MS);
    at(d);
    at(d + DAY_MS + 1);
  }
  for (const d of i.dealDates) {
    at(Date.parse(`${d.dueOn}T00:00:00Z`) - 14 * HOUR_MS - DEAL_DATE_LOOKAHEAD_MS);
    const w = dealDateWindow(d);
    at(w.start - DEAL_DATE_LOOKAHEAD_MS);
    at(w.start);
    at(w.end);
    at(w.end + DAY_MS + 1);
  }
  for (const a of i.appointments) {
    at(a.endsAt);
    at(a.endsAt + OUTCOME_LATE_MS + 1);
  }
  for (const p of i.pondLeads ?? []) at(p.enteredAt + POND_NEW_WINDOW_MS + 1);
  return best === Infinity ? null : (best as Instant);
}
