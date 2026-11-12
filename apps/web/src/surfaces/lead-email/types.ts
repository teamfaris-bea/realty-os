// Response shapes of the lead-email API (apps/api/src/leadEmail/routes.ts: InboxResponse, ReviewsResponse,
// ReviewDecisionResponse). Kept here as plain types: apps/web imports no @realty/api code.

export interface Inbox {
  leadSourceId: string;
  enabled: boolean;
  connectionId: string | null;
  status: string | null;
  address: string | null;
  addressCreatedAt: string | null;
  allowedSenderDomains: string[];
  suggestedSenderDomains: { domain: string; label: string }[];
  /** saved entries the trust rule ignores (consumer mailbox domains, R-LEM-11): shown as not allowed */
  ignoredSenderDomains: string[];
  /** every portal the server knows; only the pre-ticked ones start ticked (suggested, unconfirmed) */
  portalCatalog: PortalCatalogEntry[];
  inboundDomainConfigured: boolean;
}

export interface PortalCatalogEntry {
  portal: 'zillow' | 'realtor' | 'redfin' | 'homes' | 'trulia' | 'opcity';
  domain: string;
  label: string;
  preTicked: boolean;
}

export interface InboxResponse {
  inbox: Inbox;
}

export interface FieldView {
  value: string;
  span: { start: number; end: number };
}

export interface ReviewFields {
  name: FieldView | null;
  phones: FieldView[];
  emails: FieldView[];
  message: FieldView | null;
  property: FieldView | null;
  listingId: FieldView | null;
  leadType: string;
}

export interface ReviewItem {
  id: string;
  receivedAt: string;
  leadSourceId: string;
  leadSourceName: string;
  status: 'needs_review' | 'accepted' | 'discarded';
  /** never shown: the page shows holdSentence */
  holdCode: string;
  holdSentence: string;
  senderDomain: string | null;
  dkimPassDomains: string[];
  parserKind: string | null;
  subject: string | null;
  text: string | null;
  fields: ReviewFields | null;
  canAccept: boolean;
  contactId: string | null;
  decidedAt: string | null;
}

export interface ReviewsResponse {
  items: ReviewItem[];
  pendingCount: number;
}

export interface ReviewDecisionResponse {
  review: ReviewItem;
  contactId: string | null;
}

export const INBOX_KEY = (leadSourceId: string) => ['lead-email', 'inbox', leadSourceId] as const;
export const REVIEWS_KEY = ['lead-email', 'reviews'] as const;
