// Import helpers (pure; unit-tested). The staged FUB / CSV import (ARCHITECTURE §13, A6): counts
// first, then per category a dry run, a review list, an approval of exactly what was reviewed, a commit,
// and a verification (recount + side-by-side checks), in dependency order. The server enforces every
// step (R-IMPORT-2…5); these helpers only decide what the page offers, so it never offers a step the
// server would refuse.
import { IMPORT_CATEGORIES, type ImportBatch, type ImportCategory, type ImportStage } from '../admin/lib/types.js';

export const CATEGORY_LABEL: Record<ImportCategory, string> = {
  contacts: 'Contacts',
  ownership: 'Who owns each contact',
  notes: 'Notes',
  messages: 'Texts and emails',
  call_recordings: 'Calls and recordings',
  consent: 'Opt-outs and consent history',
};

/**
 * What a category means, where it needs saying. Consent (owner decision, core-compliance/2.0.0): opt-
 * outs carry over and block sending exactly like an opt-out made here; opt-ins are kept as history and
 * no longer change who can be messaged.
 */
export const CATEGORY_NOTE: Partial<Record<ImportCategory, string>> = {
  consent: "Opt-outs carry over and block texts, email or calls here exactly as if the person had opted out in this app: anyone who texted STOP, unsubscribed or asked not to be contacted in the old system stays opted out. Opt-ins are kept as history only; they don't change who can be messaged.",
};

/** What skipping a category gives up, where it matters. */
export const SKIP_WARNING: Partial<Record<ImportCategory, string>> = {
  consent: "If you skip this, opt-outs from the old system won't carry over, and people who asked not to be contacted could be messaged from here.",
};

export const STAGE_STATUS: Record<string, string> = {
  pending: 'Not started',
  dry_run_running: 'Dry run in progress',
  dry_run_ready: 'Dry run ready to review',
  approved: 'Approved, ready to import',
  committing: 'Importing',
  committed: 'Imported, waiting for verification',
  verified: 'Verified',
  skipped: 'Skipped',
  reverting: 'Undoing',
  reverted: 'Undone',
  failed: 'Stopped with a problem',
};

export const OUTCOME_LABEL: Record<string, string> = {
  will_import: 'Will import',
  imported: 'Imported',
  needs_review: 'Needs review',
  rejected: 'Rejected',
  duplicate: 'Possible duplicate',
  reverted: 'Undone',
};

export const SOURCE_LABEL: Record<ImportBatch['source'], string> = {
  csv: 'CSV file',
  fub_api: 'Follow Up Boss',
  fub_export: 'Follow Up Boss export',
};

const DONE = new Set(['verified', 'skipped']);
const RUNNING_STAGE = new Set(['dry_run_running', 'committing', 'reverting']);
const RUNNING_BATCH = new Set(['connection_test', 'snapshotting', 'committing', 'reverting']);

/** Stages in dependency order (contacts → ownership → notes → messages → call_recordings → consent). */
export function ordered(stages: readonly ImportStage[]): ImportStage[] {
  return [...stages].sort((a, b) => IMPORT_CATEGORIES.indexOf(a.category) - IMPORT_CATEGORIES.indexOf(b.category));
}

/** The earlier stages that still block this one from committing (R-IMPORT-3): not verified or skipped. */
export function blockingEarlier(stage: ImportStage, stages: readonly ImportStage[]): ImportStage[] {
  const i = IMPORT_CATEGORIES.indexOf(stage.category);
  return ordered(stages).filter((s) => IMPORT_CATEGORIES.indexOf(s.category) < i && !DONE.has(s.status));
}

export type StageStep = 'dry_run' | 'running' | 'review' | 'commit' | 'verify' | 'done' | 'none';

/** What this stage needs next. A dry run may run early; a commit waits for earlier stages. */
export function nextStep(stage: ImportStage, batch: Pick<ImportBatch, 'snapshotSha256' | 'status'>): StageStep {
  if (batch.status === 'reverted' || batch.status === 'abandoned') return 'none';
  if (RUNNING_STAGE.has(stage.status)) return 'running';
  switch (stage.status) {
    case 'pending':
    case 'failed':
      return batch.snapshotSha256 ? 'dry_run' : 'none';
    case 'dry_run_ready':
      return 'review';
    case 'approved':
      return 'commit';
    case 'committed':
      return 'verify';
    case 'verified':
    case 'skipped':
    case 'reverted':
      return 'done';
    default:
      return 'none';
  }
}

const REVERTIBLE = new Set(['committed', 'verified']);
const SKIPPABLE = new Set(['pending', 'dry_run_ready', 'failed']);
const CSV_CONSENT_TARGETS = new Set(['consent_sms', 'consent_email', 'consent_voice', 'opted_out', 'unsubscribed', 'do_not_contact']);

/**
 * Consent can be skipped only after its dry run has shown which opt-outs would be lost (E40), unless the
 * contacts are skipped too or a CSV maps no consent column: the server's consentSkipBlocker, mirrored so
 * the page never offers a skip the server refuses.
 */
export function consentNeedsDryRunToSkip(stage: ImportStage, stages: readonly ImportStage[], batch: Pick<ImportBatch, 'source' | 'csv'>): boolean {
  if (stage.category !== 'consent') return false;
  if (stages.find((s) => s.category === 'contacts')?.status === 'skipped') return false;
  if (batch.source === 'csv' && !(batch.csv?.mapping ?? []).some((t) => CSV_CONSENT_TARGETS.has(String((t as { field?: unknown } | null)?.field ?? '')))) return false;
  return !['dry_run_ready', 'approved'].includes(stage.status);
}

/** "Skip this category" is offered: a stage not imported yet, and (consent) its dry run done where needed. */
export function canSkipStage(stage: ImportStage, stages: readonly ImportStage[], batch: Pick<ImportBatch, 'source' | 'csv' | 'status'>): boolean {
  return SKIPPABLE.has(stage.status) && batch.status !== 'reverted' && !consentNeedsDryRunToSkip(stage, stages, batch);
}

/** "Undo this category" is offered: imported, and no later category is still imported (undo runs latest first, IMPORT_REVERT_ORDER). */
export function canUndoStage(stage: ImportStage, stages: readonly ImportStage[], batch: Pick<ImportBatch, 'status'>): boolean {
  return REVERTIBLE.has(stage.status) && batch.status !== 'reverted' && !stages.some((s) => s.seq > stage.seq && REVERTIBLE.has(s.status));
}

/** Whether the page should poll: something is running on the server. */
export function isRunning(b: ImportBatch): boolean {
  return RUNNING_BATCH.has(b.status) || b.stages.some((s) => RUNNING_STAGE.has(s.status));
}

/**
 * Does source = will import + needs review + rejected + duplicate? (said, never hidden) After the commit the other
 * three are the recount's, so it is checked against what was imported: a record the commit documented as not
 * imported (a person brought in unassigned, owner decision B4) is in the rejected count, not a gap.
 */
export function reconciles(c: NonNullable<ImportStage['counts']>): boolean {
  return c.source === (c.imported ?? c.willImport) + c.needsReview + c.rejected + c.duplicate;
}

// ---- owner decision B7 (2026-11-11): Follow Up Boss tasks and appointments are counted, never imported ----

/** What Follow Up Boss holds that the import does not bring over, with the server's plain sentence (null for CSV). */
export interface NotImportedView {
  tasks: number | null;
  appointments: number | null;
  countedAt?: 'connection_test' | 'snapshot' | 'export_file' | null;
  lines: string[];
}

/** A batch as GET /imports/:id returns it (owner decision B7 adds `notImported`). */
export type ImportBatchView = ImportBatch & { notImported?: NotImportedView | null };

// ---- owner decision B4 (2026-11-11): people the ownership commit brought in unassigned ---------------------

/** GET /imports/:id/report, ownership: the people brought in unassigned; "Assign these people" selects exactly `contactIds`. */
export interface UnassignedView {
  total: number;
  stillUnassigned: number;
  /** the people who still have no owner, at most the bulk Assign cap (2,000) */
  contactIds: string[];
  people: { contactId: string; name: string; sentence: string; stillUnassigned: boolean }[];
}

/** The verification with what the approval expected and the outcomes the commit documented (each with a sentence). */
export interface DocumentedOutcome {
  code: string;
  count: number;
  sentence: string;
}

/** Bytes → base64 in chunks (no stack overflow on large files). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** A one-line, human summary of a normalized record from the review list. */
export function recordSummary(r: Record<string, unknown> | null): string {
  if (!r) return 'No details';
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const parts: string[] = [];
  const name = str(r.displayName);
  if (name) parts.push(name);
  parts.push(...list(r.phones), ...list(r.emails));
  const preview = str(r.preview);
  if (preview) parts.push(`“${preview.length > 120 ? `${preview.slice(0, 120)}…` : preview}”`);
  if (Array.isArray(r.addresses)) parts.push(`${r.addresses.length} address${r.addresses.length === 1 ? '' : 'es'}`);
  if (parts.length === 0 && str(r.personRef)) parts.push(`Person ${str(r.personRef)}`);
  return parts.join(' · ') || 'No details';
}

/** Spot checks ready to submit: every sampled record marked one way or the other (none sampled: nothing to mark). */
export function spotChecksReady(sample: readonly { sourceRef: string }[], marks: ReadonlyMap<string, boolean>): boolean {
  return sample.every((s) => marks.has(s.sourceRef));
}

// ---- PARITY 65: stages, tags and custom fields (R-PAR-46) -------------------------------------------

export const PARITY_STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export const STAGE_KEY_LABEL: Record<(typeof PARITY_STAGES)[number], string> = {
  new: 'New',
  attempting: 'Attempting',
  connected: 'Connected',
  nurture: 'Nurture',
  active: 'Active',
  under_contract: 'Under contract',
  closed: 'Closed',
  lost: 'Lost',
};
export const FIELD_TYPE_LABEL = { text: 'text', number: 'number', date: 'date', single_select: 'one choice', multi_select: 'several choices' } as const;
export type FieldTypeKey = keyof typeof FIELD_TYPE_LABEL;

export type FieldActionView = { action: 'skip' } | { action: 'create'; type: FieldTypeKey; label: string } | { action: 'existing'; fieldId: string };

export interface ParityRowView {
  category: 'stages' | 'tags' | 'custom_fields';
  source: number;
  imported: number;
  needsReview: number;
  rejected: number;
  duplicate: number;
}

export interface ParityResponse {
  options: { stageMap: Record<string, string>; keepStageAsTag: boolean; fields: Record<string, FieldActionView> };
  stages: { label: string; people: number; suggested: string | null; mapped: string | null }[];
  tags: { distinct: number; existing: number; toCreate: number; overLimit: number; sourceLinks: number; links: number; protectedNew: number; optOutTagged: number; overLimitNames: string[] };
  fields: { sourceKey: string; label: string; people: number; suggestedType: FieldTypeKey; protected: boolean; action: FieldActionView; fit: number; misfit: number; options: { id: string; label: string }[] }[];
  existingFields: { id: string; key: string; label: string; type: FieldTypeKey }[];
  blockers: string[];
  lines: string[];
  report: ParityRowView[];
}

export const PARITY_CATEGORY_LABEL: Record<ParityRowView['category'], string> = { stages: 'Stages', tags: 'Tags', custom_fields: 'Custom fields' };

/** The parity map can still change: the contacts stage has not been imported (or is being). */
export function parityEditable(stages: readonly { category: string; status: string }[]): boolean {
  const c = stages.find((s) => s.category === 'contacts');
  return !!c && ['pending', 'dry_run_ready', 'approved', 'failed'].includes(c.status);
}
