// Compliance policy helpers (pure; unit-tested). The server decides whether a version is looser and
// what it needs (api/admin policy.ts: Owner + re-auth + the exact attestation sentence); this file
// mirrors that decision only to show the attestation BEFORE the Owner taps save, so the page is honest
// about what a change means. If the two ever disagree, the server's answer (ATTESTATION_REQUIRED /
// OWNER_REQUIRED) wins and the page shows the attestation then. VERIFY WITH COUNSEL: every value here
// is a legal parameter; none is hard-coded per state.
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

/** Numeric fields: label, unit and the platform's ceiling (the DB CHECK; higher is looser). */
export const NUMERIC_FIELDS: readonly { key: PolicyField; label: string; max: number; min: number; unit?: string }[] = [
  { key: 'humanReplyWindowMinutes', label: 'After a client writes, an agent may reply outside contact hours for', max: 30, min: 0, unit: 'minutes' },
  { key: 'autoSmsPer24h', label: 'Assistant texts per contact per day', max: 1, min: 0 },
  { key: 'autoSmsPer7d', label: 'Assistant texts per contact per week', max: 3, min: 0 },
  { key: 'autoEmailPer24h', label: 'Assistant emails per contact per day', max: 1, min: 0 },
  { key: 'autoEmailPer7d', label: 'Assistant emails per contact per week', max: 3, min: 0 },
  { key: 'autoCrossChannelPer24h', label: 'Assistant messages per contact per day, all channels', max: 2, min: 0 },
  { key: 'manualSmsConfirmAfter24h', label: 'Ask the agent to confirm after this many texts to one contact in a day', max: 3, min: 1 },
  { key: 'callAttemptsPer24h', label: 'Call attempts per contact per day', max: 3, min: 1 },
  { key: 'maxDeferrals', label: 'Times a message may wait for contact hours before it is dropped', max: 5, min: 1 },
];

const HIGHER_IS_LOOSER: readonly PolicyField[] = NUMERIC_FIELDS.map((f) => f.key);

function seconds(t: string): number {
  const [h = '0', m = '0', s = '0'] = t.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

/**
 * Fields of `next` that permit more contact than the active `base`, plus anything beyond the shipped
 * defaults that needs an Owner attestation (contact window wider than the defaults, one-party
 * recording). Same rules as api/admin policyLoosening.
 */
export function looserFields(base: PolicyValues, next: PolicyValues, defaults: PolicyValues): PolicyField[] {
  const out = new Set<PolicyField>();
  if (seconds(next.contactWindowStart) < seconds(base.contactWindowStart)) out.add('contactWindowStart');
  if (seconds(next.contactWindowEnd) > seconds(base.contactWindowEnd)) out.add('contactWindowEnd');
  for (const f of HIGHER_IS_LOOSER) if ((next[f] as number) > (base[f] as number)) out.add(f);
  if (base.emailQuietHours && !next.emailQuietHours) out.add('emailQuietHours');
  const had = new Set(base.autonomousCategories);
  if (next.autonomousCategories.some((c) => !had.has(c))) out.add('autonomousCategories');
  if (!base.recordingEnabled && next.recordingEnabled) out.add('recordingEnabled');
  if (base.recordingMode === 'announce_all' && next.recordingMode !== 'announce_all') out.add('recordingMode');
  if (seconds(next.contactWindowStart) < seconds(defaults.contactWindowStart)) out.add('contactWindowStart');
  if (seconds(next.contactWindowEnd) > seconds(defaults.contactWindowEnd)) out.add('contactWindowEnd');
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
  contactWindowStart: 'Contact hours start',
  contactWindowEnd: 'Contact hours end',
  humanReplyWindowMinutes: 'Reply window after a client writes',
  emailQuietHours: 'Email waits for contact hours',
  autoSmsPer24h: 'Assistant texts per day',
  autoSmsPer7d: 'Assistant texts per week',
  autoEmailPer24h: 'Assistant emails per day',
  autoEmailPer7d: 'Assistant emails per week',
  autoCrossChannelPer24h: 'Assistant messages per day, all channels',
  manualSmsConfirmAfter24h: 'Confirm after texts per day',
  callAttemptsPer24h: 'Call attempts per day',
  maxDeferrals: 'Waits for contact hours',
  autonomousCategories: 'What the assistant may send on its own',
  optOutConfirmationSender: 'Who confirms an opt-out',
  recordingEnabled: 'Call recording',
  recordingMode: 'Recording notice',
};

/** A policy value said in words. */
export function valueText(k: PolicyField, v: PolicyValues): string {
  switch (k) {
    case 'contactWindowStart':
    case 'contactWindowEnd':
      return `${v[k]} in the contact's local time`;
    case 'humanReplyWindowMinutes':
      return `${v.humanReplyWindowMinutes} minutes`;
    case 'emailQuietHours':
      return v.emailQuietHours ? 'Yes' : 'No, email may go any time';
    case 'autonomousCategories':
      return v.autonomousCategories.length === 0 ? 'Nothing' : v.autonomousCategories.map((c) => CATEGORY_LABEL[c] ?? c).join(', ');
    case 'optOutConfirmationSender':
      return v.optOutConfirmationSender === 'provider' ? 'The phone carrier service' : 'This app';
    case 'recordingEnabled':
      return v.recordingEnabled ? 'On' : 'Off';
    case 'recordingMode':
      return v.recordingMode === 'announce_all' ? 'Every call is announced before recording' : 'One-party consent where the law allows it';
    default:
      return String(v[k]);
  }
}
