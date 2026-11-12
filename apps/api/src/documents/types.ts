// Constants and shared types of api/documents (module 42). Every limit lives here, so one constant changes it.
import type { CommsDeps } from '../comms/types.js';
import type { Providers } from '../providers/index.js';

export const DOCUMENT_KINDS = ['purchase_contract', 'addendum', 'disclosure', 'inspection', 'appraisal', 'listing_agreement', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export const DOCUMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** One file part: at most 10,000,000 bytes (decimal, as the DB guard). */
export const DOCUMENT_MAX_BYTES = 10_000_000;
/** The whole multipart body: the file plus 64 KiB for the boundary, headers and the small fields. */
export const DOCUMENT_BODY_LIMIT = DOCUMENT_MAX_BYTES + 65_536;
/** The optional displayName field, before cleaning. */
export const DISPLAY_NAME_FIELD_MAX_BYTES = 1024;
export const DISPLAY_NAME_MAX = 200;
export const UPLOADS_PER_HOUR = 60;

/** Retention after the scope's close (R-DATA-6: 7 years, configurable 3-10; VERIFY WITH COUNSEL). */
export const DOCUMENT_RETENTION_YEARS = 7;
export const DOCUMENT_RETENTION_MIN_YEARS = 3;
export const DOCUMENT_RETENTION_MAX_YEARS = 10;

/** The reconcile re-enqueues a scan pending for longer than this (a lost job). */
export const SCAN_STALE_MS = 2 * 60_000;
export const DOCUMENTS_RECONCILE_EVERY_MS = 5 * 60_000;
export const DOCUMENTS_RECONCILE_OFFSET_MS = 150_000;

/** Kinds read for contract dates (PDF deal documents only). */
export const EXTRACTABLE_KINDS: readonly DocumentKind[] = ['purchase_contract', 'addendum'];

export const DOCUMENT_JOBS = {
  scan: 'documents.scan',
  extract: 'documents.extract',
  reconcile: 'documents.reconcile',
} as const;

export type DocumentScope = { kind: 'deal'; id: string } | { kind: 'listing'; id: string } | { kind: 'contact'; id: string };

/** What the HTTP and worker paths need. No tenant context: every call names the actor. */
export type DocumentDeps = Pick<CommsDeps, 'db' | 'envelope' | 'ids' | 'linkSecret'> & {
  providers: Pick<Providers, 'storage' | 'scanner' | 'textExtractor'>;
};
