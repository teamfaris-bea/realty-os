// API shapes of api/imports and the plain sentences the review list and the report show (BUILD_PLAN
// module 16; R-IMPORT-1 copy, R-IMPORT-5; product values: honest copy, every number is a count).
// No confidence scores anywhere (R-AST-13); no tenant id in any shape (R-TEN-3).
import { type Category, type ConsentSummary, type Counts, type DocumentedOutcomes, type NormalizedRecord, type ParityReportRow, type SourceName, batchReport, connectionTestLines, notImportedLines, optOutPreview, parityCommittedReport, parityLines, parityReport, reportLines } from '@realty/core/import';
import type { Channel } from '@realty/core/compliance';
import { type Role, canOwnLeads } from '@realty/core/foundation';
import { BULK_CAPS } from '@realty/core/parity/bulk';
import type { BatchRow, MappingRow, StageRow } from './repos/batches.js';
import type { RecordRow, UnassignedPersonRow } from './repos/records.js';
import { type CameInUnassignedIssue, OWNER_UNAVAILABLE, PERSON_CHANGED, PERSON_MERGED, type PersonIssue, type UnassignedIssue, type UnassignedNow, type UnassignedReason } from './types.js';

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
  OPT_OUTS_CARRIED: 'Skipped as a duplicate, but its opt-outs were recorded on its phones and emails when the contacts were imported.',
  USER_UNMAPPED: 'Assigned to a Follow Up Boss user who is not mapped to a team member yet.',
  IN_FILE_DUPLICATE: 'Same person as an earlier row of this import (same id, phone or email).',
  ALREADY_IMPORTED: 'Already imported earlier; nothing new to add.',
  NAME_ONLY_MATCH: 'Someone with the same name exists. Not merged: listed as a possible duplicate.',
  MATCH_OWNED_CONTACT: "Matches a contact another agent owns. Only empty fields are filled; the owner doesn't change.",
  MATCH_MULTIPLE: 'More than one existing contact shares these details; listed as possible duplicates.',
  MATCH_DELETED_CONTACT: 'Matches a deleted contact. It is imported as a new contact; any opt-out still applies.',
  ADDRESS_OPTED_OUT: 'Opted out already. Will stay opted out.',
  // batch 6 review F3: true of every way it is reached (a person already here, a skipped duplicate's, someone gave them an
  // owner since the contacts were imported); never "already has an owner" of someone who has none
  OWNER_KEPT: "This person was already here, or someone gave them an owner after the contacts were imported, so the import doesn't change who owns them.",
  [PERSON_MERGED]: 'Brought in unassigned: they were merged with another person after the contacts were imported.',
  [PERSON_CHANGED]: 'Brought in unassigned: someone changed who holds them after the contacts were imported.',
  CONSENT_VALUE_AMBIGUOUS: 'A permission value is unclear; nothing was recorded from it.',
  CONSENT_VALUE_UNRECOGNIZED: 'A permission value was not recognized; nothing was recorded from it.',
  CONSENT_CONFLICT: 'The source says both yes and no; the opt-out wins.',
  NO_CONSENT_DATA: 'No permission information to record.',
  RECORDING_NOTICE_UNKNOWN: 'Recording notice unknown: the recording is kept and labelled, and not transcribed.',
  RECORDING_NOT_AVAILABLE: 'The recording could not be copied from Follow Up Boss; the call is imported without it.',
  USER_MAPPING_INCOMPLETE: 'Map every Follow Up Boss user before approving this step.',
  COMMIT_FAILED: 'This record could not be written; nothing else was affected.',
  // owner decision B4 (E230); shown with the member's name and the reason when the issue carries them (unassignedSentence)
  [OWNER_UNAVAILABLE]: "Brought in unassigned: the member they were matched to couldn't hold leads when the owners were imported.",
};

export const GENERIC_ISSUE = 'Something about this record needs a look.';

/** A member a sentence names, with their membership as it reads now (repos/batches memberNames). */
export interface MemberNow {
  name: string;
  status: string;
  role: string;
}
/** The members the sentences of a page name (the review list, the report), looked up when shown. */
export type MemberNames = ReadonlyMap<string, MemberNow>;
const NO_NAMES: MemberNames = new Map();

/** Whether the reason the commit read still describes the member now (review B4-R2: only then is it said in the present). */
function reasonHolds(reason: UnassignedReason, m: MemberNow | undefined): boolean {
  if (m === undefined) return false;
  switch (reason) {
    case 'suspended':
      return m.status === 'suspended';
    case 'inactive':
      return m.status !== 'active';
    case 'role':
      return !canOwnLeads(m.role as Role);
    case 'unavailable':
      return false;
  }
}

const AT_IMPORT = 'when the owners were imported';

/**
 * Owner decision B4 (E230): why a planned assignment came in unassigned, naming the member when we can. The reason is
 * the one the commit read. It is said in the present ("Blake Chen's account is suspended") while the member's
 * membership still shows it, and otherwise as it was then ("was suspended when the owners were imported"), so a
 * member reactivated, or given a role that holds leads, since the commit is never described as they were (B4-R2).
 */
export function unassignedClause(reason: UnassignedReason, member: MemberNow | undefined): string {
  const name = member !== undefined && member.name.trim() !== '' ? member.name : null;
  const now = reasonHolds(reason, member);
  switch (reason) {
    case 'suspended': {
      const whose = name === null ? 'the account of the member they were matched to' : `${name}'s account`;
      return now ? `${whose} is suspended` : `${whose} was suspended ${AT_IMPORT}`;
    }
    case 'inactive': {
      const who = name ?? 'the member they were matched to';
      return now ? `${who} is no longer an active member of the team` : `${who} was no longer an active member of the team ${AT_IMPORT}`;
    }
    case 'role': {
      const whose = name === null ? 'the role of the member they were matched to' : `${name}'s role`;
      return now ? `${whose} can't hold leads` : `${whose} couldn't hold leads ${AT_IMPORT}`;
    }
    case 'unavailable':
      return `${name ?? 'the member they were matched to'} couldn't take leads ${AT_IMPORT}`;
  }
}

const REASONS: ReadonlySet<string> = new Set<UnassignedReason>(['suspended', 'inactive', 'role', 'unavailable']);
function asUnassigned(i: { code: string }): UnassignedIssue | null {
  const x = i as Partial<UnassignedIssue>;
  return x.code === OWNER_UNAVAILABLE && typeof x.userId === 'string' && REASONS.has(String(x.reason)) ? (x as UnassignedIssue) : null;
}
/** batch 6 review F3: the person left the import's creation state and nobody holds them */
function asPerson(i: { code: string } | null | undefined): PersonIssue | null {
  return i && (i.code === PERSON_MERGED || i.code === PERSON_CHANGED) ? (i as PersonIssue) : null;
}
/** What the report's group line says of the people a person issue brought in unassigned. */
const PERSON_CLAUSE: Record<PersonIssue['code'], string> = {
  [PERSON_MERGED]: 'they were merged with another person after the contacts were imported',
  [PERSON_CHANGED]: 'someone changed who holds them after the contacts were imported',
};

/** "Brought in unassigned: Blake Chen's account is suspended." */
export function unassignedSentence(issue: UnassignedIssue, names: MemberNames = NO_NAMES): string {
  return `Brought in unassigned: ${unassignedClause(issue.reason, names.get(issue.userId))}.`;
}

/** The members the issues of these records name (their names are looked up once per page). */
export function namedMembers(records: Iterable<{ issues: readonly { code: string }[] }>): string[] {
  const out = new Set<string>();
  for (const r of records) {
    for (const i of r.issues) {
      const u = asUnassigned(i);
      if (u) out.add(u.userId);
    }
  }
  return [...out];
}

export function issueView(i: { code: string; severity: string; field?: string }, names: MemberNames = NO_NAMES): { code: string; severity: string; field: string | null; sentence: string } {
  const u = asUnassigned(i);
  return { code: i.code, severity: i.severity, field: i.field ?? null, sentence: u ? unassignedSentence(u, names) : (ISSUE_SENTENCES[i.code] ?? GENERIC_ISSUE) };
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/**
 * The verification's documented commit outcomes (owner decision B4, E230; batch 6 review F3), in words; empty when
 * there are none. Said as it was at the commit, which stays true whatever the members' state is when it is read
 * (review B4-R2). `person`: of the `unassigned`, those brought in unassigned because the person left the import's
 * creation state (merged with another person, or changed by someone) rather than because of their member.
 */
export function documentedView(d: DocumentedOutcomes, split: { person?: number } = {}): { code: string; count: number; sentence: string }[] {
  const person = Math.min(split.person ?? 0, d.unassigned);
  const member = d.unassigned - person;
  const kept = d.kept ?? 0;
  const out: { code: string; count: number; sentence: string }[] = [];
  if (member > 0) {
    const one = member === 1;
    out.push({
      code: OWNER_UNAVAILABLE,
      count: member,
      sentence: `${plural(member, 'planned assignment', 'planned assignments')} came in unassigned because the member ${one ? 'it was' : 'they were'} matched to couldn't hold leads ${AT_IMPORT} (each record says why). ${one ? 'It is' : 'They are'} counted as not imported.`,
    });
  }
  if (person > 0) {
    const one = person === 1;
    out.push({
      code: PERSON_CHANGED,
      count: person,
      sentence: `${plural(person, 'planned assignment', 'planned assignments')} came in unassigned because the person was merged with another person, or someone changed who holds them, after the contacts were imported (${one ? 'the record says which' : 'each record says which'}). ${one ? 'It is' : 'They are'} counted as not imported.`,
    });
  }
  if (kept > 0) {
    const one = kept === 1;
    out.push({
      code: 'OWNER_KEPT',
      count: kept,
      sentence: `${plural(kept, 'planned assignment', 'planned assignments')} ${one ? 'was' : 'were'} not made because someone gave the person an owner after the contacts were imported (${one ? 'the record says so' : 'each record says so'}). ${one ? 'It is' : 'They are'} counted as already here.`,
    });
  }
  return out;
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
    blockers: s.blockers.map((i) => issueView(i)),
    approvedAt: iso(s.approved_at),
    approvedByUserId: s.approved_by_user_id,
    committedAt: iso(s.committed_at),
    verifiedAt: iso(s.verified_at),
    verifiedByUserId: s.verified_by_user_id,
    revert: s.revert_report as Record<string, unknown> | null,
  };
}

/**
 * Owner decision B7 (E233): what Follow Up Boss holds that the import never brings over (tasks, appointments),
 * from the latest count (the connection test, the snapshot, or the export file), with the plain sentence. Null for
 * a CSV file. A batch counted before B7 has no counts: said as "could not count", never guessed. A count the latest
 * counting could not read again is the earlier one, named in `keptFrom` and said with when it was taken (review F4).
 */
export function notImportedView(b: BatchRow): {
  tasks: number | null;
  appointments: number | null;
  countedAt: 'connection_test' | 'snapshot' | 'export_file' | null;
  keptFrom?: NonNullable<BatchRow['options']['notImported']>['keptFrom'];
  lines: string[];
} | null {
  if (b.source === 'csv') return null;
  const c = b.options.notImported;
  const counts = { tasks: c?.tasks ?? null, appointments: c?.appointments ?? null };
  const kept = c?.keptFrom && Object.keys(c.keptFrom).length > 0 ? c.keptFrom : undefined;
  return { ...counts, countedAt: c?.countedAt ?? null, ...(kept ? { keptFrom: kept } : {}), lines: notImportedLines({ ...counts, ...(kept ? { kept } : {}) }, sourceName(b)) };
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
    notImported: notImportedView(b),
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

export function recordView(r: RecordRow, names: MemberNames = NO_NAMES) {
  const plan = r.plan as { kind?: string; duplicateCandidates?: { contactId: string; reason: string }[]; staysOptedOut?: Channel[]; mergeIntoContactId?: string } | null;
  return {
    id: r.id,
    sourceRef: r.source_ref,
    outcome: r.outcome,
    dryRunOutcome: r.dry_run_outcome,
    planned: plan?.kind ? (PLAN_WORD[plan.kind] ?? null) : null,
    issues: r.issues.map((i) => issueView(i, names)),
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
  const what = r.removedByTable ? removedWords(r.removedByTable) : `${n(r.removed)} ${r.removed === 1 ? 'row' : 'rows'}`;
  const left = (r.needsDecision ?? 0) === 0 ? 'nothing was left for your decision' : `${n(r.needsDecision)} ${r.needsDecision === 1 ? 'record was' : 'records were'} changed since the import and left for your decision`;
  // names only what was removed: records left for a decision and the import's opt-outs (kept, below) are not
  const lines = [`Undone. The undo removed ${what} that this import added; ${left}.`];
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

/** People an ownership commit brought in unassigned (owner decision B4, E231): who, why, and where each is now. */
export interface UnassignedReport {
  /** records the commit brought in unassigned for a documented reason (OWNER_UNAVAILABLE) */
  total: number;
  /** of those people, how many are still unassigned (live, not merged away, nobody's: no owner, offer or pond) */
  stillUnassigned: number;
  /** the people still unassigned, in record order, at most the bulk Assign cap: "Assign these people" selects exactly these */
  contactIds: string[];
  /** where they are now, in words (the report's last lines): every number a count, "an owner" only of the owned */
  summary: string[];
  /**
   * the first UNASSIGNED_LISTED people, with the reason in words and what is true of them now; `mergedIntoContactId`:
   * a person merged into another contact since lives on that one (review F7: the report links there);
   * `askedAgainSentence`: owner decision D8 (E341), when they asked again and where the routing took them, else null
   */
  people: {
    contactId: string;
    name: string;
    sentence: string;
    stillUnassigned: boolean;
    now: UnassignedNow;
    nowSentence: string | null;
    mergedIntoContactId: string | null;
    askedAgainSentence: string | null;
  }[];
}
export const UNASSIGNED_LISTED = 50;

/** "Nov 12, 2026, 3:04 PM EST": an instant as the team's clock shows it (tenant_settings.default_timezone). */
function teamTime(at: Date, zone: string): string {
  // newer ICU builds put a narrow no-break space before AM/PM: one plain space, the same on every runtime
  const f = (timeZone: string) =>
    new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(at).replace(/[\u202f\u00a0]/g, ' ');
  try {
    return f(zone);
  } catch {
    return f('UTC'); // a zone the runtime does not know: still a true instant, said in UTC
  }
}

/**
 * Owner decision D8 (2026-11-12, E341): one of these people asked again (a portal, a partner feed, a lead email, the
 * generic intake) and was routed like a returning lead. When (the team's time), and where that routing took them, as
 * their own ledger says: the agent it was offered to, or the pond. Null when they have not asked again.
 */
export function askedAgainSentence(r: UnassignedPersonRow, names: MemberNames = NO_NAMES, zone = 'UTC'): string | null {
  if (r.asked_again_at === null) return null;
  const when = `Asked again on ${teamTime(r.asked_again_at, zone)}`;
  switch (r.asked_again_next) {
    case 'offered': {
      const name = r.asked_again_offered_to === null ? '' : (names.get(r.asked_again_offered_to)?.name.trim() ?? '');
      return `${when} and was offered to ${name === '' ? 'an agent' : name}.`;
    }
    case 'sent_to_pond':
      return `${when} and was put in ${r.asked_again_pond?.trim() || 'a pond'}.`;
    case null:
      return `${when} and is waiting to be routed.`;
    default:
      return `${when}.`; // someone acted on them before any routing (the line about now says where they are)
  }
}

/** What is true of one of these people now (review B4-R1): only someone owned "has an owner". */
const NOW_SENTENCE: Record<UnassignedNow, string | null> = {
  unassigned: null,
  owned: 'Has an owner now.',
  offered: 'On offer to an agent now, with no owner yet.',
  in_pond: 'In a pond now, with no owner.',
  closed: 'Closed after the import.',
  deleted: 'Deleted after the import.',
  merged: 'Merged into another contact after the import.',
};

/** What happened to them after the import, in the order the summary names them: [state, one, many]. */
const AFTER_IMPORT: readonly [UnassignedNow, string, string][] = [
  ['owned', 'was given an owner', 'were given an owner'],
  ['in_pond', 'was put in a pond', 'were put in a pond'],
  ['offered', 'was offered to an agent', 'were each offered to an agent'],
  ['closed', 'was closed', 'were closed'],
  ['deleted', 'was deleted', 'were deleted'],
  ['merged', 'was merged into another contact', 'were each merged into another contact'],
];

function andList(parts: readonly string[]): string {
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/** Where the people brought in unassigned are now, in words that stay true (review B4-R1: never "an owner" for someone with none). */
function nowLines(rows: readonly UnassignedPersonRow[]): string[] {
  const n = (s: UnassignedNow) => rows.filter((r) => r.now === s).length;
  if (n('owned') === rows.length) return [rows.length === 1 ? 'That person has an owner now.' : rows.length === 2 ? 'Both of them have an owner now.' : 'All of them have an owner now.'];
  const out: string[] = [];
  const after = AFTER_IMPORT.filter(([s]) => n(s) > 0).map(([s, one, many]) => `${n(s).toLocaleString('en-US')} ${n(s) === 1 ? one : many}`);
  if (after.length > 0) out.push(`After the import, ${andList(after)}.`);
  const still = n('unassigned');
  if (still > 0) out.push(`${plural(still, 'person is', 'people are')} still unassigned: use "${still === 1 ? 'Assign this person' : 'Assign these people'}" to give them an owner.`);
  return out;
}

/** The issue that brought a report row in unassigned, when it is one we can say in words. */
function cameInIssue(r: UnassignedPersonRow): CameInUnassignedIssue | null {
  return asUnassigned(r.issue ?? { code: '' }) ?? asPerson(r.issue);
}

/**
 * The report's listing of the people brought in unassigned, and its plain lines (every number is a count). `zone`: the
 * team's time zone, for when a person asked again (owner decision D8).
 */
export function unassignedReport(rows: readonly UnassignedPersonRow[], names: MemberNames, zone = 'UTC'): { view: UnassignedReport; lines: string[] } | null {
  // one line per person: two records live on one person once a merge joined them (batch 6 review F3)
  const seen = new Set<string>();
  const valid = rows.filter((r) => {
    if (cameInIssue(r) === null || seen.has(r.contact_id)) return false;
    seen.add(r.contact_id);
    return true;
  });
  if (valid.length === 0) return null;
  const still = valid.filter((r) => r.now === 'unassigned');
  const groups = new Map<string, { clause: string; n: number }>();
  for (const r of valid) {
    const issue = cameInIssue(r) as CameInUnassignedIssue;
    const u = asUnassigned(issue);
    const k = u ? `${u.userId}:${u.reason}` : issue.code;
    const g = groups.get(k);
    if (g) g.n += 1;
    else groups.set(k, { clause: u ? unassignedClause(u.reason, names.get(u.userId)) : PERSON_CLAUSE[(issue as PersonIssue).code], n: 1 });
  }
  const lines = [...groups.values()].map((g) => `${plural(g.n, 'person', 'people')} came in unassigned because ${g.clause}.`);
  lines.push('Nothing was assigned to them, and the import started no offer, timer or routing.');
  // owner decision D8 (E341): a new inquiry from one of them routes them like a returning lead; each listed person says
  // when and to whom. Counted once the routing took them somewhere (an offer or a pond), never while it is still due.
  const routed = valid.filter((r) => r.asked_again_at !== null && (r.asked_again_next === 'offered' || r.asked_again_next === 'sent_to_pond')).length;
  if (routed > 0) lines.push(`${routed.toLocaleString('en-US')} of them asked again after the import and ${routed === 1 ? 'was' : 'were'} routed by your routing rules.`);
  const summary = nowLines(valid);
  lines.push(...summary);
  return {
    view: {
      total: valid.length,
      stillUnassigned: still.length,
      contactIds: still.slice(0, BULK_CAPS.assign).map((r) => r.contact_id),
      summary,
      people: valid.slice(0, UNASSIGNED_LISTED).map((r) => {
        const issue = cameInIssue(r) as CameInUnassignedIssue;
        const u = asUnassigned(issue);
        return {
          contactId: r.contact_id,
          name: r.display_name ?? 'Unnamed person',
          sentence: u ? unassignedSentence(u, names) : (ISSUE_SENTENCES[issue.code] ?? GENERIC_ISSUE),
          stillUnassigned: r.now === 'unassigned',
          now: r.now,
          nowSentence: NOW_SENTENCE[r.now] ?? null,
          mergedIntoContactId: r.now === 'merged' ? r.merged_into_contact_id : null,
          askedAgainSentence: askedAgainSentence(r, names, zone),
        };
      }),
    },
    lines,
  };
}

/** GET /imports/:id/report: per category source | imported | needs review | rejected | duplicate, plus plain lines. */
export function reportView(b: BatchRow, stages: readonly StageRow[], extra: { unassigned?: readonly UnassignedPersonRow[]; names?: MemberNames; zone?: string } = {}) {
  const name = sourceName(b);
  // owner decision B4 (E231): the ownership stage's report lists the people it brought in unassigned while it stands
  const ownership = stages.find((s) => s.category === 'ownership');
  const unassigned = ownership && ['committed', 'verified'].includes(ownership.status) ? unassignedReport(extra.unassigned ?? [], extra.names ?? NO_NAMES, extra.zone) : null;
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
  const left = notImportedView(b);
  return {
    source: name,
    parity: parityReportView(b, stages),
    // owner decision B7 (E233): the final report says what does not come over
    notImported: left ? { tasks: left.tasks, appointments: left.appointments, lines: left.lines } : null,
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
        lines: [
          ...(r.phase === 'reverted' ? revertLines(r.stage) : reportLines(t.category, r.phase, r.counts, name, (r.stage.consent_summary as ConsentSummary | null) ?? null)),
          // why they came in unassigned; where they are now (`summary`) is said once, by the people card next to the
          // "Assign these people" it names (review F8)
          ...(t.category === 'ownership' && unassigned ? unassigned.lines.slice(0, unassigned.lines.length - unassigned.view.summary.length) : []),
        ],
        unassigned: t.category === 'ownership' && unassigned ? unassigned.view : null,
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
