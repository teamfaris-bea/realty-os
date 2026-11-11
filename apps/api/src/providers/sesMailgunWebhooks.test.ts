// Amazon SES (via SNS) and Mailgun event webhooks end to end (real Postgres, fake providers, a fake SNS
// that serves a self-signed certificate through the injected fetch: no network):
//   - SES: SNS-signed notifications for an allowed topic feed suppressions and opt-outs exactly like
//     Postmark/SendGrid; a forged signature or another topic is 403 with a tenant-less rejected row; an
//     SNS retry (same MessageId) is a duplicate; SubscriptionConfirmation is confirmed at the SubscribeURL
//   - Mailgun: HMAC-signed webhooks, same effects; a stale timestamp or bad signature is 403
//   - each route answers 404 when its format is not configured
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { EMAIL_REF_HEADER } from '../comms/render.js';
import { type CommsWorld, call, commsWorld, ownedContact } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { snsVerifier } from './email/ses.js';
import { FakeSns, mailgunBody } from './email/testing.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:realty-ses-events';
const OTHER_TOPIC = 'arn:aws:sns:us-east-1:210987654321:someone-elses-topic';
const MAILGUN_KEY = 'mailgun-webhook-signing-key-0123456789';

let h: ApiHarness;
let w: CommsWorld;
const sns = new FakeSns();

beforeAll(async () => {
  snsVerifier.setFetch(sns.fetch);
  h = await createApiHarness({ config: { emailInbound: { formats: ['ses', 'mailgun'], sesSnsTopicArns: [TOPIC], mailgunWebhookSigningKey: MAILGUN_KEY } } });
  w = await commsWorld(h, { agents: 1 });
  h.providers.email.verifiedDomains.add('mail.sesmg.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.sesmg.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@mail.sesmg.test`, displayName: 'Agent', userId: w.agents[0]!.userId, domainId: dom.body.domain.id });
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
});
afterAll(async () => {
  await h?.close();
});

const sendEmail = (c: TestClient, contactId: string) =>
  call<{ result: string; message: { id: string } | null; decision: { reasons: string[] } | null }>(c, 'POST', `/contacts/${contactId}/messages`, { channel: 'email', subject: 'New homes', body: 'Fresh listings for you.', idempotencyKey: `e-${randomUUID()}` });
const refOf = (messageId: string) => h.providers.email.sent.find((m) => m.idempotencyKey === messageId)!.headers![EMAIL_REF_HEADER]!;
const suppression = (email: string, reason: string) =>
  h.su.query('SELECT 1 FROM suppressions WHERE tenant_id = $1 AND reason = $2 AND address_hint LIKE $3 AND lifted_at IS NULL', [w.tenantId, reason, `${email.slice(0, 1)}•••@%`]).then((r) => r.rows.length);
const statusOf = (messageId: string) => h.su.query('SELECT status FROM messages WHERE id = $1', [messageId]).then((r) => r.rows[0]!.status as string);
const rejected = () => h.su.query("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'").then((r) => r.rows[0].n as number);

/** SNS delivers with Content-Type text/plain */
const postSns = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/webhooks/email/ses/events', headers: { 'content-type': 'text/plain; charset=UTF-8', 'x-amz-sns-message-type': String((body as { Type?: string }).Type ?? '') }, payload: JSON.stringify(body) });
const postMailgun = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/webhooks/email/mailgun/events', headers: { 'content-type': 'application/json' }, payload: JSON.stringify(body) });

const sesMail = (ref: string | null, o: Record<string, unknown> = {}) => ({ messageId: `ses-${randomUUID()}`, timestamp: new Date().toISOString(), ...(ref ? { tags: { realty_ref: [ref] } } : {}), ...o });
const sesEvent = (message: Record<string, unknown>, topic = TOPIC) => sns.message({ Type: 'Notification', TopicArn: topic, Message: JSON.stringify(message) }, { version: '2' });

describe('Amazon SES events via SNS feed suppressions and opt-outs (R-CONSENT-9, R-CONSENT-18)', () => {
  it('R-CONSENT-9: an SES permanent bounce suppresses the address; a forged signature or another topic is 403 with a tenant-less rejected row; an SNS retry is a duplicate', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = refOf(sent.body.message!.id);
    const bounce = { eventType: 'Bounce', mail: sesMail(ref), bounce: { bounceType: 'Permanent', bounceSubType: 'General', timestamp: new Date().toISOString(), bouncedRecipients: [{ emailAddress: c.email }] } };
    const before = await rejected();
    const hardBefore = await suppression(c.email, 'hard_bounce');
    const msg = sesEvent(bounce);
    const forged = await postSns({ ...msg, Signature: Buffer.from('x'.repeat(256)).toString('base64') });
    expect(forged.statusCode).toBe(403);
    expect(forged.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect((await postSns({ ...msg, Message: JSON.stringify({ ...bounce, mail: sesMail(ref, { messageId: 'tampered' }) }) })).statusCode).toBe(403);
    // AWS signs every topic's messages: a correctly signed message of a topic we do not list is refused
    expect((await postSns(sesEvent(bounce, OTHER_TOPIC))).statusCode).toBe(403);
    expect(await rejected()).toBe(before + 3);
    const rows = await h.su.query("SELECT tenant_id, payload_enc FROM webhook_events WHERE status = 'rejected' ORDER BY received_at DESC LIMIT 3");
    for (const r of rows.rows) expect(r).toEqual({ tenant_id: null, payload_enc: null });
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore);

    const ok = await postSns(msg);
    expect(ok.statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore + 1);
    expect(await statusOf(sent.body.message!.id)).toBe('bounced');
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('SUPPRESSED');
    // SNS retries the same message (same MessageId and signature): recorded once
    expect((await postSns(msg)).statusCode).toBe(200);
    expect((await h.su.query('SELECT tenant_id FROM webhook_events WHERE provider_event_id = $1', [`event:ses:${msg.MessageId}`])).rows).toEqual([{ tenant_id: w.tenantId }]);
  });

  it('R-CONSENT-9: an SES complaint (ref from the X-Realty-Ref original header) is a never-liftable suppression; a transient bounce changes nothing', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = refOf(sent.body.message!.id);
    const hardBefore = await suppression(c.email, 'hard_bounce');
    const spamBefore = await suppression(c.email, 'spam_complaint');
    const headers = [{ name: 'From', value: 'agent@mail.sesmg.test' }, { name: EMAIL_REF_HEADER, value: ref }];
    const soft = sesEvent({ notificationType: 'Bounce', mail: sesMail(null, { headers }), bounce: { bounceType: 'Transient', bounceSubType: 'MailboxFull', timestamp: new Date().toISOString() } });
    expect((await postSns(soft)).statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore);
    expect(await statusOf(sent.body.message!.id)).not.toBe('bounced');
    const complaint = sesEvent({ notificationType: 'Complaint', mail: sesMail(null, { headers }), complaint: { complaintFeedbackType: 'abuse', timestamp: new Date().toISOString(), complainedRecipients: [{ emailAddress: c.email }] } });
    expect((await postSns(complaint)).statusCode).toBe(200);
    expect(await suppression(c.email, 'spam_complaint')).toBe(spamBefore + 1);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('SUPPRESSED');
  });

  it("R-CONSENT-18: an SES subscription opt-out is the person's opt-out: the next marketing email is denied", async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = refOf(sent.body.message!.id);
    const r = await postSns(sesEvent({ eventType: 'Subscription', mail: sesMail(ref), subscription: { contactList: 'realty', timestamp: new Date().toISOString(), newTopicPreferences: { unsubscribeAll: true } } }));
    expect(r.statusCode).toBe(200);
    expect((await h.su.query("SELECT source, purpose FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).rows).toEqual([{ source: 'provider_report', purpose: 'marketing' }]);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('CONSENT_REVOKED');
  });

  it('a SubscriptionConfirmation for an allowed topic is confirmed by GET to its SubscribeURL; one for another topic is 403 and fetches nothing', async () => {
    const conf = sns.message({ Type: 'SubscriptionConfirmation', TopicArn: TOPIC, Message: 'You have chosen to subscribe to the topic …' });
    const r = await postSns(conf);
    expect(r.statusCode).toBe(200);
    expect(sns.fetched).toContain(conf.SubscribeURL);
    const n = sns.fetched.length;
    const other = sns.message({ Type: 'SubscriptionConfirmation', TopicArn: OTHER_TOPIC, Message: 'x' });
    expect((await postSns(other)).statusCode).toBe(403);
    expect(sns.fetched.slice(n)).not.toContain(other.SubscribeURL);
    // delivery, open and unknown events are accepted; nothing to suppress
    expect((await postSns(sesEvent({ eventType: 'Send', mail: sesMail(null) }))).statusCode).toBe(200);
  });
});

describe('Mailgun events feed suppressions and opt-outs (R-CONSENT-9, R-CONSENT-18)', () => {
  it('R-CONSENT-9: a Mailgun permanent failure suppresses the address; a temporary failure does not; a bad signature or a stale timestamp is 403', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = refOf(sent.body.message!.id);
    const hardBefore = await suppression(c.email, 'hard_bounce');
    const ev = (o: Record<string, unknown>) => ({ id: randomUUID(), timestamp: Date.now() / 1000, recipient: c.email, 'user-variables': { realty_ref: ref }, ...o });
    expect((await postMailgun(mailgunBody(MAILGUN_KEY, ev({ event: 'failed', severity: 'temporary', reason: 'generic', 'delivery-status': { code: 452 } })))).statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore);
    const hard = ev({ event: 'failed', severity: 'permanent', reason: 'bounce', 'delivery-status': { code: 550 } });
    const before = await rejected();
    expect((await postMailgun(mailgunBody('wrong-signing-key-0000000000', hard))).statusCode).toBe(403);
    expect((await postMailgun(mailgunBody(MAILGUN_KEY, hard, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(403);
    expect((await postMailgun({ 'event-data': hard })).statusCode).toBe(403);
    expect(await rejected()).toBe(before + 3);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore);
    expect((await postMailgun(mailgunBody(MAILGUN_KEY, hard))).statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore + 1);
    expect(await statusOf(sent.body.message!.id)).toBe('bounced');
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('SUPPRESSED');
  });

  it("R-CONSENT-9 R-CONSENT-18: a Mailgun complaint is a spam_complaint suppression; a Mailgun unsubscribe is the person's opt-out", async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = refOf(sent.body.message!.id);
    const r = await postMailgun(mailgunBody(MAILGUN_KEY, { event: 'unsubscribed', id: randomUUID(), timestamp: Date.now() / 1000, 'user-variables': { realty_ref: ref } }));
    expect(r.statusCode).toBe(200);
    expect((await h.su.query("SELECT source, purpose FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).rows).toEqual([{ source: 'provider_report', purpose: 'marketing' }]);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('CONSENT_REVOKED');
    const spamBefore = await suppression(c.email, 'spam_complaint');
    expect((await postMailgun(mailgunBody(MAILGUN_KEY, { event: 'complained', id: randomUUID(), timestamp: Date.now() / 1000, 'user-variables': { realty_ref: ref } }))).statusCode).toBe(200);
    expect(await suppression(c.email, 'spam_complaint')).toBe(spamBefore + 1);
  });
});

describe('format switch', () => {
  it('each route answers 404 when its format is not configured (after the signature check)', async () => {
    const saved = h.app.platform.config.emailInbound.formats;
    try {
      (h.app.platform.config.emailInbound as { formats: string[] }).formats = [];
      expect((await postSns(sesEvent({ eventType: 'Send', mail: sesMail(null) }))).statusCode).toBe(404);
      expect((await postMailgun(mailgunBody(MAILGUN_KEY, { event: 'delivered', id: randomUUID() }))).statusCode).toBe(404);
      // unsigned is still 403 first
      expect((await postMailgun({})).statusCode).toBe(403);
    } finally {
      (h.app.platform.config.emailInbound as { formats: string[] }).formats = saved;
    }
  });
});
