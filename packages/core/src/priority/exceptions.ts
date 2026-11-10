// The Team Lead live exception queue, derived (BUILD_PLAN module 5; ARCHITECTURE §14; R-ACC-1,
// R-ACC-2, R-AST-15, R-IMPORT-6).
//
// deriveExceptions is pure and recomputable. Items are keyed per occurrence:
//   untouched_lead   untouched:{contact}:{ownership_period_seq}
//   overdue_promise  promise:{task}
//   failed_send      send:{message}
//   missing_outcome  appt:{appointment}
// `detectedAt` is the instant the condition started holding (a deadline, a status change), never
// the time the recompute happened to run, so recomputing never moves it. A condition fixed after it
// started holding ("fixed late") is still an item, with `conditionClearedAt` = the fix instant; the
// queue keeps it until a person resolves or verifies it (exception_events, R-ACC-3, not core).
//
// Imported history never raises an exception (R-IMPORT-6), and only a human touch satisfies the
// first-touch SLA (R-AST-15): `SlaFacts.firstTouchAt` is the ledger's first_touch_recorded, which
// only a gate-allowed human outbound writes (R-OWN-14).
import { REASON_CODES, type ReasonCode, canonicalJson, reasonSentence } from '../compliance/index.js';
import { HOUR_MS, type Instant, MINUTE_MS, instant } from '../foundation/index.js';
import { awaitsOutcome, taskDeadline } from './feed.js';
import { clip } from './format.js';
import { apptKey, promiseKey, sendKey, untouchedKey } from './keys.js';
import type {
  ApptFacts,
  ExceptionDerivation,
  ExceptionEvidence,
  ExceptionInputs,
  ExceptionItemSpec,
  ExceptionSettings,
  OutboundStatusFacts,
  SlaFacts,
  TaskFacts,
} from './types.js';

/** exception_items.rule_version. Bump on any change to a definition below. */
export const EXCEPTION_RULE_VERSION = 1;

/** R-ACC-2 / R-GATE-8 defaults. */
export const DEFAULT_EXCEPTION_SETTINGS: Required<ExceptionSettings> = {
  missingOutcomeHours: 2,
  unknownDispatchMinutes: 10,
  dispatchingStaleMinutes: 20,
};

const MAX_QUOTES = 3;

export type DerivedException = { kind: 'item'; spec: ExceptionItemSpec } | { kind: 'clear'; key: string };

// ---- the four definitions (R-ACC-2) -------------------------------------------------------------

/** untouched_lead: an SLA period with no human touch by its first-touch deadline. */
export function untouchedLead(s: SlaFacts, now: Instant): DerivedException {
  const key = untouchedKey(s.contactId, s.periodSeq);
  const due = s.firstTouchDueAt;
  // Not due yet, touched in time, or the period ended before the deadline (no breach is ever written then).
  if (now < due || (s.firstTouchAt !== null && s.firstTouchAt <= due) || (s.periodEndedAt !== null && s.periodEndedAt <= due)) {
    return { kind: 'clear', key };
  }
  const late = s.firstTouchAt !== null;
  const explanation = late
    ? 'First human call, text or email came after the first-contact deadline'
    : s.periodEndedAt !== null
      ? 'No human call, text or email by the first-contact deadline; the lead later left this agent'
      : 'No human call, text or email by the first-contact deadline';
  const evidence: ExceptionEvidence[] = [
    { sourceType: 'ownership_period', sourceId: s.contactId, explanation, at: due },
    { sourceType: 'ownership_period', sourceId: s.contactId, explanation: 'Lead became theirs', at: s.ownedAt },
  ];
  if (late) evidence.push({ sourceType: 'ownership_period', sourceId: s.contactId, explanation: 'First human contact', at: s.firstTouchAt as Instant });
  return {
    kind: 'item',
    spec: {
      itemType: 'untouched_lead',
      subjectType: 'contact',
      subjectId: s.contactId,
      contactId: s.contactId,
      ownerUserId: s.ownerUserId,
      detectedAt: due,
      dueAt: due,
      evidence,
      conditionClearedAt: late ? (s.firstTouchAt as Instant) : null,
      ruleVersion: EXCEPTION_RULE_VERSION,
      dedupeKey: key,
    },
  };
}

/** overdue_promise: an open promise task past its deadline (all-day: the end of its local day). */
export function overduePromise(t: TaskFacts, now: Instant): DerivedException | null {
  if (t.kind !== 'promise' || t.createdByKind === 'import') return null;
  const key = promiseKey(t.taskId);
  const deadline = taskDeadline(t);
  // An unpinned (needs-review) promise date is never asserted, so it cannot be overdue (R-AST-5).
  if (deadline === null || now <= deadline) return { kind: 'clear', key };
  let clearedAt: Instant | null = null;
  if (t.status === 'done') {
    if (t.completedAt === null || t.completedAt <= deadline) return { kind: 'clear', key };
    clearedAt = t.completedAt;
  } else if (t.status === 'canceled') {
    return { kind: 'clear', key };
  }
  const evidence: ExceptionEvidence[] = [
    {
      sourceType: 'task',
      sourceId: t.taskId,
      explanation: clearedAt === null ? 'Promised follow-up is past due and still open' : 'Promised follow-up was done after it was due',
      at: deadline,
    },
  ];
  for (const q of (t.evidence ?? []).slice(0, MAX_QUOTES)) {
    evidence.push({ sourceType: q.sourceType, sourceId: q.sourceId, explanation: 'Where it was promised', locator: q.locator, snippet: clip(q.snippet, 500) });
  }
  return {
    kind: 'item',
    spec: {
      itemType: 'overdue_promise',
      subjectType: 'task',
      subjectId: t.taskId,
      contactId: t.contactId,
      ownerUserId: t.assigneeUserId,
      detectedAt: deadline,
      dueAt: deadline,
      evidence,
      conditionClearedAt: clearedAt,
      ruleVersion: EXCEPTION_RULE_VERSION,
      dedupeKey: key,
    },
  };
}

const TERMINAL_FAILURES = new Set<OutboundStatusFacts['status']>(['blocked', 'failed', 'undelivered', 'bounced']);

/** Provider failure codes api/comms stores in messages.status_reason. */
const PROVIDER_WORDS: Readonly<Record<string, string>> = {
  PROVIDER_REJECTED: 'the carrier or provider rejected it',
  PROVIDER_OPTED_OUT: 'the number opted out with the carrier',
  PROVIDER_TIMEOUT: 'the provider did not answer',
  PROVIDER_UNAVAILABLE: 'the provider was unavailable',
  PROVIDER_NOT_CONFIGURED: 'no provider account is set up',
  PROVIDER_ERROR: 'a provider error',
};
/**
 * Gate reasons retired in core-compliance/2.0.0 (quiet hours, caps, consent basis, DNC registry). New
 * sends never carry them, but messages blocked before the change still do.
 */
const RETIRED_GATE_WORDS: Readonly<Record<string, string>> = {
  OUTSIDE_CONTACT_WINDOW: 'Outside the hours they could be contacted',
  OUTSIDE_WINDOW_REPLY: 'Outside the hours they could be contacted',
  QUIET_HOURS_DEFERRED: 'Outside the hours they could be contacted',
  NO_CONTACTABLE_WINDOW: 'Outside the hours they could be contacted',
  FREQUENCY_CAP: 'Over the message limit',
  MANUAL_SMS_VOLUME: 'Over the message limit',
  CALL_ATTEMPT_LIMIT: 'Over the call attempt limit',
  POLICY_CAP_ZERO: 'Automated messages were turned off in the team policy',
  CONSENT_BASIS_INSUFFICIENT: 'No consent on file for automated messages',
  CONSENT_IMPORTED_BASIS_ONLY: 'Only imported consent on file',
  CONSENT_CONFIRMATION_REQUIRED: 'Waited for a confirmation that never came',
  DNC_LISTED: 'On a Do Not Call list',
  DNC_STATUS_UNKNOWN_NO_RELATIONSHIP: 'Do Not Call status unknown',
};
const CURRENT_GATE_CODES: ReadonlySet<string> = new Set<string>(REASON_CODES);

/**
 * A stored status reason in words (the queue never shows a raw code, CONVENTIONS §7): gate reason
 * codes get core/compliance's own sentence, provider codes fixed words, any other code nothing at
 * all; free text from a provider ("mailbox full", carrier error "30007") is kept, clipped.
 */
export function statusReasonWords(reason: string, channel: OutboundStatusFacts['channel']): string | null {
  const provider = PROVIDER_WORDS[reason];
  if (provider !== undefined) return provider;
  if (CURRENT_GATE_CODES.has(reason)) return reasonSentence(reason as ReasonCode, channel === 'email' ? 'email' : 'sms');
  const retired = RETIRED_GATE_WORDS[reason];
  if (retired !== undefined) return retired;
  if (/^[A-Z][A-Z0-9_]*$/.test(reason)) return null;
  return clip(reason, 160);
}

function failureExplanation(m: OutboundStatusFacts, s: Required<ExceptionSettings>): string {
  const noun = m.channel === 'email' ? 'Email' : 'Text';
  const why = m.statusReason ? statusReasonWords(m.statusReason, m.channel) : null;
  switch (m.status) {
    case 'blocked':
      return why ? `${noun} blocked by the send-time check: ${why}` : `${noun} blocked by the send-time check`;
    case 'failed':
      return why ? `${noun} failed to send (${why})` : `${noun} failed to send`;
    case 'undelivered':
      return why ? `${noun} not delivered (${why})` : `${noun} not delivered`;
    case 'bounced':
      return why ? `${noun} bounced (${why})` : `${noun} bounced`;
    case 'dispatch_unknown':
      return `${noun} send result unknown for over ${s.unknownDispatchMinutes} min`;
    default:
      return `${noun} stuck sending for over ${s.dispatchingStaleMinutes} min`;
  }
}

/** failed_send: blocked/failed/undelivered/bounced, unknown > 10 min, or dispatching > 20 min. */
export function failedSend(m: OutboundStatusFacts, now: Instant, s: Required<ExceptionSettings>): DerivedException | null {
  if (m.imported || m.initiator === 'import') return null;
  const key = sendKey(m.messageId);
  let detectedAt: Instant | null = null;
  if (TERMINAL_FAILURES.has(m.status)) detectedAt = m.statusAt;
  else if (m.status === 'dispatch_unknown') {
    const since = m.statusAt;
    if (now - since > s.unknownDispatchMinutes * MINUTE_MS) detectedAt = instant(since + s.unknownDispatchMinutes * MINUTE_MS);
  } else if (m.status === 'dispatching') {
    const since = m.dispatchedAt ?? m.statusAt;
    if (now - since > s.dispatchingStaleMinutes * MINUTE_MS) detectedAt = instant(since + s.dispatchingStaleMinutes * MINUTE_MS);
  }
  if (detectedAt === null) return { kind: 'clear', key };
  return {
    kind: 'item',
    spec: {
      itemType: 'failed_send',
      subjectType: 'message',
      subjectId: m.messageId,
      contactId: m.contactId,
      ownerUserId: m.ownerUserId,
      detectedAt,
      dueAt: null,
      evidence: [{ sourceType: 'message', sourceId: m.messageId, explanation: failureExplanation(m, s), at: m.statusAt }],
      conditionClearedAt: null,
      ruleVersion: EXCEPTION_RULE_VERSION,
      dedupeKey: key,
    },
  };
}

const APPT_NAME: Record<ApptFacts['kind'], string> = {
  buyer_consult: 'Buyer consult',
  listing_appointment: 'Listing appointment',
  consult: 'Consult',
  other: 'Appointment',
};

/** missing_outcome: ended more than `missingOutcomeHours` ago, no outcome, not canceled/rescheduled. */
export function missingOutcome(a: ApptFacts, now: Instant, s: Required<ExceptionSettings>): DerivedException | null {
  if (a.createdByKind === 'import') return null;
  const key = apptKey(a.appointmentId);
  const deadline = instant(a.endsAt + s.missingOutcomeHours * HOUR_MS);
  if (now <= deadline || (a.status !== 'scheduled' && a.status !== 'held')) return { kind: 'clear', key };
  let clearedAt: Instant | null = null;
  if (!awaitsOutcome(a)) {
    if ((a.outcomeLoggedAt as Instant) <= deadline) return { kind: 'clear', key };
    clearedAt = a.outcomeLoggedAt;
  }
  return {
    kind: 'item',
    spec: {
      itemType: 'missing_outcome',
      subjectType: 'appointment',
      subjectId: a.appointmentId,
      contactId: a.contactId,
      ownerUserId: a.userId,
      detectedAt: deadline,
      dueAt: deadline,
      evidence: [
        {
          sourceType: 'appointment',
          sourceId: a.appointmentId,
          explanation:
            clearedAt === null
              ? `${APPT_NAME[a.kind]} ended; no outcome logged`
              : `${APPT_NAME[a.kind]} outcome logged more than ${s.missingOutcomeHours} h after it ended`,
          at: a.endsAt,
        },
      ],
      conditionClearedAt: clearedAt,
      ruleVersion: EXCEPTION_RULE_VERSION,
      dedupeKey: key,
    },
  };
}

// ---- recompute ----------------------------------------------------------------------------------

const SEP = '\u001f';

function locatorPrint(l: ExceptionEvidence['locator']): string {
  if (l === undefined) return '';
  switch (l.kind) {
    case 'transcript_offset':
      return `t${l.startMs}-${l.endMs}`;
    case 'char_range':
      return `c${l.start}-${l.end}`;
    case 'field':
      return `f${l.name}`;
    case 'message':
      return 'm';
  }
}

/**
 * A fixed-order fingerprint of everything stored on a row except the clear instant (only whether it
 * is cleared). Equal for a row read back from jsonb whatever its key order; much cheaper than
 * canonical JSON on a 10k-contact recompute.
 */
export function exceptionFingerprint(x: ExceptionItemSpec): string {
  const parts: (string | number | null)[] = [
    x.dedupeKey,
    x.itemType,
    x.subjectType,
    x.subjectId,
    x.contactId,
    x.ownerUserId,
    x.detectedAt,
    x.dueAt,
    x.ruleVersion,
    x.conditionClearedAt === null ? 'open' : 'cleared',
    x.evidence.length,
  ];
  for (const e of x.evidence) parts.push(e.sourceType, e.sourceId, e.explanation, e.at ?? '', locatorPrint(e.locator), e.snippet ?? '');
  return parts.join(SEP);
}

/**
 * Derives the exception queue for one scope (a tenant, or one contact's facts). Returns the rows to
 * upsert by dedupe key and the keys whose condition stopped holding.
 *
 * - Without `existing`: every item whose condition holds or was fixed late is returned, and
 *   `cleared` lists the input subjects whose condition does not hold (the API sets
 *   condition_cleared_at = now where it is still null, which is a no-op for keys with no row).
 * - With `existing` (the stored rows of the same scope): unchanged items are not returned again,
 *   and `cleared` lists only stored, still-open keys whose condition stopped holding or whose
 *   subject is gone. Running it again on its own output gives no upserts and no clears.
 *
 * Stored `conditionClearedAt` instants are kept (an item that is cleared both in the store and in
 * the derivation is unchanged); a stored-cleared item whose condition holds again is upserted open.
 */
export function deriveExceptions(i: ExceptionInputs): ExceptionDerivation {
  const s: Required<ExceptionSettings> = { ...DEFAULT_EXCEPTION_SETTINGS, ...stripUndefined(i.settings) };
  const items = new Map<string, ExceptionItemSpec>();
  const clear = new Set<string>();
  const take = (d: DerivedException | null): void => {
    if (d === null) return;
    if (d.kind === 'clear') {
      clear.add(d.key);
      return;
    }
    const prev = items.get(d.spec.dedupeKey);
    // Duplicate input rows for one subject: keep one deterministically.
    if (prev === undefined || canonicalJson(d.spec) < canonicalJson(prev)) items.set(d.spec.dedupeKey, d.spec);
  };
  for (const x of i.ownedWithSla) take(untouchedLead(x, i.now));
  for (const x of i.promiseTasks) take(overduePromise(x, i.now));
  for (const x of i.outbound) take(failedSend(x, i.now, s));
  for (const x of i.appointments) take(missingOutcome(x, i.now, s));
  for (const k of items.keys()) clear.delete(k);

  const upserts: ExceptionItemSpec[] = [];
  const cleared: string[] = [];
  if (i.existing === undefined) {
    upserts.push(...items.values());
    cleared.push(...clear);
  } else {
    const stored = new Map(i.existing.map((e) => [e.dedupeKey, e] as const));
    for (const spec of items.values()) {
      const ex = stored.get(spec.dedupeKey);
      if (ex !== undefined && exceptionFingerprint(ex) === exceptionFingerprint(spec)) continue;
      upserts.push(spec);
    }
    for (const [key, ex] of stored) {
      if (ex.conditionClearedAt === null && !items.has(key)) cleared.push(key);
    }
  }
  upserts.sort((a, b) => (a.dedupeKey < b.dedupeKey ? -1 : 1)); // keys are unique here
  cleared.sort();
  return { upserts, cleared };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}
