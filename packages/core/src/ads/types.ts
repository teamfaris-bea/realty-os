// Types of core/ads (PHASE2_3_PLAN module 51), mirroring 0018 §15: ad_campaigns, ad_budget_caps and
// ad_allocation_events, and the payload app.ad_allocation_cap_check() reads. Money is integer cents
// (safe integers ≥ 0) everywhere; there is no float and no tenant_id.
import type { Brand, Instant, ListingId } from '../foundation/index.js';
import type { PieceStatus } from '../marketing/index.js';

// ---- branded ids (0018 §15) -----------------------------------------------------------------
export type CampaignId = Brand<string, 'AdCampaignId'>;
export type CapVersionId = Brand<string, 'AdBudgetCapId'>;
export type MarketingPieceId = Brand<string, 'MarketingPieceId'>;

/** ad_campaigns.status (0018). */
export const CAMPAIGN_STATUSES = ['draft', 'active', 'paused', 'ended', 'rejected'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/** integration_connections.status (0018). R-INT-2: only connected or degraded connections act. */
export const CONNECTION_STATUSES = ['not_configured', 'needs_partner_access', 'pending_review', 'connected', 'degraded', 'revoked', 'disconnected'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** ad_allocation_events.event_kind (0018). */
export const LEDGER_EVENT_KINDS = ['planned', 'applied', 'failed', 'paused'] as const;
export type LedgerEventKind = (typeof LEDGER_EVENT_KINDS)[number];

/** One ad_campaigns row with its connection and creative, and its latest ledger event. */
export interface Campaign {
  readonly id: CampaignId;
  /** integration_connections.kind as stored. Only exactly 'ads_google' is ever moved (D2). */
  readonly connectionKind: string;
  readonly connectionStatus: ConnectionStatus;
  readonly status: CampaignStatus;
  /** ad_campaigns.special_category as stored (the CHECK keeps it 'housing'). */
  readonly specialCategory: string;
  /** ad_campaigns.targeting as stored (a TargetingSpec, R-FH-4); read only by the validator, never copied. */
  readonly targeting: unknown;
  readonly listingId: ListingId | null;
  /** The creative piece (marketing_pieces) or null. */
  readonly creative: { readonly pieceId: MarketingPieceId; readonly status: PieceStatus; readonly listingId: ListingId } | null;
  /** daily_budget_cents: the platform's budget, mirrored by the system. */
  readonly dailyBudgetCents: number;
  /** The campaign's latest ad_allocation_events row (by occurred_at, then id), or null. */
  readonly latestEvent: { readonly kind: LedgerEventKind; readonly toDailyCents: number } | null;
}

/** Provider-reported spend of one campaign over the rules' window (windowDays must equal AllocRules.windowDays). */
export interface Spend {
  readonly campaignId: CampaignId;
  readonly spendCents: number;
  readonly windowDays: number;
}

/** Attributed outcomes of one campaign: the API attributes by campaign_ref (lead_inquiries, deals). */
export interface OutcomeCounts {
  readonly campaignId: CampaignId;
  /** Deals of this campaign that reached agreement_signed in the window (R-ADS-6 counts these). */
  readonly agreements: number;
  readonly closings: number;
}

/** Outcomes over a window; the window must be the rules' window. */
export interface Outcomes {
  readonly windowDays: number;
  readonly campaigns: readonly OutcomeCounts[];
}

/** One ad_budget_caps version. */
export interface Cap {
  readonly id: CapVersionId;
  readonly versionNo: number;
  readonly monthlyCapCents: number;
  readonly dailyCeilingCents: number;
  readonly effectiveFrom: Instant;
}

export type LeadingOutcome = 'agreements' | 'closings';

/** Core defaults (0018 has no rules table). */
export interface AllocRules {
  /** The outcome window, in days. R-ADS-6: 90. */
  readonly windowDays: number;
  /** R-ADS-6: agreements a campaign needs in the window before money moves to or from it (product default 5). */
  readonly minAgreements: number;
  /** Which outcome a dollar is measured against. Default 'agreements' (R-ADS-6 counts agreements; §1 names appointments/closings). */
  readonly leadingOutcome: LeadingOutcome;
  /** The most one proposal lowers a campaign by to move money, in basis points of its budget (default 2000 = 20 %). */
  readonly maxShiftBps: number;
  /** No campaign is moved below this daily budget (default 0). VERIFY (N14): the platform's minimum daily budget and increment. */
  readonly minDailyCents: number;
}

/** One element of assistant_actions.payload->'changes', exactly as the cap trigger reads it. */
export interface AllocationChange {
  readonly campaign_id: string;
  readonly to_daily_cents: number;
}

/** Why a campaign is not moved (R-ADS-4, R-INT-2, D2; a paused campaign is resumed by a tap). */
export type EligibilityCode =
  | 'NOT_GOOGLE_ADS'
  | 'CONNECTION_NOT_LIVE'
  | 'NOT_ACTIVE'
  | 'PAUSED'
  | 'REJECTED'
  | 'NOT_HOUSING_CATEGORY'
  | 'TARGETING_REFUSED'
  | 'CREATIVE_NOT_APPROVED'
  | 'CHANGE_IN_FLIGHT';

/** ad_allocation_events.reason_code of a row (matches ^[A-Z][A-Z0-9_]*$). */
export type ProposalReasonCode =
  | 'RAISED_LOWER_COST_PER_OUTCOME'
  | 'LOWERED_HIGHER_COST_PER_OUTCOME'
  | 'LOWERED_TO_FIT_CEILING'
  | 'KEPT_UNCHANGED'
  | 'KEPT_BELOW_MINIMUM_SAMPLE'
  | 'KEPT_NO_SPEND'
  | 'KEPT_NOT_ELIGIBLE';

/** Every campaign in a proposal, as the cap check counts it. */
export interface ProposalRow {
  readonly campaignId: CampaignId;
  /** What the cap check counts today (0 for a campaign that is not active). */
  readonly fromDailyCents: number;
  readonly toDailyCents: number;
  readonly changed: boolean;
  readonly reasonCode: ProposalReasonCode;
  /** A plain sentence with its denominators. */
  readonly sentence: string;
  /** Why it is not moved (empty when it is eligible). */
  readonly blockers: readonly EligibilityCode[];
  /** The targeting validator's issues, when TARGETING_REFUSED (field names, never values). */
  readonly targetingIssues: readonly string[];
}

export interface CampaignCounts {
  readonly campaignId: CampaignId;
  readonly agreements: number;
  readonly closings: number;
  readonly spendCents: number;
}

/** Every campaign's outcomes and spend, and the minimum sample (R-ADS-6). */
export interface Counts {
  readonly windowDays: number;
  readonly minAgreements: number;
  readonly leadingOutcome: LeadingOutcome;
  readonly campaigns: readonly CampaignCounts[];
}

export interface Proposal {
  readonly capVersionId: CapVersionId;
  readonly capVersionNo: number;
  /** The ad_reallocation payload's `changes`: only the campaigns whose budget changes. */
  readonly changes: readonly AllocationChange[];
  /** Every campaign (by id), changed or not. */
  readonly rows: readonly ProposalRow[];
  readonly totals: { readonly currentDailyCents: number; readonly proposedDailyCents: number; readonly ceilingDailyCents: number };
  readonly counts: Counts;
}

/** Codes of a hold (CONVENTIONS §7: the module's code union). */
export type AdsHoldCode = 'ADS_BELOW_MINIMUM_SAMPLE' | 'ADS_NO_PLAN_FITS' | 'ADS_NOTHING_TO_MOVE';
export type AdsErrorCode = AdsHoldCode;

export interface Hold {
  readonly hold: AdsHoldCode;
  readonly counts: Counts;
}

/** One provider-reported hour of one campaign's spend, in the provider's reporting zone. */
export interface HourlySpend {
  readonly campaignId: CampaignId;
  readonly hourStart: Instant;
  readonly spendCents: number;
}
