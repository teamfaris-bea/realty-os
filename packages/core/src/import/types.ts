// Shared vocabulary of core/import (BUILD_PLAN module 6, DATA_MODEL §1 import_* tables, R-IMPORT-*,
// R-CONSENT-3, ARCHITECTURE §13).
//
// Every string union mirrors a CHECK constraint in packages/db/migrations/0001_init.sql
// (import_stages.category, import_records.outcome, contacts.stage/contact_type/intent,
// contact_points.label/status, messages.status, calls.status/outcome), so values produced here can be
// written as they are.
//
// PII: normalized records carry names and addresses because they ARE the import (they are written to
// `import_records.normalized`, readable by Owner/Admin only). Issues never carry a value: a code, a
// severity and the field name only (CONVENTIONS §8).
import type { ContactId, Instant, UserId } from '../foundation/index.js';
import type { AddressKind, Channel } from '../compliance/index.js';
import type { ImportTarget, OwnershipState } from '../ownership/index.js';

export type { ImportTarget };

// ---- categories and stage order (R-IMPORT-3) ----------------------------------------------------

export type Category = 'contacts' | 'ownership' | 'notes' | 'messages' | 'call_recordings' | 'consent';

/** Commit order (import_stages.seq 1…6). Revert runs in the reverse order (R-IMPORT-10). */
export const CATEGORIES: readonly Category[] = ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'];

/** import_stages.seq, fixed by category (DB CHECK). */
export function categorySeq(c: Category): 1 | 2 | 3 | 4 | 5 | 6 {
  return (CATEGORIES.indexOf(c) + 1) as 1 | 2 | 3 | 4 | 5 | 6;
}

export function isCategory(s: string): s is Category {
  return (CATEGORIES as readonly string[]).includes(s);
}

// ---- issues -------------------------------------------------------------------------------------

/**
 * `error`  : the value (field set) or the record (no field) is rejected.
 * `review` : a human must decide; the record is `needs_review`.
 * `info`   : shown in the review list; changes nothing.
 */
export type IssueSeverity = 'error' | 'review' | 'info';

export type IssueCode =
  // value level (the value is dropped, the record may survive)
  | 'PHONE_INVALID'
  | 'EMAIL_INVALID'
  | 'POSTAL_INVALID'
  | 'TIMESTAMP_INVALID'
  | 'FORMULA_PREFIX'
  | 'VALUE_TRUNCATED'
  | 'TOO_MANY_VALUES'
  | 'STAGE_UNMAPPED'
  | 'TYPE_UNMAPPED'
  | 'INTENT_UNMAPPED'
  | 'NAME_MISSING'
  | 'EXTRA_CELLS'
  | 'TAG_READ_AS_OPT_OUT'
  // record level
  | 'NO_IDENTITY'
  | 'RECORD_MALFORMED'
  | 'SOURCE_REF_DUPLICATE'
  | 'BODY_EMPTY'
  | 'BODY_TOO_LONG'
  | 'PARENT_NOT_FOUND'
  | 'PARENT_REJECTED'
  | 'PARENT_NOT_LINKED'
  /** info: the record's person was skipped as a duplicate; it goes on the contact that person is the same as (B6) */
  | 'PARENT_DUPLICATE'
  | 'USER_UNMAPPED'
  | 'IN_FILE_DUPLICATE'
  | 'ALREADY_IMPORTED'
  | 'NAME_ONLY_MATCH'
  | 'MATCH_OWNED_CONTACT'
  | 'MATCH_MULTIPLE'
  | 'MATCH_DELETED_CONTACT'
  | 'ADDRESS_OPTED_OUT'
  | 'OWNER_KEPT'
  | 'CONSENT_VALUE_AMBIGUOUS'
  | 'CONSENT_VALUE_UNRECOGNIZED'
  | 'CONSENT_CONFLICT'
  | 'NO_CONSENT_DATA'
  | 'RECORDING_NOTICE_UNKNOWN'
  // stage level (blockers)
  | 'USER_MAPPING_INCOMPLETE';

export interface Issue {
  code: IssueCode;
  severity: IssueSeverity;
  /** The normalized field (or CSV header) the issue is about; absent for record-level issues. */
  field?: string;
}

// ---- normalization outcome ----------------------------------------------------------------------

/**
 * The outcome of normalizing one source record. `rejected` records have no usable record but keep
 * their `sourceRef` and issues so they are counted and listed (R-IMPORT-5 reconciliation).
 */
export type RecordOutcome<T> =
  | { sourceRef: string; status: 'valid' | 'needs_review'; record: T; issues: Issue[] }
  | { sourceRef: string; status: 'rejected'; record: null; issues: Issue[] };

// ---- normalized records -------------------------------------------------------------------------

export type ContactStage = 'new' | 'attempting' | 'connected' | 'nurture' | 'active' | 'under_contract' | 'closed' | 'lost';
export type ContactType = 'lead' | 'sphere' | 'past_client' | 'vendor' | 'other';
export type Intent = 'buyer' | 'seller' | 'buyer_seller' | 'renter' | 'landlord' | 'investor';
export type PointLabel = 'mobile' | 'home' | 'work' | 'other';
export type PointStatus = 'active' | 'invalid' | 'wrong_number' | 'bouncing' | 'removed';

export interface NormalizedPhone {
  e164: string;
  extension?: string;
  label: PointLabel;
  status: PointStatus;
  isPrimary: boolean;
}

export interface NormalizedEmail {
  email: string;
  label: PointLabel;
  status: PointStatus;
  isPrimary: boolean;
}

export interface NormalizedAddress {
  kind: 'home' | 'mailing' | 'property' | 'interest';
  line1: string | null;
  line2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string;
}

/** Positive and negative consent indicators for one address, as the source stated them. */
export interface ImportedAddressConsent {
  kind: AddressKind;
  /** Normalized: E.164 or lower-case email. */
  address: string;
  /** Positive indicators: become `imported_unverified` grants only (R-CONSENT-3). */
  grants: Channel[];
  /** Opt-out / unsubscribe indicators: become full-strength revocations at commit (R-CONSENT-3). */
  revokes: Channel[];
  /** Do-not-contact: becomes an `import_dnc` suppression on every channel. */
  doNotContact: boolean;
}

/**
 * The consent-relevant fields of one source person (FUB or a CSV row), after normalization.
 * `occurredAt` is the source's own timestamp for the indicators, when it has one.
 */
export interface FubConsentFields {
  addresses: ImportedAddressConsent[];
  occurredAt: Instant | null;
}
export type ImportedConsentFields = FubConsentFields;

export interface NormalizedContact {
  category: 'contacts';
  sourceRef: string;
  /** FUB person id / CSV external id column; the external_refs key (R-IMPORT-9). */
  externalId: string | null;
  firstName: string | null;
  lastName: string | null;
  displayName: string;
  contactType: ContactType;
  stage: ContactStage;
  intent: Intent | null;
  phones: NormalizedPhone[];
  emails: NormalizedEmail[];
  addresses: NormalizedAddress[];
  tags: string[];
  /** Display-only source fields (custom fields, original stage, source label…): contacts.imported_fields. */
  importedFields: Record<string, string>;
  leadSourceLabel: string | null;
  createdAt: Instant | null;
  /** PARITY 65 (R-PAR-46): the source's own stage label (FUB stage / CSV stage column), as written there */
  stageLabel?: string | null;
  /** PARITY 65 (R-PAR-46): the source's custom fields (FUB `custom*` keys / CSV custom columns) as raw text */
  customFields?: Record<string, string>;
  /** CSV only: the consent columns of the same row, for the optional consent stage. */
  consent?: { fields: FubConsentFields; issues: Issue[] };
}

export interface NormalizedOwnership {
  category: 'ownership';
  sourceRef: string;
  personRef: string;
  target: ImportTarget;
}

export interface NormalizedNote {
  category: 'notes';
  sourceRef: string;
  externalId: string;
  personRef: string;
  body: string;
  authorUserId: UserId | null;
  occurredAt: Instant;
}

export type ImportedMessageStatus = 'received' | 'sent' | 'delivered' | 'failed' | 'undelivered' | 'bounced';

export interface NormalizedMessage {
  category: 'messages';
  sourceRef: string;
  externalId: string;
  personRef: string;
  channel: 'sms' | 'email';
  direction: 'inbound' | 'outbound';
  subject: string | null;
  body: string;
  /** Only `received` for inbound (messages CHECK). */
  status: ImportedMessageStatus;
  userId: UserId | null;
  occurredAt: Instant;
}

export type CallStatus = 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled' | 'voicemail';
export type CallOutcome = 'connected' | 'left_voicemail' | 'no_answer' | 'wrong_number' | 'bad_number' | 'do_not_call_request' | 'callback_requested';

export interface NormalizedCall {
  category: 'call_recordings';
  sourceRef: string;
  externalId: string;
  personRef: string;
  direction: 'inbound' | 'outbound';
  startedAt: Instant;
  durationS: number | null;
  status: CallStatus;
  outcome: CallOutcome | null;
  agentUserId: UserId | null;
  note: string | null;
  /**
   * Present when the source has a recording. The URL is NOT copied here (it can carry a token); the
   * commit reads it from the encrypted raw snapshot. R-IMPORT-12: labelled "recording notice
   * unknown", basis `unknown_imported`, not transcribed by default.
   */
  recording: { consentBasis: 'unknown_imported'; label: 'recording notice unknown'; transcribe: false } | null;
}

export interface NormalizedConsent {
  category: 'consent';
  sourceRef: string;
  personRef: string;
  fields: FubConsentFields;
  /** Verbatim source fields the indicators came from (consent_events.original_provenance). */
  provenance: Record<string, unknown>;
}

export type NormalizedRecord =
  | NormalizedContact
  | NormalizedOwnership
  | NormalizedNote
  | NormalizedMessage
  | NormalizedCall
  | NormalizedConsent;

export type RecordOf<C extends Category> = Extract<NormalizedRecord, { category: C }>;

/** FUB user / pond → local target (import_user_mappings). */
export interface UserMapping {
  users: ReadonlyMap<string, ImportTarget>;
  ponds?: ReadonlyMap<string, ImportTarget>;
}

// ---- existing state the dry run matches against --------------------------------------------------

export type ExternalEntityType = 'contact' | 'note' | 'message' | 'call' | 'recording' | 'user' | 'deal';

export interface ExistingContact {
  contactId: ContactId;
  createdAt: Instant;
  ownershipState: OwnershipState;
  closedReason: string | null;
  ownerUserId: UserId | null;
  mergedIntoContactId: ContactId | null;
  /** contacts.import_batch_id: set when an import created the contact. */
  importBatchId: string | null;
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  intent: Intent | null;
  /** Normalized E.164 / emails of the contact's points. */
  phones: readonly string[];
  emails: readonly string[];
  tags: readonly string[];
  importedFieldKeys: readonly string[];
  hasAddress: boolean;
}

/**
 * How this batch's contacts stage plans to handle a person: create, attach to an existing contact, undecided, or
 * not at all; or, for a person whose record is skipped as a duplicate (it is never committed and gets no
 * external_ref), the person it is the same as: the earlier row of this import (`pendingPersonRef`, an in-file
 * duplicate) or the existing contact it matched with nothing new to fill (`contactId`). Later stages put that
 * person's history there (B6, R-IMPORT-4).
 */
export type ContactsStagePlan = 'create' | 'attach' | 'needs_review' | 'rejected' | { sameAs: ContactRef };

/** Everything the dry run needs to know about the tenant's current data. Build with `buildExistingIndex`. */
export interface ExistingIndex {
  /** The batch being dry-run (to tell import-created contacts from pre-existing ones). */
  batchId: string;
  /** Address key: the tenant HMAC (hex) in the API; any injective function in tests. */
  keyOf(kind: AddressKind, normalized: string): string;
  contacts: ReadonlyMap<string, ExistingContact>;
  byAddress: ReadonlyMap<string, readonly ContactId[]>;
  byName: ReadonlyMap<string, readonly ContactId[]>;
  /** `refKey(entityType, externalId)` → local entity id (external_refs, R-IMPORT-9). */
  externalRefs: ReadonlyMap<string, string>;
  /**
   * This batch's contacts-stage plan for person refs that are NOT committed yet (later stages may be
   * dry-run before the contacts stage commits, R-IMPORT-3), and the skipped duplicates (never committed).
   * Committed refs are in `externalRefs`.
   */
  contactsStage: ReadonlyMap<string, ContactsStagePlan>;
  /** Address key → channels that are revoked or suppressed now (E39 preview). */
  optedOut: ReadonlyMap<string, readonly Channel[]>;
  /** `importedConsentKey(...)` of imported consent events already in the ledger (re-run idempotency). */
  importedConsent: ReadonlySet<string>;
}

// ---- dry run ------------------------------------------------------------------------------------

/** The dry-run outcomes (import_records.outcome before commit). */
export type DryRunOutcome = 'will_import' | 'needs_review' | 'rejected' | 'duplicate';

/** A contact that may not be committed yet: either a local id or the contacts-stage person ref. */
export type ContactRef = { contactId: ContactId } | { pendingPersonRef: string };

/** Fields filled on an existing contact: only where it is empty (E41). */
export interface ContactFill {
  firstName?: string;
  lastName?: string;
  intent?: Intent;
  addPhones: NormalizedPhone[];
  addEmails: NormalizedEmail[];
  addAddresses: NormalizedAddress[];
  addTags: string[];
  addImportedFields: Record<string, string>;
}

export interface DuplicateCandidate {
  contactId: ContactId;
  /** contact_duplicate_candidates.match_reason */
  reason: 'shared_phone' | 'shared_email' | 'phone_email_split' | 'import';
}

export type PlanAction =
  | { kind: 'create_contact'; duplicateCandidates: DuplicateCandidate[] }
  | { kind: 'attach_contact'; contactId: ContactId; fill: ContactFill; duplicateCandidates: DuplicateCandidate[] }
  | { kind: 'update_contact'; contactId: ContactId; fill: ContactFill }
  | { kind: 'skip'; existingId: string }
  | { kind: 'assign'; contact: ContactRef; target: ImportTarget }
  | { kind: 'insert_history'; contact: ContactRef }
  | { kind: 'record_consent'; contact: ContactRef | null; fields: FubConsentFields; grants: number; revokes: number; doNotContact: number };

export interface PlannedRecord {
  sourceRef: string;
  outcome: DryRunOutcome;
  /** What a commit does if the record is imported (null for rejected records). */
  action: PlanAction | null;
  issues: Issue[];
  /** import_records.match_contact_id */
  matchContactId: ContactId | null;
  normalized: NormalizedRecord | null;
  /** Channels already opted out for one of the record's addresses: "opted out, will stay opted out" (E39). */
  staysOptedOut: Channel[];
}

export interface StageCounts {
  source: number;
  will_import: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
}

export interface ConsentSummary {
  /** Records with at least one positive texting indicator. */
  textingPermission: number;
  /** Records with at least one positive email indicator. */
  emailPermission: number;
  /** Records with at least one opt-out / unsubscribe. */
  optedOut: number;
  /** Records with a do-not-contact flag. */
  doNotContact: number;
}

export interface StageDryRun {
  category: Category;
  counts: StageCounts;
  records: PlannedRecord[];
  /** Stage-level problems that block approval (e.g. an incomplete user mapping, R-IMPORT-8). */
  blockers: Issue[];
  /** sha256 of the canonical input records: a commit must present the same digest (R-IMPORT-4, E42). */
  snapshotSha256: string;
  consentSummary: ConsentSummary | null;
}

// ---- verification -------------------------------------------------------------------------------

/** One side of a recount (R-IMPORT-5): the plan after reviews, or what the database holds. */
export interface Counts {
  source: number;
  imported: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
}

export interface CountDiff {
  key: keyof Counts;
  source: number;
  db: number;
}

/** Codes core/import can return as `{ ok: false, code }` (CONVENTIONS §7). */
export type ImportErrorCode =
  | 'SNAPSHOT_CHANGED'
  | 'STAGE_BLOCKED'
  | 'REVIEW_PENDING'
  | 'REVIEW_NOT_ALLOWED'
  | 'UNKNOWN_RECORD'
  | 'RECOUNT_MISMATCH'
  | 'SPOT_CHECKS_INCOMPLETE'
  | 'SPOT_CHECK_FAILED'
  | 'CATEGORY_MISMATCH';
