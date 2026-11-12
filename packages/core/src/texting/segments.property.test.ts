import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { classifyGraphemes, smsSegments, splitParts } from './index.js';

const GSM_CHARS = [...'@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà\f^{}\\[~]|€'];
const gsmChar = fc.constantFrom(...GSM_CHARS);
const gsmText = fc.array(gsmChar, { maxLength: 400 }).map((cs) => cs.join(''));
const anyText = fc.string({ unit: 'binary', maxLength: 400 });
const mixed = fc.oneof(gsmText, anyText, fc.array(fc.constantFrom('a', '😀', '👍🏽', '€', 'é', '́', '\r', '\n', 'ç'), { maxLength: 300 }).map((x) => x.join('')));
const sender = fc.constantFrom<'local' | 'toll_free'>('local', 'toll_free');

describe('R-MMS-9 properties', () => {
  it('R-MMS-9: parts never decrease as GSM characters are appended', () => {
    fc.assert(
      fc.property(mixed, gsmChar, sender, (text, ch, s) => {
        expect(smsSegments(text + ch, { sender: s }).parts).toBeGreaterThanOrEqual(smsSegments(text, { sender: s }).parts);
      }),
    );
  });

  it('R-MMS-9: a non-empty text never has 0 parts, and parts match the split', () => {
    fc.assert(
      fc.property(mixed, sender, (text, s) => {
        const r = smsSegments(text, { sender: s });
        if (text.length > 0) expect(r.parts).toBeGreaterThan(0);
        expect(splitParts(text, { sender: s })).toHaveLength(r.parts);
        expect(r.gsmParts).toBeLessThanOrEqual(r.parts);
      }),
    );
  });

  it('R-MMS-9: units equal the sum of grapheme costs (after CR LF split)', () => {
    fc.assert(
      fc.property(mixed, (text) => {
        const r = smsSegments(text);
        const gs = classifyGraphemes(text);
        const cost = r.encoding === 'gsm7' ? gs.reduce((n, g) => n + g.gsm, 0) : gs.reduce((n, g) => n + g.ucs2, 0);
        expect(r.units).toBe(cost);
        expect(r.encoding === 'gsm7').toBe(gs.every((g) => g.gsm > 0));
      }),
    );
  });

  it('R-MMS-9: any binary string (lone surrogates included) is counted, parts rejoin to it, and no pair is cut', () => {
    fc.assert(
      fc.property(anyText, sender, (text, s) => {
        const r = smsSegments(text, { sender: s });
        const parts = splitParts(text, { sender: s });
        expect(parts.join('')).toBe(text);
        if (r.encoding === 'ucs2') {
          expect(r.units).toBe(text.length);
          for (const p of parts) expect(p.length).toBeLessThanOrEqual(r.perPart);
        }
        for (let i = 1; i < parts.length; i++) {
          expect(/[\uD800-\uDBFF]$/.test(parts[i - 1]!) && /^[\uDC00-\uDFFF]/.test(parts[i]!)).toBe(false);
        }
      }),
    );
  });

  it('R-MMS-9: for well-formed full-Unicode text no part starts with a low surrogate or ends with a high surrogate', () => {
    const scalar = fc.integer({ min: 0, max: 0x10ffff }).filter((cp) => cp < 0xd800 || cp > 0xdfff);
    const wellFormed = fc.array(fc.oneof(scalar, fc.constantFrom(0x301, 0x1d167, 0x200d, 0x1f600, 0x1f3fd)), { maxLength: 300 }).map((cps) => String.fromCodePoint(...cps));
    fc.assert(
      fc.property(wellFormed, sender, (text, s) => {
        const parts = splitParts(text, { sender: s });
        expect(parts.join('')).toBe(text);
        for (const p of parts) {
          expect(/^[\uDC00-\uDFFF]/.test(p)).toBe(false);
          expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
        }
      }),
    );
  });
});
