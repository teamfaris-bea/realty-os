// Module 45 (api/portal) in the gate: check 8's portal sign-in link clause (R-PORTAL-11, R-GATE-14; core-compliance/3.2.0).
// The client's own sign-in link skips ONLY the automation pause, and only as a system, informational sms/email send
// to a contact. Every D1 opt-out still blocks it (VERIFY WITH COUNSEL, Q-PORTAL-1).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instant } from '../foundation/index.js';
import { type GateInput, RULES_VERSION, canContact } from './gate.js';
import { H1, H2, NOW, gateInput, revokedRow } from './testing/fixtures.js';
import { ACTION_CATEGORIES, ALWAYS_HUMAN_CATEGORIES, AUTONOMOUS_ELIGIBLE, PORTAL_LOGIN_LINK } from './types.js';

const PAUSED = instant(NOW - 60_000);
const email = { recipient: { kind: 'contact' as const, addressHmac: H1, channel: 'email' as const }, sender: { kind: 'email' as const, registration: 'ready' as const, domainVerified: true } };
const link = (o: Partial<GateInput> = {}) => gateInput({ initiator: 'system', category: 'portal_login_link', purpose: 'informational', ...o });
const decisionOf = (i: GateInput) => {
  const d = canContact(i);
  return { outcome: d.outcome, reasons: d.reasons };
};

describe('R-PORTAL-11 the sign-in link through an automation pause', () => {
  it('R-PORTAL-11: the category exists, is never autonomous-eligible and never always-human', () => {
    expect(ACTION_CATEGORIES).toContain('portal_login_link');
    expect(PORTAL_LOGIN_LINK).toBe('portal_login_link');
    expect(AUTONOMOUS_ELIGIBLE.has('portal_login_link')).toBe(false);
    expect(ALWAYS_HUMAN_CATEGORIES.has('portal_login_link')).toBe(false);
  });

  it('E682: a paused conversation still gets the link, by text and by email', () => {
    expect(decisionOf(link({ automationPausedAt: PAUSED }))).toEqual({ outcome: 'allow', reasons: [] });
    expect(decisionOf(link({ ...email, automationPausedAt: PAUSED }))).toEqual({ outcome: 'allow', reasons: [] });
  });

  it('R-GATE-14: an opt-out on that channel, a suppression or person-level do-not-contact blocks the link (no override)', () => {
    expect(canContact(link({ automationPausedAt: PAUSED, consent: [revokedRow()] })).reasons).toEqual(['CONSENT_REVOKED']);
    expect(canContact(link({ suppressions: [{ channel: 'all', reason: 'admin_block', liftedAt: null }] })).reasons).toEqual(['SUPPRESSED']);
    expect(canContact(link({ personDoNotContact: true })).reasons).toEqual(['PERSON_DO_NOT_CONTACT']);
    // a STOP from another phone of the contact (R-PAR-12) still blocks texts to this one
    expect(canContact(link({ consent: [revokedRow({ addressHmac: H2 })] })).reasons).toContain('CONSENT_REVOKED');
  });

  it('R-GATE-14: the wrong number behind a wrong_number pause still blocks (check 2), the pause itself does not', () => {
    const d = canContact(link({ automationPausedAt: PAUSED, contactPoint: { status: 'wrong_number', lineType: 'mobile' } }));
    expect(d.reasons).toEqual(['WRONG_NUMBER']);
  });

  it('VERIFY 1 (Q-PORTAL-1): an SMS STOP does not block the link by email (opt-outs are per channel, D1)', () => {
    const smsStop = revokedRow({ channel: 'sms' });
    expect(decisionOf(link({ ...email, automationPausedAt: PAUSED, consent: [smsStop] }))).toEqual({ outcome: 'allow', reasons: [] });
    expect(canContact(link({ automationPausedAt: PAUSED, consent: [smsStop] })).reasons).toEqual(['CONSENT_REVOKED']);
  });

  it('R-PORTAL-11: any other use of the label is gated like `none` (a human, the assistant, marketing, voice, to a user)', () => {
    const cases: Partial<GateInput>[] = [
      { initiator: 'human' },
      { initiator: 'assistant' },
      { purpose: 'marketing' },
      { recipient: { kind: 'contact', addressHmac: H1, channel: 'voice' }, rendered: undefined },
      { recipient: { kind: 'user', addressHmac: H2, channel: 'sms' }, contactPoint: null, consent: [] },
    ];
    for (const c of cases) {
      const i = link({ automationPausedAt: PAUSED, ...c });
      expect(decisionOf(i), JSON.stringify(c)).toEqual(decisionOf({ ...i, category: 'none' }));
    }
    expect(canContact(link({ initiator: 'assistant', automationPausedAt: PAUSED })).reasons).toContain('AUTOMATION_PAUSED');
  });

  it('R-PORTAL-11: decisions carry core-compliance/3.2.0', () => {
    expect(RULES_VERSION).toBe('core-compliance/3.2.0');
    expect(canContact(link()).rulesVersion).toBe('core-compliance/3.2.0');
  });
});

// The equivalence property: for portal_login_link the decision is `none`'s minus AUTOMATION_PAUSED when the clause's
// conditions hold, and exactly `none`'s otherwise.
const inputArb: fc.Arbitrary<GateInput> = fc
  .record({
    initiator: fc.constantFrom('human', 'assistant', 'system') as fc.Arbitrary<GateInput['initiator']>,
    purpose: fc.constantFrom('informational', 'marketing') as fc.Arbitrary<GateInput['purpose']>,
    channel: fc.constantFrom('sms', 'email', 'voice') as fc.Arbitrary<'sms' | 'email' | 'voice'>,
    toUser: fc.boolean(),
    paused: fc.boolean(),
    revoke: fc.constantFrom('none', 'sms', 'email', 'other_phone') as fc.Arbitrary<'none' | 'sms' | 'email' | 'other_phone'>,
    suppress: fc.boolean(),
    dnc: fc.boolean(),
    point: fc.constantFrom('active', 'wrong_number', 'invalid') as fc.Arbitrary<'active' | 'wrong_number' | 'invalid'>,
    payment: fc.boolean(),
    fh: fc.boolean(),
    suspended: fc.boolean(),
  })
  .map((r) =>
    gateInput({
      initiator: r.initiator,
      purpose: r.purpose,
      recipient: r.toUser ? { kind: 'user', addressHmac: H2, channel: r.channel } : { kind: 'contact', addressHmac: H1, channel: r.channel },
      ...(r.channel === 'email' ? { sender: { kind: 'email', registration: 'ready', domainVerified: true } } : {}),
      ...(r.channel === 'voice' ? { rendered: undefined } : { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: r.payment, fairHousingHardMatches: r.fh ? 1 : 0 } }),
      automationPausedAt: r.paused ? PAUSED : null,
      consent: r.revoke === 'none' ? [] : [revokedRow({ channel: r.revoke === 'other_phone' ? 'sms' : r.revoke, addressHmac: r.revoke === 'other_phone' ? H2 : H1, purpose: r.purpose })],
      suppressions: r.suppress ? [{ channel: 'all', reason: 'admin_block', liftedAt: null }] : [],
      personDoNotContact: r.dnc,
      contactPoint: r.toUser ? null : { status: r.point, lineType: 'mobile' },
      tenant: { suspended: r.suspended, brokerageNamePresent: true, postalAddressPresent: true },
    }),
  );

describe('R-PORTAL-11 property: portal_login_link is `none` minus the pause, under exactly the clause', () => {
  it('R-PORTAL-11 property: {outcome, reasons} equals none\'s minus AUTOMATION_PAUSED when the conditions hold, else equals it', () => {
    fc.assert(
      fc.property(inputArb, (base) => {
        const portal = canContact({ ...base, category: 'portal_login_link' });
        const none = canContact({ ...base, category: 'none' });
        const ch = base.recipient.channel;
        const holds = base.initiator === 'system' && base.purpose === 'informational' && (ch === 'sms' || ch === 'email') && base.recipient.kind === 'contact';
        const expected = holds ? none.reasons.filter((r) => r !== 'AUTOMATION_PAUSED') : none.reasons;
        expect(portal.reasons).toEqual(expected);
        expect(portal.outcome).toBe(expected.length > 0 ? 'deny' : 'allow');
      }),
      { numRuns: 3000 },
    );
  });

  it('R-PORTAL-11 property: every D1 opt-out fact still denies the link', () => {
    fc.assert(
      fc.property(inputArb, (base) => {
        const i = { ...base, category: 'portal_login_link' as const };
        expect(canContact({ ...i, personDoNotContact: true }).outcome).toBe('deny');
        expect(canContact({ ...i, suppressions: [{ channel: 'all', reason: 'admin_block', liftedAt: null }] }).outcome).toBe('deny');
        if (base.recipient.kind === 'contact') {
          expect(canContact({ ...i, consent: [revokedRow({ channel: base.recipient.channel, addressHmac: H1, purpose: base.purpose })] }).outcome).toBe('deny');
        }
      }),
      { numRuns: 2000 },
    );
  });
});
