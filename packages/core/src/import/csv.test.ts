import { describe, expect, it } from 'vitest';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import {
  MAX_CSV_ROWS,
  type ParsedCsv,
  csvConsentRecords,
  csvSafeCell,
  decodeText,
  mapImportedConsent,
  normalizeCsv,
  normalizeCsvRow,
  parseCsv,
  readConsentCell,
  suggestMapping,
} from './index.js';
import { T0, csvBytes, testKey } from './testing/fixtures.js';
import { sequentialIds } from '../foundation/index.js';
import { validateConsentEventSpec } from '../compliance/index.js';

const US = { defaultCountry: 'US' } as const;

function parsed(text: string, opts?: { bom?: boolean }): ParsedCsv {
  const r = parseCsv(csvBytes(text, opts), { maxRows: MAX_CSV_ROWS });
  if ('error' in r) throw new Error(`unexpected CSV error ${r.error.code}`);
  return r;
}

function rowsFor(text: string) {
  const p = parsed(text);
  return normalizeCsv(p, suggestMapping(p.headers), US, 'leads.csv');
}

describe('parseCsv: CSV edge rows (BUILD_PLAN module 6)', () => {
  it('strips a UTF-8 BOM from the first header', () => {
    const p = parsed('First Name,Phone\r\nJane,415-555-0132\r\n', { bom: true });
    expect(p.headers).toEqual(['First Name', 'Phone']);
    expect(p.encoding).toBe('utf-8');
    expect(suggestMapping(p.headers)[0]).toEqual({ field: 'first_name' });
  });

  it('decodes UTF-16 LE and BE files by their BOM', () => {
    const text = 'Name,Email\nJosé,jose@example.com\n';
    const le = new Uint8Array(2 + text.length * 2);
    const be = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const u = text.charCodeAt(i);
      le[2 + 2 * i] = u & 0xff;
      le[3 + 2 * i] = u >> 8;
      be[2 + 2 * i] = u >> 8;
      be[3 + 2 * i] = u & 0xff;
    }
    for (const bytes of [le, be]) {
      const r = parseCsv(bytes, { maxRows: 10 });
      expect('error' in r).toBe(false);
      if (!('error' in r)) expect(r.rows[0]).toEqual(['José', 'jose@example.com']);
    }
  });

  it('falls back to Windows-1252 for files that are not valid UTF-8 (Excel "CSV")', () => {
    // "Renée" in cp1252: é = 0xE9; a curly quote 0x92
    const bytes = new Uint8Array([...utf8ToBytes('Name\n'), 0x52, 0x65, 0x6e, 0xe9, 0x65, 0x92, 0x0a]);
    const r = parseCsv(bytes, { maxRows: 10 });
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.encoding).toBe('windows-1252');
      expect(r.rows[0]).toEqual(['Renée’']);
    }
  });

  it('rejects overlong and surrogate UTF-8 sequences instead of decoding them', () => {
    expect(decodeText(new Uint8Array([0xc0, 0xaf])).encoding).toBe('windows-1252');
    expect(decodeText(new Uint8Array([0xed, 0xa0, 0x80])).encoding).toBe('windows-1252');
    expect(decodeText(utf8ToBytes('😀 ok')).text).toBe('😀 ok');
  });

  it('keeps quoted newlines, quoted delimiters and doubled quotes inside one field', () => {
    const p = parsed('Name,Notes\n"Doe, Jane","Line 1\nLine 2 ""quoted"""\nBob,plain\n');
    expect(p.rows).toEqual([
      ['Doe, Jane', 'Line 1\nLine 2 "quoted"'],
      ['Bob', 'plain'],
    ]);
    // Row numbers are spreadsheet rows: the quoted newline does not create a row.
    expect(p.rowNumbers).toEqual([2, 3]);
  });

  it('handles CRLF, lone CR and a missing final newline', () => {
    expect(parsed('A,B\r\n1,2\r3,4').rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('skips blank lines but counts them for row numbers', () => {
    const p = parsed('Name\n\nJane\n , \nBob\n');
    expect(p.rows).toEqual([['Jane'], ['Bob']]);
    expect(p.rowNumbers).toEqual([3, 5]);
  });

  it('detects semicolon and tab delimiters from the header', () => {
    expect(parsed('Name;Phone\nJane;415-555-0132\n').rows[0]).toEqual(['Jane', '415-555-0132']);
    expect(parsed('Name\tPhone\nJane\t415-555-0132\n').delimiter).toBe('\t');
  });

  it('reports an unterminated quote with the line it started on', () => {
    expect(parseCsv(csvBytes('Name,Notes\nJane,"never closed\nmore\n'), { maxRows: 10 })).toEqual({ error: { code: 'CSV_UNTERMINATED_QUOTE', line: 2 } });
  });

  it('rejects empty, header-only-blank and binary files', () => {
    expect(parseCsv(csvBytes(''), { maxRows: 10 })).toEqual({ error: { code: 'CSV_EMPTY' } });
    expect(parseCsv(csvBytes('\n\n  \n'), { maxRows: 10 })).toEqual({ error: { code: 'CSV_EMPTY' } });
    expect(parseCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]), { maxRows: 10 })).toEqual({ error: { code: 'CSV_BINARY' } });
  });

  it('rejects absurd column counts and giant fields', () => {
    expect(parseCsv(csvBytes(`${Array.from({ length: 501 }, (_, i) => `c${i}`).join(',')}\n`), { maxRows: 10 })).toMatchObject({ error: { code: 'CSV_TOO_MANY_COLUMNS' } });
    expect(parseCsv(csvBytes(`Name\n"${'x'.repeat(40_000)}"\n`), { maxRows: 10 })).toMatchObject({ error: { code: 'CSV_FIELD_TOO_LARGE' } });
  });

  it('R-IMPORT-13 a CSV file holds at most 50,000 rows: 50,000 parse, 50,001 is refused, a larger maxRows is clamped', () => {
    const rows = (n: number) => `Name,Phone\n${Array.from({ length: n }, (_, i) => `P${i},+1415555${String(i % 10000).padStart(4, '0')}`).join('\n')}\n`;
    const ok = parseCsv(csvBytes(rows(50_000)), { maxRows: 50_000 });
    expect('error' in ok ? ok.error : ok.rows.length).toBe(50_000);
    expect(parseCsv(csvBytes(rows(50_001)), { maxRows: 50_000 })).toMatchObject({ error: { code: 'CSV_TOO_MANY_ROWS', limit: 50_000 } });
    expect(parseCsv(csvBytes(rows(50_001)), { maxRows: 1_000_000 })).toMatchObject({ error: { code: 'CSV_TOO_MANY_ROWS', limit: 50_000 } });
    expect(parseCsv(csvBytes(rows(11)), { maxRows: 10 })).toMatchObject({ error: { code: 'CSV_TOO_MANY_ROWS', limit: 10 } });
  });
});

describe('suggestMapping', () => {
  it('maps common headers, keeps repeats of multi-valued fields, and sends unknown headers to imported_fields', () => {
    const m = suggestMapping(['First Name', 'Last Name', 'E-mail', 'Cell Phone', 'Phone 2', 'Zip', 'Tags', 'Favorite Color', '', 'First Name', '__proto__']);
    expect(m).toEqual([
      { field: 'first_name' },
      { field: 'last_name' },
      { field: 'email' },
      { field: 'phone_mobile' },
      { field: 'phone' },
      { field: 'postal_code' },
      { field: 'tags' },
      { field: 'custom', key: 'Favorite Color' },
      { field: 'ignore' },
      { field: 'custom', key: 'First Name' },
      { field: 'ignore' },
    ]);
  });
});

describe('normalizeCsvRow', () => {
  it('E45 R-IMPORT-13 a phone without an area code ("555-0100") is rejected PHONE_INVALID with the reason in the review list', () => {
    const [jane, nobody] = rowsFor('Name,Phone\nJane Roe,555-0100\n,555-0100\n');
    expect(jane?.status).toBe('needs_review');
    expect(jane?.issues).toContainEqual({ code: 'PHONE_INVALID', severity: 'error', field: 'phone' });
    expect(jane?.record?.phones).toEqual([]);
    expect(nobody).toMatchObject({ status: 'rejected', record: null, sourceRef: 'leads.csv#row=3' });
    expect(nobody?.issues.map((i) => i.code)).toEqual(['PHONE_INVALID', 'NO_IDENTITY']);
  });

  it('R-IMPORT-13 phones normalize with the tenant default country (US), extensions kept apart', () => {
    const [r] = rowsFor('Name,Mobile,Work Phone\nJane,(415) 555-0132,"312.555.0145 x22"\n');
    expect(r?.status).toBe('valid');
    expect(r?.record?.phones).toEqual([
      { e164: '+14155550132', label: 'mobile', status: 'active', isPrimary: true },
      { e164: '+13125550145', extension: '22', label: 'work', status: 'active', isPrimary: false },
    ]);
  });

  it('splits several phones/emails in one cell, de-duplicates, lower-cases emails', () => {
    const [r] = rowsFor('Name,Email,Phone\nJane,"Jane@Example.com; jane@example.com,j2@example.com","415-555-0132 | 4155550132"\n');
    expect(r?.record?.emails.map((e) => e.email)).toEqual(['jane@example.com', 'j2@example.com']);
    expect(r?.record?.phones.map((p) => p.e164)).toEqual(['+14155550132']);
  });

  it('flags formula-prefixed values for review and keeps them verbatim as text (CSV injection)', () => {
    const [r] = rowsFor('First Name,Last Name,Phone,Notes\n"=HYPERLINK(""http://x"",""y"")",@SUM(A1),+1 415 555 0132,-cmd\n');
    expect(r?.status).toBe('needs_review');
    expect(r?.issues.filter((i) => i.code === 'FORMULA_PREFIX').map((i) => i.field).sort()).toEqual(['Notes', 'first_name', 'last_name']);
    expect(r?.record?.firstName).toBe('=HYPERLINK("http://x","y")');
    // A +1 phone is a phone, not a formula.
    expect(r?.record?.phones[0]?.e164).toBe('+14155550132');
    expect(csvSafeCell('=1+1')).toBe("'=1+1");
    expect(csvSafeCell('-5')).toBe('-5');
    expect(csvSafeCell('Jane')).toBe('Jane');
  });

  it('custom columns go to imported_fields (display-only); stage and type map with the original kept', () => {
    const [r] = rowsFor('Name,Email,Stage,Type,Favorite Color,Lead Source\nJane,j@example.com,Pending,Sphere,Teal,Open house\n');
    expect(r?.record).toMatchObject({
      stage: 'under_contract',
      contactType: 'sphere',
      leadSourceLabel: 'Open house',
      importedFields: { 'Favorite Color': 'Teal', 'Original stage': 'Pending', Source: 'Open house' },
    });
  });

  it('unknown stage keeps the default and is flagged; the original goes to imported_fields', () => {
    const [r] = rowsFor('Name,Email,Stage\nJane,j@example.com,Waiting on lender\n');
    expect(r?.record?.stage).toBe('new');
    expect(r?.issues).toContainEqual({ code: 'STAGE_UNMAPPED', severity: 'info', field: 'stage' });
    expect(r?.record?.importedFields['Original stage']).toBe('Waiting on lender');
  });

  it('splits a full name, restores a ZIP leading zero, de-duplicates tags case-insensitively', () => {
    const [r] = rowsFor('Name,Email,Address,City,State,Zip,Tags\nJane Q. Public,j@example.com,1 Elm,Boston,ma,2134,"Buyer, buyer,  VIP "\n');
    expect(r?.record).toMatchObject({ firstName: 'Jane Q.', lastName: 'Public', displayName: 'Jane Q. Public', tags: ['Buyer', 'VIP'] });
    expect(r?.record?.addresses).toEqual([{ kind: 'home', line1: '1 Elm', line2: null, city: 'Boston', region: 'MA', postalCode: '02134', country: 'US' }]);
  });

  it('an invalid postal code is dropped with POSTAL_INVALID; an invalid email with EMAIL_INVALID', () => {
    const [r] = rowsFor('Name,Email,Zip\nJane,not-an-email,ABCDE\n');
    expect(r?.status).toBe('needs_review');
    expect(r?.issues.map((i) => i.code).sort()).toEqual(['EMAIL_INVALID', 'POSTAL_INVALID']);
  });

  it('a row without a name uses an email or phone as display name and says so', () => {
    const [r] = rowsFor('Email\nsam@example.com\n');
    expect(r?.record?.displayName).toBe('sam@example.com');
    expect(r?.issues).toContainEqual({ code: 'NAME_MISSING', severity: 'info' });
  });

  it('extra cells beyond the header are noted, missing cells read as empty', () => {
    const [r] = normalizeCsv(parsed('Name,Email\nJane\nBob,b@example.com,surprise\n'), suggestMapping(['Name', 'Email']), US, 'f.csv');
    expect(r?.status).toBe('valid');
    const p = parsed('Name,Email\nBob,b@example.com,surprise\n');
    const [b] = normalizeCsv(p, suggestMapping(p.headers), US, 'f.csv');
    expect(b?.issues).toContainEqual({ code: 'EXTRA_CELLS', severity: 'info' });
  });

  it('never throws on hostile input', () => {
    const m = suggestMapping(['Name', 'Phone', 'Email', 'Zip']);
    for (const cell of ['\u0000', '￿'.repeat(5000), '"', 'x'.repeat(100_000), '١٢٣٤٥٦٧٨٩٠', '+999999999999999999']) {
      expect(() => normalizeCsvRow([cell, cell, cell, cell], m, US)).not.toThrow();
    }
  });
});

describe('CSV consent columns (R-IMPORT-13, R-CONSENT-3)', () => {
  it('reads consent cells strictly: yes → grant, opt-out words → revoke, a bare "no" is ambiguous, anything else unrecognized', () => {
    expect(['Yes', 'TRUE', '1', 'x', 'Opted In', '✓'].map(readConsentCell)).toEqual(Array(6).fill('yes'));
    expect(['Opted out', 'unsubscribed', 'STOP', 'DNC'].map(readConsentCell)).toEqual(Array(4).fill('revoke'));
    expect(['no', 'N', 'false', '0'].map(readConsentCell)).toEqual(Array(4).fill('ambiguous'));
    expect(['', '  '].map(readConsentCell)).toEqual(['empty', 'empty']);
    expect(['maybe', 'ask later'].map(readConsentCell)).toEqual(['unrecognized', 'unrecognized']);
  });

  it('R-IMPORT-13 a CSV consent column only produces imported_unverified grants or revocations, with row-level provenance', () => {
    const contacts = rowsFor(
      'Name,Phone,Email,SMS Consent,Email Consent,Opted Out,DNC\n' +
        'Jane,415-555-0132,j@example.com,Yes,yes,,\n' +
        'Bob,312-555-0145,b@example.com,yes,,yes,\n' +
        'Carl,646-555-0177,,,,,Yes\n' +
        'Dee,206-555-0199,,no,,,\n' +
        'Eve,206-555-0111,,maybe,,,\n' +
        'Fay,206-555-0122,,,,,\n',
    );
    const consent = csvConsentRecords(contacts);
    expect(consent.map((c) => [c.sourceRef, c.status])).toEqual([
      ['leads.csv#row=2', 'valid'],
      ['leads.csv#row=3', 'valid'],
      ['leads.csv#row=4', 'valid'],
      ['leads.csv#row=5', 'needs_review'],
      ['leads.csv#row=6', 'needs_review'],
    ]);
    const ids = sequentialIds();
    const specs = consent.flatMap((c, i) =>
      c.record ? mapImportedConsent(c.record.fields, c.record.provenance, { ids, now: T0, hmac: testKey, source: 'import_csv', contactId: null, importRecordId: `00000000-0000-7000-8000-00000000c00${i}` }) : [],
    );
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) {
      expect(validateConsentEventSpec(s)).toEqual([]);
      expect(s.imported).toBe(true);
      expect(s.originalProvenance).toMatchObject({ source: 'csv' });
      expect(s.eventType === 'grant' ? s.level === 'imported_unverified' : s.eventType === 'revoke' && s.level === 'none').toBe(true);
    }
    // Bob opted out: no grant survives for him, only revocations on every channel of every address.
    const bob = specs.filter((s) => s.originalProvenance?.['sourceRef'] === 'leads.csv#row=3');
    expect(bob.every((s) => s.eventType === 'revoke')).toBe(true);
    expect(bob.map((s) => s.channel).sort()).toEqual(['email', 'sms', 'voice']);
    // Dee's bare "no" is a revocation only after review; Eve's "maybe" produces nothing.
    expect(consent[3]?.issues).toContainEqual({ code: 'CONSENT_VALUE_AMBIGUOUS', severity: 'review', field: 'consent_sms' });
    expect(consent[4]?.record?.fields.addresses).toEqual([]);
  });
});
