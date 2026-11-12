import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, type IanaZone, at, instant, zone } from '../foundation/index.js';
import type { GrantEvidence } from './consent.js';
import { type CapCounts, type ChannelFacts, ISA_REASON_CLASS, type PlanInput, capsCheck, gapReadyAt, isaReasonClass, messageKind, planSend, refusalClass } from './sendPolicy.js';

const NOW = at('2026-11-18T16:00:00Z'); // Wed 11:00 ET
const PHONE = 'a'.repeat(64);
const EMAIL = 'c'.repeat(64);
const NY = zone('America/New_York');
const zero: CapCounts = { ai24h: 0, automated24h: 0, initiated24h: 0, initiated7d: 0, lastAiOutboundAt: null };
const disclosure = { id: 'd1', body: 'Maple Team may contact you.', scopeStated: true, channels: ['sms', 'email'], purposes: ['marketing'], origin: 'inquiry' as const };
const g = (channel: 'sms' | 'email', hmac: string): GrantEvidence => ({ consentEventId: `g-${channel}`, channel, purpose: 'marketing', level: 'express_written', source: 'web_form', addressHmac: hmac, recordedAt: at('2026-11-15T00:00:00Z'), expiresAt: null, imported: false, needsReview: false, disclosure, evidenceObject: false });
const sms = (o: Partial<ChannelFacts['consent']> = {}, inbound: ChannelFacts['inbound'] = null): ChannelFacts => ({
  channel: 'sms',
  boundHmac: PHONE,
  inbound,
  lastAiOutboundAt: null,
  consent: { personHmacs: [PHONE], consentState: [], grants: [g('sms', PHONE)], negatives: [], dnc: [{ checkId: 'd', addressHmac: PHONE, result: 'not_listed', checkedAt: NOW }], tenantNames: ['Maple Team'], rules: { d12EffectiveAt: at('2026-11-12T00:00:00Z') }, lastInbound: null, lastAiOutboundAt: null, ...o },
});
const email = (o: Partial<ChannelFacts['consent']> = {}): ChannelFacts => ({ channel: 'email', boundHmac: EMAIL, inbound: null, lastAiOutboundAt: null, consent: { ...sms().consent, personHmacs: [EMAIL], grants: [g('email', EMAIL)], dnc: [], ...o } });
const plan = (o: Partial<PlanInput> = {}): PlanInput => ({ now: NOW, preferred: 'sms', channels: [sms(), email()], content: { kind: 'conversation', hasFact: false }, emailOnly: false, zones: [NY], window: { startSec: 9 * 3600, endSec: 20 * 3600 }, initiatedDays: [1, 2, 3, 4, 5, 6], noInitiatedOnHolidays: true, counts: zero, ...o });
const inb = { messageId: 'in', channel: 'sms' as const, fromHmac: PHONE, at: instant(NOW - HOUR_MS), dkimAligned: null };

describe('R-ISA-9 messageKind: reply or initiated, computed by core', () => {
  const mk = (o: Partial<Parameters<typeof messageKind>[0]> = {}) => messageKind({ now: NOW, channel: 'sms', boundHmac: PHONE, content: { kind: 'conversation', hasFact: false }, inbound: inb, lastAiOutboundAt: null, ...o });
  it('a conversation reply to their own recent bound inbound is a reply', () => expect(mk()).toBe('reply'));
  it('any fact, a facts message, no inbound, another channel or point, outside the window, or after the last AI outbound is initiated', () => {
    expect(mk({ content: { kind: 'conversation', hasFact: true } })).toBe('initiated');
    expect(mk({ content: { kind: 'facts', hasFact: false } })).toBe('initiated');
    expect(mk({ inbound: null })).toBe('initiated');
    expect(mk({ inbound: { ...inb, channel: 'email' } })).toBe('initiated');
    expect(mk({ inbound: { ...inb, fromHmac: EMAIL } })).toBe('initiated');
    expect(mk({ inbound: { ...inb, at: instant(NOW - 25 * HOUR_MS) } })).toBe('initiated');
    expect(mk({ lastAiOutboundAt: NOW })).toBe('initiated');
    expect(mk({ channel: 'email', boundHmac: EMAIL, inbound: { ...inb, channel: 'email', fromHmac: EMAIL, dkimAligned: false } })).toBe('initiated');
    expect(mk({ channel: 'email', boundHmac: EMAIL, inbound: { ...inb, channel: 'email', fromHmac: EMAIL, dkimAligned: true } })).toBe('reply');
    expect(mk({ inbound: { ...inb, at: instant(NOW + 1) } })).toBe('initiated');
  });
});

describe('R-ISA-11 E515 caps', () => {
  it('a 4th AI message in 24 h, the AI yielding to bulk, initiated limits, the 120 s gap', () => {
    expect(capsCheck({ ...zero, ai24h: 3 }, 'reply', NOW)).toEqual(['ISA_CAP_REACHED']);
    expect(capsCheck({ ...zero, automated24h: 3 }, 'reply', NOW)).toEqual(['ISA_CAP_REACHED']);
    expect(capsCheck({ ...zero, initiated24h: 1 }, 'initiated', NOW)).toEqual(['ISA_CAP_REACHED']);
    expect(capsCheck({ ...zero, initiated24h: 1 }, 'reply', NOW)).toEqual([]);
    expect(capsCheck({ ...zero, initiated7d: 3 }, 'initiated', NOW)).toEqual(['ISA_CAP_REACHED']);
    expect(capsCheck({ ...zero, lastAiOutboundAt: instant(NOW - 119_000) }, 'reply', NOW)).toEqual(['ISA_MIN_GAP']);
    expect(capsCheck({ ...zero, lastAiOutboundAt: instant(NOW - 120_000) }, 'reply', NOW)).toEqual([]);
    expect(capsCheck({ ...zero, ai24h: 2, automated24h: 2 }, 'initiated', NOW)).toEqual([]);
    expect(gapReadyAt({ lastAiOutboundAt: instant(NOW - 60_000) }, NOW)).toBe(instant(NOW + 60_000));
    expect(gapReadyAt({ lastAiOutboundAt: null }, NOW)).toBe(NOW);
  });
  it('property: within caps iff every count is below its cap (and the gap passed)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 5 }), fc.integer({ min: 0, max: 3 }), fc.integer({ min: 0, max: 5 }), fc.constantFrom('reply' as const, 'initiated' as const), (a, b, c, d, tier) => {
        const r = capsCheck({ ai24h: a, automated24h: b, initiated24h: c, initiated7d: d, lastAiOutboundAt: null }, tier, NOW);
        const over = a >= 3 || b >= 3 || (tier === 'initiated' && (c >= 1 || d >= 3));
        expect(r.includes('ISA_CAP_REACHED')).toBe(over);
      }),
    );
  });
});

describe('R-ISA-8 planSend', () => {
  it('a reply goes now on SMS with the own-inbound basis', () => {
    const p = planSend(plan({ channels: [sms({}, null), email()].map((c) => (c.channel === 'sms' ? { ...c, inbound: inb } : c)) }));
    expect(p).toMatchObject({ ok: true, channel: 'sms', tier: 'reply', basis: { kind: 'own_inbound', messageId: 'in' }, notBefore: NOW, fellBackToEmail: false, deferredBy: [] });
  });
  it('E519 SMS failing ONLY on evidence falls back to email when email passes', () => {
    const p = planSend(plan({ channels: [sms({ grants: [] }), email()] }));
    expect(p).toMatchObject({ ok: true, channel: 'email', tier: 'initiated', fellBackToEmail: true });
  });
  it('no email fallback after a DNC failure or an opt-out on SMS', () => {
    expect(planSend(plan({ channels: [sms({ dnc: [] }), email()] }))).toMatchObject({ ok: false, codes: ['ISA_DNC_UNVERIFIED'] });
    const revoked = { channel: 'sms' as const, purpose: 'marketing' as const, addressHmac: PHONE, status: 'revoked' as const, level: 'none' as const, basisEventId: null, expiresAt: null, ledgerEventCount: 1 };
    expect(planSend(plan({ channels: [sms({ consentState: [revoked] }), email()] }))).toMatchObject({ ok: false, codes: ['ISA_CONSENT_EVIDENCE_MISSING'] });
  });
  it('nothing sends when neither channel has evidence; the channel missing is ISA_CHANNEL_NOT_ALLOWED', () => {
    expect(planSend(plan({ channels: [sms({ grants: [] }), email({ grants: [] })] }))).toMatchObject({ ok: false, codes: ['ISA_CONSENT_EVIDENCE_MISSING'] });
    expect(planSend(plan({ channels: [] }))).toMatchObject({ ok: false, codes: ['ISA_CHANNEL_NOT_ALLOWED'] });
    expect(planSend(plan({ emailOnly: true, channels: [sms()] }))).toMatchObject({ ok: false, codes: ['ISA_CHANNEL_NOT_ALLOWED'] });
  });
  it('sold-derived facts go by email only', () => {
    expect(planSend(plan({ emailOnly: true, content: { kind: 'facts', hasFact: true } }))).toMatchObject({ ok: true, channel: 'email' });
  });
  it('E511 E515 the window and the gap set notBefore; caps refuse', () => {
    const late = planSend(plan({ now: at('2026-11-19T04:10:00Z') }));
    expect(late).toMatchObject({ ok: true, notBefore: at('2026-11-19T14:00:00Z'), deferredBy: ['ISA_QUIET_HOURS'] });
    const gap = planSend(plan({ counts: { ...zero, lastAiOutboundAt: instant(NOW - 60_000) } }));
    expect(gap).toMatchObject({ ok: true, notBefore: instant(NOW + 60_000), deferredBy: ['ISA_MIN_GAP'] });
    expect(planSend(plan({ counts: { ...zero, ai24h: 3 } }))).toMatchObject({ ok: false, codes: ['ISA_CAP_REACHED'] });
    expect(planSend(plan({ zones: [zone('America/New_York'), zone('Asia/Shanghai')] as IanaZone[] }))).toMatchObject({ ok: false, zoneWindowsDoNotOverlap: true });
    expect(planSend(plan({ preferred: 'email' }))).toMatchObject({ ok: true, channel: 'email' });
  });
  void DAY_MS;
});

describe('R-ISA-8 the dispatch reason classes', () => {
  it('deferrable, replan, terminal and end_care', () => {
    expect(isaReasonClass('ISA_QUIET_HOURS')).toBe('deferrable');
    expect(isaReasonClass('ISA_STALE_REPLY')).toBe('replan');
    expect(isaReasonClass('ISA_UNBOUND_RECIPIENT')).toBe('terminal');
    expect(isaReasonClass('ASSISTANT_ACTION_WITHDRAWN')).toBe('terminal');
    expect(isaReasonClass('CONSENT_REVOKED')).toBe('end_care');
    expect(refusalClass(['ISA_QUIET_HOURS', 'ISA_STALE_REPLY'])).toBe('replan');
    expect(refusalClass(['ISA_QUIET_HOURS', 'SUPPRESSED'])).toBe('end_care');
    expect(refusalClass(['ISA_CAP_REACHED', 'ISA_NOT_AUTHORIZED'])).toBe('terminal');
    expect(refusalClass([])).toBe('deferrable');
    expect(Object.values(ISA_REASON_CLASS).every((c) => ['deferrable', 'replan', 'end_care'].includes(c))).toBe(true);
  });
});
