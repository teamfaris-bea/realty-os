import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { type SourceText, containsWords, formatEvidence, locateQuote, normalizeForQuote, normalizeSnippet, sourceIndex, verifiedMatch, verifyQuote } from './evidence.js';
import { CALL, CALL_ID, CALL_START, LATE_SMS, LISTING, NOTE, SMS_ID } from './testing/fixtures.js';
import type { EvidenceRef } from './types.js';

const callRef = (snippet: string, startMs: number, endMs: number): EvidenceRef => ({
  sourceType: 'call',
  sourceId: CALL_ID,
  locator: { kind: 'transcript_offset', startMs, endMs },
  snippet,
});
const smsRef = (snippet: string): EvidenceRef => ({ sourceType: 'message', sourceId: SMS_ID, locator: { kind: 'message' }, snippet });

describe('verifyQuote (R-AST-2)', () => {
  it('R-AST-2 normalizes smart quotes, dashes, whitespace and case on both sides', () => {
    // source: 'Can’t talk now —  call me   TOMORROW, please!'
    expect(verifyQuote(LATE_SMS, smsRef("can't talk now - call me tomorrow"))).toEqual({ verified: true });
    expect(verifyQuote(LATE_SMS, smsRef('CAN’T TALK NOW — CALL ME TOMORROW, PLEASE!'))).toEqual({ verified: true });
    expect(verifyQuote(LATE_SMS, smsRef('call\nme\ttomorrow'))).toEqual({ verified: true });
    expect(verifyQuote(LATE_SMS, smsRef('“call me tomorrow”'))).toEqual({ verified: true });
  });

  it('R-AST-2 E33 a fabricated or paraphrased quote fails with NOT_FOUND', () => {
    expect(verifyQuote(LATE_SMS, smsRef('call me next week'))).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(CALL, callRef('we want a large yard for the dog', 30_000, 36_000))).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(CALL, callRef('list it at five hundred', 0, 42_000))).toEqual({ verified: false, reason: 'NOT_FOUND' });
  });

  it('R-AST-2 words inside the snippet are never dropped: only edge punctuation and wrapping quotes', () => {
    expect(verifyQuote(LATE_SMS, smsRef('call me, tomorrow'))).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(LATE_SMS, smsRef('call me … tomorrow'))).toEqual({ verified: false, reason: 'NOT_FOUND' });
  });

  it('R-AST-2 transcript quotes must fall within [start_ms, end_ms] ± one segment', () => {
    const q = 'call me Thursday around four';
    expect(verifyQuote(CALL, callRef(q, 22_000, 30_000))).toEqual({ verified: true }); // exact segment
    expect(verifyQuote(CALL, callRef(q, 15_000, 21_000))).toEqual({ verified: true }); // one segment before
    expect(verifyQuote(CALL, callRef(q, 31_000, 35_000))).toEqual({ verified: true }); // one segment after
    expect(verifyQuote(CALL, callRef(q, 9_000, 14_000))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' }); // two before
    expect(verifyQuote(CALL, callRef(q, 37_000, 41_000))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' }); // two after
    expect(verifyQuote(CALL, callRef(q, 30_000, 20_000))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' }); // inverted
  });

  it('R-AST-2 a quote spanning two segments verifies when both are in range', () => {
    expect(verifyQuote(CALL, callRef('around four. Oh, and we really want', 22_000, 36_000))).toEqual({ verified: true });
    expect(verifyQuote(CALL, callRef('around four. Oh, and we really want', 0, 4_000))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
  });

  it('R-AST-2 a range between or past the segments widens to the neighbouring segments', () => {
    const gap: SourceText = { ...CALL, segments: [{ startMs: 0, endMs: 1000, text: 'hello there' }, { startMs: 5000, endMs: 6000, text: 'call me friday' }] } as SourceText;
    expect(verifyQuote(gap, callRef('call me friday', 2000, 3000))).toEqual({ verified: true });
    expect(verifyQuote(gap, callRef('call me friday', 90_000, 95_000))).toEqual({ verified: true });
    expect(verifyQuote(gap, callRef('hello there', 90_000, 95_000))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
  });

  it('R-AST-2 a transcript quote with a non-transcript locator is out of range', () => {
    expect(verifyQuote(CALL, { ...callRef('call me Thursday', 0, 0), locator: { kind: 'message' } })).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
  });

  it('R-AST-2 char_range quotes must lie inside the range', () => {
    const text = NOTE.kind === 'text' ? NOTE.text : '';
    const start = text.indexOf('Wants to close');
    const ref = (s: number, e: number): EvidenceRef => ({ sourceType: 'note', sourceId: NOTE.sourceId, locator: { kind: 'char_range', start: s, end: e }, snippet: 'wants to close' });
    expect(verifyQuote(NOTE, ref(start, start + 14))).toEqual({ verified: true });
    expect(verifyQuote(NOTE, ref(0, 10))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
    expect(verifyQuote(NOTE, ref(10, 2))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
  });

  it('R-AST-2 field quotes must be in the named field', () => {
    const ref = (name: string, snippet: string): EvidenceRef => ({ sourceType: 'listing', sourceId: LISTING.sourceId, locator: { kind: 'field', name }, snippet });
    expect(verifyQuote(LISTING, ref('price', '$439,000'))).toEqual({ verified: true });
    expect(verifyQuote(LISTING, ref('address', '$439,000'))).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
    expect(verifyQuote(LISTING, ref('price', '$500,000'))).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(LISTING, ref('beds', '3'))).toEqual({ verified: true });
  });

  it('R-AST-2 a ref to a different source, an empty snippet or an over-long snippet is NOT_FOUND', () => {
    expect(verifyQuote(LATE_SMS, { ...smsRef('call me'), sourceId: '00000000-0000-7000-8000-00000000dead' })).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(LATE_SMS, { ...smsRef('call me'), sourceType: 'note' })).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(LATE_SMS, smsRef('  “” ... '))).toEqual({ verified: false, reason: 'NOT_FOUND' });
    expect(verifyQuote(LATE_SMS, smsRef(`call me ${'x'.repeat(600)}`))).toEqual({ verified: false, reason: 'NOT_FOUND' });
  });

  it('R-AST-2 source ids compare case-insensitively (uuid text forms)', () => {
    expect(verifyQuote(LATE_SMS, { ...smsRef('call me'), sourceId: SMS_ID.toUpperCase() })).toEqual({ verified: true });
  });

  it('R-AST-2 property: a message quote verifies exactly when its normalized form occurs in the normalized source as whole words', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.nat(), fc.nat(), fc.boolean(), (text, a, b, mutate) => {
        const src: SourceText = { kind: 'text', sourceType: 'message', sourceId: SMS_ID, text, at: at('2026-01-01T00:00:00Z'), author: 'client' };
        const s = Math.min(a, b) % (text.length + 1);
        const e = Math.max(a, b) % (text.length + 1);
        const snippet = text.slice(Math.min(s, e), Math.max(s, e)) + (mutate ? 'zq' : '');
        const needle = normalizeSnippet(snippet);
        const expected = containsWords(normalizeForQuote(text).text, needle);
        if (expected) expect(normalizeForQuote(text).text.includes(needle)).toBe(true);
        expect(verifyQuote(src, smsRef(snippet)).verified).toBe(expected);
      }),
    );
  });

  it('R-AST-2 property: a word-aligned substring of a source always verifies, whatever its case and spacing', () => {
    const word = fc.stringMatching(/^[A-Za-z0-9']{1,8}$/);
    fc.assert(
      fc.property(fc.array(word, { minLength: 1, maxLength: 12 }), fc.nat(), fc.nat(), (words, a, b) => {
        const text = words.join('  ');
        const i = Math.min(a, b) % words.length;
        const j = Math.max(a, b) % words.length;
        const snippet = words.slice(i, j + 1).join(' \n').toUpperCase();
        const src: SourceText = { kind: 'text', sourceType: 'message', sourceId: SMS_ID, text, at: at('2026-01-01T00:00:00Z'), author: 'client' };
        expect(verifyQuote(src, smsRef(snippet)).verified).toBe(normalizeSnippet(snippet) !== '');
      }),
    );
  });
});

describe('locateQuote / verifiedMatch', () => {
  it('R-AST-2 reports when the quoted words were said (call start + segment offset)', () => {
    const m = verifiedMatch(CALL, callRef('call me Thursday around four', 22_000, 30_000));
    expect(m?.at).toBe(CALL_START + 22_000);
    expect(m?.segFirst).toBe(4);
  });

  it('finds every occurrence and flags the in-range ones', () => {
    const src: SourceText = { kind: 'text', sourceType: 'message', sourceId: SMS_ID, text: 'yes. yes!', at: at('2026-01-01T00:00:00Z'), author: 'client' };
    const loc = locateQuote(src, { locator: { kind: 'char_range', start: 5, end: 9 }, snippet: 'yes' });
    expect(loc.found && loc.matches.map((m) => [m.rawStart, m.inRange])).toEqual([
      [0, false],
      [5, true],
    ]);
    expect(verifiedMatch(src, { ...smsRef('nope') })).toBeNull();
  });

  it('maps normalized offsets back to raw offsets across collapsed whitespace and astral characters', () => {
    const n = normalizeForQuote('  A😀  B ');
    expect(n.text).toBe('a😀 b');
    expect(n.map).toEqual([2, 3, 3, 5, 7]);
  });
});

describe('sourceIndex', () => {
  it('indexes by type:id (case-insensitive) and by handle', () => {
    const idx = sourceIndex([CALL, LATE_SMS]);
    expect(idx.byHandle.get('S1')).toBe(CALL);
    expect(idx.byKey.get(`message:${SMS_ID}`)).toBe(LATE_SMS);
    expect(idx.byKey.get(`call:${CALL_ID.toUpperCase()}`)).toBeUndefined();
  });
});

describe('formatEvidence (A2 display)', () => {
  it('renders source + locator + snippet, never a score', () => {
    expect(formatEvidence(callRef('“call me Thursday around four.”', 134_000, 140_000))).toBe('“call me Thursday around four” at 2:14 in the call');
    expect(formatEvidence(callRef('hi', 3_725_000, 3_730_000))).toBe('“hi” at 1:02:05 in the call');
    expect(formatEvidence(smsRef('call me tomorrow'))).toBe('“call me tomorrow” in the text');
    expect(formatEvidence({ sourceType: 'listing', sourceId: LISTING.sourceId, locator: { kind: 'field', name: 'list_price' }, snippet: '$439,000' })).toBe('“$439,000” (list price) on the listing');
    for (const s of ['email', 'note', 'import', 'behavior_event', 'deal', 'task', 'appointment'] as const) {
      expect(formatEvidence({ sourceType: s, sourceId: SMS_ID, locator: { kind: 'message' }, snippet: 'x' })).not.toMatch(/confidence|%/i);
    }
  });
});

describe('evidence edge cases', () => {
  it('sources without a handle are indexed by key only; null fields are skipped', () => {
    const noHandle: SourceText = { kind: 'text', sourceType: 'note', sourceId: SMS_ID, text: 'x', at: at('2026-01-01T00:00:00Z'), author: 'agent' };
    expect(sourceIndex([noHandle]).byHandle.size).toBe(0);
    const f: SourceText = { kind: 'fields', sourceType: 'listing', sourceId: SMS_ID, at: at('2026-01-01T00:00:00Z'), fields: { a: null, b: 'null' } };
    expect(verifyQuote(f, { sourceType: 'listing', sourceId: SMS_ID, locator: { kind: 'field', name: 'b' }, snippet: 'null' })).toEqual({ verified: true });
    expect(verifyQuote(f, { sourceType: 'listing', sourceId: SMS_ID, locator: { kind: 'field', name: 'a' }, snippet: 'null' })).toEqual({ verified: false, reason: 'OUT_OF_RANGE' });
  });
});

describe('formatEvidence on locators stored by code (module 55 verify 1)', () => {
  it('E662: a field locator stored with `field` (voice/handback.ts, comms/inbound.ts) is worded by that field; one with neither name nor field has no field words; it never throws', () => {
    expect(formatEvidence({ sourceType: 'call', sourceId: SMS_ID, locator: { kind: 'field', field: 'voice_outcome' } as never, snippet: 'booked' })).toBe('“booked” (voice outcome) in the call');
    expect(formatEvidence({ sourceType: 'call', sourceId: SMS_ID, locator: { kind: 'field' } as never, snippet: 'no_answer' })).toBe('“no_answer” in the call');
    expect(formatEvidence({ sourceType: 'call', sourceId: SMS_ID, locator: { kind: 'field', name: 7, field: 'status' } as never, snippet: 'x' })).toBe('“x” (status) in the call');
  });
});
