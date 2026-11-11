// Module 62 (templates half): merge-field parsing, validation and the one-person, one-pass renderer.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_FIELDS,
  type OnePersonContext,
  type RenderableTemplate,
  cleanValue,
  parseMergeTokens,
  renderForSend,
  renderTemplate,
  validateTemplate,
} from './index.js';

const LIVE = new Set(['budget', 'home_anniversary']);

function ctx(o: { first?: string | null; last?: string | null; display?: string | null; fields?: Record<string, string | null> } = {}): OnePersonContext {
  return {
    contact: { firstName: o.first === undefined ? 'Jane' : o.first, lastName: o.last === undefined ? 'Doe' : o.last, displayName: o.display === undefined ? 'Jane Doe' : o.display },
    agent: { firstName: 'Sam', lastName: 'Agent', phone: '+15125550100', email: 'sam@realty.test' },
    team: { name: 'Hill Team' },
    brokerage: { name: 'Hill Realty LLC' },
    fields: o.fields ?? { budget: '$450,000' },
  };
}

const sms = (body: string): RenderableTemplate => ({ channel: 'sms', subject: null, body });
const email = (subject: string, body: string): RenderableTemplate => ({ channel: 'email', subject, body });

describe('R-PAR-24 merge fields are a closed set', () => {
  it('R-PAR-24 parses every built-in, field.<key> and a fallback; nothing else in braces is a field', () => {
    for (const f of BUILT_IN_FIELDS) expect(parseMergeTokens(`Hi {{${f}}}`)).toMatchObject({ ok: true, tokens: [{ field: f, fallback: null }] });
    expect(parseMergeTokens('Hi {{ contact.first_name | there }}!')).toMatchObject({ ok: true, tokens: [{ field: 'contact.first_name', fallback: 'there' }] });
    expect(parseMergeTokens('{{field.budget}}')).toMatchObject({ ok: true, tokens: [{ field: 'field.budget' }] });
    for (const bad of ['contact.phone', 'contact.email', 'contact.id', 'agent.password', 'owner.first_name', 'tenant_id', 'field.Budget', 'field.x', 'contact.first_name.x', '']) {
      expect(parseMergeTokens(`Hi {{${bad}}}`), bad).toMatchObject({ ok: false, code: 'MERGE_FIELD_UNKNOWN' });
    }
  });

  it('R-PAR-24 malformed tokens are refused: unclosed, nested, an empty or oversized fallback', () => {
    expect(parseMergeTokens('Hi {{contact.first_name')).toMatchObject({ ok: false, code: 'MERGE_FIELD_MALFORMED' });
    expect(parseMergeTokens('Hi {{contact.{{agent.email}}}}')).toMatchObject({ ok: false, code: 'MERGE_FIELD_MALFORMED' });
    expect(parseMergeTokens('Hi {{contact.first_name|}}')).toMatchObject({ ok: false, code: 'MERGE_FIELD_FALLBACK_INVALID' });
    expect(parseMergeTokens(`Hi {{contact.first_name|${'x'.repeat(61)}}}`)).toMatchObject({ ok: false, code: 'MERGE_FIELD_FALLBACK_INVALID' });
    expect(parseMergeTokens('Hi {{contact.first_name|a|b}}')).toMatchObject({ ok: false, code: 'MERGE_FIELD_FALLBACK_INVALID' });
    expect(parseMergeTokens('Hi {{contact.first_name|a\nb}}')).toMatchObject({ ok: false, code: 'MERGE_FIELD_FALLBACK_INVALID' });
    // single braces are plain text
    expect(parseMergeTokens('Price {range} } {')).toEqual({ ok: true, tokens: [] });
  });

  it('R-PAR-24 validation ties merge_fields to the saved body and subject, sorted and deduplicated', () => {
    const v = validateTemplate({ channel: 'email', name: ' Intro ', subject: 'For {{contact.first_name}}', body: 'Hi {{contact.first_name}}, {{agent.first_name}} at {{brokerage.name}}. {{field.budget}}' }, LIVE);
    expect(v).toEqual({ ok: true, template: { name: 'Intro', subject: 'For {{contact.first_name}}', body: 'Hi {{contact.first_name}}, {{agent.first_name}} at {{brokerage.name}}. {{field.budget}}', mergeFields: ['agent.first_name', 'brokerage.name', 'contact.first_name', 'field.budget'] } });
    // every stored field matches the DB CHECK shape
    if (v.ok) for (const f of v.template.mergeFields) expect(f).toMatch(/^(contact\.(first_name|last_name|display_name)|agent\.(first_name|last_name|phone|email)|team\.name|brokerage\.name|field\.[a-z][a-z0-9_]{1,40})$/);
  });

  it('R-PAR-24 an archived or unknown custom field is refused at save', () => {
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: 'Hi {{field.old_key}}' }, LIVE, new Set(['old_key']))).toMatchObject({ ok: false, code: 'MERGE_FIELD_ARCHIVED' });
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: 'Hi {{field.nope}}' }, LIVE)).toMatchObject({ ok: false, code: 'MERGE_FIELD_UNKNOWN' });
  });

  it('R-PAR-24 shape rules: subject only for email and never CR/LF; body length per channel; control characters', () => {
    expect(validateTemplate({ channel: 'email', name: 'x', subject: null, body: 'b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_SUBJECT_REQUIRED' });
    expect(validateTemplate({ channel: 'email', name: 'x', subject: 'a\r\nBcc: x@evil.test', body: 'b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_SUBJECT_INVALID' });
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: 'nope', body: 'b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_SUBJECT_NOT_ALLOWED' });
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: 'x'.repeat(1601) }, LIVE)).toMatchObject({ code: 'TEMPLATE_BODY_TOO_LONG' });
    expect(validateTemplate({ channel: 'email', name: 'x', subject: 's', body: 'x'.repeat(20000) }, LIVE)).toMatchObject({ ok: true });
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: '   ' }, LIVE)).toMatchObject({ code: 'TEMPLATE_BODY_EMPTY' });
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: 'a\u0007b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_BODY_INVALID' });
    expect(validateTemplate({ channel: 'sms', name: 'a\tb', subject: null, body: 'b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_NAME_INVALID' });
    expect(validateTemplate({ channel: 'sms', name: 'x'.repeat(81), subject: null, body: 'b' }, LIVE)).toMatchObject({ code: 'TEMPLATE_NAME_INVALID' });
  });
});

describe('R-PAR-24 rendering: one person, one pass, plain text', () => {
  it('R-PAR-24 renders the built-ins and custom fields for one person', () => {
    expect(renderTemplate(sms('Hi {{contact.first_name}}, {{agent.first_name}} from {{team.name}} ({{brokerage.name}}). Budget {{field.budget}}.'), ctx())).toEqual({
      body: 'Hi Jane, Sam from Hill Team (Hill Realty LLC). Budget $450,000.',
      missing: [],
    });
  });

  it('R-PAR-24 E179 a value that looks like a token is inserted literally (one pass, never re-parsed)', () => {
    const r = renderTemplate(sms('Hi {{contact.first_name}}! Reach me at {{agent.phone}}.'), ctx({ first: '{{agent.email}}' }));
    expect(r.body).toBe('Hi {{agent.email}}! Reach me at +15125550100.');
    expect(r.body).not.toContain('sam@realty.test');
    // and a fallback that looks like a token is literal too (validation refuses braces in a fallback anyway)
    expect(renderTemplate(sms('Hi {{contact.first_name|friend}}'), ctx({ first: '' })).body).toBe('Hi friend');
  });

  it('R-PAR-24 CR/LF are stripped from the subject, also when a value carries them (no header injection)', () => {
    const r = renderTemplate(email('Hello {{contact.first_name}}', 'Body'), ctx({ first: 'Jane\r\nBcc: victim@evil.test' }));
    expect(r.subject).toBe('Hello Jane Bcc: victim@evil.test');
    expect(r.subject).not.toMatch(/[\r\n]/);
    // a value never adds lines to the body either
    expect(renderTemplate(sms('Hi {{contact.first_name}}.'), ctx({ first: 'Jane\nSTOP' })).body).toBe('Hi Jane STOP.');
    // control characters are removed
    expect(cleanValue('Ja\u0000ne\u0007 \u2028Doe')).toBe('Ja ne Doe');
  });

  it('R-PAR-24 a field with no value and no fallback refuses the send (MERGE_FIELD_EMPTY): never "Hi ,"', () => {
    for (const first of [null, '', '   ', '\u0000']) {
      const r = renderForSend(sms('Hi {{contact.first_name}}, quick question.'), ctx({ first }));
      expect(r, String(first)).toEqual({ ok: false, code: 'MERGE_FIELD_EMPTY', missing: ['contact.first_name'] });
    }
    expect(renderForSend(sms('Hi {{contact.first_name|there}}, quick question.'), ctx({ first: null }))).toEqual({ ok: true, subject: null, body: 'Hi there, quick question.' });
    // a custom field the sender cannot see is absent from the context: empty, not another person's value
    expect(renderForSend(sms('Budget {{field.home_anniversary}}'), ctx())).toMatchObject({ ok: false, code: 'MERGE_FIELD_EMPTY', missing: ['field.home_anniversary'] });
    expect(renderForSend(email('{{contact.first_name}}', 'x'), ctx({ first: null }))).toMatchObject({ ok: false, code: 'MERGE_FIELD_EMPTY' });
  });

  it('R-PAR-24 property: no rendered template is ever "Hi ," (an empty value is always refused or replaced)', () => {
    const field = fc.constantFrom(...BUILT_IN_FIELDS, 'field.budget' as const);
    fc.assert(
      fc.property(field, fc.option(fc.constantFrom('', ' ', '\n', 'Ann'), { nil: null }), fc.boolean(), (f, v, fallback) => {
        const c = ctx({ first: v, last: v, display: v, fields: { budget: v } });
        const all: OnePersonContext = { ...c, agent: { firstName: v, lastName: v, phone: v, email: v }, team: { name: v }, brokerage: { name: v } };
        const r = renderForSend(sms(`Hi {{${f}${fallback ? '|there' : ''}}}, x`), all);
        if (r.ok) expect(r.body).not.toMatch(/^Hi ,/);
        else expect(r.code).toBe('MERGE_FIELD_EMPTY');
      }),
    );
  });
});

describe('R-PAR-24 property: rendering for person X never outputs a value of any other person', () => {
  // A pool of distinct people. The context holds exactly one of them; the output may contain only X's
  // values, the sender's, the team's and the brokerage's, and template text.
  const token = fc.stringMatching(/^[A-Z][a-z]{5,9}[0-9]{3}$/);
  const person = fc.record({ first: token, last: token, display: token, budget: token });
  it('R-PAR-24 a template over every field, for each of N people, never prints another person\'s value', () => {
    fc.assert(
      fc.property(fc.uniqueArray(person, { minLength: 2, maxLength: 6, selector: (p) => p.first + p.last + p.display + p.budget }), fc.nat(), (people, k) => {
        const all = new Set(people.flatMap((p) => [p.first, p.last, p.display, p.budget]));
        if (all.size !== people.length * 4) return; // values must be distinct across people for the check to be sharp
        const x = people[k % people.length]!;
        const tpl = sms('{{contact.first_name}} {{contact.last_name}} {{contact.display_name}} {{field.budget}} {{agent.first_name}} {{team.name}} {{brokerage.name}}');
        const out = renderTemplate(tpl, ctx({ first: x.first, last: x.last, display: x.display, fields: { budget: x.budget } })).body;
        for (const p of people) {
          if (p === x) continue;
          for (const v of [p.first, p.last, p.display, p.budget]) expect(out).not.toContain(v);
        }
        for (const v of [x.first, x.last, x.display, x.budget]) expect(out).toContain(v);
      }),
    );
  });

  it('R-PAR-24 property: the output is the template with each token replaced, in one left-to-right pass', () => {
    // any first name (including braces) is printed verbatim, cleaned of control characters only
    fc.assert(
      fc.property(fc.string({ maxLength: 40 }), (first) => {
        const r = renderTemplate(sms('<{{contact.first_name|-}}>'), ctx({ first }));
        const v = cleanValue(first);
        expect(r.body).toBe(`<${v.length > 0 ? v : '-'}>`.trim());
      }),
    );
  });
});
