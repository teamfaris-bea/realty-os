// Amazon SES via SNS: signature verification (both SignatureVersions, AWS's canonical strings), the
// certificate URL and topic allowlists, the timestamp window, subscription confirmation, and the mapping
// of SES notifications to our normalized events. No network: FakeSns serves a self-signed certificate.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SNS_TIMESTAMP_TOLERANCE_S, SnsVerifier, isSnsUrl, parseSesNotification, snsStringToSign } from './ses.js';
import { FakeSns, SNS_CERT_URL } from './testing.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:ses-events';
const OTHER_TOPIC = 'arn:aws:sns:us-east-1:999999999999:attacker-topic';

function setup() {
  const sns = new FakeSns();
  const v = new SnsVerifier(sns.fetch);
  return { sns, v };
}

const notification = (sns: FakeSns, message: unknown, o: Parameters<FakeSns['message']>[1] = {}, extra: Record<string, string> = {}) =>
  sns.message({ Type: 'Notification', TopicArn: TOPIC, Message: JSON.stringify(message), ...extra }, o);

describe('SNS message verification', () => {
  it('the canonical string to sign follows AWS: Notification keys (Subject only when present) and confirmation keys, in order', () => {
    const sns = new FakeSns();
    const n = sns.message({ Type: 'Notification', TopicArn: TOPIC, Message: 'm', MessageId: 'id', Timestamp: 't' });
    expect(snsStringToSign(n)).toBe('Message\nm\nMessageId\nid\nTimestamp\nt\nTopicArn\n' + TOPIC + '\nType\nNotification\n');
    expect(snsStringToSign({ ...n, Subject: 's' })).toBe('Message\nm\nMessageId\nid\nSubject\ns\nTimestamp\nt\nTopicArn\n' + TOPIC + '\nType\nNotification\n');
    const c = sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, Message: 'm', MessageId: 'id', Timestamp: 't', Token: 'k', SubscribeURL: 'u' });
    expect(snsStringToSign(c)).toBe('Message\nm\nMessageId\nid\nSubscribeURL\nu\nTimestamp\nt\nToken\nk\nTopicArn\n' + TOPIC + '\nType\nSubscriptionConfirmation\n');
  });

  it('accepts SignatureVersion 1 (SHA1withRSA) and 2 (SHA256withRSA), with and without a Subject; the certificate is fetched once and cached', async () => {
    const { sns, v } = setup();
    expect(await v.verify(notification(sns, { a: 1 }, { version: '1' }), [TOPIC], Date.now())).toBe(true);
    expect(await v.verify(notification(sns, { a: 2 }, { version: '2' }, { Subject: 'Amazon SES Email Event Notification' }), [TOPIC], Date.now())).toBe(true);
    expect(await v.verify(sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, Message: 'confirm' }), [TOPIC], Date.now())).toBe(true);
    expect(sns.fetched).toEqual([SNS_CERT_URL]);
  });

  it('rejects a tampered field, the wrong key, the wrong version, a topic not on the allowlist, and an unknown Type', async () => {
    const { sns, v } = setup();
    const m = notification(sns, { a: 1 });
    expect(await v.verify({ ...m, Message: '{"a":2}' }, [TOPIC], Date.now())).toBe(false);
    expect(await v.verify({ ...m, Subject: 'added' }, [TOPIC], Date.now())).toBe(false);
    expect(await v.verify({ ...m, SignatureVersion: '2' }, [TOPIC], Date.now())).toBe(false);
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(await v.verify(notification(sns, { a: 1 }, { key: other.privateKey }), [TOPIC], Date.now())).toBe(false);
    // AWS signs messages of any topic: a validly signed message of someone else's topic is refused
    const foreign = sns.message({ Type: 'Notification', TopicArn: OTHER_TOPIC, Message: '{}' });
    expect(await v.verify(foreign, [TOPIC], Date.now())).toBe(false);
    expect(await v.verify(m, [], Date.now())).toBe(false);
    expect(await v.verify(m, undefined, Date.now())).toBe(false);
    expect(await v.verify({ ...m, Type: 'Other' }, [TOPIC], Date.now())).toBe(false);
    expect(await v.verify({ ...m, SignatureVersion: '3' }, [TOPIC], Date.now())).toBe(false);
    expect(await v.verify('not an object', [TOPIC], Date.now())).toBe(false);
  });

  it('fetches the certificate only from https sns.<region>.amazonaws.com(.cn) .pem URLs; anything else is refused without a request', async () => {
    const { sns, v } = setup();
    const bad = [
      'http://sns.us-east-1.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com.evil.example/x.pem',
      'https://evil.example/sns.us-east-1.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com/x.txt',
      'https://sns.us-east-1.amazonaws.com:8443/x.pem',
      'https://user:pw@sns.us-east-1.amazonaws.com/x.pem',
      'https://s3.amazonaws.com/x.pem',
      'https://sns.us-east-1.amazonaws.com/x.pem?y=1',
      'not a url',
    ];
    for (const url of bad) {
      sns.served.set(url, sns.pem);
      expect(await v.verify(sns.message({ Type: 'Notification', TopicArn: TOPIC, SigningCertURL: url }), [TOPIC], Date.now()), url).toBe(false);
    }
    expect(sns.fetched).toEqual([]);
    expect(isSnsUrl('https://sns.cn-north-1.amazonaws.com.cn/SimpleNotificationService-x.pem', true)).toBe(true);
    // an allowed URL that does not serve a certificate fails closed, and is retried next time (not cached)
    const missing = 'https://sns.eu-west-1.amazonaws.com/missing.pem';
    expect(await v.verify(sns.message({ Type: 'Notification', TopicArn: TOPIC, SigningCertURL: missing }), [TOPIC], Date.now())).toBe(false);
    sns.served.set(missing, 'garbage');
    expect(await v.verify(sns.message({ Type: 'Notification', TopicArn: TOPIC, SigningCertURL: missing }), [TOPIC], Date.now())).toBe(false);
    expect(sns.fetched).toEqual([missing, missing]);
  });

  it('timestamp window: up to 1 hour old (SNS retries keep the original Timestamp), at most 30 s in the future; an expired certificate fails', async () => {
    const { sns, v } = setup();
    const now = Date.now();
    const at = (ms: number) => notification(sns, {}, {}, { Timestamp: new Date(ms).toISOString() });
    expect(await v.verify(at(now - (SNS_TIMESTAMP_TOLERANCE_S - 60) * 1000), [TOPIC], now)).toBe(true);
    expect(await v.verify(at(now - (SNS_TIMESTAMP_TOLERANCE_S + 60) * 1000), [TOPIC], now)).toBe(false);
    expect(await v.verify(at(now + 20_000), [TOPIC], now)).toBe(true);
    expect(await v.verify(at(now + 120_000), [TOPIC], now)).toBe(false);
    expect(await v.verify(notification(sns, {}, {}, { Timestamp: 'yesterday' }), [TOPIC], now)).toBe(false);
    // a certificate that expired 10 days ago (the message itself is fresh and correctly signed)
    const old = new FakeSns(now - 40 * 86_400_000);
    expect(await new SnsVerifier(old.fetch).verify(notification(old, {}), [TOPIC], now)).toBe(false);
    expect(await new SnsVerifier(old.fetch).verify(old.message({ Type: 'Notification', TopicArn: TOPIC, Timestamp: new Date(now - 20 * 86_400_000).toISOString() }), [TOPIC], now - 20 * 86_400_000)).toBe(true);
  });

  it('confirms a subscription only for an allowed topic and an https SNS SubscribeURL', async () => {
    const { sns, v } = setup();
    const ok = sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC });
    expect(await v.confirmSubscription(ok, [TOPIC])).toBe(true);
    expect(sns.fetched.at(-1)).toBe(ok.SubscribeURL);
    const n = sns.fetched.length;
    expect(await v.confirmSubscription(sns.message({ Type: 'SubscriptionConfirmation', TopicArn: OTHER_TOPIC }), [TOPIC])).toBe(false);
    expect(await v.confirmSubscription(sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, SubscribeURL: 'https://evil.example/?Action=ConfirmSubscription' }), [TOPIC])).toBe(false);
    expect(await v.confirmSubscription(sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, SubscribeURL: 'http://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription' }), [TOPIC])).toBe(false);
    expect(await v.confirmSubscription(sns.message({ Type: 'Notification', TopicArn: TOPIC }), [TOPIC])).toBe(false);
    expect(sns.fetched.length).toBe(n);
  });
});

describe('SES notifications → normalized events', () => {
  const sns = new FakeSns();
  const mail = (o: Record<string, unknown> = {}) => ({ messageId: 'ses-msg-1', timestamp: '2026-11-10T10:00:00.000Z', tags: { realty_ref: ['REF-FROM-TAG'] }, ...o });
  const parse = (message: Record<string, unknown>) => parseSesNotification(notification(sns, message));

  it('maps event publishing and identity notification types; the event id is the SNS MessageId', () => {
    const m = notification(sns, { eventType: 'Bounce', mail: mail(), bounce: { bounceType: 'Permanent', bounceSubType: 'NoEmail', timestamp: '2026-11-10T10:01:00.000Z', bouncedRecipients: [{ emailAddress: 'a@x.test' }, { emailAddress: 'b@x.test' }] } });
    expect(parseSesNotification(m)).toEqual({ eventId: `ses:${m.MessageId}`, ref: 'REF-FROM-TAG', type: 'bounced', occurredAt: '2026-11-10T10:01:00.000Z', code: 'ses:Bounce:Permanent/NoEmail' });
    const cases: [Record<string, unknown>, string][] = [
      [{ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bounceSubType: 'General' } }, 'bounced'],
      [{ eventType: 'Bounce', bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull' } }, 'ignored'],
      [{ eventType: 'Bounce', bounce: { bounceType: 'Undetermined', bounceSubType: 'Undetermined' } }, 'ignored'],
      [{ eventType: 'Complaint', complaint: { complaintFeedbackType: 'abuse' } }, 'complained'],
      [{ notificationType: 'Complaint', complaint: {} }, 'complained'],
      [{ eventType: 'Delivery', delivery: { timestamp: '2026-11-10T10:00:05.000Z' } }, 'delivered'],
      [{ eventType: 'Open', open: {} }, 'opened'],
      [{ eventType: 'Click', click: {} }, 'clicked'],
      [{ eventType: 'Reject', reject: { reason: 'Bad content' } }, 'failed'],
      [{ eventType: 'Rendering Failure', failure: {} }, 'failed'],
      [{ eventType: 'Subscription', subscription: { newTopicPreferences: { unsubscribeAll: true } } }, 'unsubscribed'],
      [{ eventType: 'Subscription', subscription: { newTopicPreferences: { unsubscribeAll: false, topicSubscriptionStatus: [{ topicName: 'news', subscriptionStatus: 'OptOut' }] } } }, 'unsubscribed'],
      [{ eventType: 'Subscription', subscription: { newTopicPreferences: { unsubscribeAll: false, topicSubscriptionStatus: [{ topicName: 'news', subscriptionStatus: 'OptIn' }] } } }, 'ignored'],
      [{ eventType: 'Send', send: {} }, 'ignored'],
      [{ eventType: 'DeliveryDelay', deliveryDelay: { delayType: 'MailboxFull' } }, 'ignored'],
      [{ eventType: 'SomethingNew' }, 'ignored'],
    ];
    for (const [msg, type] of cases) expect(parse({ mail: mail(), ...msg })?.type, JSON.stringify(msg)).toBe(type);
  });

  it('the ref comes from the realty_ref tag, else the X-Realty-Ref original header; none is null', () => {
    expect(parse({ eventType: 'Delivery', mail: mail({ tags: {}, headers: [{ name: 'From', value: 'a@x' }, { name: 'X-Realty-Ref', value: 'REF-FROM-HEADER' }] }) })?.ref).toBe('REF-FROM-HEADER');
    expect(parse({ eventType: 'Delivery', mail: mail({ tags: { realty_ref: ['T'] }, headers: [{ name: 'x-realty-ref', value: 'H' }] }) })?.ref).toBe('T');
    expect(parse({ eventType: 'Delivery', mail: mail({ tags: undefined }) })?.ref).toBeNull();
  });

  it('a Message that is not an SES notification is null', () => {
    expect(parseSesNotification(notification(sns, { hello: 'world' }))).toBeNull();
    expect(parseSesNotification(sns.message({ Type: 'Notification', TopicArn: TOPIC, Message: 'not json' }))).toBeNull();
    expect(parseSesNotification(sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC }))).toBeNull();
  });
});
