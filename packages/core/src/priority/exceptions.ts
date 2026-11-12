// The Team Lead live exception queue, derived (BUILD_PLAN module 5; ARCHITECTURE §14; R-ACC-1,
// R-ACC-2, R-AST-15, R-IMPORT-6).
//
// deriveExceptions is pure and recomputable. Items are keyed per occurrence:
//   untouched_lead   untouched:{contact}:{ownership_period_seq}
//   overdue_promise  promise:{task}
//   failed_send      send:{message}
//   missing_outcome  appt:{appointment}
//   milestone_at_risk milestone:{deal_date}:{due_version}   (R-ACC-6, module 18a)
// `detectedAt` is the instant the condition started holding (a deadline, a status change), never
// the time the recompute happened to run, so recomputing never moves it. A condition fixed after it
// started holding ("fixed late") is still an item, with `conditionClearedAt` = the fix instant; the
// queue keeps it until a person resolves or verifies it (exception_events, R-ACC-3, not core).
//
// Imported history never raises an exception (R-IMPORT-6), and only a human touch satisfies the
// first-touch SLA (R-AST-15): `SlaFacts.firstTouchAt` is the ledger's first_touch_recorded, which
// only a gate-allowed human outbound writes (R-OWN-14: a call, text, email or reply in the website chat,
// owner decision D8).
//
// R-MKT-8: an open-house invite recipient blocked at send time (an opt-out) is counted on the send itself
// ("Sent 41 of 45; 4 opted out"), so a message carrying `marketingPieceId` never raises failed_send.
import { REASON_CODES, type ReasonCode, canonicalJson, reasonSentence } from '../compliance/index.js';
import { HOUR_MS, type Instant, MINUTE_MS, instant } from '../foundation/index.js';
import { awaitsOutcome, taskDeadline } from './feed.js';
import { clip } from './format.js';
import { apptKey, milestoneKey, promiseKey, sendKey, untouchedKey } from './keys.js';
import type {
  ApptFacts,
  DealDateFacts,
  ExceptionDerivation,
  ExceptionEvidence,
  ExceptionInputs,
  ExceptionItemSpec,
  ExceptionSettings,
  MilestoneDateFacts,
  OutboundStatusFacts,
  SlaFacts,
  TaskFacts,
} from './types.js';

/**
 * exception_items.rule_version. Bump on any change to a definition below.
 * 2: milestone_at_risk (R-ACC-6) and the open-house invite exclusion of failed_send (R-MKT-8).
 * 3: an untouched_lead period's first-touch window also ends when a re-inquiry starts a new period of
 *    the same owner (R-OWN-20, E68): a touch in the later period no longer marks the earlier miss
 *    "fixed late", and a period superseded before its deadline is no item.
 * Owner decision D8 (2026-11-12) changed no definition here: a reply in the website chat became a touch where
 * touches are written (R-OWN-14, dispatch TX1), and the untouched_lead evidence now names it among the touch kinds
 * and says whose touch is missing ("call, text, email or chat reply from the agent or a collaborator"). A stored item
 * gets the new words when a recompute next reaches it (DATA_MODEL R-ACC-2 says when those words need a check first).
 */
export const EXCEPTION_RULE_VERSION = 3;

/** R-ACC-6: a confirmed date due within this long with nobody responsible is at risk. */
export const MILESTONE_UNASSIGNED_WINDOW_MS = 48 * HOUR_MS;

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
  // The first-touch window ends when the lead leaves the agent or a re-inquiry starts a new period of theirs.
  const endedBy = (at: Instant | null): boolean => at !== null && at <= due;
  // Not due yet, touched in time, or the window ended before the deadline (no breach is ever written then:
  // the breach timer is fenced on the period, R-OWN-15).
  if (now < due || (s.firstTouchAt !== null && s.firstTouchAt <= due) || endedBy(s.periodEndedAt) || endedBy(s.nextPeriodAt)) {
    return { kind: 'clear', key };
  }
  const late = s.firstTouchAt !== null;
  // The touch kinds and who makes one are R-OWN-14's (owner decision D8 added the chat reply): the agent of the period
  // or a collaborator. Someone else may have replied (a Team Lead in the chat, E311), which is no touch, so the words
  // say whose touch is missing rather than that nobody replied.
  const explanation = late
    ? 'First human call, text, email or chat reply from the agent or a collaborator came after the first-contact deadline'
    : s.periodEndedAt !== null
      ? 'No human call, text, email or chat reply from the agent or a collaborator by the first-contact deadline; the lead later left this agent'
      : 'No human call, text, email or chat reply from the agent or a collaborator by the first-contact deadline';
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
  // R-MKT-8: an invite recipient's row (blocked by an opt-out) is counted on the send, not queued.
  if (m.marketingPieceId !== undefined && m.marketingPieceId !== null) return { kind: 'clear', key: sendKey(m.messageId) };
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

const DATE_NAME: Record<DealDateFacts['kind'], string> = {
  acceptance: 'Acceptance date',
  inspection: 'Inspection deadline',
  appraisal: 'Appraisal date',
  financing: 'Financing deadline',
  closing: 'Closing date',
  possession: 'Possession date',
  custom: 'Contract date',
};

/**
 * milestone_at_risk (R-ACC-6, R-TXN-3): a CONFIRMED date with completed_at NULL that is overdue
 * (`due_at < now`), or due within 48 h (`due_at - now ≤ 48 h`) with no responsible party. Stored fields
 * only: a proposed or waived date, or one whose stored instant is missing, is never a risk. The evidence
 * names which predicate holds (both, when an overdue date also has nobody responsible).
 *
 * detectedAt is when the condition started holding: `due_at - 48 h` while it is only unassigned,
 * `due_at` once overdue with someone responsible. A date completed after its due instant is "fixed late"
 * (conditionClearedAt = completed_at); completed in time, it clears. The key carries due_version, so after
 * a confirmed date moves the old occurrence clears and the new one is judged on its own.
 */
export function milestoneAtRisk(d: MilestoneDateFacts, now: Instant): DerivedException | null {
  const key = milestoneKey(d.dealDateId, d.dueVersion);
  if (d.status !== 'confirmed' || d.dueAt === null) return { kind: 'clear', key };
  const due = d.dueAt;
  const name = DATE_NAME[d.kind ?? 'custom'];
  const unassignedFrom = instant(due - MILESTONE_UNASSIGNED_WINDOW_MS);
  const nobody = d.responsible === null;

  if (d.completedAt !== null) {
    // done: an item only when it was done after the date passed ("fixed late")
    if (d.completedAt <= due) return { kind: 'clear', key };
    const evidence: ExceptionEvidence[] = [
      { sourceType: 'deal_date', sourceId: d.dealDateId, explanation: `${name} passed before it was marked done`, at: due, predicate: 'overdue' },
      { sourceType: 'deal_date', sourceId: d.dealDateId, explanation: 'Marked done', at: d.completedAt },
      { sourceType: 'deal', sourceId: d.dealId, explanation: 'The deal this date belongs to' },
    ];
    return { kind: 'item', spec: milestoneSpec(d, key, nobody ? unassignedFrom : due, evidence, d.completedAt) };
  }

  const overdue = due < now;
  const unassigned = nobody && due - now <= MILESTONE_UNASSIGNED_WINDOW_MS;
  if (!overdue && !unassigned) return { kind: 'clear', key };
  const evidence: ExceptionEvidence[] = [];
  if (overdue) evidence.push({ sourceType: 'deal_date', sourceId: d.dealDateId, explanation: `${name} has passed and is not marked done`, at: due, predicate: 'overdue' });
  if (unassigned) {
    evidence.push({
      sourceType: 'deal_date',
      sourceId: d.dealDateId,
      explanation: overdue ? 'Nobody is named as responsible for it' : `${name} is due within 48 h and nobody is named as responsible for it`,
      at: due,
      predicate: 'unassigned',
    });
  }
  evidence.push({ sourceType: 'deal', sourceId: d.dealId, explanation: 'The deal this date belongs to' });
  return { kind: 'item', spec: milestoneSpec(d, key, unassigned ? unassignedFrom : due, evidence, null) };
}

function milestoneSpec(d: MilestoneDateFacts, key: string, detectedAt: Instant, evidence: ExceptionEvidence[], clearedAt: Instant | null): ExceptionItemSpec {
  return {
    itemType: 'milestone_at_risk',
    subjectType: 'deal_date',
    subjectId: d.dealDateId,
    contactId: null,
    ownerUserId: d.ownerUserId,
    detectedAt,
    dueAt: d.dueAt,
    evidence,
    conditionClearedAt: clearedAt,
    ruleVersion: EXCEPTION_RULE_VERSION,
    dedupeKey: key,
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
  for (const e of x.evidence) parts.push(e.sourceType, e.sourceId, e.explanation, e.at ?? '', locatorPrint(e.locator), e.snippet ?? '', e.predicate ?? '');
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
  for (const x of i.milestoneDates ?? []) take(milestoneAtRisk(x, i.now));
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
