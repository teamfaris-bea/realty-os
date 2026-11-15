// b18 round 3 item 1 (owner boundary B18S-5; R-LSRC-8, E728): imported source labels and the lead sources they mean.
//
// Imports preserve the full raw source label in original_source_detail.import_source and normalized.leadSourceLabel.
// Unmapped, ambiguous and missing labels fail closed (0101); historical source associations survive unmapping.
// The Owner maps a label, exactly as the import stored it, to one lead source (lead_sources.import_labels, 0099;
// Owner only in the API and the database), at import time from the import's preview or afterwards from the lead
// sources page. app.person_from_lead_source then counts the people it labels as sent by that source, so a source
// marked "No automated contact for leads from this source" covers them like any lead it sent. The import preview
// (GET /imports/:id/parity) and summary (GET /imports/:id/report) list the labels found, each with its source and
// whether that source is marked; GET /lead-sources/import-labels lists every label in the CRM.
//
//   GET /lead-sources/import-labels   settings.routing        every imported label with its people, source and mark
//   PUT /lead-sources/import-labels   lead_source.ai_care 🔒   { label, leadSourceId | null }: map, move or unmap a label
// The reads and words live here (imports/parity.ts and imports/routes.ts use them; no assistant import, so no load cycle
// through imports/commit.ts); the Owner's write and the stop it starts are in leads/sources.ts.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { NO_AUTOMATED_CONTACT_LABEL } from './automatedContact.js';

/** A source label exactly as the import stores it on the person it creates (imports/commit.ts originalSourceDetail). */
export function importLabelOf(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  return raw;
}

export interface ImportLabelRow {
  label: string;
  classification: 'SOURCE_UNCLASSIFIED' | 'classified';
  people: number;
  leadSourceId: string | null;
  leadSourceName: string | null;
  noAutomatedContact: boolean;
  sentence: string;
}

interface Mapped {
  id: string;
  name: string;
  noAutomatedContact: boolean;
}

/** The plain sentence of one label: who it labels, which source it means, and whether that source is marked. */
export function importLabelSentence(label: string, people: number, m: Mapped | null): string {
  const who = `${label === '' ? 'Missing source label' : `"${label}"`} (${people === 1 ? '1 person' : `${people} people`})`;
  if (!m) return `${who}: SOURCE_UNCLASSIFIED. Automated contact is blocked until the Owner confirms one exact source mapping.`;
  if (m.noAutomatedContact) return `${who}: mapped to ${m.name}, which has "${NO_AUTOMATED_CONTACT_LABEL}" on, so nothing automatic reaches them.`;
  return `${who}: mapped to ${m.name}.`;
}

/** Every mapped label of the tenant and the source it means (the caller reads lead_sources: Owner/Admin or system). */
export async function labelMappings(tx: Tx): Promise<Map<string, Mapped>> {
  const r = await sql<{ label: string; id: string; name: string; no_ai_care: boolean }>`
    SELECT l.label, s.id, s.name, s.no_ai_care FROM lead_sources s CROSS JOIN LATERAL unnest(s.import_labels) AS l(label)
     WHERE s.tenant_id = app.tenant_id() ORDER BY s.created_at, s.id`.execute(tx);
  const out = new Map<string, Mapped>();
  const ambiguous = new Set<string>();
  for (const x of r.rows) {
    const prev = out.get(x.label);
    if (prev?.id === x.id) continue;
    if (prev || ambiguous.has(x.label)) { out.delete(x.label); ambiguous.add(x.label); }
    else out.set(x.label, { id: x.id, name: x.name, noAutomatedContact: x.no_ai_care });
  }
  return out;
}

/** Rows for labels and their people counts, sorted by label, each with its mapping and sentence. */
export function labelRows(counts: ReadonlyMap<string, number>, mapped: ReadonlyMap<string, Mapped>): ImportLabelRow[] {
  return [...counts.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, people]) => {
      const m = label.trim() ? mapped.get(label) ?? null : null;
      return { label, classification: m ? 'classified' : 'SOURCE_UNCLASSIFIED', people, leadSourceId: m?.id ?? null, leadSourceName: m?.name ?? null, noAutomatedContact: m?.noAutomatedContact ?? true, sentence: importLabelSentence(label, people, m) };
    });
}

/** Tallies labels (as the import stores them) over a list of raw source labels; missing labels are counted under the empty review key. */
export function tallyLabels(raw: readonly (string | null | undefined)[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of raw) {
    const l = r?.trim() ? importLabelOf(r)! : '';
    out.set(l, (out.get(l) ?? 0) + 1);
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
 */
export async function tenantLabels(tx: Tx): Promise<ImportLabelRow[]> {
  const r = await sql<{ label: string; people: string }>`
    WITH labels AS (
      SELECT coalesce(r.normalized ->> 'leadSourceLabel', '') AS label, x.id
        FROM import_records r CROSS JOIN LATERAL (VALUES (CASE WHEN r.target_table = 'contacts' THEN r.target_id END), (r.match_contact_id)) AS x(id)
       WHERE r.tenant_id = app.tenant_id() AND x.id IS NOT NULL AND r.normalized ->> 'category' = 'contacts'
      UNION ALL
      SELECT coalesce(c.original_source_detail->>'import_source',''), c.id FROM contacts c
       WHERE c.tenant_id = app.tenant_id() AND (c.import_batch_id IS NOT NULL OR c.original_source_detail ? 'import_system')
         AND NOT EXISTS (SELECT 1 FROM import_records r WHERE r.tenant_id = c.tenant_id AND r.normalized->>'category' = 'contacts'
           AND ((r.target_table = 'contacts' AND r.target_id = c.id) OR r.match_contact_id = c.id))
    ) SELECT label, count(DISTINCT id) AS people FROM labels GROUP BY label`.execute(tx);
  const mapped = await labelMappings(tx);
  const counts = new Map<string, number>(r.rows.map((x) => [x.label, Number(x.people)]));
  for (const label of mapped.keys()) if (!counts.has(label)) counts.set(label, 0);
  return labelRows(counts, mapped);
}
