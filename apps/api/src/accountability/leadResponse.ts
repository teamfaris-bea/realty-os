// The lead response report (b19 team-queue lane; DATA_MODEL R-TEAMQ-6..9, E827..E832).
//
//   GET /team/lead-response?range=today|7d|30d|90d   team_queue.view   (Owner/Admin: all; Team Lead: their teams and
//                                                                      pond leads; an Agent, an ISA, a TC: 404)
//
// Response time FROM ARRIVAL. Per inbound inquiry of the period: when it arrived, the first human attempt after
// that by ANYONE (the scoreboard's touch), who made it and in what role to the lead at that moment, the time from
// arrival in staffed and in wall-clock time, and whether an automated reply went out (shown apart, never counted).
// Rolled up by lead source: inquiries, with a human attempt, within 5 and 15 staffed minutes, the median and 90th
// percentile (never on a small sample), and still waiting. Every count travels with its denominator (R-ACC-4).
// b19 step 2 (R-TEAMQ-18): an inquiry whose minute-three backup alert was raised says when and to whom; each roll-up
// counts "backup alerted" over its inquiries and "first attempt by the backup" over those alerted.
//
// How it differs from the scoreboard's speed-to-lead: that number starts when an AGENT ACCEPTS a lead and credits
// the owner's (or a collaborator's) first touch per ownership period; a lead nobody accepted, or one sitting in a
// pond, never enters it. This one starts when the LEAD ARRIVES, counts every inquiry whoever holds the lead, and
// credits whoever actually made the attempt.
//
// Kept out of the measure, and said so: imports (not inquiries; counted apart), people a member typed in, ignored
// duplicate deliveries, and inquiries of people since closed (spam, not a lead, do not contact, merged), which are
// counted apart. READ-ONLY: nothing here writes, sends, alerts or reassigns.
import type { ContactId, Instant, LeadSourceId, UserId } from '@realty/core/foundation';
import { businessCalendar } from '@realty/core/foundation';
import {
  type AttemptKind,
  type AttemptRole,
  type MeasuredInquiry,
  RESPONSE_MEDIAN_MIN_SAMPLE,
  RESPONSE_P90_MIN_SAMPLE,
  RESPONSE_WITHIN_SECONDS,
  type ResponseInquiryFacts,
  type ResponseRollup,
  rollUpResponses,
} from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { iso, ms } from './common.js';
import * as repo from './repos/leadResponse.js';
import { RANGE_DAYS, type RangeKey, rangeBounds } from './repos/scoreboard.js';
import { staffedHours } from './repos/teamQueue.js';
import type { RangeView } from './scoreboard.js';

/** Inquiries listed in full (the newest); the roll-up always covers every inquiry read. */
export const RESPONSE_LIST_CAP = 200;

export interface ResponseInquiryView {
  inquiryId: string;
  contact: { id: string; name: string };
  sourceId: string;
  sourceName: string | null;
  /** the arrival: the one arrival instant (R-TEAMQ-19), never the source's claimed time alone */
  arrivedAt: string;
  /** it arrived outside staffed hours: staffed time counts from `countedFrom` (the next opening) */
  offHours: boolean;
  countedFrom: string;
  attempt: { at: string; kind: AttemptKind; by: { userId: string; name: string | null } | null; role: AttemptRole; wallSeconds: number; staffedSeconds: number } | null;
  /** no human attempt yet: how long it has waited */
  waiting: { wallSeconds: number; staffedSeconds: number } | null;
  /** when an automated reply went out after the arrival (null: none). Never an attempt. */
  automatedReplyAt: string | null;
  /** R-TEAMQ-18: this inquiry's minute-three backup alert: when, to whom, and whether to the backup or to the team lead in their place (null: nobody was alerted) */
  backupAlert: { at: string; to: { userId: string; name: string | null }; recipient: 'backup' | 'team_lead' | 'admins' } | null;
  within5: boolean;
  within15: boolean;
}

export interface LeadResponseView {
  range: RangeView;
  staffedHours: { open: string; close: string; zone: string };
  rules: { within5Seconds: number; within15Seconds: number; medianMinSample: number; p90MinSample: number };
  totals: ResponseRollup;
  sources: (ResponseRollup & { sourceId: string; sourceName: string | null; notWithin5: ResponseInquiryView[]; notWithin5More: number })[];
  /** the newest inquiries of the period, at most RESPONSE_LIST_CAP */
  inquiries: ResponseInquiryView[];
  inquiriesMore: number;
  /** people an import added in the period: not inquiries, never in the measure */
  imports: { people: number };
  /** inquiries of people since closed (spam, not a lead, do not contact, merged): left out of the measure */
  closedExcluded: number;
  /** the period holds more inquiries than one report reads: the numbers cover the newest ones only */
  truncated: boolean;
  generatedAt: string;
}

function kindOf(r: repo.InquiryResponseRow): AttemptKind {
  if (r.attempt_kind === 'call') return 'call';
  return r.attempt_channel === 'email' ? 'email' : r.attempt_channel === 'web_chat' ? 'chat' : 'text';
}

/** R-TEAMQ-18: the owner at that moment is `owner`; else the alerted backup, after the alert, is `backup`. */
function roleOf(r: repo.InquiryResponseRow): AttemptRole {
  if (r.attempt_by !== null && r.owner_then !== null && r.attempt_by === r.owner_then) return 'owner';
  if (r.backup_then) return 'backup';
  return r.collaborator_then ? 'collaborator' : 'other';
}

/** The lead response report for a range, as the caller may see it (read-only). */
export async function leadResponse(tx: Tx, key: RangeKey, now: Instant): Promise<LeadResponseView> {
  const b = await rangeBounds(tx, key, now);
  const [hours, rows, imported] = await Promise.all([staffedHours(tx), repo.inquiryResponses(tx, b.from, b.to, repo.RESPONSE_READ_CAP), repo.importedPeople(tx, b.from, b.to)]);
  const truncated = rows.length > repo.RESPONSE_READ_CAP;
  const read = rows.slice(0, repo.RESPONSE_READ_CAP);
  const open = read.filter((r) => r.ownership_state !== 'closed');
  const names = new Map(open.map((r) => [r.contact_id, r.contact_name] as const));
  const attemptNames = new Map<string, string | null>();
  const facts: ResponseInquiryFacts[] = open.map((r) => {
    if (r.attempt_by !== null) attemptNames.set(r.attempt_by, r.attempt_by_name);
    if (r.backup_alert_user !== null) attemptNames.set(r.backup_alert_user, r.backup_alert_name);
    return {
      inquiryId: r.id as never,
      contactId: r.contact_id as ContactId,
      sourceId: r.source_id as LeadSourceId,
      sourceName: r.source_name,
      arrivedAt: ms(r.arrived_at),
      firstAttempt: r.attempt_at === null ? null : { at: ms(r.attempt_at), kind: kindOf(r), byUserId: r.attempt_by as UserId | null, role: roleOf(r) },
      automatedReplyAt: r.automated_at === null ? null : ms(r.automated_at),
      backupAlert: r.backup_alert_at === null || r.backup_alert_user === null || r.backup_alert_recipient === null ? null : { at: ms(r.backup_alert_at), byUserId: r.backup_alert_user as UserId, recipient: r.backup_alert_recipient },
    };
  });
  const calendar = businessCalendar({ zone: hours.zone, open: hours.open, close: hours.close });
  const rolled = rollUpResponses(facts, now, calendar);
  const view = (m: MeasuredInquiry): ResponseInquiryView => ({
    inquiryId: m.inquiryId,
    contact: { id: m.contactId, name: names.get(m.contactId) ?? '' },
    sourceId: m.sourceId,
    sourceName: m.sourceName,
    arrivedAt: iso(m.arrivedAt),
    offHours: m.offHours,
    countedFrom: iso(m.countedFrom),
    attempt:
      m.attempt === null
        ? null
        : {
            at: iso(m.attempt.at),
            kind: m.attempt.kind,
            by: m.attempt.byUserId === null ? null : { userId: m.attempt.byUserId, name: attemptNames.get(m.attempt.byUserId) ?? null },
            role: m.attempt.role,
            wallSeconds: m.attempt.wallSeconds,
            staffedSeconds: m.attempt.staffedSeconds,
          },
    waiting: m.waiting,
    automatedReplyAt: m.automatedReplyAt === null ? null : iso(m.automatedReplyAt),
    backupAlert: m.backupAlert === null ? null : { at: iso(m.backupAlert.at), to: { userId: m.backupAlert.byUserId, name: attemptNames.get(m.backupAlert.byUserId) ?? null }, recipient: m.backupAlert.recipient },
    within5: m.within5,
    within15: m.within15,
  });
  // the facts are newest first (the read's order), and so is the list
  const listed = rolled.measured.slice(0, RESPONSE_LIST_CAP);
  return {
    range: { key, from: iso(b.from), to: iso(b.to), days: RANGE_DAYS[key], zone: b.zone },
    staffedHours: { open: hours.open, close: hours.close, zone: hours.zone },
    rules: { within5Seconds: RESPONSE_WITHIN_SECONDS[0], within15Seconds: RESPONSE_WITHIN_SECONDS[1], medianMinSample: RESPONSE_MEDIAN_MIN_SAMPLE, p90MinSample: RESPONSE_P90_MIN_SAMPLE },
    totals: rolled.totals,
    sources: rolled.sources.map(({ notWithin5, ...s }) => ({ ...s, notWithin5: notWithin5.map(view) })),
    inquiries: listed.map(view),
    inquiriesMore: rolled.measured.length - listed.length,
    imports: { people: imported },
    closedExcluded: read.length - open.length,
    truncated,
    generatedAt: iso(now),
  };
}
