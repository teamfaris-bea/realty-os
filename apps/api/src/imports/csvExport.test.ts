// CSV formula injection (OWASP "CSV Injection"): every CSV the API ever sends (error reports,
// rejected-row reports, any text/csv download) goes through csvExport.ts, which neutralises cells
// that a spreadsheet would evaluate and quotes every field.
import { parseCsv } from '@realty/core/import';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { csvField, neutralizeCsvCell, toCsv } from './csvExport.js';

describe('neutralizeCsvCell', () => {
  it('prefixes a single quote to cells starting with = + - @ tab or CR', () => {
    for (const v of ['=1+1', '=HYPERLINK("https://evil.example","x")', '+1 (415) 555-0100', '-5', '-2+3+cmd|\' /C calc\'!A0', '@SUM(A1:A2)', '\t=1', '\r=1', '+', '-', '=']) {
      expect([v, neutralizeCsvCell(v)]).toEqual([v, `'${v}`]);
    }
  });

  it('leaves every other cell exactly as it is', () => {
    for (const v of ['', 'Jane', ' =1', "'=already", '1-2', 'a=b', 'jane@example.com', '415-555-0100', '\n=1', 'Ünïcödé']) {
      expect([v, neutralizeCsvCell(v)]).toEqual([v, v]);
    }
  });
});

describe('csvField / toCsv', () => {
  it('quotes every text field, doubles embedded quotes, keeps commas and newlines inside the field', () => {
    expect(csvField('a "b", c\nd')).toBe('"a ""b"", c\nd"');
    expect(csvField('=1+1')).toBe('"\'=1+1"');
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
    expect(csvField(42)).toBe('42');
    expect(csvField(-5)).toBe('-5'); // a typed number cannot carry a formula
    expect(csvField(Number.NaN)).toBe('');
    expect(csvField(true)).toBe('true');
  });

  it('builds a CRLF file whose header and cells are all neutralised', () => {
    const out = toCsv(['Row', '=Reason'], [
      [2, '=cmd|"/C calc"!A0'],
      [3, 'PHONE_INVALID'],
    ]);
    expect(out).toBe('"Row","\'=Reason"\r\n2,"\'=cmd|""/C calc""!A0"\r\n3,"PHONE_INVALID"\r\n');
  });

  it('property: parsed back, no cell starts with a formula trigger and each is the value or the value with one quote prefixed', () => {
    fc.assert(
      fc.property(fc.array(fc.string({ unit: fc.constantFrom('=', '+', '-', '@', '\t', '\r', '\n', '"', ',', ';', "'", ' ', 'a', '1', 'é'), maxLength: 12 }), { minLength: 1, maxLength: 6 }), (cells) => {
        const parsed = parseCsv(new TextEncoder().encode(toCsv(cells.map((_, i) => `c${i}`), [cells])), { maxRows: 10 });
        if ('error' in parsed) return; // e.g. an all-blank row: nothing to evaluate either way
        for (const [i, got] of (parsed.rows[0] ?? []).entries()) {
          const v = cells[i] as string;
          expect(/^[=+\-@\t\r]/.test(got)).toBe(false);
          expect([v, `'${v}`]).toContain(got);
        }
      }),
      { numRuns: 300 },
    );
  });
});
