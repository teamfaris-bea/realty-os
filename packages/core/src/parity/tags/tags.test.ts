import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { caseSplits, singularForms } from './fold.js';
import { classifyProtected, DEFAULT_PROTECTED_LEXICON, normalizeTagName, protectedMatch, TAG_NAME_MAX, tagNameKey, tagReadsLikeOptOut } from './index.js';

describe('normalizeTagName (R-PAR-6)', () => {
  it('R-PAR-6 E165: "buyer" and "Buyer" (and full-width "Ｂｕｙｅｒ") share one key; the typed spelling is kept for display', () => {
    const a = normalizeTagName('Buyer');
    const b = normalizeTagName('buyer');
    const c = normalizeTagName('Ｂｕｙｅｒ');
    expect(a).toEqual({ ok: true, name: 'Buyer', key: 'buyer' });
    expect(b.ok && b.key).toBe('buyer');
    expect(c.ok && c.key).toBe('buyer');
  });

  it('R-PAR-6: stored trimmed with whitespace collapsed; invisible characters dropped; control characters refused', () => {
    expect(normalizeTagName('  Hot \t lead  ')).toEqual({ ok: true, name: 'Hot lead', key: 'hot lead' });
    expect(normalizeTagName('Ho​t')).toEqual({ ok: true, name: 'Hot', key: 'hot' });
    expect(normalizeTagName('a\u0007b')).toEqual({ ok: false, code: 'TAG_NAME_INVALID' });
    expect(normalizeTagName('   ')).toEqual({ ok: false, code: 'TAG_NAME_EMPTY' });
    expect(normalizeTagName('​')).toEqual({ ok: false, code: 'TAG_NAME_EMPTY' });
    expect(normalizeTagName('x'.repeat(65))).toEqual({ ok: false, code: 'TAG_NAME_TOO_LONG' });
    expect(normalizeTagName('😀'.repeat(64)).ok).toBe(true); // code points, as the DB's length()
    expect(normalizeTagName(42 as unknown as string)).toEqual({ ok: false, code: 'TAG_NAME_INVALID' });
  });

  it('R-PAR-6 property: an accepted name is trimmed, 1-64 code points, control-free, and normalizing it again is a fixed point', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'grapheme', maxLength: 80 }), (raw) => {
        const r = normalizeTagName(raw);
        if (!r.ok) return;
        expect(r.name).toBe(r.name.trim());
        expect([...r.name].length).toBeGreaterThanOrEqual(1);
        expect([...r.name].length).toBeLessThanOrEqual(TAG_NAME_MAX);
        // eslint-disable-next-line no-control-regex
        expect(/[\u0000-\u001f\u007f-\u009f]/u.test(r.name)).toBe(false);
        expect(normalizeTagName(r.name)).toEqual(r);
        expect(r.key).toBe(tagNameKey(r.name));
      }),
      { numRuns: 500 },
    );
  });
});

describe('opt-out look-alike tags (R-PAR-7)', () => {
  it('R-PAR-7 E167: "DNC", "Do not call", "Opt-out", "STOP", "Unsubscribed" read like an opt-out (the UI offers the real do-not-contact); others do not', () => {
    for (const n of ['DNC', ' dnc ', 'Do not contact', 'do-not-call', 'Opted out', 'opt_out', 'STOP', 'Unsubscribed']) expect(tagReadsLikeOptOut(n), n).toBe(true);
    for (const n of ['Buyer', 'Stop by open house', 'DNC list review', 'unsubscribe me later', '']) expect(tagReadsLikeOptOut(n), n).toBe(false);
  });
});

describe('classifyProtected (R-PAR-8, core module 20 lexicon)', () => {
  const PROTECTED = [
    'VA buyer', // E189
    'V.A. Buyer',
    'Vеteran', // Cyrillic е
    'Military status', // E175
    'PCS move',
    'Section 8',
    'Voucher holder',
    'Spanish speaking',
    'Perfect for families', // module 20 hard term
    'Kids', // module 20 soft term
    'Seniors',
    'Empty nesters',
    'Single mom',
    'Divorcing',
    'Church group',
    'Wheelchair user',
    'Pregnant',
    'Immigrant',
    'LGBTQ',
    'Family size', // module 20 attribute vocabulary
    'Household income',
    'Religion',
    'Active duty', // par-proxy/2 (the import's interim list)
    'Sexual orientation',
    // par-proxy/3: plurals, case boundaries and phrases written as one word, which the import's interim rule protected
    'Latinos', 'Latinas', 'Hispanics', 'Asians', 'Christians', 'Catholics', 'Muslims', 'Races', 'Churches', 'Babies', 'Disabilities',
    'Single moms', 'Single dads', 'Single parents', 'Green cards',
    'SpanishSpeaking', 'Spanishspeaking', 'ActiveDuty', 'Activeduty', 'ACTIVEDUTY', 'SingleMom', 'Singlemom', 'Singleparent', 'SingleMoms',
    'PCSmove', 'PCSMove', 'PCSing', 'VALoan', 'Valoan', 'VAbuyer', 'HasKids', 'MaritalStatus', 'SourceOfIncome', 'Section8Buyer', 'customSingleParents',
  ];
  const NOT_PROTECTED = ['Buyer', 'Seller', 'Hot', 'A-Lead', 'Pre-approved', 'First-time buyer', 'Investor', 'Sphere', 'Open house 5/12', 'Zillow', 'Referral',
    'Birthday', 'Home anniversary', 'Closing date', 'Move-in date', 'Price range', 'Lender', 'Interest rate', 'Family room', 'Single family', 'Church St listing', 'Pool', 'Condo',
    // whole words only: the interim rule's prefix matches ("va" in "Vacation", "race" in "Racecar") were never protection
    'Vacation home', 'Racecar', 'Value buyer', 'Valley view',
    // plurals and case boundaries of ordinary words stay ordinary
    'Buyers', 'Investors', 'Birthdays', 'Home anniversaries', 'Interests', 'Window blinds', 'Blinds', 'SingleFamily', 'FirstTimeBuyer', 'HotLead', 'LeadScore',
    // the lexicon's own words only, never Object.prototype's
    'constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'];

  it.each(PROTECTED)('R-PAR-8: "%s" is a protected proxy', (n) => expect(classifyProtected(n)).toBe(true));
  it.each(NOT_PROTECTED)('R-PAR-8: "%s" is not', (n) => expect(classifyProtected(n)).toBe(false));

  it('R-PAR-8: a match names its class and list (shown to the Admin); the lexicon is data', () => {
    expect(protectedMatch('VA buyer')).toEqual({ class: 'military_status', via: 'parity_proxy_word', text: 'va' });
    expect(protectedMatch('perfect for families')?.via).toBe('fair_housing_lexicon');
    const custom = { ...DEFAULT_PROTECTED_LEXICON, words: { ...DEFAULT_PROTECTED_LEXICON.words, pool: 'disability' as const } };
    expect(classifyProtected('Pool', custom)).toBe(true);
  });

  it('R-PAR-8 property: a protected word embedded in any tag still classifies (words around it never hide it)', () => {
    const words = ['va', 'veteran', 'section 8', 'seniors', 'kids', 'spanish'];
    fc.assert(
      fc.property(fc.constantFrom(...words), fc.stringMatching(/^[A-Za-z]{0,8}$/), fc.stringMatching(/^[A-Za-z]{0,8}$/), (w, pre, post) => {
        expect(classifyProtected(`${pre} ${w} ${post}`.trim())).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('R-PAR-8 par-proxy/3: a name is also read at its case boundaries (both readings of an acronym run) and a plural as its singular', () => {
    expect(caseSplits('ActiveDuty')).toEqual(['Active Duty', 'Active Duty']);
    expect(caseSplits('VALoan')).toEqual(['VA Loan', 'VAL oan']);
    expect(caseSplits('PCSmove')).toEqual(['PC Smove', 'PCS move']);
    expect(caseSplits('Section8Buyer')).toEqual(['Section8 Buyer', 'Section8 Buyer']);
    expect(caseSplits('Single mom')).toEqual(['Single mom', 'Single mom']);
    expect(singularForms('catholics')).toEqual(['catholics', 'catholic']);
    expect(singularForms('churches')).toEqual(['churches', 'church', 'churche']);
    expect(singularForms('families')).toEqual(['families', 'family', 'famili', 'familie']);
    expect(singularForms('class')).toEqual(['class']);
    // the explanation names the term found
    expect(protectedMatch('Single moms')).toEqual({ class: 'familial_status', via: 'parity_proxy_phrase', text: 'single mom' });
    expect(protectedMatch('Activeduty')).toEqual({ class: 'military_status', via: 'parity_proxy_phrase', text: 'active duty' });
    expect(protectedMatch('Catholics')).toEqual({ class: 'religion', via: 'parity_proxy_word', text: 'catholic' });
    expect(protectedMatch('PCSing')).toEqual({ class: 'military_status', via: 'parity_proxy_word', text: 'pcs' }); // "PCS ing"
    // a name that matched before par-proxy/3 keeps its explanation (read as typed first)
    expect(protectedMatch('VA buyer')).toEqual({ class: 'military_status', via: 'parity_proxy_word', text: 'va' });
  });

  it('R-PAR-8 property: a protected word, singular or plural, still classifies inside a camelCase compound and between other words', () => {
    const words = ['veteran', 'veterans', 'section 8', 'senior', 'seniors', 'kids', 'spanish', 'catholic', 'catholics', 'single mom', 'single moms', 'active duty', 'hispanic', 'hispanics'];
    const camel = (s: string) => s.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
    fc.assert(
      fc.property(fc.constantFrom(...words), fc.stringMatching(/^[A-Z][a-z]{1,7}$/), fc.stringMatching(/^(|[A-Z][a-z]{1,7})$/), (w, pre, post) => {
        expect(classifyProtected(`${pre}${camel(w)}${post}`)).toBe(true);
        expect(classifyProtected(`${pre} ${w} ${post}`.trim())).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
