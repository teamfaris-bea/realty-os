// Mailgun webhooks: HMAC-SHA256 signature over timestamp + token (constant time, ±5 minutes) and the
// mapping of event-data to our normalized events.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_TOLERANCE_S } from '../webhooks.js';
import { mailgunSignature, parseMailgunEvent, verifyMailgunSignature } from './mailgun.js';
import { mailgunBody } from './testing.js';

const KEY = 'mailgun-signing-key-0123456789abcdef';
const now = () => Math.floor(Date.now() / 1000);

describe('Mailgun signature', () => {
  it('matches the documented construction: hex HMAC-SHA256(key, timestamp + token)', () => {
    const token = 'a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0';
    expect(mailgunSignature('key', '1529006854', token)).toBe(createHmac('sha256', 'key').update(`1529006854${token}`).digest('hex'));
    expect(mailgunSignature('key', '1', '2')).toBe(mailgunSignature('key', '12', ''));
  });

  it('accepts a correct signature; refuses the wrong key, a tampered token/timestamp, a stale or future timestamp, malformed fields and no key', () => {
    const b = mailgunBody(KEY, { event: 'delivered', id: 'x' });
    expect(verifyMailgunSignature(KEY, b, now(), SIGNATURE_TOLERANCE_S)).toBe(true);
    expect(verifyMailgunSignature('other-key-000000000000', b, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    const s = b.signature as Record<string, string>;
    expect(verifyMailgunSignature(KEY, { ...b, signature: { ...s, token: s.token + 'a' } }, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, { ...b, signature: { ...s, timestamp: String(Number(s.timestamp) + 1) } }, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, mailgunBody(KEY, {}, now() - SIGNATURE_TOLERANCE_S - 5), now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, mailgunBody(KEY, {}, now() + SIGNATURE_TOLERANCE_S + 5), now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, { ...b, signature: { ...s, signature: s.signature!.toUpperCase() } }, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, { 'event-data': {} }, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(undefined, b, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
    expect(verifyMailgunSignature(KEY, null, now(), SIGNATURE_TOLERANCE_S)).toBe(false);
  });
});

describe('Mailgun event-data → normalized events', () => {
  it('maps events; failed/permanent is a bounce, failed/temporary is ignored; rejected is failed; unknown is ignored', () => {
    const p = (e: Record<string, unknown>) => parseMailgunEvent(mailgunBody(KEY, { id: 'ev-1', timestamp: 1_794_300_000.5, 'user-variables': { realty_ref: 'REF' }, ...e }));
    expect(p({ event: 'failed', severity: 'permanent', reason: 'bounce', 'delivery-status': { code: 550, message: '5.1.1 user unknown' } })).toEqual({
      eventId: 'mailgun:ev-1',
      ref: 'REF',
      type: 'bounced',
      occurredAt: new Date(1_794_300_000_500).toISOString(),
      code: 'mailgun:failed:permanent/bounce/550',
    });
    const cases: [Record<string, unknown>, string][] = [
      [{ event: 'failed', severity: 'temporary', reason: 'generic', 'delivery-status': { code: 421 } }, 'ignored'],
      [{ event: 'failed', severity: 'permanent', reason: 'suppress-unsubscribe' }, 'bounced'],
      [{ event: 'complained' }, 'complained'],
      [{ event: 'unsubscribed' }, 'unsubscribed'],
      [{ event: 'delivered' }, 'delivered'],
      [{ event: 'opened' }, 'opened'],
      [{ event: 'clicked' }, 'clicked'],
      [{ event: 'rejected', reject: { reason: 'policy' } }, 'failed'],
      [{ event: 'accepted' }, 'ignored'],
      [{ event: 'stored' }, 'ignored'],
    ];
    for (const [e, type] of cases) expect(p(e)?.type, JSON.stringify(e)).toBe(type);
  });

  it('the event id falls back to the signature token; no ref is null; no event-data is null', () => {
    const b = mailgunBody(KEY, { event: 'delivered' });
    expect(parseMailgunEvent(b)).toMatchObject({ eventId: `mailgun:${(b.signature as { token: string }).token}`, ref: null });
    expect(parseMailgunEvent({ signature: {} })).toBeNull();
    expect(parseMailgunEvent(null)).toBeNull();
  });
});
