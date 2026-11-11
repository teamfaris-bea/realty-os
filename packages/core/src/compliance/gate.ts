// The outbound gate: canContact() (ARCHITECTURE §9; R-CONSENT-7, -10, -17, -18; R-GATE-5, -7, -11, -12).
//
// Pure and deterministic: the same input gives the same decision and the same inputsDigest. Every
// check runs and every reason is collected; any reason ⇒ deny, else allow. Nothing can be confirmed
// past and nothing is deferred.
//
// core-compliance/2.0.0 (owner decision: every lead consented through third-party sources). The
// consent-basis requirement, the national DNC registry check, the contact window / quiet hours,
// frequency caps, timezone evidence, the defer outcome and needs_confirmation are gone. What stays:
//
//   0  autonomy: always-human categories (money, contracts, a new kind of client message, seller
//      updates) are never automated; the assistant (and the system, for categories a tenant can
//      switch on) sends only the policy-approved autonomous categories; no automated calls; agent
//      alerts only to users
//   1  tenant suspended
//   2  contact point invalid / wrong number / SMS to landline
//   3  sender missing / unregistered; marketing email needs the verified domain
//   4  marketing identity: brokerage name on all marketing; marketing email also postal address and
//      an unsubscribe link (CAN-SPAM applies regardless of consent)
//   5  OPT-OUT, no override (R-CONSENT-10): a revoked consent_state row for the channel (+ purpose for
//      SMS/email; any purpose for calls). An SMS revoke on any of the contact's phones blocks texting
//      every one of them.
//   6  active suppression (bounce, complaint, do-not-contact request, …)
//   7  payment / wire instructions
//   8  automation paused (the client replied): automated sends only
//
// core-compliance/3.0.0 (Phase 2, PHASE2_3_PLAN module 19; R-CHAN-2, R-CHAN-3, R-CHAN-5, R-GATE-13, R-INT-2).
// Owner scope change D2: Facebook Messenger and Instagram DMs are out of scope, so core has no Meta channel,
// window or platform:meta clearance check; a messenger/instagram channel is unknown to core and refused.
// New channel: website chat, gated exactly like texts (an opt-out on any of the contact's chat identities
// blocks all of them). Added checks (D1 stands: only opt-outs block, plus these, none about consent):
//
//   9  PERSON_DO_NOT_CONTACT: the person-level do-not-contact (contacts.do_not_contact_at, also when a
//      do-not-contact duplicate was merged into the recipient) blocks every channel for every initiator;
//      only the system's STOP/HELP SMS reply to the number that sent it is exempt, as in the DB guard
//  10  CHANNEL_NOT_CONNECTED: a chat reply goes out only through a connected or degraded widget connection
//  11  FAIR_HOUSING_TERMS: a hard fair-housing match (counted by core/fairhousing, module 20) blocks
//      marketing for everyone and any automated send. VERIFY WITH COUNSEL
//
// Every new input only ever adds reasons (monotonic denial, property-tested). An unknown channel throws
// ChannelUnknownError (R-GATE-13): it is refused, never mapped.
// The opt-out exemption (ARCHITECTURE §9 path 8) covers only the system's own informational SMS reply
// to a STOP/HELP keyword; it still checks everything else, suppressions included.
//
// Legal parameters come from `input.policy` (resolvePolicy). VERIFY WITH COUNSEL every default.
import type { Instant } from '../foundation/index.js';
import { canonicalize, canonicalJson, sha256Hex, type Canonical } from './digest.js';
import type { ResolvedPolicy } from './policy.js';
import { type ReasonCode, explain } from './reasons.js';
import {
  type ActionCategory,
  ALWAYS_HUMAN_CATEGORIES,
  AUTONOMOUS_ELIGIBLE,
  CHANNELS,
  type Channel,
  ChannelUnknownError,
  CONSENT_EXEMPT_CATEGORIES,
  isPlatformChannel,
  type ConsentStateRow,
  type Initiator,
  type LineType,
  type PointStatus,
  type Purpose,
  type SuppressionRow,
} from './types.js';

/** Stored in gate_decisions.core_rules_version. Bump on any change to a decision rule. */
export const RULES_VERSION = 'core-compliance/3.0.0';

/**
 * Channels whose system STOP/HELP reply may reach the identity that sent the keyword (the DB guard's
 * `exempt`, minus the out-of-scope Meta channels, D2). Chat has no keyword protocol.
 */
export const KEYWORD_REPLY_CHANNELS: ReadonlySet<Channel> = new Set<Channel>(['sms']);

/** Live connection statuses a chat reply may be sent through (R-INT-2, R-TEN-11). */
export type GateConnectionStatus = 'connected' | 'degraded' | 'other';

export interface GateInput {
  now: Instant;
  recipient: { kind: 'contact' | 'user'; addressHmac: string; channel: Channel };
  purpose: Purpose;
  initiator: Initiator;
  category: ActionCategory;
  /**
   * consent_state rows for this address, plus (SMS and voice) the contact's other phones. Only `revoked` rows
   * matter: the consent level is history and no send depends on it.
   */
  consent: ConsentStateRow[];
  /** suppressions for this address. */
  suppressions: SuppressionRow[];
  /**
   * The keyword exemption only (R-CONSENT-7): HMACs of the addresses that texted a STOP/HELP keyword into
   * this conversation in the last 24 hours. The system's reply may reach a revoked number only when that
   * number is one of them, i.e. it answers the number that asked, never another phone of the contact.
   */
  keywordSenders?: string[];
  contactPoint: { status: PointStatus; lineType: LineType } | null;
  automationPausedAt: Instant | null;
  sender: { kind: 'phone' | 'email'; registration: 'ready' | 'pending' | 'blocked'; domainVerified?: boolean } | null;
  tenant: { suspended: boolean; brokerageNamePresent: boolean; postalAddressPresent: boolean };
  rendered?: {
    containsBrokerageName: boolean;
    containsOptOutHint: boolean;
    paymentInstructions: boolean;
    /** Hard fair-housing matches in the text (core/fairhousing `check(...).hard.length`); absent = not checked. */
    fairHousingHardMatches?: number;
  };
  policy: ResolvedPolicy;
  /**
   * The person-level do-not-contact (R-CHAN-2): `contacts.do_not_contact_at` of the recipient contact, or of
   * any duplicate merged into it. False for a user recipient.
   */
  personDoNotContact: boolean;
  /** Web chat: the sending widget's `integration_connections` status; null = none. Ignored on other channels. */
  connection: { status: GateConnectionStatus } | null;
}

export type GateOutcome = 'allow' | 'deny';

export interface GateDecision {
  outcome: GateOutcome;
  reasons: ReasonCode[];
  explanation: string;
  rulesVersion: string;
  inputsDigest: string;
}

/** The canonical, plaintext-free `gate_decisions.inputs` object (R-GATE-11). */
export function gateInputsRecord(input: GateInput): { [k: string]: Canonical } {
  return canonicalize(input) as { [k: string]: Canonical };
}

/**
 * Opt-out (R-CONSENT-7, -10, -20): whether a revoked row blocks this send. `rows` hold the recipient
 * address plus, for SMS and calls, the contact's other phones. Calls are blocked by a voice revoke of
 * either purpose on any of the contact's phones (a "do not call me" is about the person, never one
 * number or one purpose; outbound-3); texts by a revoke of the send's purpose on any of the contact's
 * phones; email by a revoke of the send's purpose on the address itself.
 */
export function optedOut(rows: readonly ConsentStateRow[], channel: Channel, purpose: Purpose, addressHmac: string): boolean {
  return rows.some((r) => {
    if (r.status !== 'revoked' || r.channel !== channel) return false;
    if (channel === 'voice') return true;
    if (r.purpose !== purpose) return false;
    // texts and chat: a revoke on any of the contact's points of the kind (R-CONSENT-7); email: this address
    return r.addressHmac === addressHmac || channel !== 'email';
  });
}


export function canContact(input: GateInput): GateDecision {
  const { recipient, policy, category } = input;
  const ch = recipient.channel;
  if (!(CHANNELS as readonly string[]).includes(ch)) throw new ChannelUnknownError(String(ch));
  const platform = isPlatformChannel(ch);
  const reasons: ReasonCode[] = [];
  const add = (r: ReasonCode): void => {
    reasons.push(r); // each check adds a distinct code at most once
  };
  const automated = input.initiator !== 'human';
  const toUser = recipient.kind === 'user';
  const marketing = input.purpose === 'marketing';
  // The exemption covers only what it exists for: the system's own informational SMS reply to a
  // STOP/HELP keyword. A human, assistant, marketing, email or voice send labelled with one of these
  // categories is gated like any other send, so the label can never message an opted-out address.
  // It answers only the number that sent the keyword (outbound-1): a HELP from one phone never reaches
  // another phone of the contact that opted out earlier.
  const optOutExempt =
    CONSENT_EXEMPT_CATEGORIES.has(category) &&
    input.initiator === 'system' &&
    !marketing &&
    KEYWORD_REPLY_CHANNELS.has(ch) &&
    !toUser &&
    (input.keywordSenders ?? []).includes(recipient.addressHmac);
  const messaging = ch !== 'voice';

  // 0. autonomy / category / recipient
  if ((category === 'agent_alert') !== toUser) add('RECIPIENT_CATEGORY_MISMATCH');
  if (automated && ALWAYS_HUMAN_CATEGORIES.has(category)) add('CATEGORY_REQUIRES_HUMAN');
  if (
    (input.initiator === 'assistant' || (input.initiator === 'system' && AUTONOMOUS_ELIGIBLE.has(category))) &&
    !policy.autonomous.has(category)
  ) {
    add('CATEGORY_NOT_AUTONOMOUS');
  }
  if (automated && ch === 'voice') add('AUTOMATED_VOICE_UNAVAILABLE');

  // 1. tenant
  if (input.tenant.suspended) add('TENANT_SUSPENDED');

  // 2. contact point
  const point = input.contactPoint;
  if (point === null) {
    if (!toUser) add('CONTACT_POINT_INVALID');
  } else if (point.status === 'wrong_number') add('WRONG_NUMBER');
  else if (point.status !== 'active') add('CONTACT_POINT_INVALID');
  if (point !== null && ch === 'sms' && point.lineType === 'landline') add('LANDLINE_NO_SMS');

  // 3. sender (a chat reply is sent by its widget connection, check 10)
  const sender = input.sender;
  if (!platform) {
    if (sender === null || sender.kind !== (ch === 'email' ? 'email' : 'phone')) add('SENDER_UNAVAILABLE');
    else if (ch === 'voice' ? sender.registration === 'blocked' : sender.registration !== 'ready') add('SENDER_NOT_REGISTERED');
  }
  if (ch === 'email' && marketing && sender?.domainVerified !== true) add('EMAIL_DOMAIN_UNVERIFIED');

  // 4. marketing identity (R-GATE-12, R-CONSENT-18) and content presence
  const rendered = input.rendered;
  if (messaging && rendered === undefined) add('RENDERED_CONTENT_MISSING');
  if (marketing && (!input.tenant.brokerageNamePresent || rendered?.containsBrokerageName === false)) add('BROKERAGE_IDENTITY_MISSING');
  if (marketing && ch === 'email') {
    if (!input.tenant.postalAddressPresent) add('POSTAL_ADDRESS_MISSING');
    if (rendered?.containsOptOutHint === false) add('UNSUBSCRIBE_MISSING');
  }

  // 5. opt-out (no override, R-CONSENT-10)
  if (!optOutExempt && optedOut(input.consent, ch, input.purpose, recipient.addressHmac)) add('CONSENT_REVOKED');

  // 6. suppressions
  if (input.suppressions.some((s) => s.liftedAt === null && (s.channel === 'all' || s.channel === ch))) add('SUPPRESSED');

  // 7. payment instructions (R-GATE-7)
  if (rendered?.paymentInstructions === true) add('PAYMENT_INSTRUCTIONS');

  // 8. automation pause (R-AST-9); humans can always reply
  if (automated && !toUser && !optOutExempt && input.automationPausedAt !== null) add('AUTOMATION_PAUSED');

  // 9. person-level do-not-contact (R-CHAN-2): every channel, every initiator, no override
  if (!optOutExempt && input.personDoNotContact) add('PERSON_DO_NOT_CONTACT');

  // 10. a chat reply needs a live widget connection (R-INT-2)
  if (platform) {
    const st = input.connection?.status;
    if (st !== 'connected' && st !== 'degraded') add('CHANNEL_NOT_CONNECTED');
  }

  // 11. fair housing (R-FH-1/2 at send time): marketing for everyone, anything automated
  if ((rendered?.fairHousingHardMatches ?? 0) > 0 && (marketing || automated)) add('FAIR_HOUSING_TERMS');

  const outcome: GateOutcome = reasons.length > 0 ? 'deny' : 'allow';
  return {
    outcome,
    reasons,
    explanation: explain(outcome, reasons, ch),
    rulesVersion: RULES_VERSION,
    inputsDigest: sha256Hex(canonicalJson(input)),
  };
}
