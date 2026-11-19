// Fixtures of the team work queue for jsdom tests (imported by *.test.tsx only). Invented people only.
import type { TeamQueueGroup, TeamQueueGroupKey, TeamQueueResponse, TeamQueueRow } from './lib.js';

export const QUEUE_PATH = 'GET /team/queue';

/** The server's group words (core TEAM_QUEUE_GROUP_WORDS), as GET /team/queue returns them. */
export const QUEUE_WORDS: Record<TeamQueueGroupKey, [label: string, empty: string]> = {
  new_lead: ['New leads nobody has tried yet', 'Nobody is waiting on a first call.'],
  unanswered_reply: ['Replies nobody has answered', 'Every reply has an answer from a person.'],
  due_promise: ['Promises past due', 'No promise is past due.'],
  overdue_follow_up: ['Follow-ups past due', 'No follow-up is past due.'],
  appointment_outcome: ['Appointments needing an outcome', 'Every finished appointment has its outcome.'],
};

export const QUEUE_PEOPLE = {
  quinn: '01900000-0000-7000-8000-0000000000c1',
  opal: '01900000-0000-7000-8000-0000000000c2',
  ivo: '01900000-0000-7000-8000-0000000000c3',
  rhea: '01900000-0000-7000-8000-0000000000c4',
} as const;
const BEN = '01900000-0000-7000-8000-0000000000b2';

/** A new lead on offer, 12 minutes after it arrived, with an automatic reply and no human attempt. */
export function queueRow(o: Partial<TeamQueueRow> = {}): TeamQueueRow {
  return {
    key: `new_lead:${QUEUE_PEOPLE.quinn}`,
    contact: { id: QUEUE_PEOPLE.quinn, name: 'Quinn Harbor' },
    source: 'Website form',
    owner: { kind: 'on_offer', userId: BEN, name: 'Ben Agent', pondId: null, label: 'No owner yet: on offer to Ben Agent' },
    why: 'Arrived 12 min ago from Website form. On offer to Ben Agent. Nobody has called, texted or emailed yet. An automatic reply went out at 2:03 PM.',
    since: new Date(Date.now() - 12 * 60_000).toISOString(),
    waitingSeconds: 720,
    staffedSeconds: 720,
    offHours: false,
    ...o,
  };
}

/** GET /team/queue: the five groups in the server's order, with the given rows (default: every group empty). */
export function workQueue(rows: Partial<Record<TeamQueueGroupKey, TeamQueueRow[]>> = {}, over: Partial<Record<TeamQueueGroupKey, Partial<TeamQueueGroup>>> = {}): TeamQueueResponse {
  return {
    groups: (Object.keys(QUEUE_WORDS) as TeamQueueGroupKey[]).map((key) => {
      const list = rows[key] ?? [];
      return { key, label: QUEUE_WORDS[key][0], empty: QUEUE_WORDS[key][1], rows: list, total: list.length, more: 0, atLeast: false, ...over[key] };
    }),
    staffedHours: { open: '08:00', close: '21:00', zone: 'America/New_York' },
    windows: { newLeadDays: 14, replyDays: 14, taskDays: 90, appointmentDays: 30 },
    generatedAt: new Date().toISOString(),
  };
}
