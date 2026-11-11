// Per-category report and verification (BUILD_PLAN module 6; R-IMPORT-5, R-IMPORT-1 copy).
//
// - Reconciliation is exact: source = imported + needs_review + rejected + duplicate, on both sides.
// - Verification = recount (plan after reviews vs what the database holds) + 20 side-by-side spot
//   checks (fewer only when fewer records were imported), recorded with the verifier.
// - Report copy is plain and never claims more than the counts show: every number in a sentence is
//   one of the counts, and nothing is promised before the connection test (R-IMPORT-1).
import { type Channel, sha256Hex } from '../compliance/index.js';
import type { Instant, UserId } from '../foundation/index.js';
import { CATEGORIES, type Category, type ConsentSummary, type CountDiff, type Counts, type ImportErrorCode, type NotImportedCounts, type StageCounts } from './types.js';

const KEYS: readonly (keyof Counts)[] = ['source', 'imported', 'needs_review', 'rejected', 'duplicate'];

export function reconciles(c: Counts): boolean {
  return c.source === c.imported + c.needs_review + c.rejected + c.duplicate;
}

export function stageReconciles(c: StageCounts): boolean {
  return c.source === c.will_import + c.needs_review + c.rejected + c.duplicate;
}

/**
 * R-IMPORT-5 recount: the expected counts (dry run + reviews, `commitPlan(...).expected`) against the
 * database recount. Matches only when every count is equal and both sides reconcile exactly.
 */
export function verificationReport(source: Counts, db: Counts): { matches: boolean; diffs: CountDiff[]; reconciles: { source: boolean; db: boolean } } {
  const diffs: CountDiff[] = KEYS.filter((k) => source[k] !== db[k]).map((k) => ({ key: k, source: source[k], db: db[k] }));
  const rec = { source: reconciles(source), db: reconciles(db) };
  return { matches: diffs.length === 0 && rec.source && rec.db, diffs, reconciles: rec };
}

export const SPOT_CHECKS = 20;

/**
 * The records to compare side by side: a deterministic, seed-dependent sample of `n` imported source
 * refs (the API seeds with the stage id, so the verifier cannot pick easy ones and a re-open shows the
 * same sample).
 */
export function spotCheckSample(importedRefs: readonly string[], seed: string, n = SPOT_CHECKS): string[] {
  return [...new Set(importedRefs)]
    .map((r) => ({ r, h: sha256Hex(`${seed}|${r}`) }))
    .sort((a, b) => (a.h < b.h ? -1 : 1)) // refs are unique, so their hashes are too
    .slice(0, n)
    .map((x) => x.r);
}

export interface SpotCheck {
  sourceRef: string;
  matches: boolean;
}

/**
 * Owner decision B4 (2026-11-11, E230): outcomes of a commit that the approved plan could not predict, each
 * documented on its records with the reason. Today there is one: a planned assignment the ownership commit
 * brought in unassigned because its member could no longer hold leads at that moment (suspended, no longer an
 * active member, or a role that holds none). Nothing is assigned to them; the record counts as not imported.
 */
export interface DocumentedOutcomes {
  /** planned assignments the ownership commit brought in unassigned (api/imports OWNER_UNAVAILABLE) */
  unassigned: number;
}

export const NO_DOCUMENTED: DocumentedOutcomes = { unassigned: 0 };

/**
 * The counts the approval expected, with the documented commit outcomes applied: each one moves exactly one
 * record from imported to rejected. Never clamped, so a documented count larger than the planned imports can
 * never match a real recount, and it never hides any other difference (R-IMPORT-5 stays exact).
 */
export function expectedAfterCommit(approved: Counts, d: DocumentedOutcomes): Counts {
  return { ...approved, imported: approved.imported - d.unassigned, rejected: approved.rejected + d.unassigned };
}

/** The `import_stages.verification` document. */
export interface StageVerification {
  verifiedByUserId: UserId;
  verifiedAt: Instant;
  /** `approved`: what the approval expected; `expected`: that with the documented outcomes applied (E230) */
  recount: { approved: Counts; expected: Counts; db: Counts };
  documented: DocumentedOutcomes;
  spotChecks: SpotCheck[];
}

/**
 * R-IMPORT-5: a stage can be marked verified only when the recount matches and every sampled record
 * was checked and matched. Returns the verification document to store with the verifier. `expected` is what
 * the approval expected; the documented commit outcomes (E230) are applied to it before the recount.
 */
export function buildVerification(i: {
  expected: Counts;
  documented?: DocumentedOutcomes;
  db: Counts;
  sample: readonly string[];
  spotChecks: readonly SpotCheck[];
  verifierUserId: UserId;
  at: Instant;
}): { ok: true; verification: StageVerification } | { ok: false; code: Extract<ImportErrorCode, 'RECOUNT_MISMATCH' | 'SPOT_CHECKS_INCOMPLETE' | 'SPOT_CHECK_FAILED'>; diffs?: CountDiff[]; sourceRefs?: string[] } {
  const documented = i.documented ?? NO_DOCUMENTED;
  const expected = expectedAfterCommit(i.expected, documented);
  const recount = verificationReport(expected, i.db);
  if (!recount.matches) return { ok: false, code: 'RECOUNT_MISMATCH', diffs: recount.diffs };
  const required = Math.min(SPOT_CHECKS, i.db.imported);
  const checked = new Map(i.spotChecks.map((s) => [s.sourceRef, s]));
  const missing = i.sample.filter((r) => !checked.has(r));
  if (i.sample.length < required || missing.length > 0) return { ok: false, code: 'SPOT_CHECKS_INCOMPLETE', sourceRefs: missing };
  const failed = i.sample.filter((r) => checked.get(r)?.matches !== true);
  if (failed.length > 0) return { ok: false, code: 'SPOT_CHECK_FAILED', sourceRefs: failed };
  return {
    ok: true,
    verification: {
      verifiedByUserId: i.verifierUserId,
      verifiedAt: i.at,
      recount: { approved: i.expected, expected, db: i.db },
      documented,
      spotChecks: i.sample.map((r) => checked.get(r) as SpotCheck),
    },
  };
}

// ---- report rows and copy -----------------------------------------------------------------------------

export interface ReportRow {
  category: Category;
  source: number;
  imported: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
  reconciles: boolean;
}

/** GET /imports/:id/report: one row per category in stage order (missing stages are left out). */
export function batchReport(stages: readonly { category: Category; counts: Counts }[]): ReportRow[] {
  const by = new Map(stages.map((s) => [s.category, s.counts]));
  return CATEGORIES.filter((c) => by.has(c)).map((c) => {
    const k = by.get(c) as Counts;
    return { category: c, ...k, reconciles: reconciles(k) };
  });
}

const NOUN: Record<Category, [string, string]> = {
  contacts: ['contact', 'contacts'],
  ownership: ['assignment', 'assignments'],
  notes: ['note', 'notes'],
  messages: ['message', 'messages'],
  call_recordings: ['call', 'calls'],
  consent: ['person with consent information', 'people with consent information'],
};

function n(x: number): string {
  return x.toLocaleString('en-US');
}

function plural(x: number, one: string, many: string): string {
  return `${n(x)} ${x === 1 ? one : many}`;
}

export type SourceName = 'Follow Up Boss' | 'your file';

/**
 * Plain sentences for one stage. Before commit the counts are what WILL happen; after commit what
 * DID. Every number is a count from the input; nothing else is claimed.
 */
export function reportLines(
  category: Category,
  phase: 'dry_run' | 'committed',
  counts: Counts,
  source: SourceName,
  consent: ConsentSummary | null = null,
): string[] {
  const [one, many] = NOUN[category];
  const lines = [`${plural(counts.source, one, many)} in ${source}.`];
  const done = phase === 'committed';
  const parts = [
    `${n(counts.imported)} ${done ? 'imported' : 'will be imported'}`,
    `${n(counts.needs_review)} ${counts.needs_review === 1 ? 'needs' : 'need'} your review`,
    `${n(counts.rejected)} ${done ? 'not imported' : 'will not be imported'} (see reasons)`,
    `${n(counts.duplicate)} already here or nothing new`,
  ];
  lines.push(`${parts.join(' · ')}.`);
  if (category === 'consent' && consent) {
    if (consent.textingPermission > 0) {
      lines.push(
        `${plural(consent.textingPermission, 'contact', 'contacts')} had texting permission in ${source}. We kept that as history; the assistant won't text them automatically until they confirm.`,
      );
    }
    if (consent.optedOut > 0) lines.push(`${plural(consent.optedOut, 'contact', 'contacts')} had opted out. ${consent.optedOut === 1 ? 'That stays' : 'They stay'} opted out.`);
    if (consent.doNotContact > 0) lines.push(`${plural(consent.doNotContact, 'contact was', 'contacts were')} marked do not contact. That stays.`);
  }
  if (category === 'call_recordings' && phase === 'committed' && counts.imported > 0) {
    lines.push('Imported recordings are labelled "recording notice unknown" and are not transcribed.');
  }
  return lines;
}

/** R-IMPORT-1: the only thing said after the connection test — counts, and no promise. */
export function connectionTestLines(categories: Record<Category, number | null>, source: SourceName): string[] {
  const lines: string[] = [];
  for (const c of CATEGORIES) {
    if (c === 'ownership' || c === 'consent') continue;
    const v = categories[c];
    const [one, many] = NOUN[c];
    lines.push(v === null ? `We could not count ${many} in ${source}.` : `${plural(v, one, many)} found in ${source}.`);
  }
  lines.push('Nothing is imported yet. Each step shows you exactly what would change before anything is written.');
  return lines;
}

/**
 * Owner decision B7 (2026-11-11, E233): what Follow Up Boss has that the import never brings over, said plainly
 * on the Imports page (from the connection test and the snapshot) and in the final report. Every number is a
 * count; one that could not be read is said so. A CSV file has neither, so nothing is said for it.
 */
export function notImportedLines(c: NotImportedCounts, source: SourceName): string[] {
  if (source === 'your file') return [];
  const tail = `Realty OS doesn't bring tasks or appointments over: finish or note the open ones in ${source} before you switch.`;
  const { tasks, appointments } = c;
  if (tasks === 0 && appointments === 0) return [`${source} has no tasks or appointments. Realty OS doesn't bring tasks or appointments over.`];
  if (tasks !== null && appointments !== null) return [`${source} has ${plural(tasks, 'task', 'tasks')} and ${plural(appointments, 'appointment', 'appointments')}. ${tail}`];
  if (tasks !== null) return [`${source} has ${plural(tasks, 'task', 'tasks')}; we could not count its appointments. ${tail}`];
  if (appointments !== null) return [`${source} has ${plural(appointments, 'appointment', 'appointments')}; we could not count its tasks. ${tail}`];
  return [`We could not count tasks or appointments in ${source}. ${tail}`];
}

const CHANNEL_WORD: Record<Channel, string> = { sms: 'texts', voice: 'calls', email: 'email', web_chat: 'website chat' };

/**
 * E39: the review-list note for a record whose address is already opted out. Importing never lifts
 * an opt-out, so the note says so plainly. Null when nothing is opted out.
 */
export function optOutPreview(staysOptedOut: readonly Channel[]): string | null {
  const words = (['sms', 'voice', 'email'] as const).filter((c) => staysOptedOut.includes(c)).map((c) => CHANNEL_WORD[c]);
  if (words.length === 0) return null;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1] as string}`;
  return `Opted out of ${list as string}. Will stay opted out.`;
}
