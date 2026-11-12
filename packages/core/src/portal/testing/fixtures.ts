// Synthetic fixtures for core/portal tests (the repository is public: no real names).
import { instant, sequentialIds, zone, type Brand, type ContactId, type DealDateId, type DealId, type ListingId, type LocalDate, type ShowingId, type StoredObjectId, type TaskId, type AssistantActionId } from '../../foundation/index.js';
import type { DocumentId, DocumentSource, FeedbackSource, GrantBinding, MilestoneSource, PortalSource, SellerUpdateSource, ShowingSource, SourceFacts, TaskSource } from '../types.js';

const ids = sequentialIds({ prefix: 0x44 });
export const newId = <T extends string>(): Brand<string, T> => ids.next<T>();

export const ZONE = zone('America/Chicago');
export const DEAL = newId<'DealId'>() as DealId;
export const OTHER_DEAL = newId<'DealId'>() as DealId;
export const LISTING = newId<'ListingId'>() as ListingId;        // the deal's listing
export const OWN_LISTING = newId<'ListingId'>() as ListingId;    // a listing grant's listing
export const OTHER_LISTING = newId<'ListingId'>() as ListingId;
export const CLIENT = newId<'ContactId'>() as ContactId;
export const OTHER_BUYER = newId<'ContactId'>() as ContactId;

/** A live deal grant whose deal names LISTING; the client is a buyer unless `clientIsSellerSide`. */
export function dealGrant(over: Partial<GrantBinding> = {}): GrantBinding {
  return { dealId: DEAL, listingId: null, dealListingId: LISTING, clientContactId: CLIENT, clientIsSellerSide: false, revoked: false, lapsed: false, accountDisabled: false, ...over };
}
/** A live listing grant on OWN_LISTING (the client is the listing's seller). */
export function listingGrant(over: Partial<GrantBinding> = {}): GrantBinding {
  return { dealId: null, listingId: OWN_LISTING, dealListingId: null, clientContactId: CLIENT, clientIsSellerSide: false, revoked: false, lapsed: false, accountDisabled: false, ...over };
}

export const T0 = instant(Date.UTC(2026, 10, 13, 3, 30)); // 21:30 on 2026-11-12 in Chicago; 2026-11-13 in UTC

export function milestone(over: Partial<MilestoneSource> = {}): MilestoneSource {
  return { type: 'deal_date', id: newId<'DealDateId'>() as DealDateId, dealId: DEAL, kind: 'inspection', label: null, dueOn: '2026-12-01' as LocalDate, status: 'confirmed', dueVersion: 2, ...over };
}
export function documentSrc(over: Partial<DocumentSource> = {}): DocumentSource {
  return { type: 'document', id: newId<'DocumentId'>() as DocumentId, dealId: DEAL, listingId: null, contactId: null, objectId: newId<'StoredObjectId'>() as StoredObjectId,
    kind: 'inspection', displayName: 'Inspection report.pdf', versionNo: 3, sharedToPortal: true, scanStatus: 'clean', ...over };
}
export function showing(over: Partial<ShowingSource> = {}, log: Partial<ShowingSource['showing']> = {}): ShowingSource {
  return { type: 'showing', listingId: LISTING, buyerContactId: CLIENT,
    showing: { id: newId<'ShowingId'>() as ShowingId, startsAt: T0, status: 'completed', source: 'manual', buyerAgentName: 'Agent Example', buyerAgentBrokerage: 'Example Brokerage', ...log }, ...over };
}
export function feedback(over: Partial<FeedbackSource> = {}, log: Partial<FeedbackSource['feedback']> = {}): FeedbackSource {
  return { type: 'showing_feedback', listingId: LISTING, buyerContactId: CLIENT,
    feedback: { id: newId<'ShowingFeedbackId'>(), showingId: newId<'ShowingId'>() as ShowingId, rating: 4, comments: 'Bright kitchen; the yard is small.', source: 'manual', receivedAt: T0, ...log }, ...over };
}
export function sellerUpdate(over: Partial<SellerUpdateSource> = {}): SellerUpdateSource {
  return { type: 'assistant_action', id: newId<'AssistantActionId'>() as AssistantActionId, kind: 'seller_update_draft', status: 'approved', triggerListingId: LISTING,
    text: 'Six showings this week. We recommend holding the price for one more week.', ...over };
}
export function task(over: Partial<TaskSource> = {}): TaskSource {
  return { type: 'task', id: newId<'TaskId'>() as TaskId, dealId: DEAL, listingId: null, title: 'Send the signed addendum', dueAt: T0, status: 'open', notes: 'PRIVATE NOTE: never copied', ...over };
}

export function facts(source: PortalSource, over: Partial<Omit<SourceFacts, 'source'>> = {}): SourceFacts {
  return { source, grant: dealGrant(), publisher: 'user', zone: ZONE, ...over };
}
