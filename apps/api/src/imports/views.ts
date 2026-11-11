// API shapes of api/imports and the plain sentences the review list and the report show (BUILD_PLAN
// module 16; R-IMPORT-1 copy, R-IMPORT-5; product values: honest copy, every number is a count).
// No confidence scores anywhere (R-AST-13); no tenant id in any shape (R-TEN-3).
import { type Category, type ConsentSummary, type Counts, type NormalizedRecord, type ParityReportRow, type SourceName, batchReport, connectionTestLines, optOutPreview, parityCommittedReport, parityLines, parityReport, reportLines } from '@realty/core/import';
import type { Channel } from '@realty/core/compliance';
import type { BatchRow, MappingRow, StageRow } from './repos/batches.js';
import type { RecordRow } from './repos/records.js';

/** One plain sentence per issue code (the web maps codes too; unknown codes get a generic sentence). */
export const ISSUE_SENTENCES: Record<string, string> = {
  PHONE_INVALID: 'A phone number could not be read as a full number with area code; it was left out.',
  EMAIL_INVALID: 'An email address is not valid; it was left out.',
  POSTAL_INVALID: 'A postal code is not valid; it was left out.',
  TIMESTAMP_INVALID: 'A date could not be read.',
  FORMULA_PREFIX: 'A value started like a spreadsheet formula; it was stored as plain text.',
  VALUE_TRUNCATED: 'A value was too long and was shortened.',
  TOO_MANY_VALUES: 'There were more values than we keep; the extra ones were left out.',
  STAGE_MAP_INCOMPLETE: 'Some stages from the source have no stage here yet. Pick one for each under "Stages, tags and custom fields", then run the check again.',
  TAG_LIMIT: 'These tags would pass the 1,000-tag limit. Merge or delete some tags first; the ones that do not fit stay as text on each person.',
  CUSTOM_FIELD_LIMIT: 'These new custom fields would pass the 50-field limit. Map some onto existing fields or keep them as text.',
  STAGE_UNMAPPED: 'The stage name is not one we know: it gets the stage chosen for it in the stage map, and the original is kept for reference.',
  TYPE_UNMAPPED: 'The contact type is not one we know; it was kept for reference.',
  INTENT_UNMAPPED: 'Buyer/seller intent could not be read; it was kept for reference.',
  NAME_MISSING: 'No name; the contact is named after a phone or email.',
  EXTRA_CELLS: 'The row has more cells than the header; the extra cells were ignored.',
  TAG_READ_AS_OPT_OUT: 'A tag reads like an opt-out, so it is treated as one.',
  NO_IDENTITY: 'No name, valid phone or valid email: nothing to import.',
  RECORD_MALFORMED: 'The record could not be read.',
  SOURCE_REF_DUPLICATE: 'The same record appears twice in the source; the second copy was left out.',
  BODY_EMPTY: 'Empty text: nothing to import.',
  BODY_TOO_LONG: 'The text was too long and was shortened.',
  PARENT_NOT_FOUND: 'The contact this belongs to is not in the import.',
  PARENT_REJECTED: 'The contact this belongs to was not imported.',
  PARENT_NOT_LINKED: 'The contact this belongs to still needs your review.',
  PARENT_DUPLICATE: 'The person this belongs to was skipped as a duplicate (of an earlier row, or of a contact already here), so it goes on that contact.',
  USER_UNMAPPED: 'Assigned to a Follow Up Boss user who is not mapped to a team member yet.',
  IN_FILE_DUPLICATE: 'Same person as an earlier row of this import (same id, phone or email).',
  ALREADY_IMPORTED: 'Already imported earlier; nothing new to add.',
  NAME_ONLY_MATCH: 'Someone with the same name exists. Not merged: listed as a possible duplicate.',
  MATCH_OWNED_CONTACT: "Matches a contact another agent owns. Only empty fields are filled; the owner doesn't change.",
  MATCH_MULTIPLE: 'More than one existing contact shares these details; listed as possible duplicates.',
  MATCH_DELETED_CONTACT: 'Matches a deleted contact. It is imported as a new contact; any opt-out still applies.',
  ADDRESS_OPTED_OUT: 'Opted out already. Will stay opted out.',
  OWNER_KEPT: 'This contact already has an owner here; the import does not change it.',
  CONSENT_VALUE_AMBIGUOUS: 'A permission value is unclear; nothing was recorded from it.',
  CONSENT_VALUE_UNRECOGNIZED: 'A permission value was not recognized; nothing was recorded from it.',
  CONSENT_CONFLICT: 'The source says both yes and no; the opt-out wins.',
  NO_CONSENT_DATA: 'No permission information to record.',
  RECORDING_NOTICE_UNKNOWN: 'Recording notice unknown: the recording is kept and labelled, and not transcribed.',
  RECORDING_NOT_AVAILABLE: 'The recording could not be copied from Follow Up Boss; the call is imported without it.',
  USER_MAPPING_INCOMPLETE: 'Map every Follow Up Boss user before approving this step.',
  COMMIT_FAILED: 'This record could not be written; nothing else was affected.',
};

export const GENERIC_ISSUE = 'Something about this record needs a look.';

export function issueView(i: { code: string; severity: string; field?: string }): { code: string; severity: string; field: string | null; sentence: string } {
  return { code: i.code, severity: i.severity, field: i.field ?? null, sentence: ISSUE_SENTENCES[i.code] ?? GENERIC_ISSUE };
}

export function sourceName(b: BatchRow): SourceName {
  return b.source === 'csv' ? 'your file' : 'Follow Up Boss';
}

const iso = (d: Date | null) => (d === null ? null : d.toISOString());

export function stageView(s: StageRow) {
  return {
    id: s.id,
    category: s.category,
    seq: s.seq,
    status: s.status,
    counts:
      s.count_source === null
        ? null
        : {
            source: s.count_source,
            willImport: s.count_will_import ?? 0,
            imported: s.count_imported,
            needsReview: s.count_needs_review ?? 0,
            rejected: s.count_rejected ?? 0,
            duplicate: s.count_duplicate ?? 0,
          },
    dryRunSha256: s.dry_run_sha256,
    dryRunCompletedAt: iso(s.dry_run_completed_at),
    blockers: s.blockers.map(issueView),
    approvedAt: iso(s.approved_at),
    approvedByUserId: s.approved_by_user_id,
    committedAt: iso(s.committed_at),
    verifiedAt: iso(s.verified_at),
    verifiedByUserId: s.verified_by_user_id,
    revert: s.revert_report as Record<string, unknown> | null,
  };
}

export function batchView(b: BatchRow, stages: readonly StageRow[]) {
  return {
    id: b.id,
    source: b.source,
    status: b.status,
    sourceCounts: b.source_counts,
    snapshotSha256: b.source_snapshot_sha256,
    snapshotAt: iso(b.source_snapshot_at),
    snapshotError: b.options.snapshotError ?? null,
    fileLabel: b.options.fileLabel ?? null,
    csv: b.source === 'csv' ? { headers: b.options.headers ?? [], mapping: b.options.mapping ?? [] } : null,
    createdAt: b.created_at.toISOString(),
    createdByUserId: b.created_by_user_id,
    revertedAt: iso(b.reverted_at),
    stages: stages.map(stageView),
    connectionTest: connectionTestLines(
      {
        contacts: b.source_counts.contacts ?? null,
        ownership: b.source_counts.ownership ?? null,
        notes: b.source === 'csv' ? 0 : (b.source_counts.notes ?? null),
        messages: b.source === 'csv' ? 0 : (b.source_counts.messages ?? null),
        call_recordings: b.source === 'csv' ? 0 : (b.source_counts.call_recordings ?? null),
        consent: b.source_counts.consent ?? null,
      },
      sourceName(b),
    ).filter((l) => b.source !== 'csv' || !/^0 (notes|messages|calls) /.test(l)),
  };
}

function summary(n: NormalizedRecord | null): Record<string, unknown> | null {
  if (!n) return null;
  switch (n.category) {
    case 'contacts':
      return { displayName: n.displayName, phones: n.phones.map((p) => p.e164), emails: n.emails.map((e) => e.email), tags: n.tags, stage: n.stage, contactType: n.contactType };
    case 'ownership':
      return { personRef: n.personRef, target: n.target };
    case 'notes':
      return { personRef: n.personRef, preview: n.body.slice(0, 200), occurredAt: new Date(n.occurredAt).toISOString() };
    case 'messages':
      return { personRef: n.personRef, channel: n.channel, direction: n.direction, preview: n.body.slice(0, 200), occurredAt: new Date(n.occurredAt).toISOString() };
    case 'call_recordings':
      return { personRef: n.personRef, direction: n.direction, startedAt: new Date(n.startedAt).toISOString(), durationS: n.durationS, recording: n.recording ? n.recording.label : null };
    case 'consent':
      return {
        personRef: n.personRef,
        addresses: n.fields.addresses.map((a) => ({ kind: a.kind, address: a.address, grants: a.grants, revokes: a.revokes, doNotContact: a.doNotContact })),
      };
  }
}

const PLAN_WORD: Record<string, string> = {
  create_contact: 'create',
  attach_contact: 'attach',
  update_contact: 'update',
  skip: 'skip',
  assign: 'assign',
  insert_history: 'add',
  record_consent: 'record',
};

export function recordView(r: RecordRow) {
  const plan = r.plan as { kind?: string; duplicateCandidates?: { contactId: string; reason: string }[]; staysOptedOut?: Channel[]; mergeIntoContactId?: string } | null;
  return {
    id: r.id,
    sourceRef: r.source_ref,
    outcome: r.outcome,
    dryRunOutcome: r.dry_run_outcome,
    planned: plan?.kind ? (PLAN_WORD[plan.kind] ?? null) : null,
    issues: r.issues.map(issueView),
    record: summary(r.normalized as NormalizedRecord | null),
    matchContactId: r.match_contact_id,
    duplicateCandidates: (plan?.duplicateCandidates ?? []).map((d) => ({ contactId: d.contactId, reason: d.reason })),
    optOutNote: optOutPreview(plan?.staysOptedOut ?? []),
    review: r.review_decision === null ? null : { decision: r.review_decision, byUserId: r.reviewed_by_user_id, mergeIntoContactId: plan?.mergeIntoContactId ?? null },
    targetId: r.target_id,
  };
}

export function mappingView(b: BatchRow, rows: readonly MappingRow[]) {
  const byRef = new Map(rows.map((r) => [r.source_user_ref, r]));
  const target = (m: MappingRow | undefined) =>
    m === undefined ? null : m.target_kind === 'user' ? { kind: 'user' as const, userId: m.target_user_id } : m.target_kind === 'pond' ? { kind: 'pond' as const, pondId: m.target_pond_id } : { kind: 'unassigned' as const };
  const users = (b.options.sourceUsers ?? []).map((u) => ({ sourceRef: u.ref, label: u.label, people: u.people, target: target(byRef.get(u.ref)) }));
  const ponds = (b.options.sourcePonds ?? []).map((p) => ({ sourceRef: p.ref, label: p.label, people: p.people, target: target(byRef.get(`pond:${p.ref}`)) }));
  const unmapped = users.filter((u) => u.target === null && u.people > 0).length + ponds.filter((p) => p.target === null).length;
  return { users, ponds, unmapped, complete: unmapped === 0 };
}

/** What an undo removed, in words: "3 people, 3 phone numbers or emails and 2 notes". */
const REMOVED_WORDS: Record<string, [string, string]> = {
  contacts: ['person', 'people'],
  contact_points: ['phone number or email', 'phone numbers or emails'],
  contact_addresses: ['address', 'addresses'],
  notes: ['note', 'notes'],
  messages: ['text or email', 'texts and emails'],
  calls: ['call', 'calls'],
  recordings: ['recording', 'recordings'],
  consent_events: ['imported permission', 'imported permissions'],
};
const REMOVED_ORDER = Object.keys(REMOVED_WORDS);

export function removedWords(byTable: Record<string, number>): string {
  const parts = Object.entries(byTable)
    .filter(([, k]) => k > 0)
    .sort(([a], [b]) => (REMOVED_ORDER.indexOf(a) < 0 ? 99 : REMOVED_ORDER.indexOf(a)) - (REMOVED_ORDER.indexOf(b) < 0 ? 99 : REMOVED_ORDER.indexOf(b)))
    .map(([t, k]) => {
      const w = REMOVED_WORDS[t] ?? ['other imported row', 'other imported rows'];
      return `${k.toLocaleString('en-US')} ${k === 1 ? w[0] : w[1]}`;
    });
  if (parts.length === 0) return 'nothing';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

function revertLines(s: StageRow): string[] {
  const r = (s.revert_report ?? {}) as { removed?: number; compensated?: number; needsDecision?: number; keptReasons?: Record<string, number>; removedByTable?: Record<string, number> };
  const n = (x: number | undefined) => (x ?? 0).toLocaleString('en-US');
  const what = r.removedByTable ? removedWords(r.removedByTable) : `${n(r.removed)} imported ${r.removed === 1 ? 'row' : 'rows'}`;
  const left = (r.needsDecision ?? 0) === 0 ? 'nothing was left for your decision' : `${n(r.needsDecision)} ${r.needsDecision === 1 ? 'record was' : 'records were'} changed since the import and left for your decision`;
  const lines = [`Undone. The undo removed what this import added: ${what}; ${left}.`];
  if ((r.compensated ?? 0) > 0) {
    lines.push(
      s.category === 'ownership'
        ? `${n(r.compensated)} imported ${r.compensated === 1 ? 'assignment was' : 'assignments were'} undone; ${r.compensated === 1 ? 'that lead is' : 'those leads are'} unassigned again.`
        : `${n(r.compensated)} imported permissions were withdrawn.`,
    );
  }
  if (s.category === 'ownership' && (r.needsDecision ?? 0) > 0) lines.push('Leads someone worked on since the import keep their current owner.');
  const kept = (r.keptReasons?.REVOCATION_KEPT ?? 0) + (r.keptReasons?.DNC_KEPT ?? 0);
  if (kept > 0) lines.push(`${n(kept)} imported opt-outs and do-not-contact flags stay in place.`);
  return lines;
}

/** GET /imports/:id/report: per category source | imported | needs review | rejected | duplicate, plus plain lines. */
export function reportView(b: BatchRow, stages: readonly StageRow[]) {
  const name = sourceName(b);
  const rows = stages
    .filter((s) => s.count_source !== null)
    .map((s) => {
      const committed = s.count_imported !== null && ['committed', 'verified', 'reverting', 'reverted'].includes(s.status);
      const reverted = s.status === 'reverted';
      const counts: Counts = {
        source: s.count_source ?? 0,
        imported: committed ? (s.count_imported ?? 0) : (s.count_will_import ?? 0),
        needs_review: s.count_needs_review ?? 0,
        rejected: s.count_rejected ?? 0,
        duplicate: s.count_duplicate ?? 0,
      };
      return { stage: s, counts, phase: reverted ? ('reverted' as const) : committed ? ('committed' as const) : ('dry_run' as const) };
    });
  const table = batchReport(rows.map((r) => ({ category: r.stage.category, counts: r.counts })));
  return {
    source: name,
    parity: parityReportView(b, stages),
    categories: table.map((t) => {
      const r = rows.find((x) => x.stage.category === t.category)!;
      return {
        category: t.category as Category,
        status: r.stage.status,
        phase: r.phase,
        source: t.source,
        imported: t.imported,
        needsReview: t.needs_review,
        rejected: t.rejected,
        duplicate: t.duplicate,
        reconciles: t.reconciles,
        lines: r.phase === 'reverted' ? revertLines(r.stage) : reportLines(t.category, r.phase, r.counts, name, (r.stage.consent_summary as ConsentSummary | null) ?? null),
      };
    }),
  };
}

/** PARITY 65 (R-PAR-46): the stages / tags / custom fields rows of the contacts stage, with plain lines. */
export function parityReportView(b: BatchRow, stages: readonly StageRow[]) {
  const c = stages.find((s) => s.category === 'contacts');
  const summary = b.options.paritySummary;
  if (!c || !summary || c.count_source === null) return null;
  const committed = c.count_imported !== null && ['committed', 'verified', 'reverting', 'reverted'].includes(c.status);
  const phase = c.status === 'reverted' ? ('reverted' as const) : committed ? ('committed' as const) : ('dry_run' as const);
  const rows = phase === 'dry_run' ? parityReport(summary) : parityCommittedReport(b.options.parityCommitted ?? {});
  const lines = phase === 'dry_run' ? parityLines(summary, sourceName(b) === 'your file' ? 'your file' : 'Follow Up Boss') : parityCommittedLines(rows, phase === 'reverted');
  const rev = (c.revert_report as { parity?: { tagLinks: number; values: number; tags: number; fields: number } } | null)?.parity;
  if (phase === 'reverted' && rev) {
    lines.push(`The undo removed ${rev.tagLinks} tag ${rev.tagLinks === 1 ? 'link' : 'links'}, ${rev.values} custom ${rev.values === 1 ? 'value' : 'values'} and ${rev.tags} unused ${rev.tags === 1 ? 'tag' : 'tags'}; ${rev.fields} unused ${rev.fields === 1 ? 'field was' : 'fields were'} archived.`);
  }
  return {
    phase,
    rows: rows.map((r) => ({ category: r.category, source: r.source, imported: r.imported, needsReview: r.needs_review, rejected: r.rejected, duplicate: r.duplicate })),
    lines,
  };
}

/** What the import wrote; after an undo, in the past (what it had written before the undo removed it). */
function parityCommittedLines(rows: readonly ParityReportRow[], undone = false): string[] {
  const [st, tg, cf] = rows as [ParityReportRow, ParityReportRow, ParityReportRow];
  if (undone) {
    return [
      `Before the undo, the import had set ${st.imported} ${st.imported === 1 ? 'stage' : 'stages'}, added ${tg.imported} ${tg.imported === 1 ? 'tag' : 'tags'} and written ${cf.imported} custom ${cf.imported === 1 ? 'value' : 'values'}.`,
    ];
  }
  return [
    `Stages: ${st.imported} set from the import${st.duplicate > 0 ? `, ${st.duplicate} people already here kept their stage` : ''}.`,
    `Tags: ${tg.imported} added${tg.duplicate > 0 ? `, ${tg.duplicate} already there` : ''}${tg.rejected > 0 ? `, ${tg.rejected} not added (limit); their text stays on the person` : ''}.`,
    `Custom fields: ${cf.imported} values written${cf.duplicate > 0 ? `, ${cf.duplicate} kept the value an agent had set` : ''}${cf.rejected > 0 ? `, ${cf.rejected} did not fit and stay as text on the person` : ''}.`,
  ];
}
