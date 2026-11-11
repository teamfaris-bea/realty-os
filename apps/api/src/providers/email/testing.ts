// Test support for the SES/SNS and Mailgun webhooks: an in-memory "SNS" that signs messages with a freshly
// generated RSA key and serves a self-signed X.509 certificate for it through an injectable fetch (no
// network, no key material committed). Used by ses.test.ts and providers/sesMailgunWebhooks.test.ts.
import { type KeyObject, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import type { SnsFetch, SnsMessage } from './ses.js';
import { snsStringToSign } from './ses.js';
import { mailgunSignature } from './mailgun.js';

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let x = n; x > 0; x >>= 8) bytes.unshift(x & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, ...content: Buffer[]) => {
  const c = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(c.length), c]);
};
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
const utcTime = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));

/** A self-signed X.509 (v1) certificate for `keys`, as PEM. */
export function selfSignedCert(keys: { publicKey: KeyObject; privateKey: KeyObject }, cn: string, notBefore: Date, notAfter: Date): string {
  const sha256WithRsa = seq(Buffer.from('06092a864886f70d01010b', 'hex'), Buffer.from('0500', 'hex'));
  const name = seq(tlv(0x31, seq(Buffer.from('0603550403', 'hex'), tlv(0x0c, Buffer.from(cn, 'utf8')))));
  const spki = keys.publicKey.export({ type: 'spki', format: 'der' });
  const tbs = seq(tlv(0x02, Buffer.from([0x01])), sha256WithRsa, name, seq(utcTime(notBefore), utcTime(notAfter)), name, spki);
  const sig = sign('sha256', tbs, keys.privateKey);
  const der = seq(tbs, sha256WithRsa, tlv(0x03, Buffer.from([0x00]), sig));
  return `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/(.{64})/g, '$1\n').trim()}\n-----END CERTIFICATE-----\n`;
}

export const SNS_CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-0000000000000000000000.pem';

export class FakeSns {
  readonly keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly pem: string;
  /** every URL fetched, in order */
  readonly fetched: string[] = [];
  /** URLs served (anything else is a 404) */
  readonly served = new Map<string, string>();
  constructor(now = Date.now()) {
    this.pem = selfSignedCert(this.keys, 'sns.amazonaws.com', new Date(now - 86_400_000), new Date(now + 30 * 86_400_000));
    this.served.set(SNS_CERT_URL, this.pem);
  }

  readonly fetch: SnsFetch = async (url) => {
    this.fetched.push(url);
    const body = this.served.get(url) ?? (url.includes('Action=ConfirmSubscription') ? '<ConfirmSubscriptionResponse/>' : undefined);
    return { ok: body !== undefined, status: body !== undefined ? 200 : 404, text: async () => body ?? '' };
  };

  /** A signed SNS message (fields override the defaults; the Signature is always computed over them). */
  message(fields: Partial<SnsMessage> & { Type: SnsMessage['Type']; TopicArn: string }, o: { version?: '1' | '2'; key?: KeyObject } = {}): SnsMessage {
    const m: SnsMessage = {
      MessageId: randomUUID(),
      Message: '{}',
      Timestamp: new Date().toISOString(),
      SignatureVersion: o.version ?? '1',
      Signature: '',
      SigningCertURL: SNS_CERT_URL,
      ...(fields.Type !== 'Notification'
        ? { Token: 'tok' + randomUUID().replace(/-/g, ''), SubscribeURL: `https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&TopicArn=${encodeURIComponent(fields.TopicArn)}&Token=x` }
        : {}),
      ...fields,
    };
    m.Signature = sign(m.SignatureVersion === '1' ? 'sha1' : 'sha256', Buffer.from(snsStringToSign(m), 'utf8'), o.key ?? this.keys.privateKey).toString('base64');
    return m;
  }
}

/** A Mailgun webhook body signed with `key`. */
export function mailgunBody(key: string, eventData: Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000)): Record<string, unknown> {
  const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '').slice(0, 18);
  return { signature: { timestamp: String(timestamp), token, signature: mailgunSignature(key, String(timestamp), token) }, 'event-data': eventData };
}
