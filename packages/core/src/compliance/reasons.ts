// Gate reason codes, their effect, and the human sentence each one renders (ARCHITECTURE §9,
// R-GATE-6, CONVENTIONS §7 "gate outcomes are not errors"). Reason codes are stable strings stored
// in gate_decisions.reason_codes; the explanation is what the agent sees ("Opted out of texts ·
// Outside 9 AM–8 PM their time").
import { type IanaZone, type Instant, type LocalTime } from '../foundation/index.js';
import { DateTime } from 'luxon';
import { PAYMENT_BLOCK_SENTENCE } from './content.js';
import type { Channel } from './types.js';

/** deny: blocks, never confirmable; confirm: a human may confirm past it; defer: retry later; info: no effect. */
export type ReasonEffect = 'deny' | 'confirm' | 'defer' | 'info';

export const REASON_EFFECTS = {
  TENANT_SUSPENDED: 'deny',
  RECIPIENT_CATEGORY_MISMATCH: 'deny',
  CATEGORY_REQUIRES_HUMAN: 'deny',
  CATEGORY_NOT_AUTONOMOUS: 'deny',
  AUTOMATED_VOICE_UNAVAILABLE: 'deny',
  CONTACT_POINT_INVALID: 'deny',
  WRONG_NUMBER: 'deny',
  LANDLINE_NO_SMS: 'deny',
  SENDER_UNAVAILABLE: 'deny',
  SENDER_NOT_REGISTERED: 'deny',
  EMAIL_DOMAIN_UNVERIFIED: 'deny',
  BROKERAGE_IDENTITY_MISSING: 'deny',
  POSTAL_ADDRESS_MISSING: 'deny',
  UNSUBSCRIBE_MISSING: 'deny',
  RENDERED_CONTENT_MISSING: 'deny',
  CONSENT_REVOKED: 'deny',
  SUPPRESSED: 'deny',
  PAYMENT_INSTRUCTIONS: 'deny',
  CONSENT_BASIS_INSUFFICIENT: 'deny',
  CONSENT_IMPORTED_BASIS_ONLY: 'deny',
  CONSENT_CONFIRMATION_REQUIRED: 'confirm',
  DNC_LISTED: 'deny',
  DNC_STATUS_UNKNOWN_NO_RELATIONSHIP: 'deny',
  AUTOMATION_PAUSED: 'deny',
  OUTSIDE_CONTACT_WINDOW: 'deny',
  OUTSIDE_WINDOW_REPLY: 'confirm',
  QUIET_HOURS_DEFERRED: 'defer',
  NO_CONTACTABLE_WINDOW: 'deny',
  POLICY_CAP_ZERO: 'deny',
  FREQUENCY_CAP: 'defer',
  MANUAL_SMS_VOLUME: 'confirm',
  CALL_ATTEMPT_LIMIT: 'deny',
  RECIPIENT_TZ_UNCERTAIN: 'info',
} as const satisfies Record<string, ReasonEffect>;

export type ReasonCode = keyof typeof REASON_EFFECTS;
export const REASON_CODES = Object.keys(REASON_EFFECTS) as ReasonCode[];

/**
 * R-GATE-6: the reasons that can never be confirmed past (every one is a `deny`). Listed
 * explicitly so a change to REASON_EFFECTS cannot silently make one confirmable.
 */
export const NEVER_CONFIRMABLE: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'TENANT_SUSPENDED',
  'CONTACT_POINT_INVALID',
  'WRONG_NUMBER',
  'LANDLINE_NO_SMS',
  'SENDER_UNAVAILABLE',
  'SENDER_NOT_REGISTERED',
  'EMAIL_DOMAIN_UNVERIFIED',
  'BROKERAGE_IDENTITY_MISSING',
  'POSTAL_ADDRESS_MISSING',
  'UNSUBSCRIBE_MISSING',
  'CONSENT_REVOKED',
  'SUPPRESSED',
  'PAYMENT_INSTRUCTIONS',
  'DNC_LISTED',
  'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP',
]);

// ---- explanation --------------------------------------------------------------------------------

const CHANNEL_NOUN: Record<Channel, string> = { sms: 'texts', voice: 'calls', email: 'email' };

/** 9 AM, 8 PM, 9:30 AM, 12 AM (midnight), 12 PM (noon). */
export function humanLocalTime(t: LocalTime): string {
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor((t % 3600) / 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${h12} ${suffix}` : `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

export interface ExplainContext {
  channel: Channel;
  window: { start: LocalTime; end: LocalTime };
  deferUntil?: Instant;
  zone?: IanaZone;
  caps: { manualSmsConfirmAfter24h: number; callAttemptsPer24h: number };
}

function at(t: Instant, z: IanaZone | undefined): string {
  const d = DateTime.fromMillis(t, { zone: z ?? 'UTC' }).setLocale('en-US');
  return `${d.toFormat('ccc')} ${d.toFormat('h:mm a')}${z === undefined ? ' UTC' : ' their time'}`;
}

export function reasonSentence(r: ReasonCode, c: ExplainContext): string {
  const noun = CHANNEL_NOUN[c.channel];
  const win = `${humanLocalTime(c.window.start)}–${humanLocalTime(c.window.end)}`;
  switch (r) {
    case 'TENANT_SUSPENDED':
      return 'This account is suspended';
    case 'RECIPIENT_CATEGORY_MISMATCH':
      return 'Agent alerts go only to team members';
    case 'CATEGORY_REQUIRES_HUMAN':
      return 'This kind of message always needs a person to send it';
    case 'CATEGORY_NOT_AUTONOMOUS':
      return "This kind of message isn't approved for the assistant to send on its own";
    case 'AUTOMATED_VOICE_UNAVAILABLE':
      return "The assistant doesn't make calls";
    case 'CONTACT_POINT_INVALID':
      return 'This number or address is marked invalid';
    case 'WRONG_NUMBER':
      return 'Marked as a wrong number';
    case 'LANDLINE_NO_SMS':
      return "This number is a landline and can't get texts";
    case 'SENDER_UNAVAILABLE':
      return 'No sending number or address is set up for this';
    case 'SENDER_NOT_REGISTERED':
      return c.channel === 'email' ? 'The sending email identity is turned off' : "The sending number isn't registered for texting";
    case 'EMAIL_DOMAIN_UNVERIFIED':
      return "Marketing email needs the team's verified sending domain";
    case 'BROKERAGE_IDENTITY_MISSING':
      return 'Marketing must show the brokerage name';
    case 'POSTAL_ADDRESS_MISSING':
      return 'Marketing email needs the brokerage postal address';
    case 'UNSUBSCRIBE_MISSING':
      return 'Marketing email needs an unsubscribe link';
    case 'RENDERED_CONTENT_MISSING':
      return "The message wasn't checked before sending";
    case 'CONSENT_REVOKED':
      return `Opted out of ${noun}`;
    case 'SUPPRESSED':
      return `Blocked for ${noun} (bounce, complaint or do-not-contact)`;
    case 'PAYMENT_INSTRUCTIONS':
      return PAYMENT_BLOCK_SENTENCE.replace(/\.$/, '');
    case 'CONSENT_BASIS_INSUFFICIENT':
      return `No consent on file for automated ${noun}`;
    case 'CONSENT_IMPORTED_BASIS_ONLY':
      return 'Only imported consent on file; marketing texts need a new inquiry or opt-in';
    case 'CONSENT_CONFIRMATION_REQUIRED':
      return 'No consent or recent reply on file; confirm before sending';
    case 'DNC_LISTED':
      return 'On a Do Not Call list';
    case 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP':
      return 'Do Not Call status unknown and no inquiry on file';
    case 'AUTOMATION_PAUSED':
      return 'Paused because the client replied';
    case 'OUTSIDE_CONTACT_WINDOW':
      return `Outside ${win} their time`;
    case 'OUTSIDE_WINDOW_REPLY':
      return `Outside ${win} their time; OK only as a reply to their message`;
    case 'QUIET_HOURS_DEFERRED':
      return c.deferUntil === undefined ? `Outside ${win} their time` : `Sends ${at(c.deferUntil, c.zone)}`;
    case 'NO_CONTACTABLE_WINDOW':
      return `No time is inside ${win} in every time zone this person may be in`;
    case 'POLICY_CAP_ZERO':
      return `Automated ${noun} are turned off in the team policy`;
    case 'FREQUENCY_CAP':
      return c.deferUntil === undefined ? 'Waiting for the message limit' : `Message limit reached; sends ${at(c.deferUntil, c.zone)}`;
    case 'MANUAL_SMS_VOLUME':
      return `Already texted ${c.caps.manualSmsConfirmAfter24h} times in 24 hours; confirm to send another`;
    case 'CALL_ATTEMPT_LIMIT':
      return `Already ${c.caps.callAttemptsPer24h} call attempts in 24 hours`;
    case 'RECIPIENT_TZ_UNCERTAIN':
      return 'Their time zone is a best guess';
  }
}

export function explain(outcome: 'allow' | 'deny' | 'defer' | 'needs_confirmation', reasons: readonly ReasonCode[], c: ExplainContext): string {
  const visible = outcome === 'deny' ? reasons.filter((r) => REASON_EFFECTS[r] === 'deny') : reasons;
  const sentences = [...new Set(visible.map((r) => reasonSentence(r, c)))];
  if (outcome === 'allow' && sentences.length === 0) return 'OK to send';
  if (outcome === 'allow') return `OK to send · ${sentences.join(' · ')}`;
  return sentences.join(' · ');
}
