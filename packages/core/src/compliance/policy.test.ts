import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at } from '../foundation/index.js';
import { type JurisdictionPack, PLATFORM_FLOOR, parseJurisdictionPack, resolvePolicy } from './policy.js';
import { US_PACK_ROW, policy, tenantPolicy, usPack } from './testing/fixtures.js';
import { AUTONOMOUS_ELIGIBLE } from './types.js';

const pack = (key: string, rules: JurisdictionPack['rules'], reviewed: boolean = false): JurisdictionPack => ({
  key,
  version: '1',
  reviewedByCounselAt: reviewed ? at('2026-10-01T00:00:00Z') : null,
  rules,
});

describe('parseJurisdictionPack', () => {
  it('parses the seeded US placeholder pack (not counsel-reviewed); the retired window/DNC keys are ignored', () => {
    const r = parseJurisdictionPack(US_PACK_ROW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.rules.recordingPartyRule).toBe('unknown');
    expect(r.pack.rules.inquiryBasisDays).toBe(90);
    expect(r.pack.rules.optOutKeywords).toContain('OPT OUT');
    expect(r.pack.reviewedByCounselAt).toBeNull();
    expect(r.ignoredKeys).toEqual(['contact_window', 'dnc_scrub_validity_days', 'restricted_days']);
    expect(Object.keys(r.pack.rules).sort()).toEqual(['helpKeywords', 'inquiryBasisDays', 'optOutKeywords', 'recordingPartyRule', 'resubscribeKeywords']);
  });

  it('reports unknown keys without failing', () => {
    const r = parseJurisdictionPack({ ...US_PACK_ROW, rules: { ...US_PACK_ROW.rules, future_rule: 1 } });
    expect(r.ok && r.ignoredKeys).toEqual(['contact_window', 'dnc_scrub_validity_days', 'future_rule', 'restricted_days']);
  });

  it('a pack with a quiet-hours rule (contact window, restricted days) no longer blocks sending: it is ignored, not invalid', () => {
    const r = parseJurisdictionPack({ ...US_PACK_ROW, rules: { ...US_PACK_ROW.rules, contact_window: { start: '21:00', end: '08:00' }, restricted_days: ['sunday'] } });
    expect(r.ok).toBe(true);
  });

  it.each([
    ['recording_party_rule', 'two_party'],
    ['inquiry_basis_days', 0],
    ['inquiry_basis_days', 1.5],
    ['opt_out_keywords', ['STOP', '']],
    ['resubscribe_keywords', 'START'],
    ['help_keywords', [1]],
    ['ai_disclosure', { assistant_must_identify: false }],
    ['ai_disclosure', true],
    ['advertising', { brokerage_name_required: false }],
    ['advertising', null],
  ])('fails closed on a malformed or unsupported %s', (k, v) => {
    const r = parseJurisdictionPack({ ...US_PACK_ROW, rules: { ...US_PACK_ROW.rules, [k]: v } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('PACK_INVALID');
    expect(!r.ok && r.issues.some((i) => i.startsWith(k))).toBe(true);
  });

  it('rejects a bad key, an empty version and non-object rules', () => {
    expect(parseJurisdictionPack({ ...US_PACK_ROW, key: 'usa' }).ok).toBe(false);
    expect(parseJurisdictionPack({ ...US_PACK_ROW, version: ' ' }).ok).toBe(false);
    const r = parseJurisdictionPack({ ...US_PACK_ROW, rules: [] });
    expect(!r.ok && r.issues).toContain('rules: expected an object');
  });

  it('accepts a state pack and a minimal pack', () => {
    expect(parseJurisdictionPack({ key: 'US-NV', version: '1', reviewedByCounselAt: null, rules: {} })).toEqual({ ok: true, pack: { key: 'US-NV', version: '1', reviewedByCounselAt: null, rules: {} }, ignoredKeys: [] });
    const r = parseJurisdictionPack({ key: 'US-SC', version: '1', reviewedByCounselAt: null, rules: { recording_party_rule: 'one_party' } });
    expect(r.ok && r.pack.rules).toEqual({ recordingPartyRule: 'one_party' });
  });
});

describe('resolvePolicy', () => {
  it('default: categories, recording and keywords of the shipped defaults; no window, caps or DNC validity', () => {
    const p = policy();
    expect([...p.autonomous].sort()).toEqual(['booking_confirmation', 'nurture_step', 'reminder', 'search_alert', 'speed_to_lead_reply']);
    expect(p.recordingMode).toBe('announce_all');
    expect(p.recordingEnabled).toBe(true);
    expect(p.optOutConfirmationSender).toBe('provider');
    expect(p.inquiryBasisDays).toBe(90);
    expect(p.version).toEqual({ policyId: tenantPolicy().id, packs: { US: '2026.11.0' } });
    expect(p.unreviewedPacks).toEqual(['US']);
    expect(Object.keys(p).sort()).toEqual(['autonomous', 'inquiryBasisDays', 'keywords', 'optOutConfirmationSender', 'recordingEnabled', 'recordingMode', 'unreviewedPacks', 'version']);
  });

  it('autonomous categories are the tenant list ∩ the eligible set; always-human categories never pass', () => {
    const p = policy({ autonomousCategories: ['nurture_step', 'money', 'contract', 'novel_message', 'seller_update', 'bogus', 'document_chase'] });
    expect([...p.autonomous].sort()).toEqual(['document_chase', 'nurture_step']);
  });

  it('R-CONSENT-16 one-party recording mode needs an attestation', () => {
    expect(policy({ recordingMode: 'one_party_where_permitted' }).recordingMode).toBe('announce_all');
    expect(policy({ recordingMode: 'one_party_where_permitted', looseningAttestation: '  ' }).recordingMode).toBe('announce_all');
    expect(policy({ recordingMode: 'one_party_where_permitted', looseningAttestation: 'x' }).recordingMode).toBe('one_party_where_permitted');
    expect(policy({ recordingEnabled: false }).recordingEnabled).toBe(false);
  });

  it('R-CONSENT-7 keyword lists: opt-out and help are unions; resubscribe must be accepted by floor and every pack', () => {
    const extra = pack('US-AA', { optOutKeywords: ['arrêt', 'Stop'], resubscribeKeywords: ['START'], helpKeywords: ['support'] });
    const p = resolvePolicy(PLATFORM_FLOOR, [usPack(), extra], tenantPolicy());
    expect(p.keywords.optOut).toContain('ARRÊT');
    expect(p.keywords.optOut.filter((k) => k === 'STOP')).toHaveLength(1);
    expect(p.keywords.resubscribe).toEqual(['START']);
    expect(p.keywords.help).toEqual(['HELP', 'INFO', 'SUPPORT']);
    const odd = pack('US-BB', { resubscribeKeywords: ['YES'] });
    expect(resolvePolicy(PLATFORM_FLOOR, [odd], tenantPolicy()).keywords.resubscribe).toEqual([]);
    const blank = pack('US-CC', { optOutKeywords: ['!!!'] });
    expect(resolvePolicy(PLATFORM_FLOOR, [blank], tenantPolicy()).keywords.optOut).not.toContain('');
  });

  it('packs shorten the inquiry window (consent-ledger history), never lengthen it', () => {
    expect(resolvePolicy(PLATFORM_FLOOR, [pack('US-DD', { inquiryBasisDays: 30 })], tenantPolicy()).inquiryBasisDays).toBe(30);
    expect(resolvePolicy(PLATFORM_FLOOR, [pack('US-DD', { inquiryBasisDays: 400 })], tenantPolicy()).inquiryBasisDays).toBe(90);
  });

  it('the opt-out confirmation sender follows the tenant', () => {
    expect(policy({ optOutConfirmationSender: 'platform' }).optOutConfirmationSender).toBe('platform');
  });

  it('records pack versions sorted by key and lists unreviewed packs', () => {
    const reviewed = pack('US-AZ', {}, true);
    const p = resolvePolicy(PLATFORM_FLOOR, [reviewed, usPack()], tenantPolicy());
    expect(Object.keys(p.version.packs)).toEqual(['US', 'US-AZ']);
    expect(p.unreviewedPacks).toEqual(['US']);
  });

  it('property: resolvePolicy never widens categories beyond the eligible set or keywords below the floor', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ inquiry: fc.option(fc.integer({ min: 1, max: 400 }), { nil: undefined }), stop: fc.array(fc.constantFrom('STOP', 'ARRET', 'BASTA'), { maxLength: 2 }) }), { maxLength: 3 }),
        fc.subarray([...AUTONOMOUS_ELIGIBLE, 'money', 'contract', 'novel_message', 'seller_update', 'none']),
        (rawPacks, cats) => {
          const packs = rawPacks.map((r, i) => pack(`US-P${String.fromCharCode(65 + i)}`, { ...(r.inquiry === undefined ? {} : { inquiryBasisDays: r.inquiry }), optOutKeywords: r.stop }));
          const p = resolvePolicy(PLATFORM_FLOOR, packs, tenantPolicy({ autonomousCategories: cats }));
          for (const c of p.autonomous) expect(AUTONOMOUS_ELIGIBLE.has(c)).toBe(true);
          for (const pk of packs) if (pk.rules.inquiryBasisDays !== undefined) expect(p.inquiryBasisDays).toBeLessThanOrEqual(pk.rules.inquiryBasisDays);
          expect(p.inquiryBasisDays).toBeLessThanOrEqual(PLATFORM_FLOOR.maxInquiryBasisDays);
          for (const k of PLATFORM_FLOOR.keywords.optOut) expect(p.keywords.optOut).toContain(k);
        },
      ),
      { numRuns: 300 },
    );
  });
});
