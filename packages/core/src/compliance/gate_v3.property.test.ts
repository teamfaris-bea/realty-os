// core-compliance/3.0.0 property tests (R-GATE-5, R-CHAN-5): determinism and monotonic denial over EVERY input,
// the new ones included (person DNC, connection, Meta window, platform clearance, fair-housing matches), on every
// channel. "Adding a channel never relaxes a deny": every opt-out fact that blocks a text blocks each new channel too.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, instant } from '../foundation/index.js';
import { type GateInput, canContact } from './gate.js';
import { H1, H2, NOW, gateInput, grantRow, revokedRow } from './testing/fixtures.js';
import { CHANNELS, type Channel, PLATFORM_CHANNELS, isPlatformChannel } from './types.js';

const T = (ms: number): Instant => instant(NOW + ms);

const arb: fc.Arbitrary<GateInput> = fc
  .record({
    channel: fc.constantFrom(...CHANNELS),
    initiator: fc.constantFrom('human', 'assistant', 'system') as fc.Arbitrary<GateInput['initiator']>,
    purpose: fc.constantFrom('marketing', 'informational') as fc.Arbitrary<GateInput['purpose']>,
    category: fc.constantFrom('none', 'speed_to_lead_reply', 'nurture_step', 'reminder', 'money', 'opt_out_confirmation', 'help_reply') as fc.Arbitrary<GateInput['category']>,
    granted: fc.boolean(),
    revokeOwn: fc.boolean(),
    revokeOther: fc.boolean(),
    paused: fc.boolean(),
    dnc: fc.boolean(),
    conn: fc.constantFrom('connected', 'degraded', 'other', null) as fc.Arbitrary<'connected' | 'degraded' | 'other' | null>,
    window: fc.option(fc.integer({ min: -7_200_000, max: 7_200_000 }), { nil: undefined }),
    windowNull: fc.boolean(),
    cleared: fc.boolean(),
    fh: fc.integer({ min: 0, max: 2 }),
    keyword: fc.boolean(),
  })
  .map((r) => {
    const ch = r.channel;
    const consent = [
      ...(r.granted ? [grantRow({ channel: ch, purpose: r.purpose })] : []),
      ...(r.revokeOwn ? [revokedRow({ channel: ch, purpose: r.purpose })] : []),
      ...(r.revokeOther ? [revokedRow({ channel: ch, purpose: r.purpose, addressHmac: H2 })] : []),
    ];
    return gateInput({
      recipient: { kind: 'contact', addressHmac: H1, channel: ch },
      initiator: r.initiator,
      purpose: r.purpose,
      category: r.category,
      consent,
      sender: ch === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : isPlatformChannel(ch) ? null : { kind: 'phone', registration: 'ready' },
      ...(ch === 'voice' ? { rendered: undefined } : { rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false, fairHousingHardMatches: r.fh } }),
      ...(r.keyword ? { keywordSenders: [H1] } : {}),
      automationPausedAt: r.paused ? T(-1) : null,
      personDoNotContact: r.dnc,
      connection: r.conn === null ? null : { status: r.conn },
      platformWindow: r.window === undefined ? null : { openUntil: r.windowNull ? null : T(r.window) },
      platformCleared: r.cleared,
    });
  });

type Mut = (i: GateInput) => GateInput;
const MUTATIONS: Record<string, Mut> = {
  personDnc: (i) => ({ ...i, personDoNotContact: true }),
  disconnect: (i) => ({ ...i, connection: null }),
  degradeToOther: (i) => ({ ...i, connection: { status: 'other' } }),
  closeWindow: (i) => ({ ...i, platformWindow: { openUntil: i.now } }),
  forgetWindow: (i) => ({ ...i, platformWindow: null }),
  unclear: (i) => ({ ...i, platformCleared: false }),
  fairHousing: (i) => (i.rendered ? { ...i, rendered: { ...i.rendered, fairHousingHardMatches: (i.rendered.fairHousingHardMatches ?? 0) + 1 } } : i),
  revokeOwn: (i) => ({ ...i, consent: [...i.consent, revokedRow({ channel: i.recipient.channel, purpose: i.purpose })] }),
  revokeOther: (i) => ({ ...i, consent: [...i.consent, revokedRow({ channel: i.recipient.channel, purpose: i.purpose, addressHmac: H2 })] }),
  suppressAll: (i) => ({ ...i, suppressions: [...i.suppressions, { channel: 'all', reason: 'internal_dnc', liftedAt: null }] }),
  suppressChannel: (i) => ({ ...i, suppressions: [...i.suppressions, { channel: i.recipient.channel, reason: 'platform_blocked', liftedAt: null }] }),
  pause: (i) => ({ ...i, automationPausedAt: T(-1) }),
};
const mutationArb = fc.subarray(Object.keys(MUTATIONS), { minLength: 1 });

describe('core-compliance/3.0.0 properties over every channel and every new input', () => {
  it('R-GATE-5 determinism: same input ⇒ same decision and digest; deny ⇔ reasons', () => {
    fc.assert(
      fc.property(arb, (i) => {
        const a = canContact(i);
        expect(canContact({ ...i, consent: i.consent.map((r) => ({ ...r })), suppressions: [...i.suppressions] })).toEqual(a);
        expect(a.outcome === 'deny').toBe(a.reasons.length > 0);
        expect(new Set(a.reasons).size).toBe(a.reasons.length);
      }),
      { numRuns: 1000 },
    );
  });

  it('R-GATE-5 monotonic denial: adding any blocking fact never turns deny into allow and never removes a reason', () => {
    fc.assert(
      fc.property(arb, mutationArb, (i, names) => {
        const before = canContact(i);
        const after = canContact(names.reduce((acc, n) => MUTATIONS[n]!(acc), i));
        if (before.outcome === 'deny') expect(after.outcome).toBe('deny');
        for (const r of before.reasons) expect(after.reasons).toContain(r);
      }),
      { numRuns: 2000 },
    );
  });

  it('each new fact always denies where it applies', () => {
    fc.assert(
      fc.property(arb, (i) => {
        const ch = i.recipient.channel;
        const exempt = i.initiator === 'system' && (i.category === 'opt_out_confirmation' || i.category === 'help_reply') && i.purpose === 'informational' && (ch === 'sms' || ch === 'messenger' || ch === 'instagram') && (i.keywordSenders ?? []).includes(H1);
        if (!exempt) expect(canContact(MUTATIONS.personDnc!(i)).reasons).toContain('PERSON_DO_NOT_CONTACT');
        if (isPlatformChannel(ch)) expect(canContact(MUTATIONS.disconnect!(i)).reasons).toContain('CHANNEL_NOT_CONNECTED');
        if (ch === 'messenger' || ch === 'instagram') {
          expect(canContact(MUTATIONS.closeWindow!(i)).reasons).toContain('PLATFORM_WINDOW_CLOSED');
          expect(canContact(MUTATIONS.unclear!(i)).reasons).toContain('PLATFORM_NOT_CLEARED');
        }
        expect(canContact(MUTATIONS.suppressAll!(i)).outcome).toBe('deny');
      }),
      { numRuns: 1000 },
    );
  });

  it('adding a channel never relaxes a deny: every opt-out fact that blocks a text blocks each new channel', () => {
    const facts: Mut[] = [MUTATIONS.personDnc!, MUTATIONS.revokeOwn!, MUTATIONS.revokeOther!, MUTATIONS.suppressAll!, MUTATIONS.suppressChannel!];
    fc.assert(
      fc.property(arb, fc.constantFrom(...facts), (i, fact) => {
        const on = (ch: Channel): GateInput => ({ ...i, recipient: { ...i.recipient, channel: ch }, consent: i.consent.map((r) => ({ ...r, channel: ch })), sender: isPlatformChannel(ch) ? null : { kind: 'phone', registration: 'ready' }, keywordSenders: [] });
        if (canContact(fact(on('sms'))).outcome === 'deny') for (const ch of PLATFORM_CHANNELS) expect(canContact(fact(on(ch))).outcome).toBe('deny');
      }),
      { numRuns: 1000 },
    );
  });

  it('D1 on the new channels: no consent level is ever needed, only opt-outs and the operational rules block', () => {
    fc.assert(
      fc.property(arb, (i) => {
        const noGrants = { ...i, consent: i.consent.filter((r) => r.status !== 'granted') };
        expect(canContact(noGrants).outcome).toBe(canContact(i).outcome);
      }),
      { numRuns: 1000 },
    );
  });
});
