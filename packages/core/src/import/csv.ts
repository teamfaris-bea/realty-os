// CSV import: parse, suggest a column mapping, normalize rows (BUILD_PLAN module 6; R-IMPORT-13,
// R-CONSENT-3, E45).
//
// - At most 50,000 data rows per file (R-IMPORT-13). Parsing stops as soon as the limit is passed,
//   so an oversized file costs no more than the limit.
// - RFC 4180 quoting (quoted delimiters, doubled quotes, quoted newlines), CRLF / LF / CR line ends,
//   UTF-8 (with or without BOM), UTF-16 by BOM and a Windows-1252 fallback, comma / semicolon / tab
//   delimiters detected from the header line. Blank lines are skipped but still counted for row
//   numbers, so `file.csv#row=N` matches the spreadsheet row.
// - Phones normalize with the tenant's default country; an invalid value is rejected with its
//   reason code (E45 "555-0100" → PHONE_INVALID) and listed for review. A row with no usable name,
//   phone or email is rejected (NO_IDENTITY).
// - Consent columns can only produce `imported_unverified` grants or revocations, with row-level
//   provenance (R-IMPORT-13): `csvConsentRecords` turns them into consent-stage records and
//   `mapImportedConsent` (consent.ts) caps every grant.
// - Unknown columns go to `imported_fields` (display-only), never to typed columns.
//
// csv-parse is not used: its sync API depends on Node's Buffer, and core must stay free of Node
// built-ins so the web app can share these helpers.
import { normalizeEmail, normalizePhone } from '../foundation/index.js';
import type { Channel } from '../compliance/index.js';
import { normalizeZip } from '../ownership/index.js';
import { type TextEncoding, decodeText, lineField, safeKey } from './text.js';
import type {
  ContactStage,
  ContactType,
  FubConsentFields,
  ImportedAddressConsent,
  Intent,
  Issue,
  NormalizedAddress,
  NormalizedConsent,
  NormalizedContact,
  NormalizedEmail,
  NormalizedPhone,
  PointLabel,
  PointStatus,
  RecordOutcome,
} from './types.js';

export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_COLUMNS = 500;
export const MAX_CSV_FIELD_CHARS = 32_768;

export type CsvErrorCode =
  | 'CSV_EMPTY'
  | 'CSV_NO_HEADER'
  | 'CSV_TOO_MANY_ROWS'
  | 'CSV_TOO_MANY_COLUMNS'
  | 'CSV_FIELD_TOO_LARGE'
  | 'CSV_UNTERMINATED_QUOTE'
  | 'CSV_BINARY';

export interface CsvError {
  code: CsvErrorCode;
  /** 1-based physical line where the problem was found (when it has one). */
  line?: number;
  /** The limit that was exceeded (rows / columns / characters). */
  limit?: number;
}

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** Spreadsheet row number of each data row (header = row 1; blank rows count). */
  rowNumbers: number[];
  encoding: TextEncoding;
  delimiter: ',' | ';' | '\t';
}

const DELIMITERS = [',', ';', '\t'] as const;

function detectDelimiter(text: string): ',' | ';' | '\t' {
  // Count candidates outside quotes on the first line (the header).
  const counts = new Map<string, number>(DELIMITERS.map((d) => [d, 0]));
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i] as string;
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (c === '\n' || c === '\r')) break;
    else if (!inQuotes && counts.has(c)) counts.set(c, (counts.get(c) as number) + 1);
  }
  let best: ',' | ';' | '\t' = ',';
  for (const d of DELIMITERS) if ((counts.get(d) as number) > (counts.get(best) as number)) best = d;
  return best;
}

/**
 * Parses CSV bytes into a header and data rows. `maxRows` is clamped to 50,000 (R-IMPORT-13). Never
 * throws: every malformed input gives `{ error }`.
 */
export function parseCsv(bytes: Uint8Array, opts: { maxRows: number } = { maxRows: MAX_CSV_ROWS }): ParsedCsv | { error: CsvError } {
  const maxRows = Math.max(0, Math.min(Math.floor(opts.maxRows), MAX_CSV_ROWS));
  const { text, encoding } = decodeText(bytes);
  if (text.trim() === '') return { error: { code: 'CSV_EMPTY' } };
  if (text.includes('\u0000')) return { error: { code: 'CSV_BINARY' } };
  const delimiter = detectDelimiter(text);

  const records: { cells: string[]; rowNumber: number }[] = [];
  let headers: string[] | null = null;
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let quoteLine = 1;
  let recordNo = 0;
  let dataRows = 0;
  let started = false; // any character of the current record consumed
  const n = text.length;

  const endRecord = (): CsvError | null => {
    started = false;
    cells.push(field);
    field = '';
    recordNo += 1;
    const row = cells;
    cells = [];
    if (row.length > MAX_CSV_COLUMNS) return { code: 'CSV_TOO_MANY_COLUMNS', line, limit: MAX_CSV_COLUMNS };
    const blank = row.every((c) => c.trim() === '');
    if (blank) return null;
    if (headers === null) {
      headers = row.map((h) => h.replace(/^\uFEFF/, '').trim());
      return null;
    }
    dataRows += 1;
    if (dataRows > maxRows) return { code: 'CSV_TOO_MANY_ROWS', line, limit: maxRows };
    records.push({ cells: row, rowNumber: recordNo });
    return null;
  };

  let i = 0;
  while (i < n) {
    const c = text[i] as string;
    if (c !== '\r' && c !== '\n') started = true;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      // Copy a run of ordinary characters at once.
      let j = i;
      while (j < n && text[j] !== '"') {
        if (text[j] === '\n' || (text[j] === '\r' && text[j + 1] !== '\n')) line += 1;
        j += 1;
      }
      field += text.slice(i, j);
      if (field.length > MAX_CSV_FIELD_CHARS) return { error: { code: 'CSV_FIELD_TOO_LARGE', line: quoteLine, limit: MAX_CSV_FIELD_CHARS } };
      i = j;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      quoteLine = line;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      cells.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r' || c === '\n') {
      const err = endRecord();
      if (err) return { error: err };
      i += c === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line += 1;
      continue;
    }
    let j = i;
    while (j < n) {
      const d = text[j];
      if (d === delimiter || d === '\r' || d === '\n') break;
      j += 1;
    }
    field += text.slice(i, j);
    if (field.length > MAX_CSV_FIELD_CHARS) return { error: { code: 'CSV_FIELD_TOO_LARGE', line, limit: MAX_CSV_FIELD_CHARS } };
    i = j;
  }
  if (inQuotes) return { error: { code: 'CSV_UNTERMINATED_QUOTE', line: quoteLine } };
  if (started) {
    const err = endRecord();
    if (err) return { error: err };
  }
  if (headers === null) return { error: { code: 'CSV_NO_HEADER' } };
  return { headers, rows: records.map((r) => r.cells), rowNumbers: records.map((r) => r.rowNumber), encoding, delimiter };
}

// ---- column mapping -----------------------------------------------------------------------------

export type ContactField =
  | 'first_name'
  | 'last_name'
  | 'full_name'
  | 'phone'
  | 'phone_mobile'
  | 'phone_home'
  | 'phone_work'
  | 'email'
  | 'email_work'
  | 'tags'
  | 'contact_type'
  | 'stage'
  | 'intent'
  | 'address_line1'
  | 'address_line2'
  | 'city'
  | 'region'
  | 'postal_code'
  | 'country'
  | 'lead_source'
  | 'external_id'
  | 'consent_sms'
  | 'consent_email'
  | 'consent_voice'
  | 'opted_out'
  | 'unsubscribed'
  | 'do_not_contact';

export type ColumnTarget = { field: ContactField } | { field: 'custom'; key: string } | { field: 'ignore' };

/** One target per header, by index. */
export type ColumnMapping = ColumnTarget[];

/** Fields that may be mapped from several columns (all values are kept). */
const MULTI: ReadonlySet<ContactField> = new Set<ContactField>(['phone', 'phone_mobile', 'phone_home', 'phone_work', 'email', 'email_work', 'tags']);

const SYNONYMS: Record<ContactField, readonly string[]> = {
  first_name: ['firstname', 'first', 'givenname', 'fname', 'forename'],
  last_name: ['lastname', 'last', 'surname', 'familyname', 'lname'],
  full_name: ['name', 'fullname', 'contactname', 'displayname', 'contact'],
  phone: ['phone', 'phonenumber', 'telephone', 'tel', 'primaryphone', 'phone1', 'phone2', 'phone3', 'otherphone'],
  phone_mobile: ['mobile', 'cell', 'cellphone', 'mobilephone', 'mobilenumber', 'cellnumber'],
  phone_home: ['homephone', 'home'],
  phone_work: ['workphone', 'officephone', 'businessphone', 'work'],
  email: ['email', 'emailaddress', 'email1', 'email2', 'email3', 'primaryemail', 'personalemail', 'otheremail', 'mail'],
  email_work: ['workemail', 'businessemail', 'officeemail'],
  tags: ['tags', 'tag', 'labels', 'groups'],
  contact_type: ['type', 'contacttype', 'category'],
  stage: ['stage', 'status', 'leadstatus', 'leadstage'],
  intent: ['intent', 'buyerseller', 'buyerorseller', 'leadtype', 'clienttype'],
  address_line1: ['address', 'street', 'address1', 'streetaddress', 'addressline1', 'mailingaddress', 'homeaddress'],
  address_line2: ['address2', 'addressline2', 'unit', 'apt', 'suite'],
  city: ['city', 'town'],
  region: ['state', 'province', 'region'],
  postal_code: ['zip', 'zipcode', 'postalcode', 'postcode', 'postal'],
  country: ['country'],
  lead_source: ['source', 'leadsource'],
  external_id: ['id', 'externalid', 'contactid', 'fubid', 'personid', 'recordid'],
  consent_sms: ['smsconsent', 'textconsent', 'smsoptin', 'textoptin', 'oktotext', 'cantext', 'textingpermission'],
  consent_email: ['emailconsent', 'emailoptin', 'oktoemail'],
  consent_voice: ['callconsent', 'phoneconsent', 'oktocall'],
  opted_out: ['optedout', 'optout', 'smsoptout', 'textoptout'],
  unsubscribed: ['unsubscribed', 'emailunsubscribed', 'emailoptout'],
  do_not_contact: ['dnc', 'donotcontact', 'donotcall', 'donotdisturb'],
};

const LOOKUP = new Map<string, ContactField>();
for (const [field, words] of Object.entries(SYNONYMS) as [ContactField, readonly string[]][]) for (const w of words) LOOKUP.set(w, field);

function headerKey(h: string): string {
  return h
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Suggests a target per header. Known headers map to typed fields (each single-valued field once;
 * a repeat becomes a custom field); unknown headers become custom fields (`imported_fields`);
 * empty headers are ignored. The admin confirms or edits the mapping before the dry run.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const used = new Set<ContactField>();
  return headers.map((h): ColumnTarget => {
    const k = headerKey(h);
    if (k === '') return { field: 'ignore' };
    const f = LOOKUP.get(k) ?? (/^phone\d+$/.test(k) ? 'phone' : /^email\d+$/.test(k) ? 'email' : undefined);
    if (f !== undefined && (MULTI.has(f) || !used.has(f))) {
      used.add(f);
      return { field: f };
    }
    const key = safeKey(h);
    return key === null ? { field: 'ignore' } : { field: 'custom', key };
  });
}

// ---- value vocabularies -------------------------------------------------------------------------

const STAGE_WORDS: Record<string, { stage: ContactStage; type?: ContactType }> = {
  new: { stage: 'new' },
  lead: { stage: 'new' },
  newlead: { stage: 'new' },
  attempting: { stage: 'attempting' },
  attemptedcontact: { stage: 'attempting' },
  contacted: { stage: 'connected' },
  connected: { stage: 'connected' },
  prospect: { stage: 'connected' },
  hotprospect: { stage: 'active' },
  nurture: { stage: 'nurture' },
  warm: { stage: 'nurture' },
  cold: { stage: 'nurture' },
  unresponsive: { stage: 'nurture' },
  active: { stage: 'active' },
  activeclient: { stage: 'active' },
  pending: { stage: 'under_contract' },
  undercontract: { stage: 'under_contract' },
  closed: { stage: 'closed', type: 'past_client' },
  pastclient: { stage: 'closed', type: 'past_client' },
  sphere: { stage: 'nurture', type: 'sphere' },
  lost: { stage: 'lost' },
  trash: { stage: 'lost' },
  dead: { stage: 'lost' },
};

const TYPE_WORDS: Record<string, ContactType> = {
  lead: 'lead',
  buyer: 'lead',
  seller: 'lead',
  sphere: 'sphere',
  sphereofinfluence: 'sphere',
  soi: 'sphere',
  friend: 'sphere',
  family: 'sphere',
  pastclient: 'past_client',
  client: 'past_client',
  vendor: 'vendor',
  agent: 'other',
  lender: 'vendor',
  other: 'other',
};

const INTENT_WORDS: Record<string, Intent> = {
  buyer: 'buyer',
  buying: 'buyer',
  seller: 'seller',
  selling: 'seller',
  buyerseller: 'buyer_seller',
  buyerandseller: 'buyer_seller',
  both: 'buyer_seller',
  renter: 'renter',
  tenant: 'renter',
  landlord: 'landlord',
  investor: 'investor',
};

/** Maps a source stage label; unknown labels keep the default and are flagged. */
export function mapStage(label: string | null, issues: Issue[], field = 'stage'): { stage: ContactStage; type?: ContactType } {
  if (label === null) return { stage: 'new' };
  const hit = STAGE_WORDS[headerKey(label)];
  if (hit) return hit;
  issues.push({ code: 'STAGE_UNMAPPED', severity: 'info', field });
  return { stage: 'new' };
}

function mapType(label: string | null, issues: Issue[]): ContactType | null {
  if (label === null) return null;
  const hit = TYPE_WORDS[headerKey(label)];
  if (hit) return hit;
  issues.push({ code: 'TYPE_UNMAPPED', severity: 'info', field: 'contact_type' });
  return null;
}

function mapIntent(label: string | null, issues: Issue[]): Intent | null {
  if (label === null) return null;
  const hit = INTENT_WORDS[headerKey(label)];
  if (hit) return hit;
  issues.push({ code: 'INTENT_UNMAPPED', severity: 'info', field: 'intent' });
  return null;
}

/** How a consent cell reads. `ambiguous` (a bare "no") is a revocation only after a human confirms it. */
export type ConsentReading = 'yes' | 'revoke' | 'ambiguous' | 'empty' | 'unrecognized';

const YES = new Set(['yes', 'y', 'true', 't', '1', 'x', 'optedin', 'optin', 'subscribed', 'granted', 'ok', 'allowed', 'consented']);
const REVOKE = new Set(['optedout', 'optout', 'unsubscribed', 'unsubscribe', 'stop', 'stopped', 'revoked', 'donottext', 'donotemail', 'donotcall', 'dnc', 'declined', 'refused']);
const NO = new Set(['no', 'n', 'false', 'f', '0']);

export function readConsentCell(v: string): ConsentReading {
  const t = v.trim();
  if (t === '') return 'empty';
  if (t === '✓' || t === '✔') return 'yes';
  const k = headerKey(t);
  if (YES.has(k)) return 'yes';
  if (REVOKE.has(k)) return 'revoke';
  if (NO.has(k)) return 'ambiguous';
  return 'unrecognized';
}

/** A "flag" column (opted_out, unsubscribed, do_not_contact): yes/revoke words set it, negatives clear it. */
function readFlagCell(v: string): 'set' | 'clear' | 'unrecognized' {
  const r = readConsentCell(v);
  if (r === 'yes' || r === 'revoke') return 'set';
  if (r === 'ambiguous' || r === 'empty') return 'clear';
  return 'unrecognized';
}

// ---- row normalization --------------------------------------------------------------------------

const MAX_NAME = 200;
const MAX_TAG = 64;
const MAX_TAGS = 100;
const MAX_POINTS = 10;
const MAX_FIELD_VALUE = 2_000;
const MAX_IMPORTED_FIELDS = 200;

const MULTI_SPLIT = /[;|\n]|,(?!\s*(?:ext|x)\b)/i;

function splitMulti(v: string): string[] {
  return v
    .split(MULTI_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function labelOf(f: ContactField): PointLabel {
  if (f === 'phone_mobile') return 'mobile';
  if (f === 'phone_home') return 'home';
  if (f === 'phone_work' || f === 'email_work') return 'work';
  return 'other';
}

/** Postal code: US ZIP / ZIP+4; a 4-digit ZIP whose leading zero a spreadsheet dropped is restored. */
function normalizePostal(raw: string, issues: Issue[]): string | null {
  const v = raw.trim(); // never empty: empty cells are skipped before mapping
  const padded = /^\d{4}$/.test(v) ? `0${v}` : /^\d{4}-\d{4}$/.test(v) ? `0${v}` : v;
  const zip = normalizeZip(padded);
  if (zip === null) {
    issues.push({ code: 'POSTAL_INVALID', severity: 'error', field: 'postal_code' });
    return null;
  }
  const plus4 = /^\s*\d{5}[-\s]?(\d{4})\s*$/.exec(padded);
  return plus4 ? `${zip}-${plus4[1] as string}` : zip;
}

function normalizeCountry(raw: string | null): string {
  if (raw === null) return 'US';
  const k = headerKey(raw);
  if (['us', 'usa', 'unitedstates', 'unitedstatesofamerica', 'america'].includes(k)) return 'US';
  return /^[a-z]{2}$/.test(k) ? k.toUpperCase() : 'US';
}

/** Splits "Jane Q. Public" into first "Jane Q." and last "Public". */
function splitFullName(full: string): { first: string | null; last: string | null } {
  const parts = full.split(' ');
  if (parts.length === 1) return { first: full, last: null };
  return { first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] as string };
}

/** Status from issues: record-level error ⇒ rejected; any review issue or dropped value ⇒ needs_review. */
export function statusOf(issues: readonly Issue[]): 'valid' | 'needs_review' | 'rejected' {
  if (issues.some((i) => i.severity === 'error' && i.field === undefined)) return 'rejected';
  if (issues.some((i) => i.severity === 'review' || i.severity === 'error')) return 'needs_review';
  return 'valid';
}

/** Adds normalized phones from raw values; invalid values are dropped with PHONE_INVALID (E45). */
export function collectPhones(values: { raw: string; label: PointLabel; field: string; status?: PointStatus }[], defaultCountry: 'US', issues: Issue[]): NormalizedPhone[] {
  const out: NormalizedPhone[] = [];
  for (const v of values) {
    const r = normalizePhone(v.raw, defaultCountry);
    if (!r.ok) {
      issues.push({ code: 'PHONE_INVALID', severity: 'error', field: v.field });
      continue;
    }
    if (out.some((p) => p.e164 === r.e164)) continue;
    if (out.length >= MAX_POINTS) {
      issues.push({ code: 'TOO_MANY_VALUES', severity: 'info', field: v.field });
      continue;
    }
    out.push({ e164: r.e164, ...(r.extension ? { extension: r.extension } : {}), label: v.label, status: v.status ?? 'active', isPrimary: out.length === 0 });
  }
  return out;
}

export function collectEmails(values: { raw: string; label: PointLabel; field: string; status?: PointStatus }[], issues: Issue[]): NormalizedEmail[] {
  const out: NormalizedEmail[] = [];
  for (const v of values) {
    const r = normalizeEmail(v.raw);
    if (!r.ok) {
      issues.push({ code: 'EMAIL_INVALID', severity: 'error', field: v.field });
      continue;
    }
    if (out.some((e) => e.email === r.email)) continue;
    if (out.length >= MAX_POINTS) {
      issues.push({ code: 'TOO_MANY_VALUES', severity: 'info', field: v.field });
      continue;
    }
    out.push({ email: r.email, label: v.label, status: v.status ?? 'active', isPrimary: out.length === 0 });
  }
  return out;
}

/** Tags: trimmed, case-insensitively de-duplicated, ≤ 64 chars each, ≤ 100 per contact. */
export function collectTags(raws: readonly string[], issues: Issue[], field = 'tags'): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const t = lineField(raw, field, MAX_TAG, issues);
    if (t === null || seen.has(t.toLowerCase())) continue;
    if (out.length >= MAX_TAGS) {
      issues.push({ code: 'TOO_MANY_VALUES', severity: 'info', field });
      break;
    }
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

export function putImportedField(target: Record<string, string>, key: string, raw: string, issues: Issue[]): void {
  const k = safeKey(key);
  if (k === null || Object.hasOwn(target, k)) return;
  if (Object.keys(target).length >= MAX_IMPORTED_FIELDS) {
    issues.push({ code: 'TOO_MANY_VALUES', severity: 'info', field: 'imported_fields' });
    return;
  }
  const v = lineField(raw, k, MAX_FIELD_VALUE, issues);
  if (v !== null) target[k] = v;
}

/** The contacts-stage person ref a later stage links to (external id when present, else the row ref). */
export function personRefOf(c: { externalId: string | null; sourceRef: string }): string {
  return c.externalId ?? c.sourceRef;
}

/**
 * Normalizes one CSV data row with a confirmed mapping. Never throws. `at.sourceRef` names the row
 * (`file.csv#row=42`); `normalizeCsv` fills it from the parse.
 */
export function normalizeCsvRow(
  row: string[],
  m: ColumnMapping,
  tenant: { defaultCountry: 'US' },
  at: { sourceRef: string } = { sourceRef: 'row' },
): RecordOutcome<NormalizedContact> {
  const issues: Issue[] = [];
  const consentIssues: Issue[] = [];
  const single = new Map<ContactField, string>();
  const phones: { raw: string; label: PointLabel; field: string }[] = [];
  const emails: { raw: string; label: PointLabel; field: string }[] = [];
  const tagRaw: string[] = [];
  const importedFields: Record<string, string> = Object.create(null) as Record<string, string>;
  const consentCells: { field: ContactField; value: string }[] = [];

  if (row.length > m.length && row.slice(m.length).some((c) => c.trim() !== '')) issues.push({ code: 'EXTRA_CELLS', severity: 'info' });

  m.forEach((target, i) => {
    const value = row[i] ?? '';
    if (target.field === 'ignore' || value.trim() === '') return;
    if (target.field === 'custom') {
      putImportedField(importedFields, target.key, value, issues);
      return;
    }
    const f = target.field;
    switch (f) {
      case 'phone':
      case 'phone_mobile':
      case 'phone_home':
      case 'phone_work':
        for (const v of splitMulti(value)) phones.push({ raw: v, label: labelOf(f), field: f });
        return;
      case 'email':
      case 'email_work':
        for (const v of splitMulti(value)) emails.push({ raw: v, label: labelOf(f), field: f });
        return;
      case 'tags':
        tagRaw.push(...value.split(/[,;|]/));
        return;
      case 'consent_sms':
      case 'consent_email':
      case 'consent_voice':
      case 'opted_out':
      case 'unsubscribed':
      case 'do_not_contact':
        consentCells.push({ field: f, value });
        return;
      default:
        if (!single.has(f)) single.set(f, value);
    }
  });

  const text = (f: ContactField, max = MAX_NAME): string | null => lineField(single.get(f) ?? null, f, max, issues);

  let firstName = text('first_name');
  let lastName = text('last_name');
  const fullName = text('full_name');
  if (fullName !== null && firstName === null && lastName === null) ({ first: firstName, last: lastName } = splitFullName(fullName));

  const normalizedPhones = collectPhones(phones, tenant.defaultCountry, issues);
  const normalizedEmails = collectEmails(emails, issues);
  const tags = collectTags(tagRaw, issues);

  const stageLabel = text('stage', MAX_FIELD_VALUE);
  const stage = mapStage(stageLabel, issues);
  if (stageLabel !== null) putImportedField(importedFields, 'Original stage', stageLabel, issues);
  const typeLabel = text('contact_type', MAX_FIELD_VALUE);
  const contactType = mapType(typeLabel, issues) ?? stage.type ?? 'lead';
  if (typeLabel !== null && mapType(typeLabel, []) === null) putImportedField(importedFields, 'Original type', typeLabel, issues);
  const intentLabel = text('intent', MAX_FIELD_VALUE);
  const intent = mapIntent(intentLabel, issues);
  if (intentLabel !== null && intent === null) putImportedField(importedFields, 'Original intent', intentLabel, issues);

  const addresses: NormalizedAddress[] = [];
  const line1 = text('address_line1', 500);
  const line2 = text('address_line2', 500);
  const city = text('city');
  const regionRaw = text('region', 100);
  const region = regionRaw !== null && /^[a-z]{2}$/i.test(regionRaw) ? regionRaw.toUpperCase() : regionRaw;
  const postalCode = single.has('postal_code') ? normalizePostal(single.get('postal_code') as string, issues) : null;
  if (line1 !== null || line2 !== null || city !== null || region !== null || postalCode !== null) {
    addresses.push({ kind: 'home', line1, line2, city, region, postalCode, country: normalizeCountry(text('country', 100)) });
  }

  const leadSourceLabel = text('lead_source', 500);
  if (leadSourceLabel !== null) putImportedField(importedFields, 'Source', leadSourceLabel, issues);
  const externalId = text('external_id', 200);

  const named = [firstName, lastName].filter((x): x is string => x !== null).join(' ');
  const displayName = fullName ?? (named !== '' ? named : null) ?? normalizedEmails[0]?.email ?? normalizedPhones[0]?.e164 ?? null;
  if (displayName === null) {
    issues.push({ code: 'NO_IDENTITY', severity: 'error' });
    return { sourceRef: at.sourceRef, status: 'rejected', record: null, issues };
  }
  if (fullName === null && named === '') issues.push({ code: 'NAME_MISSING', severity: 'info' });

  const consent = consentCells.length > 0 ? csvConsentFields(consentCells, normalizedPhones, normalizedEmails, consentIssues) : undefined;

  const record: NormalizedContact = {
    category: 'contacts',
    sourceRef: at.sourceRef,
    externalId,
    firstName,
    lastName,
    displayName,
    contactType,
    stage: stage.stage,
    intent,
    phones: normalizedPhones,
    emails: normalizedEmails,
    addresses,
    tags,
    importedFields: { ...importedFields },
    leadSourceLabel,
    createdAt: null,
    ...(consent ? { consent: { fields: consent, issues: consentIssues } } : {}),
  };
  return finish(at.sourceRef, record, issues);
}

/** The outcome of a built record: rejected when an issue rejects the whole record, else by its issues. */
export function finish<T>(sourceRef: string, record: T, issues: Issue[]): RecordOutcome<T> {
  const status = statusOf(issues);
  return status === 'rejected' ? { sourceRef, status, record: null, issues } : { sourceRef, status, record, issues };
}

/**
 * Reads the consent columns of one row (R-IMPORT-13). Positive values become grants (capped later),
 * explicit opt-out words become revocations, a bare "no" is an ambiguous revocation that needs a
 * human (CONSENT_VALUE_AMBIGUOUS), anything else is flagged unrecognized and produces nothing.
 */
function csvConsentFields(cells: { field: ContactField; value: string }[], phones: NormalizedPhone[], emails: NormalizedEmail[], issues: Issue[]): FubConsentFields {
  const grants = new Set<Channel>();
  const revokes = new Set<Channel>();
  let dnc = false;
  const channelOf: Partial<Record<ContactField, Channel>> = { consent_sms: 'sms', consent_email: 'email', consent_voice: 'voice' };
  for (const { field, value } of cells) {
    const ch = channelOf[field];
    if (ch !== undefined) {
      const r = readConsentCell(value);
      if (r === 'yes') grants.add(ch);
      else if (r === 'revoke') revokes.add(ch);
      else if (r === 'ambiguous') {
        revokes.add(ch);
        issues.push({ code: 'CONSENT_VALUE_AMBIGUOUS', severity: 'review', field });
      } else issues.push({ code: 'CONSENT_VALUE_UNRECOGNIZED', severity: 'review', field }); // 'empty' never reaches here
      continue;
    }
    const flag = readFlagCell(value);
    if (flag === 'unrecognized') {
      issues.push({ code: 'CONSENT_VALUE_UNRECOGNIZED', severity: 'review', field });
      continue;
    }
    if (flag === 'clear') continue;
    if (field === 'opted_out') for (const c of ['sms', 'voice', 'email'] as const) revokes.add(c);
    else if (field === 'unsubscribed') revokes.add('email');
    else dnc = true;
  }
  for (const c of [...grants]) {
    if (revokes.has(c)) {
      grants.delete(c);
      issues.push({ code: 'CONSENT_CONFLICT', severity: 'info' });
    }
  }
  const addresses: ImportedAddressConsent[] = [
    ...phones.map((p) => ({
      kind: 'phone' as const,
      address: p.e164,
      grants: [...grants].filter((c) => c !== 'email'),
      revokes: [...revokes].filter((c) => c !== 'email'),
      doNotContact: dnc,
    })),
    ...emails.map((e) => ({
      kind: 'email' as const,
      address: e.email,
      grants: [...grants].filter((c) => c === 'email'),
      revokes: [...revokes].filter((c) => c === 'email'),
      doNotContact: dnc,
    })),
  ].filter((a) => a.grants.length > 0 || a.revokes.length > 0 || a.doNotContact);
  return { addresses, occurredAt: null };
}

/** Normalizes every row of a parsed file; source refs are `${fileLabel}#row=${spreadsheet row}`. */
export function normalizeCsv(parsed: ParsedCsv, m: ColumnMapping, tenant: { defaultCountry: 'US' }, fileLabel: string): RecordOutcome<NormalizedContact>[] {
  return parsed.rows.map((row, i) => normalizeCsvRow(row, m, tenant, { sourceRef: `${fileLabel}#row=${parsed.rowNumbers[i] as number}` }));
}

/**
 * The optional CSV consent stage: one record per row whose consent columns say anything. The
 * provenance is the row ref plus the verbatim indicator summary (row-level provenance, R-IMPORT-13).
 * Rows the contacts stage rejected have no addresses and so produce nothing.
 */
export function csvConsentRecords(contacts: readonly RecordOutcome<NormalizedContact>[]): RecordOutcome<NormalizedConsent>[] {
  const out: RecordOutcome<NormalizedConsent>[] = [];
  for (const c of contacts) {
    const consent = c.record?.consent;
    if (!c.record || !consent) continue;
    if (consent.fields.addresses.length === 0 && consent.issues.length === 0) continue;
    const issues = [...consent.issues];
    if (consent.fields.addresses.length === 0) issues.push({ code: 'NO_CONSENT_DATA', severity: 'info' });
    const record: NormalizedConsent = {
      category: 'consent',
      sourceRef: c.sourceRef,
      personRef: personRefOf(c.record),
      fields: consent.fields,
      provenance: {
        source: 'csv',
        sourceRef: c.sourceRef,
        indicators: consent.fields.addresses.map((a) => ({ kind: a.kind, grants: a.grants, revokes: a.revokes, doNotContact: a.doNotContact })),
      },
    };
    out.push(finish(c.sourceRef, record, issues));
  }
  return out;
}
