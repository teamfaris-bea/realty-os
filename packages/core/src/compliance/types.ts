// Shared vocabulary of core/compliance (BUILD_PLAN module 2, DATA_MODEL §1.4, §1.5, R-CONSENT, R-GATE).
//
// Every string union mirrors a CHECK constraint in packages/db/migrations/0001_init.sql, so values
// read from the database can be passed straight in after the API has validated them.
//
// Addresses never appear here in plaintext (R-CONSENT-1): consent, suppressions, DNC checks and
// gate decisions are keyed by the tenant HMAC of the normalized address, carried as a lowercase
// hex string (`addressHmac`).
import type { Instant } from '../foundation/index.js';

/**
 * Consent channels (core-compliance/3.0.0, R-GATE-13). Owner scope change D2: Facebook Messenger and
 * Instagram direct messages are out of scope, so they are NOT core channels even though 0018's CHECKs
 * still list them (a later migration narrows those; the DB guard refuses them until counsel review, and
 * core refuses them outright as unknown channels). The architecture test (packages/db/test/
 * channels_architecture.test.ts) asserts core = the DB lists minus exactly those two.
 */
export type Channel = 'sms' | 'voice' | 'email' | 'web_chat';
export const CHANNELS: readonly Channel[] = ['sms', 'voice', 'email', 'web_chat'];

/** DB channel values that exist in 0018 but are out of scope (D2): never mapped, always refused by core. */
export const OUT_OF_SCOPE_CHANNELS: readonly string[] = ['messenger', 'instagram'];

/** The Phase 1 channels (phone and email addresses). */
export type PhoneEmailChannel = 'sms' | 'voice' | 'email';
export const PHONE_EMAIL_CHANNELS: readonly PhoneEmailChannel[] = ['sms', 'voice', 'email'];

/** Chat channels: the sender identity is an `integration_connections` row (R-INBOX-3). */
export type PlatformChannel = 'web_chat';
export const PLATFORM_CHANNELS: readonly PlatformChannel[] = ['web_chat'];
export function isPlatformChannel(c: Channel): c is PlatformChannel {
  return c === 'web_chat';
}

/**
 * Stored message channels core sends on and the consent channel each maps to: the explicit map of
 * `messages_dispatch_guard` (MMS is a text) minus the out-of-scope DM channels. Anything else is
 * `CHANNEL_UNKNOWN` (R-GATE-13, E80): there is no fallthrough.
 */
export type MessageChannel = 'sms' | 'mms' | 'email' | 'web_chat';
export const MESSAGE_CHANNEL_MAP: Readonly<Record<MessageChannel, Exclude<Channel, 'voice'>>> = Object.freeze({
  sms: 'sms',
  mms: 'sms',
  email: 'email',
  web_chat: 'web_chat',
});
export const MESSAGE_CHANNELS: readonly MessageChannel[] = Object.keys(MESSAGE_CHANNEL_MAP) as MessageChannel[];

export class ChannelUnknownError extends Error {
  readonly code = 'CHANNEL_UNKNOWN';
  constructor(readonly channel: string) {
    super(`CHANNEL_UNKNOWN: no opt-out mapping for channel ${channel}`);
  }
}

/** The consent channel a stored message channel is gated on; throws `ChannelUnknownError` for anything else. */
export function gateChannelForMessage(channel: string): Exclude<Channel, 'voice'> {
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_CHANNEL_MAP, channel)) throw new ChannelUnknownError(channel);
  return MESSAGE_CHANNEL_MAP[channel as MessageChannel];
}

export type Purpose = 'marketing' | 'informational';
export const PURPOSES: readonly Purpose[] = ['marketing', 'informational'];

/** Purpose as stored on a consent event: `all` applies to both purposes (R-CONSENT-2). */
export type EventPurpose = Purpose | 'all';

export type Initiator = 'human' | 'assistant' | 'system';

export type ActionCategory =
  | 'none'
  | 'speed_to_lead_reply'
  | 'reminder'
  | 'booking_confirmation'
  | 'document_chase'
  | 'nurture_step'
  | 'search_alert'
  | 'opt_out_confirmation'
  | 'help_reply'
  | 'agent_alert'
  | 'money'
  | 'contract'
  | 'novel_message'
  | 'seller_update'
  // D12 (proposed; docs/AI_ISA.md §2.2, §8.1): sendable only by the assistant under autonomy `ai_isa_mandate`
  | 'ai_isa_message'
  | 'ai_isa_confirmation'
  | 'ai_isa_holding_line';

export const ACTION_CATEGORIES: readonly ActionCategory[] = [
  'none',
  'speed_to_lead_reply',
  'reminder',
  'booking_confirmation',
  'document_chase',
  'nurture_step',
  'search_alert',
  'opt_out_confirmation',
  'help_reply',
  'agent_alert',
  'money',
  'contract',
  'novel_message',
  'seller_update',
  'ai_isa_message',
  'ai_isa_confirmation',
  'ai_isa_holding_line',
];

/** Never autonomous (R-AST-3, DB CHECK on compliance_policy_versions.autonomous_categories). */
export const ALWAYS_HUMAN_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  'money',
  'contract',
  'novel_message',
  'seller_update',
]);

/** The only categories a tenant may make autonomous (DB CHECK). */
export const AUTONOMOUS_ELIGIBLE: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  'speed_to_lead_reply',
  'reminder',
  'booking_confirmation',
  'document_chase',
  'nurture_step',
  'search_alert',
]);

/**
 * The AI ISA categories (D12 proposed, docs/AI_ISA.md §2.2, R-ISA-8, R-ISA-23). Never in AUTONOMOUS_ELIGIBLE or a
 * policy's autonomous set (R-AST-20 holds): the gate's check 0 sends them only for `initiator='assistant'` with the
 * AI ISA facts (`GateInput.aiIsa`), and check 12 adds the AI-only send checks on top of D1.
 */
export const AI_ISA_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>(['ai_isa_message', 'ai_isa_confirmation', 'ai_isa_holding_line']);

export function isAiIsaCategory(c: ActionCategory): boolean {
  return AI_ISA_CATEGORIES.has(c);
}

/**
 * The facts dispatch TX1 reads for one AI ISA message (docs/AI_ISA.md §5.4). Core/isa computes the consent basis
 * (`aiIsaConsentBasis`), the zone set (`aiIsaRecipientZones`) and the counts; the gate re-applies each rule. Read by
 * checks 0, 8 and 12 for the AI ISA categories ONLY: every other category ignores it (non-interference, R-ISA-8).
 * VERIFY WITH COUNSEL: every value that comes from pack rules.
 */
export interface AiIsaGateFacts {
  /** 12a: the R-ISA-1 chain links that fail now (`AI_ISA_CHAIN_LINKS`); empty when the chain holds. */
  chainFailures: readonly string[];
  /** 8: the assignment is paused, ended, stopped or blocked (liveness, R-ISA-15, R-ISA-31). */
  paused: boolean;
  /** 8: `aa.pinned_inbound_seq = conversations.inbound_seq` (ISA_STALE_REPLY). */
  pinnedSeqCurrent: boolean;
  /** 8: `aa.epoch = assignment.epoch` (ISA_STALE_EPOCH). */
  epochCurrent: boolean;
  /** 8: conversations.automation_pause_reason; opt_out and wrong_number still block (docs/AI_ISA.md §5.4). */
  conversationPauseReason: string | null;
  /** 12a: the HMAC of the point bound for this channel at start (R-ISA-28); null = none bound. */
  boundRecipientHmac: string | null;
  /** 12b: the channels the content, the opt-in and the assignment allow. */
  allowedChannels: readonly ('sms' | 'email')[];
  /** 12b: the message carries media (never, D5(a)). */
  hasMedia: boolean;
  /** 12c: core/isa `aiIsaConsentBasis` for this message: the missing parts, empty when the tier passes. */
  consentMissing: readonly ('evidence' | 'reply_window' | 'dnc')[];
  /** 12d: the conservative zone set (`aiIsaRecipientZones`); empty = unresolved. */
  zones: readonly string[];
  /** 12d: the window in seconds after local midnight (content window, within the pack ceiling). */
  windowStartSec: number;
  windowEndSec: number;
  /** 12d: an initiated message (core/isa `messageKind`), which also obeys the days and the holidays. */
  initiated: boolean;
  /** 12d: ISO weekdays (1 = Monday) initiated messages may go out on. */
  initiatedDays: readonly number[];
  /** 12d: local dates (YYYY-MM-DD) with no initiated message (US federal holidays by default; VERIFY). */
  holidays: readonly string[];
  /** 12e: counts across all the person's addresses, rolling (docs/AI_ISA.md §5.3 counted statuses). */
  counts: { ai24h: number; automated24h: number; initiated24h: number; initiated7d: number; lastAiOutboundAt: Instant | null };
  /** 12e: the caps in force (content values, at or below the pack ceiling). */
  caps: { ai24h: number; automated24h: number; initiated24h: number; initiated7d: number; minGapSeconds: number };
  /** 12f */
  sharedAddress: boolean;
  activeClient: boolean;
  /** 12g: the message carries a sold-derived fact (comp set or nearby sale). */
  soldDerivedFact: boolean;
  /** 12g: platform:cma and platform:ai_isa_seller_data cleared, and the licence's `valuation.ai_isa_comps`. */
  sellerPacksCleared: boolean;
}

/**
 * Opt-out-exempt system replies (ARCHITECTURE §9 path 8): the system's own informational SMS answer to
 * a STOP/HELP keyword may reach the address that just opted out. Still sender-registration,
 * suppression and content checked.
 */
export const CONSENT_EXEMPT_CATEGORIES: ReadonlySet<ActionCategory> = new Set<ActionCategory>([
  'opt_out_confirmation',
  'help_reply',
]);

// ---- consent ------------------------------------------------------------------------------------
//
// The ledger keeps recording every consent event (opt-ins as history, opt-outs as blocks). Since
// core-compliance/2.0.0 (owner decision: every lead consented through third-party sources) no send
// depends on the consent LEVEL; the gate reads only whether a row is `revoked`.

/** Ordered weakest → strongest (DATA_MODEL §1.4). History only: no send reads the level. */
export type ConsentLevel = 'none' | 'imported_unverified' | 'inquiry' | 'express' | 'express_written';
export const CONSENT_LEVELS: readonly ConsentLevel[] = ['none', 'imported_unverified', 'inquiry', 'express', 'express_written'];

export function levelRank(l: ConsentLevel): number {
  return CONSENT_LEVELS.indexOf(l);
}

export function atLeast(l: ConsentLevel, min: ConsentLevel): boolean {
  return levelRank(l) >= levelRank(min);
}

export type ConsentEventType = 'grant' | 'revoke' | 'resubscribe' | 'expire' | 'import_revert';

export type ConsentSource =
  | 'web_form'
  | 'lead_provider'
  | 'inbound_first_contact'
  | 'inbound_keyword'
  | 'inbound_language'
  | 'verbal_on_call'
  | 'agent_entry'
  | 'signed_document'
  | 'provider_report'
  | 'wrong_number'
  | 'agent_revoke'
  | 'import_fub'
  | 'import_csv'
  | 'system_expiry';

/** Phase 1 address kinds (phones and emails: imports, intake). */
export type AddressKind = 'phone' | 'email';

/** Contact-point kinds core works with: 0018's `contact_points.kind` minus the out-of-scope DM kinds (D2). */
export type PointKind = AddressKind | 'web_chat';
export const POINT_KINDS: readonly PointKind[] = ['phone', 'email', 'web_chat'];

/** The kind of contact point a channel reaches: texts and calls a phone, email an email, chat its session identity. */
export function pointKindOf(channel: Channel): PointKind {
  switch (channel) {
    case 'sms':
    case 'voice':
      return 'phone';
    case 'email':
      return 'email';
    default:
      return channel;
  }
}

/** The consent channels a point of `kind` carries (a platform identity carries only its own, 0018 CHECK). */
export function channelsOfKind(kind: PointKind): Channel[] {
  switch (kind) {
    case 'phone':
      return ['sms', 'voice'];
    case 'email':
      return ['email'];
    default:
      return [kind];
  }
}

/** The status of one `consent_state` row. */
export type ConsentStatus = 'granted' | 'revoked' | 'none';

/** `${channel}:${purpose}:${addressHmac}`; build with `consentKey()`. */
export type ConsentKey = string & { readonly __brand: 'ConsentKey' };

export function consentKey(channel: Channel, purpose: Purpose, addressHmac: string): ConsentKey {
  return `${channel}:${purpose}:${addressHmac}` as ConsentKey;
}

/** One row of the `consent_state` projection (R-CONSENT-2, R-CONSENT-6). */
export interface ConsentStateRow {
  channel: Channel;
  purpose: Purpose;
  addressHmac: string;
  status: ConsentStatus;
  level: ConsentLevel;
  basisEventId: string | null;
  expiresAt: Instant | null;
  /** Number of ledger events for this key (purpose or `all`): the DB guard compares it. */
  ledgerEventCount: number;
}

// ---- suppressions, contact points ---------------------------------------------------------------

export type SuppressionReason =
  | 'hard_bounce'
  | 'spam_complaint'
  | 'undeliverable'
  | 'landline_no_sms'
  | 'internal_dnc'
  | 'admin_block'
  | 'wrong_number'
  | 'provider_opt_out'
  | 'import_dnc'
  | 'platform_blocked';

/** A `suppressions` row for the recipient's address. Lifted rows are ignored by the gate. */
export interface SuppressionRow {
  channel: Channel | 'all';
  reason: SuppressionReason;
  liftedAt: Instant | null;
}

export type PointStatus = 'active' | 'invalid' | 'wrong_number' | 'bouncing' | 'removed';
export type LineType = 'mobile' | 'landline' | 'voip' | 'toll_free' | 'unknown';

// ---- policy -------------------------------------------------------------------------------------

/** Inbound keyword lists, upper-case (R-CONSENT-7, pack `opt_out_keywords` etc.). */
export interface Keywords {
  optOut: readonly string[];
  resubscribe: readonly string[];
  help: readonly string[];
}

/** Recording party rule of one jurisdiction pack (`recording_party_rule`). */
export type PartyRule = 'one_party' | 'all_party' | 'unknown';
