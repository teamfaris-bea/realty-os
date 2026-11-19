// Pure helpers of the Team surface (exception queue, scoreboard, momentum). Unit-tested.
import type { EvidenceRefView, EvidenceSourceType } from '../../design/index.js';
import { formatAge, formatDays, formatDuration, formatStamp, plural } from '../admin/lib/format.js';
import type { ExceptionEvidence, ExceptionItem, ExceptionType, MomentumNorm, Scoreboard } from '../admin/lib/types.js';

export const TYPE_LABEL: Record<ExceptionType, string> = {
  untouched_lead: 'Untouched lead',
  overdue_promise: 'Overdue promise',
  failed_send: 'Message not delivered',
  missing_outcome: 'Consult missing an outcome',
  milestone_at_risk: 'Milestone at risk',
};

export const TYPE_PLURAL: Record<ExceptionType, string> = {
  untouched_lead: 'Untouched leads',
  overdue_promise: 'Overdue promises',
  failed_send: 'Not delivered',
  missing_outcome: 'Missing outcomes',
  milestone_at_risk: 'Dates at risk',
};

export const TYPES: readonly ExceptionType[] = ['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome', 'milestone_at_risk'];

const SOURCE_TYPES = new Set<EvidenceSourceType>(['call', 'message', 'email', 'note', 'listing', 'import', 'behavior_event', 'deal', 'task', 'appointment', 'ownership_period', 'message_status']);

/**
 * An untouched lead's facts belong to one ownership period: its owner's. Once that period is over, the card labels
 * them as the owner's earlier period, so nothing reads as a newer period's, and says why it ended: the lead moved
 * on (reassigned, released, closed, merged), or the owner kept it and a re-inquiry started their next period
 * (R-OWN-20). Only the server's explicit `movedOn: false` names a re-inquiry.
 */
export function periodLabel(item: Pick<ExceptionItem, 'itemType' | 'owner' | 'period'>): string | null {
  if (item.itemType !== 'untouched_lead' || !item.period) return null;
  const who = item.owner?.name ?? (item.owner ? 'A former member' : 'No owner');
  if (item.period.current) return `${who}'s ownership period`;
  return item.period.movedOn === false
    ? `${who}'s earlier ownership period (a new one started when the lead inquired again)`
    : `${who}'s earlier ownership period (the lead has moved on since)`;
}

/**
 * The server's period lines, said about the period's owner (the period label already says when it ended). Since owner
 * decision D8 the server names a chat reply among the touches and says whose touch is missing ("from the agent or a
 * collaborator": a Team Lead's reply is no touch, E311), which names the owner here; an item stored before D8 keeps
 * its earlier words.
 */
const missedBy = (o: string) => `No human call, text, email or chat reply from ${o} or a collaborator by the first-contact deadline`;
const PERIOD_LINE: Record<string, (owner: string) => string> = {
  'Lead became theirs': (o) => `Lead became ${o}'s`,
  'No human call, text, email or chat reply from the agent or a collaborator by the first-contact deadline': missedBy,
  'No human call, text, email or chat reply from the agent or a collaborator by the first-contact deadline; the lead later left this agent': missedBy,
  'First human call, text, email or chat reply from the agent or a collaborator came after the first-contact deadline': (o) =>
    `First human call, text, email or chat reply from ${o} or a collaborator came after the first-contact deadline`,
  'No human call, text or email by the first-contact deadline; the lead later left this agent': () => 'No human call, text or email by the first-contact deadline',
};

/**
 * Exception evidence (source + locator + snippet + short explanation, PII-free unless quoted) as the
 * design system's EvidenceRefView. The instant the evidence refers to is part of the explanation, so
 * "First touch was due · Nov 10, 2:14 PM" reads on its own. No score of any kind is carried over.
 * `owner`: an untouched lead's period owner, named in its period lines.
 */
export function exceptionEvidenceView(e: ExceptionEvidence, o: { owner?: string | null } = {}): EvidenceRefView {
  const sourceType = (SOURCE_TYPES.has(e.sourceType as EvidenceSourceType) ? e.sourceType : 'note') as EvidenceSourceType;
  const loc = (e.locator ?? {}) as { kind?: unknown; startMs?: unknown; endMs?: unknown; name?: unknown };
  const offset = e.link?.offsetMs ?? null;
  const locator =
    loc.kind === 'transcript_offset' && typeof loc.startMs === 'number'
      ? { kind: 'transcript_offset' as const, startMs: loc.startMs, endMs: typeof loc.endMs === 'number' ? loc.endMs : loc.startMs }
      : offset !== null
        ? { kind: 'transcript_offset' as const, startMs: offset, endMs: offset }
        : loc.kind === 'field' && typeof loc.name === 'string'
          ? { kind: 'field' as const, name: loc.name }
          : { kind: 'message' as const };
  const snippet = e.snippet?.trim();
  // an explanation that only restates the quote (the server labels quoted evidence with its quote line)
  // would show the same words twice; the quote line already says where it is from
  const restates = snippet ? e.explanation.includes(snippet) : false;
  const said = e.sourceType === 'ownership_period' && o.owner ? (PERIOD_LINE[e.explanation]?.(o.owner) ?? e.explanation) : e.explanation;
  const explanation = restates ? null : e.at ? `${said} · ${formatStamp(e.at)}` : said;
  return {
    sourceType,
    sourceId: e.link?.id ?? e.sourceId,
    contactId: e.link?.contactId ?? null,
    locator,
    ...(explanation ? { explanation } : {}),
    ...(snippet ? { snippet } : {}),
  };
}

/** "Ava Agent's · detected 3 h ago" style owner line. */
export function ownerName(item: Pick<ExceptionItem, 'owner'>): string {
  return item.owner?.name ?? (item.owner ? 'A former member' : 'No owner');
}

/** The verb a latest event is shown with. */
export const EVENT_LABEL = { resolved: 'Resolved', reassigned: 'Reassigned', verified: 'Verified', reopened: 'Reopened' } as const;

// ---- scoreboard (R-ACC-4: every number travels with its denominator) -----------------------------

/** One displayed metric: the number, what it is out of, and the words around it. */
export interface MetricLine {
  label: string;
  /** e.g. "12 of 14 within the first-touch window", "34 in 7 days" */
  text: string;
  /** a second, smaller line (e.g. the split of touches) */
  detail?: string;
}

export function daysWord(days: number): string {
  return days === 1 ? '1 day' : `${days} days`;
}

/**
 * The scoreboard as display lines. Every count says what it is out of: a share says "x of y", a
 * count over a period says "in N days", and a median says how many first touches it is the median of.
 */
export function scoreboardLines(s: Scoreboard): MetricLine[] {
  const stl = s.speedToLead;
  const median = stl.medianSeconds === null ? 'No first touches yet' : `Median ${formatDuration(stl.medianSeconds)} (of ${plural(stl.responded, 'first touch', 'first touches')})`;
  return [
    {
      // b18 review F2 (E724): a first touch is the first attempt (R-OWN-14: a call answered or not, a text, email or chat reply)
      label: 'Speed to lead (first attempt)',
      text: `${stl.withinSla} of ${stl.total} within the first-touch window`,
      detail: stl.pending > 0 ? `${median} · ${stl.pending} still waiting` : median,
    },
    // R-TEAMQ-23: the backup made the first touch (after the backup alert): shown apart, never as this member's own response
    ...((stl.byBackup ?? 0) > 0
      ? [{ label: 'First touch by the backup', text: `${stl.byBackup ?? 0} of ${stl.total + (stl.byBackup ?? 0)} first touched by the backup`, detail: 'The backup reached out first, after the backup alert. Not counted above as their own response, and not held against them.' }]
      : []),
    // a reply in the website chat is a touch (owner decision D8) and is counted with the texts and emails. b18 item g
    // (E724, owner 2026-11-14): a touch is an ATTEMPT (app.scoreboard_activity counts every outbound call a person
    // placed, whatever its status, and every text, email or chat reply they sent), never a connected conversation
    { label: 'Touches (attempts)', text: `${s.touches.count} in ${daysWord(s.touches.days)}`, detail: `${plural(s.touches.calls, 'call attempt')} (answered or not) · ${s.touches.textsAndEmails} texts, emails and chat replies sent` },
    { label: 'Appointments set', text: `${s.appointmentsSet.count} in ${daysWord(s.appointmentsSet.days)}` },
    { label: 'Appointments held', text: `${s.appointmentsHeld.count} of ${s.appointmentsHeld.of} held` },
    { label: 'Agreements signed', text: `${s.agreementsSigned.count} in ${daysWord(s.agreementsSigned.days)}` },
  ];
}

/** "Usually 9 days here (median of 12 deals)", or why there is no comparison yet. */
export function normLine(norm: MomentumNorm | null, minSample: number): string {
  if (!norm || !norm.enough) return `Not enough team history to compare yet (${norm?.sample ?? 0} of ${minSample} deals needed)`;
  return `Team median ${formatDays(norm.medianDays)} (of ${plural(norm.sample, 'deal')})`;
}

// ---- the team work queue (b19 team-queue lane; GET /team/queue, read-only) ----------------------------------

export type TeamQueueGroupKey = 'new_lead' | 'unanswered_reply' | 'due_promise' | 'overdue_follow_up' | 'appointment_outcome';

export interface TeamQueueRow {
  key: string;
  contact: { id: string; name: string };
  source: string | null;
  /** `owner`: the lead's owner, or the member a task or appointment is on; anything else is "no owner yet" */
  owner: { kind: 'owner' | 'on_offer' | 'pond' | 'unassigned'; userId: string | null; name: string | null; pondId: string | null; label: string };
  /** the server's sentence: why this row is here */
  why: string;
  since: string;
  waitingSeconds: number;
  /** new leads only: the same wait inside staffed hours */
  staffedSeconds: number | null;
  offHours: boolean;
  /**
   * new leads only (b19 step 2, R-TEAMQ-18): the minute-three backup alert, as the server's own line ("Backup
   * alerted at 2:06 PM: Sam T.", the time in the team's zone); `alerted` false: nobody could be alerted
   */
  backupAlert?: { at: string; alerted: boolean; recipient?: 'backup' | 'team_lead' | 'admins' | null; line: string } | null;
  /** new leads only (R-TEAMQ-22): when a person answered the lead's own call since it arrived (the why line says so) */
  answeredCallAt?: string | null;
  /** new leads only (R-TEAMQ-27): when a person's send to them was last reported failed (the why line says "tried … but the text failed") */
  failedAttemptAt?: string | null;
}

export interface TeamQueueGroup {
  key: TeamQueueGroupKey;
  label: string;
  empty: string;
  rows: TeamQueueRow[];
  total: number;
  more: number;
  /** the server's read reached its cap: total and more are lower bounds */
  atLeast: boolean;
  /** new_lead only (R-TEAMQ-18): of `total`, the rows whose backup was alerted; null for the other groups */
  backupAlerted?: number | null;
  /** new_lead only (R-TEAMQ-25): of `total`, the rows whose alert went to a team lead or to the Owners and Admins instead */
  othersAlerted?: number | null;
  /** new_lead only (R-TEAMQ-22): of `total`, the rows whose own call a person answered; null for the other groups */
  answeredCalls?: number | null;
  /** new_lead only (R-TEAMQ-27): of `total`, the rows where a person tried and the send was reported failed */
  failedAttempts?: number | null;
}

export interface TeamQueueResponse {
  groups: TeamQueueGroup[];
  staffedHours: { open: string; close: string; zone: string };
  windows: { newLeadDays: number; replyDays: number; taskDays: number; appointmentDays: number };
  generatedAt: string;
}

/** "32", or "at least 500" when the server's read was capped. */
export function queueCount(g: Pick<TeamQueueGroup, 'total' | 'atLeast'>): string {
  return g.atLeast ? `at least ${g.total}` : String(g.total);
}

/** How long a row has waited, in the words of its group; a new lead's staffed time is said apart when it differs. */
export function queueWait(key: TeamQueueGroupKey, r: Pick<TeamQueueRow, 'waitingSeconds' | 'staffedSeconds'>): string {
  const wait = formatAge(r.waitingSeconds);
  if (key === 'due_promise' || key === 'overdue_follow_up') return `Past due ${wait}`;
  if (key === 'appointment_outcome') return `Ended ${wait} ago`;
  const staffed = r.staffedSeconds !== null && r.waitingSeconds - r.staffedSeconds >= 60 ? ` · ${formatAge(r.staffedSeconds)} in staffed hours` : '';
  return `Waiting ${wait}${staffed}`;
}

/**
 * "Backup alerted for 2 of 5." and, apart, "A team lead or the Owners and Admins were alerted instead for 1 of 5."
 * (R-TEAMQ-18, R-TEAMQ-25: an alert that did not go to the backup is never counted as the backup's; each count with
 * its denominator; null when no row was alerted)
 */
export function queueBackupLine(g: Pick<TeamQueueGroup, 'total' | 'atLeast' | 'backupAlerted' | 'othersAlerted'>): string | null {
  const parts: string[] = [];
  if ((g.backupAlerted ?? 0) > 0) parts.push(`Backup alerted for ${g.backupAlerted} of ${queueCount(g)}.`);
  if ((g.othersAlerted ?? 0) > 0) parts.push(`A team lead or the Owners and Admins were alerted instead for ${g.othersAlerted} of ${queueCount(g)}.`);
  return parts.length === 0 ? null : parts.join(' ');
}

/** "A person answered the call of 1 of 5; nobody has called back, texted or emailed." (R-TEAMQ-22; null when no row's call was answered) */
export function queueAnsweredLine(g: Pick<TeamQueueGroup, 'total' | 'atLeast' | 'answeredCalls'>): string | null {
  if (g.answeredCalls === undefined || g.answeredCalls === null || g.answeredCalls <= 0) return null;
  return `A person answered the call of ${g.answeredCalls} of ${queueCount(g)}; nobody has called back, texted or emailed.`;
}

/** "A person tried 1 of 5, but the text or email failed." (R-TEAMQ-27; null when no row has a failed send) */
export function queueFailedLine(g: Pick<TeamQueueGroup, 'total' | 'atLeast' | 'failedAttempts'>): string | null {
  if (g.failedAttempts === undefined || g.failedAttempts === null || g.failedAttempts <= 0) return null;
  return `A person tried ${g.failedAttempts} of ${queueCount(g)}, but the text or email failed.`;
}

/** "Showing the 25 waiting longest. 7 more are not shown." (null when everything is shown) */
export function queueMoreLine(g: Pick<TeamQueueGroup, 'rows' | 'more' | 'atLeast'>): string | null {
  if (g.more <= 0) return null;
  return `Showing the ${g.rows.length} waiting longest. ${g.atLeast ? `At least ${g.more}` : g.more} more ${g.more === 1 && !g.atLeast ? 'is' : 'are'} not shown.`;
}

/** "08:00" → "8:00 AM", "21:00" → "9:00 PM" (a wall-clock time of the team's zone: no Date, no viewer zone). */
export function clock12(hhmm: string): string {
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm);
  if (!m) return hhmm;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 || h === 24 ? 'AM' : 'PM'}`;
}

/** The footer line: when it was checked, the staffed hours and how far back each group looks. */
export function queueFootnote(q: Pick<TeamQueueResponse, 'generatedAt' | 'staffedHours' | 'windows'>): string {
  const w = q.windows;
  const replies = w.replyDays === w.newLeadDays ? `${plural(w.newLeadDays, 'day')} for new leads and replies` : `${plural(w.newLeadDays, 'day')} for new leads, ${plural(w.replyDays, 'day')} for replies`;
  return `Checked ${formatStamp(q.generatedAt)}. Staffed hours are ${clock12(q.staffedHours.open)} to ${clock12(q.staffedHours.close)} (${q.staffedHours.zone}). Looks back ${replies}, ${plural(w.taskDays, 'day')} for promises and follow-ups, ${plural(w.appointmentDays, 'day')} for appointments.`;
}

// ---- the lead response report (b19 team-queue lane; GET /team/lead-response, read-only) ----------------------

export interface ResponseInquiry {
  inquiryId: string;
  contact: { id: string; name: string };
  sourceId: string;
  sourceName: string | null;
  arrivedAt: string;
  /** it arrived outside staffed hours: staffed time counts from `countedFrom` */
  offHours: boolean;
  countedFrom: string;
  attempt: { at: string; kind: 'call' | 'text' | 'email' | 'chat'; by: { userId: string; name: string | null } | null; role: 'owner' | 'backup' | 'team_lead' | 'admin' | 'collaborator' | 'other'; failed?: boolean; wallSeconds: number; staffedSeconds: number } | null;
  /** R-TEAMQ-22: a person answered the lead's own call since it arrived (never an attempt): when, by whom, how long after the arrival */
  answeredCall?: { at: string; by: { userId: string; name: string | null } | null; wallSeconds: number; staffedSeconds: number } | null;
  /** R-TEAMQ-22: attempted, else answered_call, else waiting */
  state?: 'attempted' | 'answered_call' | 'waiting';
  waiting: { wallSeconds: number; staffedSeconds: number } | null;
  automatedReplyAt: string | null;
  /** b19 step 2 (R-TEAMQ-18): the inquiry's minute-three backup alert: when, to whom, and whether to the backup or to the team lead in their place */
  backupAlert?: { at: string; to: { userId: string; name: string | null }; recipient: 'backup' | 'team_lead' | 'admins' } | null;
  within5: boolean;
  within15: boolean;
}

export interface ResponseRollup {
  inquiries: number;
  attempted: number;
  /** R-TEAMQ-27: of `attempted`, those whose first attempt was a send the provider reported as failed */
  failedAttempts?: number;
  within5: number;
  within15: number;
  /** R-TEAMQ-22: no human attempt, and a person answered the lead's own call */
  answeredCalls?: number;
  waiting: number;
  automatedReplies: number;
  /** R-TEAMQ-18: inquiries whose backup alert was raised (of `inquiries`), and of those, first tried by the alerted person */
  backupAlerted?: number;
  byBackup?: number;
  /** R-TEAMQ-25: alerts that went to a team lead in the backup's place (and of those, first tried by that team lead), or to the Owners and Admins */
  teamLeadAlerted?: number;
  byTeamLead?: number;
  adminsAlerted?: number;
  sample: number;
  medianStaffedSeconds: number | null;
  p90StaffedSeconds: number | null;
}

export interface ResponseRules {
  within5Seconds: number;
  within15Seconds: number;
  medianMinSample: number;
  p90MinSample: number;
}

export interface LeadResponseReport {
  range: { key: 'today' | '7d' | '30d' | '90d'; from: string; to: string; days: number; zone: string };
  staffedHours: { open: string; close: string; zone: string };
  rules: ResponseRules;
  totals: ResponseRollup;
  sources: (ResponseRollup & { sourceId: string; sourceName: string | null; notWithin5: ResponseInquiry[]; notWithin5More: number })[];
  inquiries: ResponseInquiry[];
  inquiriesMore: number;
  imports: { people: number };
  closedExcluded: number;
  /** R-TEAMQ-28: inquiries of people since deleted: left out of the measure */
  deletedExcluded?: number;
  truncated: boolean;
  generatedAt: string;
}

/** One line: how the report differs from the scoreboard's speed to lead. */
export const FROM_ARRIVAL_LINE =
  'From arrival: the clock starts when a lead arrives and stops at the first call, text, email or chat reply a person makes, whoever makes it. Speed to lead above starts only when an agent accepts the lead.';

const minutes = (seconds: number): number => Math.round(seconds / 60);

function percentileLine(seconds: number | null, sample: number, min: number): string {
  // never a percentile on a small sample: the server sends null below the minimum, and the sample size is always said
  if (seconds === null || sample < min) return `Not shown: ${sample} of the ${min} attempts it needs`;
  return `${formatDuration(seconds)} (of ${plural(sample, 'attempt')})`;
}

/** A roll-up's lines. Every count is "x of y" inquiries (R-ACC-4); a percentile comes with its sample or not at all. */
export function responseLines(r: ResponseRollup, rules: ResponseRules): { label: string; text: string }[] {
  const of = (n: number) => `${n} of ${r.inquiries}`;
  return [
    { label: 'Inquiries', text: plural(r.inquiries, 'inquiry', 'inquiries') },
    { label: 'With a human attempt', text: of(r.attempted) },
    // R-TEAMQ-27: a failed send is still the attempt (the scoreboard's definition), and is said
    ...((r.failedAttempts ?? 0) <= 0 ? [] : [{ label: 'Tried, but the text or email failed', text: `${r.failedAttempts} of the ${r.attempted} with an attempt` }]),
    { label: `Within ${minutes(rules.within5Seconds)} minutes`, text: of(r.within5) },
    { label: `Within ${minutes(rules.within15Seconds)} minutes`, text: of(r.within15) },
    // R-TEAMQ-22: its own state: never an attempt, never "still waiting"
    ...(r.answeredCalls === undefined ? [] : [{ label: 'A person answered their call', text: `${of(r.answeredCalls)}, not counted as an attempt: nobody has called back, texted or emailed` }]),
    { label: 'Still waiting', text: of(r.waiting) },
    { label: 'Median to the first attempt', text: percentileLine(r.medianStaffedSeconds, r.sample, rules.medianMinSample) },
    { label: '90th percentile', text: percentileLine(r.p90StaffedSeconds, r.sample, rules.p90MinSample) },
    { label: 'Automatic replies', text: `${of(r.automatedReplies)}, shown apart and never counted as an attempt` },
    // R-TEAMQ-18: the minute-three backup alert, each count with its own denominator
    ...(r.backupAlerted === undefined ? [] : [{ label: 'Backup alerted', text: of(r.backupAlerted) }]),
    ...(r.backupAlerted === undefined || r.backupAlerted <= 0 ? [] : [{ label: 'First attempt by the backup', text: `${r.byBackup ?? 0} of the ${r.backupAlerted} alerted` }]),
    // R-TEAMQ-25: an alert that went to someone else in the backup's place is its own line, never "backup alerted"
    ...((r.teamLeadAlerted ?? 0) <= 0 ? [] : [{ label: 'Team lead alerted instead of the backup', text: of(r.teamLeadAlerted ?? 0) }, { label: 'First attempt by that team lead', text: `${r.byTeamLead ?? 0} of the ${r.teamLeadAlerted} alerted` }]),
    ...((r.adminsAlerted ?? 0) <= 0 ? [] : [{ label: 'Owners and Admins alerted (no team lead to tell)', text: of(r.adminsAlerted ?? 0) }]),
  ];
}

const ATTEMPT_KIND: Record<NonNullable<ResponseInquiry['attempt']>['kind'], string> = { call: 'a call', text: 'a text', email: 'an email', chat: 'a chat reply' };
const ATTEMPT_ROLE: Record<NonNullable<ResponseInquiry['attempt']>['role'], string> = {
  owner: 'the lead’s owner',
  backup: 'the backup, after the backup alert',
  // R-TEAMQ-25: alerted in the backup's place: said as who they are, never as "the backup"
  team_lead: 'the team lead, after the alert went to them in the backup’s place',
  admin: 'an Owner or Admin, after the alert went to the Owners and Admins',
  collaborator: 'a collaborator on the lead',
  other: 'who was not the owner',
};

/** R-TEAMQ-18: " The backup, Sam T., was alerted 3 min after it arrived." ('' when nobody was alerted). */
function backupAlertSentence(i: ResponseInquiry): string {
  const b = i.backupAlert;
  if (!b) return '';
  const after = formatAge(Math.max(0, Math.round((Date.parse(b.at) - Date.parse(i.arrivedAt)) / 1000)));
  const who = b.to.name ?? 'a former member';
  if (b.recipient === 'admins') return ` There was no backup or team lead to alert, so the team's Owners and Admins were alerted (${who} among them) ${after} after it arrived.`;
  return b.recipient === 'team_lead' ? ` The source's backup was unavailable, so the team lead, ${who}, was alerted ${after} after it arrived.` : ` The backup, ${who}, was alerted ${after} after it arrived.`;
}

/** What happened to one inquiry, in a sentence or two: still waiting, or who tried, how, in what role and after how long. */
export function responseInquiryLine(i: ResponseInquiry): string {
  const auto = i.automatedReplyAt ? ` An automatic reply went out ${formatStamp(i.automatedReplyAt)}; it is not counted.` : ' No automatic reply went out.';
  const alert = backupAlertSentence(i);
  const answered = i.answeredCall ? `A person${i.answeredCall.by?.name ? `, ${i.answeredCall.by.name},` : ''} answered their call ${formatStamp(i.answeredCall.at)}.` : '';
  if (i.attempt === null && i.answeredCall) {
    // R-TEAMQ-22: never "no person has tried", never an attempt
    return `${answered} Nobody has called back, texted or emailed since. It is not counted as an attempt.${alert}${auto}`;
  }
  if (i.attempt === null) {
    const w = i.waiting ?? { wallSeconds: 0, staffedSeconds: 0 };
    const off = i.offHours ? ` (${formatAge(w.staffedSeconds)} of staffed time: it arrived outside staffed hours and is counted from opening)` : '';
    return `Still waiting after ${formatAge(w.wallSeconds)}${off}. No person has tried yet.${alert}${auto}`;
  }
  const a = i.attempt;
  const off = i.offHours ? ` It arrived outside staffed hours, so it is counted from opening (${formatAge(a.wallSeconds)} on the clock).` : '';
  // R-TEAMQ-27: tried, but the send failed: still the attempt, and said
  const failed = a.failed === true ? ` Tried, but the ${a.kind === 'email' ? 'email' : a.kind === 'chat' ? 'chat reply' : 'text'} failed: it did not reach them.` : '';
  return `First tried after ${formatAge(a.staffedSeconds)}: ${ATTEMPT_KIND[a.kind]} by ${a.by?.name ?? 'a former member'}, ${ATTEMPT_ROLE[a.role]}.${failed}${off}${answered === '' ? '' : ` ${answered}`}${alert}${auto}`;
}

/** The lines under the report: imports and closed people apart, and the rules of the measure. */
export function responseFootnotes(r: Pick<LeadResponseReport, 'imports' | 'closedExcluded' | 'deletedExcluded' | 'staffedHours' | 'rules'>): string[] {
  const out = [
    r.imports.people > 0
      ? `${plural(r.imports.people, 'person', 'people')} came in by import in this period. They are not inquiries and are not measured here.`
      : 'No one came in by import in this period.',
  ];
  if (r.closedExcluded > 0) {
    out.push(
      r.closedExcluded === 1
        ? '1 inquiry from a person since closed (spam, not a lead, do not contact or merged) is left out.'
        : `${r.closedExcluded} inquiries from people since closed (spam, not a lead, do not contact or merged) are left out.`,
    );
  }
  // R-TEAMQ-28: a deleted person's inquiry is left out too, and said
  const deleted = r.deletedExcluded ?? 0;
  if (deleted > 0) out.push(deleted === 1 ? '1 inquiry from a person since deleted is left out.' : `${deleted} inquiries from people since deleted are left out.`);
  out.push(
    `Minutes are staffed time: ${clock12(r.staffedHours.open)} to ${clock12(r.staffedHours.close)} (${r.staffedHours.zone}). A lead that arrives outside those hours is counted from opening. A median is shown from ${plural(r.rules.medianMinSample, 'attempt')} and a 90th percentile from ${r.rules.p90MinSample}.`,
  );
  return out;
}
