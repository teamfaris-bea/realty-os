// Types of core/portal (PHASE2_3_PLAN module 44), mirroring 0018 §18 (portal_items and its CHECKs,
// app.portal_items_guard) and the source tables it copies from. No tenant_id anywhere: the API reads
// one tenant's rows under RLS and hands core plain facts.
import type {
  AssistantActionId,
  Brand,
  ContactId,
  DealDateId,
  DealId,
  IanaZone,
  Instant,
  ListingId,
  LocalDate,
  StoredObjectId,
  TaskId,
} from '../foundation/index.js';
import type { FeedbackLog, ShowingLog } from '../marketing/index.js';
import type { DealDate } from '../transactions/index.js';

// ---- branded ids of the portal and document tables (0018 §16, §18) ---------------------------
export type DocumentId = Brand<string, 'DocumentId'>;
export type PortalAccountId = Brand<string, 'PortalAccountId'>;
export type PortalGrantId = Brand<string, 'PortalGrantId'>;

/** portal_items.kind (0018). */
export const PORTAL_KINDS = ['milestone', 'document', 'showing', 'feedback', 'seller_update', 'next_step'] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

/** portal_items.source_type (0018). */
export const PORTAL_SOURCE_TYPES = ['deal_date', 'document', 'showing', 'showing_feedback', 'assistant_action', 'task'] as const;
export type PortalSourceType = (typeof PORTAL_SOURCE_TYPES)[number];

/** The fixed kind ⇔ source_type pairs of the portal_items CHECK. */
export const KIND_SOURCE_TYPE: Readonly<Record<PortalKind, PortalSourceType>> = Object.freeze({
  milestone: 'deal_date',
  document: 'document',
  showing: 'showing',
  feedback: 'showing_feedback',
  seller_update: 'assistant_action',
  next_step: 'task',
});

/** portal_items.published_by_kind: a person ('user') or a rule (`portal.sync`, 'system'). */
export type Publisher = 'user' | 'system';

/** documents.kind (0018 §16). */
export const DOCUMENT_KINDS = ['purchase_contract', 'addendum', 'disclosure', 'inspection', 'appraisal', 'listing_agreement', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** documents.scan_status (0018 §16). */
export type ScanStatus = 'pending' | 'clean' | 'infected';

/**
 * The grant an item would be published into, as the API reads it for the caller's `now`.
 * Exactly one of `dealId` / `listingId` (portal_grants CHECK). `dealListingId` is deals.listing_id of a
 * deal grant (null for a listing grant or a deal without a listing).
 */
export interface GrantBinding {
  readonly dealId: DealId | null;
  readonly listingId: ListingId | null;
  readonly dealListingId: ListingId | null;
  /** portal_accounts.contact_id: the client. */
  readonly clientContactId: ContactId;
  /** The client is a `seller` or `co_seller` of the grant's deal in deal_contacts (false for a listing grant: not read). */
  readonly clientIsSellerSide: boolean;
  /** portal_grants.revoked_at is set. */
  readonly revoked: boolean;
  /** portal_grants.expires_at <= now (lapse is immediate, R-PORTAL-2). */
  readonly lapsed: boolean;
  /** portal_accounts.status = 'disabled'. */
  readonly accountDisabled: boolean;
}

/** deal_dates row: a milestone of a deal (core/transactions DealDate plus its deal). */
export interface MilestoneSource extends Pick<DealDate, 'id' | 'kind' | 'label' | 'dueOn' | 'status' | 'dueVersion'> {
  readonly type: 'deal_date';
  readonly id: DealDateId;
  readonly dealId: DealId;
}

/** documents row (0018 §16). Exactly one of dealId / listingId / contactId. */
export interface DocumentSource {
  readonly type: 'document';
  readonly id: DocumentId;
  readonly dealId: DealId | null;
  readonly listingId: ListingId | null;
  readonly contactId: ContactId | null;
  readonly objectId: StoredObjectId;
  readonly kind: DocumentKind;
  readonly displayName: string;
  readonly versionNo: number;
  readonly sharedToPortal: boolean;
  readonly scanStatus: ScanStatus;
}

/** showings row: core/marketing's ShowingLog plus its listing and the buyer who attended. */
export interface ShowingSource {
  readonly type: 'showing';
  readonly showing: ShowingLog;
  readonly listingId: ListingId;
  readonly buyerContactId: ContactId | null;
}

/** showing_feedback row (core/marketing's FeedbackLog) plus the facts of its showing. */
export interface FeedbackSource {
  readonly type: 'showing_feedback';
  readonly feedback: FeedbackLog;
  /** showings.listing_id of the feedback's showing (feedback.showingId). */
  readonly listingId: ListingId;
  readonly buyerContactId: ContactId | null;
}

/** assistant_actions row of a seller update. `text` is COALESCE(edited_payload, payload)->>'body', as approved. */
export interface SellerUpdateSource {
  readonly type: 'assistant_action';
  readonly id: AssistantActionId;
  readonly kind: string;
  readonly status: string;
  /** trigger_ref->>'listing_id', as stored (null when absent). */
  readonly triggerListingId: string | null;
  readonly text: string;
}

/** tasks row (0001). `notes`, assignee and contact are read by nobody here and never copied. */
export interface TaskSource {
  readonly type: 'task';
  readonly id: TaskId;
  readonly dealId: DealId | null;
  readonly listingId: ListingId | null;
  readonly title: string;
  readonly dueAt: Instant | null;
  readonly status: 'open' | 'done' | 'canceled';
  readonly notes?: string | null;
}

export type PortalSource = MilestoneSource | DocumentSource | ShowingSource | FeedbackSource | SellerUpdateSource | TaskSource;

/**
 * Everything publishable() and renderPortalItem() read: the source's own facts, the grant binding,
 * the publisher, and the zone local dates are shown in (the tenant's zone).
 */
export interface SourceFacts {
  readonly source: PortalSource;
  readonly grant: GrantBinding;
  readonly publisher: Publisher;
  readonly zone: IanaZone;
}

/** One portal_items row as core renders it (the API adds ids, grant, publisher and published_at). */
export interface PortalItemSpec {
  readonly kind: PortalKind;
  readonly title: string;
  readonly body: string | null;
  readonly occursOn: LocalDate | null;
  readonly documentId: DocumentId | null;
  readonly sourceType: PortalSourceType;
  readonly sourceId: string;
  readonly sourceVersion: number;
}

/** Codes publishable() returns (CONVENTIONS §7). */
export type PortalErrorCode =
  /** The input is not a well-formed SourceFacts (unknown kind or type, a non-canonical id, a bad field). */
  | 'PORTAL_SOURCE_INVALID'
  /** The kind is not the source type's fixed pair (portal_items CHECK). */
  | 'PORTAL_KIND_SOURCE_MISMATCH'
  /** Feedback, seller updates and next steps are published by a person only (CHECK; 2(d) for next steps). */
  | 'PORTAL_PERSON_ONLY'
  /** The rule path (system) publishes confirmed milestones only (2(a)). */
  | 'PORTAL_RULE_MILESTONES_ONLY'
  /** The grant is revoked or lapsed, or its account disabled (2(c), R-PORTAL-6). */
  | 'PORTAL_GRANT_INACTIVE'
  /** The DB guard's code: not a shareable source of the grant's own deal or listing. */
  | 'PORTAL_SOURCE_NOT_IN_GRANT'
  /** Reached only through the deal's listing, and the client is not on the seller side (2(b)). */
  | 'PORTAL_NOT_SELLER_SIDE'
  /** Verbatim text (feedback comments, the seller update) over 4000 code points: never cut. */
  | 'PORTAL_TEXT_TOO_LONG'
  /** Verbatim text with a control character (other than tab and newlines) or a lone surrogate. */
  | 'PORTAL_TEXT_NOT_PLAIN';

export type PublishableResult = { ok: true } | { ok: false; reason: PortalErrorCode };
