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
  consent: 'Texting and email permission',
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

/** Whether the page should poll: something is running on the server. */
export function isRunning(b: ImportBatch): boolean {
  return RUNNING_BATCH.has(b.status) || b.stages.some((s) => RUNNING_STAGE.has(s.status));
}

/** Does source = will import + needs review + rejected + duplicate? (said, never hidden) */
export function reconciles(c: NonNullable<ImportStage['counts']>): boolean {
  return c.source === c.willImport + c.needsReview + c.rejected + c.duplicate;
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
