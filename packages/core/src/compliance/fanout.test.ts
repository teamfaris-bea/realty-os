// optOutFanout and the chat side of inbound classification (core-compliance/3.0.0; R-CHAN-3, R-CONSENT-7, D-OPTOUT-LANG;
// E155). Messenger/Instagram DMs are out of scope (owner scope change D2). Every spec written must pass the
// consent_events CHECK mirror.
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
const chat1: PointFacts = { kind: 'web_chat', hmac: H4, hint: 'Website chat' };
const chat2: PointFacts = { kind: 'web_chat', hmac: H5, hint: 'Website chat' };
const all = [phone, phone2, mail, chat1, chat2];
const ctx = (o: Partial<Parameters<typeof optOutFanout>[3]> = {}) => ({ occurredAt: NOW, contactId: 'c-1', messageId: 'm-1', actor: { kind: 'system' } as const, ids: sequentialIds(), ...o });
const pairs = (specs: ReturnType<typeof optOutFanout>) => specs.map((s) => [s.addressHmac, s.channel]);

describe('optOutFanout vectors', () => {
  it('R-CONSENT-7 an SMS keyword revokes texts on every phone; an email keyword only the address that sent it', () => {
    const s = optOutFanout(all, 'keyword', 'sms', ctx({ matched: 'STOP' }));
    expect(pairs(s)).toEqual([[H1, 'sms'], [H2, 'sms']]);
    expect(s.every((e) => e.source === 'inbound_keyword' && !e.needsReview && e.purpose === 'all' && e.eventType === 'revoke')).toBe(true);
    expect(s[0]!.evidence).toEqual({ matched: 'STOP' });
    expect(pairs(optOutFanout(all, 'keyword', 'email', ctx({ inboundHmac: H3 })))).toEqual([[H3, 'email']]);
    expect(optOutFanout(all, 'keyword', 'email', ctx())).toEqual([]);
  });
  it('R-CHAN-3 opt-out language revokes every channel on every point, needs_review, written by the system', () => {
    const s = optOutFanout(all, 'language', 'web_chat', ctx());
    expect(pairs(s)).toEqual([[H1, 'sms'], [H1, 'voice'], [H2, 'sms'], [H2, 'voice'], [H3, 'email'], [H4, 'web_chat'], [H5, 'web_chat']]);
    expect(s.every((e) => e.source === 'inbound_language' && e.needsReview && e.actor.kind === 'system')).toBe(true);
  });
  it('R-CHAN-3 an agent-recorded do-not-contact fans out the same, as that user, with no review', () => {
    const s = optOutFanout(all, 'agent_dnc', 'sms', ctx({ actor: { kind: 'user', userId: 'u-1' }, messageId: null }));
    expect(s).toHaveLength(7);
    expect(s.every((e) => e.source === 'agent_revoke' && !e.needsReview && e.actor.kind === 'user')).toBe(true);
  });
  it('E155 a chat keyword is language (chat has no keyword protocol); from chat the points are the session contact only', () => {
    const s = optOutFanout([chat2], 'keyword', 'web_chat', ctx());
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

describe('classifyInbound on website chat (R-CHAN-3, D-OPTOUT-LANG)', () => {
  it('E155 STOP on chat is person-scoped language; texts keep the keyword', () => {
    expect(classifyInbound('STOP', K, 'web_chat')).toEqual({ kind: 'opt_out_language', matched: 'stop', needsReview: true, scope: 'person' });
    expect(classifyInbound('STOP', K, 'sms')).toEqual({ kind: 'stop', matched: 'STOP', needsReview: false, scope: 'channel' });
    expect(classifyInbound('Please stop contacting me', K, 'web_chat')).toMatchObject({ kind: 'opt_out_language', scope: 'person', needsReview: true });
  });
  it('START and HELP mean nothing on chat; ordinary chat is not an opt-out', () => {
    expect(classifyInbound('START', K, 'web_chat').kind).toBe('none');
    expect(classifyInbound('HELP', K, 'web_chat').kind).toBe('none');
    expect(classifyInbound('Stop by at 5?', K, 'web_chat').kind).toBe('none');
  });
});

describe('planInboundEffects on website chat', () => {
  const run = (body: string) =>
    planInboundEffects({
      classification: classifyInbound(body, K, 'web_chat'),
      channel: 'web_chat',
      address: chat1,
      otherPhones: [],
      otherEmails: [],
      otherPointsOfKind: [chat2],
      occurredAt: NOW,
      contactId: 'c-session',
      messageId: 'm-1',
      policy: { optOutConfirmationSender: 'provider' },
      ids: sequentialIds(),
    });
  it('E155 "stop contacting me" in chat flags the person-level do-not-contact of the session contact and revokes chat on its identities', () => {
    const fx = run('stop contacting me');
    expect(fx.personDoNotContact).toBe(true);
    expect(fx.consentEvents.filter((e) => e.channel === 'web_chat').map((e) => e.addressHmac)).toEqual([H4, H5]);
    expect(fx.cancelQueued).toEqual(expect.arrayContaining([{ channel: 'web_chat', hmac: H4 }]));
    expect(fx.reply).toBe('none');
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
  });
  it('a plain chat message changes nothing', () => {
    expect(run('Is the house still available?')).toMatchObject({ consentEvents: [], personDoNotContact: false, cancelQueued: [] });
  });
});
