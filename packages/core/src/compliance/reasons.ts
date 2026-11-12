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
  // D12 proposed (docs/AI_ISA.md §5.4): the AI ISA categories only; every other category never produces these.
  'ISA_NOT_AUTHORIZED',
  'ISA_PAUSED',
  'ISA_STALE_REPLY',
  'ISA_STALE_EPOCH',
  'ISA_UNBOUND_RECIPIENT',
  'ISA_PURPOSE_MISMATCH',
  'ISA_CHANNEL_NOT_ALLOWED',
  'ISA_CONSENT_EVIDENCE_MISSING',
  'ISA_REPLY_WINDOW_CLOSED',
  'ISA_DNC_UNVERIFIED',
  'ISA_QUIET_HOURS',
  'ISA_ZONE_UNRESOLVED',
  'ISA_CAP_REACHED',
  'ISA_MIN_GAP',
  'ISA_SHARED_ADDRESS',
  'ISA_ACTIVE_CLIENT',
  'ISA_SELLER_DATA_NOT_CLEARED',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

/** The opt-out reasons: never overridable by anyone (R-CONSENT-10). */
export const OPT_OUT_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(['CONSENT_REVOKED', 'SUPPRESSED', 'PERSON_DO_NOT_CONTACT']);

/** The AI ISA codes (R-ISA-8). The dispatch reason classes (deferrable, replan, terminal) are core/isa's `ISA_REASON_CLASS`. */
export const AI_ISA_REASONS: ReadonlySet<ReasonCode> = new Set<ReasonCode>(REASON_CODES.filter((r) => r.startsWith('ISA_')));

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
    case 'ISA_NOT_AUTHORIZED':
      return "The AI assistant isn't authorized to send this right now";
    case 'ISA_PAUSED':
      return 'AI care is paused or has ended for this person';
    case 'ISA_STALE_REPLY':
      return 'They wrote again, so the AI assistant will answer both messages together';
    case 'ISA_STALE_EPOCH':
      return 'AI care was paused and resumed after this was written';
    case 'ISA_UNBOUND_RECIPIENT':
      return "The AI assistant only writes to the number or address it was started on";
    case 'ISA_PURPOSE_MISMATCH':
      return 'AI assistant messages are always sent as marketing';
    case 'ISA_CHANNEL_NOT_ALLOWED':
      return `The AI assistant isn't allowed to send ${noun} here`;
    case 'ISA_CONSENT_EVIDENCE_MISSING':
      return channel === 'sms'
        ? 'Listings and follow-ups by text need written consent naming the team, from their own form. Not on file'
        : 'Listings and follow-ups by email need consent from their own form. Not on file';
    case 'ISA_REPLY_WINDOW_CLOSED':
      return 'Their last message is too old for the AI assistant to reply to';
    case 'ISA_DNC_UNVERIFIED':
      return 'AI-initiated texts need a recent Do Not Call check. Not on file';
    case 'ISA_QUIET_HOURS':
      return "Outside the hours the AI assistant may write in every time zone they could be in";
    case 'ISA_ZONE_UNRESOLVED':
      return "Their time zone couldn't be worked out, so the AI assistant waits";
    case 'ISA_CAP_REACHED':
      return 'They have had as many automated messages today as the AI assistant allows';
    case 'ISA_MIN_GAP':
      return 'The AI assistant waits a couple of minutes between messages';
    case 'ISA_SHARED_ADDRESS':
      return 'This number or address is shared with another person';
    case 'ISA_ACTIVE_CLIENT':
      return "They're already a client on an open deal or a team listing";
    case 'ISA_SELLER_DATA_NOT_CLEARED':
      return "Recent sales can't be sent until counsel and the MLS licence clear it";
  }
}

export function explain(outcome: 'allow' | 'deny', reasons: readonly ReasonCode[], channel: Channel): string {
  if (outcome === 'allow') return 'OK to send';
  return [...new Set(reasons.map((r) => reasonSentence(r, channel)))].join(' · ');
}
