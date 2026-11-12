import { describe, expect, it } from 'vitest';
import type { ConsentStateRow } from '../compliance/index.js';
import { DAY_MS, HOUR_MS, at, instant } from '../foundation/index.js';
import { type ConsentBasisInput, type GrantEvidence, aiIsaConsentBasis, consentBasisSentence, grantIssues } from './consent.js';

const NOW = at('2026-11-20T15:00:00Z');
const D12 = at('2026-11-12T00:00:00Z');
const PHONE = 'a'.repeat(64);
const OTHER_PHONE = 'b'.repeat(64);
const EMAIL = 'c'.repeat(64);
const TENANT = ['Example Realty LLC', 'Maple Team'];

const grant = (o: Partial<GrantEvidence> = {}): GrantEvidence => ({
  consentEventId: 'ce1',
  channel: 'sms',
  purpose: 'marketing',
  level: 'express_written',
  source: 'web_form',
  addressHmac: PHONE,
  recordedAt: at('2026-11-15T12:00:00Z'),
  expiresAt: null,
  imported: false,
  needsReview: false,
  disclosure: { id: 'd1', body: 'By submitting you agree that Maple Team of Example Realty LLC may text you, including by automated means.', scopeStated: true, channels: ['sms', 'email'], purposes: ['marketing'], origin: 'inquiry' },
  evidenceObject: false,
  ...o,
});

const input = (o: Partial<ConsentBasisInput> = {}): ConsentBasisInput => ({
  now: NOW,
  channel: 'sms',
  tier: 'initiated',
  boundHmac: PHONE,
  personHmacs: [PHONE, OTHER_PHONE],
  consentState: [],
  lastInbound: null,
  lastAiOutboundAt: null,
  grants: [grant()],
  negatives: [],
  dnc: [{ checkId: 'dnc1', addressHmac: PHONE, result: 'not_listed', checkedAt: instant(NOW - 5 * DAY_MS) }],
  tenantNames: TENANT,
  rules: { d12EffectiveAt: D12 },
  ...o,
});

const revoked = (hmac: string, purpose: 'marketing' | 'informational'): ConsentStateRow => ({ channel: 'sms', purpose, addressHmac: hmac, status: 'revoked', level: 'none', basisEventId: null, expiresAt: null, ledgerEventCount: 2 });

describe('R-ISA-9 E520 reply tier: the person\'s own bound inbound within 24 h', () => {
  const inb = { messageId: 'in1', channel: 'sms' as const, fromHmac: PHONE, at: instant(NOW - HOUR_MS), dkimAligned: null };
  it('passes with own_inbound basis (no inbound_first_contact grant needed)', () => {
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: inb, grants: [] }))).toEqual({ ok: true, tier: 'reply', basis: { kind: 'own_inbound', messageId: 'in1' } });
  });
  it('each failing condition', () => {
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: null }))).toMatchObject({ ok: false, codes: ['NO_INBOUND'], missing: ['evidence'] });
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: { ...inb, channel: 'email' } }))).toMatchObject({ codes: ['INBOUND_WRONG_CHANNEL'] });
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: { ...inb, fromHmac: OTHER_PHONE } }))).toMatchObject({ codes: ['INBOUND_UNBOUND'] });
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: { ...inb, at: instant(NOW - 25 * HOUR_MS) } }))).toMatchObject({ codes: ['INBOUND_OUTSIDE_WINDOW'], missing: ['reply_window'] });
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: inb, lastAiOutboundAt: instant(NOW - 30 * 60_000) }))).toMatchObject({ codes: ['INBOUND_BEFORE_LAST_AI'], missing: ['reply_window'] });
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: { ...inb, at: instant(NOW + 1000) } }))).toMatchObject({ codes: ['INBOUND_OUTSIDE_WINDOW'] });
  });
  it('email replies need an aligned DKIM pass', () => {
    const e = { ...inb, channel: 'email' as const, fromHmac: EMAIL };
    expect(aiIsaConsentBasis(input({ channel: 'email', boundHmac: EMAIL, tier: 'reply', lastInbound: { ...e, dkimAligned: false } }))).toMatchObject({ codes: ['DKIM_NOT_ALIGNED'] });
    expect(aiIsaConsentBasis(input({ channel: 'email', boundHmac: EMAIL, personHmacs: [EMAIL], tier: 'reply', lastInbound: { ...e, dkimAligned: true } })).ok).toBe(true);
  });
  it('R-PAR-12 a revoke of EITHER purpose on ANY of the person\'s phones blocks the reply tier', () => {
    expect(aiIsaConsentBasis(input({ tier: 'reply', lastInbound: inb, consentState: [revoked(OTHER_PHONE, 'informational')] }))).toMatchObject({ ok: false, codes: ['CHANNEL_REVOKED'] });
    expect(aiIsaConsentBasis(input({ consentState: [revoked(PHONE, 'marketing')] }))).toMatchObject({ ok: false, codes: ['CHANNEL_REVOKED'] });
  });
});

describe('R-ISA-9 E519 initiated tier: a grant from the person\'s own disclosure, plus a fresh DNC result for SMS', () => {
  it('passes with the grant and the DNC check as basis', () => {
    expect(aiIsaConsentBasis(input())).toEqual({ ok: true, tier: 'initiated', basis: { kind: 'grant', consentEventId: 'ce1', dncCheckId: 'dnc1' } });
  });
  const only = (g: Partial<GrantEvidence>) => aiIsaConsentBasis(input({ grants: [grant(g)] }));
  it('an inquiry-level grant (SMS needs express_written)', () => expect(only({ level: 'inquiry' })).toMatchObject({ ok: false, codes: ['GRANT_LEVEL'] }));
  it('an imported grant', () => expect(only({ imported: true })).toMatchObject({ codes: ['IMPORTED'] }));
  it('a needs_review grant', () => expect(only({ needsReview: true })).toMatchObject({ codes: ['NEEDS_REVIEW'] }));
  it('a grant recorded before D12; and D12 not yet effective (the strict default)', () => {
    expect(only({ recordedAt: at('2026-11-01T00:00:00Z') })).toMatchObject({ codes: ['BEFORE_D12'] });
    expect(aiIsaConsentBasis(input({ rules: {} }))).toMatchObject({ ok: false, codes: ['D12_NOT_EFFECTIVE'] });
  });
  it('a defaulted scope (scope_stated NULL or false) or a scope without the channel or marketing', () => {
    expect(only({ disclosure: { ...grant().disclosure!, scopeStated: null } })).toMatchObject({ codes: ['SCOPE_NOT_STATED'] });
    expect(only({ disclosure: { ...grant().disclosure!, scopeStated: false } })).toMatchObject({ codes: ['SCOPE_NOT_STATED'] });
    expect(only({ disclosure: { ...grant().disclosure!, channels: ['email'] } })).toMatchObject({ codes: ['SCOPE_EXCLUDES'] });
    expect(only({ disclosure: { ...grant().disclosure!, purposes: ['informational'] } })).toMatchObject({ codes: ['SCOPE_EXCLUDES'] });
    expect(only({ disclosure: { ...grant().disclosure!, purposes: ['all'] } }).ok).toBe(true);
  });
  it("the lead source's fallback disclosure never counts", () => expect(only({ disclosure: { ...grant().disclosure!, origin: 'source_fallback' } })).toMatchObject({ codes: ['DISCLOSURE_FALLBACK'] }));
  it('a disclosure whose body does not name the team (whatever namesSeller said)', () => {
    expect(only({ disclosure: { ...grant().disclosure!, body: 'You agree that Partner Leads Inc and its partners may contact you.' } })).toMatchObject({ codes: ['DISCLOSURE_NOT_NAMING_TEAM'] });
  });
  it('no disclosure, agent_entry, wrong purpose, wrong address, expired', () => {
    expect(only({ disclosure: null })).toMatchObject({ codes: ['DISCLOSURE_MISSING'] });
    expect(only({ source: 'agent_entry', level: 'express' })).toMatchObject({ codes: expect.arrayContaining(['GRANT_AGENT_ENTRY', 'GRANT_LEVEL']) });
    expect(only({ purpose: 'informational' })).toMatchObject({ codes: ['GRANT_PURPOSE'] });
    expect(only({ addressHmac: OTHER_PHONE })).toMatchObject({ codes: ['GRANT_WRONG_ADDRESS'] });
    expect(only({ expiresAt: instant(NOW - 1) })).toMatchObject({ codes: ['EXPIRED'] });
  });
  it('a later revoke, expire or import_revert of either purpose on any of the person\'s phones', () => {
    for (const eventType of ['revoke', 'expire', 'import_revert'] as const) {
      expect(aiIsaConsentBasis(input({ negatives: [{ channel: 'sms', addressHmac: OTHER_PHONE, eventType, at: at('2026-11-16T00:00:00Z') }] }))).toMatchObject({ codes: ['REVOKED_AFTER'] });
    }
    expect(aiIsaConsentBasis(input({ negatives: [{ channel: 'sms', addressHmac: PHONE, eventType: 'revoke', at: at('2026-11-14T00:00:00Z') }] })).ok).toBe(true);
  });
  it('a signed_document grant with an evidence object satisfies (1)–(4)', () => {
    expect(only({ source: 'signed_document', evidenceObject: true, disclosure: null, recordedAt: at('2026-01-01T00:00:00Z') }).ok).toBe(true);
    expect(only({ source: 'signed_document', evidenceObject: false, disclosure: null })).toMatchObject({ ok: false });
  });
  it('no fresh DNC result: missing, stale, listed, unknown, another number', () => {
    expect(aiIsaConsentBasis(input({ dnc: [] }))).toMatchObject({ ok: false, missing: ['dnc'], codes: ['DNC_MISSING'] });
    expect(aiIsaConsentBasis(input({ dnc: [{ checkId: 'x', addressHmac: PHONE, result: 'not_listed', checkedAt: instant(NOW - 32 * DAY_MS) }] }))).toMatchObject({ codes: ['DNC_STALE'] });
    expect(aiIsaConsentBasis(input({ dnc: [{ checkId: 'x', addressHmac: PHONE, result: 'listed', checkedAt: NOW }] }))).toMatchObject({ codes: ['DNC_LISTED'] });
    expect(aiIsaConsentBasis(input({ dnc: [{ checkId: 'x', addressHmac: PHONE, result: 'unknown', checkedAt: NOW }] }))).toMatchObject({ codes: ['DNC_MISSING'] });
    expect(aiIsaConsentBasis(input({ dnc: [{ checkId: 'x', addressHmac: OTHER_PHONE, result: 'not_listed', checkedAt: NOW }] }))).toMatchObject({ codes: ['DNC_MISSING'] });
  });
  it('email initiated needs no DNC result and accepts an inquiry-level grant', () => {
    const g = grant({ channel: 'email', addressHmac: EMAIL, level: 'inquiry', expiresAt: instant(NOW + DAY_MS) });
    expect(aiIsaConsentBasis(input({ channel: 'email', boundHmac: EMAIL, personHmacs: [EMAIL], grants: [g], dnc: [] }))).toEqual({ ok: true, tier: 'initiated', basis: { kind: 'grant', consentEventId: 'ce1', dncCheckId: null } });
  });
  it('no grant at all; the newest valid grant is chosen', () => {
    expect(aiIsaConsentBasis(input({ grants: [] }))).toMatchObject({ codes: ['NO_GRANT'] });
    const r = aiIsaConsentBasis(input({ grants: [grant({ imported: true, consentEventId: 'bad', recordedAt: at('2026-11-19T00:00:00Z') }), grant({ consentEventId: 'good' })] }));
    expect(r.ok && r.basis).toEqual({ kind: 'grant', consentEventId: 'good', dncCheckId: 'dnc1' });
    expect(grantIssues(grant(), input())).toEqual([]);
  });
});

describe('the panel sentence', () => {
  it('honest per tier and failure', () => {
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input()))).toMatch(/written consent on file and a recent Do Not Call check/);
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input({ grants: [] })))).toMatch(/^Texts: OK for replies within 24 h/);
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input({ dnc: [] })))).toMatch(/Do Not Call check from the last 31 days/);
    expect(consentBasisSentence('email', aiIsaConsentBasis(input({ channel: 'email', boundHmac: EMAIL, grants: [] })))).toMatch(/^Email:/);
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input({ consentState: [revoked(PHONE, 'marketing')] })))).toBe('Texts: they opted out.');
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input({ tier: 'reply' })))).toMatch(/replies need their own recent message/);
    expect(consentBasisSentence('sms', aiIsaConsentBasis(input({ tier: 'reply', lastInbound: { messageId: 'i', channel: 'sms', fromHmac: PHONE, at: NOW, dkimAligned: null } })))).toMatch(/OK for replies/);
  });
});
