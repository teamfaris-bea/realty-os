// D12 (proposed; docs/AI_ISA.md §2.3, §5.4; R-ISA-8): checks 0, 8 and 12 for the AI ISA categories, as properties.
//   - non-interference: for every category OUTSIDE the AI ISA set, the decision ignores `aiIsa` entirely;
//   - D1 first: every opt-out still blocks an AI ISA message, whatever its facts;
//   - monotone: an AI ISA fact only ever adds reasons;
//   - an allowed AI ISA message is inside the window in every zone, within caps, to the bound point, as marketing.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Instant, at, instant, ianaZone, localWindowContains, type LocalTime } from '../foundation/index.js';
import { type GateInput, canContact } from './gate.js';
import { H1, H2, NOW, aiIsaFacts, aiIsaInput, gateInput, grantRow, revokedRow } from './testing/fixtures.js';
import { ACTION_CATEGORIES, AI_ISA_CATEGORIES, type AiIsaGateFacts, AUTONOMOUS_ELIGIBLE, CHANNELS, isPlatformChannel } from './types.js';
import { AI_ISA_REASONS, OPT_OUT_REASONS } from './reasons.js';

const T = (ms: number): Instant => instant(NOW + ms);
const decisionOf = (i: GateInput) => {
  const d = canContact(i);
  // the digest hashes the whole input, so it differs whenever the input does; the decision itself must not
  return { outcome: d.outcome, reasons: d.reasons, explanation: d.explanation, rulesVersion: d.rulesVersion };
};

const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'Bogus/Zone'];

const factsArb: fc.Arbitrary<AiIsaGateFacts> = fc
  .record({
    chain: fc.boolean(),
    paused: fc.boolean(),
    pinned: fc.boolean(),
    epoch: fc.boolean(),
    pause: fc.constantFrom(null, 'client_replied', 'opt_out', 'wrong_number'),
    bound: fc.constantFrom(H1, H2, null),
    channels: fc.subarray(['sms', 'email'] as const),
    media: fc.boolean(),
    missing: fc.subarray(['evidence', 'reply_window', 'dnc'] as const),
    zones: fc.subarray(ZONES, { maxLength: 4 }),
    start: fc.integer({ min: 0, max: 12 }),
    end: fc.integer({ min: 12, max: 24 }),
    initiated: fc.boolean(),
    days: fc.subarray([1, 2, 3, 4, 5, 6, 7]),
    holiday: fc.boolean(),
    ai: fc.integer({ min: 0, max: 4 }),
    auto: fc.integer({ min: 0, max: 4 }),
    i24: fc.integer({ min: 0, max: 2 }),
    i7: fc.integer({ min: 0, max: 4 }),
    gapAgo: fc.option(fc.integer({ min: 0, max: 600 }), { nil: null }),
    shared: fc.boolean(),
    client: fc.boolean(),
    sold: fc.boolean(),
    cleared: fc.boolean(),
  })
  .map((r) =>
    aiIsaFacts({
      chainFailures: r.chain ? ['platform:ai_isa'] : [],
      paused: r.paused,
      pinnedSeqCurrent: r.pinned,
      epochCurrent: r.epoch,
      conversationPauseReason: r.pause,
      boundRecipientHmac: r.bound,
      allowedChannels: r.channels,
      hasMedia: r.media,
      consentMissing: r.missing,
      zones: r.zones,
      windowStartSec: r.start * 3600,
      windowEndSec: r.end * 3600,
      initiated: r.initiated,
      initiatedDays: r.days,
      holidays: r.holiday ? ['2026-11-10'] : [],
      counts: { ai24h: r.ai, automated24h: r.auto, initiated24h: r.i24, initiated7d: r.i7, lastAiOutboundAt: r.gapAgo === null ? null : T(-r.gapAgo * 1000) },
      sharedAddress: r.shared,
      activeClient: r.client,
      soldDerivedFact: r.sold,
      sellerPacksCleared: r.cleared,
    }),
  );

const inputArb: fc.Arbitrary<GateInput> = fc
  .record({
    channel: fc.constantFrom(...CHANNELS),
    initiator: fc.constantFrom('human', 'assistant', 'system') as fc.Arbitrary<GateInput['initiator']>,
    purpose: fc.constantFrom('marketing', 'informational') as fc.Arbitrary<GateInput['purpose']>,
    category: fc.constantFrom(...ACTION_CATEGORIES),
    revoke: fc.boolean(),
    suppress: fc.boolean(),
    dnc: fc.boolean(),
    paused: fc.boolean(),
    keyword: fc.boolean(),
    autonomous: fc.boolean(),
  })
  .map((r) =>
    gateInput({
      recipient: { kind: r.category === 'agent_alert' ? 'user' : 'contact', addressHmac: H1, channel: r.channel },
      initiator: r.initiator,
      purpose: r.purpose,
      category: r.category,
      consent: [grantRow({ channel: r.channel, purpose: r.purpose }), ...(r.revoke ? [revokedRow({ channel: r.channel, purpose: r.purpose })] : [])],
      suppressions: r.suppress ? [{ channel: 'all', reason: 'internal_dnc', liftedAt: null }] : [],
      sender: r.channel === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : isPlatformChannel(r.channel) ? null : { kind: 'phone', registration: 'ready' },
      ...(r.channel === 'voice' ? { rendered: undefined } : {}),
      connection: isPlatformChannel(r.channel) ? { status: 'connected' } : null,
      automationPausedAt: r.paused ? T(-1) : null,
      personDoNotContact: r.dnc,
      ...(r.keyword ? { keywordSenders: [H1] } : {}),
    }),
  );

describe('R-ISA-8 non-interference: checks 0, 8 and 12 never touch a category outside the AI ISA set', () => {
  it('property: canContact(input) equals canContact({...input, aiIsa: anything}) for every non-ISA category', () => {
    fc.assert(
      fc.property(inputArb, factsArb, (input, facts) => {
        fc.pre(!AI_ISA_CATEGORIES.has(input.category));
        expect(decisionOf({ ...input, aiIsa: facts })).toEqual(decisionOf(input));
        expect(canContact({ ...input, aiIsa: facts }).reasons.some((r) => AI_ISA_REASONS.has(r))).toBe(false);
      }),
      { numRuns: 3000 },
    );
  });
  it('the AI ISA categories are never autonomous-eligible (R-AST-20 holds) and never in a policy\'s autonomous set', () => {
    for (const c of AI_ISA_CATEGORIES) expect(AUTONOMOUS_ELIGIBLE.has(c)).toBe(false);
    expect(canContact(aiIsaInput()).reasons).not.toContain('CATEGORY_NOT_AUTONOMOUS');
  });
  it('an AI ISA category with any other initiator, or without facts, is ISA_NOT_AUTHORIZED', () => {
    fc.assert(
      fc.property(fc.constantFrom(...AI_ISA_CATEGORIES), fc.constantFrom('human', 'system') as fc.Arbitrary<GateInput['initiator']>, factsArb, (category, initiator, facts) => {
        expect(canContact(aiIsaInput({ category, initiator }, facts)).reasons).toContain('ISA_NOT_AUTHORIZED');
        expect(canContact(aiIsaInput({ category, aiIsa: undefined })).reasons).toContain('ISA_NOT_AUTHORIZED');
      }),
    );
  });
});

describe('R-ISA-8 R-ISA-31 D1 first: opt-outs block every AI ISA message, whatever its facts', () => {
  it('property: a revoke, a suppression or a person-level do-not-contact always denies with the D1 code', () => {
    fc.assert(
      fc.property(fc.constantFrom(...AI_ISA_CATEGORIES), factsArb, fc.constantFrom('revoke', 'revokeOtherPhone', 'suppress', 'dnc'), fc.boolean(), (category, facts, kind, keyword) => {
        const o: Partial<GateInput> =
          kind === 'revoke'
            ? { consent: [revokedRow({ purpose: 'marketing' })] }
            : kind === 'revokeOtherPhone'
              ? { consent: [revokedRow({ purpose: 'marketing', addressHmac: H2 })] }
              : kind === 'suppress'
                ? { suppressions: [{ channel: 'sms', reason: 'provider_opt_out', liftedAt: null }] }
                : { personDoNotContact: true };
        const d = canContact(aiIsaInput({ category, ...o, ...(keyword ? { keywordSenders: [H1] } : {}) }, facts));
        expect(d.outcome).toBe('deny');
        expect(d.reasons.some((r) => OPT_OUT_REASONS.has(r))).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });
  it('a conversation paused for an opt-out or a wrong number still blocks, even under AI care', () => {
    expect(canContact(aiIsaInput({ automationPausedAt: T(-1) }, { conversationPauseReason: 'opt_out' })).reasons).toContain('AUTOMATION_PAUSED');
    expect(canContact(aiIsaInput({ automationPausedAt: T(-1) }, { conversationPauseReason: 'wrong_number' })).reasons).toContain('AUTOMATION_PAUSED');
    // a client-reply pause is replaced by the assignment's own freshness under AI care
    expect(canContact(aiIsaInput({ automationPausedAt: T(-1) }, { conversationPauseReason: 'client_replied' })).outcome).toBe('allow');
    expect(canContact(aiIsaInput({ automationPausedAt: null }, { conversationPauseReason: 'opt_out' })).outcome).toBe('allow');
  });
});

describe('R-ISA-10 R-ISA-11 check 12: monotone, and an allow is always inside the rails', () => {
  it('property: an allowed AI ISA message is to the bound point, marketing, on an allowed channel, inside the window in every zone, within caps', () => {
    fc.assert(
      fc.property(factsArb, fc.constantFrom('sms', 'email') as fc.Arbitrary<'sms' | 'email'>, fc.integer({ min: -48, max: 48 }), (f, ch, hours) => {
        const now = T(hours * 3_600_000);
        const input = aiIsaInput({ now, recipient: { kind: 'contact', addressHmac: H1, channel: ch }, sender: ch === 'email' ? { kind: 'email', registration: 'ready', domainVerified: true } : { kind: 'phone', registration: 'ready' } }, f);
        const d = canContact(input);
        if (d.outcome !== 'allow') return;
        expect(f.boundRecipientHmac).toBe(H1);
        expect(f.allowedChannels).toContain(ch);
        expect(f.chainFailures).toEqual([]);
        expect(f.consentMissing).toEqual([]);
        expect(f.zones.length).toBeGreaterThan(0);
        for (const z of f.zones) expect(localWindowContains(now, ianaZone(z)!, f.windowStartSec as LocalTime, f.windowEndSec as LocalTime)).toBe(true);
        expect(f.counts.ai24h < f.caps.ai24h && f.counts.automated24h < f.caps.automated24h).toBe(true);
        if (f.counts.lastAiOutboundAt !== null) expect(now - f.counts.lastAiOutboundAt >= f.caps.minGapSeconds * 1000).toBe(true);
        expect(f.sharedAddress || f.activeClient || f.paused || !f.pinnedSeqCurrent || !f.epochCurrent).toBe(false);
        if (f.soldDerivedFact) expect(f.sellerPacksCleared && ch === 'email').toBe(true);
      }),
      { numRuns: 3000 },
    );
  });
  it('property: making any one fact worse never removes a reason', () => {
    const worse: ((f: AiIsaGateFacts) => AiIsaGateFacts)[] = [
      (f) => ({ ...f, chainFailures: ['x'] }),
      (f) => ({ ...f, paused: true }),
      (f) => ({ ...f, pinnedSeqCurrent: false }),
      (f) => ({ ...f, epochCurrent: false }),
      (f) => ({ ...f, boundRecipientHmac: H2 }),
      (f) => ({ ...f, allowedChannels: [] }),
      (f) => ({ ...f, hasMedia: true }),
      (f) => ({ ...f, consentMissing: ['evidence', 'reply_window', 'dnc'] }),
      (f) => ({ ...f, counts: { ...f.counts, ai24h: 99 } }),
      (f) => ({ ...f, sharedAddress: true }),
      (f) => ({ ...f, activeClient: true }),
      (f) => ({ ...f, soldDerivedFact: true, sellerPacksCleared: false }),
    ];
    fc.assert(
      fc.property(factsArb, fc.integer({ min: 0, max: worse.length - 1 }), (f, k) => {
        const a = canContact(aiIsaInput({}, f));
        const b = canContact(aiIsaInput({}, worse[k]!(f)));
        for (const r of a.reasons) expect(b.reasons).toContain(r);
        expect(b.outcome === 'deny' || a.outcome === 'allow').toBe(true);
      }),
      { numRuns: 2000 },
    );
  });
  it('E511 E512 E515 window, days and caps', () => {
    // NOW is Tue 10:00 ET = 07:00 PT: outside 09:00–20:00 Pacific
    expect(canContact(aiIsaInput({}, { zones: ['America/New_York', 'America/Los_Angeles'] })).reasons).toEqual(['ISA_QUIET_HOURS']);
    expect(canContact(aiIsaInput({ now: at('2026-11-10T17:00:00Z') }, { zones: ['America/New_York', 'America/Los_Angeles'] })).outcome).toBe('allow');
    // an initiated message on a refused weekday or a holiday
    expect(canContact(aiIsaInput({}, { initiated: true, initiatedDays: [1] })).reasons).toEqual(['ISA_QUIET_HOURS']);
    expect(canContact(aiIsaInput({}, { initiated: true, holidays: ['2026-11-10'] })).reasons).toEqual(['ISA_QUIET_HOURS']);
    expect(canContact(aiIsaInput({}, { initiated: false, holidays: ['2026-11-10'] })).outcome).toBe('allow');
    expect(canContact(aiIsaInput({}, { windowStartSec: 20 * 3600, windowEndSec: 9 * 3600 })).reasons).toEqual(['ISA_QUIET_HOURS']);
    expect(canContact(aiIsaInput({}, { windowStartSec: 9 * 3600 + 0.5 })).reasons).toEqual(['ISA_QUIET_HOURS']);
    expect(canContact(aiIsaInput({}, { zones: ['Not/AZone'] })).reasons).toEqual(['ISA_ZONE_UNRESOLVED']);
    expect(canContact(aiIsaInput({}, { initiated: true, counts: { ai24h: 0, automated24h: 0, initiated24h: 1, initiated7d: 1, lastAiOutboundAt: null } })).reasons).toEqual(['ISA_CAP_REACHED']);
    expect(canContact(aiIsaInput({}, { initiated: true, counts: { ai24h: 0, automated24h: 0, initiated24h: 0, initiated7d: 3, lastAiOutboundAt: null } })).reasons).toEqual(['ISA_CAP_REACHED']);
    expect(canContact(aiIsaInput({}, { counts: { ai24h: 2, automated24h: 2, initiated24h: 1, initiated7d: 3, lastAiOutboundAt: T(-120_000) } })).outcome).toBe('allow');
    expect(canContact(aiIsaInput({}, { counts: { ai24h: 0, automated24h: 3, initiated24h: 0, initiated7d: 0, lastAiOutboundAt: null } })).reasons).toEqual(['ISA_CAP_REACHED']);
  });
  it('12a/12b/12g: a user recipient, web chat, voice, media, sold facts by SMS', () => {
    expect(canContact(aiIsaInput({ recipient: { kind: 'user', addressHmac: H1, channel: 'sms' } })).reasons).toContain('ISA_UNBOUND_RECIPIENT');
    expect(canContact(aiIsaInput({ recipient: { kind: 'contact', addressHmac: H1, channel: 'web_chat' }, sender: null, connection: { status: 'connected' } })).reasons).toContain('ISA_CHANNEL_NOT_ALLOWED');
    expect(canContact(aiIsaInput({ recipient: { kind: 'contact', addressHmac: H1, channel: 'voice' }, rendered: undefined })).reasons).toEqual(expect.arrayContaining(['AUTOMATED_VOICE_UNAVAILABLE', 'ISA_CHANNEL_NOT_ALLOWED']));
    expect(canContact(aiIsaInput({}, { hasMedia: true })).reasons).toEqual(['ISA_CHANNEL_NOT_ALLOWED']);
    expect(canContact(aiIsaInput({}, { soldDerivedFact: true, sellerPacksCleared: true })).reasons).toEqual(['ISA_CHANNEL_NOT_ALLOWED']);
    expect(canContact(aiIsaInput({}, { boundRecipientHmac: null })).reasons).toEqual(['ISA_UNBOUND_RECIPIENT']);
    expect(canContact(aiIsaInput({ category: 'ai_isa_confirmation' })).outcome).toBe('allow');
    expect(canContact(aiIsaInput({ category: 'ai_isa_holding_line' })).outcome).toBe('allow');
  });
  it('always-human categories stay always-human (R-ISA-23)', () => {
    for (const category of ['money', 'contract', 'novel_message', 'seller_update'] as const) expect(canContact(aiIsaInput({ category })).reasons).toContain('CATEGORY_REQUIRES_HUMAN');
  });
});
