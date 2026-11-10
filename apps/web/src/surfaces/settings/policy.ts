// Compliance policy helpers (pure; unit-tested). The server decides whether a version is looser and
// what it needs (api/admin policy.ts: Owner + re-auth + the exact attestation sentence); this file
// mirrors that decision only to show the attestation BEFORE the Owner taps save, so the page is honest
// about what a change means. If the two ever disagree, the server's answer (ATTESTATION_REQUIRED /
// OWNER_REQUIRED) wins and the page shows the attestation then. VERIFY WITH COUNSEL: every value here
// is a legal parameter; none is hard-coded per state.
//
// core-compliance/2.0.0 (owner decision): the contact window / quiet hours, the human-reply window,
// email quiet hours, the frequency caps and the deferral limit are gone from the policy and from the
// send-time check. What is left: what the assistant may send on its own, who confirms an opt-out, and
// call recording.
import type { AutonomousCategory, PolicyValues } from '../admin/lib/types.js';

export type PolicyField = keyof PolicyValues;

export const CATEGORY_LABEL: Record<AutonomousCategory, string> = {
  speed_to_lead_reply: 'Instant reply to new leads',
  reminder: 'Appointment and deadline reminders',
  booking_confirmation: 'Booking confirmations',
  document_chase: 'Reminders to send documents',
  nurture_step: 'Stay-in-touch messages',
  search_alert: 'New listing alerts for saved searches',
};

/**
 * Fields of `next` that permit more than the active `base`, plus anything beyond the shipped defaults
 * that needs an Owner attestation (one-party recording). Same rules as api/admin policyLoosening.
 */
export function looserFields(base: PolicyValues, next: PolicyValues): PolicyField[] {
  const out = new Set<PolicyField>();
  const had = new Set(base.autonomousCategories);
  if (next.autonomousCategories.some((c) => !had.has(c))) out.add('autonomousCategories');
  if (!base.recordingEnabled && next.recordingEnabled) out.add('recordingEnabled');
  if (next.recordingMode !== 'announce_all') out.add('recordingMode');
  return [...out].sort();
}

/** Only the fields that differ from the active version (a version is a delta on the active one). */
export function draftDelta(base: PolicyValues, next: PolicyValues): Partial<PolicyValues> {
  const out: Partial<PolicyValues> = {};
  for (const k of Object.keys(next) as PolicyField[]) {
    const a = base[k];
    const b = next[k];
    const same = Array.isArray(a) && Array.isArray(b) ? [...a].sort().join() === [...b].sort().join() : a === b;
    if (!same) (out as Record<string, unknown>)[k] = b;
  }
  return out;
}

export const FIELD_LABEL: Record<PolicyField, string> = {
  autonomousCategories: 'What the assistant may send on its own',
  optOutConfirmationSender: 'Who confirms an opt-out',
  recordingEnabled: 'Call recording',
  recordingMode: 'Recording notice',
};

/** A policy value said in words. */
export function valueText(k: PolicyField, v: PolicyValues): string {
  switch (k) {
    case 'autonomousCategories':
      return v.autonomousCategories.length === 0 ? 'Nothing' : v.autonomousCategories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ');
    case 'optOutConfirmationSender':
      return v.optOutConfirmationSender === 'provider' ? 'The phone carrier service' : 'This app';
    case 'recordingEnabled':
      return v.recordingEnabled ? 'On' : 'Off';
    case 'recordingMode':
      return v.recordingMode === 'announce_all' ? 'Every call is announced before recording' : 'One-party consent where the law allows it';
  }
}

/**
 * The platform's opt-out keywords (core/compliance PLATFORM_FLOOR.keywords.optOut), restated so the
 * phone bundle does not pull in core/compliance at runtime; policy.test.ts asserts they match. State
 * rule packs can add more, never remove any.
 */
export const OPT_OUT_KEYWORDS: readonly string[] = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT', 'OPT OUT'];
