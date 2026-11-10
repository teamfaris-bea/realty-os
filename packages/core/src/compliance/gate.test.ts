import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type IanaZone, type Instant, at, instant, localTime, zone } from '../foundation/index.js';
import { canonicalJson, sha256Hex } from './digest.js';
import {
  type GateDecision,
  type GateInput,
  MAX_JITTER_SECONDS,
  RULES_VERSION,
  afterDeferral,
  canConfirm,
  canContact,
  gateInputsRecord,
  nextContactableAt,
} from './gate.js';
import { NEVER_CONFIRMABLE, REASON_CODES, REASON_EFFECTS, type ReasonCode, humanLocalTime } from './reasons.js';
import { CHI, H1, H2, LA, NOW, NY, assistantInput, days, gateInput, grantRow, hours, minutes, policy } from './testing/fixtures.js';
import type { ConsentStateRow, DncCheckRow } from './types.js';

// Every decision made in this file is recorded so the last test can prove that every reason code
// is produced by at least one test (BUILD_PLAN module 2 acceptance).
const seen = new Set<ReasonCode>();
function decide(input: GateInput): GateDecision {
  const d = canContact(input);
  for (const r of d.reasons) seen.add(r);
  return d;
}
const T = (ms: number): Instant => instant(NOW + ms);
/** Tue 2026-11-10 22:00 EST: outside the window in New York. */
const NIGHT = at('2026-11-11T03:00:00Z');
/** Wed 2026-11-11 09:00 EST. */
const NEXT_OPEN = at('2026-11-11T14:00:00Z');

const express = (o: Partial<ConsentStateRow> = {}) => grantRow({ level: 'express', ...o });
const written = (o: Partial<ConsentStateRow> = {}) => grantRow({ level: 'express_written', ...o });
const mkt = (o: Partial<ConsentStateRow> = {}) => grantRow({ purpose: 'marketing', ...o });
const revoked = (o: Partial<ConsentStateRow> = {}) => grantRow({ status: 'revoked', level: 'none', ...o });
const dncClear = (o: Partial<DncCheckRow> = {}): DncCheckRow => ({ registry: 'us_national', listed: false, checkedAt: T(-days(1)), validUntil: T(days(30)), ...o });
const dncListed = (o: Partial<DncCheckRow> = {}): DncCheckRow => dncClear({ listed: true, ...o });
const email = { recipient: { kind: 'contact' as const, addressHmac: H1, channel: 'email' as const }, sender: { kind: 'email' as const, registration: 'ready' as const, domainVerified: true } };
const voice = { recipient: { kind: 'contact' as const, addressHmac: H1, channel: 'voice' as const }, rendered: undefined };
const toAgent = { recipient: { kind: 'user' as const, addressHmac: H2, channel: 'sms' as const }, category: 'agent_alert' as const, initiator: 'system' as const, contactPoint: null, consent: [] };

function expectDecision(d: GateDecision, outcome: GateDecision['outcome'], ...reasons: ReasonCode[]): void {
  expect(d.outcome).toBe(outcome);
  for (const r of reasons) expect(d.reasons).toContain(r);
}

describe('baseline', () => {
  it('a clean human informational SMS is allowed with no reasons', () => {
    const d = decide(gateInput());
    expect(d).toMatchObject({ outcome: 'allow', reasons: [], explanation: 'OK to send', rulesVersion: RULES_VERSION });
    expect(d.deferUntil).toBeUndefined();
    expect(d.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a clean assistant nurture SMS with express_written marketing consent is allowed', () => {
    expect(decide(assistantInput({ purpose: 'marketing', consent: [mkt({ level: 'express_written' })], dnc: [dncClear()] })).outcome).toBe('allow');
  });
});

// ---- ARCHITECTURE §9: one row per check, for both initiator columns -------------------------------
describe('ARCHITECTURE §9 check table', () => {
  const both = (name: string, o: Partial<GateInput>, auto: [GateDecision['outcome'], ReasonCode], human: [GateDecision['outcome'], ReasonCode]) => {
    it(`§9 ${name}: assistant/system ⇒ ${auto[0]} ${auto[1]}`, () => expectDecision(decide(assistantInput({ consent: [written()], ...o })), ...auto));
    it(`§9 ${name}: human ⇒ ${human[0]} ${human[1]}`, () => expectDecision(decide(gateInput(o)), ...human));
  };
  both('1 tenant suspended', { tenant: { suspended: true, brokerageNamePresent: true, postalAddressPresent: true } }, ['deny', 'TENANT_SUSPENDED'], ['deny', 'TENANT_SUSPENDED']);
  both('2 contact point invalid', { contactPoint: { status: 'invalid', lineType: 'mobile' } }, ['deny', 'CONTACT_POINT_INVALID'], ['deny', 'CONTACT_POINT_INVALID']);
  both('2 wrong number', { contactPoint: { status: 'wrong_number', lineType: 'mobile' } }, ['deny', 'WRONG_NUMBER'], ['deny', 'WRONG_NUMBER']);
  both('2 SMS to a landline', { contactPoint: { status: 'active', lineType: 'landline' } }, ['deny', 'LANDLINE_NO_SMS'], ['deny', 'LANDLINE_NO_SMS']);
  both('3 sender not registered', { sender: { kind: 'phone', registration: 'pending' } }, ['deny', 'SENDER_NOT_REGISTERED'], ['deny', 'SENDER_NOT_REGISTERED']);
  both('3 marketing email from an unverified domain', { ...email, purpose: 'marketing', sender: { kind: 'email', registration: 'ready', domainVerified: false } }, ['deny', 'EMAIL_DOMAIN_UNVERIFIED'], ['deny', 'EMAIL_DOMAIN_UNVERIFIED']);
  both('4 marketing without the brokerage name rendered', { purpose: 'marketing', rendered: { containsBrokerageName: false, containsOptOutHint: true, paymentInstructions: false } }, ['deny', 'BROKERAGE_IDENTITY_MISSING'], ['deny', 'BROKERAGE_IDENTITY_MISSING']);
  both('4 marketing email without a postal address', { ...email, purpose: 'marketing', tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: false } }, ['deny', 'POSTAL_ADDRESS_MISSING'], ['deny', 'POSTAL_ADDRESS_MISSING']);
  both('4 marketing email without unsubscribe', { ...email, purpose: 'marketing', rendered: { containsBrokerageName: true, containsOptOutHint: false, paymentInstructions: false } }, ['deny', 'UNSUBSCRIBE_MISSING'], ['deny', 'UNSUBSCRIBE_MISSING']);
  both('5 consent revoked', { consent: [revoked()] }, ['deny', 'CONSENT_REVOKED'], ['deny', 'CONSENT_REVOKED']);
  both('6 active suppression', { suppressions: [{ channel: 'sms', reason: 'internal_dnc', liftedAt: null }] }, ['deny', 'SUPPRESSED'], ['deny', 'SUPPRESSED']);
  both('7 payment instructions', { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } }, ['deny', 'PAYMENT_INSTRUCTIONS'], ['deny', 'PAYMENT_INSTRUCTIONS']);
  both('8 consent basis below minimum', { consent: [] }, ['deny', 'CONSENT_BASIS_INSUFFICIENT'], ['needs_confirmation', 'CONSENT_CONFIRMATION_REQUIRED']);
  both('9 DNC listed (marketing)', { purpose: 'marketing', consent: [mkt({ level: 'express' })], dnc: [dncListed()] }, ['deny', 'DNC_LISTED'], ['deny', 'DNC_LISTED']);
  both('11 outside the contact window', { now: NIGHT }, ['defer', 'QUIET_HOURS_DEFERRED'], ['deny', 'OUTSIDE_CONTACT_WINDOW']);
  both('13 weak timezone evidence', { zones: { zones: [NY], source: 'area_code' } }, ['allow', 'RECIPIENT_TZ_UNCERTAIN'], ['allow', 'RECIPIENT_TZ_UNCERTAIN']);

  it('§9 8 human marketing SMS with only an imported basis ⇒ deny CONSENT_IMPORTED_BASIS_ONLY', () => {
    expectDecision(decide(gateInput({ purpose: 'marketing', consent: [mkt({ level: 'imported_unverified' })], dnc: [dncClear()] })), 'deny', 'CONSENT_IMPORTED_BASIS_ONLY');
  });
  it('§9 10 automation paused: assistant ⇒ deny; human ⇒ allowed (humans can always reply)', () => {
    expectDecision(decide(assistantInput({ consent: [written()], automationPausedAt: T(-minutes(5)) })), 'deny', 'AUTOMATION_PAUSED');
    expect(decide(gateInput({ automationPausedAt: T(-minutes(5)) })).outcome).toBe('allow');
  });
  it('§9 11 human informational reply within 30 min of an inbound outside the window ⇒ needs_confirmation', () => {
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: instant(NIGHT - minutes(10)) })), 'needs_confirmation', 'OUTSIDE_WINDOW_REPLY');
  });
  it('§9 12 caps: assistant ⇒ defer; human SMS > 3/24 h ⇒ needs_confirmation; > 3 calls/24 h ⇒ deny', () => {
    expectDecision(decide(assistantInput({ consent: [written()], recentAutomated: [{ channel: 'sms', at: T(-hours(1)), exempt: false }] })), 'defer', 'FREQUENCY_CAP');
    expectDecision(decide(gateInput({ recentManualSms24h: 3 })), 'needs_confirmation', 'MANUAL_SMS_VOLUME');
    expectDecision(decide(gateInput({ ...voice, callAttempts24h: 3 })), 'deny', 'CALL_ATTEMPT_LIMIT');
  });
  it('§9 precedence: any deny ⇒ deny; then needs_confirmation; then defer; all reasons are collected', () => {
    const d = decide(gateInput({ now: NIGHT, consent: [], recentManualSms24h: 5, suppressions: [{ channel: 'all', reason: 'admin_block', liftedAt: null }] }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toEqual(['SUPPRESSED', 'CONSENT_CONFIRMATION_REQUIRED', 'OUTSIDE_CONTACT_WINDOW', 'MANUAL_SMS_VOLUME']);
    const c = decide(gateInput({ consent: [], recentManualSms24h: 5 }));
    expect(c.reasons).toEqual(['CONSENT_CONFIRMATION_REQUIRED', 'MANUAL_SMS_VOLUME']);
    expect(c.outcome).toBe('needs_confirmation');
    const a = decide(assistantInput({ now: NIGHT, consent: [written()], recentAutomated: [{ channel: 'sms', at: instant(NIGHT - hours(1)), exempt: false }] }));
    expect(a.outcome).toBe('defer');
    expect(a.reasons).toEqual(['FREQUENCY_CAP', 'QUIET_HOURS_DEFERRED']);
  });
});

describe('check details', () => {
  it('category rules: always-human categories are never automated; the assistant sends only approved autonomous categories', () => {
    const money = decide(assistantInput({ category: 'money', consent: [written()] }));
    expect(money.reasons).toEqual(['CATEGORY_REQUIRES_HUMAN', 'CATEGORY_NOT_AUTONOMOUS']);
    expectDecision(decide(gateInput({ initiator: 'system', category: 'contract' })), 'deny', 'CATEGORY_REQUIRES_HUMAN');
    expect(decide(gateInput({ category: 'novel_message' })).outcome).toBe('allow');
    expectDecision(decide(assistantInput({ category: 'document_chase', consent: [written()] })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
    expect(decide(assistantInput({ category: 'document_chase', consent: [written()], policy: policy({ autonomousCategories: ['document_chase'] }) })).outcome).toBe('allow');
    expect(decide(gateInput({ initiator: 'system', category: 'reminder', consent: [written()] })).outcome).toBe('allow');
  });
  // R-GATE-9 itself is a DB CHECK on calls.initiator; the gate refuses automated calls as well.
  it('no automated calls in Phase 1: the gate refuses them', () => {
    expectDecision(decide(assistantInput({ ...voice, consent: [written({ channel: 'voice' })] })), 'deny', 'AUTOMATED_VOICE_UNAVAILABLE');
    expectDecision(decide(gateInput({ ...voice, initiator: 'system', category: 'reminder' })), 'deny', 'AUTOMATED_VOICE_UNAVAILABLE');
  });
  it('agent alerts go only to users, and users only get agent alerts', () => {
    expectDecision(decide(gateInput({ category: 'agent_alert', initiator: 'system' })), 'deny', 'RECIPIENT_CATEGORY_MISMATCH');
    expectDecision(decide(gateInput({ ...toAgent, category: 'none' })), 'deny', 'RECIPIENT_CATEGORY_MISMATCH');
  });
  it('contact point: missing, bouncing or removed is invalid; a landline can still be called', () => {
    expectDecision(decide(gateInput({ contactPoint: null })), 'deny', 'CONTACT_POINT_INVALID');
    expectDecision(decide(gateInput({ contactPoint: { status: 'bouncing', lineType: 'mobile' } })), 'deny', 'CONTACT_POINT_INVALID');
    expectDecision(decide(gateInput({ contactPoint: { status: 'removed', lineType: 'mobile' } })), 'deny', 'CONTACT_POINT_INVALID');
    expect(decide(gateInput({ ...voice, contactPoint: { status: 'active', lineType: 'landline' } })).outcome).toBe('allow');
    expect(decide(gateInput({ contactPoint: { status: 'active', lineType: 'unknown' } })).outcome).toBe('allow');
  });
  it('sender: missing or the wrong kind is unavailable; voice tolerates a pending 10DLC registration but not a blocked number', () => {
    expectDecision(decide(gateInput({ sender: null })), 'deny', 'SENDER_UNAVAILABLE');
    expectDecision(decide(gateInput({ ...email, sender: { kind: 'phone', registration: 'ready' } })), 'deny', 'SENDER_UNAVAILABLE');
    expectDecision(decide(gateInput({ sender: { kind: 'email', registration: 'ready' } })), 'deny', 'SENDER_UNAVAILABLE');
    expect(decide(gateInput({ ...voice, sender: { kind: 'phone', registration: 'pending' } })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...voice, sender: { kind: 'phone', registration: 'blocked' } })), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(decide(gateInput({ ...email, sender: { kind: 'email', registration: 'blocked' } })), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(decide(gateInput({ ...email, purpose: 'marketing', sender: { kind: 'email', registration: 'ready' } })), 'deny', 'EMAIL_DOMAIN_UNVERIFIED');
    expectDecision(decide(gateInput({ ...email, purpose: 'marketing', sender: null })), 'deny', 'EMAIL_DOMAIN_UNVERIFIED', 'SENDER_UNAVAILABLE');
  });
  it('message channels need the rendered content checked; calls do not', () => {
    expectDecision(decide(gateInput({ rendered: undefined })), 'deny', 'RENDERED_CONTENT_MISSING');
    expectDecision(decide(gateInput({ ...email, rendered: undefined })), 'deny', 'RENDERED_CONTENT_MISSING');
    expect(decide(gateInput({ ...voice })).outcome).toBe('allow');
  });
  it('suppressions: channel-specific or all; lifted ones are ignored', () => {
    expect(decide(gateInput({ suppressions: [{ channel: 'email', reason: 'hard_bounce', liftedAt: null }] })).outcome).toBe('allow');
    expect(decide(gateInput({ suppressions: [{ channel: 'sms', reason: 'internal_dnc', liftedAt: T(-days(1)) }] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...email, suppressions: [{ channel: 'all', reason: 'admin_block', liftedAt: null }] })), 'deny', 'SUPPRESSED');
    expectDecision(decide(gateInput({ ...email, suppressions: [{ channel: 'email', reason: 'spam_complaint', liftedAt: null }] })), 'deny', 'SUPPRESSED');
  });
  it('opt-out is channel and purpose specific; a marketing-only revoke does not block an informational text', () => {
    expect(decide(gateInput({ consent: [express(), mkt({ status: 'revoked', level: 'none' })] })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, consent: [revoked({ channel: 'sms' })] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...email, consent: [revoked({ channel: 'email' })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(gateInput({ ...voice, consent: [revoked({ channel: 'voice' })] })), 'deny', 'CONSENT_REVOKED');
  });
  it("an SMS revoke on another of the contact's phones also blocks this number", () => {
    expectDecision(decide(gateInput({ consent: [express(), revoked({ addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expect(decide(gateInput({ ...email, consent: [revoked({ addressHmac: H2 })] })).outcome).toBe('allow');
    expect(decide(gateInput({ consent: [express(), revoked({ addressHmac: H2, purpose: 'marketing' })] })).outcome).toBe('allow');
  });
});

// ---- R-CONSENT-5: every cell ----------------------------------------------------------------------
describe('R-CONSENT-5 minimum consent per send', () => {
  const inbound29d = T(-days(29));
  it.each([
    ['express (native)', [express()], 'allow'],
    ['express_written', [written()], 'allow'],
    ['express from texting first (inbound_first_contact projects to express informational)', [express({ basisEventId: 'first-text' })], 'allow'],
    ['inquiry only', [grantRow({ level: 'inquiry', expiresAt: T(days(10)) })], 'deny'],
    ['imported_unverified only', [grantRow({ level: 'imported_unverified' })], 'deny'],
    ['no basis', [], 'deny'],
    ['an expired express basis', [express({ expiresAt: T(-1) })], 'deny'],
  ] as const)('R-CONSENT-5 SMS informational, assistant/system: %s ⇒ %s', (_n, consent, outcome) => {
    const d = decide(assistantInput({ consent: [...consent] }));
    expect(d.outcome).toBe(outcome);
    if (outcome === 'deny') expect(d.reasons).toEqual(['CONSENT_BASIS_INSUFFICIENT']);
    expect(decide(gateInput({ initiator: 'system', category: 'reminder', consent: [...consent] })).outcome).toBe(outcome);
  });

  it.each([
    ['no basis, no inbound', [], null, 'needs_confirmation'],
    ['no basis, contact wrote in 29 days ago', [], inbound29d, 'allow'],
    ['no basis, inbound 31 days ago', [], T(-days(31)), 'needs_confirmation'],
    ['inquiry basis', [grantRow({ level: 'inquiry', expiresAt: T(days(1)) })], null, 'allow'],
    ['expired inquiry basis', [grantRow({ level: 'inquiry', expiresAt: T(-1) })], null, 'needs_confirmation'],
    ['imported_unverified basis', [grantRow({ level: 'imported_unverified' })], null, 'allow'],
    ['revoked', [revoked()], inbound29d, 'deny'],
  ] as const)('R-CONSENT-5 SMS informational, human: %s ⇒ %s', (_n, consent, lastInboundAt, outcome) => {
    expect(decide(gateInput({ consent: [...consent], lastInboundAt })).outcome).toBe(outcome);
  });

  it.each([
    ['express_written', [mkt({ level: 'express_written' })], 'allow'],
    ['express', [mkt({ level: 'express' })], 'deny'],
    ['imported_unverified', [mkt({ level: 'imported_unverified' })], 'deny'],
    ['express on informational only', [express()], 'deny'],
  ] as const)('R-CONSENT-5 SMS marketing, assistant/system: %s ⇒ %s', (_n, consent, outcome) => {
    expect(decide(assistantInput({ purpose: 'marketing', category: 'search_alert', consent: [...consent], dnc: [dncClear()] })).outcome).toBe(outcome);
  });

  it.each([
    ['inquiry (unexpired)', [mkt({ level: 'inquiry', expiresAt: T(days(5)) })], 'allow', []],
    ['express', [mkt({ level: 'express' })], 'allow', []],
    ['no basis', [], 'needs_confirmation', ['CONSENT_CONFIRMATION_REQUIRED']],
    ['expired inquiry', [mkt({ level: 'inquiry', expiresAt: T(-1) })], 'needs_confirmation', ['CONSENT_CONFIRMATION_REQUIRED']],
    ['only an imported basis', [mkt({ level: 'imported_unverified' })], 'deny', ['CONSENT_IMPORTED_BASIS_ONLY']],
  ] as const)('R-CONSENT-5 SMS marketing, human: %s ⇒ %s', (_n, consent, outcome, reasons) => {
    const d = decide(gateInput({ purpose: 'marketing', consent: [...consent], dnc: [dncClear()] }));
    expect(d.outcome).toBe(outcome);
    expect(d.reasons).toEqual(reasons);
  });

  it('R-CONSENT-5 voice, assistant/system: not available in Phase 1', () => {
    for (const purpose of ['informational', 'marketing'] as const) {
      expectDecision(decide(assistantInput({ ...voice, purpose, consent: [written({ channel: 'voice', purpose })] })), 'deny', 'AUTOMATED_VOICE_UNAVAILABLE');
    }
  });
  it('R-CONSENT-5 voice informational, human: allowed unless revoked or internal DNC; no basis needed', () => {
    expect(decide(gateInput({ ...voice, consent: [] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...voice, consent: [revoked({ channel: 'voice' })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(gateInput({ ...voice, suppressions: [{ channel: 'voice', reason: 'internal_dnc', liftedAt: null }] })), 'deny', 'SUPPRESSED');
  });
  it('R-CONSENT-5 voice marketing, human: also needs R-CONSENT-15', () => {
    expect(decide(gateInput({ ...voice, purpose: 'marketing', consent: [], dnc: [dncClear()] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...voice, purpose: 'marketing', consent: [] })), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
  });
  it('R-CONSENT-5 email informational: allowed unless revoked/suppressed, for both initiators', () => {
    for (const mk of [gateInput, (o: Partial<GateInput>) => assistantInput({ category: 'speed_to_lead_reply', ...o })]) {
      expect(decide(mk({ ...email, consent: [] })).outcome).toBe('allow');
      expectDecision(decide(mk({ ...email, consent: [revoked({ channel: 'email' })] })), 'deny', 'CONSENT_REVOKED');
      expectDecision(decide(mk({ ...email, suppressions: [{ channel: 'email', reason: 'hard_bounce', liftedAt: null }] })), 'deny', 'SUPPRESSED');
    }
  });
  it('R-CONSENT-5 email marketing: opt-out model + verified domain + postal address + unsubscribe + brokerage name, for both initiators', () => {
    for (const mk of [gateInput, (o: Partial<GateInput>) => assistantInput({ category: 'search_alert', ...o })]) {
      expect(decide(mk({ ...email, purpose: 'marketing', consent: [] })).outcome).toBe('allow');
      const bad = decide(
        mk({
          ...email,
          purpose: 'marketing',
          consent: [],
          sender: { kind: 'email', registration: 'ready', domainVerified: false },
          tenant: { suspended: false, brokerageNamePresent: false, postalAddressPresent: false },
          rendered: { containsBrokerageName: false, containsOptOutHint: false, paymentInstructions: false },
        }),
      );
      expect(bad.reasons).toEqual(['EMAIL_DOMAIN_UNVERIFIED', 'BROKERAGE_IDENTITY_MISSING', 'POSTAL_ADDRESS_MISSING', 'UNSUBSCRIBE_MISSING']);
    }
  });
});

describe('check boundaries', () => {
  it("R-CONSENT-1 a grant on another of the contact's addresses is never this address's basis", () => {
    expectDecision(decide(assistantInput({ consent: [written({ addressHmac: H2 })] })), 'deny', 'CONSENT_BASIS_INSUFFICIENT');
    expect(decide(gateInput({ consent: [express({ addressHmac: H2 })] })).outcome).toBe('needs_confirmation');
    expect(decide(gateInput({ consent: [express({ channel: 'voice' })] })).outcome).toBe('needs_confirmation');
  });
  it('only SMS revokes on other phones block an SMS; a voice revoke there does not', () => {
    expect(decide(gateInput({ consent: [express(), revoked({ addressHmac: H2, channel: 'voice' })] })).outcome).toBe('allow');
  });
  it('postal address and unsubscribe are email-only marketing requirements; missing content on marketing email is denied, not a crash', () => {
    const noPostal = { tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: false } };
    expect(decide(gateInput({ ...noPostal, purpose: 'marketing', consent: [mkt()], dnc: [dncClear()] })).outcome).toBe('allow');
    expect(decide(gateInput({ ...noPostal, ...email })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, purpose: 'marketing', rendered: undefined })).reasons).toEqual(['RENDERED_CONTENT_MISSING']);
  });
  it('the 30-day inbound window is inclusive, and a future-dated inbound does not count', () => {
    expect(decide(gateInput({ consent: [], lastInboundAt: T(-days(30)) })).outcome).toBe('allow');
    expect(decide(gateInput({ consent: [], lastInboundAt: T(-days(30) - 1) })).outcome).toBe('needs_confirmation');
    expect(decide(gateInput({ consent: [], lastInboundAt: NOW })).outcome).toBe('allow');
    expect(decide(gateInput({ consent: [], lastInboundAt: T(1) })).outcome).toBe('needs_confirmation');
  });
  it('a reply sent at the very instant of the inbound counts as a reply', () => {
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: NIGHT })), 'needs_confirmation', 'OUTSIDE_WINDOW_REPLY');
  });
  it('a DNC scrub checked at this very instant is valid', () => {
    expect(decide(gateInput({ purpose: 'marketing', consent: [], dnc: [dncClear({ checkedAt: NOW })] })).reasons).toEqual(['CONSENT_CONFIRMATION_REQUIRED']);
  });
  it('call-attempt and manual-SMS limits apply to humans only', () => {
    expect(decide(gateInput({ ...voice, initiator: 'system', category: 'reminder', callAttempts24h: 9 })).reasons).toEqual(['AUTOMATED_VOICE_UNAVAILABLE']);
    expect(decide(assistantInput({ consent: [written()], recentManualSms24h: 9 })).outcome).toBe('allow');
    expect(decide(gateInput({ ...toAgent, recentManualSms24h: 9 })).outcome).toBe('allow');
  });
  it('RULES_VERSION is a stable versioned string (stored in gate_decisions.core_rules_version)', () => {
    expect(RULES_VERSION).toMatch(/^core-compliance\/\d+\.\d+\.\d+$/);
  });
});

describe('R-GATE-12 brokerage identity on marketing', () => {
  it('R-GATE-12 marketing on every channel needs the brokerage name; informational does not', () => {
    const noName = { tenant: { suspended: false, brokerageNamePresent: false, postalAddressPresent: true } };
    expectDecision(decide(gateInput({ ...noName, purpose: 'marketing', consent: [mkt()], dnc: [dncClear()] })), 'deny', 'BROKERAGE_IDENTITY_MISSING');
    expectDecision(decide(gateInput({ ...voice, ...noName, purpose: 'marketing', dnc: [dncClear()] })), 'deny', 'BROKERAGE_IDENTITY_MISSING');
    expect(decide(gateInput({ ...noName })).outcome).toBe('allow');
    expect(decide(gateInput({ rendered: { containsBrokerageName: false, containsOptOutHint: false, paymentInstructions: false } })).outcome).toBe('allow');
    expect(canConfirm(decide(gateInput({ ...noName, purpose: 'marketing', consent: [], dnc: [dncClear()] })))).toBe(false);
  });
});

// ---- R-CONSENT-15 DNC ------------------------------------------------------------------------------
describe('R-CONSENT-15 DNC for marketing SMS and voice', () => {
  const human = (o: Partial<GateInput>) => decide(gateInput({ purpose: 'marketing', consent: [mkt({ level: 'express' })], ...o }));
  it('R-CONSENT-15 a valid listed check without express_written ⇒ DNC_LISTED; with express_written ⇒ allowed', () => {
    expectDecision(human({ dnc: [dncListed()] }), 'deny', 'DNC_LISTED');
    expectDecision(human({ dnc: [dncClear(), dncListed({ registry: 'us_state:CO' })] }), 'deny', 'DNC_LISTED');
    expect(human({ consent: [mkt({ level: 'express_written' })], dnc: [dncListed()] }).outcome).toBe('allow');
    expect(decide(assistantInput({ purpose: 'marketing', category: 'search_alert', consent: [mkt({ level: 'express_written' })], dnc: [dncListed()] })).outcome).toBe('allow');
  });
  it('R-CONSENT-15 unknown or expired status with no unexpired inquiry/express basis ⇒ deny for every initiator', () => {
    const none = { consent: [] as ConsentStateRow[] };
    expectDecision(human({ ...none, dnc: [] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ ...none, dnc: [dncClear({ validUntil: T(-1) })] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ ...none, dnc: [dncClear({ registry: 'us_state:TX' })] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ consent: [mkt({ level: 'inquiry', expiresAt: T(-1) })], dnc: [] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ consent: [mkt({ level: 'imported_unverified' })], dnc: [] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(decide(assistantInput({ purpose: 'marketing', category: 'search_alert', consent: [] })), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
  });
  it('R-CONSENT-15 a scrub is valid for the pack window (31 d) even if valid_until says longer; future scrubs do not count', () => {
    const none = { consent: [] as ConsentStateRow[] };
    expect(human({ ...none, dnc: [dncClear({ checkedAt: T(-days(30)), validUntil: T(days(60)) })] }).reasons).not.toContain('DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ ...none, dnc: [dncClear({ checkedAt: T(-days(31)), validUntil: T(days(60)) })] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    expectDecision(human({ ...none, dnc: [dncClear({ checkedAt: T(1) })] }), 'deny', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    // an expired listing no longer counts as listed
    expect(human({ dnc: [dncListed({ validUntil: T(-1) }), dncClear()] }).outcome).toBe('allow');
  });
  it('R-CONSENT-15 an unexpired inquiry/express basis on either purpose is a relationship', () => {
    expect(human({ consent: [mkt({ level: 'inquiry', expiresAt: T(days(1)) })], dnc: [] }).outcome).toBe('allow');
    expect(human({ consent: [grantRow({ level: 'inquiry', expiresAt: T(days(1)) })], dnc: [] }).reasons).toEqual(['CONSENT_CONFIRMATION_REQUIRED']);
    expect(human({ ...voice, consent: [grantRow({ channel: 'voice', level: 'express' })], dnc: [] }).outcome).toBe('allow');
  });
  it('R-CONSENT-15 informational and email are not DNC-checked', () => {
    expect(decide(gateInput({ dnc: [dncListed()] })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, purpose: 'marketing', consent: [], dnc: [dncListed()] })).outcome).toBe('allow');
  });
});

// ---- R-CONSENT-13 windows -------------------------------------------------------------------------
describe('R-CONSENT-13 quiet hours', () => {
  const inWindow = (d: GateDecision) => d.outcome === 'allow';
  it('R-CONSENT-13 the window is [09:00, 20:00) recipient-local for SMS and voice', () => {
    expect(inWindow(decide(gateInput({ now: at('2026-11-10T14:00:00Z') })))).toBe(true); // 09:00
    expect(inWindow(decide(gateInput({ now: at('2026-11-10T13:59:59Z') })))).toBe(false); // 08:59:59
    expect(inWindow(decide(gateInput({ now: at('2026-11-11T00:59:59Z') })))).toBe(true); // 19:59:59
    expect(inWindow(decide(gateInput({ now: at('2026-11-11T01:00:00Z') })))).toBe(false); // 20:00
    expect(inWindow(decide(gateInput({ ...voice, now: NIGHT })))).toBe(false);
  });
  it('R-CONSENT-13 the intersection over candidate zones applies (area-code zone + tenant zone)', () => {
    // 10:00 ET = 07:00 PT: outside for the Pacific candidate
    const zones = { zones: [NY, LA], source: 'area_code' as const };
    expectDecision(decide(gateInput({ zones })), 'deny', 'OUTSIDE_CONTACT_WINDOW', 'RECIPIENT_TZ_UNCERTAIN');
    const d = decide(assistantInput({ zones, consent: [written()] }));
    expect(d.outcome).toBe('defer');
    const open = at('2026-11-10T17:00:00Z'); // 12:00 ET = 09:00 PT
    expect(d.deferUntil).toBeGreaterThanOrEqual(open);
    expect(d.deferUntil).toBeLessThanOrEqual(open + MAX_JITTER_SECONDS * 1000);
  });
  it('R-CONSENT-13 human outside the window: deny, except an informational reply within 30 min ⇒ needs_confirmation', () => {
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: instant(NIGHT - minutes(30)) })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: instant(NIGHT - minutes(30) + 1) })), 'needs_confirmation', 'OUTSIDE_WINDOW_REPLY');
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: instant(NIGHT + 1) })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(gateInput({ now: NIGHT, purpose: 'marketing', consent: [mkt()], dnc: [dncClear()], lastInboundAt: instant(NIGHT - minutes(1)) })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(gateInput({ now: NIGHT, lastInboundAt: instant(NIGHT - minutes(5)), policy: policy({ humanReplyWindowMinutes: 0 }) })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(gateInput({ ...voice, now: NIGHT, lastInboundAt: instant(NIGHT - minutes(5)) })), 'needs_confirmation', 'OUTSIDE_WINDOW_REPLY');
  });
  it('R-CONSENT-13 E36 an agent approving a draft at 11 PM: deny, or confirmation for a reply within 30 min', () => {
    const elevenPm = at('2026-11-11T04:00:00Z');
    expectDecision(decide(gateInput({ now: elevenPm })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    const c = decide(gateInput({ now: elevenPm, lastInboundAt: instant(elevenPm - minutes(12)) }));
    expect(c.outcome).toBe('needs_confirmation');
    expect(canConfirm(c)).toBe(true);
    expect(c.explanation).toBe('Outside 9 AM–8 PM their time; OK only as a reply to their message');
  });
  it('R-CONSENT-13 automated sends outside the window defer to the next opening + deterministic 0–20 min jitter', () => {
    const d = decide(assistantInput({ now: NIGHT, consent: [written()] }));
    expect(d.outcome).toBe('defer');
    expect(d.reasons).toEqual(['QUIET_HOURS_DEFERRED']);
    expect(d.deferUntil).toBeGreaterThanOrEqual(NEXT_OPEN);
    expect(d.deferUntil).toBeLessThanOrEqual(NEXT_OPEN + MAX_JITTER_SECONDS * 1000);
    expect(d.explanation).toMatch(/^Sends Wed 9:\d\d AM their time$/);
    expect(decide(assistantInput({ now: NIGHT, consent: [written()] })).deferUntil).toBe(d.deferUntil);
  });
  it('R-CONSENT-13 without a jitter key the address and category seed the jitter', () => {
    const { jitterKey: _k, ...rest } = assistantInput({ now: NIGHT, consent: [written()] });
    const d = decide(rest);
    expect(d.deferUntil).toBeGreaterThanOrEqual(NEXT_OPEN);
    expect(d.deferUntil).toBeLessThanOrEqual(NEXT_OPEN + MAX_JITTER_SECONDS * 1000);
  });
  it('R-CONSENT-13 jitter never pushes a send out of a short window (falls back to the opening)', () => {
    const p = { ...policy(), window: { start: localTime('09:00'), end: localTime('09:00:30') } };
    const results = new Set<number>();
    for (let i = 0; i < 30; i++) results.add(decide(assistantInput({ now: NIGHT, consent: [written()], policy: p, jitterKey: `k${i}` })).deferUntil as number);
    expect([...results]).toEqual(expect.arrayContaining([NEXT_OPEN]));
    for (const r of results) expect(r).toBeLessThan(NEXT_OPEN + 30_000);
  });
  it('R-CONSENT-13 E30 a 9:00 AM burst of deferred sends is spread deterministically over 0–20 minutes', () => {
    const untils = Array.from({ length: 200 }, (_, i) => decide(assistantInput({ now: NIGHT, consent: [written()], jitterKey: `m-${i}` })).deferUntil as number);
    for (const u of untils) {
      expect(u).toBeGreaterThanOrEqual(NEXT_OPEN);
      expect(u).toBeLessThanOrEqual(NEXT_OPEN + MAX_JITTER_SECONDS * 1000);
    }
    expect(new Set(untils).size).toBeGreaterThan(150);
    const minuteBuckets = new Set(untils.map((u) => Math.floor((u - NEXT_OPEN) / 60_000)));
    expect(minuteBuckets.size).toBeGreaterThanOrEqual(18);
    const again = Array.from({ length: 200 }, (_, i) => decide(assistantInput({ now: NIGHT, consent: [written()], jitterKey: `m-${i}` })).deferUntil as number);
    expect(again).toEqual(untils);
  });
  it('R-CONSENT-13 E29 a 7:55 PM send pushed past 8 PM by a backlog defers to the next morning at send time', () => {
    const scheduledFor = at('2026-11-11T00:55:00Z'); // 7:55 PM ET: would have been allowed
    expect(decide(assistantInput({ now: scheduledFor, consent: [written()] })).outcome).toBe('allow');
    const d = decide(assistantInput({ now: at('2026-11-11T01:01:00Z'), consent: [written()] }));
    expect(d.outcome).toBe('defer');
    expect(d.deferUntil).toBeGreaterThanOrEqual(NEXT_OPEN);
  });
  it('R-CONSENT-13 email has no quiet hours by default; a tenant may turn them on', () => {
    expect(decide(gateInput({ ...email, now: NIGHT })).outcome).toBe('allow');
    expect(decide(assistantInput({ ...email, category: 'speed_to_lead_reply', now: NIGHT })).outcome).toBe('allow');
    const q = policy({ emailQuietHours: true });
    expectDecision(decide(gateInput({ ...email, now: NIGHT, policy: q })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(assistantInput({ ...email, category: 'speed_to_lead_reply', now: NIGHT, policy: q })), 'defer', 'QUIET_HOURS_DEFERRED');
  });
  it('R-CONSENT-13 the Owner-attested 08:00–21:00 window applies as resolved', () => {
    const wide = policy({ contactWindowStart: '08:00', contactWindowEnd: '21:00', looseningAttestation: 'attested' });
    const eightThirty = at('2026-11-10T13:30:00Z');
    expect(decide(gateInput({ now: eightThirty, policy: wide })).outcome).toBe('allow');
    expect(decide(gateInput({ now: eightThirty })).outcome).toBe('deny');
  });
  it('R-CONSENT-13 no contactable instant: zones that never overlap, an empty window or no zones ⇒ deny, never "now"', () => {
    // 11–13 hours apart all year: 11-hour windows never overlap
    const apart = { zones: [zone('Pacific/Auckland'), zone('Europe/London')], source: 'explicit' as const };
    expectDecision(decide(assistantInput({ zones: apart, consent: [written()] })), 'deny', 'NO_CONTACTABLE_WINDOW');
    expectDecision(decide(gateInput({ zones: apart })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    const empty = { ...policy(), window: { start: localTime('12:00'), end: localTime('11:00') } };
    expectDecision(decide(assistantInput({ policy: empty, consent: [written()] })), 'deny', 'NO_CONTACTABLE_WINDOW');
    expectDecision(decide(gateInput({ policy: empty })), 'deny', 'OUTSIDE_CONTACT_WINDOW');
    expectDecision(decide(assistantInput({ zones: { zones: [], source: 'explicit' }, consent: [written()] })), 'deny', 'NO_CONTACTABLE_WINDOW');
  });
  it('R-CONSENT-13 weak timezone evidence is flagged only where a window applies', () => {
    expect(decide(gateInput({ zones: { zones: [NY], source: 'tenant_default' } })).reasons).toEqual(['RECIPIENT_TZ_UNCERTAIN']);
    expect(decide(gateInput({ zones: { zones: [NY], source: 'address' } })).reasons).toEqual([]);
    expect(decide(gateInput({ ...email, zones: { zones: [NY], source: 'tenant_default' } })).reasons).toEqual([]);
    expect(decide(gateInput({ zones: { zones: [NY], source: 'area_code' } })).explanation).toBe('OK to send · Their time zone is a best guess');
  });
});

// E9: DST vectors for six zones, 2026 and 2027 (quiet-hours side; the offer-window side is core/ownership).
describe('R-CONSENT-13 E9 DST boundaries in six zones, 2026–2027', () => {
  const ZONES: [string, number, number | null][] = [
    ['America/New_York', -5, -4],
    ['America/Chicago', -6, -5],
    ['America/Denver', -7, -6],
    ['America/Phoenix', -7, null],
    ['America/Los_Angeles', -8, -7],
    ['Pacific/Honolulu', -10, null],
  ];
  const DAYS: [string, [number, number, number], 'spring' | 'fall'][] = [
    ['2026 spring forward', [2026, 2, 8], 'spring'],
    ['2026 fall back', [2026, 10, 1], 'fall'],
    ['2027 spring forward', [2027, 2, 14], 'spring'],
    ['2027 fall back', [2027, 10, 7], 'fall'],
  ];
  const utc = (y: number, m: number, d: number, h: number, mi = 0) => instant(Date.UTC(y, m, d, h, mi));
  for (const [name, std, dst] of ZONES) {
    for (const [label, [y, m, d], kind] of DAYS) {
      // offset in force at 09:00 and 20:00 local on the transition day
      const off = dst === null ? std : kind === 'spring' ? dst : std;
      it(`R-CONSENT-13 E9 ${name} ${label}: 01:00 local defers to 09:00 local; 19:59 allowed, 20:00 not`, () => {
        const z = zone(name) as IanaZone;
        const zones = { zones: [z], source: 'explicit' as const };
        const startOff = dst === null ? std : kind === 'spring' ? std : dst; // offset at 01:00 local
        const oneAm = utc(y, m, d, 1 - startOff);
        const open = utc(y, m, d, 9 - off);
        const deferred = decide(assistantInput({ now: oneAm, zones, consent: [written()], jitterKey: 'dst' }));
        expect(deferred.outcome).toBe('defer');
        expect(deferred.deferUntil).toBeGreaterThanOrEqual(open);
        expect(deferred.deferUntil).toBeLessThanOrEqual(open + MAX_JITTER_SECONDS * 1000);
        expect(decide(gateInput({ now: open, zones })).outcome).toBe('allow');
        expect(decide(gateInput({ now: instant(open - 1000), zones })).outcome).toBe('deny');
        expect(decide(gateInput({ now: utc(y, m, d, 19 - off, 59), zones })).outcome).toBe('allow');
        expect(decide(gateInput({ now: utc(y, m, d, 20 - off), zones })).outcome).toBe('deny');
      });
    }
  }
  it('R-CONSENT-13 E9 a window boundary in a skipped hour moves to the transition; in a repeated hour it takes the later instant', () => {
    const zones = { zones: [NY], source: 'explicit' as const };
    // spring forward 2026-03-08: 02:30 does not exist ⇒ the window opens at 03:00 EDT = 07:00Z
    const gap = { ...policy(), window: { start: localTime('02:30'), end: localTime('20:00') } };
    expect(decide(gateInput({ now: at('2026-03-08T07:00:00Z'), zones, policy: gap })).outcome).toBe('allow');
    expect(decide(gateInput({ now: at('2026-03-08T06:59:59Z'), zones, policy: gap })).outcome).toBe('deny');
    // fall back 2026-11-01: 01:30 happens twice ⇒ the window opens at the later one, 01:30 EST = 06:30Z
    const overlap = { ...policy(), window: { start: localTime('01:30'), end: localTime('20:00') } };
    expect(decide(gateInput({ now: at('2026-11-01T05:45:00Z'), zones, policy: overlap })).outcome).toBe('deny');
    expect(decide(gateInput({ now: at('2026-11-01T06:30:00Z'), zones, policy: overlap })).outcome).toBe('allow');
    const d = decide(assistantInput({ now: at('2026-11-01T05:45:00Z'), zones, policy: overlap, consent: [written()] }));
    expect(d.deferUntil).toBeGreaterThanOrEqual(at('2026-11-01T06:30:00Z'));
  });
});

// ---- R-CONSENT-14 caps ----------------------------------------------------------------------------
describe('R-CONSENT-14 frequency caps', () => {
  const auto = (o: Partial<GateInput>) => decide(assistantInput({ consent: [written()], ...o }));
  const sms = (atMs: number, o: Partial<GateInput['recentAutomated'][number]> = {}) => ({ channel: 'sms' as const, at: T(atMs), exempt: false, ...o });
  it('R-CONSENT-14 automated SMS 1/24 h per address defers until the oldest send leaves the window', () => {
    const d = auto({ recentAutomated: [sms(-hours(1))] });
    expectDecision(d, 'defer', 'FREQUENCY_CAP');
    expect(d.deferUntil).toBe(T(hours(23))); // 09:00 ET tomorrow: inside the window, no jitter
    expect(d.explanation).toBe('Message limit reached; sends Wed 9:00 AM their time');
    expect(auto({ recentAutomated: [sms(-hours(24))] }).outcome).toBe('allow');
  });
  it('R-CONSENT-14 a cap release outside the window moves to the next opening (+ jitter)', () => {
    const d = auto({ recentAutomated: [sms(-hours(2))] }); // release 08:00 ET tomorrow
    expect(d.outcome).toBe('defer');
    expect(d.reasons).toEqual(['FREQUENCY_CAP']);
    expect(d.deferUntil).toBeGreaterThanOrEqual(NEXT_OPEN);
    expect(d.deferUntil).toBeLessThanOrEqual(NEXT_OPEN + MAX_JITTER_SECONDS * 1000);
  });
  it('R-CONSENT-14 automated SMS 3/7 d per address', () => {
    const d = auto({ recentAutomated: [sms(-days(6)), sms(-days(4)), sms(-days(2))] });
    expectDecision(d, 'defer', 'FREQUENCY_CAP');
    expect(d.deferUntil).toBe(T(days(1)));
    expect(auto({ recentAutomated: [sms(-days(8)), sms(-days(4)), sms(-days(2))] }).outcome).toBe('allow');
    expect(auto({ recentAutomated: [sms(-days(7)), sms(-days(4)), sms(-days(2))] }).outcome).toBe('allow');
  });
  it('R-CONSENT-14 automated email 1/24 h and 3/7 d per address (no quiet hours: exact release)', () => {
    const e = (atMs: number) => ({ channel: 'email' as const, at: T(atMs), exempt: false });
    const d = auto({ ...email, recentAutomated: [e(-hours(5))] });
    expectDecision(d, 'defer', 'FREQUENCY_CAP');
    expect(d.deferUntil).toBe(T(hours(19)));
    expect(auto({ ...email, recentAutomated: [e(-days(5)), e(-days(3)), e(-days(2))] }).deferUntil).toBe(T(days(2)));
    expect(auto({ ...email, recentAutomated: [sms(-hours(1), { sameAddress: false })] }).outcome).toBe('allow');
    // no candidate zone (email has no window): the time is shown in UTC rather than guessed
    expect(auto({ ...email, zones: { zones: [], source: 'tenant_default' }, recentAutomated: [e(-hours(5))] }).explanation).toBe('Message limit reached; sends Wed 10:00 AM UTC');
  });
  it('R-CONSENT-14 automated cross-channel 2/24 h per contact counts sends to other addresses', () => {
    const d = auto({ recentAutomated: [sms(-hours(1), { sameAddress: false }), { channel: 'email', at: T(-minutes(30)), exempt: false }] });
    expectDecision(d, 'defer', 'FREQUENCY_CAP');
    expect(d.deferUntil).toBe(T(hours(23)));
    expect(auto({ recentAutomated: [sms(-hours(3), { sameAddress: false })] }).outcome).toBe('allow');
    // sameAddress omitted counts as the same address (stricter)
    expect(auto({ recentAutomated: [sms(-hours(3))] }).outcome).toBe('defer');
  });
  it('R-CONSENT-14 exempt sends never count; cap-exempt categories are not capped (consent and quiet hours still apply)', () => {
    expect(auto({ recentAutomated: [sms(-hours(1), { exempt: true }), sms(-hours(2), { exempt: true })] }).outcome).toBe('allow');
    for (const category of ['booking_confirmation', 'reminder'] as const) {
      expect(auto({ category, recentAutomated: [sms(-hours(1)), sms(-hours(2)), sms(-hours(3))] }).outcome).toBe('allow');
      expectDecision(auto({ category, now: NIGHT }), 'defer', 'QUIET_HOURS_DEFERRED');
      expectDecision(auto({ category, consent: [revoked()] }), 'deny', 'CONSENT_REVOKED');
    }
  });
  it('R-CONSENT-14 a tenant cap of 0 turns that automated channel off (deny, not an endless defer)', () => {
    expectDecision(auto({ policy: policy({ autoSmsPer24h: 0 }) }), 'deny', 'POLICY_CAP_ZERO');
    expectDecision(auto({ policy: policy({ autoSmsPer7d: 0 }) }), 'deny', 'POLICY_CAP_ZERO');
    expectDecision(auto({ ...email, category: 'speed_to_lead_reply', policy: policy({ autoEmailPer24h: 0 }) }), 'deny', 'POLICY_CAP_ZERO');
    expectDecision(auto({ ...email, category: 'speed_to_lead_reply', policy: policy({ autoEmailPer7d: 0 }) }), 'deny', 'POLICY_CAP_ZERO');
    expectDecision(auto({ policy: policy({ autoCrossChannelPer24h: 0 }) }), 'deny', 'POLICY_CAP_ZERO');
    expect(auto({ ...email, category: 'speed_to_lead_reply', policy: policy({ autoSmsPer24h: 0 }) }).outcome).toBe('allow');
  });
  it('R-CONSENT-14 manual SMS above 3/24 h needs confirmation; more than 3 call attempts/24 h is denied', () => {
    expect(decide(gateInput({ recentManualSms24h: 2 })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ recentManualSms24h: 3 })), 'needs_confirmation', 'MANUAL_SMS_VOLUME');
    expect(decide(gateInput({ recentManualSms24h: 3 })).explanation).toBe('Already texted 3 times in 24 hours; confirm to send another');
    expect(decide(gateInput({ ...voice, callAttempts24h: 2 })).outcome).toBe('allow');
    const c = decide(gateInput({ ...voice, callAttempts24h: 3 }));
    expectDecision(c, 'deny', 'CALL_ATTEMPT_LIMIT');
    expect(canConfirm(c)).toBe(false);
    expect(decide(gateInput({ ...voice, recentManualSms24h: 9 })).outcome).toBe('allow');
    expect(decide(gateInput({ callAttempts24h: 9 })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, recentManualSms24h: 9 })).outcome).toBe('allow');
  });
  it('R-CONSENT-14 after the policy number of deferrals the step is skipped_ineligible', () => {
    const p = policy();
    expect([0, 1, 2, 3, 4].map((n) => afterDeferral(n, p))).toEqual(['defer', 'defer', 'defer', 'skipped_ineligible', 'skipped_ineligible']);
    expect(afterDeferral(1, policy({ maxDeferrals: 1 }))).toBe('skipped_ineligible');
  });
  it('R-CONSENT-14 property: caps defer and never deny', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ ch: fc.constantFrom('sms', 'email') as fc.Arbitrary<'sms' | 'email'>, ago: fc.integer({ min: 0, max: 8 * 24 * 60 }), exempt: fc.boolean(), same: fc.option(fc.boolean(), { nil: undefined }) }), { maxLength: 8 }),
        fc.constantFrom('sms', 'email') as fc.Arbitrary<'sms' | 'email'>,
        fc.integer({ min: 0, max: 7 * 24 * 60 }),
        (sends, ch, nowShift) => {
          const now = instant(NOW + nowShift * 60_000);
          const recentAutomated = sends.map((s) => ({ channel: s.ch, at: instant(now - s.ago * 60_000), exempt: s.exempt, ...(s.same === undefined ? {} : { sameAddress: s.same }) }));
          const base = ch === 'email' ? { ...email, category: 'speed_to_lead_reply' as const } : {};
          const d = canContact(assistantInput({ ...base, now, consent: [written()], recentAutomated }));
          expect(d.outcome).not.toBe('deny');
          if (d.outcome === 'defer') expect(d.deferUntil).toBeGreaterThan(now);
          // after the deferral the caps no longer bind
          if (d.outcome === 'defer') expect(canContact(assistantInput({ ...base, now: d.deferUntil as Instant, consent: [written()], recentAutomated })).outcome).toBe('allow');
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---- exempt categories, users, pause ---------------------------------------------------------------
describe('consent-exempt replies, agent alerts', () => {
  const sys = (category: 'opt_out_confirmation' | 'help_reply', o: Partial<GateInput> = {}) => decide(gateInput({ initiator: 'system', category, consent: [revoked()], automationPausedAt: T(-1), ...o }));
  it('R-CONSENT-7 the opt-out confirmation and HELP reply go to an opted-out, paused number', () => {
    expect(sys('opt_out_confirmation').outcome).toBe('allow');
    expect(sys('help_reply').outcome).toBe('allow');
    expect(sys('help_reply', { recentAutomated: [{ channel: 'sms', at: T(-1), exempt: false }] }).outcome).toBe('allow');
  });
  it('consent-exempt replies are still sender-registration, suppression and content checked, and respect quiet hours', () => {
    expectDecision(sys('opt_out_confirmation', { sender: { kind: 'phone', registration: 'blocked' } }), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(sys('help_reply', { suppressions: [{ channel: 'sms', reason: 'landline_no_sms', liftedAt: null }] }), 'deny', 'SUPPRESSED');
    expectDecision(sys('opt_out_confirmation', { now: NIGHT }), 'defer', 'QUIET_HOURS_DEFERRED');
  });
  it('R-CONSENT-1 E60 an agent who texted STOP to alert SMS gets no alert SMS (user recipient consent)', () => {
    expectDecision(decide(gateInput({ ...toAgent, consent: [revoked({ addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expect(decide(gateInput({ ...toAgent })).outcome).toBe('allow');
  });
  it('agent alerts: no consent basis, quiet hours, DNC or caps; still tenant, sender, suppression and content checks', () => {
    expect(decide(gateInput({ ...toAgent, now: NIGHT, recentAutomated: [{ channel: 'sms', at: T(-1), exempt: false }] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...toAgent, sender: { kind: 'phone', registration: 'pending' } })), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(decide(gateInput({ ...toAgent, suppressions: [{ channel: 'sms', reason: 'admin_block', liftedAt: null }] })), 'deny', 'SUPPRESSED');
    expectDecision(decide(gateInput({ ...toAgent, contactPoint: { status: 'invalid', lineType: 'mobile' } })), 'deny', 'CONTACT_POINT_INVALID');
    expectDecision(decide(gateInput({ ...toAgent, tenant: { suspended: true, brokerageNamePresent: true, postalAddressPresent: true } })), 'deny', 'TENANT_SUSPENDED');
  });
});

// ---- edge cases -----------------------------------------------------------------------------------
describe('edge cases', () => {
  it('R-CONSENT-1 E21 spouses share one phone; one texts STOP: the address-keyed revoke blocks SMS to both contacts', () => {
    const shared = [revoked({ purpose: 'informational' }), revoked({ purpose: 'marketing' })];
    // contact A and contact B evaluate the same address HMAC
    for (const contact of ['A', 'B']) {
      const d = decide(gateInput({ consent: shared, jitterKey: contact }));
      expectDecision(d, 'deny', 'CONSENT_REVOKED');
      expect(d.explanation).toBe('Opted out of texts');
    }
  });
  it('R-CONSENT-1 E23 STOP to number A, then an agent texts from number B: tenant-wide address revoke ⇒ deny', () => {
    const d = decide(gateInput({ consent: [revoked()], sender: { kind: 'phone', registration: 'ready' } }));
    expectDecision(d, 'deny', 'CONSENT_REVOKED');
    expect(canConfirm(d)).toBe(false);
  });
  it('R-CONSENT-5 E37 a lead form without SMS consent language: no assistant SMS; email first response; the agent texts per the human rules', () => {
    const inquiry = [grantRow({ level: 'inquiry', expiresAt: T(days(90)) }), mkt({ level: 'inquiry', expiresAt: T(days(90)) })];
    expectDecision(decide(assistantInput({ category: 'speed_to_lead_reply', consent: inquiry })), 'deny', 'CONSENT_BASIS_INSUFFICIENT');
    expect(decide(assistantInput({ ...email, category: 'speed_to_lead_reply', consent: [] })).outcome).toBe('allow');
    expect(decide(gateInput({ consent: inquiry })).outcome).toBe('allow');
    expect(decide(gateInput({ purpose: 'marketing', consent: inquiry })).outcome).toBe('allow');
  });
  // E8 (core part): a lead at 02:00 gets the assistant's email now and its SMS at 09:00 local; the
  // SLA clock starts at nextContactableAt. Offer delivery at 02:00 is core/ownership + api/leads.
  it('lead at 02:00: assistant email now, SMS deferred to 09:00 recipient-local; nextContactableAt for the SLA', () => {
    const twoAm = at('2026-11-10T07:00:00Z');
    expect(decide(assistantInput({ ...email, category: 'speed_to_lead_reply', now: twoAm })).outcome).toBe('allow');
    const s = decide(assistantInput({ category: 'speed_to_lead_reply', now: twoAm, consent: [written()] }));
    expect(s.outcome).toBe('defer');
    const nine = at('2026-11-10T14:00:00Z');
    expect(s.deferUntil).toBeGreaterThanOrEqual(nine);
    expect(nextContactableAt(twoAm, [NY], policy(), 'sms')).toBe(nine);
    expect(nextContactableAt(twoAm, [NY], policy(), 'email')).toBe(twoAm);
    expect(nextContactableAt(twoAm, [NY], policy({ emailQuietHours: true }), 'email')).toBe(nine);
    expect(nextContactableAt(twoAm, [NY, CHI], policy(), 'voice')).toBe(at('2026-11-10T15:00:00Z'));
    expect(nextContactableAt(twoAm, [], policy(), 'sms')).toBeNull();
    expect(nextContactableAt(twoAm, [NY], { ...policy(), window: { start: localTime('10:00'), end: localTime('10:00') } }, 'sms')).toBeNull();
  });
});

// ---- R-GATE-5, R-GATE-6, R-GATE-11 ----------------------------------------------------------------
const rank = { allow: 0, defer: 1, needs_confirmation: 2, deny: 3 } as const;
const inputArb: fc.Arbitrary<GateInput> = fc
  .record({
    initiator: fc.constantFrom('human', 'assistant', 'system') as fc.Arbitrary<GateInput['initiator']>,
    channel: fc.constantFrom('sms', 'voice', 'email') as fc.Arbitrary<'sms' | 'voice' | 'email'>,
    purpose: fc.constantFrom('marketing', 'informational') as fc.Arbitrary<'marketing' | 'informational'>,
    category: fc.constantFrom('none', 'nurture_step', 'search_alert', 'reminder', 'money', 'opt_out_confirmation', 'help_reply') as fc.Arbitrary<GateInput['category']>,
    level: fc.constantFrom('none', 'imported_unverified', 'inquiry', 'express', 'express_written') as fc.Arbitrary<ConsentStateRow['level']>,
    hour: fc.integer({ min: 0, max: 47 }),
    inboundAgoMin: fc.option(fc.integer({ min: 0, max: 60 * 24 * 40 }), { nil: null }),
    dnc: fc.constantFrom('none', 'clear', 'expired') as fc.Arbitrary<'none' | 'clear' | 'expired'>,
    manual: fc.integer({ min: 0, max: 5 }),
    calls: fc.integer({ min: 0, max: 5 }),
    recent: fc.array(fc.integer({ min: 0, max: 60 * 24 * 8 }), { maxLength: 4 }),
    paused: fc.boolean(),
    zones: fc.constantFrom([NY], [NY, LA], [CHI]),
  })
  .map((r) => {
    const now = instant(at('2026-11-10T05:00:00Z') + r.hour * 30 * 60_000);
    const consent =
      r.level === 'none' ? [] : [grantRow({ channel: r.channel, purpose: r.purpose, level: r.level, expiresAt: r.level === 'inquiry' ? instant(now + days(10)) : null })];
    const dnc: DncCheckRow[] = r.dnc === 'clear' ? [dncClear({ checkedAt: instant(now - days(1)), validUntil: instant(now + days(10)) })] : r.dnc === 'expired' ? [dncClear({ checkedAt: instant(now - days(40)), validUntil: instant(now - days(9)) })] : [];
    return gateInput({
      now,
      initiator: r.initiator,
      purpose: r.purpose,
      category: r.category,
      recipient: { kind: 'contact', addressHmac: H1, channel: r.channel },
      sender: r.channel === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : { kind: 'phone', registration: 'ready' },
      ...(r.channel === 'voice' ? { rendered: undefined } : {}),
      consent,
      dnc,
      lastInboundAt: r.inboundAgoMin === null ? null : instant(now - r.inboundAgoMin * 60_000),
      recentManualSms24h: r.manual,
      callAttempts24h: r.calls,
      recentAutomated: r.recent.map((m) => ({ channel: r.channel, at: instant(now - m * 60_000), exempt: false })),
      automationPausedAt: r.paused ? instant(now - 1) : null,
      zones: { zones: [...r.zones], source: 'explicit' },
      jitterKey: `j${r.hour}`,
    });
  });

describe('R-GATE-5 determinism and monotonic denial', () => {
  it('R-GATE-5 the same input yields the same decision and inputsDigest; key and set order do not matter', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const a = canContact(input);
        const b = canContact({ ...input, consent: input.consent.map((r) => ({ ...r })), policy: { ...input.policy, autonomous: new Set([...input.policy.autonomous].reverse()) } });
        expect(b).toEqual(a);
        const reordered = Object.fromEntries(Object.entries(input).reverse()) as unknown as GateInput;
        expect(canContact(reordered).inputsDigest).toBe(a.inputsDigest);
      }),
      { numRuns: 300 },
    );
  });
  it('R-GATE-5 different inputs give different digests', () => {
    const a = canContact(gateInput());
    expect(canContact(gateInput({ recentManualSms24h: 1 })).inputsDigest).not.toBe(a.inputsDigest);
    expect(canContact(gateInput({ now: T(1) })).inputsDigest).not.toBe(a.inputsDigest);
  });
  it('R-GATE-5 adding a revoke, a suppression or a DNC listing never relaxes the outcome', () => {
    const addRevoke = (i: GateInput): GateInput => ({
      ...i,
      consent: [...i.consent.filter((r) => !(r.channel === i.recipient.channel && r.purpose === i.purpose && r.addressHmac === i.recipient.addressHmac)), revoked({ channel: i.recipient.channel, purpose: i.purpose })],
    });
    const addOtherRevoke = (i: GateInput): GateInput => ({ ...i, consent: [...i.consent, revoked({ channel: i.recipient.channel, purpose: i.purpose, addressHmac: H2 })] });
    const addSuppression = (ch: 'all' | 'sms' | 'voice' | 'email') => (i: GateInput): GateInput => ({ ...i, suppressions: [...i.suppressions, { channel: ch, reason: 'internal_dnc', liftedAt: null }] });
    const addDnc = (registry: string) => (i: GateInput): GateInput => ({ ...i, dnc: [...i.dnc, dncListed({ registry, checkedAt: instant(i.now - days(1)), validUntil: instant(i.now + days(5)) })] });
    const mutations = [addRevoke, addOtherRevoke, addSuppression('all'), addSuppression('sms'), addSuppression('email'), addSuppression('voice'), addDnc('us_national'), addDnc('us_state:CA')];
    fc.assert(
      fc.property(inputArb, fc.subarray(mutations, { minLength: 1 }), (input, muts) => {
        const before = canContact(input);
        const after = canContact(muts.reduce((acc, m) => m(acc), input));
        expect(rank[after.outcome]).toBeGreaterThanOrEqual(rank[before.outcome]);
        if (before.outcome === 'deny') expect(after.outcome).toBe('deny');
        if (before.outcome !== 'allow') expect(after.outcome).not.toBe('allow');
      }),
      { numRuns: 500 },
    );
  });
  it('assistant and system initiators never get needs_confirmation (DB CHECK)', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        if (input.initiator !== 'human') expect(canContact(input).outcome).not.toBe('needs_confirmation');
      }),
      { numRuns: 500 },
    );
  });
  it('every non-allow decision carries at least one reason, and defer carries deferUntil (DB CHECKs)', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = canContact(input);
        if (d.outcome !== 'allow') expect(d.reasons.length).toBeGreaterThan(0);
        expect(d.outcome === 'defer').toBe(d.deferUntil !== undefined);
        expect(d.explanation.length).toBeGreaterThan(0);
      }),
      { numRuns: 500 },
    );
  });
});

describe('R-GATE-6 reasons that can never be confirmed past', () => {
  it('R-GATE-6 every never-confirmable reason is a deny effect', () => {
    for (const r of NEVER_CONFIRMABLE) expect(REASON_EFFECTS[r]).toBe('deny');
    for (const r of ['TENANT_SUSPENDED', 'CONTACT_POINT_INVALID', 'WRONG_NUMBER', 'LANDLINE_NO_SMS', 'SENDER_NOT_REGISTERED', 'BROKERAGE_IDENTITY_MISSING', 'POSTAL_ADDRESS_MISSING', 'CONSENT_REVOKED', 'SUPPRESSED', 'PAYMENT_INSTRUCTIONS', 'DNC_LISTED', 'DNC_STATUS_UNKNOWN_NO_RELATIONSHIP'] as const) {
      expect(NEVER_CONFIRMABLE.has(r)).toBe(true);
    }
  });
  it('R-GATE-6 a confirmable reason combined with any never-confirmable one is a deny that cannot be confirmed', () => {
    const confirmable = gateInput({ consent: [], now: NIGHT, lastInboundAt: instant(NIGHT - minutes(40)) });
    expect(canConfirm(decide(gateInput({ consent: [] })))).toBe(true);
    const blocks: Partial<GateInput>[] = [
      { tenant: { suspended: true, brokerageNamePresent: true, postalAddressPresent: true } },
      { contactPoint: { status: 'invalid', lineType: 'mobile' } },
      { contactPoint: { status: 'wrong_number', lineType: 'mobile' } },
      { contactPoint: { status: 'active', lineType: 'landline' } },
      { sender: { kind: 'phone', registration: 'blocked' } },
      { consent: [revoked()] },
      { suppressions: [{ channel: 'sms', reason: 'spam_complaint', liftedAt: null }] },
      { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } },
    ];
    for (const b of blocks) {
      const d = decide({ ...confirmable, ...b, now: NOW, lastInboundAt: null });
      expect(d.outcome).toBe('deny');
      expect(canConfirm(d)).toBe(false);
    }
    expect(canConfirm({ outcome: 'needs_confirmation', reasons: ['CONSENT_CONFIRMATION_REQUIRED', 'DNC_LISTED'] })).toBe(false);
    expect(canConfirm({ outcome: 'needs_confirmation', reasons: ['MANUAL_SMS_VOLUME', 'RECIPIENT_TZ_UNCERTAIN'] })).toBe(true);
    expect(canConfirm({ outcome: 'allow', reasons: [] })).toBe(false);
    expect(canConfirm({ outcome: 'defer', reasons: ['FREQUENCY_CAP'] })).toBe(false);
  });
});

describe('R-GATE-11 decision content', () => {
  it('R-GATE-11 the decision carries the core rules version and the digest of the canonical, plaintext-free inputs incl. the policy version', () => {
    const input = gateInput();
    const d = decide(input);
    const record = gateInputsRecord(input);
    expect(d.rulesVersion).toBe(RULES_VERSION);
    expect(d.inputsDigest).toBe(sha256Hex(canonicalJson(record)));
    expect((record.policy as { version: { policyId: string } }).version.policyId).toBe(input.policy.version.policyId);
    const json = JSON.stringify(record);
    expect(json).not.toMatch(/\+1\d{10}/);
    expect(json).not.toMatch(/@/);
    expect(Object.keys(record.recipient as object).sort()).toEqual(['addressHmac', 'channel', 'kind']);
    expect(Array.isArray((record.policy as { autonomous: unknown }).autonomous)).toBe(true);
  });
});

describe('explanations', () => {
  it('a block reads as short human sentences joined with " · "', () => {
    expect(decide(gateInput({ now: NIGHT, consent: [revoked()] })).explanation).toBe('Opted out of texts · Outside 9 AM–8 PM their time');
    expect(decide(gateInput({ ...voice, consent: [revoked({ channel: 'voice' })] })).explanation).toBe('Opted out of calls');
    expect(decide(gateInput({ ...email, sender: { kind: 'email', registration: 'blocked' } })).explanation).toBe('The sending email identity is turned off');
    expect(humanLocalTime(localTime('00:00'))).toBe('12 AM');
    expect(humanLocalTime(localTime('12:30'))).toBe('12:30 PM');
    expect(humanLocalTime(localTime('09:05'))).toBe('9:05 AM');
  });
});

describe('reason catalogue', () => {
  it('every reason code renders a sentence and has an effect', async () => {
    const { reasonSentence } = await import('./reasons.js');
    for (const r of REASON_CODES) {
      expect(['deny', 'confirm', 'defer', 'info']).toContain(REASON_EFFECTS[r]);
      expect(reasonSentence(r, { channel: 'sms', window: policy().window, caps: policy().caps }).length).toBeGreaterThan(3);
    }
  });
});

// Must stay the last test of this file: tests run in order, so `seen` holds every earlier decision.
describe('acceptance: every reason code has at least one test', () => {
  it('every reason code was produced by at least one test above', () => {
    expect(REASON_CODES.filter((r) => !seen.has(r))).toEqual([]);
  });
});
