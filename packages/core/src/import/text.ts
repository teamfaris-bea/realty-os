// Byte decoding and text hygiene shared by the CSV and FUB normalizers (internal to core/import).
//
// Core has no DOM or Node types (no TextDecoder, no Buffer), so decoding is done here: strict UTF-8,
// UTF-16 LE/BE by BOM, and Windows-1252 as the fallback for files that are not valid UTF-8 (Excel on
// Windows still writes "CSV" in the ANSI code page).
import type { Issue } from './types.js';

export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

/** Windows-1252 code points for bytes 0x80…0x9F (the rest of the range is Latin-1). */
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

const CHUNK = 8192;

function fromCodePoints(cps: number[]): string {
  let out = '';
  for (let i = 0; i < cps.length; i += CHUNK) out += String.fromCodePoint(...cps.slice(i, i + CHUNK));
  return out;
}

/** Strict UTF-8 (no overlongs, no surrogates, no truncated sequences). Null when invalid. */
export function decodeUtf8(bytes: Uint8Array, start = 0): string | null {
  const cps: number[] = [];
  let i = start;
  const n = bytes.length;
  while (i < n) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      cps.push(b0);
      i += 1;
      continue;
    }
    let need: number;
    let cp: number;
    let min: number;
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1;
      cp = b0 & 0x1f;
      min = 0x80;
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2;
      cp = b0 & 0x0f;
      min = 0x800;
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3;
      cp = b0 & 0x07;
      min = 0x10000;
    } else return null;
    for (let k = 1; k <= need; k += 1) {
      const b = bytes[i + k];
      if (b === undefined || (b & 0xc0) !== 0x80) return null;
      cp = (cp << 6) | (b & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return null;
    cps.push(cp);
    i += need + 1;
  }
  return fromCodePoints(cps);
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const units: number[] = [];
  for (let i = start; i + 1 < bytes.length; i += 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    units.push(littleEndian ? a | (b << 8) : (a << 8) | b);
  }
  let out = '';
  for (let i = 0; i < units.length; i += CHUNK) out += String.fromCharCode(...units.slice(i, i + CHUNK));
  // Lone surrogates become U+FFFD so later normalization never sees malformed strings.
  return out.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '�');
}

function decodeCp1252(bytes: Uint8Array): string {
  const cps: number[] = new Array<number>(bytes.length);
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] as number;
    cps[i] = b >= 0x80 && b <= 0x9f ? (CP1252_HIGH[b - 0x80] as number) : b;
  }
  return fromCodePoints(cps);
}

/** Decodes a file: BOM first, then strict UTF-8, then Windows-1252. The BOM is never part of the text. */
export function decodeText(bytes: Uint8Array): { text: string; encoding: TextEncoding } {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    const t = decodeUtf8(bytes, 3);
    if (t !== null) return { text: t, encoding: 'utf-8' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decodeUtf16(bytes, 2, true), encoding: 'utf-16le' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decodeUtf16(bytes, 2, false), encoding: 'utf-16be' };
  const utf8 = decodeUtf8(bytes);
  if (utf8 !== null) return { text: utf8.replace(/^\uFEFF/, ''), encoding: 'utf-8' };
  return { text: decodeCp1252(bytes), encoding: 'windows-1252' };
}

// ---- text hygiene -------------------------------------------------------------------------------

/**
 * Spreadsheet formula triggers (CSV injection): a cell starting with `=`, `@`, a tab or a CR, or a
 * `+`/`-` followed by something that is not a plain number. Imported values are stored and shown
 * as text and never evaluated; a field that looks like a formula is flagged for review, and
 * `csvSafeCell` neutralizes values when they are exported again.
 */
export function looksLikeFormula(v: string): boolean {
  if (/^[=@\t\r]/.test(v)) return true;
  return /^[+-]/.test(v) && !/^[+-]\s*[\d\s().-]*$/.test(v);
}

/** Prefixes a value for safe export to a spreadsheet (OWASP CSV injection guidance). */
export function csvSafeCell(v: string): string {
  return looksLikeFormula(v) ? `'${v}` : v;
}

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const CONTROL_ALL = /[\u0000-\u001F\u007F]/g;

/** One-line text (names, tags, labels): NFC, control characters removed, whitespace collapsed. */
export function cleanLine(raw: string): string {
  return raw.normalize('NFC').replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim();
}

/** Multi-line text (note and message bodies): NFC, CRLF → LF, other control characters removed. */
export function cleanBody(raw: string): string {
  return raw.normalize('NFC').replace(/\r\n?/g, '\n').replace(CONTROL_EXCEPT_NEWLINE, '').trim();
}

/**
 * A one-line field value with its issues: formula-looking values are flagged for review (and kept
 * verbatim, as text), long values are truncated with an info issue.
 */
export function lineField(raw: string | null | undefined, field: string, max: number, issues: Issue[]): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmedRaw = raw.trim();
  if (trimmedRaw !== '' && looksLikeFormula(trimmedRaw)) issues.push({ code: 'FORMULA_PREFIX', severity: 'review', field });
  let v = cleanLine(raw);
  if (v === '') return null;
  if (v.length > max) {
    v = v.slice(0, max).trimEnd();
    issues.push({ code: 'VALUE_TRUNCATED', severity: 'info', field });
  }
  return v;
}

/**
 * The longest source label an import keeps (UTF-16 units; the CSV parser's own cell bound, MAX_CSV_FIELD_CHARS). A label
 * is never cut to fit: a longer one rejects its record (`sourceLabel`).
 */
export const SOURCE_LABEL_MAX = 32_768;

/** Half of a surrogate pair on its own: not a character, and not storable as UTF-8. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * R-LSRC-9 M1 (owner decision 2026-11-14, point 3): a person's source label EXACTLY as the file or the other system gave
 * it. Not trimmed, not re-cased, not normalized, not cut: the string that comes back is the string that went in, so two
 * labels that differ in any character are two labels and nobody infers that one means another. This is the one function
 * both normalizers store the label through (csv.ts, fub.ts); the API stores and compares what it returns
 * (import_records.normalized.leadSourceLabel, contacts.original_source_detail.import_source, lead_sources.import_labels).
 *
 * `null` means the person has NO label: nothing was given, or only whitespace. They belong to their import's no-label
 * group, which the Owner classifies as one row.
 *
 * A label that cannot be stored exactly is never altered to fit: one holding U+0000 or half of a surrogate pair (the
 * database cannot keep either), or one longer than SOURCE_LABEL_MAX, rejects its record (SOURCE_LABEL_UNREADABLE, a
 * record-level error; a rejected record is no import evidence and blocks nobody). A formula-looking label is flagged for
 * review like any other cell (`field`), and kept as written.
 */
export function sourceLabel(raw: string | null | undefined, field: string, issues: Issue[]): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  if (raw.length > SOURCE_LABEL_MAX || raw.includes('\u0000') || LONE_SURROGATE.test(raw)) {
    issues.push({ code: 'SOURCE_LABEL_UNREADABLE', severity: 'error' });
    return null;
  }
  if (looksLikeFormula(raw.trim())) issues.push({ code: 'FORMULA_PREFIX', severity: 'review', field });
  return raw;
}

/** Keys that must never become object members (imported_fields comes from untrusted headers). */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function safeKey(k: string): string | null {
  const key = cleanLine(k).slice(0, 100);
  return key === '' || UNSAFE_KEYS.has(key) ? null : key;
}

/** Comparison key for names: NFKD, diacritics and punctuation removed, lower-case, single spaces. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A short, non-identifying address hint for consent/suppression rows (≤ 40 chars, DB CHECK). */
export function addressHint(kind: 'phone' | 'email', normalized: string): string {
  if (kind === 'phone') return `•••${normalized.slice(-4)}`;
  const at = normalized.indexOf('@');
  const domain = normalized.slice(at + 1);
  return `${normalized.slice(0, 1)}•••@${domain}`.slice(0, 40);
}
