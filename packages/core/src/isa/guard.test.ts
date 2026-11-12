import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { aiIdentityMissing, hasNumber, isaGuard, type IsaGuardCode } from './guard.js';
import { composeMessage, disclosureLine, signOffLine } from './lines.js';
import { IDENTITY, WHO } from './testing/fixtures.js';

const g = (text: string, channel: 'sms' | 'email' = 'sms') => isaGuard(text, { channel, identity: IDENTITY, sources: [] });
const codes = (text: string): IsaGuardCode[] => g(text).codes;

describe('R-ISA-7 the ISA guard passes plain conversation', () => {
  for (const t of ['Thanks for getting back to me! What part of town are you hoping to be in?', 'Got it. Are you hoping to move soon, or just starting to look?', 'Do you already have a lender you like, or are you paying cash?']) {
    it(`passes: "${t}"`, () => expect(g(t)).toEqual({ pass: true, codes: [], fallback: 'holding' }));
  }
});

describe('R-ISA-7 E506 a hostile model is blocked, with the class line as fallback', () => {
  const cases: [string, IsaGuardCode, 'pricing' | 'fair_housing' | 'holding'][] = [
    ['That one is listed at $450,000.', 'NUMBER_IN_MODEL_TEXT', 'holding'],
    ['It would cost about a grand more.', 'NUMBER_IN_MODEL_TEXT', 'holding'],
    ['Your home is worth a lot right now.', 'VALUATION_TERM', 'pricing'],
    ['Prices are rising in your area.', 'MARKET_CLAIM', 'pricing'],
    ["It's a seller's market, a good time to sell.", 'MARKET_CLAIM', 'pricing'],
    ['A home nearby just sold for more than asking.', 'MARKET_CLAIM', 'pricing'],
    ['The one on your street closed at a great number.', 'MARKET_CLAIM', 'pricing'],
    ['That house is bigger than yours.', 'COMPARATIVE_CLAIM', 'pricing'],
    ['This is a great deal.', 'COMPARATIVE_CLAIM', 'pricing'],
    ["You're booked for Tuesday!", 'COMMITMENT_TERM', 'holding'],
    ['I promise we will find it.', 'COMMITMENT_TERM', 'holding'],
    ['I guarantee a quick sale.', 'COMMITMENT_TERM', 'holding'],
    ['See it here: evil.example/listing', 'LINK_IN_MODEL_TEXT', 'holding'],
    ['Email me at someone@example.test', 'LINK_IN_MODEL_TEXT', 'holding'],
    ['It is a very safe, family-friendly area with good schools.', 'AREA_DESCRIPTOR', 'fair_housing'],
    ["Hi, I'm Jordan from the team.", 'IDENTITY', 'holding'],
    ["I'm a real person, don't worry.", 'IDENTITY', 'holding'],
    ['Twenty percent down is typical.', 'NUMBER_IN_MODEL_TEXT', 'holding'],
  ];
  for (const [text, code, fallback] of cases) {
    it(`${code}: "${text}"`, () => {
      const r = g(text);
      expect(r.pass).toBe(false);
      expect(r.codes).toContain(code);
      expect(r.fallback).toBe(fallback);
    });
  }
  it('empty and oversized text', () => {
    expect(codes('   ')).toContain('EMPTY');
    expect(codes('a'.repeat(241))).toContain('TOO_LONG');
    expect(isaGuard('a'.repeat(241), { channel: 'email', identity: IDENTITY, sources: [] }).codes).not.toContain('TOO_LONG');
  });
  it('money and contract topics, wires and hidden characters are blocked through the shared guards', () => {
    expect(codes('Should you make an offer?')).toContain('CONTENT_GUARD');
    expect(codes('Please wire the deposit')).toContain('SCREEN_FLAG');
    expect(codes('hel​lo there')).toContain('CONTENT_GUARD');
  });
  it('a fair-housing hard term is blocked with the area line', () => {
    const r = g('Perfect for a couple with no children.');
    expect(r.codes).toContain('FAIR_HOUSING');
    expect(r.fallback).toBe('fair_housing');
  });
});

describe('R-ISA-7 E506 property: numerals, number words and "a" amounts never pass', () => {
  it('any text with a digit fails', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), fc.integer({ min: 0, max: 9 }), fc.string({ maxLength: 40 }), (a, d, b) => {
        expect(isaGuard(`${a}${d}${b}`, { channel: 'email', identity: IDENTITY, sources: [] }).pass).toBe(false);
      }),
      { numRuns: 300 },
    );
  });
  it('number words and spoken amounts fail', () => {
    const words = ['one', 'two', 'three', 'ten', 'twenty', 'fifty', 'hundred', 'thousand', 'million', 'a grand', 'half a million', 'a dozen'];
    fc.assert(
      fc.property(fc.constantFrom(...words), fc.constantFrom('We could do ', 'Maybe ', 'About '), (w, lead) => {
        expect(hasNumber(`${lead}${w} more.`)).toBe(true);
        expect(g(`${lead}${w} more.`).pass).toBe(false);
      }),
    );
    expect(hasNumber('Sounds great, talk soon')).toBe(false);
    expect(hasNumber('٣ bedrooms')).toBe(true);
    expect(hasNumber('50%')).toBe(true);
  });
});

describe('R-ISA-7 AI_IDENTITY_MISSING: the platform disclosure and sign-off say "AI assistant"', () => {
  it('composeMessage adds them; the check passes', () => {
    const first = composeMessage({ body: 'What area are you looking in?', who: WHO, firstInThread: true, optOutHint: true, channel: 'sms' });
    expect(first).toBe("Hi, this is Avery's AI assistant at Example Realty LLC.\nWhat area are you looking in?\n— Avery's AI assistant, Example Realty LLC\nReply STOP to opt out.");
    expect(aiIdentityMissing(first, WHO, true)).toBe(false);
    const later = composeMessage({ body: 'Thanks!', who: WHO, firstInThread: false, optOutHint: false, channel: 'email' });
    expect(later).toBe("Thanks!\n\n— Avery's AI assistant, Example Realty LLC");
    expect(aiIdentityMissing(later, WHO, false)).toBe(false);
  });
  it('a message without the sign-off, or a first message without the disclosure, is refused', () => {
    expect(aiIdentityMissing('Thanks! — Avery', WHO, false)).toBe(true);
    expect(aiIdentityMissing(`Thanks!\n${signOffLine(WHO)}`, WHO, true)).toBe(true);
    expect(aiIdentityMissing(`${disclosureLine(WHO)}\nThanks!\n${signOffLine(WHO)}`, WHO, true)).toBe(false);
    expect(aiIdentityMissing(`Thanks!\n${signOffLine({ ...WHO, agentFirstName: 'AI' })}`.replace('AI assistant', 'helper'), { ...WHO, agentFirstName: 'AI' }, false)).toBe(true);
  });
});
