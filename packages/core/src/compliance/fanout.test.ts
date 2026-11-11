// optOutFanout and the DM side of inbound classification (core-compliance/3.0.0; R-CHAN-3, R-CHAN-4, R-CONSENT-7,
// D-OPTOUT-LANG; E73, E74, E76, E155). Every spec it writes must pass the consent_events CHECK mirror.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sequentialIds } from '../foundation/index.js';
import { validateConsentEventSpec } from './consent.js';
import { type FanoutTrigger, type PointFacts, optOutFanout } from './fanout.js';
import { classifyInbound, planInboundEffects } from './inbound.js';
import { H1, H2, H3, NOW, policy } from './testing/fixtures.js';
import { CHANNELS, type Channel, POINT_KINDS, channelsOfKind } from './types.js';

const K = policy().keywords;
const H4 = '4'.repeat(64);
const H5 = '5'.repeat(64);
const phone: PointFacts = { kind: 'phone', hmac: H1, hint: '•••4821' };
const phone2: PointFacts = { kind: 'phone', hmac: H2, hint: '•••0001' };
const mail: PointFacts = { kind: 'email', hmac: H3, hint: 'j•••@x.com' };
const page1: PointFacts = { kind: 'messenger', hmac: H4, hint: 'Messenger' };
const page2: PointFacts = { kind: 'messenger', hmac: H5, hint: 'Messenger' };
const ig: PointFacts = { kind: 'instagram', hmac: '6'.repeat(64), hint: 'Instagram' };
const all = [phone, phone2, mail, page1, page2, ig];
const ctx = (o: Partial<Parameters<typeof optOutFanout>[3]> = {}) => ({ occurredAt: NOW, contactId: 'c-1', messageId: 'm-1', actor: { kind: 'system' } as const, ids: sequentialIds(), ...o });
const pairs = (specs: ReturnType<typeof optOutFanout>) => specs.map((s) => [s.addressHmac, s.channel]);

describe('optOutFanout vectors', () => {
  it('R-CHAN-4 E76 a Messenger keyword revokes Messenger on every Page identity of the contact, nothing else', () => {
    const s = optOutFanout(all, 'keyword', 'messenger', ctx({ matched: 'STOP' }));
    expect(pairs(s)).toEqual([[H4, 'messenger'], [H5, 'messenger']]);
    expect(s.every((e) => e.source === 'inbound_keyword' && !e.needsReview && e.purpose === 'all' && e.eventType === 'revoke')).toBe(true);
    expect(s[0]!.evidence).toEqual({ matched: 'STOP' });
  });
  it('R-CONSENT-7 an SMS keyword revokes texts on every phone; an email keyword only the address that sent it', () => {
    expect(pairs(optOutFanout(all, 'keyword', 'sms', ctx()))).toEqual([[H1, 'sms'], [H2, 'sms']]);
    expect(pairs(optOutFanout(all, 'keyword', 'email', ctx({ inboundHmac: H3 })))).toEqual([[H3, 'email']]);
    expect(optOutFanout(all, 'keyword', 'email', ctx())).toEqual([]);
  });
  it('R-CHAN-3 E74 opt-out language revokes every channel on every point, needs_review, written by the system', () => {
    const s = optOutFanout(all, 'language', 'messenger', ctx());
    expect(pairs(s)).toEqual([[H1, 'sms'], [H1, 'voice'], [H2, 'sms'], [H2, 'voice'], [H3, 'email'], [H4, 'messenger'], [H5, 'messenger'], [ig.hmac, 'instagram']]);
    expect(s.every((e) => e.source === 'inbound_language' && e.needsReview && e.actor.kind === 'system')).toBe(true);
  });
  it('R-CHAN-3 an agent-recorded do-not-contact fans out the same, as that user, with no review', () => {
    const s = optOutFanout(all, 'agent_dnc', 'sms', ctx({ actor: { kind: 'user', userId: 'u-1' }, messageId: null }));
    expect(s).toHaveLength(8);
    expect(s.every((e) => e.source === 'agent_revoke' && !e.needsReview && e.actor.kind === 'user')).toBe(true);
  });
  it('E155 a chat keyword is language (chat has no keyword protocol); from chat the points are the session contact only', () => {
    const chat: PointFacts = { kind: 'web_chat', hmac: H5, hint: 'Website chat' };
    const s = optOutFanout([chat], 'keyword', 'web_chat', ctx());
    expect(pairs(s)).toEqual([[H5, 'web_chat']]);
    expect(s[0]!.needsReview).toBe(true);
  });
  it('calls have no keyword', () => {
    expect(() => optOutFanout(all, 'keyword', 'voice', ctx())).toThrow();
  });
  it('properties: only revokes, deduplicated, deterministic, every spec passes the consent_events CHECK mirror, and language covers every channel of every point', () => {
    const pointArb = fc.record({ kind: fc.constantFrom(...POINT_KINDS), hmac: fc.constantFrom(H1, H2, H3, H4, H5), hint: fc.constant('•••') });
    fc.assert(
      fc.property(fc.array(pointArb, { maxLength: 8 }), fc.constantFrom<FanoutTrigger>('keyword', 'language', 'agent_dnc'), fc.constantFrom(...CHANNELS.filter((c) => c !== 'voice')), (points, trigger, ch: Channel) => {
        const a = optOutFanout(points, trigger, ch, ctx({ inboundHmac: H3 }));
        expect(a).toEqual(optOutFanout(points, trigger, ch, ctx({ inboundHmac: H3 })));
        expect(a.every((e) => e.eventType === 'revoke' && e.level === 'none')).toBe(true);
        expect(new Set(a.map((e) => `${e.channel}:${e.addressHmac}`)).size).toBe(a.length);
        for (const e of a) expect(validateConsentEventSpec(e)).toEqual([]);
        if (trigger !== 'keyword') for (const p of points) for (const c of channelsOfKind(p.kind)) expect(a.some((e) => e.addressHmac === p.hmac && e.channel === c)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('classifyInbound per channel (R-CHAN-4, R-CHAN-3, D-OPTOUT-LANG)', () => {
  it('STOP on Messenger/Instagram is the channel keyword; on chat it is person-scoped language', () => {
    expect(classifyInbound('STOP', K, 'messenger')).toEqual({ kind: 'stop', matched: 'STOP', needsReview: false, scope: 'channel' });
    expect(classifyInbound('stop', K, 'instagram')).toMatchObject({ kind: 'stop', scope: 'channel' });
    expect(classifyInbound('STOP', K, 'web_chat')).toEqual({ kind: 'opt_out_language', matched: 'stop', needsReview: true, scope: 'person' });
  });
  it('E74 "Please stop contacting me" on Messenger is person-scoped language', () => {
    expect(classifyInbound('Please stop contacting me', K, 'messenger')).toMatchObject({ kind: 'opt_out_language', scope: 'person', needsReview: true });
  });
  it('START resubscribes on texts and Meta DMs, never on chat; HELP is ignored on chat', () => {
    expect(classifyInbound('START', K, 'messenger').kind).toBe('start');
    expect(classifyInbound('START', K, 'web_chat').kind).toBe('none');
    expect(classifyInbound('HELP', K, 'web_chat').kind).toBe('none');
    expect(classifyInbound('Stop by at 5?', K, 'messenger').kind).toBe('none');
  });
});

describe('planInboundEffects on the new channels', () => {
  const base = (channel: Channel, body: string) =>
    planInboundEffects({
      classification: classifyInbound(body, K, channel),
      channel,
      address: page1,
      otherPhones: [phone, phone2],
      otherEmails: [mail],
      otherPointsOfKind: [page2],
      occurredAt: NOW,
      contactId: 'c-1',
      messageId: 'm-1',
      policy: { optOutConfirmationSender: 'provider' },
      ids: sequentialIds(),
    });
  it('R-CHAN-4 a Messenger STOP revokes Messenger on both Pages, cancels queued DMs to both, and sends one confirmation', () => {
    const fx = base('messenger', 'STOP');
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel])).toEqual([[H4, 'messenger'], [H5, 'messenger']]);
    expect(fx.cancelQueued).toEqual([{ channel: 'messenger', hmac: H4 }, { channel: 'messenger', hmac: H5 }]);
    expect(fx.reply).toBe('opt_out_confirmation');
    expect(fx.personDoNotContact).toBe(false);
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
  });
  it('E73 an earlier SMS STOP is untouched by a Messenger START (separate channel)', () => {
    const fx = base('messenger', 'START');
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel, e.eventType])).toEqual([[H4, 'messenger', 'resubscribe']]);
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
  });
  it('E74 opt-out language on Messenger flags the person-level do-not-contact and revokes Messenger on both Pages', () => {
    const fx = base('messenger', 'please stop contacting me');
    expect(fx.personDoNotContact).toBe(true);
    expect(fx.consentEvents.filter((e) => e.channel === 'messenger').map((e) => e.addressHmac)).toEqual([H4, H5]);
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
  });
});
