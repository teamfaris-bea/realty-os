// Shared vocabulary of core/isa (docs/AI_ISA.md §4; D12 proposed). Every string union mirrors a value the DB lanes
// (ISA-2, ISA-3) store, so the API can pass validated rows straight in. No confidence fields anywhere (R-AST-13).
import type { Instant } from '../foundation/index.js';

export type IsaSide = 'buyer' | 'seller' | 'both';
export type IsaChannel = 'sms' | 'email';
export const ISA_CHANNELS: readonly IsaChannel[] = ['sms', 'email'];

/** §3.2 capabilities. `share_value_estimate` and `seller_market_stats` are reserved and always refused. */
export const ISA_CAPABILITIES = ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'] as const;
export type IsaCapability = (typeof ISA_CAPABILITIES)[number];
export const ISA_RESERVED_CAPABILITIES = ['share_value_estimate', 'seller_market_stats'] as const;

/** §4.1 phases. `awaiting_agent` is the hold-topic phase; `paused` and `ended` carry their reason in the state. */
export const ISA_PHASES = ['starting', 'awaiting_reply', 'engaged', 'nurture', 'scheduling', 'booking', 'awaiting_agent', 'paused', 'ended'] as const;
export type IsaPhase = (typeof ISA_PHASES)[number];

/** §4.1 `ended.reason`. Exactly one handoff is written for each. */
export const ISA_END_REASONS = [
  'appointment_booked',
  'ready_buyer',
  'ready_seller',
  'escalated',
  'opted_out',
  'suppressed',
  'do_not_contact',
  'wrong_number',
  'owner_change',
  'merged',
  'owner_inactive',
  'tenant_off',
  'optin_revoked',
  'policy_updated',
  'inactivity_warning',
  'dormant',
  'limit_reached',
  'delivery_problem',
  'listed_elsewhere',
  'active_client',
  'shared_address',
  'point_removed',
  'pause_expired',
  'ended_by_user',
  'taken_over',
  'has_agent',
  'not_interested',
  'not_a_lead',
  'reinquiry_period',
  'zone_windows_do_not_overlap',
] as const;
export type IsaEndReason = (typeof ISA_END_REASONS)[number];

/** Why care is paused (§2.1, §3.1, §3.7). Resume is the owner's only (R-ISA-15). */
export const ISA_PAUSE_REASONS = [
  'user',
  'human_contact',
  'unverified_sender',
  'call',
  'chat',
  'synced_mail',
  'media',
  'pack_withdrawn',
  'ai_off',
  'approval_revoked',
  'policy_updated',
  'reinquiry',
  'possible_listing',
  'check_this',
  'taking_over',
  'ending',
] as const;
export type IsaPauseReason = (typeof ISA_PAUSE_REASONS)[number];

/** §4.4 escalation classes, in precedence order (rows 1–9 are stop classes; the slot choice sits between 9 and 11). */
export const ESCALATION_CLASSES = [
  'opt_out',
  'wrong_number',
  'possible_opt_out',
  'safety',
  'fraud_risk',
  'consent_dispute',
  'privacy_request',
  'ai_declined',
  'complaint',
  'human_request',
  'fair_housing',
  'legal_contract',
  'third_party',
  'other_agent',
  'pricing_negotiation',
  'financial',
  'sensitive_personal',
  'language',
  'data_unavailable',
  'booking_unavailable',
  'uncertain',
  'limit',
  'flood',
] as const;
export type EscalationClass = (typeof ESCALATION_CLASSES)[number];

/** terminal: ends care with a handoff; hold_topic: `awaiting_agent`, care continues; check_this: pauses with a card. */
export type EscalationType = 'terminal' | 'hold_topic' | 'check_this';
export type EscalationPriority = 'critical' | 'high' | 'normal' | 'low';

/** §4.3 qualification fields. */
export const QUAL_FIELDS = [
  'timeline',
  'financing_status_stated',
  'areas',
  'budget',
  'beds_min',
  'baths_min',
  'property_type',
  'must_haves_structured',
  'seller_timeline',
  'seller_owns_stated',
  'seller_listed_elsewhere_stated',
  'seller_motivation',
  'seller_next_move',
  'wants_agent_contact',
] as const;
export type QualField = (typeof QUAL_FIELDS)[number];

export const FINANCING_VALUES = ['preapproved', 'cash', 'talking_to_lender', 'not_started'] as const;
export type FinancingValue = (typeof FINANCING_VALUES)[number];

/** Message kinds the machine queues (§4.1); purpose is always marketing (R-ISA-8). */
export type IsaMessageKind = 'conversation' | 'facts' | 'offer' | 'confirmation' | 'holding_line';

/** One server-rendered time slot. `startsAt`/`endsAt` are instants; the rendering adds zones. */
export interface IsaSlot {
  startsAt: Instant;
  endsAt: Instant;
}

/** A usable qualification claim (verified, client own text on a bound point, value in the quote: R-ISA-27). */
export interface UsableQualClaim {
  claimId: string;
  field: QualField;
  value: QualValue;
  quote: string;
  messageId: string;
  /** The instant the client wrote it (relative timelines resolve against it). */
  saidAt: Instant;
}

export type QualValue = string | number | boolean | readonly string[];
