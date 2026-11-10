// Shared vocabulary of core/compliance (BUILD_PLAN module 2, DATA_MODEL §1.4, §1.5, R-CONSENT, R-GATE).
//
// Every string union mirrors a CHECK constraint in packages/db/migrations/0001_init.sql, so values
// read from the database can be passed straight in after the API has validated them.
//
// Addresses never appear here in plaintext (R-CONSENT-1): consent, suppressions, DNC checks and
// gate decisions are keyed by the tenant HMAC of the normalized address, carried as a lowercase
// hex string (`addressHmac`).
import type { Instant } from '../foundation/index.js';

export type Channel = 'sms' | 'voice' | 'email';
export const CHANNELS: readonly Channel[] = ['sms', 'voice', 'email'];

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
  | 'seller_update';

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

export type AddressKind = 'phone' | 'email';

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
  | 'import_dnc';

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
