// The team work queue (b19 team-queue lane; DATA_MODEL R-TEAMQ-1..5, E820..E826).
//
// What a team lead needs to answer "did anybody call?": five explainable groups, each row saying WHY it is
// here, WHO has it (or "no owner yet": on offer to whom, in which pond, or unassigned) and for HOW LONG.
//
//   new_lead             an inbound inquiry of the last 14 days whose person has had no human attempt since it
//                        arrived, whoever holds the lead (owned, on offer, in a pond, unassigned). Counted from
//                        ARRIVAL, in wall-clock and in staffed time. An automated reply never clears it.
//   unanswered_reply     the person wrote or called and no person answered (the feed's own answersClient)
//   due_promise          an open promise past its deadline (the feed's taskDeadline)
//   overdue_follow_up    any other open task about a person past its deadline
//   appointment_outcome  an appointment that has ended with no outcome logged (the feed's awaitsOutcome),
//                        as soon as it ends
//
// Pure and deterministic: facts in, rows out. Read-only by construction: nothing here writes, sends, alerts
// or reassigns. The inputs carry no client name, number or address (the API attaches the person's name to a
// row under the viewer's own visibility) and no protected-proxy field (R-AST-12). Member, pond and lead-source
// names are the team's own words and appear in the sentences.
import {
  type AppointmentId,
  type BusinessCalendar,
  type ContactId,
  DAY_MS,
  type Instant,
  type LeadInquiryId,
  type PondId,
  SECOND_MS,
  type TaskId,
  type UserId,
  businessMsBetween,
  isBusinessOpen,
  localDateOf,
  localSecondsOf,
  nextOpening,
} from '../foundation/index.js';
import { answersClient, awaitsOutcome, taskDeadline } from './feed.js';
import { shortMemberName } from './backupAlert.js';
import { clip, formatDuration } from './format.js';
import type { ApptFacts, InboundFacts, TaskFacts } from './types.js';

export const TEAM_QUEUE_GROUPS = ['new_lead', 'unanswered_reply', 'due_promise', 'overdue_follow_up', 'appointment_outcome'] as const;
export type TeamQueueGroupKey = (typeof TEAM_QUEUE_GROUPS)[number];

/** A new lead stays in the queue this long after it arrived (older ones are a list, not a queue). */
export const TEAM_QUEUE_NEW_LEAD_WINDOW_MS = 14 * DAY_MS;
/** Unanswered messages and missed calls are looked for this far back (the feed's own window). */
export const TEAM_QUEUE_REPLY_WINDOW_MS = 14 * DAY_MS;
/** Promises and follow-ups that came due this far back are read. */
export const TEAM_QUEUE_TASK_WINDOW_MS = 90 * DAY_MS;
/** Appointments that ended this far back are read (the feed's own window). */
export const TEAM_QUEUE_APPOINTMENT_WINDOW_MS = 30 * DAY_MS;
/** Rows shown per group; the rest is a count ("and 7 more"). */
export const TEAM_QUEUE_GROUP_CAP = 25;

export const TEAM_QUEUE_GROUP_WORDS: Readonly<Record<TeamQueueGroupKey, { label: string; empty: string }>> = {
  new_lead: { label: 'New leads nobody has tried yet', empty: 'Nobody is waiting on a first call.' },
  unanswered_reply: { label: 'Replies nobody has answered', empty: 'Every reply has an answer from a person.' },
  due_promise: { label: 'Promises past due', empty: 'No promise is past due.' },
  overdue_follow_up: { label: 'Follow-ups past due', empty: 'No follow-up is past due.' },
  appointment_outcome: { label: 'Appointments needing an outcome', empty: 'Every finished appointment has its outcome.' },
};

// ---- who has it ------------------------------------------------------------------------------------------

/** Who has the lead now. Anything but `owner` is "no owner yet". */
export type QueueHolder =
  | { kind: 'owner'; userId: UserId; name: string | null }
  | { kind: 'on_offer'; userId: UserId; name: string | null }
  | { kind: 'pond'; pondId: PondId | null; name: string | null }
  | { kind: 'unassigned' };

/** A team member by id and display name (null: the name is not readable, e.g. a removed member). */
export interface QueueMember {
  userId: UserId;
  name: string | null;
}

/** The holder of a lead from its ownership projection; null for a closed lead (never listed). */
export function queueHolder(c: {
  state: 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';
  ownerUserId: UserId | null;
  ownerName: string | null;
  offeredToUserId: UserId | null;
  offeredToName: string | null;
  pondId: PondId | null;
  pondName: string | null;
}): QueueHolder | null {
  if (c.state === 'closed') return null;
  if (c.state === 'owned' && c.ownerUserId !== null) return { kind: 'owner', userId: c.ownerUserId, name: c.ownerName };
  if (c.state === 'offered' && c.offeredToUserId !== null) return { kind: 'on_offer', userId: c.offeredToUserId, name: c.offeredToName };
  if (c.state === 'in_pond') return { kind: 'pond', pondId: c.pondId, name: c.pondName };
  return { kind: 'unassigned' };
}

const memberName = (name: string | null): string => (name !== null && name.trim() !== '' ? clip(name, 60) : 'a former member');
const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
/** Ends a sentence once: a name that already ends in a full stop ("Jordan P.") gets no second one. */
const stop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** The owner column: the owner's name, or "No owner yet: …" with where the lead is. */
export function holderLabel(h: QueueHolder): string {
  switch (h.kind) {
    case 'owner':
      return capital(memberName(h.name));
    case 'on_offer':
      return `No owner yet: on offer to ${memberName(h.name)}`;
    case 'pond':
      return h.name !== null && h.name.trim() !== '' ? `No owner yet: in the pond ${clip(h.name, 60)}` : 'No owner yet: in a pond';
    case 'unassigned':
      return 'No owner yet: not assigned to anyone';
  }
}

/** The same, as a sentence of the why line. */
function holderSentence(h: QueueHolder): string {
  switch (h.kind) {
    case 'owner':
      return stop(`Owned by ${memberName(h.name)}`);
    case 'on_offer':
      return stop(`On offer to ${memberName(h.name)}`);
    case 'pond':
      return h.name !== null && h.name.trim() !== '' ? stop(`In the pond ${clip(h.name, 60)}`) : 'In a pond.';
    case 'unassigned':
      return 'Not assigned to anyone.';
  }
}

// ---- time since arrival -------------------------------------------------------------------------------------

export interface ArrivalMeasure {
  /** elapsed wall-clock seconds from the arrival to `until` (0 when `until` is not after it) */
  wallSeconds: number;
  /** elapsed seconds inside staffed hours from the arrival to `until` */
  staffedSeconds: number;
  /** the arrival fell outside staffed hours: staffed time is counted from the next opening */
  offHours: boolean;
  /** the instant staffed time starts counting: the arrival itself when staffed, else the next opening */
  countedFrom: Instant;
}

/**
 * Time from a lead's ARRIVAL to `until`, in wall-clock time and in staffed time (the team's staffed hours as a
 * BusinessCalendar). An off-hours arrival counts staffed time from the next opening and is marked.
 */
export function measureFromArrival(arrivedAt: Instant, until: Instant, calendar: BusinessCalendar): ArrivalMeasure {
  return {
    wallSeconds: Math.max(0, Math.floor((until - arrivedAt) / SECOND_MS)),
    staffedSeconds: Math.floor(businessMsBetween(arrivedAt, until, calendar) / SECOND_MS),
    offHours: !isBusinessOpen(arrivedAt, calendar),
    countedFrom: nextOpening(arrivedAt, calendar),
  };
}

// ---- inputs ------------------------------------------------------------------------------------------------

/** One inbound inquiry (a lead_inquiries row that is not an ignored duplicate) with what happened after it. */
export interface QueueInquiryFacts {
  inquiryId: LeadInquiryId;
  contactId: ContactId;
  /** the inquiry's own lead source (lead_sources.name) */
  sourceName: string | null;
  /** when it arrived (lead_inquiries.received_at) */
  receivedAt: Instant;
  holder: QueueHolder;
  /**
   * The first HUMAN attempt on the person at or after the arrival, by anyone: the scoreboard's touch (a human
   * outbound call, or a human text, email or chat reply that passed the send-time gate; never a bulk send, an
   * invite, an assistant or system message, or imported history). Null: none yet.
   */
  humanAttemptAt: Instant | null;
  /** The first automated (assistant or system) message sent to the person after the arrival; never an attempt. */
  automatedReplyAt: Instant | null;
  /**
   * b19 R-TEAMQ-18: this inquiry's minute-three backup decision, when it alerted someone or found nobody to alert
   * (lead_backup_alerts): when, the alerted member's name, and whether they are the source's backup or the team lead
   * alerted in their place. Absent or null: no alert (not a covered source, not due yet, or not needed).
   */
  backupAlert?: { at: Instant; outcome: 'alerted' | 'no_recipient'; name: string | null; recipient: 'backup' | 'team_lead' | null } | null;
}

/** A client message or missed call that may be waiting (the feed's InboundFacts without an owner). */
export type QueueInboundFacts = Omit<InboundFacts, 'ownerUserId'>;

export interface QueueTaskFacts extends Pick<TaskFacts, 'taskId' | 'contactId' | 'kind' | 'dueAt' | 'dueAllDay' | 'dueTz' | 'status' | 'createdByKind'> {
  title: string;
  assignee: QueueMember;
}

export interface QueueApptFacts extends ApptFacts {
  /** whose appointment it is (appointments.user_id) */
  member: QueueMember;
}

export interface TeamQueueInputs {
  now: Instant;
  /** the team's staffed hours */
  calendar: BusinessCalendar;
  /** the people the viewer may see, with who has each and the source they first came from */
  people: ReadonlyMap<ContactId, { holder: QueueHolder; sourceName: string | null }>;
  inquiries: readonly QueueInquiryFacts[];
  inbound: readonly QueueInboundFacts[];
  tasks: readonly QueueTaskFacts[];
  appointments: readonly QueueApptFacts[];
  /** rows shown per group (default TEAM_QUEUE_GROUP_CAP) */
  cap?: number;
}

// ---- output -------------------------------------------------------------------------------------------------

export interface TeamQueueRow {
  group: TeamQueueGroupKey;
  /** stable per row: new_lead:{contact}, reply:{contact}, task:{task}, appt:{appointment} */
  key: string;
  contactId: ContactId;
  sourceName: string | null;
  /** new_lead and unanswered_reply: who has the lead. The task groups: whom the task is on. appointment_outcome: whose appointment it is. */
  holder: QueueHolder;
  ownerLabel: string;
  why: string;
  /** what the age is counted from: the arrival, the first waiting message, the deadline, the appointment's end */
  since: Instant;
  waitingSeconds: number;
  /** new_lead only: the same wait inside staffed hours */
  staffedSeconds: number | null;
  /** new_lead only: it arrived outside staffed hours */
  offHours: boolean;
  /**
   * new_lead only (b19 R-TEAMQ-18): the backup alert of this person's latest alerted inquiry, as its own line
   * ("Backup alerted at 2:06 PM: Sam T."; the time is in the team's zone, like the why line's). `alerted` false: the
   * job found nobody to alert, and the line says so. null: no alert.
   */
  backupAlert: { at: Instant; alerted: boolean; line: string } | null;
  subject: { kind: 'inquiry'; id: LeadInquiryId } | { kind: 'message' | 'call'; id: string } | { kind: 'task'; id: TaskId } | { kind: 'appointment'; id: AppointmentId };
}

export interface TeamQueueGroup {
  key: TeamQueueGroupKey;
  label: string;
  /** what to say when the group has no row */
  empty: string;
  rows: TeamQueueRow[];
  total: number;
  /** total - rows.length */
  more: number;
  /** new_lead only (b19 R-TEAMQ-18): of `total`, the rows whose backup was alerted; null for the other groups */
  backupAlerted: number | null;
}

export interface TeamQueue {
  groups: TeamQueueGroup[];
}

// ---- wording ------------------------------------------------------------------------------------------------

const ago = (now: Instant, t: Instant): string => `${formatDuration(now - t)} ago`;

/** "2:03 PM" in the team's zone. */
function clockTime(t: Instant, cal: BusinessCalendar): string {
  const s = localSecondsOf(t, cal.zone);
  const h24 = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h24 % 12 === 0 ? 12 : h24 % 12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

function automatedSentence(now: Instant, at: Instant | null, cal: BusinessCalendar): string {
  if (at === null) return 'No automatic reply has gone out.';
  return localDateOf(at, cal.zone) === localDateOf(now, cal.zone) ? `An automatic reply went out at ${clockTime(at, cal)}.` : `An automatic reply went out ${ago(now, at)}.`;
}

/** R-TEAMQ-18: the backup alert of a waiting lead, as its own line. */
function backupAlertLine(now: Instant, a: NonNullable<QueueInquiryFacts['backupAlert']>, cal: BusinessCalendar): string {
  const sameDay = localDateOf(a.at, cal.zone) === localDateOf(now, cal.zone);
  const when = sameDay ? `at ${clockTime(a.at, cal)}` : ago(now, a.at);
  if (a.outcome === 'no_recipient') return `Nobody could be alerted ${when}: the source's backup is unavailable and whoever has this lead has no team lead.`;
  const who = stop(shortMemberName(a.name));
  return a.recipient === 'team_lead' ? `The source's backup is unavailable: the team lead, ${shortMemberName(a.name)}, was alerted ${when}.` : `Backup alerted ${when}: ${who}`;
}

const TASK_WORD: Record<QueueTaskFacts['kind'], string> = { promise: 'Promise', follow_up: 'Follow-up', callback: 'Callback', todo: 'To-do', document: 'Document task' };
const APPT_WORD: Record<ApptFacts['kind'], string> = { buyer_consult: 'Buyer consult', listing_appointment: 'Listing appointment', consult: 'Consult', other: 'Appointment' };

// ---- the queue ----------------------------------------------------------------------------------------------

const seconds = (now: Instant, since: Instant): number => Math.max(0, Math.floor((now - since) / SECOND_MS));
const byWaiting = (a: TeamQueueRow, b: TeamQueueRow): number => a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function newLeadRows(i: TeamQueueInputs): TeamQueueRow[] {
  const { now } = i;
  const open = new Map<ContactId, QueueInquiryFacts[]>();
  for (const q of i.inquiries) {
    // R-TEAMQ-2: inside the window, arrived, and no HUMAN attempt at or after the arrival
    if (q.receivedAt > now || now - q.receivedAt > TEAM_QUEUE_NEW_LEAD_WINDOW_MS) continue;
    if (q.humanAttemptAt !== null && q.humanAttemptAt >= q.receivedAt) continue;
    const list = open.get(q.contactId);
    if (list === undefined) open.set(q.contactId, [q]);
    else list.push(q);
  }
  const rows: TeamQueueRow[] = [];
  for (const [contactId, list] of open) {
    list.sort((a, b) => a.receivedAt - b.receivedAt || (a.inquiryId < b.inquiryId ? -1 : 1));
    const first = list[0] as QueueInquiryFacts;
    const latest = list[list.length - 1] as QueueInquiryFacts;
    const m = measureFromArrival(first.receivedAt, now, i.calendar);
    const from = first.sourceName !== null && first.sourceName.trim() !== '' ? clip(first.sourceName, 60) : 'a source with no name';
    const offHours = m.offHours ? `, outside staffed hours (${formatDuration(m.staffedSeconds * SECOND_MS)} of staffed time since opening)` : '';
    const again = list.length > 1 ? ` Asked again ${ago(now, latest.receivedAt)} (${list.length} inquiries).` : '';
    // the automatic reply said is the first one after the FIRST unanswered arrival
    const auto = list.map((q) => q.automatedReplyAt).filter((a): a is Instant => a !== null && a >= first.receivedAt).sort((a, b) => a - b)[0] ?? null;
    // R-TEAMQ-18: the latest backup alert among the person's waiting inquiries
    const alert = list.map((q) => q.backupAlert ?? null).filter((a): a is NonNullable<QueueInquiryFacts['backupAlert']> => a !== null).sort((a, b) => b.at - a.at)[0] ?? null;
    rows.push({
      group: 'new_lead',
      key: `new_lead:${contactId}`,
      contactId,
      sourceName: first.sourceName,
      holder: latest.holder,
      ownerLabel: holderLabel(latest.holder),
      why: `Arrived ${ago(now, first.receivedAt)} from ${from}${offHours}.${again} ${holderSentence(latest.holder)} Nobody has called, texted or emailed yet. ${automatedSentence(now, auto, i.calendar)}`,
      since: first.receivedAt,
      waitingSeconds: m.wallSeconds,
      staffedSeconds: m.staffedSeconds,
      offHours: m.offHours,
      backupAlert: alert === null ? null : { at: alert.at, alerted: alert.outcome === 'alerted', line: backupAlertLine(now, alert, i.calendar) },
      subject: { kind: 'inquiry', id: first.inquiryId },
    });
  }
  return rows;
}

function replyRows(i: TeamQueueInputs): TeamQueueRow[] {
  const { now } = i;
  const waiting = new Map<ContactId, QueueInboundFacts[]>();
  for (const m of i.inbound) {
    // R-TEAMQ-3: the feed's rule, word for word (feed.ts "clients waiting")
    if (m.imported || m.isAutoReply === true || m.isKeyword === true || !i.people.has(m.contactId)) continue;
    if (m.at > now || now - m.at > TEAM_QUEUE_REPLY_WINDOW_MS) continue;
    if (m.laterTouches.some((x) => answersClient(x, m.at))) continue;
    const list = waiting.get(m.contactId);
    if (list === undefined) waiting.set(m.contactId, [m]);
    else list.push(m);
  }
  const rows: TeamQueueRow[] = [];
  for (const [contactId, msgs] of waiting) {
    const person = i.people.get(contactId) as { holder: QueueHolder; sourceName: string | null };
    msgs.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
    const first = msgs[0] as QueueInboundFacts;
    const latest = msgs[msgs.length - 1] as QueueInboundFacts;
    const missed = latest.kind === 'missed_call';
    const wrote = latest.channel === 'email' ? 'emailed' : latest.channel === 'web_chat' ? 'wrote in the website chat' : 'texted';
    const what = missed ? `Missed call ${ago(now, latest.at)}; nobody has called back or written.` : `They ${wrote} ${ago(now, latest.at)}; no answer from a person yet.`;
    const more = msgs.length > 1 ? ` ${msgs.length} messages or calls waiting, the first ${ago(now, first.at)}.` : '';
    rows.push({
      group: 'unanswered_reply',
      key: `reply:${contactId}`,
      contactId,
      sourceName: person.sourceName,
      holder: person.holder,
      ownerLabel: holderLabel(person.holder),
      why: `${what}${more} ${holderSentence(person.holder)}`,
      since: first.at,
      waitingSeconds: seconds(now, first.at),
      staffedSeconds: null,
      offHours: false,
      backupAlert: null,
      subject: { kind: missed ? 'call' : 'message', id: latest.id },
    });
  }
  return rows;
}

function taskRows(i: TeamQueueInputs, promise: boolean): TeamQueueRow[] {
  const { now } = i;
  const rows: TeamQueueRow[] = [];
  for (const t of i.tasks) {
    if ((t.kind === 'promise') !== promise || t.status !== 'open' || t.contactId === null || t.createdByKind === 'import') continue;
    const person = i.people.get(t.contactId);
    const deadline = taskDeadline(t);
    // R-TEAMQ-4: past due only (the feed's own deadline: the end of the local day for an all-day task)
    if (person === undefined || deadline === null || deadline > now || now - deadline > TEAM_QUEUE_TASK_WINDOW_MS) continue;
    const holder: QueueHolder = { kind: 'owner', userId: t.assignee.userId, name: t.assignee.name };
    const who = promise ? `${capital(memberName(t.assignee.name))} made it.` : stop(`Assigned to ${memberName(t.assignee.name)}`);
    rows.push({
      group: promise ? 'due_promise' : 'overdue_follow_up',
      key: `task:${t.taskId}`,
      contactId: t.contactId,
      sourceName: person.sourceName,
      holder,
      ownerLabel: holderLabel(holder),
      why: `${TASK_WORD[t.kind]} “${clip(t.title, 80)}” was due ${ago(now, deadline)}. ${who}`,
      since: deadline,
      waitingSeconds: seconds(now, deadline),
      staffedSeconds: null,
      offHours: false,
      backupAlert: null,
      subject: { kind: 'task', id: t.taskId },
    });
  }
  return rows;
}

function appointmentRows(i: TeamQueueInputs): TeamQueueRow[] {
  const { now } = i;
  const rows: TeamQueueRow[] = [];
  for (const a of i.appointments) {
    // R-TEAMQ-5: as soon as it has ended (the feed's awaitsOutcome), not two hours later
    if (a.contactId === null || !awaitsOutcome(a) || a.endsAt > now || now - a.endsAt > TEAM_QUEUE_APPOINTMENT_WINDOW_MS) continue;
    const person = i.people.get(a.contactId);
    if (person === undefined) continue;
    const holder: QueueHolder = { kind: 'owner', userId: a.member.userId, name: a.member.name };
    rows.push({
      group: 'appointment_outcome',
      key: `appt:${a.appointmentId}`,
      contactId: a.contactId,
      sourceName: person.sourceName,
      holder,
      ownerLabel: holderLabel(holder),
      why: `${APPT_WORD[a.kind]} ended ${ago(now, a.endsAt)} with no outcome logged. It is ${capital(memberName(a.member.name))}’s appointment.`,
      since: a.endsAt,
      waitingSeconds: seconds(now, a.endsAt),
      staffedSeconds: null,
      offHours: false,
      backupAlert: null,
      subject: { kind: 'appointment', id: a.appointmentId },
    });
  }
  return rows;
}

/** The team work queue: the five groups in their fixed order, each longest-waiting first and capped with a count. */
export function buildTeamQueue(i: TeamQueueInputs): TeamQueue {
  const cap = Math.max(1, Math.trunc(i.cap ?? TEAM_QUEUE_GROUP_CAP));
  const all: Record<TeamQueueGroupKey, TeamQueueRow[]> = {
    new_lead: newLeadRows(i),
    unanswered_reply: replyRows(i),
    due_promise: taskRows(i, true),
    overdue_follow_up: taskRows(i, false),
    appointment_outcome: appointmentRows(i),
  };
  return {
    groups: TEAM_QUEUE_GROUPS.map((key) => {
      const rows = all[key].sort(byWaiting);
      const backupAlerted = key === 'new_lead' ? rows.filter((r) => r.backupAlert?.alerted === true).length : null;
      return { key, ...TEAM_QUEUE_GROUP_WORDS[key], rows: rows.slice(0, cap), total: rows.length, more: Math.max(0, rows.length - cap), backupAlerted };
    }),
  };
}
