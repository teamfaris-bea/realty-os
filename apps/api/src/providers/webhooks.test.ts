// Webhook signature verification; acceptance: "webhook signature failures write no tenant rows".
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { routeModules } from '../routes.js';
import type { RouteModule } from '../routes.js';
import { SIGNATURE_TOLERANCE_S, signedHeader, telephonySignature } from './webhooks.js';

const handled: string[] = [];
const hooks: RouteModule = {
  name: 'webhook-probe',
  async register(app: FastifyInstance) {
    for (const provider of ['telephony', 'email', 'lead'] as const) {
      app.post(`/webhooks/test/${provider}`, { config: { auth: 'webhook', webhookProvider: provider } }, async () => {
        handled.push(provider);
        return { ok: true };
      });
    }
  },
};

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness({ routeModules: [...routeModules, hooks] });
  await h.signup(); // a tenant with data, so "no tenant rows written" is meaningful
});
afterAll(async () => {
  await h?.close();
});

async function tenantRowCounts(): Promise<Record<string, number>> {
  const tables = await h.su.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'webhook_events' ORDER BY 1",
  );
  const out: Record<string, number> = {};
  for (const { table_name } of tables.rows) out[table_name] = (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${table_name}"`)).rows[0]!.n;
  return out;
}

const form = (params: Record<string, string>) => new URLSearchParams(params).toString();

describe('webhook signatures', () => {
  it('a bad or missing signature is 403, writes no tenant rows, and leaves only a rejected, tenant-less, payload-less webhook_events row', async () => {
    const before = await tenantRowCounts();
    // every table (tenant tables and the global ones: users, sessions, auth_events, ...)
    expect(Object.keys(before).length).toBeGreaterThanOrEqual(93); // 94 tables minus webhook_events
    const eventsBefore = (await h.su.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n as number;
    const params = { MessageSid: 'SM1', From: '+18435550100', To: '+18435550001', Body: 'STOP' };
    const attempts = [
      h.app.inject({ method: 'POST', url: '/api/webhooks/test/telephony', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: form(params) }),
      h.app.inject({ method: 'POST', url: '/api/webhooks/test/telephony', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature('wrong-secret-0000000', 'https://api.test.invalid/api/webhooks/test/telephony', params) }, payload: form(params) }),
      h.app.inject({ method: 'POST', url: '/api/webhooks/test/email', headers: { 'content-type': 'application/json', 'x-realty-signature': 't=1,v1=' + '0'.repeat(64) }, payload: '{"to":"r+abc@in.test"}' }),
      h.app.inject({ method: 'POST', url: '/api/webhooks/test/lead', headers: { 'content-type': 'application/json' }, payload: '{"name":"Pat"}' }),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    }
    expect(handled).toEqual([]);
    expect(await tenantRowCounts()).toEqual(before);
    const ev = await h.su.query<{ provider: string; tenant_id: string | null; status: string; signature_valid: boolean; payload_enc: Buffer | null }>(
      'SELECT provider, tenant_id, status, signature_valid, payload_enc FROM webhook_events ORDER BY received_at',
    );
    expect(ev.rows.length - eventsBefore).toBe(4);
    for (const e of ev.rows) expect(e).toMatchObject({ tenant_id: null, status: 'rejected', signature_valid: false, payload_enc: null });
  });

  it('a valid Twilio-shaped signature (full URL + sorted params, HMAC-SHA1) passes; changing any parameter breaks it', async () => {
    const secret = h.config.webhookSecrets.telephony;
    const url = 'https://api.test.invalid/api/webhooks/test/telephony';
    const params = { MessageSid: 'SM2', From: '+18435550100', To: '+18435550001', Body: 'Yes please' };
    const ok = await h.app.inject({ method: 'POST', url: '/api/webhooks/test/telephony', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(secret, url, params) }, payload: form(params) });
    expect(ok.statusCode).toBe(200);
    expect(handled).toEqual(['telephony']);
    const tampered = await h.app.inject({
      method: 'POST',
      url: '/api/webhooks/test/telephony',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(secret, url, params) },
      payload: form({ ...params, Body: 'No' }),
    });
    expect(tampered.statusCode).toBe(403);
    // order-independent: Twilio signs sorted keys
    expect(telephonySignature(secret, url, { b: '2', a: '1' })).toBe(telephonySignature(secret, url, { a: '1', b: '2' }));
  });

  it('email/lead signatures bind the raw body and a timestamp within ±5 minutes (replay window); no Origin/CSRF needed', async () => {
    const secret = h.config.webhookSecrets.lead;
    const raw = '{"name":"Pat Lead","phone":"+18435550100"}';
    const now = Math.floor(Date.now() / 1000);
    const send = (header: string, body = raw) => h.app.inject({ method: 'POST', url: '/api/webhooks/test/lead', headers: { 'content-type': 'application/json', 'x-realty-signature': header }, payload: body });
    expect((await send(signedHeader(secret, now, raw))).statusCode).toBe(200);
    expect((await send(signedHeader(secret, now, raw), raw.replace('Pat', 'Pam'))).statusCode).toBe(403);
    expect((await send(signedHeader(secret, now - SIGNATURE_TOLERANCE_S - 5, raw))).statusCode).toBe(403);
    expect((await send(signedHeader(h.config.webhookSecrets.email, now, raw))).statusCode).toBe(403); // another provider's secret
    expect(handled.filter((p) => p === 'lead')).toHaveLength(1);
  });
});
