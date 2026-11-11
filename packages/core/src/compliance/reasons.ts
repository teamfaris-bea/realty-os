// Gate reason codes and the human sentence each one renders (ARCHITECTURE §9, CONVENTIONS §7 "gate
// outcomes are not errors"). Reason codes are stable strings stored in gate_decisions.reason_codes
// (written only for a blocked send); the explanation is what the agent sees ("Opted out of texts ·
// Marketing must show the brokerage name").
//
// core-compliance/2.0.0: every reason blocks and none can be confirmed past. The removed consent-basis,
// DNC-registry, contact-window, cap and timezone codes may still appear on gate_decisions rows written
// before the change; `reasonSentence` is only defined for the current codes.
import { PAYMENT_BLOCK_SENTENCE } from './content.js';
import type { Channel } from './types.js';

export const REASON_CODES = [
  'TENANT_SUSPENDED',
  'RECIPIENT_CATEGORY_MISMATCH',
  'CATEGORY_REQUIRES_HUMAN',
  'CATEGORY_NOT_AUTONOMOUS',
  'AUTOMATED_VOICE_UNAVAILABLE',
  'CONTACT_POINT_INVALID',
  'WRONG_NUMBER',
  'LANDLINE_NO_SMS',
  'SENDER_UNAVAILABLE',
  'SENDER_NOT_REGISTERED',
  'EMAIL_DOMAIN_UNVERIFIED',
  'BROKERAGE_IDENTITY_MISSING',
  'POSTAL_ADDRESS_MISSING',
  'UNSUBSCRIBE_MISSING',
  'RENDERED_CONTENT_MISSING',
  'CONSENT_REVOKED',
  'SUPPRESSED',
  'PAYMENT_INSTRUCTIONS',
  'AUTOMATION_PAUSED',
  // core-compliance/3.0.0 (R-CHAN-2, R-CHAN-5, R-INT-2). The Meta window and platform:meta clearance
  // codes of the plan are not added: Messenger/Instagram DMs are out of scope (D2).
  'PERSON_DO_NOT_CONTACT',
  'CHANNEL_NOT_CONNECTED',
  'FAIR_HOUSING_TERMS',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** The opt-out reasons: never overridable by anyone (R-CONSENT-10). */
export const OPT_OUT_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT']);

/** Operational platform rules (core-compliance/3.0.0): not consent, D1 stands. Blocks until the chat widget reconnects. */
export const PLATFORM_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['CHANNEL_NOT_CONNECTED']);

const CHANNEL_NOUN: Record<Channel, string> = {
  sms: 'texts',
  voice: 'calls',
  email: 'email',
  web_chat: 'chat messages',
};
const CHANNEL_NAME: Record<Channel, string> = {
  sms: 'Texting',
  voice: 'Calling',
  email: 'Email',
  web_chat: 'Website chat',
};

export function reasonSentence(r: ReasonCode, channel: Channel): string {
  const noun = CHANNEL_NOUN[channel];
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
      return channel === 'email' ? 'The sending email identity is turned off' : "The sending number isn't registered for texting";
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
    case 'AUTOMATION_PAUSED':
      return 'Paused because the client replied';
    case 'PERSON_DO_NOT_CONTACT':
      return 'This person asked not to be contacted on any channel';
    case 'CHANNEL_NOT_CONNECTED':
      // a chat reply's channel is its session: the visitor left (E77) or the widget was turned off (R-INBOX-7), never
      // a setup fault for the agent to fix (finding UXA-8)
      return channel === 'web_chat' ? 'The chat has ended: they left the page or the website chat was turned off' : `${CHANNEL_NAME[channel]} isn't connected right now`;
    case 'FAIR_HOUSING_TERMS':
      return 'Contains wording that fair-housing rules do not allow; edit it first';
  }
}

export function explain(outcome: 'allow' | 'deny', reasons: readonly ReasonCode[], channel: Channel): string {
  if (outcome === 'allow') return 'OK to send';
  return [...new Set(reasons.map((r) => reasonSentence(r, channel)))].join(' · ');
}
