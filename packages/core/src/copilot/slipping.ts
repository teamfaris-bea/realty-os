// Slipping-lead flags (CP-5, CP-6, CP-7): the rules of the shared playbooks "slipping-lead-recovery" and
// "speed-to-lead-playbook", made deterministic so every flag can be explained and tested.
//
//   SPEED_TO_LEAD_OPEN     a new lead with no human touch yet, still inside its target (watch)
//   SPEED_TO_LEAD_MISSED   past target: 5 min in business hours (8a-7p team zone), 15 min after hours;
//                          past 30 min it escalates to the sales manager and the chief of staff
//   NO_ACTIVITY_48H        an assigned lead with no human touch for 48 business-day hours (Mon-Fri)
//   NO_NEXT_STEP           a working buyer or seller with no next step
//   NEXT_STEP_OVERDUE      a next step past its due time
//   REPLY_NOT_RECONTACTED  the lead replied and nobody got back to them (watch, then at risk at 24 h)
//   DORMANT_SIGNAL         a past client or quiet lead (no touch in 30 days) visited the site, opened an
//                          email or gave a new timing cue in the last 7 days, untouched since
//   HOT_NOT_CONFIRMED      hot, or an appointment set, with no confirmation or follow-up
//   TIMING_WINDOW_OPEN     the lead's stated move window is now (or within 90 days) and no touch in 7 days
//   NO_ASSIGNED_AGENT      a workable lead with nobody assigned
//   NO_CONTACT_CHANNEL     no reachable phone or email (DATA GAP)
//
// Re-surface rule (CP-6): a flag still open 48 hours after it was first flagged comes back as AT RISK.
// Flags are advice: nothing here contacts, reassigns or changes a stage (CP-1).
import {
  DAY_MS,
  HOUR_MS,
  type Instant,
  MINUTE_MS,
  businessCalendar,
  businessMsBetween,
  instant,
  isBusinessOpen,
  nextOpening,
  type BusinessCalendar,
} from '../foundation/index.js';
import { chronological, isHumanTouch, isInboundReply, isInterestSignal, lastWhere } from './history.js';
import { timingStatus } from './timing.js';
import type { CopilotInput, CopilotPolicy, LeadSource, LeadStageClass, SlipCode, SlipFlag, SlipSeverity } from './types.js';

export const SPEED_TARGET_BUSINESS_MS = 5 * MINUTE_MS;
export const SPEED_TARGET_AFTER_HOURS_MS = 15 * MINUTE_MS;
export const SPEED_ESCALATE_MS = 30 * MINUTE_MS;
export const NO_ACTIVITY_BUSINESS_MS = 48 * HOUR_MS;
export const REPLY_RECONTACT_MS = 24 * HOUR_MS;
export const HOT_FOLLOW_UP_MS = 24 * HOUR_MS;
export const DORMANT_AFTER_MS = 30 * DAY_MS;
export const SIGNAL_RECENT_MS = 7 * DAY_MS;
export const TIMING_TOUCH_GAP_MS = 7 * DAY_MS;
export const TIMING_LOOKAHEAD_DAYS = 90;
export const RESURFACE_AFTER_MS = 48 * HOUR_MS;

/** Stages an agent is expected to be working. */
const WORKING: ReadonlySet<LeadStageClass> = new Set(['new', 'active', 'appointment', 'under_contract']);
/** Buyer/seller stages that need a next step. */
const NEEDS_NEXT_STEP: ReadonlySet<LeadStageClass> = new Set(['active', 'appointment', 'under_contract']);
const QUIET_STAGES: ReadonlySet<LeadStageClass> = new Set(['nurture', 'past_client']);

export interface SlipCalendars {
  /** speed-to-lead business hours (playbook 8a-7p, every day) */
  speed: BusinessCalendar;
  /** "48 hours (business days)": whole Mon-Fri days in the team zone */
  weekdays: BusinessCalendar;
}

export function slipCalendars(p: CopilotPolicy): SlipCalendars {
  return {
    speed: businessCalendar({ zone: p.zone, open: p.businessOpen, close: p.businessClose }),
    weekdays: businessCalendar({ zone: p.zone, open: '00:00', close: '24:00', days: [1, 2, 3, 4, 5] }),
  };
}

const RANK: Record<SlipSeverity, number> = { watch: 0, at_risk: 1, escalate: 2 };

function hoursText(ms: number): string {
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / MINUTE_MS))} min`;
  if (ms < 2 * DAY_MS) return `${Math.round(ms / HOUR_MS)} h`;
  return `${Math.round(ms / DAY_MS)} days`;
}

export function computeSlipFlags(input: CopilotInput, policy: CopilotPolicy, now: Instant): SlipFlag[] {
  const { lead } = input;
  if (lead.stage === 'closed' || lead.stage === 'trash' || lead.doNotContact) return [];
  const cal = slipCalendars(policy);
  const acts = chronological(input.activities, now);
  const lastTouch = lastWhere(acts, isHumanTouch);
  const dueToday = isBusinessOpen(now, cal.speed) ? now : nextOpening(now, cal.speed);
  const flags: SlipFlag[] = [];
  const add = (f: Omit<SlipFlag, 'resurfaced' | 'escalateTo' | 'label'> & Partial<Pick<SlipFlag, 'escalateTo' | 'label'>>): void => {
    flags.push({ label: 'CONFIRMED', escalateTo: [], resurfaced: false, ...f });
  };
  const working = WORKING.has(lead.stage);

  // speed to lead: a lead nobody has touched since it arrived (imports are not new inbound leads)
  const neverTouched = lastTouch === null;
  if (working && neverTouched && lead.source !== 'import') {
    const inHours = isBusinessOpen(lead.createdAt, cal.speed);
    const target = inHours ? SPEED_TARGET_BUSINESS_MS : SPEED_TARGET_AFTER_HOURS_MS;
    const elapsed = now - lead.createdAt;
    if (elapsed <= target) {
      add({
        code: 'SPEED_TO_LEAD_OPEN',
        severity: 'watch',
        why: `New lead ${hoursText(Math.max(elapsed, MINUTE_MS))} ago, no first response yet.`,
        nextAction: 'Send the first text now, then call if no reply in 10 minutes.',
        dueBy: instant(lead.createdAt + target),
        since: lead.createdAt,
      });
    } else {
      const escalate = elapsed > SPEED_ESCALATE_MS;
      add({
        code: 'SPEED_TO_LEAD_MISSED',
        severity: escalate ? 'escalate' : 'at_risk',
        why: `No human response ${hoursText(elapsed)} after the lead arrived (target ${inHours ? '5' : '15'} min).`,
        nextAction: inHours || isBusinessOpen(now, cal.speed) ? 'Send the first text now, then call.' : 'First thing in the morning: text, then call.',
        dueBy: dueToday,
        since: instant(lead.createdAt + target),
        escalateTo: escalate ? ['sales_manager', 'chief_of_staff'] : [],
      });
    }
  }

  // 48 business-day hours with no human touch (for never-touched new leads speed-to-lead says it already)
  if (working && lead.assignedAgent !== null && (lastTouch !== null || lead.source === 'import')) {
    const from = lastTouch?.at ?? lead.createdAt;
    if (businessMsBetween(from, now, cal.weekdays) >= NO_ACTIVITY_BUSINESS_MS) {
      add({
        code: 'NO_ACTIVITY_48H',
        severity: 'at_risk',
        why: lastTouch ? `No call, text or email in ${hoursText(now - from)}.` : `Assigned ${hoursText(now - from)} ago and never contacted.`,
        nextAction: 'Call today; if no answer, send the draft text.',
        dueBy: dueToday,
        since: from,
      });
    }
  }

  if (NEEDS_NEXT_STEP.has(lead.stage)) {
    if (lead.nextStep === null) {
      add({ code: 'NO_NEXT_STEP', severity: 'watch', why: 'No next step is set.', nextAction: 'Set one dated next step after the next conversation.', dueBy: dueToday, since: lastTouch?.at ?? lead.createdAt });
    } else if (lead.nextStep.dueAt !== null && lead.nextStep.dueAt < now) {
      add({ code: 'NEXT_STEP_OVERDUE', severity: 'at_risk', why: `Next step overdue by ${hoursText(now - lead.nextStep.dueAt)}.`, nextAction: 'Do the next step today or reset its date.', dueBy: dueToday, since: lead.nextStep.dueAt });
    }
  }

  // the lead replied and nobody got back to them
  const lastInbound = lastWhere(acts, isInboundReply);
  if (lastInbound !== null && (lastTouch === null || lastTouch.at < lastInbound.at)) {
    const waited = now - lastInbound.at;
    const late = waited >= REPLY_RECONTACT_MS;
    add({
      code: 'REPLY_NOT_RECONTACTED',
      severity: late ? 'at_risk' : 'watch',
      why: `The lead replied ${hoursText(Math.max(waited, MINUTE_MS))} ago and has not heard back.`,
      nextAction: 'Answer their reply first, then offer one next step.',
      dueBy: late ? dueToday : instant(lastInbound.at + REPLY_RECONTACT_MS),
      since: lastInbound.at,
    });
  }

  // a quiet lead woke up
  const quiet = QUIET_STAGES.has(lead.stage) || (lastTouch !== null && now - lastTouch.at >= DORMANT_AFTER_MS);
  if (quiet) {
    const afterTouch = (t: Instant): boolean => lastTouch === null || t > lastTouch.at;
    const signal = lastWhere(acts, (a) => isInterestSignal(a) && now - a.at <= SIGNAL_RECENT_MS && afterTouch(a.at));
    const cue = input.timingCues
      .filter((c) => c.excluded === undefined && c.statedAt <= now && now - c.statedAt <= SIGNAL_RECENT_MS && afterTouch(c.statedAt))
      .sort((a, b) => b.statedAt - a.statedAt)[0];
    const at = Math.max(signal?.at ?? -Infinity, cue?.statedAt ?? -Infinity);
    if (Number.isFinite(at)) {
      const what = cue !== undefined && cue.statedAt === at ? 'gave a new move timing' : signal?.kind === 'email_open' ? 'opened an email' : 'visited the website';
      add({
        code: 'DORMANT_SIGNAL',
        severity: 'at_risk',
        why: `Quiet lead ${what} ${hoursText(Math.max(now - at, MINUTE_MS))} ago.`,
        nextAction: 'Reach out today while they are looking.',
        dueBy: dueToday,
        since: instant(at),
        label: cue !== undefined && cue.statedAt === at ? 'UNVERIFIED' : 'CONFIRMED',
      });
    }
  }

  // hot or appointment set, without confirmation or follow-up
  if (working && (lead.hot || lead.appointment !== null)) {
    const appt = lead.appointment;
    const touchedRecently = lastTouch !== null && now - lastTouch.at < HOT_FOLLOW_UP_MS;
    const unconfirmed = appt !== null && !appt.confirmed && appt.at > now && !touchedRecently;
    const noFollowUp = appt !== null && appt.at <= now && (lastTouch === null || lastTouch.at <= appt.at) && now - appt.at >= HOT_FOLLOW_UP_MS;
    const hotCold = lead.hot && appt === null && !touchedRecently;
    if (unconfirmed || noFollowUp || hotCold) {
      add({
        code: 'HOT_NOT_CONFIRMED',
        severity: 'at_risk',
        why: unconfirmed ? 'Appointment set but not confirmed.' : noFollowUp ? 'No follow-up after the appointment.' : 'Marked hot with no touch in 24 h.',
        nextAction: unconfirmed ? 'Confirm the appointment time today.' : 'Follow up today with one clear next step.',
        dueBy: dueToday,
        since: appt?.at !== undefined && noFollowUp ? appt.at : (lastTouch?.at ?? lead.createdAt),
      });
    }
  }

  // stated move window is open, nobody has called in a week
  if (lead.stage !== 'under_contract' && (lastTouch === null || now - lastTouch.at >= TIMING_TOUCH_GAP_MS)) {
    const live = input.timingCues
      .filter((c) => c.excluded === undefined && c.statedAt <= now)
      .map((c) => ({ c, s: timingStatus(c, now, policy.zone, TIMING_LOOKAHEAD_DAYS) }))
      .filter((x) => x.s === 'current' || x.s === 'soon');
    const best = live.find((x) => x.s === 'current') ?? live[0];
    if (best !== undefined) {
      add({
        code: 'TIMING_WINDOW_OPEN',
        severity: best.s === 'current' ? 'at_risk' : 'watch',
        why: best.s === 'current' ? `Their stated ${best.c.intent} window is now.` : `Their stated ${best.c.intent} window starts within ${TIMING_LOOKAHEAD_DAYS} days.`,
        nextAction: 'Call to confirm timing and set the next step.',
        dueBy: dueToday,
        since: best.c.statedAt,
        label: 'UNVERIFIED',
      });
    }
  }

  if (working && lead.assignedAgent === null) {
    add({ code: 'NO_ASSIGNED_AGENT', severity: 'at_risk', why: 'Nobody is assigned.', nextAction: 'Ask the team lead to assign it.', dueBy: dueToday, since: lead.createdAt });
  }
  if (!lead.reachable.sms && !lead.reachable.email) {
    add({ code: 'NO_CONTACT_CHANNEL', severity: 'watch', why: 'No reachable phone or email on file.', nextAction: 'Find a working phone or email.', dueBy: dueToday, since: lead.createdAt, label: 'DATA_GAP' });
  }

  return resurface(flags, input.priorFlags ?? [], now);
}

/** CP-6: still open 48 h after it was first flagged ⇒ AT RISK (never lowers an escalation). */
export function resurface(flags: readonly SlipFlag[], prior: readonly { code: SlipCode; firstFlaggedAt: Instant }[], now: Instant): SlipFlag[] {
  return flags.map((f) => {
    const p = prior.filter((x) => x.code === f.code).sort((a, b) => a.firstFlaggedAt - b.firstFlaggedAt)[0];
    if (p === undefined || now - p.firstFlaggedAt < RESURFACE_AFTER_MS) return f;
    return { ...f, resurfaced: true, severity: RANK[f.severity] >= RANK.at_risk ? f.severity : 'at_risk', since: instant(Math.min(f.since, p.firstFlaggedAt)) };
  });
}

/** slipping-lead-recovery ranking: source quality order (best first). */
export const SOURCE_QUALITY: readonly LeadSource[] = ['referral', 'past_client', 'website', 'google_ads', 'open_house', 'portal', 'manual', 'other', 'import'];

export interface RankEntry {
  leadId: string;
  flags: readonly SlipFlag[];
  source: LeadSource;
  /** the most recent lead-side activity (reply, visit, open, new timing cue) */
  lastLeadActivityAt: Instant | null;
  lastHumanTouchAt: Instant | null;
  estimatedValue: number | null;
}

/**
 * The daily list order: worst severity first, then the playbook's ranking: recent activity > source quality >
 * days since last contact > estimated value. Leads without flags are dropped.
 */
export function rankSlipping(entries: readonly RankEntry[]): RankEntry[] {
  const sev = (e: RankEntry): number => Math.max(...e.flags.map((f) => RANK[f.severity]));
  return entries
    .filter((e) => e.flags.length > 0)
    .slice()
    .sort((a, b) =>
      sev(b) - sev(a)
      || (b.lastLeadActivityAt ?? -Infinity) - (a.lastLeadActivityAt ?? -Infinity)
      || SOURCE_QUALITY.indexOf(a.source) - SOURCE_QUALITY.indexOf(b.source)
      || (a.lastHumanTouchAt ?? -Infinity) - (b.lastHumanTouchAt ?? -Infinity)
      || (b.estimatedValue ?? 0) - (a.estimatedValue ?? 0)
      || a.leadId.localeCompare(b.leadId));
}
