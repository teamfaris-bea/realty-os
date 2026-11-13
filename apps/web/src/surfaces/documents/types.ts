// View types of the documents surface (module 55), mirroring apps/api/src/documents/schemas.ts. The web reads every
// state and sentence from these; nothing here carries a confidence number (R-AST-13, R-STAFF-3).

export const DOCUMENT_KINDS = ['purchase_contract', 'addendum', 'disclosure', 'inspection', 'appraisal', 'listing_agreement', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
export type ScopeKind = 'deal' | 'listing' | 'contact';
export type ScanState = 'checking' | 'waiting_for_scanner' | 'clean' | 'blocked';
export type ExtractionStatus =
  | 'not_applicable'
  | 'photo'
  | 'not_set_up'
  | 'waiting_for_scan'
  | 'not_started'
  | 'not_visible'
  | 'proposed'
  | 'approved'
  | 'executed'
  | 'rejected'
  | 'superseded'
  | 'invalidated'
  | 'expired'
  | 'blocked';
export type ExtractionOutcome = 'dates' | 'no_text' | 'no_dates' | 'unreadable';

export interface DocumentView {
  id: string;
  scope: { kind: ScopeKind; id: string };
  kind: DocumentKind;
  displayName: string;
  versionNo: number;
  supersedesId: string | null;
  contentType: string | null;
  byteSize: number | null;
  uploadedByUserId: string;
  uploadedAt: string;
  scan: ScanState;
  scanText: string | null;
  blockedReason: 'malware' | 'unscannable' | null;
  legalHold: boolean;
  retentionUntil: string | null;
  portal: { shared: boolean; portalCleared: boolean; text: string | null };
  extraction: { status: ExtractionStatus; outcome: ExtractionOutcome | null; claimCount: number; text: string | null };
  canShare: boolean;
  canHold: boolean;
}

export interface Adapter {
  configured: boolean;
  test: boolean;
  statusText: string;
}
export interface PlatformView {
  scanner: Adapter;
  extractor: Adapter;
  portalCleared: boolean;
}

export interface ListEntry extends DocumentView {
  newerVersion: { id: string; versionNo: number; scan: ScanState } | null;
}
export interface ListResponse {
  documents: ListEntry[];
  platform: PlatformView;
}
export interface DetailResponse {
  document: DocumentView;
  versions: DocumentView[];
  platform: PlatformView;
}
export interface UploadResponse extends DetailResponse {
  previousVersionShared: boolean;
  previousVersionSharedText: string | null;
}
export interface ShareResponse extends DetailResponse {
  text: string | null;
}

export interface ClaimView {
  id: string;
  ordinal: number;
  text: string;
  milestone: { kind: string; label: string; dueOn: string } | null;
  page: number | null;
  needsReview: boolean;
  reviewNote: string | null;
  reviewStatus: 'unreviewed' | 'confirmed' | 'corrected' | 'rejected';
  evidence: { sourceType: 'document'; locator: { kind: 'char_range'; page: number; start: number; end: number }; snippet: string | null; verified: boolean; line: string | null }[];
  liveDates: { dateId: string; label: string | null; dueOn: string; status: string; source: string }[];
  appliedDateId: string | null;
  appliedNote: string | null;
  conflictsWith: string[];
  conflictNote: string | null;
}

export interface ExtractionResponse {
  document: DocumentView;
  action: { id: string; status: string; outcome: ExtractionOutcome | null; text: string | null } | null;
  claims: ClaimView[];
  relativeDeadlineText: string | null;
  platform: PlatformView;
}
export interface ClaimDecisionResponse extends ExtractionResponse {
  dateId: string | null;
}
