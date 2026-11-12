import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, at, instant } from '../foundation/index.js';
import { canonicalJson, sha256Hex } from './digest.js';
import { type GateDecision, type GateInput, RULES_VERSION, canContact, gateInputsRecord, optedOut } from './gate.js';
import { OPT_OUT_REASONS, REASON_CODES, type ReasonCode, reasonSentence } from './reasons.js';
import { H1, H2, H3, NOW, aiIsaInput, assistantInput, days, dmInput, gateInput, grantRow, minutes, policy, revokedRow } from './testing/fixtures.js';
import { CHANNELS, ChannelUnknownError } from './types.js';
import type { ConsentStateRow } from './types.js';

// Every decision made in this file is recorded so the last test can prove that every reason code
// is produced by at least one test (BUILD_PLAN module 2 acceptance).
const seen = new Set<ReasonCode>();
function decide(input: GateInput): GateDecision {
  const d = canContact(input);
  for (const r of d.reasons) seen.add(r);
  return d;
}
const T = (ms: number): Instant => instant(NOW + ms);
/** Tue 2026-11-10 22:00 EST (03:00Z next day): what used to be outside the contact window. */
const NIGHT = at('2026-11-11T03:00:00Z');

const revoked = (o: Partial<ConsentStateRow> = {}) => revokedRow(o);
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
    expect(d).toEqual({ outcome: 'allow', reasons: [], explanation: 'OK to send', rulesVersion: RULES_VERSION, inputsDigest: d.inputsDigest });
    expect(d.inputsDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('a clean assistant nurture marketing SMS is allowed', () => {
    expect(decide(assistantInput({ purpose: 'marketing' })).outcome).toBe('allow');
  });
  it('the outcome is only ever allow or deny: nothing is deferred and nothing waits for a confirmation', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = canContact(input);
        expect(['allow', 'deny']).toContain(d.outcome);
        expect(d.outcome === 'deny').toBe(d.reasons.length > 0);
        expect(Object.keys(d).sort()).toEqual(['explanation', 'inputsDigest', 'outcome', 'reasons', 'rulesVersion']);
      }),
      { numRuns: 500 },
    );
  });
});

// ---- the removed consent checks stay removed (owner decision, core-compliance/2.0.0) ----------------
describe('owner decision: no send depends on consent level, DNC registry, contact window or caps', () => {
  it.each(['none', 'imported_unverified', 'inquiry', 'express', 'express_written'] as const)('consent level %s: human and assistant SMS of both purposes are allowed', (level) => {
    const rows = level === 'none' ? [] : [grantRow({ level, purpose: 'informational' }), grantRow({ level, purpose: 'marketing' })];
    for (const purpose of ['informational', 'marketing'] as const) {
      expect(decide(gateInput({ purpose, consent: rows })).outcome).toBe('allow');
      expect(decide(assistantInput({ purpose, consent: rows })).outcome).toBe('allow');
    }
  });
  it('an expired inquiry basis does not block anything', () => {
    expect(decide(assistantInput({ consent: [grantRow({ level: 'inquiry', expiresAt: T(-days(1)) })] })).outcome).toBe('allow');
  });
  it('a send in the middle of the night (recipient-local) is allowed for humans and the assistant', () => {
    expect(decide(gateInput({ now: NIGHT })).outcome).toBe('allow');
    expect(decide(assistantInput({ now: NIGHT, purpose: 'marketing' })).outcome).toBe('allow');
    expect(decide(gateInput({ ...voice, now: NIGHT, purpose: 'marketing' })).outcome).toBe('allow');
  });
  it('the gate has no inputs for DNC scrubs, caps, recent sends, inbound timing or time zones', () => {
    const keys = Object.keys(gateInput()).sort();
    for (const k of ['dnc', 'recentAutomated', 'recentManualSms24h', 'callAttempts24h', 'lastInboundAt', 'zones', 'jitterKey']) expect(keys).not.toContain(k);
  });
  it('the policy carries no contact window, caps, DNC validity or quiet-hours switch', () => {
    const p = policy() as unknown as Record<string, unknown>;
    for (const k of ['window', 'caps', 'humanReplyWindowMin', 'dncValidityDays', 'emailQuietHours']) expect(p[k]).toBeUndefined();
  });
});

// ---- ARCHITECTURE §9: one row per check, for both initiator columns -------------------------------
describe('ARCHITECTURE §9 check table', () => {
  const both = (name: string, o: Partial<GateInput>, r: ReasonCode) => {
    it(`§9 ${name}: assistant/system ⇒ deny ${r}`, () => expectDecision(decide(assistantInput(o)), 'deny', r));
    it(`§9 ${name}: human ⇒ deny ${r}`, () => expectDecision(decide(gateInput(o)), 'deny', r));
  };
  both('1 tenant suspended', { tenant: { suspended: true, brokerageNamePresent: true, postalAddressPresent: true } }, 'TENANT_SUSPENDED');
  both('2 contact point invalid', { contactPoint: { status: 'invalid', lineType: 'mobile' } }, 'CONTACT_POINT_INVALID');
  both('2 wrong number', { contactPoint: { status: 'wrong_number', lineType: 'mobile' } }, 'WRONG_NUMBER');
  both('2 SMS to a landline', { contactPoint: { status: 'active', lineType: 'landline' } }, 'LANDLINE_NO_SMS');
  both('3 sender not registered', { sender: { kind: 'phone', registration: 'pending' } }, 'SENDER_NOT_REGISTERED');
  both('3 marketing email from an unverified domain', { ...email, purpose: 'marketing', sender: { kind: 'email', registration: 'ready', domainVerified: false } }, 'EMAIL_DOMAIN_UNVERIFIED');
  both('4 marketing without the brokerage name rendered', { purpose: 'marketing', rendered: { containsBrokerageName: false, containsOptOutHint: true, paymentInstructions: false } }, 'BROKERAGE_IDENTITY_MISSING');
  both('4 marketing email without a postal address', { ...email, purpose: 'marketing', tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: false } }, 'POSTAL_ADDRESS_MISSING');
  both('4 marketing email without unsubscribe', { ...email, purpose: 'marketing', rendered: { containsBrokerageName: true, containsOptOutHint: false, paymentInstructions: false } }, 'UNSUBSCRIBE_MISSING');
  both('5 opted out', { consent: [revoked()] }, 'CONSENT_REVOKED');
  both('6 active suppression', { suppressions: [{ channel: 'sms', reason: 'internal_dnc', liftedAt: null }] }, 'SUPPRESSED');
  both('7 payment instructions', { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } }, 'PAYMENT_INSTRUCTIONS');

  it('§9 8 automation paused: assistant ⇒ deny; human ⇒ allowed (humans can always reply)', () => {
    expectDecision(decide(assistantInput({ automationPausedAt: T(-minutes(5)) })), 'deny', 'AUTOMATION_PAUSED');
    expectDecision(decide(gateInput({ initiator: 'system', category: 'reminder', automationPausedAt: T(-minutes(5)) })), 'deny', 'AUTOMATION_PAUSED');
    expect(decide(gateInput({ automationPausedAt: T(-minutes(5)) })).outcome).toBe('allow');
  });
  it('§9 every reason is collected, in check order', () => {
    const d = decide(gateInput({ consent: [revoked()], suppressions: [{ channel: 'all', reason: 'admin_block', liftedAt: null }], rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } }));
    expect(d.outcome).toBe('deny');
    expect(d.reasons).toEqual(['CONSENT_REVOKED', 'SUPPRESSED', 'PAYMENT_INSTRUCTIONS']);
  });
});

// ---- opt-out: the one consent rule that stays, with no override ------------------------------------
describe('opt-out block (R-CONSENT-7, R-CONSENT-10, R-CONSENT-20): no override for anyone', () => {
  it('R-CONSENT-10 an opted-out address is denied for every initiator, at every consent level, on every channel', () => {
    for (const ch of ['sms', 'email', 'voice'] as const) {
      const base = ch === 'email' ? email : ch === 'voice' ? voice : {};
      for (const level of ['none', 'express', 'express_written'] as const) {
        const consent = [revoked({ channel: ch }), ...(level === 'none' ? [] : [grantRow({ channel: ch, level, addressHmac: H3 })])];
        expectDecision(decide(gateInput({ ...base, consent })), 'deny', 'CONSENT_REVOKED');
        if (ch !== 'voice') expectDecision(decide(assistantInput({ ...base, consent })), 'deny', 'CONSENT_REVOKED');
      }
    }
  });
  it("R-CONSENT-7 a STOP on ANOTHER of the contact's phones blocks texting this number too", () => {
    expectDecision(decide(gateInput({ consent: [grantRow({ level: 'express_written' }), revoked({ addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(assistantInput({ consent: [revoked({ addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(assistantInput({ purpose: 'marketing', consent: [revoked({ addressHmac: H2, purpose: 'marketing' })] })), 'deny', 'CONSENT_REVOKED');
  });
  it("SMS and voice revokes reach across the contact's phones; email looks at its own address", () => {
    expect(decide(gateInput({ consent: [revoked({ addressHmac: H2, channel: 'voice' })] })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, consent: [revoked({ addressHmac: H2, channel: 'email' })] })).outcome).toBe('allow');
    // outbound-3: an agent-recorded "do not call me" on phone H2 blocks calling the contact's phone H1
    expectDecision(decide(gateInput({ ...voice, consent: [revoked({ addressHmac: H2, channel: 'voice' })] })), 'deny', 'CONSENT_REVOKED');
  });
  it('an opt-out is channel-specific: an SMS STOP does not block email or calls', () => {
    expect(decide(gateInput({ ...email, consent: [revoked({ channel: 'sms' })] })).outcome).toBe('allow');
    expect(decide(gateInput({ ...voice, consent: [revoked({ channel: 'sms' })] })).outcome).toBe('allow');
  });
  it('a marketing-only opt-out of texts/email does not block an informational one; it blocks marketing', () => {
    expect(decide(gateInput({ consent: [revoked({ purpose: 'marketing' })] })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ purpose: 'marketing', consent: [revoked({ purpose: 'marketing' })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(gateInput({ ...email, purpose: 'marketing', consent: [revoked({ channel: 'email', purpose: 'marketing' })] })), 'deny', 'CONSENT_REVOKED');
  });
  it('an agent-recorded "do not call me" (voice revoke) blocks every call to that number, whatever the purpose', () => {
    for (const p of ['informational', 'marketing'] as const) {
      for (const rp of ['informational', 'marketing'] as const) expectDecision(decide(gateInput({ ...voice, purpose: p, consent: [revoked({ channel: 'voice', purpose: rp })] })), 'deny', 'CONSENT_REVOKED');
    }
  });
  it('email unsubscribe (a revoked email row) blocks marketing email from humans and the assistant', () => {
    const unsub = [revoked({ channel: 'email', purpose: 'marketing' })];
    expectDecision(decide(gateInput({ ...email, purpose: 'marketing', consent: unsub })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(assistantInput({ ...email, category: 'search_alert', purpose: 'marketing', consent: unsub })), 'deny', 'CONSENT_REVOKED');
  });
  it('suppressions (bounce, complaint, do-not-contact request, wrong number, provider opt-out, imported DNC) block their channel or all; lifted ones do not', () => {
    for (const reason of ['hard_bounce', 'spam_complaint', 'internal_dnc', 'admin_block', 'wrong_number', 'provider_opt_out', 'import_dnc'] as const) {
      expectDecision(decide(gateInput({ suppressions: [{ channel: 'all', reason, liftedAt: null }] })), 'deny', 'SUPPRESSED');
      expectDecision(decide(gateInput({ ...email, suppressions: [{ channel: 'email', reason, liftedAt: null }] })), 'deny', 'SUPPRESSED');
      expectDecision(decide(gateInput({ ...voice, suppressions: [{ channel: 'voice', reason, liftedAt: null }] })), 'deny', 'SUPPRESSED');
    }
    expect(decide(gateInput({ suppressions: [{ channel: 'email', reason: 'hard_bounce', liftedAt: null }] })).outcome).toBe('allow');
    expect(decide(gateInput({ suppressions: [{ channel: 'sms', reason: 'internal_dnc', liftedAt: T(-days(1)) }] })).outcome).toBe('allow');
  });
  it('R-CONSENT-1 E21 spouses share one phone; one texts STOP: the address-keyed revoke blocks SMS to both contacts', () => {
    const shared = [revoked({ purpose: 'informational' }), revoked({ purpose: 'marketing' })];
    for (const purpose of ['informational', 'marketing'] as const) {
      const d = decide(gateInput({ purpose, consent: shared }));
      expectDecision(d, 'deny', 'CONSENT_REVOKED');
      expect(d.explanation).toBe('Opted out of texts');
    }
  });
  it('R-CONSENT-20 E23 STOP to number A, then an agent texts from number B: the tenant-wide address revoke denies', () => {
    expectDecision(decide(gateInput({ consent: [revoked()], sender: { kind: 'phone', registration: 'ready' } })), 'deny', 'CONSENT_REVOKED');
  });
  it('R-CONSENT-1 E60 an agent who texted STOP to alert SMS gets no alert SMS (user recipient opt-out)', () => {
    expectDecision(decide(gateInput({ ...toAgent, consent: [revoked({ addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expect(decide(gateInput({ ...toAgent })).outcome).toBe('allow');
  });
  it('the opt-out reasons are the ones listed as never overridable', () => {
    expect([...OPT_OUT_REASONS].sort()).toEqual(['CONSENT_REVOKED', 'PERSON_DO_NOT_CONTACT', 'SUPPRESSED']);
  });
  it('optedOut() agrees with the gate for every channel/purpose/address combination', () => {
    const rows = [revoked({ addressHmac: H2, purpose: 'marketing' }), revoked({ channel: 'voice', purpose: 'marketing' }), revoked({ channel: 'email', purpose: 'informational', addressHmac: H3 })];
    expect(optedOut(rows, 'sms', 'marketing', H1)).toBe(true);
    expect(optedOut(rows, 'sms', 'informational', H1)).toBe(false);
    expect(optedOut(rows, 'voice', 'informational', H1)).toBe(true);
    // outbound-3: a "do not call me" recorded on one of the contact's phones blocks calling the others
    expect(optedOut(rows, 'voice', 'informational', H2)).toBe(true);
    expect(optedOut(rows.filter((r) => r.channel !== 'voice'), 'voice', 'informational', H2)).toBe(false);
    expect(optedOut(rows, 'email', 'informational', H3)).toBe(true);
    expect(optedOut(rows, 'email', 'informational', H1)).toBe(false);
    expect(optedOut([grantRow()], 'sms', 'informational', H1)).toBe(false);
  });
});

describe('opt-out exemption for the STOP/HELP reply cannot be abused', () => {
  const sys = (category: 'opt_out_confirmation' | 'help_reply', o: Partial<GateInput> = {}) => decide(gateInput({ initiator: 'system', category, consent: [revoked()], automationPausedAt: T(-1), keywordSenders: [H1], ...o }));
  it('R-CONSENT-7 the system opt-out confirmation and HELP reply go to an opted-out, paused number', () => {
    expect(sys('opt_out_confirmation').outcome).toBe('allow');
    expect(sys('help_reply').outcome).toBe('allow');
  });
  it('R-CONSENT-7 outbound-1: the reply reaches only the number that sent the keyword, never another opted-out phone of the contact', () => {
    // H2 texted HELP; H1 (revoked by its own STOP days ago) is not the sender
    expectDecision(sys('help_reply', { keywordSenders: [H2] }), 'deny', 'CONSENT_REVOKED');
    expectDecision(sys('opt_out_confirmation', { keywordSenders: [] }), 'deny', 'CONSENT_REVOKED');
    expectDecision(sys('help_reply', { keywordSenders: undefined }), 'deny', 'CONSENT_REVOKED');
    expect(sys('help_reply', { keywordSenders: [H2, H1] }).outcome).toBe('allow');
  });
  it('the exempt replies are still sender-registration, suppression and content checked', () => {
    expectDecision(sys('opt_out_confirmation', { sender: { kind: 'phone', registration: 'blocked' } }), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(sys('help_reply', { suppressions: [{ channel: 'sms', reason: 'landline_no_sms', liftedAt: null }] }), 'deny', 'SUPPRESSED');
    expectDecision(sys('help_reply', { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } }), 'deny', 'PAYMENT_INSTRUCTIONS');
  });
  it('R-CONSENT-10 a human, assistant, marketing, email or voice send labelled as an exempt reply is still blocked by the opt-out', () => {
    expectDecision(decide(gateInput({ category: 'opt_out_confirmation', consent: [revoked()] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(gateInput({ category: 'help_reply', consent: [revoked()] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(assistantInput({ category: 'help_reply', consent: [revoked()] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(sys('opt_out_confirmation', { purpose: 'marketing', consent: [revoked({ purpose: 'marketing' })] }), 'deny', 'CONSENT_REVOKED');
    expectDecision(sys('opt_out_confirmation', { ...email, consent: [revoked({ channel: 'email' })] }), 'deny', 'CONSENT_REVOKED');
  });
});

// ---- autonomy (owner amendments A3/A7) ------------------------------------------------------------
describe('autonomy: the assistant sends only approved autonomous categories; money, contracts and new kinds of message always need a human', () => {
  it.each(['money', 'contract', 'novel_message', 'seller_update'] as const)('R-AST-3 %s is never automated (assistant or system), whatever the policy says', (category) => {
    const wide = policy({ autonomousCategories: ['speed_to_lead_reply', 'reminder', 'booking_confirmation', 'document_chase', 'nurture_step', 'search_alert', category] });
    expectDecision(decide(assistantInput({ category, policy: wide })), 'deny', 'CATEGORY_REQUIRES_HUMAN');
    expectDecision(decide(gateInput({ initiator: 'system', category, policy: wide })), 'deny', 'CATEGORY_REQUIRES_HUMAN');
    expect(decide(gateInput({ category })).outcome).toBe('allow'); // a person may send it
  });
  it('the assistant sends only the tenant-approved autonomous categories; the system respects the same switch', () => {
    expect(decide(assistantInput({ category: 'money' })).reasons).toEqual(['CATEGORY_REQUIRES_HUMAN', 'CATEGORY_NOT_AUTONOMOUS']);
    expectDecision(decide(assistantInput({ category: 'document_chase' })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
    expect(decide(assistantInput({ category: 'document_chase', policy: policy({ autonomousCategories: ['document_chase'] }) })).outcome).toBe('allow');
    expectDecision(decide(assistantInput({ category: 'nurture_step', policy: policy({ autonomousCategories: [] }) })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
    expectDecision(decide(gateInput({ initiator: 'system', category: 'reminder', policy: policy({ autonomousCategories: [] }) })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
    expect(decide(gateInput({ initiator: 'system', category: 'reminder' })).outcome).toBe('allow');
    expectDecision(decide(assistantInput({ category: 'none' })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
    expectDecision(decide(assistantInput({ category: 'opt_out_confirmation' })), 'deny', 'CATEGORY_NOT_AUTONOMOUS');
  });
  // R-GATE-9 itself is a DB CHECK on calls.initiator; the gate refuses automated calls as well.
  it('no automated voice: the gate refuses assistant and system calls', () => {
    expectDecision(decide(assistantInput({ ...voice })), 'deny', 'AUTOMATED_VOICE_UNAVAILABLE');
    expectDecision(decide(gateInput({ ...voice, initiator: 'system', category: 'reminder' })), 'deny', 'AUTOMATED_VOICE_UNAVAILABLE');
    expect(decide(gateInput({ ...voice })).outcome).toBe('allow');
  });
  it('R-AST-9 an inbound reply pauses automation: every automated send is denied, the human may still reply', () => {
    for (const category of ['speed_to_lead_reply', 'nurture_step', 'search_alert', 'reminder', 'booking_confirmation'] as const) {
      expectDecision(decide(assistantInput({ category, automationPausedAt: T(-1) })), 'deny', 'AUTOMATION_PAUSED');
    }
    expect(decide(gateInput({ automationPausedAt: T(-1) })).outcome).toBe('allow');
  });
  it('agent alerts go only to users, and users only get agent alerts', () => {
    expectDecision(decide(gateInput({ category: 'agent_alert', initiator: 'system' })), 'deny', 'RECIPIENT_CATEGORY_MISMATCH');
    expectDecision(decide(gateInput({ ...toAgent, category: 'none' })), 'deny', 'RECIPIENT_CATEGORY_MISMATCH');
  });
});

// ---- operational sanity, identity and content --------------------------------------------------------
describe('check details', () => {
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
  it('R-GATE-12 marketing on every channel needs the brokerage name; informational does not', () => {
    const noName = { tenant: { suspended: false, brokerageNamePresent: false, postalAddressPresent: true } };
    expectDecision(decide(gateInput({ ...noName, purpose: 'marketing' })), 'deny', 'BROKERAGE_IDENTITY_MISSING');
    expectDecision(decide(gateInput({ ...voice, ...noName, purpose: 'marketing' })), 'deny', 'BROKERAGE_IDENTITY_MISSING');
    expectDecision(decide(assistantInput({ ...noName, purpose: 'marketing' })), 'deny', 'BROKERAGE_IDENTITY_MISSING');
    expect(decide(gateInput({ ...noName })).outcome).toBe('allow');
    expect(decide(gateInput({ rendered: { containsBrokerageName: false, containsOptOutHint: false, paymentInstructions: false } })).outcome).toBe('allow');
  });
  it('R-CONSENT-18 marketing email (CAN-SPAM, regardless of consent): verified domain + brokerage name + postal address + unsubscribe, for both initiators', () => {
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
  it('postal address and unsubscribe are email-only marketing requirements; missing content on marketing email is denied, not a crash', () => {
    const noPostal = { tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: false } };
    expect(decide(gateInput({ ...noPostal, purpose: 'marketing' })).outcome).toBe('allow');
    expect(decide(gateInput({ ...noPostal, ...email })).outcome).toBe('allow');
    expect(decide(gateInput({ ...email, purpose: 'marketing', rendered: undefined })).reasons).toEqual(['RENDERED_CONTENT_MISSING']);
  });
  it('R-GATE-7 payment / wire instructions are denied for every initiator and channel', () => {
    const pay = { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: true } };
    expectDecision(decide(gateInput(pay)), 'deny', 'PAYMENT_INSTRUCTIONS');
    expectDecision(decide(gateInput({ ...email, ...pay })), 'deny', 'PAYMENT_INSTRUCTIONS');
    expectDecision(decide(assistantInput(pay)), 'deny', 'PAYMENT_INSTRUCTIONS');
    expectDecision(decide(gateInput({ initiator: 'system', category: 'reminder', ...pay })), 'deny', 'PAYMENT_INSTRUCTIONS');
  });
  it('agent alerts: tenant, sender, own opt-out, suppression and content checks only', () => {
    expect(decide(gateInput({ ...toAgent, now: NIGHT })).outcome).toBe('allow');
    expectDecision(decide(gateInput({ ...toAgent, sender: { kind: 'phone', registration: 'pending' } })), 'deny', 'SENDER_NOT_REGISTERED');
    expectDecision(decide(gateInput({ ...toAgent, suppressions: [{ channel: 'sms', reason: 'admin_block', liftedAt: null }] })), 'deny', 'SUPPRESSED');
    expectDecision(decide(gateInput({ ...toAgent, contactPoint: { status: 'invalid', lineType: 'mobile' } })), 'deny', 'CONTACT_POINT_INVALID');
    expectDecision(decide(gateInput({ ...toAgent, tenant: { suspended: true, brokerageNamePresent: true, postalAddressPresent: true } })), 'deny', 'TENANT_SUSPENDED');
  });
  it('RULES_VERSION is a stable versioned string, bumped to 3.0.0 for the Phase 2 channels', () => {
    expect(RULES_VERSION).toBe('core-compliance/3.0.0');
  });
});

// ---- R-GATE-5, R-GATE-11 ----------------------------------------------------------------------------
const inputArb: fc.Arbitrary<GateInput> = fc
  .record({
    initiator: fc.constantFrom('human', 'assistant', 'system') as fc.Arbitrary<GateInput['initiator']>,
    channel: fc.constantFrom('sms', 'voice', 'email') as fc.Arbitrary<'sms' | 'voice' | 'email'>,
    purpose: fc.constantFrom('marketing', 'informational') as fc.Arbitrary<'marketing' | 'informational'>,
    category: fc.constantFrom('none', 'nurture_step', 'search_alert', 'reminder', 'money', 'opt_out_confirmation', 'help_reply') as fc.Arbitrary<GateInput['category']>,
    level: fc.constantFrom('none', 'imported_unverified', 'inquiry', 'express', 'express_written') as fc.Arbitrary<ConsentStateRow['level']>,
    hour: fc.integer({ min: 0, max: 47 }),
    paused: fc.boolean(),
  })
  .map((r) => {
    const now = instant(at('2026-11-10T05:00:00Z') + r.hour * 30 * 60_000);
    const consent = r.level === 'none' ? [] : [grantRow({ channel: r.channel, purpose: r.purpose, level: r.level })];
    return gateInput({
      now,
      initiator: r.initiator,
      purpose: r.purpose,
      category: r.category,
      recipient: { kind: 'contact', addressHmac: H1, channel: r.channel },
      sender: r.channel === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : { kind: 'phone', registration: 'ready' },
      ...(r.channel === 'voice' ? { rendered: undefined } : {}),
      consent,
      automationPausedAt: r.paused ? instant(now - 1) : null,
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
    expect(canContact(gateInput({ purpose: 'marketing' })).inputsDigest).not.toBe(a.inputsDigest);
    expect(canContact(gateInput({ now: T(1) })).inputsDigest).not.toBe(a.inputsDigest);
  });
  it('R-GATE-5 adding a revoke (own address or another phone) or a suppression never turns deny into allow, and an own-address revoke or a channel suppression always denies', () => {
    const addRevoke = (i: GateInput): GateInput => ({ ...i, consent: [...i.consent.filter((r) => !(r.channel === i.recipient.channel && r.purpose === i.purpose && r.addressHmac === i.recipient.addressHmac)), revoked({ channel: i.recipient.channel, purpose: i.purpose })] });
    const addOtherRevoke = (i: GateInput): GateInput => ({ ...i, consent: [...i.consent, revoked({ channel: i.recipient.channel, purpose: i.purpose, addressHmac: H2 })] });
    const addSuppression = (ch: 'all' | 'sms' | 'voice' | 'email') => (i: GateInput): GateInput => ({ ...i, suppressions: [...i.suppressions, { channel: ch, reason: 'internal_dnc', liftedAt: null }] });
    const mutations = [addRevoke, addOtherRevoke, addSuppression('all'), addSuppression('sms'), addSuppression('email'), addSuppression('voice')];
    fc.assert(
      fc.property(inputArb, fc.subarray(mutations, { minLength: 1 }), (input, muts) => {
        const before = canContact(input);
        const after = canContact(muts.reduce((acc, m) => m(acc), input));
        if (before.outcome === 'deny') expect(after.outcome).toBe('deny');
        for (const r of before.reasons) expect(after.reasons).toContain(r);
        const exempt = input.initiator === 'system' && (input.category === 'opt_out_confirmation' || input.category === 'help_reply') && input.purpose === 'informational' && input.recipient.channel === 'sms';
        if (muts.includes(addRevoke) && !exempt) expect(after.reasons).toContain('CONSENT_REVOKED');
        if (muts.includes(addSuppression('all'))) expect(after.outcome).toBe('deny');
      }),
      { numRuns: 500 },
    );
  });
  it('a suppression on all channels always denies, the opt-out exemption included', () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expectDecision(canContact({ ...input, suppressions: [{ channel: 'all', reason: 'spam_complaint', liftedAt: null }] }), 'deny', 'SUPPRESSED');
      }),
      { numRuns: 300 },
    );
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

// ---- core-compliance/3.0.0 (module 19): website chat, person DNC, connection; D2: no Meta DMs ----------
describe('core-compliance/3.0.0: website chat, person-level do-not-contact (R-CHAN-1, R-CHAN-2, R-CHAN-5, R-INBOX-3, R-INT-2)', () => {
  it('a clean human reply on website chat is allowed (no sender phone/email needed: the widget connection sends)', () => {
    expect(decide(dmInput()).outcome).toBe('allow');
  });
  it('R-CHAN-1 a chat identity is gated by the HMAC of its address; an opt-out on another chat identity of the contact blocks this one; a phone STOP does not', () => {
    expectDecision(decide(dmInput('web_chat', { consent: [revoked({ channel: 'web_chat' })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(dmInput('web_chat', { consent: [revoked({ channel: 'web_chat', addressHmac: H2 })] })), 'deny', 'CONSENT_REVOKED');
    expect(decide(dmInput('web_chat', { consent: [revoked({ channel: 'sms', addressHmac: H3 })] })).outcome).toBe('allow');
  });
  it('R-CHAN-2 E139 a person-level do-not-contact blocks every channel for every initiator, calls included', () => {
    for (const ch of CHANNELS) {
      const base = ch === 'web_chat' ? dmInput() : ch === 'voice' ? gateInput({ recipient: { kind: 'contact', addressHmac: H1, channel: 'voice' }, rendered: undefined }) : ch === 'email' ? gateInput(email) : gateInput();
      for (const initiator of ['human', 'assistant', 'system'] as const) {
        expectDecision(decide({ ...base, initiator, category: initiator === 'human' ? 'none' : 'reminder', personDoNotContact: true }), 'deny', 'PERSON_DO_NOT_CONTACT');
      }
    }
  });
  it('R-CHAN-2 only the system keyword SMS reply to the number that sent the keyword is exempt (as in the DB guard); chat has no exemption', () => {
    const reply = { initiator: 'system' as const, category: 'opt_out_confirmation' as const, personDoNotContact: true, keywordSenders: [H1] };
    expect(decide(gateInput({ ...reply, consent: [revoked()] })).outcome).toBe('allow');
    expectDecision(decide(dmInput('web_chat', { ...reply, consent: [revoked({ channel: 'web_chat' })] })), 'deny', 'CONSENT_REVOKED', 'PERSON_DO_NOT_CONTACT');
    expectDecision(decide(gateInput({ ...reply, keywordSenders: [H2] })), 'deny', 'PERSON_DO_NOT_CONTACT');
  });
  it('R-INT-2 a chat reply through a disconnected, revoked, pending or missing widget connection is CHANNEL_NOT_CONNECTED; degraded still sends', () => {
    expectDecision(decide(dmInput('web_chat', { connection: null })), 'deny', 'CHANNEL_NOT_CONNECTED');
    expectDecision(decide(dmInput('web_chat', { connection: { status: 'other' } })), 'deny', 'CHANNEL_NOT_CONNECTED');
    expect(decide(dmInput('web_chat', { connection: { status: 'degraded' } })).outcome).toBe('allow');
    expect(decide(gateInput({ connection: null })).outcome).toBe('allow');
  });
  it('the platform rule is operational, not consent: D1 still never asks for a consent level on a chat reply', () => {
    expect(decide(dmInput('web_chat', { consent: [], initiator: 'assistant', category: 'speed_to_lead_reply' })).outcome).toBe('allow');
  });
  it('R-FH-1/2 a hard fair-housing match blocks marketing for everyone and any automated send; a human one-to-one informational reply is not blocked', () => {
    const fh = { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false, fairHousingHardMatches: 1 };
    expectDecision(decide(gateInput({ purpose: 'marketing', rendered: fh })), 'deny', 'FAIR_HOUSING_TERMS');
    expectDecision(decide(assistantInput({ rendered: fh })), 'deny', 'FAIR_HOUSING_TERMS');
    expect(decide(gateInput({ rendered: fh })).reasons).not.toContain('FAIR_HOUSING_TERMS');
    expect(decide(gateInput({ purpose: 'marketing', rendered: { ...fh, fairHousingHardMatches: 0 } })).reasons).not.toContain('FAIR_HOUSING_TERMS');
  });
  it('R-GATE-13 E80 an unknown channel is refused (throws CHANNEL_UNKNOWN), never mapped to texts; D2: Messenger and Instagram are unknown to core', () => {
    for (const ch of ['fax', 'messenger', 'instagram']) {
      expect(() => canContact(gateInput({ recipient: { kind: 'contact', addressHmac: H1, channel: ch as never } }))).toThrow(ChannelUnknownError);
    }
  });
  it('the assistant sends chat replies only in approved autonomous categories and never past a pause', () => {
    expectDecision(decide(dmInput('web_chat', { initiator: 'assistant', category: 'money' })), 'deny', 'CATEGORY_REQUIRES_HUMAN');
    expectDecision(decide(dmInput('web_chat', { initiator: 'assistant', category: 'speed_to_lead_reply', automationPausedAt: T(-1) })), 'deny', 'AUTOMATION_PAUSED');
  });
  it('every new reason renders a sentence naming the channel where it matters', () => {
    // a chat reply's CHANNEL_NOT_CONNECTED is the chat ending or its widget turned off, never a setup fault (finding UXA-8)
    expect(decide(dmInput('web_chat', { connection: null })).explanation).toBe('The chat has ended: they left the page or the website chat was turned off');
    expect(decide(dmInput('web_chat', { personDoNotContact: true })).explanation).toBe('This person asked not to be contacted on any channel');
  });
});

describe('explanations', () => {
  it('a block reads as short human sentences joined with " · "', () => {
    expect(decide(gateInput({ consent: [revoked()], suppressions: [{ channel: 'sms', reason: 'internal_dnc', liftedAt: null }] })).explanation).toBe('Opted out of texts · Blocked for texts (bounce, complaint or do-not-contact)');
    expect(decide(gateInput({ ...voice, consent: [revoked({ channel: 'voice' })] })).explanation).toBe('Opted out of calls');
    expect(decide(gateInput({ ...email, consent: [revoked({ channel: 'email' })] })).explanation).toBe('Opted out of email');
    expect(decide(gateInput({ ...email, sender: { kind: 'email', registration: 'blocked' } })).explanation).toBe('The sending email identity is turned off');
  });
});

// ---- D12 (proposed, docs/AI_ISA.md §5.4): checks 0, 8 and 12 for the AI ISA categories only -------------------
describe('R-ISA-8 AI ISA checks 0, 8 and 12 (the AI ISA categories only; property tests in gate_ai_isa.test.ts)', () => {
  it('a clean AI ISA message to the bound point is allowed', () => expect(decide(aiIsaInput()).outcome).toBe('allow'));
  it('check 0: a human or system sender, or no AI ISA facts ⇒ ISA_NOT_AUTHORIZED', () => {
    expectDecision(decide(aiIsaInput({ initiator: 'human' })), 'deny', 'ISA_NOT_AUTHORIZED');
    expectDecision(decide(aiIsaInput({ aiIsa: undefined })), 'deny', 'ISA_NOT_AUTHORIZED');
  });
  const isa = (name: string, f: Parameters<typeof aiIsaInput>[1], r: ReasonCode, o: Parameters<typeof aiIsaInput>[0] = {}) => it(`check ${name} ⇒ ${r}`, () => expectDecision(decide(aiIsaInput(o, f)), 'deny', r));
  isa('8 paused', { paused: true }, 'ISA_PAUSED');
  isa('8 stale pinned seq', { pinnedSeqCurrent: false }, 'ISA_STALE_REPLY');
  isa('8 stale epoch', { epochCurrent: false }, 'ISA_STALE_EPOCH');
  isa('12a chain', { chainFailures: ['platform:ai_isa'] }, 'ISA_NOT_AUTHORIZED');
  isa('12a unbound recipient', { boundRecipientHmac: H2 }, 'ISA_UNBOUND_RECIPIENT');
  isa('12a purpose', {}, 'ISA_PURPOSE_MISMATCH', { purpose: 'informational' });
  isa('12b channel', { allowedChannels: ['email'] }, 'ISA_CHANNEL_NOT_ALLOWED');
  isa('12c evidence', { consentMissing: ['evidence'] }, 'ISA_CONSENT_EVIDENCE_MISSING');
  isa('12c reply window', { consentMissing: ['reply_window'] }, 'ISA_REPLY_WINDOW_CLOSED');
  isa('12c DNC', { consentMissing: ['dnc'] }, 'ISA_DNC_UNVERIFIED');
  isa('12d quiet hours', { zones: ['America/Los_Angeles'] }, 'ISA_QUIET_HOURS');
  isa('12d zone', { zones: [] }, 'ISA_ZONE_UNRESOLVED');
  isa('12e cap', { counts: { ai24h: 3, automated24h: 3, initiated24h: 0, initiated7d: 0, lastAiOutboundAt: null } }, 'ISA_CAP_REACHED');
  isa('12e gap', { counts: { ai24h: 1, automated24h: 1, initiated24h: 0, initiated7d: 0, lastAiOutboundAt: instant(NOW - 60_000) } }, 'ISA_MIN_GAP');
  isa('12f shared address', { sharedAddress: true }, 'ISA_SHARED_ADDRESS');
  isa('12f active client', { activeClient: true }, 'ISA_ACTIVE_CLIENT');
  isa('12g seller data', { soldDerivedFact: true }, 'ISA_SELLER_DATA_NOT_CLEARED', { recipient: { kind: 'contact', addressHmac: H1, channel: 'email' }, sender: { kind: 'email', registration: 'ready', domainVerified: true } });
  it('D1 runs first and unchanged: an opt-out still blocks an AI ISA message whatever its facts', () => {
    expectDecision(decide(aiIsaInput({ consent: [revoked({ purpose: 'marketing' })] })), 'deny', 'CONSENT_REVOKED');
    expectDecision(decide(aiIsaInput({ personDoNotContact: true })), 'deny', 'PERSON_DO_NOT_CONTACT');
  });
});

describe('reason catalogue', () => {
  it('every reason code renders a sentence on every channel', () => {
    for (const r of REASON_CODES) for (const ch of CHANNELS) expect(reasonSentence(r, ch).length).toBeGreaterThan(3);
  });
});

// Must stay the last test of this file: tests run in order, so `seen` holds every earlier decision.
describe('acceptance: every reason code has at least one test', () => {
  it('every reason code was produced by at least one test above', () => {
    expect(REASON_CODES.filter((r) => !seen.has(r))).toEqual([]);
  });
});
