import { describe, expect, it } from 'vitest';
import { SMS_TEXT_MAX_UNITS, classifyGraphemes, gsm7Cost, isGsm7Char, smsSegments, splitParts } from './index.js';

const a = (n: number): string => 'a'.repeat(n);

describe('R-MMS-9 GSM-7 part boundaries', () => {
  it.each([
    [160, 1, 160],
    [161, 2, 153],
    [306, 2, 153],
    [307, 3, 153],
  ])('R-MMS-9: %i GSM characters take %i part(s), %i per part', (n, parts, perPart) => {
    const s = smsSegments(a(n));
    expect(s).toMatchObject({ encoding: 'gsm7', parts, units: n, perPart, special: [], gsmParts: parts, tooLong: false });
  });

  it('R-MMS-9: an extension character costs 2 septets', () => {
    expect(smsSegments('€').units).toBe(2);
    expect(smsSegments('{}[]~|^\\\f').units).toBe(18);
    expect(smsSegments(a(158) + '€')).toMatchObject({ parts: 1, units: 160 });
    expect(smsSegments(a(159) + '€')).toMatchObject({ parts: 2, units: 161 });
  });

  it('R-MMS-9: an extension character is never split across parts (152 a + € moves € to the next part)', () => {
    const text = a(152) + '€' + a(10);
    const s = smsSegments(text);
    expect(s).toMatchObject({ encoding: 'gsm7', parts: 2, units: 164, perPart: 153 });
    const parts = splitParts(text);
    expect(parts[0]).toBe(a(152));
    expect(parts[1]).toBe('€' + a(10));
  });

  it('R-MMS-9: "a\\r\\nb" is gsm7, 4 units, 1 part (CR LF counts as two septets)', () => {
    expect(smsSegments('a\r\nb')).toMatchObject({ encoding: 'gsm7', units: 4, parts: 1, special: [] });
    expect(classifyGraphemes('\r\n').map((g) => g.grapheme)).toEqual(['\r', '\n']);
  });

  it('R-MMS-9: empty text is 0 parts', () => {
    expect(smsSegments('')).toEqual({ encoding: 'gsm7', parts: 0, units: 0, perPart: 160, special: [], gsmParts: 0, tooLong: false });
    expect(splitParts('')).toEqual([]);
  });
});

describe('R-MMS-9 UCS-2', () => {
  it.each([
    [70, 1, 70],
    [71, 2, 67],
    [134, 2, 67],
    [135, 3, 67],
  ])('R-MMS-9: %i UCS-2 units take %i part(s)', (n, parts, perPart) => {
    const s = smsSegments('á' + a(n - 1));
    expect(s).toMatchObject({ encoding: 'ucs2', units: n, parts, perPart, special: ['á'] });
  });

  it.each([
    ['😀', 2],
    ['👍🏽', 4],
    ['🏳️‍🌈', 6],
  ])('R-MMS-9: %s costs %i units and is never split at the 67-unit boundary', (emoji, cost) => {
    expect(smsSegments(emoji)).toMatchObject({ encoding: 'ucs2', units: cost, parts: 1, special: [emoji] });
    const text = a(66) + emoji + a(10);
    const parts = splitParts(text);
    expect(parts[0]).toBe(a(66));
    expect(parts[1]).toBe(emoji + a(10));
    expect(smsSegments(text)).toMatchObject({ parts: 2, units: 76 + cost });
  });

  it.each([
    ['left single quote', '‘'],
    ['right single quote', '’'],
    ['left double quote', '“'],
    ['right double quote', '”'],
    ['em dash', '—'],
    ['ellipsis', '…'],
    ['bullet', '•'],
    ['no-break space', ' '],
    ['tab', '\t'],
    ['a acute', 'á'],
    ['c cedilla (lowercase)', 'ç'],
  ])('R-MMS-9: %s forces UCS-2 and is named in special', (_n, ch) => {
    const s = smsSegments(`Hi ${ch} there ${ch}`);
    expect(s.encoding).toBe('ucs2');
    expect(s.special).toEqual([ch]);
    expect(isGsm7Char(ch)).toBe(false);
  });

  it('R-MMS-9: Ç (U+00C7) is in the GSM-7 basic table; ESC (U+001B) is not a user character', () => {
    expect(smsSegments('Ça va')).toMatchObject({ encoding: 'gsm7', special: [] });
    expect(gsm7Cost('Ç')).toBe(1);
    expect(gsm7Cost('\u001b')).toBe(0);
    expect(gsm7Cost('€')).toBe(2);
    expect(gsm7Cost('ab')).toBe(0);
  });

  it('R-MMS-9: special lists distinct graphemes in order of first appearance', () => {
    expect(smsSegments('“hi” — ok “x”').special).toEqual(['“', '”', '—']);
  });

  it('R-MMS-9: every character of the basic and extension tables is GSM-7', () => {
    const basic = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
    expect(basic.length).toBe(127);
    expect(smsSegments(basic)).toMatchObject({ encoding: 'gsm7', units: 127 });
  });
});

describe('R-MMS-9 toll-free sender', () => {
  it('R-MMS-9: toll-free uses 152 septets and 66 units per part; single-part limits stay 160/70', () => {
    expect(smsSegments(a(160), { sender: 'toll_free' })).toMatchObject({ parts: 1, perPart: 160 });
    expect(smsSegments(a(304), { sender: 'toll_free' })).toMatchObject({ parts: 2, perPart: 152 });
    expect(smsSegments(a(305), { sender: 'toll_free' })).toMatchObject({ parts: 3, perPart: 152 });
    expect(smsSegments(a(306), { sender: 'local' })).toMatchObject({ parts: 2, perPart: 153 });
    expect(smsSegments('á' + a(69), { sender: 'toll_free' })).toMatchObject({ parts: 1, perPart: 70 });
    expect(smsSegments('á' + a(131), { sender: 'toll_free' })).toMatchObject({ parts: 2, perPart: 66 });
    expect(smsSegments('á' + a(132), { sender: 'toll_free' })).toMatchObject({ parts: 3, perPart: 66 });
  });
});

describe('R-MMS-9 length limit', () => {
  it('R-MMS-9: above 1600 units tooLong is true', () => {
    expect(SMS_TEXT_MAX_UNITS).toBe(1600);
    expect(smsSegments(a(1600)).tooLong).toBe(false);
    expect(smsSegments(a(1601)).tooLong).toBe(true);
    expect(smsSegments('😀'.repeat(801)).tooLong).toBe(true);
  });
});

describe('R-MMS-9 gsmParts', () => {
  it('R-MMS-9: "See you at 3 😊" has parts = gsmParts = 1', () => {
    expect(smsSegments('See you at 3 😊')).toMatchObject({ encoding: 'ucs2', parts: 1, gsmParts: 1, special: ['😊'] });
  });

  it('R-MMS-9: 98 a + one emoji (100 units) has parts 2 and gsmParts 1', () => {
    const s = smsSegments(a(98) + '😊');
    expect(s).toMatchObject({ encoding: 'ucs2', units: 100, parts: 2, gsmParts: 1 });
  });

  it('R-MMS-9: gsmParts counts extension characters at 2 septets', () => {
    expect(smsSegments('€'.repeat(80) + '😊')).toMatchObject({ gsmParts: 2 });
  });
});

describe('R-MMS-9 over-long graphemes', () => {
  it('R-MMS-9: a grapheme longer than a part is split between code points ("e" + 80 U+0301)', () => {
    const text = 'e' + '́'.repeat(80);
    expect(classifyGraphemes(text)).toHaveLength(1);
    const s = smsSegments(text);
    expect(s).toMatchObject({ encoding: 'ucs2', units: 81, parts: 2, perPart: 67 });
    const parts = splitParts(text);
    expect(parts.map((p) => p.length)).toEqual([67, 14]);
    expect(parts.join('')).toBe(text);
  });

  it('R-MMS-9: an over-long grapheme of astral code points is never split inside a surrogate pair', () => {
    // a base + 40 combining U+1D167 (astral combining mark, 2 units each) = 81 units in one grapheme
    const text = 'a' + '\u{1D167}'.repeat(40);
    const parts = splitParts(text);
    expect(parts.join('')).toBe(text);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(67);
      expect(/^[\uDC00-\uDFFF]/.test(p)).toBe(false);
      expect(/[\uD800-\uDBFF]$/.test(p)).toBe(false);
    }
    expect(parts.map((p) => p.length)).toEqual([67, 14]);
  });
});
