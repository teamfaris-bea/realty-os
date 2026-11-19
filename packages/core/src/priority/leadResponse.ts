// The lead response report (b19 team-queue lane; DATA_MODEL R-TEAMQ-7..9, E827..E832).
//
// Response time measured from the moment a lead ARRIVES (the one arrival instant, arrival.ts), not from when an agent
// accepted it: per inbound inquiry, the first HUMAN attempt after the arrival by ANYONE (the scoreboard's touch),
// who made it and in what role to the lead at that moment, in wall-clock and in staffed time. An automated reply
// is reported apart and is never an attempt. Rolled up by lead source with every denominator.
//
// "Within 5 minutes" is STAFFED time from the arrival to the first human attempt, at most 300 seconds; an arrival
// outside staffed hours counts from the next opening and is marked. The denominator is every inquiry of the
// period, so an inquiry still waiting counts against the source until someone tries.
//
// Percentiles on small samples mean nothing, so none is shown below a minimum: the median needs
// RESPONSE_MEDIAN_MIN_SAMPLE attempted inquiries and the 90th percentile RESPONSE_P90_MIN_SAMPLE; the sample
// size always travels with them. Pure: facts in, numbers out; no client name, number or address.
import type { BusinessCalendar, ContactId, Instant, LeadInquiryId, LeadSourceId, UserId } from '../foundation/index.js';
import { measureFromArrival } from './teamQueue.js';

/** "Within 5 minutes" and "within 15 minutes", in staffed seconds from arrival (the boundary included). */
export const RESPONSE_WITHIN_SECONDS = [300, 900] as const;
/** No median below this many attempted inquiries. */
export const RESPONSE_MEDIAN_MIN_SAMPLE = 5;
/** No 90th percentile below this many attempted inquiries. */
export const RESPONSE_P90_MIN_SAMPLE = 10;
/** Inquiries not within 5 minutes listed under a source; the rest is a count. */
export const RESPONSE_NOT_WITHIN_CAP = 20;

/**
 * The attempter's role to the lead at the moment of the attempt. `backup` (b19 R-TEAMQ-18): the person the
 * minute-three backup alert of this inquiry went to, attempting after it; the owner at that moment is always `owner`.
 */
export type AttemptRole = 'owner' | 'backup' | 'collaborator' | 'other';
export type AttemptKind = 'call' | 'text' | 'email' | 'chat';

export interface ResponseInquiryFacts {
  inquiryId: LeadInquiryId;
  contactId: ContactId;
  sourceId: LeadSourceId;
  sourceName: string | null;
  /** the arrival: the one arrival instant (arrival.ts, R-TEAMQ-19) */
  arrivedAt: Instant;
  /** the first human attempt on the person at or after the arrival, by anyone; null: none yet */
  firstAttempt: { at: Instant; kind: AttemptKind; byUserId: UserId | null; role: AttemptRole } | null;
  /** the first automated message sent to the person after the arrival; never an attempt */
  automatedReplyAt: Instant | null;
  /**
   * b19 R-TEAMQ-18: this inquiry's minute-three backup alert, when one was raised: when, to whom, and whether to the
   * source's backup or to the team lead alerted in their place. Absent or null: nobody was alerted.
   */
  backupAlert?: { at: Instant; byUserId: UserId; recipient: 'backup' | 'team_lead' } | null;
}

export interface MeasuredInquiry extends Omit<ResponseInquiryFacts, 'firstAttempt' | 'backupAlert'> {
  backupAlert: NonNullable<ResponseInquiryFacts['backupAlert']> | null;
  /** it arrived outside staffed hours: staffed time counts from `countedFrom` */
  offHours: boolean;
  countedFrom: Instant;
  attempt: (NonNullable<ResponseInquiryFacts['firstAttempt']> & { wallSeconds: number; staffedSeconds: number }) | null;
  /** no human attempt yet: how long it has waited as of `now` */
  waiting: { wallSeconds: number; staffedSeconds: number } | null;
  within5: boolean;
  within15: boolean;
}

export interface ResponseRollup {
  /** arrivals in the period: the denominator of every count below */
  inquiries: number;
  /** with a human attempt */
  attempted: number;
  within5: number;
  within15: number;
  /** no human attempt yet (attempted + waiting = inquiries) */
  waiting: number;
  /** with an automated reply (shown apart; never counted as an attempt) */
  automatedReplies: number;
  /** b19 R-TEAMQ-18: inquiries whose backup alert was raised (of `inquiries`) */
  backupAlerted: number;
  /** b19 R-TEAMQ-18: of `backupAlerted`, those whose first human attempt was made by the alerted person, after the alert */
  byBackup: number;
  /** the attempted inquiries the percentiles rest on */
  sample: number;
  /** median staffed seconds to the first human attempt; null below RESPONSE_MEDIAN_MIN_SAMPLE */
  medianStaffedSeconds: number | null;
  /** 90th percentile (nearest rank); null below RESPONSE_P90_MIN_SAMPLE */
  p90StaffedSeconds: number | null;
}

export interface SourceResponseRollup extends ResponseRollup {
  sourceId: LeadSourceId;
  sourceName: string | null;
  /** the inquiries not within 5 minutes: still waiting first (longest first), then the slowest */
  notWithin5: MeasuredInquiry[];
  notWithin5More: number;
}

/** One inquiry measured from its arrival: to its first human attempt, or to `now` while it waits. */
export function measureInquiry(f: ResponseInquiryFacts, now: Instant, calendar: BusinessCalendar): MeasuredInquiry {
  const { firstAttempt, backupAlert, ...rest } = f;
  const m = measureFromArrival(f.arrivedAt, firstAttempt?.at ?? now, calendar);
  const attempt = firstAttempt === null ? null : { ...firstAttempt, wallSeconds: m.wallSeconds, staffedSeconds: m.staffedSeconds };
  return {
    ...rest,
    backupAlert: backupAlert ?? null,
    offHours: m.offHours,
    countedFrom: m.countedFrom,
    attempt,
    waiting: attempt === null ? { wallSeconds: m.wallSeconds, staffedSeconds: m.staffedSeconds } : null,
    within5: attempt !== null && attempt.staffedSeconds <= RESPONSE_WITHIN_SECONDS[0],
    within15: attempt !== null && attempt.staffedSeconds <= RESPONSE_WITHIN_SECONDS[1],
  };
}

/** The median of a sorted list: an even count averages the middle two, rounded (as the scoreboard's). */
function median(sorted: readonly number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** The q-th percentile of a sorted list by nearest rank (the smallest value with at least q of the sample at or below it). */
function nearestRank(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] as number;
}

function rollup(list: readonly MeasuredInquiry[]): ResponseRollup {
  const staffed = list.flatMap((m) => (m.attempt === null ? [] : [m.attempt.staffedSeconds])).sort((a, b) => a - b);
  return {
    inquiries: list.length,
    attempted: staffed.length,
    within5: list.filter((m) => m.within5).length,
    within15: list.filter((m) => m.within15).length,
    waiting: list.length - staffed.length,
    automatedReplies: list.filter((m) => m.automatedReplyAt !== null).length,
    backupAlerted: list.filter((m) => m.backupAlert !== null).length,
    byBackup: list.filter((m) => m.backupAlert !== null && m.attempt?.role === 'backup').length,
    sample: staffed.length,
    medianStaffedSeconds: staffed.length >= RESPONSE_MEDIAN_MIN_SAMPLE ? median(staffed) : null,
    p90StaffedSeconds: staffed.length >= RESPONSE_P90_MIN_SAMPLE ? nearestRank(staffed, 0.9) : null,
  };
}

const byId = (a: MeasuredInquiry, b: MeasuredInquiry): number => (a.inquiryId < b.inquiryId ? -1 : a.inquiryId > b.inquiryId ? 1 : 0);

/** Still waiting first (the longest wait first), then the slowest attempts. */
function slowestFirst(a: MeasuredInquiry, b: MeasuredInquiry): number {
  if ((a.attempt === null) !== (b.attempt === null)) return a.attempt === null ? -1 : 1;
  if (a.waiting !== null && b.waiting !== null) return a.arrivedAt - b.arrivedAt || byId(a, b);
  return (b.attempt?.staffedSeconds ?? 0) - (a.attempt?.staffedSeconds ?? 0) || a.arrivedAt - b.arrivedAt || byId(a, b);
}

/** The report: every inquiry measured, rolled up by lead source (most inquiries first) and in total. */
export function rollUpResponses(
  inquiries: readonly ResponseInquiryFacts[],
  now: Instant,
  calendar: BusinessCalendar,
): { sources: SourceResponseRollup[]; totals: ResponseRollup; measured: MeasuredInquiry[] } {
  const measured = inquiries.map((f) => measureInquiry(f, now, calendar));
  const bySource = new Map<LeadSourceId, MeasuredInquiry[]>();
  for (const m of measured) {
    const list = bySource.get(m.sourceId);
    if (list === undefined) bySource.set(m.sourceId, [m]);
    else list.push(m);
  }
  const sources: SourceResponseRollup[] = [...bySource.entries()].map(([sourceId, list]) => {
    const slow = list.filter((m) => !m.within5).sort(slowestFirst);
    return {
      sourceId,
      sourceName: list.find((m) => m.sourceName !== null)?.sourceName ?? null,
      ...rollup(list),
      notWithin5: slow.slice(0, RESPONSE_NOT_WITHIN_CAP),
      notWithin5More: Math.max(0, slow.length - RESPONSE_NOT_WITHIN_CAP),
    };
  });
  const name = (s: SourceResponseRollup) => s.sourceName ?? '￿';
  sources.sort((a, b) => b.inquiries - a.inquiries || (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0) || (a.sourceId < b.sourceId ? -1 : 1));
  return { sources, totals: rollup(measured), measured };
}
