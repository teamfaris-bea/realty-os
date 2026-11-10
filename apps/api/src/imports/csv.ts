// CSV imports (ARCHITECTURE §13 "CSV uses the same machinery with a contacts stage and an optional
// consent stage, up to 50k rows"; R-IMPORT-13). The uploaded file IS the snapshot: it is stored
// encrypted (per-object DEK) at upload, its sha256 is the batch's snapshot hash, and every dry run
// re-parses exactly those bytes with the confirmed column mapping.
import { type Category, type ColumnMapping, type ColumnTarget, MAX_CSV_ROWS, type NormalizedRecord, type RecordOutcome, csvConsentRecords, normalizeCsv, parseCsv, suggestMapping } from '@realty/core/import';
import { z } from 'zod';

/** Upload limit (bytes) for one CSV file; the row limit (50k) is core's (R-IMPORT-13). */
export const MAX_CSV_BYTES = 25 * 1024 * 1024;

export type CsvInspection =
  | { ok: true; headers: string[]; rows: number; mapping: ColumnMapping }
  | { ok: false; code: string; line?: number; limit?: number };

/** The upload-time check: counts only (R-IMPORT-1 spirit for files) plus the suggested mapping. */
export function inspectCsv(bytes: Uint8Array): CsvInspection {
  const parsed = parseCsv(bytes, { maxRows: MAX_CSV_ROWS });
  if ('error' in parsed) return { ok: false, code: parsed.error.code, ...(parsed.error.line !== undefined ? { line: parsed.error.line } : {}), ...(parsed.error.limit !== undefined ? { limit: parsed.error.limit } : {}) };
  return { ok: true, headers: parsed.headers, rows: parsed.rows.length, mapping: suggestMapping(parsed.headers) };
}

const CONTACT_FIELDS = [
  'first_name',
  'last_name',
  'full_name',
  'phone',
  'phone_mobile',
  'phone_home',
  'phone_work',
  'email',
  'email_work',
  'tags',
  'contact_type',
  'stage',
  'intent',
  'address_line1',
  'address_line2',
  'city',
  'region',
  'postal_code',
  'country',
  'lead_source',
  'external_id',
  'consent_sms',
  'consent_email',
  'consent_voice',
  'opted_out',
  'unsubscribed',
  'do_not_contact',
] as const;

export const ColumnTargetSchema: z.ZodType<ColumnTarget> = z.union([
  z.strictObject({ field: z.enum(CONTACT_FIELDS) }),
  z.strictObject({ field: z.literal('custom'), key: z.string().regex(/^[A-Za-z][A-Za-z0-9_ -]{0,63}$/) }),
  z.strictObject({ field: z.literal('ignore') }),
]);

export const CSV_CATEGORIES: readonly Category[] = ['contacts', 'consent'];

/** A safe file label for source refs (`label#row=N`): the base name, no path, no odd characters. */
export function fileLabelOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file.csv';
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return clean === '' ? 'file.csv' : clean;
}

export interface StageSource {
  outcomes: RecordOutcome<NormalizedRecord>[];
  /** source ref → the raw source object (stored encrypted per record) */
  raws: Map<string, unknown>;
}

/** The contacts or consent stage records of a CSV snapshot, with each row's raw cells. */
export function csvStageRecords(bytes: Uint8Array, mapping: ColumnMapping, fileLabel: string, category: Category): StageSource {
  const parsed = parseCsv(bytes, { maxRows: MAX_CSV_ROWS });
  if ('error' in parsed) throw new Error(`CSV_INVALID:${parsed.error.code}`);
  const contacts = normalizeCsv(parsed, mapping, { defaultCountry: 'US' }, fileLabel);
  const raws = new Map<string, unknown>();
  parsed.rows.forEach((row, i) => raws.set(contacts[i]!.sourceRef, { headers: parsed.headers, cells: row, row: parsed.rowNumbers[i] }));
  if (category === 'contacts') return { outcomes: contacts, raws };
  if (category === 'consent') return { outcomes: csvConsentRecords(contacts), raws };
  return { outcomes: [], raws };
}
