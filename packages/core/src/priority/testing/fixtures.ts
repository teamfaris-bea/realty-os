// Test fixtures for core/priority (used only by *.test.ts; excluded from coverage).
import {
  type AppointmentId,
  type AssistantActionId,
  type CallId,
  type ContactId,
  type DealDateId,
  type DealId,
  type Instant,
  type LeadInquiryId,
  type MessageId,
  type PondId,
  type SavedSearchId,
  type TaskId,
  type UserId,
  HOUR_MS,
  MINUTE_MS,
  at,
  instant,
  localDate,
  zone,
} from '../../foundation/index.js';
import type {
  ApptFacts,
  DealDateFacts,
  DraftFacts,
  ExceptionInputs,
  FeedInputs,
  GateSummary,
  HandbackFacts,
  InactivityFacts,
  InboundFacts,
  MilestoneDateFacts,
  OfferFacts,
  OutboundStatusFacts,
  PondLeadFacts,
  ReinquiryFacts,
  SearchProposalFacts,
  SlaFacts,
  TaskFacts,
  TouchFacts,
} from '../types.js';

export const NOW: Instant = at('2026-11-10T15:00:00Z'); // 10:00 AM in New York
export const NY = zone('America/New_York');

const hex = (n: number) => n.toString(16).padStart(12, '0');
export const user = (n: number) => `a0000000-0000-7000-8000-${hex(n)}` as UserId;
export const contact = (n: number) => `c0000000-0000-7000-8000-${hex(n)}` as ContactId;
export const msg = (n: number) => `d0000000-0000-7000-8000-${hex(n)}` as MessageId;
export const call = (n: number) => `d1000000-0000-7000-8000-${hex(n)}` as CallId;
export const action = (n: number) => `e0000000-0000-7000-8000-${hex(n)}` as AssistantActionId;
export const task = (n: number) => `f0000000-0000-7000-8000-${hex(n)}` as TaskId;
export const appt = (n: number) => `f1000000-0000-7000-8000-${hex(n)}` as AppointmentId;
export const deal = (n: number) => `f2000000-0000-7000-8000-${hex(n)}` as DealId;
export const dealDate = (n: number) => `f3000000-0000-7000-8000-${hex(n)}` as DealDateId;
export const pond = (n: number) => `f4000000-0000-7000-8000-${hex(n)}` as PondId;
export const search = (n: number) => `f5000000-0000-7000-8000-${hex(n)}` as SavedSearchId;
export const inquiry = (n: number) => `f6000000-0000-7000-8000-${hex(n)}` as LeadInquiryId;

export const ME = user(10);
export const OTHER = user(11);

export const min = (n: number) => n * MINUTE_MS;
export const hours = (n: number) => n * HOUR_MS;
export const t = (deltaMs: number): Instant => instant(NOW + deltaMs);

export function feedInputs(over: Partial<FeedInputs> = {}): FeedInputs {
  return {
    now: NOW,
    userId: ME,
    offers: [],
    slas: [],
    unansweredInbound: [],
    handbacks: [],
    drafts: [],
    tasks: [],
    dealDates: [],
    appointments: [],
    blockedChannels: new Map<ContactId, GateSummary>(),
    ...over,
  };
}

export const offer = (o: Partial<OfferFacts> = {}): OfferFacts => ({
  contactId: contact(1),
  offerId: 'o0000000-0000-7000-8000-000000000001',
  offeredToUserId: ME,
  offeredAt: t(-min(1)),
  expiresAt: t(min(4)),
  sourceName: 'Zillow',
  ...o,
});

export const sla = (o: Partial<SlaFacts> = {}): SlaFacts => ({
  contactId: contact(2),
  ownerUserId: ME,
  periodSeq: 4,
  ownedAt: t(-min(5)),
  firstTouchDueAt: t(min(10)),
  firstTouchAt: null,
  periodEndedAt: null,
  nextPeriodAt: null,
  releaseDueAt: t(min(25)),
  ...o,
});

export const touch = (o: Partial<TouchFacts> = {}): TouchFacts => ({
  kind: 'message',
  direction: 'outbound',
  initiator: 'human',
  imported: false,
  gateAllowed: true,
  at: t(-min(1)),
  byUserId: ME,
  ...o,
});

export const inbound = (o: Partial<InboundFacts> = {}): InboundFacts => ({
  id: msg(1),
  kind: 'message',
  channel: 'sms',
  contactId: contact(3),
  ownerUserId: ME,
  at: t(-min(20)),
  imported: false,
  laterTouches: [],
  ...o,
});

export const handback = (o: Partial<HandbackFacts> = {}): HandbackFacts => ({
  actionId: action(1),
  ownerUserId: ME,
  contactId: contact(4),
  inboundMessageId: msg(40),
  inboundChannel: 'sms',
  receivedAt: t(-min(30)),
  replyDraftActionId: null,
  createdAt: t(-min(30)),
  ...o,
});

export const draft = (o: Partial<DraftFacts> = {}): DraftFacts => ({
  actionId: action(2),
  ownerUserId: ME,
  contactId: contact(5),
  channel: 'sms',
  category: 'novel_message',
  explanation: 'They asked about the open house on Saturday',
  needsReview: false,
  createdAt: t(-min(15)),
  ...o,
});

export const taskF = (o: Partial<TaskFacts> = {}): TaskFacts => ({
  taskId: task(1),
  assigneeUserId: ME,
  contactId: contact(6),
  dealId: null,
  kind: 'callback',
  dueAt: t(hours(2)),
  dueAllDay: false,
  dueTz: null,
  status: 'open',
  completedAt: null,
  needsReview: false,
  createdByKind: 'user',
  createdAt: t(-hours(24)),
  ...o,
});

export const dealDateF = (o: Partial<DealDateFacts> = {}): DealDateFacts => ({
  dealDateId: dealDate(1),
  dealId: deal(1),
  userIds: [ME],
  kind: 'inspection',
  label: null,
  dueOn: localDate('2026-11-10'),
  zone: NY,
  completedAt: null,
  createdAt: t(-hours(24 * 10)),
  ...o,
});

export const apptF = (o: Partial<ApptFacts> = {}): ApptFacts => ({
  appointmentId: appt(1),
  contactId: contact(7),
  userId: ME,
  kind: 'buyer_consult',
  startsAt: t(-hours(2)),
  endsAt: t(-hours(1)),
  status: 'scheduled',
  outcomeLoggedAt: null,
  createdByKind: 'user',
  ...o,
});

export const reinq = (o: Partial<ReinquiryFacts> = {}): ReinquiryFacts => ({
  contactId: contact(8),
  ownerUserId: ME,
  inquiryId: inquiry(1),
  at: t(-min(3)),
  dueAt: null,
  touchedSince: false,
  ...o,
});

export const inactivity = (o: Partial<InactivityFacts> = {}): InactivityFacts => ({
  contactId: contact(9),
  ownerUserId: ME,
  periodSeq: 7,
  warnAt: t(-hours(1)),
  releaseAt: t(hours(47)),
  ...o,
});

export const pondLead = (o: Partial<PondLeadFacts> = {}): PondLeadFacts => ({
  contactId: contact(10),
  pondId: pond(1),
  enteredSeq: 3,
  enteredAt: t(-hours(2)),
  userIds: [ME, OTHER],
  ...o,
});

export const proposal = (o: Partial<SearchProposalFacts> = {}): SearchProposalFacts => ({
  savedSearchId: search(1),
  ownerUserId: ME,
  contactId: contact(11),
  uncheckedCount: 1,
  createdAt: t(-hours(3)),
  ...o,
});

export const outbound = (o: Partial<OutboundStatusFacts> = {}): OutboundStatusFacts => ({
  messageId: msg(100),
  contactId: contact(12),
  ownerUserId: ME,
  channel: 'sms',
  initiator: 'human',
  imported: false,
  status: 'failed',
  statusAt: t(-min(5)),
  dispatchedAt: t(-min(6)),
  statusReason: '30007',
  ...o,
});

/** A confirmed milestone date of deal(1), owned by ME, due in 5 days with an agent responsible. */
export function milestone(over: Partial<MilestoneDateFacts> = {}): MilestoneDateFacts {
  return {
    dealDateId: dealDate(1),
    dealId: deal(1),
    ownerUserId: ME,
    dueAt: t(hours(5 * 24)),
    dueVersion: 1,
    responsible: 'agent',
    completedAt: null,
    status: 'confirmed',
    kind: 'inspection',
    ...over,
  };
}

export function exceptionInputs(over: Partial<ExceptionInputs> = {}): ExceptionInputs {
  return {
    now: NOW,
    ownedWithSla: [],
    promiseTasks: [],
    outbound: [],
    appointments: [],
    settings: { missingOutcomeHours: 2, unknownDispatchMinutes: 10 },
    ...over,
  };
}

/** Deterministic Fisher–Yates with a seeded LCG (tests only). */
export function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let s = seed >>> 0 || 1;
  for (let i = out.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/** A busy, realistic feed: one of everything, plus `n` extra items spread over the types. */
export function busyFeed(n = 0): FeedInputs {
  const i = feedInputs({
    offers: [offer()],
    slas: [sla()],
    unansweredInbound: [inbound()],
    handbacks: [handback()],
    drafts: [draft()],
    tasks: [taskF(), taskF({ taskId: task(2), kind: 'promise', dueAt: t(-hours(1)), contactId: contact(13), createdByKind: 'assistant' })],
    dealDates: [dealDateF()],
    appointments: [apptF()],
    reinquiries: [reinq()],
    inactivityWarnings: [inactivity()],
    pondLeads: [pondLead()],
    searchProposals: [proposal()],
  });
  for (let k = 0; k < n; k++) {
    const c = contact(1000 + k);
    switch (k % 8) {
      case 0:
        i.unansweredInbound.push(inbound({ id: msg(1000 + k), contactId: c, at: t(-min(5 + (k % 300))) }));
        break;
      case 1:
        i.tasks.push(taskF({ taskId: task(1000 + k), contactId: c, dueAt: t(min((k % 600) - 300)) }));
        break;
      case 2:
        i.drafts.push(draft({ actionId: action(1000 + k), contactId: c, createdAt: t(-min(k % 90)) }));
        break;
      case 3:
        i.slas.push(sla({ contactId: c, periodSeq: k, firstTouchDueAt: t(min((k % 40) - 20)) }));
        break;
      case 4:
        i.appointments.push(apptF({ appointmentId: appt(1000 + k), contactId: c, endsAt: t(-min(10 + (k % 200))) }));
        break;
      case 5:
        i.handbacks.push(handback({ actionId: action(5000 + k), contactId: c, receivedAt: t(-min(k % 400)) }));
        break;
      case 6:
        // distinct days from 4 days ago to 20 days ahead, so zone math is not trivially memoized
        i.dealDates.push(dealDateF({ dealDateId: dealDate(1000 + k), dealId: deal(1000 + k), dueOn: localDate(`2026-11-${String(6 + (k % 25)).padStart(2, '0')}`) }));
        break;
      default:
        i.blockedChannels.set(c, { sms: { outcome: 'deny', explanation: 'Opted out of texts' } });
        i.unansweredInbound.push(inbound({ id: msg(1000 + k), contactId: c, at: t(-min(5 + (k % 300))) }));
    }
  }
  return i;
}
