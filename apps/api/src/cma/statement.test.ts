// The statement rules (R-CMA-9 rule 5; E604, E605): printable, statementProminence and emailStatementOk, pinned to the
// PDF renderer's own winAnsi and SIZE, so a change there fails here (Documents lane, conflict note).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { SIZE, winAnsi } from '../providers/integrations/pdf.js';
import { canonicalText, emailStatementOk, fold, printable, statementProminence } from './statement.js';

describe('R-CMA-9 E604 printable', () => {
  it('E604 (a): ™, •, ², …, a ligature, an emoji, Đ, a tab and a lone CR are refused as SUBSTITUTED with their code points', () => {
    const cases: [string, string[]][] = [
      ['Statement™ text', ['U+2122']],
      ['• first point', ['U+2022']],
      ['area in m²', ['U+00B2']],
      ['and so on…', ['U+2026']],
      ['ﬁnal', ['U+FB01']],
      ['home 🏠 value', ['U+1F3E0']],
      ['Đà Nẵng', ['U+0110', 'U+1EB5']],
      ['a\tb', ['U+0009']],
      ['line one\rline two', ['U+000D']],
      ['™ and ™ again', ['U+2122']],
    ];
    for (const [text, cps] of cases) expect([text, printable(text)]).toEqual([text, { ok: false, codePoints: cps }]);
  });

  it('E604 (b): curly quotes, en and em dashes, NBSP and CRLF are allowed and kept as written (NFC, CRLF made LF)', () => {
    const t = '“Estimate” – it’s not an appraisal — see below.\r\nNext line.';
    expect(printable(t)).toEqual({ ok: true, text: '“Estimate” – it’s not an appraisal — see below.\nNext line.' });
    expect(printable('Café Ñandú, 1½')).toMatchObject({ ok: false }); // ½ is NFKC-folded to "1⁄2"
    expect(printable('Café Ñandú, ¼')).toMatchObject({ ok: false });
    expect(printable('Café Ñandú')).toEqual({ ok: true, text: 'Café Ñandú' });
    expect(printable('Café')).toEqual({ ok: true, text: 'Café' }); // NFC composes first
  });

  it('E604: the four folds are exactly the renderer\'s (pinned to pdf.ts winAnsi on printable ASCII and Latin-1)', () => {
    for (const ch of ['‘', '’', '“', '”', '–', '—', ' ']) expect([ch, winAnsi(ch)]).toEqual([ch, fold(ch)]);
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...' abcXYZ09.,;:!?"\'()-/éÑ¡ÿ\n'.split('')) }), (s) => {
        expect(printable(s)).toEqual({ ok: true, text: canonicalText(s) });
      }),
    );
    // anything refused would print differently in the PDF; anything allowed prints as its fold
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme-composite' }), (s) => {
        const p = printable(s);
        if (p.ok) expect(winAnsi(p.text)).toBe(fold(p.text));
        else expect(winAnsi(canonicalText(s))).not.toBe(fold(canonicalText(s)));
      }),
    );
  });
});

describe('R-CMA-9 E605 prominence', () => {
  it('E605: min ≤ 12 is body; 12.5, 14 and 18 heading; 18.5 and 28 display; 30 none; never small or footnote', () => {
    expect(SIZE).toEqual({ display: 28, heading: 18, body: 12, small: 9, footnote: 7 });
    const cases: [number, string | null][] = [
      [6, 'body'],
      [10, 'body'],
      [12, 'body'],
      [12.5, 'heading'],
      [14, 'heading'],
      [18, 'heading'],
      [18.5, 'display'],
      [28, 'display'],
      [28.01, null],
      [30, null],
      [Number.NaN, null],
    ];
    for (const [min, p] of cases) expect([min, statementProminence(min)]).toEqual([min, p]);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 40, noNaN: true }), (min) => {
        const p = statementProminence(min);
        if (p === null) expect(min).toBeGreaterThan(28);
        else {
          expect(SIZE[p]!).toBeGreaterThanOrEqual(Math.max(12, min));
          expect(['body', 'heading', 'display']).toContain(p);
        }
      }),
    );
  });

  it('E605 owner question e: a plain-text email carries a statement only when its minimum is ≤ 12 pt', () => {
    expect([10, 12, 12.5, 14, 30].map(emailStatementOk)).toEqual([true, true, false, false, false]);
    expect(emailStatementOk(Number.NaN)).toBe(false);
  });
});
