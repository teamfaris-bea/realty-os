import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at, formatLocalTime, localTime } from '../foundation/index.js';
import {
  type JurisdictionPack,
  PLATFORM_FLOOR,
  formatWindow,
  parseJurisdictionPack,
  resolvePolicy,
  windowIsEmpty,
} from './policy.js';
import { US_PACK_ROW, policy, tenantPolicy, usPack } from './testing/fixtures.js';
import { AUTONOMOUS_ELIGIBLE } from './types.js';

const pack = (key: string, rules: JurisdictionPack['rules'], reviewed: boolean = false): JurisdictionPack => ({
  key,
  version: '1',
  reviewedByCounselAt: reviewed ? at('2026-10-01T00:00:00Z') : null,
  rules,
});

describe('parseJurisdictionPack', () => {
  it('parses the seeded US placeholder pack (not counsel-reviewed)', () => {
    const r = parseJurisdictionPack(US_PACK_ROW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.rules.contactWindow).toEqual({ start: localTime('08:00'), end: localTime('21:00') });
    expect(r.pack.rules.recordingPartyRule).toBe('unknown');
    expect(r.pack.rules.inquiryBasisDays).toBe(90);
    expect(r.pack.rules.dncScrubValidityDays).toBe(31);
    expect(r.pack.rules.optOutKeywords).toContain('OPT OUT');
    expect(r.pack.reviewedByCounselAt).toBeNull();
    expect(r.ignoredKeys).toEqual([]);
  });

  it('reports unknown keys without failing', () => {
    const r = parseJurisdictionPack({ ...US_PACK_ROW, rules: { ...US_PACK_ROW.rules, future_rule: 1 } });
    expect(r.ok && r.ignoredKeys).toEqual(['future_rule']);
  });

  it.each([
    ['contact_window', { start: '21:00', end: '08:00' }],
    ['contact_window', { start: 'nine' }],
    ['contact_window', 'all day'],
    ['restricted_days', ['sunday']],
    ['restricted_days', 'none'],
    ['recording_party_rule', 'two_party'],
    ['inquiry_basis_days', 0],
    ['inquiry_basis_days', 1.5],
    ['dnc_scrub_validity_days', '31'],
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
  it('R-CONSENT-13 default: 09:00–20:00 window, caps and categories of the shipped defaults', () => {
    const p = policy();
    expect(formatWindow(p.window)).toBe('09:00–20:00');
    expect(p.caps).toEqual({
      autoSmsPer24h: 1,
      autoSmsPer7d: 3,
      autoEmailPer24h: 1,
      autoEmailPer7d: 3,
      autoCrossChannelPer24h: 2,
      manualSmsConfirmAfter24h: 3,
      callAttemptsPer24h: 3,
      maxDeferrals: 3,
    });
    expect([...p.autonomous].sort()).toEqual(['booking_confirmation', 'nurture_step', 'reminder', 'search_alert', 'speed_to_lead_reply']);
    expect(p.recordingMode).toBe('announce_all');
    expect(p.recordingEnabled).toBe(true);
    expect(p.optOutConfirmationSender).toBe('provider');
    expect(p.emailQuietHours).toBe(false);
    expect(p.humanReplyWindowMin).toBe(30);
    expect(p.inquiryBasisDays).toBe(90);
    expect(p.dncValidityDays).toBe(31);
    expect(p.version).toEqual({ policyId: tenantPolicy().id, packs: { US: '2026.11.0' } });
    expect(p.unreviewedPacks).toEqual(['US']);
  });

  it('R-CONSENT-13 an Owner widens the window to the 08:00–21:00 floor only with an attestation', () => {
    const wide = { contactWindowStart: '08:00', contactWindowEnd: '21:00' };
    expect(formatWindow(policy(wide).window)).toBe('09:00–20:00');
    expect(formatWindow(policy({ ...wide, looseningAttestation: '  ' }).window)).toBe('09:00–20:00');
    expect(formatWindow(policy({ ...wide, looseningAttestation: 'I confirm counsel approved 8 AM to 9 PM.' }).window)).toBe('08:00–21:00');
    // Wider than the floor is clamped even with an attestation.
    expect(formatWindow(policy({ contactWindowStart: '07:00', contactWindowEnd: '22:00', looseningAttestation: 'x' }).window)).toBe('08:00–21:00');
    // A one-sided widening without attestation keeps the other (narrower) side.
    expect(formatWindow(policy({ contactWindowStart: '10:00', contactWindowEnd: '21:00' }).window)).toBe('10:00–20:00');
  });

  it('R-CONSENT-13 a tenant can narrow the window; a pack narrows the attested bound', () => {
    expect(formatWindow(policy({ contactWindowStart: '10:00', contactWindowEnd: '18:30' }).window)).toBe('10:00–18:30');
    const state = pack('US-XX', { contactWindow: { start: localTime('08:30'), end: localTime('20:30') } });
    const p = resolvePolicy(PLATFORM_FLOOR, [usPack(), state], tenantPolicy({ contactWindowStart: '08:00', contactWindowEnd: '21:00', looseningAttestation: 'x' }));
    expect(formatWindow(p.window)).toBe('08:30–20:30');
    const strict = pack('US-YY', { contactWindow: { start: localTime('10:00'), end: localTime('19:00') } });
    expect(formatWindow(resolvePolicy(PLATFORM_FLOOR, [strict], tenantPolicy()).window)).toBe('10:00–19:00');
  });

  it('R-CONSENT-13 conflicting windows resolve to an empty window (nothing contactable), never a wider one', () => {
    const late = pack('US-ZZ', { contactWindow: { start: localTime('12:00'), end: localTime('19:00') } });
    const p = resolvePolicy(PLATFORM_FLOOR, [late], tenantPolicy({ contactWindowStart: '09:00', contactWindowEnd: '11:00' }));
    expect(windowIsEmpty(p.window)).toBe(true);
    expect(windowIsEmpty(policy().window)).toBe(false);
    expect(formatLocalTime(p.window.start)).toBe('12:00');
  });

  it('R-CONSENT-14 tenants may only lower caps; bad numbers become 0 (strictest)', () => {
    const p = policy({ autoSmsPer24h: 5, autoSmsPer7d: 2, autoEmailPer24h: 0, autoEmailPer7d: 9, autoCrossChannelPer24h: 1.7, manualSmsConfirmAfter24h: Number.NaN, callAttemptsPer24h: -2, maxDeferrals: 9 });
    expect(p.caps).toEqual({
      autoSmsPer24h: 1,
      autoSmsPer7d: 2,
      autoEmailPer24h: 0,
      autoEmailPer7d: 3,
      autoCrossChannelPer24h: 1,
      manualSmsConfirmAfter24h: 0,
      callAttemptsPer24h: 0,
      maxDeferrals: 5,
    });
    expect(policy({ maxDeferrals: 0 }).caps.maxDeferrals).toBe(1);
    expect(policy({ humanReplyWindowMinutes: 45 }).humanReplyWindowMin).toBe(30);
    expect(policy({ humanReplyWindowMinutes: 10 }).humanReplyWindowMin).toBe(10);
  });

  it('autonomous categories are the tenant list ∩ the eligible set; always-human categories never pass', () => {
    const p = policy({ autonomousCategories: ['nurture_step', 'money', 'contract', 'novel_message', 'seller_update', 'bogus', 'document_chase'] });
    expect([...p.autonomous].sort()).toEqual(['document_chase', 'nurture_step']);
  });

  it('R-CONSENT-16 one-party recording mode needs an attestation', () => {
    expect(policy({ recordingMode: 'one_party_where_permitted' }).recordingMode).toBe('announce_all');
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

  it('R-CONSENT-15 packs shorten the inquiry window and DNC validity, never lengthen them', () => {
    const p = resolvePolicy(PLATFORM_FLOOR, [pack('US-DD', { inquiryBasisDays: 30, dncScrubValidityDays: 45 })], tenantPolicy());
    expect(p.inquiryBasisDays).toBe(30);
    expect(p.dncValidityDays).toBe(31);
  });

  it('email quiet hours and the opt-out confirmation sender follow the tenant', () => {
    expect(policy({ emailQuietHours: true }).emailQuietHours).toBe(true);
    expect(policy({ optOutConfirmationSender: 'platform' }).optOutConfirmationSender).toBe('platform');
  });

  it('records pack versions sorted by key and lists unreviewed packs', () => {
    const reviewed = pack('US-AZ', {}, true);
    const p = resolvePolicy(PLATFORM_FLOOR, [reviewed, usPack()], tenantPolicy());
    expect(Object.keys(p.version.packs)).toEqual(['US', 'US-AZ']);
    expect(p.unreviewedPacks).toEqual(['US']);
  });

  // Property: resolvePolicy never widens beyond the floor or the packs (BUILD_PLAN module 2).
  const timeArb = fc.integer({ min: 0, max: 24 * 4 }).map((q) => localTime(`${String(Math.floor(q / 4)).padStart(2, '0')}:${String((q % 4) * 15).padStart(2, '0')}`));
  const packArb = fc.record({
    start: timeArb,
    len: fc.integer({ min: 1, max: 24 * 4 }),
    inquiry: fc.option(fc.integer({ min: 1, max: 400 }), { nil: undefined }),
    dnc: fc.option(fc.integer({ min: 1, max: 400 }), { nil: undefined }),
  });
  it('property: resolvePolicy never widens beyond the floor or any pack', () => {
    fc.assert(
      fc.property(
        fc.array(packArb, { maxLength: 3 }),
        timeArb,
        fc.integer({ min: 1, max: 96 }),
        fc.boolean(),
        fc.record({ s: fc.integer({ min: -2, max: 9 }), s7: fc.integer({ min: -2, max: 9 }), e: fc.integer({ min: -2, max: 9 }), x: fc.integer({ min: -2, max: 9 }), m: fc.integer({ min: -2, max: 9 }), c: fc.integer({ min: -2, max: 9 }) }),
        fc.subarray([...AUTONOMOUS_ELIGIBLE, 'money', 'contract', 'novel_message', 'seller_update', 'none']),
        (rawPacks, tStart, tLen, attested, caps, cats) => {
          const packs = rawPacks.map((r, i) => {
            const end = Math.min(86_400, r.start + r.len * 900);
            return pack(`US-P${String.fromCharCode(65 + i)}`, {
              ...(r.start < end ? { contactWindow: { start: r.start, end: end as never } } : {}),
              ...(r.inquiry === undefined ? {} : { inquiryBasisDays: r.inquiry }),
              ...(r.dnc === undefined ? {} : { dncScrubValidityDays: r.dnc }),
            });
          });
          const tEnd = Math.min(86_400, tStart + tLen * 900);
          if (tStart >= tEnd) return;
          const t = tenantPolicy({
            contactWindowStart: tStart,
            contactWindowEnd: tEnd as never,
            looseningAttestation: attested ? 'attested' : null,
            autoSmsPer24h: caps.s,
            autoSmsPer7d: caps.s7,
            autoEmailPer24h: caps.e,
            autoCrossChannelPer24h: caps.x,
            manualSmsConfirmAfter24h: caps.m,
            callAttemptsPer24h: caps.c,
            autonomousCategories: cats,
          });
          const p = resolvePolicy(PLATFORM_FLOOR, packs, t);
          if (!windowIsEmpty(p.window)) {
            expect(p.window.start).toBeGreaterThanOrEqual(PLATFORM_FLOOR.widestWindow.start);
            expect(p.window.end).toBeLessThanOrEqual(PLATFORM_FLOOR.widestWindow.end);
            expect(p.window.start).toBeGreaterThanOrEqual(t.contactWindowStart as number);
            expect(p.window.end).toBeLessThanOrEqual(t.contactWindowEnd as number);
            for (const pk of packs) {
              if (!pk.rules.contactWindow) continue;
              expect(p.window.start).toBeGreaterThanOrEqual(pk.rules.contactWindow.start);
              expect(p.window.end).toBeLessThanOrEqual(pk.rules.contactWindow.end);
            }
            if (!attested) {
              expect(p.window.start).toBeGreaterThanOrEqual(PLATFORM_FLOOR.defaultWindow.start);
              expect(p.window.end).toBeLessThanOrEqual(PLATFORM_FLOOR.defaultWindow.end);
            }
          }
          for (const k of Object.keys(PLATFORM_FLOOR.maxCaps) as (keyof typeof PLATFORM_FLOOR.maxCaps)[]) {
            expect(p.caps[k]).toBeLessThanOrEqual(PLATFORM_FLOOR.maxCaps[k]);
            expect(p.caps[k]).toBeGreaterThanOrEqual(0);
          }
          for (const c of p.autonomous) expect(AUTONOMOUS_ELIGIBLE.has(c)).toBe(true);
          for (const pk of packs) {
            if (pk.rules.inquiryBasisDays !== undefined) expect(p.inquiryBasisDays).toBeLessThanOrEqual(pk.rules.inquiryBasisDays);
            if (pk.rules.dncScrubValidityDays !== undefined) expect(p.dncValidityDays).toBeLessThanOrEqual(pk.rules.dncScrubValidityDays);
          }
          expect(p.inquiryBasisDays).toBeLessThanOrEqual(PLATFORM_FLOOR.maxInquiryBasisDays);
          expect(p.dncValidityDays).toBeLessThanOrEqual(PLATFORM_FLOOR.maxDncValidityDays);
          for (const k of PLATFORM_FLOOR.keywords.optOut) expect(p.keywords.optOut).toContain(k);
        },
      ),
      { numRuns: 400 },
    );
  });
});
