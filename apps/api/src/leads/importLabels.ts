// b18 round 3 item 1 and the owner decision of 2026-11-14 (R-LSRC-8, R-LSRC-9, R-LSRC-10; E728 to E746): imported source
// labels, the lead sources they mean, and the source review list.
//
// A Follow Up Boss or CSV import keeps a person's source only as a label (imports/commit.ts stores it as
// contacts.original_source_detail.import_source; every import record keeps normalized.leadSourceLabel). The label is
// kept EXACTLY as imported (core sourceLabel: never trimmed, re-cased or cut) and compared whole (0101). The Owner maps
// a label to one lead source (lead_sources.import_labels; Owner only in the API and the database), from the import's
// own review or afterwards from the lead sources page. People an import brought in with NO label are that import's
// no-label group, which the Owner classifies the same way, as one row (lead_sources.import_unlabeled_batches). Until the
// Owner does, a committed imported person is "in review" (unclassified): nothing automatic goes to them
// (leads/automatedContact.ts SOURCE_UNCLASSIFIED).
//
// The review list (R-LSRC-10) is one row per label per team and one per import's no-label group. Each row says:
//   state      mapped (to a named lead source) | suggested (an exact known match, with the suggested source: never
//              applied until the Owner confirms) | ambiguous (two lead sources match or hold it) | in_review
//   people     how many people carry it (the CRM-wide list: people an import COMMITTED with it; an import's own review:
//              the people of that import), and committedPeople
//   firstSeen  the import that first committed a person with it, that import's kind, and when (import_source_labels, 0102)
//   changedBy / changedAt  who last mapped, re-mapped or un-mapped it, and when
// The only suggestion logic is core suggestLeadSource (an exact lead-source name or Owner-confirmed label, apart from
// capital letters and surrounding spaces). Nothing here infers that one label means another.
//
//   GET  /lead-sources/import-labels          settings.routing        the CRM-wide review list
//   PUT  /lead-sources/import-labels          lead_source.ai_care 🔒   { label | unlabeledImportId, leadSourceId | null }:
//                                                                      map, re-map or un-map
//   POST /lead-sources/import-labels/confirm  lead_source.ai_care 🔒   { label, leadSourceId }: confirm the suggestion shown
//   GET  /imports/:id/parity, /report         import.run 🔒            the same rows for one import (preview and summary)
// The reads and words live here (imports/parity.ts and imports/routes.ts use them; no assistant import, so no load cycle
// through imports/commit.ts); the Owner's write and the stop it starts are in leads/sources.ts.
import { SOURCE_LABEL_MAX, suggestLeadSource } from '@realty/core/import';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { NO_AUTOMATED_CONTACT_LABEL } from './automatedContact.js';

/**
 * The longest label an import keeps (core SOURCE_LABEL_MAX: the CSV parser's own cell bound), and so the longest one
 * that can be mapped: no imported label is ever too long for the Owner to map. A label is never cut.
 */
export const IMPORT_LABEL_MAX = SOURCE_LABEL_MAX;

/**
 * A source label exactly as the import stores it on the person it creates (imports/commit.ts originalSourceDetail) and
 * as every list here keys it: the string itself, or null when there is no label (nothing, or only whitespace: the same
 * rule as core sourceLabel, which every imported label has already been through).
 */
export function importLabelOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw;
}

/** The kind of an import (import_batches.source). */
export type ImportKind = 'csv' | 'fub_api' | 'fub_export';
export type ImportLabelState = 'mapped' | 'suggested' | 'ambiguous' | 'in_review';

export interface ImportLabelRow {
  /** the review row (import_source_labels.id), or null for a label so far seen only in an import's preview */
  id: string | null;
  /** the label exactly as imported; '' on the row of an import's no-label group (`unlabeledImportId` is then set) */
  label: string;
  /** the import whose people with no source label this row is, or null on a label's row */
  unlabeledImportId: string | null;
  /** the people who carry it: in the CRM-wide list, people an import committed with it; in one import's rows, that import's people */
  people: number;
  /** of those, the people an import has COMMITTED with it (imported or merged): the ones in review while it is unmapped */
  committedPeople: number;
  state: ImportLabelState;
  leadSourceId: string | null;
  leadSourceName: string | null;
  /** the label is mapped to a source marked "No automated contact for leads from this source" */
  noAutomatedContact: boolean;
  /**
   * R-LSRC-9: no lead source, or more than one, holds it (state is not `mapped`), so the people an import committed
   * with it are unclassified: nothing automatic goes to them until the Owner maps it (SOURCE_UNCLASSIFIED).
   */
  inReview: boolean;
  /** state `suggested` only: the lead source core suggestLeadSource names. Never applied until the Owner confirms it. */
  suggestion: { leadSourceId: string; leadSourceName: string; noAutomatedContact: boolean } | null;
  /** the import that first committed a person with it; null while none has */
  firstSeen: { importId: string; kind: ImportKind; at: string } | null;
  /** who last mapped, re-mapped or un-mapped it (null: never through this list, or the record no longer matches the mapping) */
  changedBy: { userId: string; name: string } | null;
  changedAt: string | null;
  sentence: string;
}

interface Mapped {
  id: string;
  name: string;
  noAutomatedContact: boolean;
  /** more than one lead source holds the label: nobody may guess which one it means */
  ambiguous?: boolean;
}

const peopleWords = (people: number): string => (people === 1 ? '1 person' : `${people} people`);
/** What "in review" means, in the Owner's words, at the end of an unmapped or ambiguous row. */
const IN_REVIEW = 'Nothing automatic goes to the people imported with it until the Owner maps it to a lead source.';
const KIND_WORDS: Record<ImportKind, string> = { csv: 'file import', fub_api: 'Follow Up Boss import', fub_export: 'Follow Up Boss import' };

/** What a row's sentence is built from, besides its people. */
type Reading =
  | { state: 'mapped'; m: Mapped }
  | { state: 'suggested'; suggested: { name: string; noAutomatedContact: boolean } }
  | { state: 'ambiguous'; held: boolean }
  | { state: 'in_review' };

/** The plain sentence of one label: who it labels, which source it means, and whether that source is marked. */
export function importLabelSentence(label: string, people: number, r: Reading): string {
  const who = `"${label}" (${peopleWords(people)})`;
  switch (r.state) {
    case 'mapped':
      return r.m.noAutomatedContact ? `${who}: mapped to ${r.m.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.` : `${who}: mapped to ${r.m.name}.`;
    case 'suggested':
      return `${who}: not reviewed yet. It reads the same as the lead source ${r.suggested.name}, or a label already mapped to it, apart from capital letters and spaces around it, so ${r.suggested.name} is suggested. Nothing is mapped until the Owner confirms it${
        r.suggested.noAutomatedContact ? ` (${r.suggested.name} has "${NO_AUTOMATED_CONTACT_LABEL}" on)` : ''
      }, and nothing automatic goes to the people imported with it until then.`;
    case 'ambiguous':
      return r.held
        ? `${who}: more than one lead source holds this label, so it is not reviewed yet. ${IN_REVIEW}`
        : `${who}: not reviewed yet. It reads the same as more than one lead source, so none is suggested. ${IN_REVIEW}`;
    case 'in_review':
      return `${who}: not reviewed yet. ${IN_REVIEW}`;
  }
}

/**
 * The sentence of one import's no-label group. `kind` (the CRM-wide list) names which sort of import it was; an
 * import's own review says "in this import".
 */
export function unlabeledSentence(people: number, r: Reading, kind: ImportKind | null = null): string {
  const who = `${kind ? `No source label in one ${KIND_WORDS[kind]}` : 'No source label in this import'} (${peopleWords(people)})`;
  if (r.state !== 'mapped') {
    return r.state === 'ambiguous'
      ? `${who}: more than one lead source holds these people, so they are not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.`
      : `${who}: not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.`;
  }
  if (r.m.noAutomatedContact) return `${who}: counted as ${r.m.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`;
  return `${who}: counted as ${r.m.name}.`;
}

// ---- what the rows are built from ----

interface SourceFacts {
  id: string;
  name: string;
  marked: boolean;
  labels: string[];
  batches: string[];
}

/** The team's lead sources and what each holds (the caller reads lead_sources: Owner/Admin or system). */
export interface SourceCatalog {
  sources: SourceFacts[];
  byLabel: Map<string, Mapped>;
  byBatch: Map<string, Mapped>;
}

function mappingsOf(rows: readonly { key: string; id: string; name: string; marked: boolean }[]): Map<string, Mapped> {
  const out = new Map<string, Mapped>();
  for (const x of rows) {
    const prev = out.get(x.key);
    // one label lives on one source (setImportSource moves it). Were two to hold it, it is ambiguous: its people are
    // unclassified unless one of the two is marked, in which case the marked one's setting covers them (0101), and
    // that is the one shown
    if (!prev) out.set(x.key, { id: x.id, name: x.name, noAutomatedContact: x.marked });
    else if (prev.noAutomatedContact || x.marked) out.set(x.key, { ...(x.marked && !prev.noAutomatedContact ? { id: x.id, name: x.name } : { id: prev.id, name: prev.name }), noAutomatedContact: true });
    else out.set(x.key, { ...prev, ambiguous: true });
  }
  return out;
}

export async function sourceCatalog(tx: Tx): Promise<SourceCatalog> {
  const r = await sql<{ id: string; name: string; no_ai_care: boolean; import_labels: string[]; batches: string[] }>`
    SELECT s.id, s.name, s.no_ai_care, s.import_labels, s.import_unlabeled_batches::text[] AS batches FROM lead_sources s
     WHERE s.tenant_id = app.tenant_id() ORDER BY s.created_at, s.id`.execute(tx);
  const sources = r.rows.map((s) => ({ id: s.id, name: s.name, marked: s.no_ai_care, labels: s.import_labels, batches: s.batches }));
  return {
    sources,
    byLabel: mappingsOf(sources.flatMap((s) => s.labels.map((key) => ({ key, id: s.id, name: s.name, marked: s.marked })))),
    byBatch: mappingsOf(sources.flatMap((s) => s.batches.map((key) => ({ key, id: s.id, name: s.name, marked: s.marked })))),
  };
}

/** One row of import_source_labels (0102), as the list needs it. */
interface Provenance {
  id: string;
  label: string | null;
  unlabeledImportId: string | null;
  firstSeen: ImportLabelRow['firstSeen'];
  leadSourceId: string | null;
  changedBy: ImportLabelRow['changedBy'];
  changedAt: string | null;
}
interface ProvenanceMaps {
  byLabel: Map<string, Provenance>;
  byBatch: Map<string, Provenance>;
}

/**
 * The review records (import_source_labels) of the team, or of one label or one import's no-label group. The table
 * holds one row per label, so reading all of them is in proportion to the labels, never to the people.
 */
async function provenance(tx: Tx, only?: { label: string } | { unlabeledImportId: string }): Promise<ProvenanceMaps> {
  const where = !only
    ? sql`true`
    : 'label' in only
      ? sql`l.import_label IS NOT NULL AND digest(l.import_label, 'sha256') = digest(${only.label}::text, 'sha256') AND l.import_label = ${only.label}::text`
      : sql`l.unlabeled_batch_id = ${only.unlabeledImportId}::uuid`;
  const r = await sql<{ id: string; import_label: string | null; unlabeled_batch_id: string | null; first_seen_batch_id: string | null; first_seen_kind: ImportKind | null; first_seen_at: Date | null; lead_source_id: string | null; mapped_by_user_id: string | null; mapped_at: Date | null; mapped_by_name: string | null }>`
    SELECT l.id, l.import_label, l.unlabeled_batch_id, l.first_seen_batch_id, l.first_seen_kind, l.first_seen_at, l.lead_source_id, l.mapped_by_user_id, l.mapped_at,
           (SELECT u.display_name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = l.tenant_id AND m.user_id = l.mapped_by_user_id) AS mapped_by_name
      FROM import_source_labels l WHERE l.tenant_id = app.tenant_id() AND ${where}`.execute(tx);
  const out: ProvenanceMaps = { byLabel: new Map(), byBatch: new Map() };
  for (const x of r.rows) {
    const p: Provenance = {
      id: x.id,
      label: x.import_label,
      unlabeledImportId: x.unlabeled_batch_id,
      firstSeen: x.first_seen_batch_id && x.first_seen_kind && x.first_seen_at ? { importId: x.first_seen_batch_id, kind: x.first_seen_kind, at: x.first_seen_at.toISOString() } : null,
      leadSourceId: x.lead_source_id,
      changedBy: x.mapped_by_user_id ? { userId: x.mapped_by_user_id, name: x.mapped_by_name ?? 'A former member' } : null,
      changedAt: x.mapped_at ? x.mapped_at.toISOString() : null,
    };
    if (p.label !== null) out.byLabel.set(p.label, p);
    else if (p.unlabeledImportId !== null) out.byBatch.set(p.unlabeledImportId, p);
  }
  return out;
}

interface Counts {
  people: number;
  committedPeople: number;
}

/**
 * One label's row. The state is read from the mapping every check reads (the catalog); the suggestion, only for a label
 * no source holds, comes from core suggestLeadSource and nothing else; who and when are shown only while the record
 * still agrees with that mapping.
 */
function labelRow(label: string, n: Counts, cat: SourceCatalog, prov: Provenance | null): ImportLabelRow {
  const m = cat.byLabel.get(label) ?? null;
  const held = m !== null && m.ambiguous !== true;
  let reading: Reading;
  let suggestion: ImportLabelRow['suggestion'] = null;
  if (held) reading = { state: 'mapped', m };
  else if (m) reading = { state: 'ambiguous', held: true };
  else {
    const s = suggestLeadSource(label, cat.sources.map((x) => ({ id: x.id, name: x.name, ownerConfirmedLabels: x.labels })));
    const src = s.status === 'suggestion' ? cat.sources.find((x) => x.id === s.leadSourceId) : undefined;
    if (src) {
      suggestion = { leadSourceId: src.id, leadSourceName: src.name, noAutomatedContact: src.marked };
      reading = { state: 'suggested', suggested: { name: src.name, noAutomatedContact: src.marked } };
    } else reading = s.status === 'ambiguous' ? { state: 'ambiguous', held: false } : { state: 'in_review' };
  }
  return { ...common(n, held ? m : null, m?.noAutomatedContact ?? false, reading.state, prov), label, unlabeledImportId: null, suggestion, sentence: importLabelSentence(label, n.people, reading) };
}

/** The row of one import's no-label group. Nothing is ever suggested for it: there is no label to match. */
function groupRow(importId: string, n: Counts, cat: SourceCatalog, prov: Provenance | null, kind: ImportKind | null): ImportLabelRow {
  const m = cat.byBatch.get(importId) ?? null;
  const held = m !== null && m.ambiguous !== true;
  const reading: Reading = held ? { state: 'mapped', m } : m ? { state: 'ambiguous', held: true } : { state: 'in_review' };
  return { ...common(n, held ? m : null, m?.noAutomatedContact ?? false, reading.state, prov), label: '', unlabeledImportId: importId, suggestion: null, sentence: unlabeledSentence(n.people, reading, kind) };
}

function common(n: Counts, held: Mapped | null, marked: boolean, state: ImportLabelState, prov: Provenance | null) {
  // who and when are the record of the Owner's last act; they are shown only while that record is still the mapping
  const agrees = prov !== null && prov.changedAt !== null && prov.leadSourceId === (held?.id ?? null);
  return {
    id: prov?.id ?? null,
    people: n.people,
    committedPeople: n.committedPeople,
    state,
    leadSourceId: held?.id ?? null,
    leadSourceName: held?.name ?? null,
    noAutomatedContact: marked,
    inReview: state !== 'mapped',
    firstSeen: prov?.firstSeen ?? null,
    changedBy: agrees ? prov.changedBy : null,
    changedAt: agrees ? prov.changedAt : null,
  };
}

const byLabel = (a: ImportLabelRow, b: ImportLabelRow): number => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

// ---- the lists ----

/**
 * The CRM-wide review list (GET /lead-sources/import-labels): one row per label and one per import's no-label group,
 * built from COMMITTED import outcomes. A row exists for every label a committed contacts record carries (counted from
 * the records themselves, so the count cannot go stale), for every review record (0102) and for every mapped label
 * even when nobody carries it yet (so it can be un-mapped). A dry run, a rejected, skipped or duplicate record and an
 * abandoned import add nothing. Labels first, by label; then the no-label groups, newest first.
 *
 * Cost: one pass over the team's committed contacts import records (through import_records_target_contact) for the
 * counts, and the review records, in proportion to the labels. The Owner's mapping itself never does this (labelRowOf).
 */
export async function tenantLabels(tx: Tx): Promise<ImportLabelRow[]> {
  const r = await sql<{ label: string | null; batch_id: string | null; people: string }>`
    SELECT CASE WHEN btrim(coalesce(r.normalized ->> 'leadSourceLabel', '')) <> '' THEN r.normalized ->> 'leadSourceLabel' END AS label,
           CASE WHEN btrim(coalesce(r.normalized ->> 'leadSourceLabel', '')) = '' THEN st.batch_id::text END AS batch_id,
           count(DISTINCT r.target_id) AS people
      FROM import_records r JOIN import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
     WHERE r.tenant_id = app.tenant_id() AND r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND r.normalized ->> 'category' = 'contacts'
     GROUP BY 1, 2`.execute(tx);
  const cat = await sourceCatalog(tx);
  const prov = await provenance(tx);
  const labels = new Map<string, number>();
  const groups = new Map<string, number>();
  for (const x of r.rows) {
    if (x.label !== null) labels.set(x.label, Number(x.people));
    else if (x.batch_id !== null) groups.set(x.batch_id, Number(x.people));
  }
  for (const l of [...prov.byLabel.keys(), ...cat.byLabel.keys()]) if (!labels.has(l)) labels.set(l, 0);
  for (const b of [...prov.byBatch.keys(), ...cat.byBatch.keys()]) if (!groups.has(b)) groups.set(b, 0);
  const kinds = await importKinds(tx, [...groups.keys()]);
  const labelRows = [...labels.entries()].map(([label, people]) => labelRow(label, { people, committedPeople: people }, cat, prov.byLabel.get(label) ?? null)).sort(byLabel);
  const groupRows = [...groups.entries()]
    .map(([id, people]) => ({ row: groupRow(id, { people, committedPeople: people }, cat, prov.byBatch.get(id) ?? null, kinds.get(id)?.kind ?? null), at: kinds.get(id)?.at ?? '' }))
    .sort((a, b) => (a.at > b.at ? -1 : a.at < b.at ? 1 : a.row.unlabeledImportId! < b.row.unlabeledImportId! ? -1 : 1))
    .map((x) => x.row);
  return [...labelRows, ...groupRows];
}

async function importKinds(tx: Tx, ids: readonly string[]): Promise<Map<string, { kind: ImportKind; at: string }>> {
  if (ids.length === 0) return new Map();
  const r = await sql<{ id: string; source: ImportKind; created_at: Date }>`SELECT id, source, created_at FROM import_batches WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
  return new Map(r.rows.map((x) => [x.id, { kind: x.source, at: x.created_at.toISOString() }]));
}

/**
 * One import's review rows (the preview, GET /imports/:id/parity, and the summary, GET /imports/:id/report): the same
 * rows, states and counts as the CRM-wide list, for the labels this import carries and its own no-label group.
 * `inImport` is how many people of this import carry each label (null: no label); `people` on a row is that number,
 * and `committedPeople` how many of them this import has committed so far. Reads the import's own records and the
 * review records; it writes nothing (a preview has no side effects).
 */
export async function importLabelRows(tx: Tx, importId: string, inImport: ReadonlyMap<string | null, number>): Promise<ImportLabelRow[]> {
  const committed = await sql<{ label: string | null; people: string }>`
    SELECT CASE WHEN btrim(coalesce(r.normalized ->> 'leadSourceLabel', '')) <> '' THEN r.normalized ->> 'leadSourceLabel' END AS label, count(DISTINCT r.target_id) AS people
      FROM import_stages st JOIN import_records r ON r.tenant_id = st.tenant_id AND r.stage_id = st.id
     WHERE st.tenant_id = app.tenant_id() AND st.batch_id = ${importId}::uuid AND st.category = 'contacts'
       AND r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND r.normalized ->> 'category' = 'contacts'
     GROUP BY 1`.execute(tx);
  const done = new Map<string | null, number>(committed.rows.map((x) => [x.label, Number(x.people)]));
  const cat = await sourceCatalog(tx);
  const prov = await provenance(tx);
  const rows: ImportLabelRow[] = [];
  for (const [label, people] of inImport) {
    if (label !== null) rows.push(labelRow(label, { people, committedPeople: done.get(label) ?? 0 }, cat, prov.byLabel.get(label) ?? null));
  }
  rows.sort(byLabel);
  const unlabeled = inImport.get(null) ?? 0;
  if (unlabeled > 0 || (done.get(null) ?? 0) > 0) rows.push(groupRow(importId, { people: unlabeled, committedPeople: done.get(null) ?? 0 }, cat, prov.byBatch.get(importId) ?? null, null));
  return rows;
}

/** Tallies the people of one import by label, exactly as imported; no label counts under `null`. */
export function tallyLabels(raw: readonly (string | null | undefined)[]): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const r of raw) {
    const l = importLabelOf(r);
    out.set(l, (out.get(l) ?? 0) + 1);
  }
  return out;
}

/** The import summary's rows: the import's contacts records, counted by label (Owner/Admin read import_records). */
export async function stageLabels(tx: Tx, importId: string, stageId: string): Promise<ImportLabelRow[]> {
  const r = await sql<{ label: string | null }>`
    SELECT normalized ->> 'leadSourceLabel' AS label FROM import_records
     WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId}::uuid AND normalized ->> 'category' = 'contacts'`.execute(tx);
  return importLabelRows(tx, importId, tallyLabels(r.rows.map((x) => x.label)));
}

/**
 * One label's row, for the Owner's mapping answer (leads/sources.ts setImportSource): the same row as the CRM-wide list
 * gives it, read through app.import_source_people and import_records_contact_label (0101) and the label's own review
 * record, so a mapping change never reads the team's whole import history to answer.
 */
export async function labelRowOf(tx: Tx, label: string): Promise<ImportLabelRow> {
  // app.import_source_people (0101): the people the label's records targeted or matched, each once, through the index;
  // the committed ones are the people this row counts
  const r = await sql<{ people: string }>`SELECT count(*) FILTER (WHERE p.committed) AS people FROM app.import_source_people(app.tenant_id(), ${label}::text, NULL::uuid) p`.execute(tx);
  const people = Number(r.rows[0]?.people ?? 0);
  return labelRow(label, { people, committedPeople: people }, await sourceCatalog(tx), (await provenance(tx, { label })).byLabel.get(label) ?? null);
}

/** One import's no-label group, the same way (the people that import committed with no source label). */
export async function unlabeledRowOf(tx: Tx, importId: string): Promise<ImportLabelRow> {
  const r = await sql<{ people: string }>`SELECT count(*) FILTER (WHERE p.committed) AS people FROM app.import_source_people(app.tenant_id(), NULL::text, ${importId}::uuid) p`.execute(tx);
  const people = Number(r.rows[0]?.people ?? 0);
  const kind = (await importKinds(tx, [importId])).get(importId)?.kind ?? null;
  return groupRow(importId, { people, committedPeople: people }, await sourceCatalog(tx), (await provenance(tx, { unlabeledImportId: importId })).byBatch.get(importId) ?? null, kind);
}

// ---- the review records (0102) ----

/**
 * The Owner's mapping, recorded on the label's (or the no-label group's) review record: the source it now means (null:
 * removed), who did it and when. Runs as the Owner (the database lets nobody else write these columns, and only in
 * their own name). Returns the record's id for the audit row.
 */
export async function recordMapping(tx: Tx, key: { label: string } | { unlabeledImportId: string }, leadSourceId: string | null, byUserId: string, atIso: string): Promise<string> {
  const r = 'label' in key
    ? await sql<{ id: string }>`
        INSERT INTO import_source_labels (tenant_id, import_label, lead_source_id, mapped_by_user_id, mapped_at)
        VALUES (app.tenant_id(), ${key.label}::text, ${leadSourceId}::uuid, ${byUserId}::uuid, ${atIso}::timestamptz)
        ON CONFLICT (tenant_id, digest(import_label, 'sha256')) WHERE import_label IS NOT NULL
        DO UPDATE SET lead_source_id = EXCLUDED.lead_source_id, mapped_by_user_id = EXCLUDED.mapped_by_user_id, mapped_at = EXCLUDED.mapped_at, updated_at = now()
        RETURNING id`.execute(tx)
    : await sql<{ id: string }>`
        INSERT INTO import_source_labels (tenant_id, unlabeled_batch_id, lead_source_id, mapped_by_user_id, mapped_at)
        VALUES (app.tenant_id(), ${key.unlabeledImportId}::uuid, ${leadSourceId}::uuid, ${byUserId}::uuid, ${atIso}::timestamptz)
        ON CONFLICT (tenant_id, unlabeled_batch_id) WHERE unlabeled_batch_id IS NOT NULL
        DO UPDATE SET lead_source_id = EXCLUDED.lead_source_id, mapped_by_user_id = EXCLUDED.mapped_by_user_id, mapped_at = EXCLUDED.mapped_at, updated_at = now()
        RETURNING id`.execute(tx);
  return r.rows[0]!.id;
}

/**
 * The contacts commit's provenance (imports/commit.ts, the system actor, in the chunk's own transaction): every label
 * the chunk COMMITTED a person with, and its no-label group when it committed a person with none, gets its review
 * record with this import as where it was first seen; a record that exists keeps its first-seen (a label the Owner
 * mapped ahead of any commit gets it now). One statement for the labels, sorted, so two imports that commit the same
 * new labels at once take them in one order. Never called by a dry run.
 */
export async function recordCommitted(tx: Tx, o: { importId: string; kind: ImportKind; labels: readonly string[]; unlabeled: boolean; atIso: string }): Promise<void> {
  const labels = [...new Set(o.labels)].sort();
  if (labels.length > 0) {
    await sql`
      INSERT INTO import_source_labels (tenant_id, import_label, first_seen_batch_id, first_seen_kind, first_seen_at)
      SELECT app.tenant_id(), l, ${o.importId}::uuid, ${o.kind}::text, ${o.atIso}::timestamptz FROM unnest(${labels}::text[]) AS l ORDER BY l
      ON CONFLICT (tenant_id, digest(import_label, 'sha256')) WHERE import_label IS NOT NULL
      DO UPDATE SET first_seen_batch_id = EXCLUDED.first_seen_batch_id, first_seen_kind = EXCLUDED.first_seen_kind, first_seen_at = EXCLUDED.first_seen_at, updated_at = now()
        WHERE import_source_labels.first_seen_batch_id IS NULL`.execute(tx);
  }
  if (o.unlabeled) {
    await sql`
      INSERT INTO import_source_labels (tenant_id, unlabeled_batch_id, first_seen_batch_id, first_seen_kind, first_seen_at)
      VALUES (app.tenant_id(), ${o.importId}::uuid, ${o.importId}::uuid, ${o.kind}::text, ${o.atIso}::timestamptz)
      ON CONFLICT (tenant_id, unlabeled_batch_id) WHERE unlabeled_batch_id IS NOT NULL
      DO UPDATE SET first_seen_batch_id = EXCLUDED.first_seen_batch_id, first_seen_kind = EXCLUDED.first_seen_kind, first_seen_at = EXCLUDED.first_seen_at, updated_at = now()
        WHERE import_source_labels.first_seen_batch_id IS NULL`.execute(tx);
  }
}
