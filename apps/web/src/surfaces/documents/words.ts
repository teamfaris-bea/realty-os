// Pure words and checks of the documents surface (module 55). Unit-tested. Every map is typed and exhaustive, so a new
// kind or state fails the typecheck instead of showing a raw code (CONVENTIONS §7).
import type { Role } from '@realty/core/foundation';
import type { DocumentKind, ExtractionStatus, ScanState, ScopeKind } from './types.js';

export const KIND_WORDS: Record<DocumentKind, string> = {
  purchase_contract: 'Purchase contract',
  addendum: 'Addendum',
  disclosure: 'Disclosure',
  inspection: 'Inspection report',
  appraisal: 'Appraisal',
  listing_agreement: 'Listing agreement',
  other: 'Other document',
};

/** A short state label; the API's scanText is the full sentence shown beside it. */
export const SCAN_WORDS: Record<ScanState, string> = {
  checking: 'Being checked for viruses',
  waiting_for_scanner: 'Locked: no virus scanner yet',
  clean: 'Passed the virus check',
  blocked: 'Blocked by the virus check',
};

/**
 * What the date review says about the extraction, for the states whose sentence the API leaves null
 * (waiting_for_scan, not_applicable, not_started, not_visible and the closed action states). A state the API
 * words itself (photo, not_set_up, an outcome) shows the API's sentence instead.
 */
export const EXTRACTION_WORDS: Record<ExtractionStatus, string> = {
  not_applicable: 'Only PDF purchase contracts and addenda on a deal are read for dates.',
  photo: 'Photos and scans are not read.',
  not_set_up: 'Reading dates from PDFs is not set up.',
  waiting_for_scan: 'The dates are read after the file passes the virus check.',
  not_started: 'The dates in this contract have not been read yet.',
  not_visible: 'Only the person who uploaded this contract, or an Owner or Admin, can review its dates.',
  proposed: 'Waiting for review.',
  approved: 'Reviewed.',
  executed: 'Reviewed.',
  rejected: 'Reviewed: none of these dates were used.',
  superseded: 'A newer version of this contract replaced these dates.',
  invalidated: 'These dates can no longer be used.',
  expired: 'This review closed before it was finished.',
  blocked: 'These dates can no longer be used.',
};

export const WHO_REVIEWS = 'Only the person who uploaded this contract, or an Owner or Admin, can review its dates.';

export const ACCEPT = 'application/pdf,image/jpeg,image/png';
export const ACCEPTED_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png'];
/** 10,000,000 bytes (decimal, as the API and the database count) */
export const MAX_BYTES = 10_000_000;

/** R-STAFF-8 / E672: why a chosen file is refused before any request, or null when it may be sent. */
export function precheck(file: Pick<File, 'size' | 'type'>): string | null {
  if (file.size === 0) return 'This file is empty. Choose another file.';
  if (!ACCEPTED_TYPES.includes(file.type)) return 'Only PDF, JPEG and PNG files can be added. Choose a PDF or a photo.';
  if (file.size > MAX_BYTES) return 'This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.';
  return null;
}

/**
 * R-STAFF-6: whether to show upload controls, mirroring core authz (document.upload, document.upload_listing,
 * document.upload_contact) from the session role and what the page knows. A Team Lead's team is not known here, so a
 * Team Lead sees the control and the server decides (a refusal is 404: "You can't add documents here").
 */
export function mayUpload(kind: ScopeKind, role: Role | null | undefined, f: { own: boolean; member: boolean }): boolean {
  if (!role) return false;
  if (role === 'owner' || role === 'admin') return true;
  switch (kind) {
    case 'deal':
      return role === 'team_lead' || (role === 'agent' && (f.own || f.member)) || (role === 'tc' && f.member);
    case 'listing':
      return role === 'team_lead' || (role === 'agent' && f.own);
    case 'contact':
      return role === 'team_lead' || role === 'agent' || role === 'isa';
  }
}

/** A new version, on the document page: the scope's upload action by role (the server checks the scope's facts). */
export function mayAddVersion(kind: ScopeKind, role: Role | null | undefined): boolean {
  return mayUpload(kind, role, { own: true, member: true });
}

/** Sentences for the codes the documents surface meets (passed to messageFor; never the shell's map). */
export const DOC_MESSAGES: Record<string, string> = {
  DOCUMENT_TYPE_NOT_ALLOWED: 'Only PDF, JPEG and PNG files can be added, and the file must really be that type. Choose another file.',
  DOCUMENT_TOO_LARGE: 'This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.',
  PAYLOAD_TOO_LARGE: 'This file is larger than 10 MB (10,000,000 bytes). Choose a smaller file.',
  DOCUMENT_VERSION_CONFLICT: 'Someone added a new version of this document first. Open the newest version to add another.',
  DOCUMENT_QUARANTINED: 'This file is still waiting for the virus check, so it can’t be opened yet.',
  DOCUMENT_BLOCKED: 'This file was blocked by the virus check, so nobody can open it.',
  DOCUMENT_SUPERSEDED: 'A newer version of this contract replaced this one. Review the dates on the newest version.',
  DOCUMENT_NOT_SHAREABLE: 'Only deal and listing documents that passed the virus check can be marked for the client portal.',
  DOCUMENT_HOLD_OWNER_ADMIN: 'Only an Owner or Admin can place a legal hold or change how long a document is kept.',
  DOCUMENT_RETENTION_OUT_OF_RANGE: 'Keep a document 3 to 10 years after the close (or after the upload when there is no close).',
  DOCUMENT_RETAINED: 'This document is on legal hold or inside its retention period, so that can’t be done.',
  CONTACT_MERGED: 'This person was merged into another record. Add documents on their current record.',
  VALIDATION_FAILED: 'Something in this form isn’t right. Check the file, the kind and the name, then try again.',
  RATE_LIMITED: 'You reached the limit of 60 uploads an hour. Try again later.',
  // the date review (module 55 item 7)
  EXTRACTION_EXISTS: 'The dates in this contract were already read.',
  EXTRACTION_CLOSED: 'This contract’s date review is closed. The page shows where each date stands.',
  EXTRACTION_CLAIM_NEEDS_REVIEW: 'This date wasn’t found in the contract as quoted, so it can’t be confirmed here. Enter it by hand on the deal timeline if it is right.',
  EXTRACTION_CLAIM_DECIDED: 'Someone already decided this date. The page shows the latest.',
  EXTRACTION_TARGET_KIND: 'That date is a different kind of milestone. Replace a date of the same kind, or add this as a new date.',
  DATE_HUMAN_CONFIRMATION: 'Only a person can confirm a date, as themselves.',
};

/** Upload refusals: a 404 means this person cannot add documents to this record (R-PERM-5 hides why). */
export const UPLOAD_MESSAGES: Record<string, string> = { ...DOC_MESSAGES, NOT_FOUND: 'You can’t add documents here.' };

/** "Uploaded by you" or by someone else: the API names the uploader by id only. */
export function uploaderWords(uploadedByUserId: string, me: string | null | undefined): string {
  return uploadedByUserId === me ? 'Uploaded by you' : 'Uploaded by a teammate';
}

/** "Nov 12, 2026" for an instant, in the viewer's zone. */
export function dateWords(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** "Nov 12, 2026" for a local date "2026-11-12" (no zone shift). */
export function localDateWords(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return '';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** R-STAFF-5: the same-origin download address, built in code from an id (never a URL from data). */
export function downloadHref(documentId: string): string | null {
  return UUID.test(documentId) ? `/api/documents/${documentId}/file` : null;
}

export const docKeys = {
  list: (kind: ScopeKind, id: string) => ['documents', kind, id] as const,
  detail: (id: string) => ['document', id] as const,
  extraction: (id: string) => ['document', id, 'extraction'] as const,
};
