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

// ---- upload type checks -------------------------------------------------------------------------

const EXTENSIONS: Record<'csv' | 'fub_export', readonly string[]> = { csv: ['csv', 'tsv', 'txt'], fub_export: ['json'] };

/** Leading bytes of compressed / archive formats (gzip, zip incl. xlsx/docx, bzip2, xz, zstd, 7z, rar, OLE2 .xls). */
const ARCHIVE_MAGIC: readonly (readonly number[])[] = [
  [0x1f, 0x8b],
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00],
  [0x28, 0xb5, 0x2f, 0xfd],
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c],
  [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07],
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
];

/** True when the bytes start like a compressed file or an archive (never inflated: refused instead). */
export function looksCompressed(bytes: Uint8Array): boolean {
  if (ARCHIVE_MAGIC.some((m) => m.every((b, i) => bytes[i] === b))) return true;
  // bzip2: "BZh" + block size digit 1-9
  return bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68 && (bytes[3] ?? 0) >= 0x31 && (bytes[3] ?? 0) <= 0x39;
}

/**
 * Why an uploaded file is not of the type its source takes, or null when it is: the file name's
 * extension must fit the source (.csv/.tsv/.txt for CSV, .json for a FUB export) and the bytes must
 * not be a compressed file or an archive. Nothing in the import pipeline decompresses anything.
 */
export function uploadTypeProblem(source: 'csv' | 'fub_export', fileName: string, bytes: Uint8Array): 'COMPRESSED' | 'EXTENSION' | null {
  if (looksCompressed(bytes)) return 'COMPRESSED';
  const base = (fileName.split(/[\\/]/).pop() ?? '').trim().toLowerCase();
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1) : '';
  return EXTENSIONS[source].includes(ext) ? null : 'EXTENSION';
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
