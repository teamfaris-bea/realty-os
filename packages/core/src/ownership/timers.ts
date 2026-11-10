// Deadlines and timer plumbing (R-OWN-9, R-OWN-13, R-OWN-15, R-OWN-23; ARCHITECTURE §6 timer catalog).
//
// Every deadline is computed ONCE, at transition time, with the settings and calendar passed in, and
// stored as a UTC instant. Nothing here is re-evaluated against later settings (E10, E67): timer
// commands compare their fence with the STORED instant, never with a recomputed one.
import {
  type BusinessCalendar,
  type ContactId,
  HOUR_MS,
  type IanaZone,
  type Instant,
  addBusinessDuration,
  addLocalDays,
  instant,
  maxInstant,
} from '../foundation/index.js';
import { INACTIVITY_STAGES, type ContactStage, type Effect, type EffectiveLeadSettings, type OwnershipProjection, type TimerDeadline } from './types.js';

/** R-OWN-9: the offer window counts business time; delivered now even after hours (E8). */
export function offerExpiresAt(now: Instant, windowSeconds: number, cal: BusinessCalendar): Instant {
  return addBusinessDuration(now, windowSeconds, cal);
}

/**
 * R-OWN-13: first touch is due `sla` business seconds after max(owned_at, next contactable instant);
 * auto-release (when enabled) `release` business seconds after the same base.
 */
export function firstTouchDeadlines(i: {
  ownedAt: Instant;
  settings: Pick<EffectiveLeadSettings, 'firstTouchSlaSeconds' | 'firstTouchReleaseSeconds'>;
  calendar: BusinessCalendar;
  nextContactableAt: (from: Instant) => Instant;
}): { firstTouchDueAt: Instant; releaseDueAt: Instant | null } {
  const base = maxInstant(i.ownedAt, i.nextContactableAt(i.ownedAt));
  const due = addBusinessDuration(base, i.settings.firstTouchSlaSeconds, i.calendar);
  const rel = i.settings.firstTouchReleaseSeconds;
  return { firstTouchDueAt: due, releaseDueAt: rel === null ? null : addBusinessDuration(base, rel, i.calendar) };
}

/**
 * R-OWN-23: release after `inactivityReleaseDays` tenant-zone calendar days without a human touch,
 * warning `inactivityWarningHours` before. Both null when disabled, when the stage is past
 * new/attempting, or when a deal is open. A warning that would fall at or before `from` is dropped.
 */
export function inactivityDeadlines(i: {
  from: Instant;
  settings: Pick<EffectiveLeadSettings, 'inactivityReleaseDays' | 'inactivityWarningHours'>;
  zone: IanaZone;
  stage?: ContactStage;
  dealOpen?: boolean;
}): { warnAt: Instant | null; releaseAt: Instant | null } {
  const days = i.settings.inactivityReleaseDays;
  if (days === null || i.dealOpen === true || (i.stage !== undefined && !INACTIVITY_STAGES.has(i.stage))) {
    return { warnAt: null, releaseAt: null };
  }
  const releaseAt = addLocalDays(i.from, days, i.zone);
  const warn = releaseAt - i.settings.inactivityWarningHours * HOUR_MS;
  return { warnAt: warn > i.from ? instant(warn) : null, releaseAt };
}

/** Whether inactivity deadlines apply at FIRE time (disabled / stage / deal are honoured then). */
export function inactivityApplies(settings: Pick<EffectiveLeadSettings, 'inactivityReleaseDays'>, stage: ContactStage | undefined, dealOpen: boolean | undefined): boolean {
  return settings.inactivityReleaseDays !== null && dealOpen !== true && (stage === undefined || INACTIVITY_STAGES.has(stage));
}

// ---- dedupe keys ---------------------------------------------------------------------------------

export function offerTimerKey(contactId: ContactId, offerId: string): string {
  return `ownership.offer_expiry:${contactId}:${offerId}`;
}
export function breachTimerKey(contactId: ContactId, periodSeq: number): string {
  return `ownership.first_touch_breach:${contactId}:${periodSeq}`;
}
export function releaseTimerKey(contactId: ContactId, periodSeq: number): string {
  return `ownership.auto_release:${contactId}:${periodSeq}`;
}
export function inactivityTimerKey(contactId: ContactId, which: 'warn' | 'release', periodSeq: number, dueAt: Instant): string {
  return `ownership.inactivity:${contactId}:${which}:${periodSeq}:${dueAt}`;
}

// ---- effects --------------------------------------------------------------------------------------

export function offerTimer(contactId: ContactId, offerId: string, runAt: Instant): Effect {
  return {
    kind: 'enqueueTimer',
    jobKind: 'ownership.offer_expiry',
    runAt,
    dedupeKey: offerTimerKey(contactId, offerId),
    fence: { contactId, deadline: 'offer_expiry', offerId },
  };
}

/** Timers of an ownership period with first-touch SLA (breach and, when enabled, auto-release). */
export function slaTimers(contactId: ContactId, p: Pick<OwnershipProjection, 'periodSeq' | 'firstTouchDueAt' | 'releaseDueAt'>): Effect[] {
  const out: Effect[] = [];
  if (p.periodSeq === null) return out;
  if (p.firstTouchDueAt !== null) {
    out.push({
      kind: 'enqueueTimer',
      jobKind: 'ownership.first_touch_breach',
      runAt: p.firstTouchDueAt,
      dedupeKey: breachTimerKey(contactId, p.periodSeq),
      fence: { contactId, deadline: 'first_touch_breach', periodSeq: p.periodSeq, dueAt: p.firstTouchDueAt },
    });
  }
  if (p.releaseDueAt !== null) {
    out.push({
      kind: 'enqueueTimer',
      jobKind: 'ownership.auto_release',
      runAt: p.releaseDueAt,
      dedupeKey: releaseTimerKey(contactId, p.periodSeq),
      fence: { contactId, deadline: 'auto_release', periodSeq: p.periodSeq, dueAt: p.releaseDueAt },
    });
  }
  return out;
}

export function inactivityTimers(contactId: ContactId, periodSeq: number, d: { warnAt: Instant | null; releaseAt: Instant | null }): Effect[] {
  const out: Effect[] = [];
  if (d.warnAt !== null) {
    out.push({
      kind: 'enqueueTimer',
      jobKind: 'ownership.inactivity',
      runAt: d.warnAt,
      dedupeKey: inactivityTimerKey(contactId, 'warn', periodSeq, d.warnAt),
      fence: { contactId, deadline: 'inactivity_warn', periodSeq, dueAt: d.warnAt },
    });
  }
  if (d.releaseAt !== null) {
    out.push({
      kind: 'enqueueTimer',
      jobKind: 'ownership.inactivity',
      runAt: d.releaseAt,
      dedupeKey: inactivityTimerKey(contactId, 'release', periodSeq, d.releaseAt),
      fence: { contactId, deadline: 'inactivity_release', periodSeq, dueAt: d.releaseAt },
    });
  }
  return out;
}

/** Dedupe keys of every timer bound to the period `p` (and the stored inactivity deadlines). */
export function periodTimerKeys(contactId: ContactId, periodSeq: number | null, inactivity?: { warnAt: Instant | null; releaseAt: Instant | null }): string[] {
  if (periodSeq === null) return [];
  const keys = [breachTimerKey(contactId, periodSeq), releaseTimerKey(contactId, periodSeq)];
  if (inactivity?.warnAt) keys.push(inactivityTimerKey(contactId, 'warn', periodSeq, inactivity.warnAt));
  if (inactivity?.releaseAt) keys.push(inactivityTimerKey(contactId, 'release', periodSeq, inactivity.releaseAt));
  return keys;
}

/**
 * An early wake (now < stored deadline) re-enqueues the same timer at the stored deadline. The
 * running job still holds the original dedupe key (unique while pending/running), so the retry
 * gets a distinct key; the sweeper backstops a lost one either way (R-OWN-15).
 */
export function rescheduleTimer(contactId: ContactId, deadline: TimerDeadline, fence: { offerId: string } | { periodSeq: number; dueAt: Instant }, runAt: Instant, now: Instant): Effect {
  const jobKind =
    deadline === 'offer_expiry'
      ? 'ownership.offer_expiry'
      : deadline === 'first_touch_breach'
        ? 'ownership.first_touch_breach'
        : deadline === 'auto_release'
          ? 'ownership.auto_release'
          : 'ownership.inactivity';
  const base =
    'offerId' in fence
      ? offerTimerKey(contactId, fence.offerId)
      : deadline === 'first_touch_breach'
        ? breachTimerKey(contactId, fence.periodSeq)
        : deadline === 'auto_release'
          ? releaseTimerKey(contactId, fence.periodSeq)
          : inactivityTimerKey(contactId, deadline === 'inactivity_warn' ? 'warn' : 'release', fence.periodSeq, fence.dueAt);
  const jobFence =
    'offerId' in fence
      ? ({ contactId, deadline: 'offer_expiry', offerId: fence.offerId } as const)
      : { contactId, deadline: deadline as Exclude<TimerDeadline, 'offer_expiry'>, periodSeq: fence.periodSeq, dueAt: fence.dueAt };
  return { kind: 'enqueueTimer', jobKind, runAt, dedupeKey: `${base}:early:${now}`, fence: jobFence };
}
