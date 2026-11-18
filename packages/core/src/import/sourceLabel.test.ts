// R-LSRC-9 M1 (owner decision 2026-11-14, point 3: keep the raw label exactly as imported): a person's source label
// reaches the import record EXACTLY as the file or the other system gave it. Not trimmed, not re-cased, not normalized,
// not cut: two labels that differ in any character are two labels, and nobody infers that one means another. The labels
// here are made up.
import { describe, expect, it } from 'vitest';
import { MAX_CSV_ROWS, SOURCE_LABEL_MAX, mapFub, normalizeCsv, parseCsv, sourceLabel, suggestMapping, type Issue } from './index.js';
import { USERS, csvBytes } from './testing/fixtures.js';

const US = { defaultCountry: 'US' } as const;

function csvRow(sourceCell: string) {
  const quoted = `"${sourceCell.replace(/"/g, '""')}"`;
  const p = parseCsv(csvBytes(`Name,Email,Source\nJane,jane@example.com,${quoted}\n`), { maxRows: MAX_CSV_ROWS });
  if ('error' in p) throw new Error(`unexpected CSV error ${p.error.code}`);
  const [r] = normalizeCsv(p, suggestMapping(p.headers), US, 'leads.csv');
  if (!r) throw new Error('no row');
  return r;
}
const fubPerson = (source: unknown) => mapFub('contacts', { id: 7001, firstName: 'Jane', lastName: 'Doe', emails: [{ value: 'jane@example.com', type: 'home', status: 'Valid', isPrimary: 1 }], source }, USERS);
const labelOf = (r: { record: unknown }): unknown => (r.record as { leadSourceLabel?: unknown } | null)?.leadSourceLabel;

/** U+1F3E0, one character and two UTF-16 units. */
const HOUSE = '\u{1F3E0}';

describe('R-LSRC-9 M1: the source label is kept exactly as imported', () => {
  it('sourceLabel returns the string it was given: surrounding and inner whitespace, letter case and un-normalized characters are all kept', () => {
    const issues: Issue[] = [];
    for (const raw of ['  Northgate Referrals ', 'NORTHGATE  referrals', 'Northgate\tReferrals', 'Café walk-ins', 'Café walk-ins', 'x']) {
      expect(sourceLabel(raw, 'source', issues)).toBe(raw);
    }
    expect(issues).toEqual([]);
  });

  it('no label at all (missing, empty, or only whitespace) is null: that person belongs to the import\'s no-label group, never to a label', () => {
    const issues: Issue[] = [];
    for (const raw of [null, undefined, '', ' ', ' \t ', ' ', '\n']) expect(sourceLabel(raw, 'source', issues)).toBeNull();
    expect(issues).toEqual([]);
  });

  it('CSV: the cell is the label, character for character (the display copy in imported_fields may be tidied; the label is not)', () => {
    const raw = '  Northgate  REFERRALS (Café) ';
    const r = csvRow(raw);
    expect(r.status).toBe('valid');
    expect(labelOf(r)).toBe(raw);
    expect((r.record as { importedFields: Record<string, string> }).importedFields['Source']).toBe('Northgate REFERRALS (Café)');
  });

  it('CSV: an emoji that straddles the old 500-unit cut is not split, and a label longer than the cut is kept whole with no "shortened" issue on the label', () => {
    // units 0..498 are letters, the emoji takes units 499 and 500: slice(0, 500) would have kept half of it
    const raw = `${'a'.repeat(499)}${HOUSE}${'b'.repeat(300)}`;
    expect(raw.length).toBe(801);
    const r = csvRow(raw);
    const got = labelOf(r) as string;
    expect(got).toBe(raw);
    // the emoji is whole: no half of a surrogate pair is left anywhere
    expect(got.slice(499, 501)).toBe(HOUSE);
    expect([...got].filter((ch) => /^[\uD800-\uDFFF]$/.test(ch))).toEqual([]);
    expect([...got]).toHaveLength(800);
    expect(r.issues.filter((i) => i.field === 'lead_source')).toEqual([]);
  });

  it('CSV: two long labels that share their first 120 characters (the older cut) stay two labels', () => {
    const head = HOUSE.repeat(120);
    const a = labelOf(csvRow(`${head} east`));
    const b = labelOf(csvRow(`${head} west`));
    expect(a).toBe(`${head} east`);
    expect(b).toBe(`${head} west`);
    expect(a).not.toBe(b);
  });

  it('Follow Up Boss: the person\'s source is the label, character for character, at any length up to the bound', () => {
    const raw = ` Harbor Desk  ${HOUSE.repeat(260)} Partner `;
    const r = fubPerson(raw);
    expect(r.status).toBe('valid');
    expect(labelOf(r)).toBe(raw);
    expect(labelOf(fubPerson('   '))).toBeNull();
    expect(labelOf(fubPerson(null))).toBeNull();
  });

  it('a formula-looking label is still flagged for review (CSV injection) and still kept as written', () => {
    const r = csvRow('=cmd|x');
    expect(r.status).toBe('needs_review');
    expect(r.issues).toContainEqual({ code: 'FORMULA_PREFIX', severity: 'review', field: 'lead_source' });
    expect(labelOf(r)).toBe('=cmd|x');
  });

  it('a label that cannot be stored exactly (a NUL, half of a surrogate pair, or longer than the bound) rejects its record: it is never altered or cut to fit, and a rejected record blocks nobody', () => {
    for (const raw of ['North\u0000gate', `Northgate ${HOUSE.slice(0, 1)}`, `${HOUSE.slice(1)} Northgate`, 'n'.repeat(SOURCE_LABEL_MAX + 1)]) {
      const issues: Issue[] = [];
      expect(sourceLabel(raw, 'source', issues)).toBeNull();
      expect(issues).toEqual([{ code: 'SOURCE_LABEL_UNREADABLE', severity: 'error' }]);
      const r = fubPerson(raw);
      expect([r.status, r.record]).toEqual(['rejected', null]);
      expect(r.issues).toContainEqual({ code: 'SOURCE_LABEL_UNREADABLE', severity: 'error' });
    }
    // exactly at the bound it is kept
    const atBound = 'n'.repeat(SOURCE_LABEL_MAX);
    expect(labelOf(fubPerson(atBound))).toBe(atBound);
    // a file cannot carry a NUL at all: the parser refuses it whole before any row is read
    expect(parseCsv(csvBytes('Name,Email,Source\nJane,jane@example.com,North\u0000gate\n'), { maxRows: MAX_CSV_ROWS })).toEqual({ error: { code: 'CSV_BINARY' } });
  });
});
