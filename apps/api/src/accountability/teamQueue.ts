// The team work queue (b19 team-queue lane; DATA_MODEL R-TEAMQ-1..6, E820..E826).
//
//   GET /team/queue      team_queue.view   Owner, Admin: every lead; Team Lead: their teams' leads and pond leads;
//                                          an Agent, an ISA and a TC are refused (404, R-PERM-5)
//
// What a team lead needs to answer "did anybody call?": five groups (new lead with no human attempt, unanswered
// reply, due promise, overdue follow-up, appointment needing an outcome), each row saying why it is here, who has
// it or "no owner yet" (on offer to whom, in which pond, or unassigned), and for how long, counted from ARRIVAL.
//
// READ-ONLY: this module only reads, in one transaction as the caller, so row-level security and the team scope of
// repos/teamQueue.ts decide which people exist for them. It writes nothing, enqueues no job, sends no message and
// raises no notification; it never reassigns. Core (buildTeamQueue) holds the grouping and the "why" sentences.
//
// How it differs from the exception list beside it (GET /team/exceptions): that list is the ledger of misses a
// person must resolve (an untouched lead only AFTER its deadline, measured from when an agent accepted; a missing
// outcome two hours after the appointment); this queue is what is waiting right now, from arrival, whoever holds it.
import {
  type ContactId,
  DAY_MS,
  type Instant,
  type PondId,
  type UserId,
  businessCalendar,
  instant,
} from '@realty/core/foundation';
import {
  type QueueApptFacts,
  type QueueHolder,
  type QueueInquiryFacts,
  type QueueTaskFacts,
  TEAM_QUEUE_APPOINTMENT_WINDOW_MS,
  TEAM_QUEUE_NEW_LEAD_WINDOW_MS,
  TEAM_QUEUE_REPLY_WINDOW_MS,
  TEAM_QUEUE_TASK_WINDOW_MS,
  type TeamQueueGroupKey,
  buildTeamQueue,
  queueHolder,
} from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { iso, ms } from './common.js';
import * as repo from './repos/teamQueue.js';

export interface TeamQueueOwnerView {
  /** `owner`: the lead's owner, or the member a task or appointment is on. Anything else is "no owner yet". */
  kind: QueueHolder['kind'];
  userId: string | null;
  name: string | null;
  pondId: string | null;
  /** the owner's name, or "No owner yet: on offer to …", "… in the pond …", "… not assigned to anyone" */
  label: string;
}

export interface TeamQueueRowView {
  key: string;
  contact: { id: string; name: string };
  /** the lead source: the inquiry's own for a new lead, else the one the person first came from */
  source: string | null;
  owner: TeamQueueOwnerView;
  why: string;
  /** what the wait is counted from: the arrival, the first waiting message, the deadline, the appointment's end */
  since: string;
  waitingSeconds: number;
  /** new leads only: the same wait inside staffed hours */
  staffedSeconds: number | null;
  /** new leads only: it arrived outside staffed hours (staffed time counts from opening) */
  offHours: boolean;
}

export interface TeamQueueGroupView {
  key: TeamQueueGroupKey;
  label: string;
  empty: string;
  rows: TeamQueueRowView[];
  total: number;
  more: number;
  /** the read reached its cap: `total` and `more` are lower bounds */
  atLeast: boolean;
}

export interface TeamQueueView {
  groups: TeamQueueGroupView[];
  staffedHours: { open: string; close: string; zone: string };
  windows: { newLeadDays: number; replyDays: number; taskDays: number; appointmentDays: number };
  generatedAt: string;
}

const days = (windowMs: number): number => Math.round(windowMs / DAY_MS);
const back = (now: Instant, windowMs: number): Instant => instant(now - windowMs);

export function holderOfRow(r: repo.HolderColumns): QueueHolder | null {
  return queueHolder({
    state: r.ownership_state,
    ownerUserId: r.owner_user_id as UserId | null,
    ownerName: r.owner_name,
    offeredToUserId: r.offered_to_user_id as UserId | null,
    offeredToName: r.offered_to_name,
    pondId: r.pond_id as PondId | null,
    pondName: r.pond_name,
  });
}

export function ownerView(h: QueueHolder, label: string): TeamQueueOwnerView {
  return {
    kind: h.kind,
    userId: h.kind === 'owner' || h.kind === 'on_offer' ? h.userId : null,
    name: h.kind === 'unassigned' ? null : h.name,
    pondId: h.kind === 'pond' ? h.pondId : null,
    label,
  };
}

/** The team work queue as the caller may see it (read-only). */
export async function teamQueue(tx: Tx, now: Instant): Promise<TeamQueueView> {
  const cap = repo.QUEUE_READ_CAP;
  const [hours, inquiries, inbound, promises, followUps, appointments] = await Promise.all([
    repo.staffedHours(tx),
    repo.waitingInquiries(tx, back(now, TEAM_QUEUE_NEW_LEAD_WINDOW_MS), now, cap),
    repo.waitingInbound(tx, back(now, TEAM_QUEUE_REPLY_WINDOW_MS), now, cap),
    repo.pastDueTasks(tx, true, back(now, TEAM_QUEUE_TASK_WINDOW_MS), now, cap),
    repo.pastDueTasks(tx, false, back(now, TEAM_QUEUE_TASK_WINDOW_MS), now, cap),
    repo.endedAppointments(tx, back(now, TEAM_QUEUE_APPOINTMENT_WINDOW_MS), now, cap),
  ]);
  const calendar = businessCalendar({ zone: hours.zone, open: hours.open, close: hours.close });

  // the people behind the rows, as the caller's RLS shows them: name, who has them, where they first came from
  const names = new Map<string, string>();
  const people = new Map<ContactId, { holder: QueueHolder; sourceName: string | null }>();
  const addPerson = (r: repo.HolderColumns & { contact_id: string; source_name: string | null }): QueueHolder | null => {
    const holder = holderOfRow(r);
    if (holder === null) return null;
    names.set(r.contact_id, r.contact_name);
    people.set(r.contact_id as ContactId, { holder, sourceName: r.source_name });
    return holder;
  };
  for (const p of inbound.people) addPerson(p);
  const tasks = [...promises.slice(0, cap), ...followUps.slice(0, cap)];
  const appts = appointments.slice(0, cap);
  const missing = [...tasks.map((t) => t.contact_id), ...appts.map((a) => a.contact_id)].filter((id) => !people.has(id as ContactId));
  for (const p of await repo.peopleByIds(tx, missing)) addPerson(p);

  const inquiryFacts: QueueInquiryFacts[] = [];
  for (const q of inquiries.slice(0, cap)) {
    const holder = holderOfRow(q);
    if (holder === null) continue;
    names.set(q.contact_id, q.contact_name);
    inquiryFacts.push({
      inquiryId: q.id as never,
      contactId: q.contact_id as ContactId,
      sourceName: q.source_name,
      receivedAt: ms(q.received_at),
      holder,
      humanAttemptAt: null, // the read keeps only inquiries with no human attempt at or after the arrival
      automatedReplyAt: q.automated_at === null ? null : ms(q.automated_at),
    });
  }
  const taskFacts: QueueTaskFacts[] = tasks.map((t) => ({
    taskId: t.id as never,
    contactId: t.contact_id as ContactId,
    kind: t.kind,
    dueAt: ms(t.due_at),
    dueAllDay: t.due_all_day,
    dueTz: t.due_tz as never,
    status: 'open',
    createdByKind: t.created_by_kind,
    title: t.title,
    assignee: { userId: t.assignee_user_id as UserId, name: t.assignee_name },
  }));
  const apptFacts: QueueApptFacts[] = appts.map((a) => ({
    appointmentId: a.id as never,
    contactId: a.contact_id as ContactId,
    userId: a.user_id as UserId,
    kind: a.kind,
    startsAt: ms(a.starts_at),
    endsAt: ms(a.ends_at),
    status: a.status,
    outcomeLoggedAt: null,
    createdByKind: a.created_by_kind,
    member: { userId: a.user_id as UserId, name: a.member_name },
  }));

  const q = buildTeamQueue({ now, calendar, people, inquiries: inquiryFacts, inbound: inbound.inbound, tasks: taskFacts, appointments: apptFacts });
  const capped: Record<TeamQueueGroupKey, boolean> = {
    new_lead: inquiries.length > cap,
    unanswered_reply: inbound.capped,
    due_promise: promises.length > cap,
    overdue_follow_up: followUps.length > cap,
    appointment_outcome: appointments.length > cap,
  };
  return {
    groups: q.groups.map((g) => ({
      key: g.key,
      label: g.label,
      empty: g.empty,
      rows: g.rows.map((r) => ({
        key: r.key,
        contact: { id: r.contactId, name: names.get(r.contactId) ?? '' },
        source: r.sourceName,
        owner: ownerView(r.holder, r.ownerLabel),
        why: r.why,
        since: iso(r.since),
        waitingSeconds: r.waitingSeconds,
        staffedSeconds: r.staffedSeconds,
        offHours: r.offHours,
      })),
      total: g.total,
      more: g.more,
      atLeast: capped[g.key],
    })),
    staffedHours: { open: hours.open, close: hours.close, zone: hours.zone },
    windows: {
      newLeadDays: days(TEAM_QUEUE_NEW_LEAD_WINDOW_MS),
      replyDays: days(TEAM_QUEUE_REPLY_WINDOW_MS),
      taskDays: days(TEAM_QUEUE_TASK_WINDOW_MS),
      appointmentDays: days(TEAM_QUEUE_APPOINTMENT_WINDOW_MS),
    },
    generatedAt: iso(now),
  };
}
