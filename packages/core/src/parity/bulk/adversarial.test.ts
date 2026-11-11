// Module 62 adversarial tests: template injection, other people's data, opt-outs (D1, R-PAR-12), caps,
// idempotency, ownership and fair-housing audience protection, attacked through the pure decisions.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OnePersonContext, parseMergeTokens, renderForSend, renderTemplate, validateTemplate } from '../templates/index.js';
import { BULK_CAPS, BULK_KINDS, type BulkPersonFacts, bulkActionPreflight, bulkPreflight, bulkSendKey, checkBulkSize, checkDailyEmailCap, derivedCommandId } from './index.js';
import { H1, H2, NOW, bulkGate, revoked, user } from './testing.js';

const ctx = (first: string | null, fields: Record<string, string | null> = {}): OnePersonContext => ({
  contact: { firstName: first, lastName: 'Doe', displayName: 'Jane Doe' },
  agent: { firstName: 'Sam', lastName: 'Agent', phone: '+15125550100', email: 'sam@realty.test' },
  team: { name: 'Hill Team' },
  brokerage: { name: 'Hill Realty LLC' },
  fields,
});
const OWN: BulkPersonFacts = { detailVisible: true, merged: false, deleted: false, access: { own: true } };
const run = { actor: user('agent'), now: NOW };

describe('template injection (R-PAR-24)', () => {
  it('R-PAR-24 a contact-supplied name cannot pull the sender\'s or anyone\'s data, add a header or spoof text', () => {
    const tpl = { channel: 'email' as const, subject: 'Hi {{contact.first_name}}', body: 'Dear {{contact.first_name}},\nRegards, {{agent.first_name}}' };
    for (const evil of ['{{agent.email}}', '{{ agent.phone }}', '{{field.budget}}', '}}{{agent.email', '\r\nBcc: x@evil.test', 'Jane\u202egnp.exe', 'J\u200bane', '<script>alert(1)</script>']) {
      const r = renderTemplate(tpl, ctx(evil, { budget: 'SECRET' }));
      expect(r.body).not.toContain('sam@realty.test');
      expect(r.body).not.toContain('+15125550100');
      expect(r.body).not.toContain('SECRET');
      expect(r.subject).not.toMatch(/[\r\n]/);
      expect(r.body + (r.subject ?? '')).not.toMatch(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/);
      // plain text: markup is printed as text, never interpreted (the email is text/plain)
      if (evil.startsWith('<')) expect(r.body).toContain('<script>');
    }
  });

  it('R-PAR-24 field.<key> that names an object prototype property reads nothing', () => {
    for (const key of ['constructor', 'tostring', 'hasownproperty', 'valueof']) {
      expect(renderForSend({ channel: 'sms', subject: null, body: `x {{field.${key}}}` }, ctx('Jane'))).toMatchObject({ ok: false, code: 'MERGE_FIELD_EMPTY' });
    }
    // __proto__ is not even a field shape
    expect(parseMergeTokens('{{field.__proto__}}')).toMatchObject({ ok: false, code: 'MERGE_FIELD_UNKNOWN' });
  });

  it('R-PAR-24 the closed set cannot be widened by spacing, case, unicode look-alikes or extra segments', () => {
    for (const bad of ['Contact.first_name', 'contact .first_name', 'contact.first_name ', 'contact.f\u0456rst_name', 'contact.first_name.0', 'agent.email_address', 'contact.phone', 'contact.points']) {
      const r = parseMergeTokens(`{{${bad}}}`);
      if (bad === 'contact.first_name ') expect(r.ok).toBe(true); // surrounding whitespace is trimmed, nothing more
      else expect(r, bad).toMatchObject({ ok: false });
    }
    expect(validateTemplate({ channel: 'sms', name: 'x', subject: null, body: '{{contact.phone}}' }, new Set())).toMatchObject({ ok: false, code: 'MERGE_FIELD_UNKNOWN' });
  });

  it('R-PAR-24 a huge value cannot push a text past its limit unnoticed', () => {
    const r = renderForSend({ channel: 'sms', subject: null, body: 'Hi {{contact.first_name}}' }, ctx('x'.repeat(2000)));
    expect(r).toEqual({ ok: false, code: 'TEMPLATE_RENDERED_TOO_LONG' });
  });

  it('R-PAR-24 property: arbitrary values never create tokens, lines in the subject or another field\'s value', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (v) => {
        const r = renderTemplate({ channel: 'email', subject: 'S {{contact.first_name|x}}', body: 'B {{contact.first_name|x}} {{agent.email}}' }, ctx(v));
        expect(r.subject).not.toMatch(/[\r\n]/);
        // the agent's email appears exactly once (the token), however the name is spelled
        const count = r.body.split('sam@realty.test').length - 1;
        expect(count).toBe(v.includes('sam@realty.test') ? 1 + (v.split('sam@realty.test').length - 1) : 1);
      }),
    );
  });
});

describe('opt-outs in bulk (D1, R-PAR-12, R-PAR-36)', () => {
  it('R-PAR-12 a STOP on a removed phone of the person (its consent row is in the gate input) still skips the text', () => {
    // the API includes removed points' HMACs in the gate's consent rows (as the DB guard does)
    const g = bulkGate('sms', { consent: [revoked('sms', H2)] });
    expect(bulkPreflight('text', OWN, { kind: 'text', addressHmac: H1, sharedWithEarlier: false, gate: g, lastInboundAt: null, rendered: { ok: true } }, run)).toMatchObject({ ok: false, reason: 'RECIPIENT_OPTED_OUT' });
  });

  it('R-PAR-36 no flag, role or kind turns off the opt-out check: an Owner, any purpose label, any template', () => {
    for (const role of ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const) {
      const g = bulkGate('email', { consent: [revoked('email', H1)] });
      const r = bulkPreflight('email', { ...OWN, access: { own: true, team: true } }, { kind: 'email', addressHmac: H1, sharedWithEarlier: false, gate: g, lastInboundAt: null, rendered: { ok: true } }, { actor: user(role), now: NOW });
      expect(r, role).toMatchObject({ ok: false, reason: 'RECIPIENT_OPTED_OUT' });
    }
    // a bulk send is never informational: a gate input claiming so is refused outright
    expect(() => bulkPreflight('email', OWN, { kind: 'email', addressHmac: H1, sharedWithEarlier: false, gate: bulkGate('email', { purpose: 'informational' }), lastInboundAt: null, rendered: { ok: true } }, run)).toThrow();
    // nor an assistant or system send (no autonomy through bulk)
    expect(() => bulkPreflight('email', OWN, { kind: 'email', addressHmac: H1, sharedWithEarlier: false, gate: bulkGate('email', { initiator: 'system' }), lastInboundAt: null, rendered: { ok: true } }, run)).toThrow();
  });
});

describe('caps and idempotency (R-PAR-33, R-PAR-34, R-PAR-38, R-PAR-40)', () => {
  it('R-PAR-40 caps cannot be dodged with odd numbers', () => {
    for (const k of BULK_KINDS) for (const n of [-1, Number.NaN, Number.POSITIVE_INFINITY, BULK_CAPS[k] + 0.5, Number.MAX_SAFE_INTEGER]) expect(checkBulkSize(k, n).ok, `${k} ${n}`).toBe(false);
    for (const [a, b] of [[0, Number.NaN], [Number.POSITIVE_INFINITY, 0], [0, -5], [1.5, 1]] as const) expect(checkDailyEmailCap(a, b).ok).toBe(false);
  });

  it('R-PAR-34 a retried item derives the same command id and send key; different kinds of key never collide', () => {
    const a = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const c = '0190a1b2-c3d4-7e5f-8a9b-000000000001';
    expect(derivedCommandId(a, c)).toBe(derivedCommandId(a, c));
    expect(bulkSendKey(a, H1)).toBe(bulkSendKey(a, H1));
    expect(bulkSendKey(a, H1)).not.toContain(derivedCommandId(a, c));
  });
});

describe('ownership and roles (R-PAR-33, R-PAR-35)', () => {
  it('R-PAR-35 no role but Owner/Admin/TL assigns; a TC runs nothing; a support or unknown role never passes', () => {
    for (const k of BULK_KINDS) expect(bulkActionPreflight({ kind: k, role: 'tc', selected: 1, audienceProtected: false }).ok, k).toBe(false);
    expect(bulkActionPreflight({ kind: 'assign', role: 'support' as never, selected: 1, audienceProtected: false }).ok).toBe(false);
  });

  it('R-PAR-35 per item, a person who is only a pond/offer card for the creator is never acted on', () => {
    for (const access of [{ pond: true }, { offer: true }, { deal: true }, {}]) {
      expect(bulkPreflight('tag', { ...OWN, access }, { kind: 'tag', alreadyTagged: false, tagCount: 0 }, run).ok, JSON.stringify(access)).toBe(false);
    }
  });
});

describe('fair housing audience (R-PAR-8)', () => {
  it('R-PAR-8 E189 a protected audience is refused for email, text and enroll whatever the role', () => {
    for (const role of ['owner', 'admin', 'team_lead', 'agent', 'isa'] as const) {
      expect(bulkActionPreflight({ kind: 'email', role, selected: 1, audienceProtected: true, templateChannelMatches: true, brokerageNamePresent: true, postalAddressPresent: true, emailDomainVerified: true, emailsConfirmedToday: 0 })).toMatchObject({ code: 'AUDIENCE_PROTECTED_PROXY' });
      expect(bulkActionPreflight({ kind: 'enroll', role, selected: 1, audienceProtected: true, playbookApproved: true })).toMatchObject({ code: 'AUDIENCE_PROTECTED_PROXY' });
    }
  });
});
