// Shared vocabulary of core/marketing (PHASE2_3_PLAN module 27; DATA_MODEL Part 2 R-MKT-1..10,
// R-SELL-2/3, R-FH-1/2; E85, E87, E89..E94).
//
// - A `PieceVersion` mirrors one `marketing_pieces` row (0018 section 7) plus its ordered
//   `marketing_piece_assets`. Its prose is the only model/agent-written text; bound facts (price,
//   status, beds, baths, sqft, address, open-house time, photos) are never in the prose, they render
//   live from the team listing (R-MKT-3, E90).
// - `Rendered` is a piece as blocks, each with its origin (prose / bound fact / identity / pack) and
//   a prominence class, so jurisdiction advertising rules such as "brokerage name at least as
//   prominent as the team name" (E92) can be evaluated on data, plus the plain text.
// - `GuardResult` IS the `marketing_pieces.guard_result` JSON: snake_case keys the approval CHECK
//   reads (`content_sha256`, `brokerage_name_present`, `hard_count`, `pack_rule_failures`).
// - `AdvertisingPack` is jurisdiction advertising-rule data with the strictest default. Every value
//   is product policy, not legal advice: **VERIFY WITH COUNSEL** per jurisdiction.
// There are no confidence fields anywhere in this module (R-AST-13): claims carry evidence.
import type { IanaZone, Instant, MessageId, ShowingId, StoredObjectId } from '../foundation/index.js';
import type { ClaimKind, Locator } from '../assistant/index.js';
import type { CompetingRule, LicensePack, ListingFacts } from '../listings/index.js';

// ---- pieces -------------------------------------------------------------------------------------

/** marketing_pieces.kind */
export const PIECE_KINDS = ['website_page', 'social_post', 'open_house_invite', 'flyer', 'marketplace_export', 'gbp_post'] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

/** marketing_pieces.status */
export const PIECE_STATUSES = ['draft', 'approved', 'published', 'exported', 'retracted', 'superseded'] as const;
export type PieceStatus = (typeof PIECE_STATUSES)[number];

/** marketing_pieces.bound_fields (the DB CHECK's set, in its order). */
export const BOUND_FIELDS = ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'open_house_at', 'photos'] as const;
export type BoundField = (typeof BOUND_FIELDS)[number];

/** One image of a piece (marketing_piece_assets: position 1..50, a live `marketing_asset` object). */
export interface AssetRef {
  readonly objectId: StoredObjectId;
  readonly position: number;
}

/** marketing_pieces.open_house (open_house_invite only). Instants are stored; the zone renders them. */
export interface OpenHouse {
  readonly startsAt: Instant;
  readonly endsAt: Instant;
  readonly zone: IanaZone;
}

export interface WebsitePageProse {
  readonly headline: string;
  readonly body: string;
  readonly highlights: readonly string[];
}
export interface SocialPostProse {
  readonly caption: string;
  readonly hashtags: readonly string[];
}
export interface OpenHouseInviteProse {
  readonly subject: string;
  readonly body: string;
}
export interface FlyerProse {
  readonly headline: string;
  readonly body: string;
  readonly highlights: readonly string[];
}
export interface MarketplaceExportProse {
  readonly title: string;
  readonly description: string;
}
export interface GbpPostProse {
  readonly body: string;
}

export interface ProseByKind {
  website_page: WebsitePageProse;
  social_post: SocialPostProse;
  open_house_invite: OpenHouseInviteProse;
  flyer: FlyerProse;
  marketplace_export: MarketplaceExportProse;
  gbp_post: GbpPostProse;
}

/** One version of one piece (marketing_pieces + its ordered assets). `prose` is validated by `PieceSchemas[kind]`. */
export interface PieceVersion<K extends PieceKind = PieceKind> {
  readonly kind: K;
  readonly versionNo: number;
  readonly prose: ProseByKind[K] | Readonly<Record<string, unknown>>;
  readonly templateKey: string;
  readonly boundFields: readonly BoundField[];
  readonly assets: readonly AssetRef[];
  readonly openHouse?: OpenHouse | null;
}

// ---- identity and packs -----------------------------------------------------------------------

/** Who advertises (tenant_settings): the brokerage of record and the team operating under it. */
export interface BrokerageIdentity {
  /** The brokerage's legal (licensed) name; R-MKT-1 requires it on every piece. */
  readonly brokerageLegalName: string;
  /** tenant_settings.team_name (or the tenant name). Equal to the brokerage name for a solo brokerage. */
  readonly teamName: string;
  readonly licenseNumber: string | null;
  readonly brokerageAddress: string | null;
  readonly brokeragePhone?: string | null;
}

/** How large a block is drawn. Ordered: footnote < small < body < heading < display. */
export const PROMINENCE = ['footnote', 'small', 'body', 'heading', 'display'] as const;
export type Prominence = (typeof PROMINENCE)[number];

/**
 * Advertising rules of one jurisdiction pack (jurisdiction_packs.rules.advertising), parsed with the
 * strictest value for anything missing. **VERIFY WITH COUNSEL** every field per jurisdiction.
 */
export interface AdvertisingPack {
  /** jurisdiction_packs id / key, named in failure reasons. */
  readonly id: string;
  /** The brokerage name is drawn at least as prominently as the team name (E92). Strictest: true. */
  readonly brokerageNameAtLeastAsProminentAsTeam: boolean;
  /** Every piece shows the brokerage licence number. Strictest: true. */
  readonly requireLicenseNumber: boolean;
  /** Every piece shows the brokerage office address. Strictest: true. */
  readonly requireBrokerageAddress: boolean;
  /** Every piece carries the equal-housing statement. Strictest: true. */
  readonly requireEqualHousingStatement: boolean;
  /** The statement's wording. Default "Equal Housing Opportunity." (VERIFY WITH COUNSEL). */
  readonly equalHousingStatement: string;
  /** Words a team name may not contain (e.g. words implying it is itself a brokerage). Default none: counsel supplies them. */
  readonly teamNameForbiddenTerms: readonly string[];
  /** When counsel reviewed the pack; null = unreviewed. Shown, never used to relax a rule. */
  readonly reviewedByCounselAt: string | null;
}

/** Every pack that governs the listing's jurisdiction (platform floor ∧ each pack). Empty ⇒ strictest default. */
export interface Packs {
  readonly advertising: readonly AdvertisingPack[];
}

/** The combined rules (strictest of every pack) plus which packs asked for each one. */
export interface AdvertisingRules {
  readonly brokerageNameAtLeastAsProminentAsTeam: boolean;
  readonly requireLicenseNumber: boolean;
  readonly requireBrokerageAddress: boolean;
  readonly requireEqualHousingStatement: boolean;
  readonly equalHousingStatement: string;
  readonly teamNameForbiddenTerms: readonly string[];
  /** rule → pack ids that require it ('platform.default' when no pack was given). */
  readonly requiredBy: Readonly<Record<AdvertisingRuleId, readonly string[]>>;
}

export type AdvertisingRuleId =
  | 'brokerage_name_prominence'
  | 'license_number'
  | 'brokerage_address'
  | 'equal_housing_statement'
  | 'team_name_terms';

// ---- rendering --------------------------------------------------------------------------------

export type BlockRole =
  | 'headline'
  | 'subject'
  | 'title'
  | 'caption'
  | 'body'
  | 'highlights'
  | 'hashtags'
  | 'price'
  | 'status'
  | 'facts'
  | 'address'
  | 'open_house'
  | 'gallery'
  | 'brokerage_name'
  | 'team_name'
  | 'license'
  | 'brokerage_address'
  | 'equal_housing';

/** Where a block's words come from. Only `prose` is model/agent-written copy (R-MKT-3 numerals rule). */
export type BlockOrigin = 'prose' | 'bound' | 'identity' | 'pack';

export interface Block {
  readonly role: BlockRole;
  readonly origin: BlockOrigin;
  readonly prominence: Prominence;
  readonly text: string;
}

/** A platform-level problem found while rendering (not a jurisdiction pack rule). */
export interface RenderIssue {
  readonly ruleId: string;
  readonly reason: string;
}

export type MarketingRefusalCode =
  | 'MARKETING_TEAM_LISTING_ONLY'
  | 'MARKETING_TEMPLATE_UNKNOWN'
  | 'MARKETING_PROSE_INVALID'
  | 'MARKETING_BOUND_FIELD_INVALID';

export interface RenderedPiece {
  readonly ok: true;
  readonly kind: PieceKind;
  readonly templateKey: string;
  readonly blocks: readonly Block[];
  /** Plain text: every block with text, in order, one per line. */
  readonly text: string;
  /** The piece's images, in position order. */
  readonly images: readonly AssetRef[];
  readonly issues: readonly RenderIssue[];
}

export interface RenderRefusal {
  readonly ok: false;
  readonly code: MarketingRefusalCode;
  readonly reason: string;
}

/** `renderPiece`'s result: a rendering, or a refusal (an MLS listing, an unknown template, invalid prose). */
export type Rendered = RenderedPiece | RenderRefusal;

// ---- guard result (= marketing_pieces.guard_result) ---------------------------------------------

export interface GuardTermHit {
  readonly term_id: string;
  readonly text: string;
}

export interface PackRuleFailure {
  /** An AdvertisingRuleId, or a platform rule id such as 'R-MKT-3'. */
  readonly rule_id: string;
  /** The jurisdiction pack that requires it, or 'platform'. */
  readonly pack_id: string;
  /** Human sentence shown where approval is refused (E92). */
  readonly reason: string;
}

export type NumeralShape = 'price' | 'date' | 'time' | 'year' | 'number_words';

export interface NumeralIssue {
  readonly role: BlockRole;
  readonly shape: NumeralShape;
  readonly text: string;
}

/** Exactly the JSON written to marketing_pieces.guard_result. Produced only by `guardResult`. */
export interface GuardResult {
  readonly content_sha256: string;
  readonly brokerage_name_present: boolean;
  readonly hard_count: number;
  readonly hard: readonly GuardTermHit[];
  readonly soft: readonly GuardTermHit[];
  readonly pack_rule_failures: readonly PackRuleFailure[];
  readonly numeral_issues: readonly NumeralIssue[];
  readonly lexicon_version: string;
  readonly fair_housing_reviewed: boolean;
}

// ---- export ----------------------------------------------------------------------------------------

export type ExportFlag = 'may_be_out_of_date';

export interface ExportBundleOk {
  readonly ok: true;
  readonly kind: PieceKind;
  /** Copy to paste where the agent posts it. */
  readonly text: string;
  readonly images: readonly AssetRef[];
  /** What the product says about it (R-MKT-6: never that it was posted). */
  readonly label: string;
  readonly flags: readonly ExportFlag[];
}

export type ExportBundle = ExportBundleOk | RenderRefusal;

// ---- seller updates -----------------------------------------------------------------------------

/** The reporting window [start, end) and how it is named in sentences ("this week"). */
export interface Period {
  readonly start: Instant;
  readonly end: Instant;
  readonly zone: IanaZone;
  /** Default "this week". */
  readonly label?: string;
}

/** A showings row (0001), as logged. */
export interface ShowingLog {
  readonly id: ShowingId;
  readonly startsAt: Instant;
  readonly status: 'scheduled' | 'completed' | 'canceled' | 'no_show';
  readonly source: 'manual' | 'showing_service' | 'import';
  readonly buyerAgentName: string | null;
  readonly buyerAgentBrokerage: string | null;
}

/** A showing_feedback row (0001). `comments` is shown verbatim (E89). */
export interface FeedbackLog {
  readonly id: string;
  readonly showingId: ShowingId;
  readonly rating: number | null;
  readonly comments: string | null;
  readonly source: 'manual' | 'showing_service' | 'email';
  readonly receivedAt: Instant;
}

/** A marketing piece's lifecycle instants (only `publishedAt` counts as activity; exports never do). */
export interface PieceActivity {
  readonly pieceId: string;
  readonly kind: PieceKind;
  readonly status: PieceStatus;
  readonly publishedAt: Instant | null;
  readonly exportedAt: Instant | null;
}

/** One recipient of an open-house invite send: one gated messages row each (R-MKT-8). */
export interface InviteRecipient {
  readonly messageId: MessageId;
  readonly outcome: 'sent' | 'opted_out' | 'blocked';
}

export interface InviteSendLog {
  readonly pieceId: string;
  readonly sentAt: Instant;
  readonly recipients: readonly InviteRecipient[];
}

/** A marketing_activity row an agent logged. Its `metrics` are deliberately not read (R-MKT-10). */
export interface LoggedActivity {
  readonly id: string;
  readonly kind: 'social_post' | 'email_blast' | 'open_house' | 'flyer' | 'website' | 'portal' | 'other';
  readonly channel: string | null;
  readonly occurredAt: Instant;
}

export type MlsInput =
  | { readonly connected: false }
  | {
      readonly connected: true;
      readonly lastSyncedAt: Instant | null;
      readonly pack: LicensePack;
      readonly candidates: readonly ListingFacts[];
      readonly rule: CompetingRule;
    };

export interface SellerUpdateInputs {
  readonly listing: ListingFacts;
  readonly now: Instant;
  readonly showingServiceConnected: boolean;
  readonly showings: readonly ShowingLog[];
  readonly feedback: readonly FeedbackLog[];
  readonly pieces: readonly PieceActivity[];
  readonly inviteSends: readonly InviteSendLog[];
  readonly loggedActivity: readonly LoggedActivity[];
  readonly mls: MlsInput;
  /** Names that feedback may mention (buyers): such an item is flagged for the agent (E89). */
  readonly knownBuyerNames?: readonly string[];
}

/** 'value': the API's seller-update value range (lane V2-B, R-CMA-10); core never assembles it (the API appends it). */
export type SectionKind = 'showings' | 'feedback' | 'marketing' | 'competing' | 'value';

/** Where a section's data stands. */
export type SectionState = 'has_data' | 'none_logged' | 'unavailable' | 'stale';

export interface SectionLine {
  readonly text: string;
  /** Feedback only: verbatim, the agent may remove it, never published by a rule (E89, R-PORTAL-3). */
  readonly feedback?: {
    readonly feedbackId: string;
    readonly verbatim: string;
    readonly removable: true;
    readonly publish: 'person_only';
    readonly namesPerson: boolean;
  };
}

export interface Section {
  readonly kind: SectionKind;
  readonly title: string;
  readonly state: SectionState;
  /** One sentence on where this section's data comes from and how current it is. */
  readonly statement: string;
  readonly lines: readonly SectionLine[];
  /** Ordinals of the claims backing this section. */
  readonly claimOrdinals: readonly number[];
}

/** evidence_refs.source_type after 0018. */
export const EVIDENCE_SOURCE_TYPES = [
  'call', 'message', 'email', 'note', 'listing', 'import', 'behavior_event', 'deal', 'task', 'appointment',
  'showing', 'showing_feedback', 'marketing_activity', 'home_valuation', 'deal_date', 'metric', 'document', 'property_record',
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

/** An evidence pointer: source + id + locator + verbatim snippet (the field's value). */
export interface EvidenceSpec {
  readonly sourceType: EvidenceSourceType;
  readonly sourceId: string;
  readonly locator: Locator;
  readonly snippet: string;
}

/** A claim the API stores as assistant_claims + evidence_refs. No confidence field (R-AST-13). */
export interface ClaimSpec {
  readonly ordinal: number;
  readonly kind: ClaimKind;
  readonly section: SectionKind;
  /** ≤ 300 characters. */
  readonly text: string;
  /** The number the claim states, or null for a non-count statement. */
  readonly count: number | null;
  readonly evidence: readonly EvidenceSpec[];
}

