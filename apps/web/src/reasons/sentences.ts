// The one place apps/web turns opt-out reasons and message status reasons into plain sentences
// (lane optout-visibility). Every Text / Email / Call / Send caption and every "Not sent: …" line in a
// thread comes from here, so the same fact is always said the same way. Raw codes are never shown: an
// unknown code gets an honest generic sentence.
//
//   reachSentence   why a channel is blocked before anyone taps   "Texted STOP on Nov 10"
//   messageStatus   what happened to an outbound message          "Not sent: texted STOP on Nov 10"
import type { ReachChannel, ReachReason } from './types.js';

/** The channels a reason can be said for: texts, calls, email, and (module 22) the website chat. */
export type SayChannel = ReachChannel | 'web_chat';

/** "Nov 10", or "Nov 10, 2025" outside the current year, in the viewer's zone. */
export function shortDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }).format(d);
}

const NOUN: Record<SayChannel, string> = { sms: 'texts', voice: 'calls', email: 'email', web_chat: 'chat messages' };
const VERB: Record<SayChannel, string> = { sms: 'texted', voice: 'called', email: 'emailed', web_chat: 'contacted' };

const on = (iso: string | null, now?: Date) => (iso ? ` on ${shortDate(iso, now)}` : '');

/**
 * A masked number that never breaks across lines ("•••-•••-7385" wrapped after a hyphen on a phone): its
 * hyphens become non-breaking hyphens (U+2011) and its spaces non-breaking spaces.
 */
export function unbreakable(hint: string): string {
  return hint.replace(/-/g, '\u2011').replace(/ /g, '\u00a0');
}

/** " from •••‑•••‑7385" (" (removed number)" when that phone is no longer on the person), or nothing. */
const fromOther = (r: ReachReason) => (r.otherAddress && r.addressHint ? ` from ${unbreakable(r.addressHint)}${r.addressRemoved ? ' (removed number)' : ''}` : '');
const marketingOnly = (r: ReachReason) => r.purposes.length > 0 && !r.purposes.includes('informational');

function recorded(r: ReachReason, now?: Date): string {
  const who = r.recordedBy?.displayName;
  if (who && r.at) return ` (recorded by ${who} on ${shortDate(r.at, now)})`;
  if (who) return ` (recorded by ${who})`;
  return on(r.at, now);
}

function optOutSentence(r: ReachReason, ch: SayChannel, now?: Date): string {
  const noun = marketingOnly(r) ? `marketing ${NOUN[ch]}` : NOUN[ch];
  // module 22: website chat has no keyword protocol (a STOP there is opt-out language) and no carrier
  if (ch === 'web_chat' && (r.source === 'keyword' || r.source === 'opt_out_language')) return `Asked in the chat to stop being contacted${on(r.at, now)}`;
  if (ch === 'web_chat' && r.source === 'provider_report') return `Opted out of ${noun}${on(r.at, now)}`;
  switch (r.source) {
    case 'keyword':
      return `Texted ${r.keyword ?? 'STOP'}${fromOther(r)}${on(r.at, now)}`;
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

const SUPPRESSION: Record<string, (r: ReachReason, ch: SayChannel, now?: Date) => string> = {
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

/**
 * The person-level do-not-contact (R-CHAN-2, review optouts/F1): one sentence on every channel, so it never reads as an
 * opt-out of that channel alone ("Asked not to be contacted at all (recorded by Ava Agent on Nov 10)").
 */
export const PERSON_DNC = 'Asked not to be contacted at all';

/** Why `ch` is blocked, in one sentence ("Texted STOP on Nov 10"). */
export function reachSentence(r: ReachReason, ch: SayChannel, now?: Date): string {
  switch (r.code) {
    case 'PERSON_DO_NOT_CONTACT':
      return `${PERSON_DNC}${r.source === 'imported' ? ` in your previous system${on(r.at, now)} (imported)` : recorded(r, now)}`;
    case 'CONSENT_REVOKED':
      return optOutSentence(r, ch, now);
    case 'SUPPRESSED':
      return (SUPPRESSION[r.suppressionReason ?? ''] ?? ((x: ReachReason, c: SayChannel) => `Blocked for ${NOUN[c]}${on(x.at, now)}`))(r, ch, now);
    case 'WRONG_NUMBER':
      return 'Marked as a wrong number';
    case 'CONTACT_POINT_INVALID':
      return ch === 'email' ? "This email address isn't working" : ch === 'web_chat' ? "This chat can't take replies" : "This number isn't working";
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
  ASSISTANT_ACTION_WITHDRAWN: 'it was withdrawn before it went out (the lead was merged, reassigned, closed or started a new inquiry period)',
  PLAYBOOK_NOT_APPROVED: 'the playbook is no longer approved',
  PLAYBOOK_OWNER_NOT_CONTACT_OWNER: 'the playbook belongs to an agent who no longer owns the lead',
  ENROLLMENT_NOT_ACTIVE: 'the playbook for this contact is paused or stopped',
  AUTONOMY_DOWNGRADED: 'the assistant held it for review',
  // the person-level do-not-contact: the gate's code, and the dispatch guards' own (the same code, R-CHAN-2)
  PERSON_DO_NOT_CONTACT: 'they asked not to be contacted',
  // a dispatch guard's own refusal with no gate code for the same fact
  RECIPIENT_NOT_A_CONTACT_POINT: "the number or address isn't on their record, so their opt-outs couldn't be checked",
};

/**
 * The dispatch guards' own refusals (stored when the database refused a send the app gate allowed) that state a
 * fact the gate states with its own code: said with exactly the gate's words, so the same fact is always said
 * the same way. PERSON_DO_NOT_CONTACT needs no entry: the guard and the gate use the same code.
 */
const GUARD_SAME_FACT: Readonly<Record<string, string>> = { RECIPIENT_OPTED_OUT: 'CONSENT_REVOKED', RECIPIENT_SUPPRESSED: 'SUPPRESSED' };

/** status_reason codes that say the person opted out of the channel (after GUARD_SAME_FACT). */
const OPTED_OUT_REASONS: ReadonlySet<string> = new Set(['CONSENT_REVOKED']);

/** Twilio-style carrier error codes worth naming; anything else is "the carrier rejected it". */
const CARRIER: Record<string, string> = {
  '21610': 'they had opted out with the carrier',
  RECIPIENT_OPTED_OUT: 'they had opted out with the carrier',
  '30003': 'their phone was unreachable',
  '30005': "the number doesn't exist",
  '30006': "the number can't get texts (likely a landline)",
  '30007': 'the carrier filtered it',
  '30008': 'the carrier rejected it',
  // Twilio REST and status-callback codes the Twilio adapter reports (VERIFY against Twilio's error dictionary)
  '21211': "the number isn't a valid phone number",
  '21408': "texting that country isn't turned on for this account",
  '21606': "the sending number can't send texts",
  '21612': "the carrier can't deliver texts from this number to theirs",
  '21614': "the number isn't a mobile number",
  '21617': 'the text was too long',
  '30001': 'too many texts were waiting to go out',
  '30002': 'the phone account is suspended',
  '30004': 'the recipient or their carrier blocked it',
  '30010': 'it cost more than the allowed maximum',
  '30022': 'the daily texting limit for this number was reached',
  '30023': 'the daily texting limit for this number was reached',
  '30032': "the toll-free sending number isn't verified yet",
  '30034': "the sending number isn't registered for texting yet",
  // the Twilio adapter's own codes
  TWILIO_AUTH: "the phone service didn't accept our credentials",
  TWILIO_FROM_INVALID: "the sending number isn't a valid phone number",
  TWILIO_TO_INVALID: "the number isn't a valid phone number",
  TWILIO_TIMEOUT: "the phone service didn't answer in time",
  TWILIO_NETWORK: "the phone service couldn't be reached",
  TWILIO_BAD_RESPONSE: 'the phone service sent an unexpected answer',
  TWILIO_HTTP_429: 'the phone service was busy',
};

/** Email codes: the SMTP adapter's codes and SMTP reply codes (SMTP_<3 digits>). */
const EMAIL_CODES: Record<string, string> = {
  SMTP_AUTH: "the email service didn't accept our credentials",
  SMTP_AUTH_INCOMPLETE: "sending email isn't fully set up",
  SMTP_AUTH_PLAINTEXT: "sending email isn't set up securely",
  SMTP_AUTH_UNSUPPORTED: "the email service doesn't support our sign-in method",
  SMTP_STARTTLS_UNAVAILABLE: "the email service doesn't offer a secure connection",
  SMTP_HELO_INVALID: "sending email isn't set up correctly",
  SMTP_CONNECTION: "the email service couldn't be reached",
  SMTP_PROTOCOL: 'the email service sent an unexpected answer',
  SMTP_TIMEOUT: "the email service didn't answer in time",
  EMAIL_LINK_INVALID: 'a link in it was not allowed',
  SMTP_421: 'the email service was busy',
  SMTP_450: 'their mailbox was unavailable',
  SMTP_451: 'the email service had a temporary problem',
  SMTP_452: 'the email service was out of room',
  SMTP_550: "the address doesn't exist or refused it",
  SMTP_551: "the address doesn't exist",
  SMTP_552: 'their mailbox is full or the email was too large',
  SMTP_553: "the address isn't valid",
  SMTP_554: 'their mail server refused it',
};

/** Amazon SES bounce subtypes (ses:Bounce:<type>/<subtype>). VERIFY against the SES notification reference. */
const SES_BOUNCE: Record<string, string> = {
  NoEmail: "the address doesn't exist",
  Suppressed: "the address is on Amazon SES's suppression list after earlier bounces",
  OnAccountSuppressionList: "the address is on the account's suppression list",
  MailboxFull: 'their mailbox is full',
  MessageTooLarge: 'the email was too large',
  ContentRejected: 'their mail server refused the content',
  AttachmentRejected: 'their mail server refused an attachment',
  General: 'the email bounced',
  Undetermined: 'the email bounced',
};

/** Mailgun failure reasons (mailgun:failed:<severity>/<reason>[/<smtp>]). VERIFY against Mailgun's event docs. */
const MAILGUN_REASON: Record<string, string> = {
  bounce: 'the email bounced',
  'suppress-bounce': 'the address bounced before, so Mailgun did not try again',
  'suppress-unsubscribe': 'they had unsubscribed at Mailgun earlier',
  'suppress-complaint': 'they had marked an earlier email as spam',
  espblock: 'their email provider blocked it',
  old: "it couldn't be delivered in time",
  generic: 'their mail server refused it',
};

/** The sentence for a provider error code, or null when the code is not one we can name. */
export function providerCodeSentence(code: string | null | undefined): string | null {
  if (!code) return null;
  if (CARRIER[code]) return CARRIER[code]!;
  if (EMAIL_CODES[code]) return EMAIL_CODES[code]!;
  const ses = /^ses:(Bounce|Complaint|Reject|RenderingFailure)(?::([^/]*)(?:\/(.*))?)?$/.exec(code);
  if (ses) {
    if (ses[1] === 'Complaint') return 'they marked it as spam';
    if (ses[1] === 'Reject') return 'the email service refused to send it';
    if (ses[1] === 'RenderingFailure') return "the email couldn't be put together";
    return SES_BOUNCE[ses[3] ?? ''] ?? 'the email bounced';
  }
  const mg = /^mailgun:(failed|rejected)(?:[:/]([^/]*)(?:\/([^/]*))?)?/.exec(code);
  if (mg) {
    if (mg[1] === 'rejected') return 'the email service refused to send it';
    return MAILGUN_REASON[mg[3] ?? ''] ?? 'the email bounced';
  }
  return null;
}

const FAILED: Record<string, string> = {
  PROVIDER_OPTED_OUT: 'they had opted out with the carrier',
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
  const ch: SayChannel = m.channel === 'email' ? 'email' : m.channel === 'web_chat' ? 'web_chat' : 'sms';
  const reason = m.statusReason ?? '';
  if (isHeld(m)) return { text: `Held because ${contactFirstName || 'they'} replied`, tone: 'held' };
  switch (m.status) {
    case 'blocked': {
      if (m.blockedBy) return { text: `Not sent: ${lowerFirst(reachSentence(m.blockedBy, ch, now))}`, tone: 'failed' };
      const code = Object.hasOwn(GUARD_SAME_FACT, reason) ? GUARD_SAME_FACT[reason]! : reason;
      if (OPTED_OUT_REASONS.has(code)) return { text: `Not sent: opted out of ${NOUN[ch]}`, tone: 'failed' };
      return { text: `Not sent: ${(Object.hasOwn(BLOCKED, code) ? BLOCKED[code] : undefined) ?? 'blocked by a sending rule'}`, tone: 'failed' };
    }
    case 'failed':
    case 'undelivered': {
      // module 22: a chat reply is delivered by the website chat, not a carrier
      const service = ch === 'email' ? 'email service' : ch === 'web_chat' ? 'website chat' : 'phone service';
      const rejected = ch === 'email' ? 'the email service rejected it' : ch === 'web_chat' ? "the website chat couldn't deliver it" : 'the carrier rejected it';
      const why = providerCodeSentence(m.providerErrorCode) ?? (reason === 'PROVIDER_REJECTED' ? rejected : FAILED[reason]?.replace('phone service', service)) ?? (ch === 'email' ? 'the email provider rejected it' : rejected);
      return { text: `Not delivered: ${why}`, tone: 'failed' };
    }
    case 'bounced':
      return { text: `Not delivered: ${providerCodeSentence(m.providerErrorCode) ?? 'the email bounced'}`, tone: 'failed' };
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
