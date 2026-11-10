// The one place apps/web turns opt-out reasons and message status reasons into plain sentences
// (lane optout-visibility). Every Text / Email / Call / Send caption and every "Not sent: …" line in a
// thread comes from here, so the same fact is always said the same way. Raw codes are never shown: an
// unknown code gets an honest generic sentence.
//
//   reachSentence   why a channel is blocked before anyone taps   "Texted STOP on Nov 10"
//   messageStatus   what happened to an outbound message          "Not sent: texted STOP on Nov 10"
import type { ReachChannel, ReachReason } from './types.js';

/** "Nov 10", or "Nov 10, 2025" outside the current year, in the viewer's zone. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

const NOUN: Record<ReachChannel, string> = { sms: 'texts', voice: 'calls', email: 'email' };
const VERB: Record<ReachChannel, string> = { sms: 'texted', voice: 'called', email: 'emailed' };

const on = (iso: string | null, now?: Date) => (iso ? ` on ${shortDate(iso, now)}` : '');
const marketingOnly = (r: ReachReason) => r.purposes.length > 0 && !r.purposes.includes('informational');

function recorded(r: ReachReason, now?: Date): string {
  const who = r.recordedBy?.displayName;
  if (who && r.at) return ` (recorded by ${who} on ${shortDate(r.at, now)})`;
  if (who) return ` (recorded by ${who})`;
  return on(r.at, now);
}

function optOutSentence(r: ReachReason, ch: ReachChannel, now?: Date): string {
  const noun = marketingOnly(r) ? `marketing ${NOUN[ch]}` : NOUN[ch];
  switch (r.source) {
    case 'keyword':
      return `Texted ${r.keyword ?? 'STOP'}${r.otherAddress && r.addressHint ? ` from ${r.addressHint}` : ''}${on(r.at, now)}`;
    case 'opt_out_language':
      return `Asked by text to stop getting ${noun}${on(r.at, now)}`;
    case 'unsubscribe':
      return `Unsubscribed from ${marketingOnly(r) ? 'marketing email' : 'email'}${on(r.at, now)}`;
    case 'agent_recorded':
    case 'call_outcome':
      return `Asked not to be ${VERB[ch]}${marketingOnly(r) ? ' with marketing' : ''}${recorded(r, now)}`;
    case 'wrong_number':
      return `Marked as a wrong number${recorded(r, now)}`;
    case 'provider_report':
      return `${ch === 'email' ? 'The email provider' : 'The carrier'} reported they opted out${on(r.at, now)}`;
    case 'imported':
      return `Opted out of ${noun} in your previous system${on(r.at, now)} (imported)`;
    default:
      return `Opted out of ${noun}${on(r.at, now)}`;
  }
}

const SUPPRESSION: Record<string, (r: ReachReason, ch: ReachChannel, now?: Date) => string> = {
  hard_bounce: (r, _c, now) => `Email to this address bounced${on(r.at, now)}`,
  spam_complaint: (r, _c, now) => `Marked an email as spam${on(r.at, now)}`,
  undeliverable: (r, _c, now) => `Messages can't be delivered here${r.at ? ` (since ${shortDate(r.at, now)})` : ''}`,
  landline_no_sms: () => "This number is a landline and can't get texts",
  internal_dnc: (r, _c, now) => `On the team's do-not-contact list${r.recordedBy?.displayName ? ` (added by ${r.recordedBy.displayName}${on(r.at, now)})` : r.at ? ` since ${shortDate(r.at, now)}` : ''}`,
  admin_block: (r, _c, now) => `Blocked by ${r.recordedBy?.displayName ?? 'an admin'}${on(r.at, now)}`,
  wrong_number: (r, _c, now) => `Marked as a wrong number${on(r.at, now)}`,
  provider_opt_out: (r, ch, now) => `${ch === 'email' ? 'The email provider' : 'The carrier'} reported they opted out${on(r.at, now)}`,
  import_dnc: (r, _c, now) => `Marked do-not-contact in your previous system${r.at ? ` (imported ${shortDate(r.at, now)})` : ' (imported)'}`,
};

/** Why `ch` is blocked, in one sentence ("Texted STOP on Nov 10"). */
export function reachSentence(r: ReachReason, ch: ReachChannel, now?: Date): string {
  switch (r.code) {
    case 'CONSENT_REVOKED':
      return optOutSentence(r, ch, now);
    case 'SUPPRESSED':
      return (SUPPRESSION[r.suppressionReason ?? ''] ?? ((x: ReachReason, c: ReachChannel) => `Blocked for ${NOUN[c]}${on(x.at, now)}`))(r, ch, now);
    case 'WRONG_NUMBER':
      return 'Marked as a wrong number';
    case 'CONTACT_POINT_INVALID':
      return ch === 'email' ? "This email address isn't working" : "This number isn't working";
    case 'LANDLINE_NO_SMS':
      return "This number is a landline and can't get texts";
  }
}

const lowerFirst = (s: string) => (/^(The|This|On|Opted|Texted|Asked|Unsubscribed|Marked|Messages|Email|Blocked)\b/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);

// ---- message status ----------------------------------------------------------------------------

/** messages.status_reason of a blocked message that has no opt-out evidence (core reason codes + dispatch reasons). */
const BLOCKED: Record<string, string> = {
  CONSENT_REVOKED: 'they opted out',
  SUPPRESSED: 'the address is blocked (bounce, complaint or do-not-contact)',
  WRONG_NUMBER: 'marked as a wrong number',
  CONTACT_POINT_INVALID: "the number or address isn't working",
  LANDLINE_NO_SMS: "the number is a landline and can't get texts",
  SENDER_UNAVAILABLE: 'no sending number or address is set up',
  SENDER_NOT_REGISTERED: "the sending number isn't registered for texting yet",
  EMAIL_DOMAIN_UNVERIFIED: "marketing email needs the team's verified sending domain",
  BROKERAGE_IDENTITY_MISSING: 'marketing must show the brokerage name',
  POSTAL_ADDRESS_MISSING: 'marketing email needs the brokerage postal address',
  UNSUBSCRIBE_MISSING: 'marketing email needs an unsubscribe link',
  PAYMENT_INSTRUCTIONS: 'it contained payment or wire instructions, which are never sent',
  AUTOMATION_PAUSED: 'automation is paused because they replied',
  TENANT_SUSPENDED: 'this account is suspended',
  CATEGORY_REQUIRES_HUMAN: 'this kind of message always needs a person to send it',
  CATEGORY_NOT_AUTONOMOUS: "this kind of message isn't approved for the assistant",
  SENDER_NOT_AUTHORIZED: 'you no longer handle this contact',
  ASSISTANT_ACTION_NOT_APPROVED: "the draft wasn't approved",
  ASSISTANT_ACTION_STALE: 'the lead moved to someone else after it was drafted',
  PLAYBOOK_NOT_APPROVED: 'the playbook is no longer approved',
  PLAYBOOK_OWNER_NOT_CONTACT_OWNER: 'the playbook belongs to an agent who no longer owns the lead',
  ENROLLMENT_NOT_ACTIVE: 'the playbook for this contact is paused or stopped',
  AUTONOMY_DOWNGRADED: 'the assistant held it for review',
};

/** Twilio-style carrier error codes worth naming; anything else is "the carrier rejected it". */
const CARRIER: Record<string, string> = {
  '21610': 'they had opted out with the carrier',
  RECIPIENT_OPTED_OUT: 'they had opted out with the carrier',
  '30003': 'their phone was unreachable',
  '30005': "the number doesn't exist",
  '30006': "the number can't get texts (likely a landline)",
  '30007': 'the carrier filtered it',
  '30008': 'the carrier rejected it',
};

const FAILED: Record<string, string> = {
  PROVIDER_OPTED_OUT: 'they had opted out with the carrier',
  PROVIDER_REJECTED: 'the phone service rejected it',
  PROVIDER_UNAVAILABLE: "the phone service wasn't answering",
  PROVIDER_TIMEOUT: "the phone service didn't answer in time",
  PROVIDER_NOT_CONFIGURED: "sending isn't set up yet",
  DISPATCH_UNKNOWN_UNRESOLVED: "we couldn't confirm it went out",
};

const CANCELED: Record<string, string> = {
  CANCELED_BY_SENDER: 'Canceled, not sent',
  OPTED_OUT: 'Canceled: they opted out',
  PROVIDER_OPTED_OUT: 'Canceled: the carrier reported they opted out',
  WRONG_NUMBER: 'Canceled: wrong number',
  CLIENT_REPLIED: 'Canceled: they replied, so the assistant stopped',
  SAVED_SEARCH_PAUSED: 'Canceled: the saved search was paused',
  PLAYBOOK_VERSION_REPLACED: 'Canceled: the playbook was updated',
  PLAYBOOK_APPROVAL_REVOKED: 'Canceled: the playbook approval was withdrawn',
};

/** Held states: a message that waits for its sender's tap (E27). */
export const HELD_REASONS: ReadonlySet<string> = new Set(['CLIENT_REPLIED_SINCE_SCHEDULED']);

export interface MessageStatusFacts {
  status: string | null | undefined;
  statusReason?: string | null | undefined;
  providerErrorCode?: string | null | undefined;
  blockedBy?: ReachReason | null | undefined;
  channel: string;
}

export interface StatusLine {
  text: string;
  /** failed: never drawn like a sent message; held: waits for its sender's tap; info: on its way */
  tone: 'failed' | 'held' | 'info';
}

export function isHeld(m: Pick<MessageStatusFacts, 'status' | 'statusReason'>): boolean {
  return (m.status === 'queued' || m.status === 'scheduled') && HELD_REASONS.has(m.statusReason ?? '');
}

/** What happened to an outbound message, in plain words, when it did not simply go out; null for sent/delivered. */
export function messageStatus(m: MessageStatusFacts, contactFirstName: string, now?: Date): StatusLine | null {
  const ch: ReachChannel = m.channel === 'email' ? 'email' : 'sms';
  const reason = m.statusReason ?? '';
  if (isHeld(m)) return { text: `Held because ${contactFirstName || 'they'} replied`, tone: 'held' };
  switch (m.status) {
    case 'blocked':
      if (m.blockedBy) return { text: `Not sent: ${lowerFirst(reachSentence(m.blockedBy, ch, now))}`, tone: 'failed' };
      if (reason === 'CONSENT_REVOKED') return { text: `Not sent: opted out of ${NOUN[ch]}`, tone: 'failed' };
      return { text: `Not sent: ${BLOCKED[reason] ?? 'blocked by a sending rule'}`, tone: 'failed' };
    case 'failed':
    case 'undelivered': {
      const why = CARRIER[m.providerErrorCode ?? ''] ?? FAILED[reason]?.replace('phone service', ch === 'email' ? 'email service' : 'phone service') ?? (ch === 'email' ? 'the email provider rejected it' : 'the carrier rejected it');
      return { text: `Not delivered: ${why}`, tone: 'failed' };
    }
    case 'bounced':
      return { text: 'Not delivered: the email bounced', tone: 'failed' };
    case 'canceled':
      return { text: CANCELED[reason] ?? 'Canceled, not sent', tone: 'failed' };
    case 'scheduled':
      return { text: 'Scheduled', tone: 'info' };
    case 'queued':
    case 'dispatching':
      return { text: 'Sending', tone: 'info' };
    case 'dispatch_unknown':
      return { text: 'Checking whether it went out', tone: 'info' };
    default:
      return null;
  }
}
