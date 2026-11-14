// b18 item i (owner, 2026-11-14: Resend preferred for inbound email, untested; PHASE2_3_PLAN N24): a Resend inbound
// adapter for lead-email intake. Resend signs webhooks the Standard Webhooks / Svix way: HMAC-SHA256 with the
// `whsec_` secret over `${id}.${timestamp}.${body}`, headers svix-id / svix-timestamp / svix-signature (or webhook-*),
// timestamp within 5 minutes. The parsed email feeds the same lead-email pipeline as Postmark and SendGrid. DKIM trust
// is unchanged: Resend's payload carries no receiving-server verdict this code believes (VERIFY), so every Resend lead
// email is held for review. Fakes only: the secret is generated here, never a real one; no request leaves the process.
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, leadsWorld } from '../leads/testing.js';
import { RESEND_TOLERANCE_S, verifyStandardWebhook } from '../providers/email/resend.js';
import { parseResendLeadEmail } from './formats.js';
import { contactCount, enableInbox, labelledBody, leadAddress, messageRows, outcomeOf } from './testing.js';

const SECRET = `whsec_${randomBytes(24).toString('base64')}`;
const keyOf = (secret: string) => Buffer.from(secret.slice('whsec_'.length), 'base64');
const sign = (secret: string, id: string, ts: number, body: string) => `v1,${createHmac('sha256', keyOf(secret)).update(`${id}.${ts}.${body}`).digest('base64')}`;
const now = () => Math.floor(Date.now() / 1000);

function received(to: string, o: { from?: string; text?: string | null; html?: string | null; id?: string } = {}) {
  return {
    type: 'email.received',
    created_at: new Date().toISOString(),
    data: {
      email_id: o.id ?? randomUUID(),
      created_at: new Date().toISOString(),
      from: o.from ?? 'Zillow <leads@zillow.com>',
      to: [to],
      cc: [],
      bcc: [],
      subject: 'New lead from Zillow',
      message_id: `<${randomUUID()}@zillow.com>`,
      ...(o.text === null ? {} : { text: o.text ?? labelledBody({ name: 'Rae Resend', email: leadAddress() }) }),
      ...(o.html === undefined || o.html === null ? {} : { html: o.html }),
      attachments: [],
    },
  };
}

describe('b18 item i: Standard Webhooks signature (verifyStandardWebhook)', () => {
  const body = JSON.stringify({ type: 'email.received', data: { email_id: 'x' } });
  const headers = (id: string, ts: number, sig: string, prefix: 'svix' | 'webhook' = 'svix') => ({ [`${prefix}-id`]: id, [`${prefix}-timestamp`]: String(ts), [`${prefix}-signature`]: sig });

  it('E726: a signature over id.timestamp.body with the whsec_ key verifies, under the svix-* or the webhook-* header names, and among several signatures', () => {
    const id = `msg_${randomUUID()}`;
    const t = now();
    expect(verifyStandardWebhook(SECRET, headers(id, t, sign(SECRET, id, t, body)), body, t)).toBe(true);
    expect(verifyStandardWebhook(SECRET, headers(id, t, sign(SECRET, id, t, body), 'webhook'), body, t)).toBe(true);
    expect(verifyStandardWebhook(SECRET, headers(id, t, `v1,${randomBytes(32).toString('base64')} ${sign(SECRET, id, t, body)}`), body, t)).toBe(true);
  });

  it('E726: a bad signature, another secret, a changed body or id, another version tag, a missing header, no secret or a secret without whsec_ are refused', () => {
    const id = `msg_${randomUUID()}`;
    const t = now();
    const good = sign(SECRET, id, t, body);
    const other = `whsec_${randomBytes(24).toString('base64')}`;
    expect(verifyStandardWebhook(SECRET, headers(id, t, `v1,${randomBytes(32).toString('base64')}`), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(id, t, sign(other, id, t, body)), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(id, t, good), `${body} `, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(`${id}x`, t, good), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(id, t, good.replace(/^v1,/, 'v2,')), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, { 'svix-id': id, 'svix-signature': good }, body, t)).toBe(false);
    expect(verifyStandardWebhook(undefined, headers(id, t, good), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET.slice('whsec_'.length), headers(id, t, good), body, t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(id, t, good), undefined, t)).toBe(false);
  });

  it('E726: a replay outside the tolerance (older, or too far in the future) is refused even with a valid signature; inside it verifies', () => {
    const id = `msg_${randomUUID()}`;
    const t = now();
    for (const ts of [t - RESEND_TOLERANCE_S - 1, t + RESEND_TOLERANCE_S + 1, t - 86_400]) expect(verifyStandardWebhook(SECRET, headers(id, ts, sign(SECRET, id, ts, body)), body, t), String(ts - t)).toBe(false);
    expect(verifyStandardWebhook(SECRET, headers(id, t - RESEND_TOLERANCE_S + 5, sign(SECRET, id, t - RESEND_TOLERANCE_S + 5, body)), body, t)).toBe(true);
    expect(verifyStandardWebhook(SECRET, headers(id, Number.NaN, good(id, t)), body, t)).toBe(false);
    function good(i: string, ts: number) {
      return sign(SECRET, i, ts, body);
    }
  });
});

describe('b18 item i: the Resend email.received payload (parseResendLeadEmail)', () => {
  it('E726: an email.received event normalizes like the other formats; Resend supplies no DKIM verdict here (held for review: DKIM trust unchanged)', () => {
    const e = received('leads+abc@leads.realty-os.invalid', { html: '<p>Hi</p>' });
    const n = parseResendLeadEmail(e)!;
    expect(n).toMatchObject({ format: 'resend', messageId: `resend:${e.data.email_id}`, from: 'leads@zillow.com', recipients: ['leads+abc@leads.realty-os.invalid'], subject: 'New lead from Zillow', html: '<p>Hi</p>', dkim: [] });
    expect(n.text).toContain('Rae Resend');
  });

  it('E726: a malformed payload is refused (null): not an object, another event type, no data, no email id, no recipient, several From addresses', () => {
    const ok = received('leads+abc@leads.realty-os.invalid');
    for (const bad of [null, 'x', [], {}, { ...ok, type: 'email.sent' }, { type: 'email.received' }, { ...ok, data: { ...ok.data, email_id: '' } }, { ...ok, data: { ...ok.data, to: [] } }, { ...ok, data: { ...ok.data, email_id: 'x'.repeat(301) } }]) {
      expect(parseResendLeadEmail(bad), JSON.stringify(bad)?.slice(0, 80)).toBeNull();
    }
    expect(parseResendLeadEmail({ ...ok, data: { ...ok.data, from: 'a@x.test, b@y.test' } })!.from).toBeNull();
  });
});

describe('b18 item i: POST /webhooks/lead-email/resend/inbound feeds the lead-email pipeline', () => {
  let h: ApiHarness;
  let w: LeadsWorld;
  let addr: string;
  beforeAll(async () => {
    h = await createApiHarness({ config: { emailInbound: { formats: ['resend'], resendWebhookSecret: SECRET }, leadEmail: { inboundDomain: 'leads.realty-os.invalid', authservId: null } } as never });
    w = await leadsWorld(h, { agents: 1 });
    addr = (await enableInbox(h, w.owner, w.sourceId)).address!;
  }, 180_000);
  afterAll(async () => {
    await h?.close();
  });

  const post = (payload: unknown, o: { id?: string; ts?: number; secret?: string; sig?: string } = {}) => {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const id = o.id ?? `msg_${randomUUID()}`;
    const ts = o.ts ?? now();
    return h.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/resend/inbound', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': o.sig ?? sign(o.secret ?? SECRET, id, ts, body) }, payload: body });
  };
  const rejectedRows = async () => Number((await h.su.query<{ n: string }>("SELECT count(*) AS n FROM webhook_events WHERE signature_valid = false")).rows[0]!.n);

  it('E726: a signed email.received reaches the pipeline as a resend lead email and, with no DKIM verdict from Resend, is held for review (DKIM_MISSING); a retry is a duplicate', async () => {
    const n = await contactCount(h, w.tenantId);
    const e = received(addr);
    const first = await post(e);
    expect(first.statusCode).toBe(200);
    expect(outcomeOf(first)).toBe('needs_review');
    const row = (await messageRows(h, w.tenantId)).at(-1)!;
    expect(row.hold_code).toBe('DKIM_MISSING');
    expect((await h.su.query('SELECT provider_format FROM lead_email_messages WHERE id = $1', [row.id])).rows[0]!.provider_format).toBe('resend');
    expect(await contactCount(h, w.tenantId)).toBe(n);
    // the same email delivered again (Resend retries with the same email id) is a duplicate, never a second row
    expect(outcomeOf(await post(e))).toBe('duplicate');
  });

  it('E726: a bad signature is 403 with one rejected, tenant-less row and nothing stored; so is a replay outside the 5-minute tolerance', async () => {
    const before = (await messageRows(h, w.tenantId)).length;
    const r0 = await rejectedRows();
    expect((await post(received(addr), { sig: `v1,${randomBytes(32).toString('base64')}` })).statusCode).toBe(403);
    expect((await post(received(addr), { secret: `whsec_${randomBytes(24).toString('base64')}` })).statusCode).toBe(403);
    expect((await post(received(addr), { ts: now() - RESEND_TOLERANCE_S - 60 })).statusCode).toBe(403);
    expect(await rejectedRows()).toBe(r0 + 3);
    expect((await messageRows(h, w.tenantId)).length).toBe(before);
  });

  it('E726: a validly signed but malformed payload is 422 VALIDATION_FAILED and stores nothing; a recipient that is no inbox is unrouted', async () => {
    const before = (await messageRows(h, w.tenantId)).length;
    for (const bad of [{ type: 'email.received' }, { type: 'email.bounced', data: { email_id: randomUUID() } }, []]) {
      const r = await post(bad);
      expect(r.statusCode, JSON.stringify(bad)).toBe(422);
      expect((r.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
    expect([400, 422]).toContain((await post('{not json')).statusCode);
    expect((await messageRows(h, w.tenantId)).length).toBe(before);
    expect(outcomeOf(await post(received(`leads+${'0'.repeat(40)}@leads.realty-os.invalid`)))).toBe('unrouted');
  });

  it('E726: the route is 404 unless EMAIL_INBOUND_FORMATS names resend', async () => {
    const off = await createApiHarness({ config: { emailInbound: { formats: [] } } as never });
    try {
      const body = JSON.stringify(received('leads+abc@leads.realty-os.invalid'));
      const id = `msg_${randomUUID()}`;
      const ts = now();
      const r = await off.app.inject({ method: 'POST', url: '/api/webhooks/lead-email/resend/inbound', headers: { 'content-type': 'application/json', 'svix-id': id, 'svix-timestamp': String(ts), 'svix-signature': sign(SECRET, id, ts, body) }, payload: body });
      expect([403, 404]).toContain(r.statusCode);
    } finally {
      await off.close();
    }
  });
});
