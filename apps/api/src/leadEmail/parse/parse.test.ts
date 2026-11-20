// Lead-email parsing (R-INBOX-9, E78, E153). Every vendor fixture is SYNTHETIC (see ./fixtures.ts).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isValidEmail } from './fields.js';
import { isOwnAddress } from './extract.js';
import { isConsumerMailboxDomain } from '../trust.js';
import {
  CATALOG_PORTAL_DOMAINS,
  GENERIC,
  GENERIC_HTML,
  LEADMETA_BODY_HTML,
  LEADMETA_DUPLICATE_HTML,
  LEADMETA_ESCAPED_HTML,
  LEADMETA_HEAD_HTML,
  LEADMETA_HOSTILE_HTML,
  LEADMETA_UNKNOWN_VERSION_HTML,
  NEWSLETTER_TEXT,
  REALTOR,
  REALTOR_HTML,
  ZILLOW,
  ZILLOW_CHANGED_TEXT,
  ZILLOW_HTML,
  catalogLabelled,
  catalogUnlabelled,
  forwardedByHand,
} from './fixtures.js';
import {
  type Field,
  type ParsedLead,
  type ParseInput,
  type ParseResult,
  MAX_INPUT_CHARS,
  PORTAL_DOMAINS,
  cleanField,
  normalizeBody,
  parseLeadEmail,
  scanLeadMetadata,
} from './index.js';

// eslint-disable-next-line no-control-regex -- the property under test is the absence of control characters
const FORBIDDEN = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/;

const okLead = (r: ParseResult): ParsedLead => {
  if (!r.ok) throw new Error(`expected ok, got ${r.reason}`);
  return r.lead;
};
const leadOf = (r: ParseResult): ParsedLead | null => (r.ok ? r.lead : r.partial);
const fieldsOf = (l: ParsedLead): Array<[string, Field]> => {
  const out: Array<[string, Field]> = [];
  for (const k of ['name', 'message', 'property', 'listingId'] as const) {
    const f = l[k];
    if (f) out.push([k, f]);
  }
  for (const f of l.phones) out.push(['phone', f]);
  for (const f of l.emails) out.push(['email', f]);
  return out;
};
const CAPS: Record<string, number> = { name: 120, message: 2000, property: 300, listingId: 64, phone: 40 };
/** text.slice(span) is the raw value: the value is its cleaned (emails: lowercased) form */
const expectSpans = (r: ParseResult) => {
  const l = leadOf(r);
  if (!l) return;
  for (const [k, f] of fieldsOf(l)) {
    expect(f.span.start).toBeGreaterThanOrEqual(0);
    expect(f.span.end).toBeLessThanOrEqual(r.text.length);
    expect(f.span.start).toBeLessThanOrEqual(f.span.end);
    const raw = r.text.slice(f.span.start, f.span.end);
    if (k === 'email') expect(raw.toLowerCase()).toBe(f.value);
    else expect(cleanField(raw, CAPS[k]!)).toBe(f.value);
  }
};
const generic = (text: string, senderDomain: string | null = 'forms.agent-site.test', subject: string | null = null): ParseInput => ({ subject, text, html: null, senderDomain });
const zillow = (text: string, subject: string | null = null): ParseInput => ({ subject, text, html: null, senderDomain: 'mail.zillow.com' });

describe('happy paths (SYNTHETIC fixtures)', () => {
  it('R-INBOX-9: a Zillow lead yields every field', () => {
    const r = parseLeadEmail(ZILLOW);
    const l = okLead(r);
    expect(l.format).toBe('zillow');
    expect(l.name?.value).toBe('Jane Q. Buyer');
    expect(l.emails.map((e) => e.value)).toEqual(['jane.buyer@example.test']);
    expect(l.phones.map((p) => p.value)).toEqual(['(555) 555-0127']);
    expect(l.property?.value).toBe('123 Maple Street, Springfield, IL 62704');
    expect(l.postalCode).toBe('62704');
    expect(l.listingId?.value).toBe('2081234567');
    expect(l.message?.value).toBe('Hi, I would like to see this home. I am free on weekends.');
    expect(l.leadType).toBe('buy');
    expectSpans(r);
  });

  it('R-INBOX-9: a Realtor.com lead yields every field', () => {
    const r = parseLeadEmail(REALTOR);
    const l = okLead(r);
    expect(l.format).toBe('realtor');
    expect(l.name?.value).toBe('John Doe');
    expect(l.emails.map((e) => e.value)).toEqual(['john.doe@example.test']);
    expect(l.phones.map((p) => p.value)).toEqual(['+1 555.555.0147']);
    expect(l.property?.value).toBe('456 Oak Ave, Austin, TX 78701-1234');
    expect(l.postalCode).toBe('78701');
    expect(l.listingId?.value).toBe('TX-998877');
    expect(l.message?.value).toBe('I want to sell my home this spring.');
    expect(l.leadType).toBe('sell');
    expectSpans(r);
  });

  it('R-INBOX-9: a generic labelled lead yields every field (bullets, multi-line message)', () => {
    const r = parseLeadEmail(GENERIC);
    const l = okLead(r);
    expect(l.format).toBe('generic');
    expect(l.name?.value).toBe('Maria Garcia');
    expect(l.emails.map((e) => e.value)).toEqual(['maria@example.test']);
    expect(l.phones.map((p) => p.value)).toEqual(['555 555 0129']);
    expect(l.property?.value).toBe('9 Elm Ct, Portland, OR 97201');
    expect(l.postalCode).toBe('97201');
    expect(l.listingId?.value).toBe('ABC-123');
    expect(l.message?.value).toBe('Looking for a 2 bedroom place. Pets ok?');
    expect(l.leadType).toBe('rent');
    expectSpans(r);
  });

  it('HTML-only variants parse like their text forms; script, comments and link URLs never leak', () => {
    const z = parseLeadEmail({ ...ZILLOW, text: null, html: ZILLOW_HTML });
    const zl = okLead(z);
    expect(zl.format).toBe('zillow');
    expect(zl.name?.value).toBe('Jane Q. Buyer');
    expect(zl.emails.map((e) => e.value)).toEqual(['jane.buyer@example.test']);
    expect(zl.phones.map((p) => p.value)).toEqual(['(555) 555-0127']);
    expect(zl.property?.value).toBe('123 Maple Street, Springfield, IL 62704');
    expect(zl.listingId?.value).toBe('2081234567');
    expect(zl.message?.value).toBe("Hi, I'd like to see this home & its yard.");
    expect(z.text).not.toContain('attacker.test');
    expect(z.text).not.toContain('https://');
    expect(z.text).not.toContain('mailto:');
    expectSpans(z);

    const rr = parseLeadEmail({ ...REALTOR, text: '', html: REALTOR_HTML });
    const rl = okLead(rr);
    expect(rl.format).toBe('realtor');
    expect(rl.listingId?.value).toBe('TX-998877');
    expect(rl.message?.value).toBe('I want to sell my home this spring.');
    expectSpans(rr);

    const g = parseLeadEmail({ ...GENERIC, text: '  \n ', html: GENERIC_HTML });
    const gl = okLead(g);
    expect(gl.format).toBe('generic');
    expect(gl.message?.value).toBe('Looking for a 2 bedroom place. Pets ok?');
    expect(gl.leadType).toBe('rent');
    expectSpans(g);
  });

  it('the text part wins over the html part when both are present', () => {
    const r = parseLeadEmail({ ...GENERIC, html: '<p>Name: Other</p><p>Email: other@example.test</p>' });
    expect(okLead(r).emails.map((e) => e.value)).toEqual(['maria@example.test']);
  });
});

describe('R-INBOX-9: spans, empty fields, review', () => {
  it('R-INBOX-9: every extracted field cites its source span', () => {
    for (const input of [ZILLOW, REALTOR, GENERIC, { ...ZILLOW, text: null, html: ZILLOW_HTML }, { ...GENERIC, text: null, html: GENERIC_HTML }]) {
      const r = parseLeadEmail(input);
      expect(r.ok).toBe(true);
      expectSpans(r);
    }
    // spans index the normalized body: CRLF and NFKC (fullwidth letters) are applied first
    const r = parseLeadEmail(generic('Ｎａｍｅ： Ａｎｎ\r\nEmail: ann@example.test\r\n'));
    const l = okLead(r);
    expect(l.name?.value).toBe('Ann');
    expect(r.text.slice(l.name!.span.start, l.name!.span.end)).toBe('Ann');
    expectSpans(r);
  });

  it('R-INBOX-9: a field not found stays empty', () => {
    const l = okLead(parseLeadEmail(generic('Name: Ann Lee\nEmail: ann@example.test')));
    expect(l.phones).toEqual([]);
    expect(l.message).toBeNull();
    expect(l.property).toBeNull();
    expect(l.listingId).toBeNull();
    expect(l.postalCode).toBeNull();
    expect(l.leadType).toBe('general');
  });

  it('R-INBOX-9: no phone and no email ⇒ NO_CONTACT_POINT (review), with the partial lead', () => {
    const r = parseLeadEmail(generic('Name: Ann Lee\nEmail: not an address\nPhone: call me\nMessage: hello'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('NO_CONTACT_POINT');
    expect(r.partial?.format).toBe('generic');
    expect(r.partial?.name?.value).toBe('Ann Lee');
    expect(r.partial?.message?.value).toBe('hello');
    expect(r.partial?.emails).toEqual([]);
    expect(r.partial?.phones).toEqual([]);

    const z = parseLeadEmail(zillow('New lead from Zillow\nName: Ann Lee\nProperty: 1 Main St, Reno, NV 89501'));
    expect(z).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT', partial: { format: 'zillow', postalCode: '89501' } });
  });

  it('postal code: last 5-digit ZIP of the property; ZIP+4 → 5 digits; none ⇒ null', () => {
    const p = (prop: string) => okLead(parseLeadEmail(generic(`Name: A B\nEmail: a@example.test\nProperty: ${prop}`))).postalCode;
    expect(p('12345 Long Rd, Dallas, TX 75201')).toBe('75201');
    expect(p('1 Main St, Austin, TX 78701-1234')).toBe('78701');
    expect(p('Lot 7, Unit 123456')).toBeNull();
    expect(p('Cozy loft downtown')).toBeNull();
  });

  it('listing id: [A-Za-z0-9-] ≤ 64, an optional leading # is skipped, otherwise null', () => {
    const id = (v: string) => okLead(parseLeadEmail(generic(`Name: A B\nEmail: a@example.test\nMLS #: ${v}`))).listingId?.value ?? null;
    expect(id('#A1-2')).toBe('A1-2');
    expect(id('A1 2')).toBeNull();
    expect(id('x'.repeat(65))).toBeNull();
    expect(id('x'.repeat(64))).toBe('x'.repeat(64));
    expect(id('../../etc')).toBeNull();
  });

  it('lead type: explicit label first, then vendor keywords (subject, then earliest in body)', () => {
    const t = (body: string, subject: string | null = null) => leadOf(parseLeadEmail(zillow(`Zillow lead\nEmail: a@example.test\n${body}`, subject)))!.leadType;
    expect(t('Interested in: renting', 'New buyer lead')).toBe('rent');
    expect(t('', 'Seller lead')).toBe('sell');
    expect(t('A renter contacted you')).toBe('rent');
    expect(t('Message: what is my home value?')).toBe('value');
    expect(t('Your Zestimate request')).toBe('value');
    expect(t('Message: I want to sell my home')).toBe('sell');
    expect(t('Message: Please schedule a tour')).toBe('buy');
    expect(t('Message: hello')).toBe('general');
    const g = (v: string) => okLead(parseLeadEmail(generic(`Name: A B\nEmail: a@example.test\nType: ${v}`))).leadType;
    expect(g('Buying')).toBe('buy');
    expect(g('Selling')).toBe('sell');
    expect(g('Home valuation')).toBe('value');
    expect(g('lease')).toBe('rent');
    expect(g('other')).toBe('general');
    // the generic format reads no keywords from the body
    expect(okLead(parseLeadEmail(generic('Name: A B\nEmail: a@example.test\nMessage: I am a buyer'))).leadType).toBe('general');
  });

  it('subject fallback for the property only when the text also appears in the body (a field always has a span)', () => {
    const body = 'Zillow lead\nEmail: a@example.test\nAbout 77 Pine Rd, Boise, ID 83702 and more';
    const l = okLead(parseLeadEmail(zillow(body, 'New inquiry for 77 Pine Rd, Boise, ID 83702')));
    expect(l.property?.value).toBe('77 Pine Rd, Boise, ID 83702');
    expect(l.postalCode).toBe('83702');
    const absent = okLead(parseLeadEmail(zillow('Zillow lead\nEmail: a@example.test', 'New inquiry for 77 Pine Rd')));
    expect(absent.property).toBeNull();
    // never for the generic format
    expect(okLead(parseLeadEmail(generic(`Name: A B\nEmail: a@example.test\n77 Pine Rd`, null, 'New inquiry for 77 Pine Rd'))).property).toBeNull();
  });

  it('phones: 10–15 digits as written, optional +1/1, no letters; emails lowercased; max 5 each, deduped', () => {
    const phones = ['555-555-0126', '(555) 555-0126', '+1 555 555 0126', '1-555-555-0130', '+44 20 7946 0958', '555 111 22', '555-CALL-NOW', '555 555 0126 ext 5', '1234567890123456'];
    const l = okLead(parseLeadEmail(generic(['Name: A B', ...phones.map((p) => `Phone: ${p}`)].join('\n'))));
    expect(l.phones.map((p) => p.value)).toEqual(['555-555-0126', '1-555-555-0130', '+44 20 7946 0958']);
    const many = okLead(parseLeadEmail(generic(['Name: A B', ...Array.from({ length: 8 }, (_, i) => `Email: P${i}@Example.test`), 'Email: p0@example.test'].join('\n'))));
    expect(many.emails.map((e) => e.value)).toEqual(['p0@example.test', 'p1@example.test', 'p2@example.test', 'p3@example.test', 'p4@example.test']);
    const manyPhones = okLead(parseLeadEmail(generic(['Name: A B', ...Array.from({ length: 8 }, (_, i) => `Phone: 555-555-010${i}`)].join('\n'))));
    expect(manyPhones.phones).toHaveLength(5);
  });

  it('name: must contain a letter, no @ < >, capped at 120', () => {
    const n = (v: string) => leadOf(parseLeadEmail(generic(`Name: ${v}\nEmail: a@example.test`)))!.name?.value ?? null;
    expect(n('12345')).toBeNull();
    expect(n('Ann <ann@example.test>')).toBeNull();
    expect(n('ann@example.test')).toBeNull();
    expect(n('José Núñez')).toBe('José Núñez');
    expect(n('A'.repeat(500))).toBe('A'.repeat(120));
  });
});

describe('header injection and invisible characters', () => {
  it('a Name value carrying CRLF + Bcc never yields a Bcc header or address', () => {
    const r = parseLeadEmail(generic('Name: Eve\r\nBcc: x@evil.test\r\nEmail: eve@example.test'));
    const l = okLead(r);
    expect(l.name?.value).toBe('Eve');
    expect(l.emails.map((e) => e.value)).toEqual(['eve@example.test']);
  });

  it('a phone line with "\\r\\nTo:" yields only the phone', () => {
    const l = okLead(parseLeadEmail(generic('Name: Eve\nPhone: 555-555-0127\r\nTo: victim@evil.test')));
    expect(l.phones.map((p) => p.value)).toEqual(['555-555-0127']);
    expect(l.emails).toEqual([]);
  });

  it('an email value with an injected header: the injected address never becomes an email; an in-line injection is rejected', () => {
    const l = okLead(parseLeadEmail(generic('Name: Eve\nEmail: a@b.test\r\nBcc: c@d.test')));
    expect(l.emails.map((e) => e.value)).toEqual(['a@b.test']);
    // a line separator (not split by normalizeBody) inside the value ⇒ the whole value is rejected
    const r = parseLeadEmail(generic('Name: Eve\nEmail: a@b.test\u2028Bcc: c@d.test'));
    expect(r).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT' });
    expect(isValidEmail('a@b.test\r\nBcc: c@d.test')).toBe(false);
    expect(isValidEmail('a@b.test\u202E')).toBe(false);
    expect(isValidEmail('"a b"@b.test')).toBe(false);
    expect(isValidEmail('<a@b.test>')).toBe(false);
    expect(isValidEmail('a@b.test,c@d.test')).toBe(false);
    expect(isValidEmail('a@b.test;c@d.test')).toBe(false);
  });

  it('bidi overrides, U+2028/2029 and controls are stripped from every value', () => {
    const r = parseLeadEmail(generic('Name: \u202EevE\u202C Smith\u2028Bcc: x\nPhone: 555\u2066-555-0127\u2069\nMessage: hi\u2029there\u0085now\u200F'));
    const l = okLead(r);
    expect(l.name?.value).toBe('evE Smith Bcc: x');
    expect(l.phones.map((p) => p.value)).toEqual(['555-555-0127']);
    // U+0085 (NEL) is a C1 control: normalizeBody already removed it
    expect(l.message?.value).toBe('hi therenow');
    for (const [, f] of fieldsOf(l)) expect(f.value).not.toMatch(FORBIDDEN);
    expectSpans(r);
  });

  it('cleanField strips CR, LF, C0/C1, U+2028/2029 and bidi overrides, collapses whitespace, trims and caps', () => {
    expect(cleanField('  Eve\r\nBcc: x@evil.test  ', 100)).toBe('Eve Bcc: x@evil.test');
    expect(cleanField('a\u0000b\u0007c\u009Fd\u007F', 100)).toBe('abcd');
    expect(cleanField('\u202Aa\u202B\u202C\u202D\u202Eb\u2066\u2067\u2068\u2069', 100)).toBe('ab');
    expect(cleanField('a\u2028b\u2029c\t\td', 100)).toBe('a b c d');
    expect(cleanField('abcdef', 3)).toBe('abc');
    expect(cleanField('ab😀', 3)).toBe('ab');
    expect(cleanField('a\uD800b', 10)).toBe('ab');
    expect(cleanField('abc', 0)).toBe('');
  });
});

describe("the portal's and sender's own addresses are never a lead's", () => {
  it('portal addresses on Email: lines and in the footer never become emails', () => {
    const body = ['New lead from Zillow', 'Name: Ann Lee', 'Email: leads@zillow.com', 'Email: noreply@mail.zillow.com', 'Email: X@Realtor.com', 'Email: y@move.com', 'Phone: 555-555-0127', 'Contact us: support@zillow.com'].join('\n');
    const l = okLead(parseLeadEmail(zillow(body)));
    expect(l.emails).toEqual([]);
    expect(l.phones).toHaveLength(1);
    expect(okLead(parseLeadEmail(ZILLOW)).emails.map((e) => e.value)).toEqual(['jane.buyer@example.test']);
    expect(okLead(parseLeadEmail(REALTOR)).emails.map((e) => e.value)).toEqual(['john.doe@example.test']);
  });

  it('only the portal address ⇒ NO_CONTACT_POINT', () => {
    expect(parseLeadEmail(zillow('Zillow lead\nName: Ann\nEmail: leads@zillow.com'))).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT' });
  });

  it("the trusted sender's own domain (and its subdomains) is excluded", () => {
    const r = parseLeadEmail(generic('Name: Ann\nEmail: forms@agent-site.test\nEmail: bot@x.forms.agent-site.test\nEmail: ann@example.test', 'agent-site.test'));
    expect(okLead(r).emails.map((e) => e.value)).toEqual(['ann@example.test']);
  });

  it('arbitrary addresses in the body (not on Email: lines) are never harvested', () => {
    const r = parseLeadEmail(generic('Name: Ann\nPhone: 555-555-0127\nWrite to someone@example.test anytime'));
    expect(okLead(r).emails).toEqual([]);
  });

  it('PORTAL_DOMAINS lists the portals (VERIFY)', () => {
    expect(PORTAL_DOMAINS).toEqual(expect.arrayContaining(['zillow.com', 'realtor.com', 'move.com']));
  });
});

describe('format detection, E78, E153', () => {
  it('unknown format ⇒ UNKNOWN_FORMAT with no partial', () => {
    expect(parseLeadEmail(generic(NEWSLETTER_TEXT, 'agency.test'))).toEqual({ ok: false, text: NEWSLETTER_TEXT, reason: 'UNKNOWN_FORMAT', partial: null });
    expect(parseLeadEmail({ subject: null, text: null, html: null, senderDomain: null })).toEqual({ ok: false, text: '', reason: 'UNKNOWN_FORMAT', partial: null });
  });

  it('E78: a changed Zillow template leaves unparsed fields empty and goes to review', () => {
    // every label renamed: no field is guessed from free text
    const r = parseLeadEmail(zillow(ZILLOW_CHANGED_TEXT, 'New lead for 123 Maple Street'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toBe('PARTIAL_FORMAT');
    expect(r.partial?.format).toBe('zillow');
    expect(r.partial?.property?.value).toBe('123 Maple Street');
    expect(r.partial?.name).toBeNull();
    expect(r.partial?.phones).toEqual([]);
    expect(r.partial?.emails).toEqual([]);
    expectSpans(r);
    // nothing recognizable at all ⇒ PARTIAL_FORMAT, partial null
    expect(parseLeadEmail(zillow(ZILLOW_CHANGED_TEXT))).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: null });
  });

  it('E78: a partly changed Zillow template keeps what still parses, contact labels gone ⇒ NO_CONTACT_POINT', () => {
    const r = parseLeadEmail(zillow('New lead from Zillow\nName: Ann Lee\nCustomer phone - 555-555-0127\nProperty: 1 Main St'));
    expect(r).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT', partial: { format: 'zillow', name: { value: 'Ann Lee' }, phones: [], emails: [], message: null } });
  });

  it('a vendor sender without the marker falls back to generic, else PARTIAL_FORMAT', () => {
    const noMarker = 'Name: Ann Lee\nEmail: ann@example.test';
    expect(okLead(parseLeadEmail(zillow(noMarker))).format).toBe('generic');
    expect(okLead(parseLeadEmail({ subject: null, text: noMarker, html: null, senderDomain: 'realtor.com' })).format).toBe('generic');
    const r = parseLeadEmail(zillow('Email: ann@example.test\nPhone: 555-555-0127'));
    expect(r).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: { format: 'zillow' } });
    expect(leadOf(r)?.emails.map((e) => e.value)).toEqual(['ann@example.test']);
    // a Zillow marker but no recognizable label at all
    expect(parseLeadEmail(zillow('Zillow: you have a new lead! Open the app to see it.'))).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: null });
  });

  it('E153: a forged "Zillow" email from another sender is never parsed as Zillow and never throws', () => {
    const forged = { ...ZILLOW, senderDomain: 'zillow.com.evil.test' };
    const r = parseLeadEmail(forged);
    expect(leadOf(r)?.format).toBe('generic');
    expect(leadOf(parseLeadEmail({ ...ZILLOW, senderDomain: 'notzillow.com' }))?.format).toBe('generic');
    expect(okLead(parseLeadEmail({ ...ZILLOW, senderDomain: 'ZILLOW.COM.' })).format).toBe('zillow');
    expect(() => parseLeadEmail(null as unknown as ParseInput)).not.toThrow();
    expect(() => parseLeadEmail({ subject: 5, text: {}, html: [], senderDomain: 7 } as unknown as ParseInput)).not.toThrow();
  });
});

describe('normalizeBody', () => {
  it('CRLF/CR → LF, controls removed (\\n \\t kept), NFKC, truncated to MAX_INPUT_CHARS', () => {
    expect(normalizeBody({ subject: null, text: 'a\r\nb\rc\u0000d\u0007e\tf\u009Fg', html: null, senderDomain: null })).toBe('a\nb\ncde\tfg');
    expect(normalizeBody({ subject: null, text: 'ﬁ Ｍａｉｌ①', html: null, senderDomain: null })).toBe('fi Mail1');
    expect(normalizeBody({ subject: null, text: 'x'.repeat(MAX_INPUT_CHARS + 10), html: null, senderDomain: null })).toHaveLength(MAX_INPUT_CHARS);
    expect(normalizeBody({ subject: null, text: null, html: '<p>a</p><p>b</p>', senderDomain: null })).toBe('a\n\nb\n\n');
    expect(normalizeBody({ subject: null, text: '', html: null, senderDomain: null })).toBe('');
  });
});

// ---- properties -------------------------------------------------------------------------------------

const LABELS = ['Name', 'Contact', 'Email', 'E-mail', 'Phone', 'Message', 'Comments', 'Property', 'Listing', 'Address', 'Listing ID', 'MLS #', 'Zpid', 'Type', 'Interested in'];
const NASTY = ['\r\n', '\r', '\n', '\u2028', '\u2029', '\u202E', '\u2066', '\u0000', '\u0085', '\u001B', '<', '>', '@', ':', ' ', '\t', '"', ',', ';', '&#10;'];
const valueArb = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.emailAddress(),
  fc.constantFrom('leads@zillow.com', 'noreply@mail.zillow.com', 'a@b.test', 'Ann@Example.test', '555-555-0127', '+1 (555) 555 0127', 'Jane Doe', '123 Main St, Reno, NV 89501', 'ABC-123'),
  fc.array(fc.oneof(fc.constantFrom(...NASTY), fc.string({ maxLength: 6 })), { maxLength: 8 }).map((xs) => xs.join('')),
);
const labelledBody = fc
  .array(fc.tuple(fc.constantFrom('', '- ', '* ', '  '), fc.constantFrom(...LABELS), fc.constantFrom(':', ': ', ' : '), valueArb), { maxLength: 12 })
  .chain((ls) => fc.tuple(fc.constant(ls), fc.constantFrom('\n', '\r\n'), fc.boolean()))
  .map(([ls, nl, marker]) => (marker ? 'New lead from Zillow realtor.com' + nl : '') + ls.map(([b, l, c, v]) => b + l + c + v).join(nl));
const htmlish = fc
  .array(fc.oneof(fc.constantFrom('<p>', '</p>', '<br>', '<script>', '</script>', '<!--', '-->', '<a href="x>', '"', '&amp;', '&#0;', '&#x110000;', '&#65;', '<td>', '</td>', '<', '&'), labelledBody, fc.string({ maxLength: 10 })), { maxLength: 12 })
  .map((xs) => xs.join(''));
const domainArb = fc.oneof(
  fc.constant(null),
  fc.constantFrom('zillow.com', 'mail.zillow.com', 'realtor.com', 'move.com', 'leads.realtor.com', 'example.test', 'ZILLOW.COM', ''),
  fc.domain(),
  fc.string({ unit: 'binary', maxLength: 20 }),
);
const inputArb: fc.Arbitrary<ParseInput> = fc.record({
  subject: fc.oneof(fc.constant(null), fc.string({ unit: 'binary', maxLength: 60 }), fc.constant('New lead for 123 Main St')),
  text: fc.oneof(fc.constant(null), fc.constant(''), labelledBody, fc.string({ unit: 'binary', maxLength: 200 })),
  html: fc.oneof(fc.constant(null), htmlish, fc.string({ unit: 'binary', maxLength: 200 })),
  senderDomain: domainArb,
});
const isOwn = (email: string, sender: string | null) => {
  const d = email.slice(email.lastIndexOf('@') + 1);
  const s = (sender ?? '').trim().toLowerCase().replace(/\.+$/, '');
  const under = (b: string) => b !== '' && (d === b || d.endsWith('.' + b));
  // R-LEM-11: the sender's own domain only when it is not a consumer mailbox domain
  return PORTAL_DOMAINS.some(under) || (!isConsumerMailboxDomain(s) && under(s));
};

describe('properties (fast-check)', () => {
  it('E153: parseLeadEmail never throws and always returns a ParseResult', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = parseLeadEmail(input);
        expect(typeof r.ok).toBe('boolean');
        expect(typeof r.text).toBe('string');
        if (!r.ok) expect(['UNKNOWN_FORMAT', 'NO_CONTACT_POINT', 'PARTIAL_FORMAT']).toContain(r.reason);
      }),
      { numRuns: 500 },
    );
  });

  it('R-INBOX-9: ok ⇒ at least one phone or email; every email valid and never the portal or sender', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const r = parseLeadEmail(input);
        const l = leadOf(r);
        if (r.ok) expect(r.lead.phones.length + r.lead.emails.length).toBeGreaterThanOrEqual(1);
        if (!l) return;
        expect(l.phones.length).toBeLessThanOrEqual(5);
        expect(l.emails.length).toBeLessThanOrEqual(5);
        for (const e of l.emails) {
          expect(isValidEmail(e.value)).toBe(true);
          expect(e.value).toBe(e.value.toLowerCase());
          expect(isOwn(e.value, input.senderDomain)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('no field value contains CR, LF, C0/C1 controls, U+2028/2029 or bidi overrides', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const l = leadOf(parseLeadEmail(input));
        if (!l) return;
        for (const [, f] of fieldsOf(l)) expect(f.value).not.toMatch(FORBIDDEN);
        if (l.postalCode !== null) expect(l.postalCode).toMatch(/^[0-9]{5}$/);
        if (l.listingId) expect(l.listingId.value).toMatch(/^[A-Za-z0-9-]{1,64}$/);
        if (l.name) expect(l.name.value.length).toBeLessThanOrEqual(120);
        if (l.message) expect(l.message.value.length).toBeLessThanOrEqual(2000);
        if (l.property) expect(l.property.value.length).toBeLessThanOrEqual(300);
      }),
      { numRuns: 500 },
    );
  });

  it('R-INBOX-9: every span lies within [0, text.length] with start ≤ end and cites the raw value', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expectSpans(parseLeadEmail(input));
      }),
      { numRuns: 500 },
    );
  });
});

describe('performance', () => {
  const time = (f: () => unknown) => {
    const t0 = performance.now();
    f();
    return performance.now() - t0;
  };
  it('a 5 MB HTML bomb parses in < 1000 ms', () => {
    for (const html of ['<div>'.repeat(1_000_000), 'a<'.repeat(2_500_000), '<!--' + 'x'.repeat(5_000_000), '<a href="' + 'x'.repeat(5_000_000), '<script>' + 'x'.repeat(5_000_000)]) {
      expect(time(() => parseLeadEmail({ subject: null, text: null, html, senderDomain: 'zillow.com' }))).toBeLessThan(1000);
    }
  });
  it("a 5 MB 'Name: ' repetition parses in < 1000 ms", () => {
    const one = 'Name: '.repeat(873_814);
    const lines = 'Name: x\n'.repeat(655_360);
    const mixed = 'Message: a\nb\n'.repeat(400_000);
    for (const text of [one, lines, mixed]) {
      expect(text.length).toBeGreaterThanOrEqual(5_000_000);
      expect(time(() => parseLeadEmail({ subject: 'New lead for ' + 'x'.repeat(100_000), text, html: null, senderDomain: 'zillow.com' }))).toBeLessThan(1000);
    }
  });
});

// ---- R-LEM-9 R-LEM-10 R-LEM-11 (SYNTHETIC fixtures) -------------------------------------------------------------

const html = (h: string, senderDomain: string | null = 'unknown-sender.test', text: string | null = null): ParseInput => ({ subject: 'New lead', text, html: h, senderDomain });
/** a clean declaration */
const VERSION_TAG = '<meta name="lead_information_version" content="1.0">';
const NAME_TAG = '<meta name="lead_name" content="Quinn Real">';
const PHONE_TAG = '<meta name="lead_phone" content="555-555-0122">';
/** what a vendor's template makes of a lead_email tag typed into a form field: text, never a tag */
const ESCAPED_TAG = '&lt;meta name="lead_email" content="attacker@example.test"&gt;';
/** what the scanner read: the declared flag, the values by name, the conflicting names */
const readOf = (h: string) => {
  const s = scanLeadMetadata(h);
  return { declared: s.declared, values: Object.fromEntries(s.values.map((v) => [v.name, v.value])), conflicts: s.conflicts };
};
const emailsOf = (r: ParseResult) => (leadOf(r)?.emails ?? []).map((e) => e.value);
/** the email is declared, reads exactly `values`, and is held on `conflicts`: never ok, no email at all */
const expectHeld = (h: string, conflicts: string[], values: Record<string, string> = {}) => {
  expect(readOf(h), h).toEqual({ declared: true, values, conflicts });
  const r = parseLeadEmail(html(h));
  expect(r, h).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT' });
  expect(emailsOf(r), h).toEqual([]);
  expectSpans(r);
};

describe('R-LEM-9 catalog portals without a vendor parser', () => {
  it('R-LEM-9 E332: a labelled email from each catalog portal parses as generic; unlabelled is held UNKNOWN_FORMAT; their own addresses are never a lead’s', () => {
    for (const d of CATALOG_PORTAL_DOMAINS) {
      expect(PORTAL_DOMAINS, d).toContain(d);
      const r = parseLeadEmail(catalogLabelled(d));
      const l = okLead(r);
      expect([d, l.format]).toEqual([d, 'generic']);
      expect(l.name?.value).toBe('Morgan Sample');
      expect(l.emails.map((e) => e.value)).toEqual(['morgan.sample@example.test']);
      expect(l.phones.map((p) => p.value)).toEqual(['555-555-0124']);
      expectSpans(r);
      expect(parseLeadEmail(catalogUnlabelled(d)), d).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
      // a portal address on an Email: line, whoever sent it, is never a lead's
      const own = parseLeadEmail(generic(`Name: A B\nEmail: leads@${d}\nEmail: x@mail.${d}\nPhone: 555-555-0118`, 'forms.agent-site.test'));
      expect(okLead(own).emails, d).toEqual([]);
    }
  });
});

describe('R-LEM-10 leadmetadata.org meta tags', () => {
  it('R-LEM-10 E330: tags in the head are read for any sender; values decoded and cleaned; prepended as lead_* lines with spans into the normalized body; lead_source is not a field', () => {
    const r = parseLeadEmail(html(LEADMETA_HEAD_HTML));
    const l = okLead(r);
    expect(l.format).toBe('leadmetadata');
    expect(l.name?.value).toBe('Avery Sample');
    expect(l.emails.map((e) => e.value)).toEqual(['avery.sample@example.test']);
    expect(l.phones.map((p) => p.value)).toEqual(['(555) 555-0120']);
    expect(l.property?.value).toBe('5 Birch Ln, Fairview, OR 97024');
    expect(l.postalCode).toBe('97024');
    expect(l.message?.value).toBe("I'd like a tour & the HOA fees.");
    expect(l.leadType).toBe('buy');
    expect(r.text.startsWith('lead_name: Avery Sample\nlead_email: avery.sample@example.test\n')).toBe(true);
    expect(r.text).toContain('lead_source: Some Other Portal\n');
    expect(r.text).toContain('You have a new lead.');
    expect(normalizeBody(html(LEADMETA_HEAD_HTML))).toBe(r.text);
    expectSpans(r);
    for (const [, f] of fieldsOf(l)) expect(r.text.slice(f.span.start, f.span.end).toLowerCase()).toBe(f.value.toLowerCase());
    // any sender, even a vendor's or none (trust decides elsewhere)
    expect(okLead(parseLeadEmail(html(LEADMETA_HEAD_HTML, 'mail.zillow.com'))).format).toBe('leadmetadata');
    expect(okLead(parseLeadEmail(html(LEADMETA_HEAD_HTML, null))).format).toBe('leadmetadata');
    // the raw HTML part is read even when a text part exists (the text part is the body after the prefix)
    const both = parseLeadEmail(html(LEADMETA_HEAD_HTML, 'x.test', 'Plain part of the email'));
    expect(okLead(both).format).toBe('leadmetadata');
    expect(both.text.endsWith('\n\nPlain part of the email')).toBe(true);
    expectSpans(both);
  });

  it('R-LEM-10 E330: tags in the body are read (case-insensitive names, unquoted and reordered attributes)', () => {
    const r = parseLeadEmail(html(LEADMETA_BODY_HTML));
    const l = okLead(r);
    expect(l.format).toBe('leadmetadata');
    expect(l.name?.value).toBe('Robin Example');
    expect(l.emails.map((e) => e.value)).toEqual(['robin@example.test']);
    expectSpans(r);
  });

  it('R-LEM-10 E330: an unknown version is not read; a text/plain part with meta tags is never read', () => {
    expect(scanLeadMetadata(LEADMETA_UNKNOWN_VERSION_HTML).declared).toBe(false);
    expect(parseLeadEmail(html(LEADMETA_UNKNOWN_VERSION_HTML))).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
    const plain = '<meta name="lead_information_version" content="1.0">\n<meta name="lead_email" content="plain@example.test">';
    const r = parseLeadEmail({ subject: null, text: plain, html: null, senderDomain: 'x.test' });
    expect(r).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT' });
    expect(r.text.startsWith('lead_')).toBe(false);
  });

  it('E596: a lead_* name twice with different values holds the email PARTIAL_FORMAT (the conflicting field stays empty); the same value twice is fine', () => {
    const r = parseLeadEmail(html(LEADMETA_DUPLICATE_HTML));
    expect(r).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: { format: 'leadmetadata', name: { value: 'Drew Twice' }, emails: [] } });
    expect(r.text).not.toContain('other@example.test');
    expectSpans(r);
    const same = LEADMETA_DUPLICATE_HTML.replace('other@example.test', 'DREW@example.test');
    expect(okLead(parseLeadEmail(html(same))).emails.map((e) => e.value)).toEqual(['drew@example.test']);
    // a contradicted version declaration is a conflict too
    const versions = LEADMETA_HEAD_HTML.replace('<meta charset="utf-8">', '<meta name="lead_information_version" content="2.0">');
    expect(parseLeadEmail(html(versions))).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT' });
  });

  it('E331: escaped tags, comments, script, style, textarea, title and attribute values are never read; decoded content cannot inject a header', () => {
    const esc = parseLeadEmail(html(LEADMETA_ESCAPED_HTML));
    expect(esc).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
    expect(scanLeadMetadata(LEADMETA_ESCAPED_HTML).declared).toBe(false);
    const r = parseLeadEmail(html(LEADMETA_HOSTILE_HTML));
    expect(r).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT', partial: { format: 'leadmetadata', name: { value: 'Quinn Real' }, emails: [], phones: [] } });
    expect(scanLeadMetadata(LEADMETA_HOSTILE_HTML).values.map((v) => v.name)).toEqual(['lead_name', 'lead_phone']);
    for (const v of scanLeadMetadata(LEADMETA_HOSTILE_HTML).values) expect(v.value).not.toMatch(FORBIDDEN);
    expect(r.text).not.toMatch(/(comment|script|style|title|textarea|attr|glued)@attacker/);
    expectSpans(r);
  });

  it('E331: at most 64 lead_* tags are read; a value is capped at 2,000 characters', () => {
    const many = '<meta name="lead_x" content="y">'.repeat(64) + '<meta name="lead_information_version" content="1.0"><meta name="lead_email" content="late@example.test">';
    expect(scanLeadMetadata(many).declared).toBe(false);
    const long = `<meta name="lead_information_version" content="1.0"><meta name="lead_message" content="${'m'.repeat(5000)}"><meta name="lead_email" content="a@example.test">`;
    const r = parseLeadEmail(html(long));
    expect(okLead(r).message?.value).toHaveLength(2000);
    expectSpans(r);
  });

  it('E331: an unclosed meta tag cannot take escaped text that follows it as its attributes', () => {
    // The fuzz test below found this once (fast-check seed -37172102, path "118:3:6:10:9", shrunk). The unclosed
    // "<meta " runs to the next '>', so the escaped text (what a vendor's template makes of markup a lead typed into
    // a form field) supplied its name= and content=.
    const doc = [VERSION_TAG, '<meta ', ESCAPED_TAG, VERSION_TAG].join('');
    const r = parseLeadEmail({ subject: null, text: null, html: doc, senderDomain: 'x.test', forwardedOnly: false });
    expect((leadOf(r)?.emails ?? []).map((e) => e.value)).toEqual([]);
    expect(r.text).not.toContain('lead_email: ');
    const scan = scanLeadMetadata(doc);
    expect(scan.values.map((v) => v.name)).not.toContain('lead_email');
    // the first version tag is clean, so the email is declared; the malformed tag claims lead_email, which is
    // therefore a conflict: nothing is read from it and the email is held
    expect(scan).toEqual({ declared: true, values: [], conflicts: ['lead_email'] });
    expect(r).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: null });
  });

  // The attacker's cases. The text a lead types reaches the email entity-escaped (no raw '<' or '>'), possibly with
  // its quotes left as they are. Each case states what is read and why.

  it('E331: escaped text before, between and after real tags is text: the tags read as if it were not there', () => {
    // no tag is open where the text sits, so it never reaches a tag's attribute region
    const without = [VERSION_TAG, NAME_TAG, PHONE_TAG].join('');
    const withText = [ESCAPED_TAG, VERSION_TAG, ESCAPED_TAG, NAME_TAG, ESCAPED_TAG, PHONE_TAG, ESCAPED_TAG].join('');
    expect(readOf(withText)).toEqual({ declared: true, values: { lead_name: 'Quinn Real', lead_phone: '555-555-0122' }, conflicts: [] });
    expect(scanLeadMetadata(withText)).toEqual(scanLeadMetadata(without));
    const r = parseLeadEmail(html(withText));
    expect(okLead(r).phones.map((p) => p.value)).toEqual(['555-555-0122']);
    expect(emailsOf(r)).toEqual([]);
    expectSpans(r);
  });

  it('E331: an unclosed meta tag before, between or after real tags: the escaped text it takes is never read, and the tags it swallows are not read either', () => {
    // between: the open tag runs to the '>' of the phone tag. It claims lead_email, so lead_email is a conflict
    // and the email is held; the name tag before it is clean and stays in the held partial; the phone is gone
    expectHeld([VERSION_TAG, NAME_TAG, '<meta ', ESCAPED_TAG, PHONE_TAG].join(''), ['lead_email'], { lead_name: 'Quinn Real' });
    // before: the open tag swallows the declaration itself. Only a clean tag declares, so nothing is read at all
    const before = ['<meta ', ESCAPED_TAG, VERSION_TAG, NAME_TAG, PHONE_TAG].join('');
    expect(readOf(before)).toEqual({ declared: false, values: {}, conflicts: [] });
    expect(parseLeadEmail(html(before))).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
    // after, at the very end of the document: the tag never closes, so it is no tag; what came before is read
    for (const tail of ['<meta ', '<meta ' + ESCAPED_TAG, '<meta name="lead_email" content="attacker@example.test"', '<meta name="lead_email" content="attacker@example.test', '<meta']) {
      const doc = [VERSION_TAG, NAME_TAG, tail].join('');
      expect(readOf(doc), tail).toEqual({ declared: true, values: { lead_name: 'Quinn Real' }, conflicts: [] });
      expect(parseLeadEmail(html(doc)), tail).toMatchObject({ ok: false, reason: 'NO_CONTACT_POINT', partial: { name: { value: 'Quinn Real' }, emails: [] } });
    }
  });

  it('E331: the escaped text is refused however it is written: single quotes, no quotes, content first, uppercase, a slash, newlines, tabs and form feeds', () => {
    // in every form the open tag's first attribute name starts with '&' (not a plain name), so the tag is not clean
    const forms = [
      "&lt;meta name='lead_email' content='attacker@example.test'&gt;",
      '&lt;meta name=lead_email content=attacker@example.test&gt;',
      '&lt;meta content="attacker@example.test" name="lead_email"&gt;',
      '&LT;META NAME="LEAD_EMAIL" CONTENT="attacker@example.test"&GT;',
      '&lt;meta name="lead_email" content="attacker@example.test" /&gt;',
      '&lt;meta name="lead_email" content="attacker@example.test"/&gt;',
      '&lt;meta\nname="lead_email"\tcontent="attacker@example.test"\f&gt;',
      '&lt;meta\r\n\tname="lead_email"\f\fcontent="attacker@example.test"\n&gt;',
      '&#60;meta name="lead_email" content="attacker@example.test"&#62;',
      '&#x3c;meta name="lead_email" content="attacker@example.test"&#x3E;',
      '&lt;meta name="lead_email" content="attacker@example.test" x=">"&gt;',
    ];
    // '<meta' with the text glued to it is scanned as a meta tag too (the tag name ends at the '&'), so it is held as well
    for (const open of ['<meta ', '<meta\t', '<meta\n', '<meta\f', '<META ', '<meta /', '<meta/', '<meta']) {
      for (const f of forms) expectHeld([VERSION_TAG, NAME_TAG, open, f, PHONE_TAG].join(''), ['lead_email'], { lead_name: 'Quinn Real' });
    }
  });

  it('E331: whitespace, a self-closing slash, uppercase and either attribute order are not the trigger: such clean tags are still read', () => {
    const legit = [
      '<meta\n\tname="lead_email"\f\r\ncontent="ws@example.test"\n>',
      '<meta name="lead_email" content="ws@example.test" />',
      '<meta name="lead_email" content="ws@example.test"/>',
      '<META CONTENT="ws@example.test" NAME="LEAD_EMAIL">',
      "<meta content='ws@example.test' name='lead_email' data-x='1' itemprop=x>",
      '<meta name=lead_email content=ws@example.test>',
    ];
    for (const t of legit) {
      expect(readOf(VERSION_TAG + t), t).toEqual({ declared: true, values: { lead_email: 'ws@example.test' }, conflicts: [] });
      expect(emailsOf(parseLeadEmail(html(VERSION_TAG + t))), t).toEqual(['ws@example.test']);
    }
  });

  it('E331: a quoted value may hold anything (a ">", a "<", escaped tags): it is that value and nothing else, and it never closes or opens a tag', () => {
    // inside quotes the text is the value of the attribute the vendor put it in: a message stays a message
    const doc = [VERSION_TAG, PHONE_TAG, `<meta name="lead_message" content='a > b < c ${ESCAPED_TAG}'>`].join('');
    expect(readOf(doc)).toEqual({ declared: true, values: { lead_phone: '555-555-0122', lead_message: 'a > b < c <meta name="lead_email" content="attacker@example.test">' }, conflicts: [] });
    const r = parseLeadEmail(html(doc));
    expect(okLead(r).message?.value).toBe('a > b < c <meta name="lead_email" content="attacker@example.test">');
    expect(emailsOf(r)).toEqual([]);
    expectSpans(r);
    // a quoted '>' does not close an open tag, so the text after it is still inside the tag: not clean
    expectHeld([VERSION_TAG, '<meta data-x=">" ', ESCAPED_TAG, PHONE_TAG].join(''), ['lead_email']);
    // a value left open ends at the next quote; the text after that quote is at tag level (lead_email" is no name)
    expectHeld([VERSION_TAG, '<meta name="lead_phone" content="', ESCAPED_TAG, '">'].join(''), ['lead_phone']);
    expectHeld([VERSION_TAG, '<meta name="lead_email" content="', ESCAPED_TAG, PHONE_TAG].join(''), ['lead_email']);
  });

  it('E331: a value that breaks out of its quotes cannot rename its tag or replace its value: name or content twice is not read', () => {
    // what <meta content="{{message}}" name="lead_message"> becomes when the template leaves quotes unescaped and
    // the lead types: attacker@example.test" name="lead_email" x="   — the first name would have won
    expectHeld(`${VERSION_TAG}${NAME_TAG}<meta content="attacker@example.test" name="lead_email" x="" name="lead_message">`, ['lead_email'], { lead_name: 'Quinn Real' });
    expectHeld(`${VERSION_TAG}<meta name="lead_name" name="lead_email" content="attacker@example.test">`, ['lead_name']);
    // content twice: neither value is read (before, the first won)
    expectHeld(`${VERSION_TAG}<meta name="lead_email" content="first@example.test" content="attacker@example.test">`, ['lead_email']);
    expectHeld(`${VERSION_TAG}<meta name="lead_email" content="same@example.test" CONTENT="same@example.test">`, ['lead_email']);
    // a clean tag of the same name does not rescue it: the name is in conflict, as with two different values (E596)
    expectHeld(`${VERSION_TAG}<meta name="lead_email" content="real@example.test"><meta name="lead_email" content="real@example.test" content="x">`, ['lead_email']);
    // any other attribute may repeat (first wins, as before): the tag is read
    expect(readOf(`${VERSION_TAG}<meta class="a" class="b" name="lead_email" content="ok@example.test">`).values).toEqual({ lead_email: 'ok@example.test' });
  });

  it('E331: a "<", a quote or an entity for "<" or ">" in an unquoted value, in every spelling, is not read', () => {
    const dirty = ['<b', 'a<b', 'Eve"x', "Eve'x", '&lt;b', '&LT;b', '&Lt;b', '&ltb', 'x&gt;', 'x&GT', '&#60;b', '&#060b', '&#0000060;', '&#62;', '&#x3c;b', '&#X3C;b', '&#x3Cg', '&#x003e;', '&#X3E'];
    for (const v of dirty) expectHeld(`${VERSION_TAG}${PHONE_TAG}<meta name=lead_name content=${v}>`, ['lead_name'], { lead_phone: '555-555-0122' });
    // an open unquoted value takes the escaped text: '&lt;meta' is its value, and name= then comes twice
    expectHeld(`${VERSION_TAG}<meta name=lead_name content=${ESCAPED_TAG}${PHONE_TAG}`, ['lead_name']);
    // other entities and other numbers are no angle bracket: an unquoted value with them is read as before
    const fine: Array<[string, string]> = [['Tom&amp;Jerry', 'Tom&Jerry'], ['a&#600;b', 'aɘb'], ['a&#x3c0;b', 'aπb'], ['a&b', 'a&b'], ['a&#;b', 'a&#;b'], ['a=b', 'a=b']];
    for (const [raw, value] of fine) expect(readOf(`${VERSION_TAG}<meta name=lead_name content=${raw}>`), raw).toEqual({ declared: true, values: { lead_name: value }, conflicts: [] });
  });

  it('E331: an attribute name that is not a plain name (a "<", "&", quote, NUL or other control character, a digit first, none at all) means the tag is not read', () => {
    const bad = ['<p', '<meta', 'x<y', 'a&b', '&gt;', '"x"', "'x", 'x"', '9x', '-x', '\u0000', 'x\u0000y', '\u0001', '\u000B', '\u007F', '\u0085x', ' ', '‮x', '[x]', '@x', 'x.y', '="x"', 'a'.repeat(65)];
    for (const a of bad) {
      // the tag claims lead_email with a content, so it would have been read: now it is a conflict and held
      expectHeld(`${VERSION_TAG}<meta name="lead_email" content="attacker@example.test" ${a}>`, ['lead_email']);
      expectHeld(`${VERSION_TAG}<meta ${a} name="lead_email" content="attacker@example.test">`, ['lead_email']);
    }
    // an unclosed real tag before a real tag: '<meta' is the second tag's first "attribute"
    expectHeld(`${VERSION_TAG}<meta <meta name="lead_email" content="real@example.test">`, ['lead_email']);
    // a control character glued to name= or content= makes it another attribute: the tag then has no name (or no
    // content), claims nothing, and is not read; nothing is held
    for (const t of ['<meta\u0000name="lead_email" content="attacker@example.test">', '<meta \u0000name="lead_email" content="attacker@example.test">', '<meta name="lead_email"\u0000content="attacker@example.test">', '<meta name="lead_email" \u000Bcontent="attacker@example.test">']) {
      expect(readOf(VERSION_TAG + NAME_TAG + t), JSON.stringify(t)).toEqual({ declared: true, values: { lead_name: 'Quinn Real' }, conflicts: [] });
      expect(emailsOf(parseLeadEmail(html(VERSION_TAG + NAME_TAG + t)))).toEqual([]);
    }
    // plain names with '-', '_', ':' and digits are fine
    expect(readOf(`${VERSION_TAG}<meta data-x1="1" xml:lang="en" a_b name="lead_email" content="ok@example.test">`).values).toEqual({ lead_email: 'ok@example.test' });
  });

  it('E331: a tag that is not clean never declares, and a declared email with one is held, not handed to the body labels', () => {
    // the only declaration sits in a tag that is not clean: the email is not declared, the real tag it swallowed is
    // not read, and the email is read like any email without tags
    const undeclared = `<meta &lt;meta name="lead_information_version" content="1.0"&gt;<meta name="lead_email" content="ok@example.test">${NAME_TAG}`;
    expect(readOf(undeclared)).toEqual({ declared: false, values: {}, conflicts: [] });
    expect(parseLeadEmail(html(undeclared))).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
    // a declared email whose unclean tag claims the version: the version is in conflict
    expectHeld(`${VERSION_TAG}${NAME_TAG}<meta &lt;meta name="lead_information_version" content="1.0"&gt;${PHONE_TAG}`, ['lead_information_version'], { lead_name: 'Quinn Real' });
    // held means held: the labelled body is not read in its place (it would have made an ok generic lead)
    const body = '<p>Name: Eve Body</p><p>Email: body@example.test</p><p>Phone: 555-555-0111</p>';
    expect(okLead(parseLeadEmail(html(body))).format).toBe('generic');
    const r = parseLeadEmail(html(`${VERSION_TAG}<meta ${ESCAPED_TAG}${PHONE_TAG}${body}`));
    expect(r).toMatchObject({ ok: false, reason: 'PARTIAL_FORMAT', partial: null });
    // a tag that is not clean but claims no name we read (or no lead_* name at all) changes nothing
    for (const t of ['<meta name="viewport" content="width=device-width" content="x">', '<meta name="lead_unknown_field" content="a" content="b">', '<meta http-equiv=refresh content=0;url=<x>']) {
      expect(readOf(VERSION_TAG + t + NAME_TAG + PHONE_TAG), t).toEqual({ declared: true, values: { lead_name: 'Quinn Real', lead_phone: '555-555-0122' }, conflicts: [] });
    }
  });

  it('E331: fuzz: never throws, spans hold, no attacker value is read from markup around real tags', () => {
    const piece = fc.oneof(
      fc.constantFrom('<meta name="lead_information_version" content="1.0">', '<meta name="lead_email" content="ok@example.test">', '<!--', '-->', '<script>', '</script>', '<title>', '</title>', '<textarea>', '</textarea>', '<style>', '</style>', '"', "'", '<', '>', '&lt;meta name="lead_email" content="attacker@example.test"&gt;', '<meta name="lead_phone" content="', '&#10;', '&amp;', '<meta ', 'content=', '='),
      // tags left open in more ways, and the escaped text in more spellings (the case pinned above, in variants)
      fc.constantFrom('<meta name="lead_email" content="', "<meta name='lead_email' content='", '<meta name=lead_name content=', '<meta\t', '<meta\n', '<META ', '<meta/', '<meta', 'name=', ' ', '\t', '\n', '\f', '/', '\u0000'),
      fc.constantFrom(
        '&#60;meta name="lead_email" content="attacker@example.test"&#62;',
        '&#x3C;meta name="lead_email" content="attacker@example.test"&#x3e;',
        "&lt;meta name='lead_email' content='attacker@example.test'&gt;",
        '&lt;meta name=lead_email content=attacker@example.test&gt;',
        '&lt;meta content="attacker@example.test" name="lead_email"&gt;',
        '&LT;META NAME="lead_email" CONTENT="attacker@example.test"&GT;',
        '&lt;meta\tname="lead_email"\ncontent="attacker@example.test"\f/&gt;',
      ),
      fc.string({ unit: 'binary', maxLength: 12 }),
    );
    fc.assert(
      fc.property(fc.array(piece, { maxLength: 30 }), fc.boolean(), (xs, fwd) => {
        const input: ParseInput = { subject: null, text: null, html: xs.join(''), senderDomain: 'x.test', forwardedOnly: fwd };
        const r = parseLeadEmail(input);
        expect(typeof r.ok).toBe('boolean');
        expectSpans(r);
        const l = leadOf(r);
        for (const e of l?.emails ?? []) expect(e.value).not.toContain('attacker');
        for (const [, f] of l ? fieldsOf(l) : []) expect(f.value).not.toMatch(FORBIDDEN);
        // the scanner itself: the escaped address is never the value of a tag, whatever the email check would say
        for (const v of scanLeadMetadata(input.html).values) expect(v.value).not.toBe('attacker@example.test');
      }),
      { numRuns: 10_000 },
    );
  });

  it('E331: the scanner is linear: a 10 MB hostile body finishes well under 2 s', () => {
    const bodies = [
      '<meta name="lead_x" content="'.repeat(350_000),
      '<'.repeat(10_000_000),
      '<meta '.repeat(1_700_000),
      '<!--' + '<meta name="lead_email" content="a@b.test">'.repeat(230_000),
      '<script>' + '</scrip'.repeat(1_400_000),
      `<meta name="lead_information_version" content="1.0"><meta a=${'x'.repeat(10_000_000)}`,
      '<meta name="lead_information_version" content="1.0">' + '<meta name="lead_name" content="Ann">'.repeat(270_000),
    ];
    for (const b of bodies) {
      expect(b.length).toBeGreaterThanOrEqual(9_000_000);
      const t0 = performance.now();
      parseLeadEmail({ subject: null, text: null, html: b, senderDomain: 'x.test' });
      scanLeadMetadata(b);
      expect(performance.now() - t0).toBeLessThan(2000);
    }
  });
});

describe('R-LEM-11 personal mailboxes and hand forwards', () => {
  it('R-LEM-11: isOwnAddress drops portal addresses always, and the sender’s domain only when it is not a consumer mailbox domain', () => {
    expect(isOwnAddress('synthetic_lead-sam@gmail.com', 'gmail.com')).toBe(false);
    expect(isOwnAddress('leads@zillow.com', 'gmail.com')).toBe(true);
    expect(isOwnAddress('x@redfin.com', 'gmail.com')).toBe(true);
    expect(isOwnAddress('forms@agent-site.test', 'agent-site.test')).toBe(true);
    expect(isOwnAddress('a@b.outlook.com', 'outlook.com')).toBe(false);
    const r = parseLeadEmail({ subject: null, text: 'Name: Sam Lead\nEmail: synthetic_lead-sam@gmail.com', html: null, senderDomain: 'gmail.com' });
    expect(okLead(r).emails.map((e) => e.value)).toEqual(['synthetic_lead-sam@gmail.com']);
  });

  it('R-LEM-11 E326: forwardedOnly reads only the forwarded block (Gmail, Outlook, Apple Mail markers), spans into the whole body', () => {
    for (const m of ['gmail', 'outlook', 'apple'] as const) {
      const text = forwardedByHand(m);
      const r = parseLeadEmail({ subject: 'Fwd: New lead', text, html: null, senderDomain: 'gmail.com', forwardedOnly: true });
      const l = okLead(r);
      expect([m, l.format, l.name?.value]).toEqual([m, 'generic', 'Sam Lead']);
      expect(l.emails.map((e) => e.value)).toEqual(['synthetic_lead-sam@gmail.com']);
      expect(l.phones.map((p) => p.value)).toEqual(['555-555-0121']);
      expect(l.name!.span.start).toBeGreaterThan(text.indexOf('From: Zillow'));
      expectSpans(r);
      // without forwardedOnly the forwarder's own note is read first
      expect(okLead(parseLeadEmail({ subject: null, text, html: null, senderDomain: 'gmail.com' })).name?.value).toBe('Not The Lead');
    }
  });

  it('R-LEM-11: forwardedOnly with no marker pre-fills nothing; lead metadata is not read from a hand forward', () => {
    const r = parseLeadEmail({ subject: null, text: 'Name: Sam Lead\nEmail: synthetic_lead-sam@gmail.com\nPhone: 555-555-0121', html: null, senderDomain: 'gmail.com', forwardedOnly: true });
    expect(r).toMatchObject({ ok: false, reason: 'UNKNOWN_FORMAT', partial: null });
    const meta = parseLeadEmail({ subject: null, text: null, html: LEADMETA_HEAD_HTML, senderDomain: 'gmail.com', forwardedOnly: true });
    expect(meta).toMatchObject({ ok: false, partial: null });
    expect(meta.text.startsWith('lead_')).toBe(false);
  });
});
