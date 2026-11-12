// Response shapes of the Lead sources API (apps/api/src/leads/sourcesSchemas.ts OverviewResponse, OnOffResponse,
// WebhookRotatedResponse, PreviewResponse; leads/schemas.ts LeadSourceCreatedResponse) and of the Google Ads lead
// form API (apps/api/src/leadForms/routes.ts). Plain types: apps/web imports no @realty/api code.

export type PathState = 'on' | 'off' | 'not_available';

export interface SourceOverview {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  createdAt: string;
  /** when it was turned off, while it is off */
  offSince: string | null;
  lastLeadAt: string | null;
  leadsLast30Days: number;
  heldEmails: number;
  forwardingConfirmations: number;
  hasConsentText: boolean;
  paths: {
    email: { state: PathState; address: string | null; lastEmailAt: string | null };
    webhook: { hasToken: boolean; ownSecret: boolean; secretCreatedAt: string | null };
    googleLeadForm: {
      state: PathState;
      createdAt: string | null;
      inquiryType: string | null;
      citesSourceDisclosure: boolean | null;
      lastTestAt: string | null;
      lastUnreadableAt: string | null;
      unreadableCount: number;
    };
    trackingNumbers: { id: string; e164: string }[];
    partnerFeeds: { kind: string; status: string }[];
    webChats: { status: string }[];
  };
}

export interface OverviewResponse {
  sources: SourceOverview[];
  deployment: { inboundEmail: boolean; publicHttps: boolean };
}

export interface SourceView {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  offSince?: string | null;
  hasToken: boolean;
  createdAt: string;
}

export interface CreatedResponse {
  source: SourceView;
  ingestToken: string;
  intakePath: string;
}

export interface OnOffResponse {
  source: SourceView;
  paths: string[];
  sentence: string;
}

export interface WebhookRotated {
  intakeUrl: string;
  signingSecret: string;
  createdAt: string;
}

export type InquiryType = 'buy' | 'sell' | 'rent' | 'value' | 'general';

export interface PreviewResponse {
  rule: { id: string; name: string } | null;
  outcome: { kind: 'offer'; userId: string; name: string } | { kind: 'pond'; pondId: string; pondName: string; reason: string };
  considered: { userId: string; name: string; eligible: boolean; reason: string | null }[];
  sentence: string;
  firstResponse: 'queued' | 'off';
}

export interface GoogleLeadForm {
  state: PathState;
  webhookUrl: string;
  /** only while it is on */
  key: string | null;
  createdAt: string | null;
  inquiryType: InquiryType | null;
  citesSourceDisclosure: boolean | null;
  lastTestAt: string | null;
  lastLeadAt: string | null;
  lastUnreadableAt: string | null;
  unreadableCount: number;
  sourceHasConsentText: boolean;
}

export interface GoogleKeyResponse {
  key: string;
  webhookUrl: string;
  createdAt: string;
}

export const OVERVIEW_KEY = ['lead-sources', 'overview'] as const;
export const GOOGLE_KEY = (id: string) => ['lead-sources', 'google-lead-form', id] as const;
/** the keys the admin pages already use, so a change here refreshes them too */
export const ADMIN_SOURCES_KEY = ['admin', 'lead-sources'] as const;
export const NUMBERS_KEY = ['admin', 'numbers'] as const;
export const MEMBERS_KEY = ['admin', 'members'] as const;
export const RULES_KEY = ['admin', 'routing-rules'] as const;
