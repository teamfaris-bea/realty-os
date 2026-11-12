// Property and example tests of the pure contract-date finder and the claim decision (R-DOC-2, R-AST-1, R-AST-2,
// E131, E416, E417). Synthetic contract text only.
import { instant } from '@realty/core/foundation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideCandidate } from './decide.js';
import { type Candidate, LABELS_V1, MAX_CANDIDATES, SNIPPET_LIMIT, datesIn, findContractDates, hasRelativeDeadline, isoDate } from './finder.js';

const CTX = { documentId: '01900000-0000-7000-8000-00000000d0c1', uploadedAt: instant(Date.UTC(2027, 0, 1)) };
const page = (text: string, n = 1) => ({ page: n, text });

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const arbDate = fc.date({ min: new Date(Date.UTC(2001, 0, 1)), max: new Date(Date.UTC(2098, 11, 31)), noInvalidDate: true });
const arbFormat = fc.constantFrom('mdy', 'mdyy', 'long', 'iso');
function render(d: Date, f: string): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (f === 'mdy') return `${String(m).padStart(2, '0')}/${String(day).padStart(2, '0')}/${y}`;
  if (f === 'mdyy') return `${m}/${day}/${String(y).slice(2)}`;
  if (f === 'long') return `${MONTHS[m - 1]} ${day}, ${y}`;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const arbLabel = fc.constantFrom('Closing Date', 'Settlement', 'Inspection Period ends', 'Due Diligence deadline', 'Appraisal', 'Financing', 'Loan Commitment', 'Effective Date', 'Acceptance', 'Binding Agreement Date', 'Possession');
const filler = fc.stringMatching(/^[a-z ]{0,40}$/);

describe('findContractDates (R-DOC-2)', () => {
  it('R-DOC-2: every candidate\'s snippet is exactly page[start, end), at most 160 characters, and the snippet\'s last date is its dueOn', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbLabel, arbDate, arbFormat, filler), { minLength: 1, maxLength: 8 }), filler, (entries, tail) => {
        const text = `${entries.map(([l, d, f, fill]) => `${fill} ${l}: ${render(d, f)}.`).join(' ')} ${tail}`;
        const out = findContractDates([page(text)]);
        for (const c of out) {
          expect(c.snippet).toBe(text.slice(c.start, c.end));
          expect(c.snippet.length).toBeLessThanOrEqual(SNIPPET_LIMIT);
          expect(datesIn(c.snippet).at(-1)?.iso).toBe(c.dueOn);
          expect(decideCandidate(c, text, CTX).verified).toBe(true);
        }
        expect(out.length).toBeGreaterThan(0);
      }),
      { numRuns: 300 },
    );
  });

  it('R-DOC-2: the output is deterministic and in page order; at most 50 candidates', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(arbLabel, arbDate, arbFormat), { minLength: 0, maxLength: 80 }), (entries) => {
        const pages = entries.map(([l, d, f], i) => page(`${l}: ${render(d, f)}`, i + 1));
        const a = findContractDates(pages);
        expect(findContractDates([...pages].reverse())).toEqual(a);
        expect(a.length).toBeLessThanOrEqual(MAX_CANDIDATES);
        for (let i = 1; i < a.length; i++) expect(a[i]!.page).toBeGreaterThanOrEqual(a[i - 1]!.page);
      }),
    );
  });

  it('E416 R-DOC-2: a deadline written as a number of days is never a candidate, even when an absolute date follows it', () => {
    fc.assert(
      fc.property(arbLabel, fc.integer({ min: 1, max: 90 }), fc.constantFrom('days', 'calendar days', 'business days', 'day'), arbDate, arbFormat, (l, n, unit, d, f) => {
        const text = `${l}: within ${n} ${unit} after the date of ${render(d, f)}`;
        const out = findContractDates([page(text)]);
        expect(out.filter((c) => c.start === text.indexOf(l))).toEqual([]);
        expect(hasRelativeDeadline([page(text)])).toBe(true);
      }),
    );
    expect(findContractDates([page('Inspection Period: 10 days after Acceptance.')])).toEqual([]);
  });

  it('R-DOC-2: invalid calendar dates are dropped; a date beyond 80 characters or behind another label is not paired', () => {
    expect(isoDate(2027, 2, 29)).toBeNull();
    expect(isoDate(2028, 2, 29)).toBe('2028-02-29');
    expect(findContractDates([page('Closing Date: 02/30/2027')])).toEqual([]);
    expect(findContractDates([page(`Closing Date: ${'x'.repeat(81)} 01/15/2027`)])).toEqual([]);
    const two = findContractDates([page('Closing Date: Possession on 01/20/2027')]);
    expect(two.map((c) => [c.kind, c.dueOn])).toEqual([['possession', '2027-01-20']]);
  });

  it('R-DOC-2: each built-in label maps to its milestone, in every accepted date form', () => {
    const forms = ['01/15/2027', '1/15/27', 'January 15, 2027', '2027-01-15'];
    const cases: [string, string][] = [['Closing', 'closing'], ['Settlement Date', 'closing'], ['Inspection', 'inspection'], ['Due Diligence Period ends', 'inspection'], ['Appraisal', 'appraisal'], ['Financing contingency', 'financing'], ['Loan Commitment', 'financing'], ['Effective Date', 'acceptance'], ['Acceptance', 'acceptance'], ['Binding Agreement Date', 'acceptance'], ['Possession', 'possession']];
    for (const [label, kind] of cases) {
      for (const f of forms) expect(findContractDates([page(`${label}: ${f}`)]).map((c) => [c.kind, c.dueOn]), `${label} ${f}`).toEqual([[kind, '2027-01-15']]);
    }
    expect(LABELS_V1.map((l) => l.kind).sort()).toEqual(['acceptance', 'appraisal', 'closing', 'financing', 'inspection', 'possession']);
  });
});

describe('decideCandidate (R-AST-1, E131, E417)', () => {
  const text = 'Closing Date: 01/15/2027. Possession: 01/16/2027.';
  const good = findContractDates([page(text)])[0]!;

  it('E131 R-AST-1: a quote that is not in the PDF is needs_review', () => {
    const forged: Candidate = { ...good, snippet: 'Closing Date: 02/15/2027', dueOn: '2027-02-15' };
    expect(decideCandidate(forged, text, CTX)).toMatchObject({ verified: false, reason: 'QUOTE_NOT_VERIFIED' });
  });

  it('E417 R-AST-1: a real quote whose date differs from the proposed one is needs_review; a quote outside its range is needs_review', () => {
    expect(decideCandidate({ ...good, dueOn: '2027-01-16' }, text, CTX)).toMatchObject({ verified: false, reason: 'DATE_MISMATCH' });
    expect(decideCandidate({ ...good, start: good.end, end: good.end + 3 }, text, CTX)).toMatchObject({ verified: false, reason: 'QUOTE_NOT_VERIFIED' });
    expect(decideCandidate(good, text, CTX)).toMatchObject({ verified: true, evidence: { sourceType: 'document', locator: { kind: 'char_range', page: 1, start: 0 }, verified: true } });
  });

  it('E417 R-AST-1 (property): any change to the date or the range of a verified candidate never verifies a different date', () => {
    fc.assert(
      fc.property(arbDate, arbDate, arbFormat, (d1, d2, f) => {
        const t = `Closing Date: ${render(d1, f)}`;
        const c = findContractDates([page(t)])[0]!;
        const other = isoDate(d2.getUTCFullYear(), d2.getUTCMonth() + 1, d2.getUTCDate())!;
        const r = decideCandidate({ ...c, dueOn: other }, t, CTX);
        expect(r.verified).toBe(other === c.dueOn);
      }),
    );
  });
});
