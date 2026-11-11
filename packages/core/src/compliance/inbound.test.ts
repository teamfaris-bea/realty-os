import { describe, expect, it } from 'vitest';
import { instant, sequentialIds } from '../foundation/index.js';
import { projectConsent, toConsentEvent, validateConsentEventSpec } from './consent.js';
import { channelsNamed, classifyInbound, normalizeKeyword, planInboundEffects, type InboundClassification } from './inbound.js';
import { H1, H2, H3, NOW, ev, policy } from './testing/fixtures.js';
import { consentKey } from './types.js';

const K = policy().keywords;
const kind = (body: string) => classifyInbound(body, K).kind;

describe('classifyInbound: exact keywords (R-CONSENT-7)', () => {
  it.each(['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit', 'REVOKE', 'optout', 'OPT OUT', 'opt-out', 'Opt Out!'])(
    'R-CONSENT-7 %j is the STOP keyword',
    (b) => {
      expect(classifyInbound(b, K)).toMatchObject({ kind: 'stop', needsReview: false });
    },
  );

  it.each(['stop.', 'Stop 🙏', 'STOP STOP', 'stop!!!', '"STOP"', 'S T O P'.replace(/ /g, ''), 'Stoppp', 'stop stop stop', 'OPT OUT OPT OUT', '🛑 STOP 🛑'])(
    'R-CONSENT-7 E25 normalization makes %j an exact keyword match',
    (b) => {
      expect(classifyInbound(b, K)).toMatchObject({ kind: 'stop', needsReview: false, matched: expect.any(String) });
    },
  );

  it('R-CONSENT-7 reports the canonical keyword it matched', () => {
    expect(classifyInbound('opt-out', K).matched).toBe('OPT OUT');
    expect(classifyInbound('Stopall.', K).matched).toBe('STOPALL');
  });

  it.each(['START', 'unstop', 'Start!'])('R-CONSENT-10 %j is the START keyword', (b) => {
    expect(classifyInbound(b, K)).toMatchObject({ kind: 'start', needsReview: false });
  });

  it.each(['HELP', 'help?', 'Info'])('%j is the HELP keyword', (b) => {
    expect(classifyInbound(b, K)).toMatchObject({ kind: 'help', needsReview: false });
  });

  it('mixed or partial keywords are not exact', () => {
    expect(kind('STOP START')).not.toBe('stop');
    expect(kind('STOP START')).not.toBe('start');
    expect(kind('')).toBe('none');
    expect(kind('🙏')).toBe('none');
    expect(kind('OPT')).toBe('none');
    expect(kind('help me find a house')).toBe('none');
  });

  it('keyword lists come from the policy (pack words count)', () => {
    const k = { ...K, optOut: [...K.optOut, 'ARRÊT'] };
    expect(classifyInbound('arrêt', k).kind).toBe('stop');
    expect(classifyInbound('arrêt', K).kind).toBe('none');
  });

  it('normalizeKeyword strips punctuation and emoji and upper-cases', () => {
    expect(normalizeKeyword('  opt-out!! 🙏 ')).toBe('OPT OUT');
  });
});

describe('classifyInbound: opt-out language and negation (R-CONSENT-8, E24)', () => {
  it.each([
    'Stop by at 5?',
    "Don't stop sending listings!",
    'Dont stop texting me these, they are great',
    'Please do not stop the emails',
    'I want to stop by the open house',
    'Can we stop at the coffee shop first?',
    'Never stop calling me with deals lol',
    "I'll text you when I'm there",
    'Call me tomorrow',
    "Please don't remove me from the list",
    'Thanks!',
  ])('R-CONSENT-8 E24 %j is not an opt-out', (b) => {
    expect(['none'].includes(kind(b))).toBe(true);
  });

  it.each([
    ['Please stop texting me', 'stop texting'],
    ['STOP TEXTING ME', 'stop texting'],
    ['stop all messages', 'stop all messages'],
    ['Can you stop calling me', 'stop calling'],
    ['Why won’t you stop texting me', 'stop texting'],
    ['Do not text me again', 'do not text'],
    ["don't call this number", "don't call"],
    ['Never contact me', 'never contact'],
    ['remove me from your list', 'remove me from'],
    ['Take me off this list please', 'take me off'],
    ['Please remove my number', 'remove my number'],
    ['unsubscribe me', 'unsubscribe me'],
    ['opt me out', 'opt me out'],
    ['lose my number', 'lose my number'],
    ['Leave me alone.', 'leave me alone'],
    ['No more texts please', 'no more texts'],
    ['Stop. Do not text me.', 'do not text'],
  ])('R-CONSENT-8 %j is opt-out language (revoke with needs_review)', (b, matched) => {
    expect(classifyInbound(b, K)).toEqual({ kind: 'opt_out_language', matched, needsReview: true, scope: 'person' });
  });

  it.each([
    ['Wrong number', 'wrong number'],
    ['Sorry, you have the wrong person', 'wrong person'],
    ['this is the wrong #', 'wrong #'],
    ["This isn't the right number for Jane", "isn't the right number"],
  ])('R-CONSENT-11 %j is a wrong-number reply (needs_review)', (b, matched) => {
    expect(classifyInbound(b, K)).toEqual({ kind: 'wrong_number', matched, needsReview: true, scope: 'address' });
  });

  it('a negated wrong-number phrase is not a wrong number', () => {
    expect(kind('It is not the wrong number, this is Jane')).toBe('none');
  });

  it('wrong number wins over opt-out language in the same message', () => {
    expect(kind('Wrong number, stop texting me')).toBe('wrong_number');
  });

  it('channelsNamed maps verbs to channels, defaulting to the inbound channel', () => {
    expect(channelsNamed('do not call', 'sms')).toEqual(['voice']);
    expect(channelsNamed('stop texting', 'email')).toEqual(['sms']);
    expect(channelsNamed('no more emails', 'sms')).toEqual(['email']);
    expect(channelsNamed('stop messages', 'sms')).toEqual(['sms']);
    expect(channelsNamed('remove me from', 'email')).toEqual(['email']);
  });
});

describe('planInboundEffects', () => {
  const addr = { kind: 'phone' as const, hmac: H1, hint: '•••4821' };
  const other = { kind: 'phone' as const, hmac: H2, hint: '•••0001' };
  const email = { kind: 'email' as const, hmac: H3, hint: 'j•••@x.com' };
  const run = (classification: InboundClassification, o: Partial<Parameters<typeof planInboundEffects>[0]> = {}) =>
    planInboundEffects({
      classification,
      channel: 'sms',
      address: addr,
      otherPhones: [other, email, addr],
      occurredAt: NOW,
      contactId: 'c-1',
      messageId: 'm-1',
      policy: { optOutConfirmationSender: 'provider' },
      ids: sequentialIds(),
      ...o,
    });

  it('R-CONSENT-7 STOP revokes SMS (all purposes) for the address and the other phones, cancels their queued SMS, notifies the owner; the provider confirms', () => {
    const fx = run(classifyInbound('STOP', K));
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel, e.purpose, e.eventType, e.source, e.needsReview])).toEqual([
      [H1, 'sms', 'all', 'revoke', 'inbound_keyword', false],
      [H2, 'sms', 'all', 'revoke', 'inbound_keyword', false],
    ]);
    expect(fx.cancelQueuedSmsTo).toEqual([H1, H2]);
    expect(fx.notifyOwner).toBe(true);
    expect(fx.reply).toBe('none');
    expect(fx.markWrongNumber).toBe(false);
    for (const e of fx.consentEvents) {
      expect(validateConsentEventSpec(e)).toEqual([]);
      expect(e).toMatchObject({ evidenceMessageId: 'm-1', actor: { kind: 'system' }, contactId: 'c-1', evidence: { matched: 'STOP' } });
    }
    // the projection of those events is revoked for both phones and both purposes
    const rows = projectConsent(fx.consentEvents.map(toConsentEvent), NOW);
    for (const h of [H1, H2]) for (const p of ['marketing', 'informational'] as const) expect(rows.get(consentKey('sms', p, h))?.status).toBe('revoked');
  });

  it('R-CONSENT-7 exactly one confirmation when the platform (not the provider) sends it', () => {
    expect(run(classifyInbound('stop', K), { policy: { optOutConfirmationSender: 'platform' } }).reply).toBe('opt_out_confirmation');
  });

  it('R-CONSENT-7 STOP in an email reply revokes email for that address only', () => {
    const fx = run(classifyInbound('unsubscribe', K), { channel: 'email', address: email });
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel])).toEqual([[H3, 'email']]);
    expect(fx.cancelQueuedSmsTo).toEqual([]);
    expect(fx.reply).toBe('none');
  });

  it('R-CONSENT-10 START resubscribes the same phones STOP revoked (the address and the contact\'s other phones its STOP revoked)', () => {
    const fx = run(classifyInbound('START', K), { otherPhones: [{ ...other, keywordRevokedBySender: true }, email, addr] });
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.eventType, e.channel])).toEqual([
      [H1, 'resubscribe', 'sms'],
      [H2, 'resubscribe', 'sms'],
    ]);
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
    expect(fx.notifyOwner).toBe(false);
    expect(run(classifyInbound('START', K), { channel: 'email', address: email }).consentEvents).toEqual([]);
  });

  it('R-CONSENT-10 outbound-4: START never lifts another number\'s own STOP (only that number\'s START does)', () => {
    // H2 texted STOP itself (or another number's STOP revoked it): H1's START resubscribes H1 only
    const fx = run(classifyInbound('START', K));
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.eventType])).toEqual([[H1, 'resubscribe']]);
    const rows = projectConsent([...run(classifyInbound('STOP', K), { address: other, otherPhones: [addr] }).consentEvents, ...fx.consentEvents].map(toConsentEvent), NOW);
    expect(rows.get(consentKey('sms', 'informational', H2))?.status).toBe('revoked');
  });

  it('HELP gets one reply only when the platform sends it; never on email', () => {
    expect(run(classifyInbound('HELP', K)).reply).toBe('none');
    expect(run(classifyInbound('HELP', K), { policy: { optOutConfirmationSender: 'platform' } }).reply).toBe('help_reply');
    expect(run(classifyInbound('HELP', K), { channel: 'email', address: email, policy: { optOutConfirmationSender: 'platform' } }).reply).toBe('none');
  });

  it('R-CONSENT-11 a wrong-number reply revokes every channel of the address, marks the point and stops enrollments', () => {
    const fx = run(classifyInbound('wrong number', K));
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel, e.source, e.needsReview])).toEqual([
      [H1, 'sms', 'wrong_number', true],
      [H1, 'voice', 'wrong_number', true],
    ]);
    expect(fx.markWrongNumber).toBe(true);
    expect(fx.cancelQueuedSmsTo).toEqual([H1]);
    expect(fx.notifyOwner).toBe(true);
    const em = run(classifyInbound('wrong person', K), { channel: 'email', address: email });
    expect(em.consentEvents.map((e) => e.channel)).toEqual(['email']);
    expect(em.cancelQueuedSmsTo).toEqual([]);
  });

  it('R-CONSENT-8 opt-out language revokes immediately with needs_review: the inbound channel plus any channel it names', () => {
    const fx = run(classifyInbound("Don't call me", K));
    expect(fx.consentEvents.map((e) => [e.addressHmac, e.channel, e.source, e.needsReview])).toEqual([
      [H1, 'sms', 'inbound_language', true],
      [H2, 'sms', 'inbound_language', true],
      [H1, 'voice', 'inbound_language', true],
      [H2, 'voice', 'inbound_language', true], // "call me" means the person: every phone of the contact
    ]);
    expect(fx.cancelQueuedSmsTo).toEqual([H1, H2]);
    expect(fx.notifyOwner).toBe(true);
    for (const e of fx.consentEvents) expect(validateConsentEventSpec(e)).toEqual([]);
    // by email, "stop texting me" revokes email on the sending address AND SMS on the contact's phones
    const em = run(classifyInbound('please stop texting me', K), { channel: 'email', address: email });
    expect(em.consentEvents.map((e) => [e.addressHmac, e.channel])).toEqual([
      [H2, 'sms'],
      [H1, 'sms'],
      [H3, 'email'],
    ]);
  });

  it('a plain message changes no consent', () => {
    const fx = run(classifyInbound('See you at 5', K));
    expect(fx).toEqual({ consentEvents: [], cancelQueuedSmsTo: [], markWrongNumber: false, notifyOwner: false, reply: 'none', cancelQueued: [], personDoNotContact: false });
    const noMatch = run({ kind: 'opt_out_language', needsReview: true });
    expect(noMatch.consentEvents.map((e) => e.channel)).toEqual(['sms', 'sms']);
    expect(noMatch.consentEvents[0]!.evidence).toEqual({});
  });

  // The STOP-vs-dispatch race itself (E22) is an api/comms two-session test.
  it('R-CONSENT-7 a revoke written by ingestion makes the projection revoked for the next send attempt', () => {
    const prior = [ev({ eventType: 'grant', level: 'express_written', disclosureId: 'd', occurredAt: instant(NOW - 1000) })];
    const fx = run(classifyInbound('STOP', K));
    const rows = projectConsent([...prior, ...fx.consentEvents.map(toConsentEvent)], NOW);
    expect(rows.get(consentKey('sms', 'marketing', H1))?.status).toBe('revoked');
  });
});
