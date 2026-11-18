// b18 round 3 item 1 (owner boundary B18S-5; R-LSRC-8, E728): imported source labels and the lead sources they mean.
//
// A Follow Up Boss or CSV import keeps a person's source only as a label (imports/commit.ts stores it as
// contacts.original_source_detail.import_source; every import record keeps normalized.leadSourceLabel).
// The Owner maps a label, exactly as the import stored it and compared WHOLE (0101), to one lead source
// (lead_sources.import_labels, 0099; Owner only in the API and the database), at import time from the import's preview
// or afterwards from the lead sources page. People an import brought in with NO label are that import's no-label group,
// which the Owner classifies the same way, per import (lead_sources.import_unlabeled_batches, 0101). Until the Owner
// does, a committed imported person is "in review" (unclassified): nothing automatic goes to them
// (leads/automatedContact.ts SOURCE_UNCLASSIFIED; R-LSRC-9, owner decision 2026-11-14). app.person_from_lead_source then counts the people it labels as sent by that source, so a source
// marked "No automated contact for leads from this source" covers them like any lead it sent. The import preview
// (GET /imports/:id/parity) and summary (GET /imports/:id/report) list the labels found, each with its source and
// whether that source is marked; GET /lead-sources/import-labels lists every label in the CRM.
//
//   GET /lead-sources/import-labels   settings.routing        every imported label with its people, source and mark
//   PUT /lead-sources/import-labels   lead_source.ai_care 🔒   { label, leadSourceId | null }: map, move or unmap a label;
//                                                              { unlabeledImportId, leadSourceId | null }: the same for the
//                                                              people one import brought in with no source label
// The reads and words live here (imports/parity.ts and imports/routes.ts use them; no assistant import, so no load cycle
// through imports/commit.ts); the Owner's write and the stop it starts are in leads/sources.ts.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { NO_AUTOMATED_CONTACT_LABEL } from './automatedContact.js';

/**
 * The longest label an import stores (core lineField cuts a source label at 500 UTF-16 units), and so the longest one
 * that can be mapped. A label is never cut here: it is compared whole (0101), so two long labels that share a beginning
 * are two labels.
 */
export const IMPORT_LABEL_MAX = 500;

/** A source label exactly as the import stores it on the person it creates (imports/commit.ts originalSourceDetail). */
export function importLabelOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw;
}

export interface ImportLabelRow {
  /** the label exactly as imported; '' on the row of an import's no-label group (`unlabeledImportId` is then set) */
  label: string;
  people: number;
  leadSourceId: string | null;
  leadSourceName: string | null;
  /** the label is mapped to a source marked "No automated contact for leads from this source" */
  noAutomatedContact: boolean;
  /**
   * R-LSRC-9: no lead source, or more than one, holds the label, so the people an import committed with it are
   * unclassified: nothing automatic goes to them until the Owner maps it (SOURCE_UNCLASSIFIED).
   */
  inReview: boolean;
  /** the import whose people with no source label this row is, or null on a label's row */
  unlabeledImportId: string | null;
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

/** The plain sentence of one label: who it labels, which source it means, and whether that source is marked. */
export function importLabelSentence(label: string, people: number, m: Mapped | null): string {
  const who = `"${label}" (${peopleWords(people)})`;
  if (!m) return `${who}: not reviewed yet. ${IN_REVIEW}`;
  if (m.ambiguous) return `${who}: more than one lead source holds this label, so it is not reviewed yet. ${IN_REVIEW}`;
  if (m.noAutomatedContact) return `${who}: mapped to ${m.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`;
  return `${who}: mapped to ${m.name}.`;
}

/** The sentence of one import's no-label group. */
export function unlabeledSentence(people: number, m: Mapped | null): string {
  const who = `No source label in this import (${peopleWords(people)})`;
  if (!m || m.ambiguous) return `${who}: not reviewed yet. Nothing automatic goes to the people imported without a label until the Owner chooses their lead source.`;
  if (m.noAutomatedContact) return `${who}: counted as ${m.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`;
  return `${who}: counted as ${m.name}.`;
}

/** Every mapped label of the tenant and the source it means (the caller reads lead_sources: Owner/Admin or system). */
export async function labelMappings(tx: Tx): Promise<Map<string, Mapped>> {
  const r = await sql<{ label: string; id: string; name: string; no_ai_care: boolean }>`
    SELECT l.label, s.id, s.name, s.no_ai_care FROM lead_sources s CROSS JOIN LATERAL unnest(s.import_labels) AS l(label)
     WHERE s.tenant_id = app.tenant_id() ORDER BY s.created_at, s.id`.execute(tx);
  return mappingsOf(r.rows.map((x) => ({ key: x.label, id: x.id, name: x.name, marked: x.no_ai_care })));
}

/** Every import whose no-label group is classified, and the source it counts as. */
export async function unlabeledMappings(tx: Tx): Promise<Map<string, Mapped>> {
  const r = await sql<{ batch_id: string; id: string; name: string; no_ai_care: boolean }>`
    SELECT b.batch_id::text AS batch_id, s.id, s.name, s.no_ai_care FROM lead_sources s CROSS JOIN LATERAL unnest(s.import_unlabeled_batches) AS b(batch_id)
     WHERE s.tenant_id = app.tenant_id() ORDER BY s.created_at, s.id`.execute(tx);
  return mappingsOf(r.rows.map((x) => ({ key: x.batch_id, id: x.id, name: x.name, marked: x.no_ai_care })));
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

/** Rows for labels and their people counts, sorted by label, each with its mapping and sentence. */
export function labelRows(counts: ReadonlyMap<string, number>, mapped: ReadonlyMap<string, Mapped>): ImportLabelRow[] {
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, people]) => {
      const m = mapped.get(label) ?? null;
      const held = m !== null && m.ambiguous !== true;
      return { label, people, leadSourceId: held ? m.id : null, leadSourceName: held ? m.name : null, noAutomatedContact: m?.noAutomatedContact ?? false, inReview: !held, unlabeledImportId: null, sentence: importLabelSentence(label, people, m) };
    });
}

/** The row of one import's no-label group. */
export function unlabeledRow(importId: string, people: number, m: Mapped | null): ImportLabelRow {
  const held = m !== null && m.ambiguous !== true;
  return { label: '', people, leadSourceId: held ? m.id : null, leadSourceName: held ? m.name : null, noAutomatedContact: m?.noAutomatedContact ?? false, inReview: !held, unlabeledImportId: importId, sentence: unlabeledSentence(people, m) };
}

/** Tallies labels (as the import stores them) over a list of raw source labels; a missing label is not counted. */
export function tallyLabels(raw: readonly (string | null | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of raw) {
    const l = importLabelOf(r);
    if (l !== null) out.set(l, (out.get(l) ?? 0) + 1);
  }
  return out;
}

/** The import summary's labels: one contacts stage's records, counted by label (Owner/Admin read import_records). */
export async function stageLabels(tx: Tx, stageId: string): Promise<ImportLabelRow[]> {
  const r = await sql<{ label: string | null }>`
    SELECT normalized ->> 'leadSourceLabel' AS label FROM import_records
     WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId}::uuid AND normalized ->> 'category' = 'contacts'`.execute(tx);
  return labelRows(tallyLabels(r.rows.map((x) => x.label)), await labelMappings(tx));
}

/**
 * Every imported label in the CRM: the people the imports created or matched with it (any import record that targeted
 * or matched a contact, as app.person_from_lead_source reads them), and every mapped label even when nobody carries it.
 * The label is the whole stored label (0101).
 */
export async function tenantLabels(tx: Tx): Promise<ImportLabelRow[]> {
  const r = await sql<{ label: string; people: string }>`
    SELECT r.normalized ->> 'leadSourceLabel' AS label, count(DISTINCT x.id) AS people
      FROM import_records r CROSS JOIN LATERAL (VALUES (CASE WHEN r.target_table = 'contacts' THEN r.target_id END), (r.match_contact_id)) AS x(id)
     WHERE r.tenant_id = app.tenant_id() AND x.id IS NOT NULL AND r.normalized ->> 'category' = 'contacts'
       AND coalesce(r.normalized ->> 'leadSourceLabel', '') <> ''
     GROUP BY 1`.execute(tx);
  const mapped = await labelMappings(tx);
  const counts = new Map<string, number>(r.rows.map((x) => [x.label, Number(x.people)]));
  for (const label of mapped.keys()) if (!counts.has(label)) counts.set(label, 0);
  return labelRows(counts, mapped);
}

/**
 * One label's row, for the Owner's mapping answer (leads/sources.ts setImportSource): the same people count and words
 * as its row of `tenantLabels`, read through app.import_source_people and import_records_contact_label (0101), so a
 * mapping change never reads the tenant's whole import history to answer.
 */
export async function labelRowOf(tx: Tx, label: string): Promise<ImportLabelRow> {
  // app.import_source_people (0101): the people the label's records targeted or matched, each once, through the index
  const r = await sql<{ people: string }>`SELECT count(*) AS people FROM app.import_source_people(app.tenant_id(), ${label}::text, NULL::uuid)`.execute(tx);
  const held = await sql<{ id: string; name: string; no_ai_care: boolean }>`
    SELECT s.id, s.name, s.no_ai_care FROM lead_sources s WHERE s.tenant_id = app.tenant_id() AND ${label}::text = ANY (s.import_labels) ORDER BY s.created_at, s.id`.execute(tx);
  const mapped = mappingsOf(held.rows.map((x) => ({ key: label, id: x.id, name: x.name, marked: x.no_ai_care })));
  return labelRows(new Map([[label, Number(r.rows[0]?.people ?? 0)]]), mapped)[0]!;
}

/**
 * R-LSRC-9: the no-label group of every import that COMMITTED people with no source label (one row per import, newest
 * first), or of one import. These are the people who stay unclassified until the Owner classifies that group. Not yet
 * on a route: the review list (GET /lead-sources/import-labels and the import's review step) adds these rows.
 */
export async function unlabeledGroups(tx: Tx, o: { importId?: string } = {}): Promise<ImportLabelRow[]> {
  const r = await sql<{ batch_id: string; people: string }>`
    SELECT st.batch_id::text AS batch_id, count(DISTINCT r.target_id) AS people
      FROM import_records r JOIN import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
      JOIN import_batches b ON b.tenant_id = st.tenant_id AND b.id = st.batch_id
     WHERE r.tenant_id = app.tenant_id() AND st.category = 'contacts' AND r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged')
       AND r.normalized ->> 'category' = 'contacts' AND btrim(coalesce(r.normalized ->> 'leadSourceLabel', '')) = ''
       AND (${o.importId ?? null}::uuid IS NULL OR st.batch_id = ${o.importId ?? null}::uuid)
     GROUP BY st.batch_id, b.created_at ORDER BY b.created_at DESC, st.batch_id`.execute(tx);
  const mapped = await unlabeledMappings(tx);
  return r.rows.map((x) => unlabeledRow(x.batch_id, Number(x.people), mapped.get(x.batch_id) ?? null));
}
