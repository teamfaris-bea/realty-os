// Google Ads lead forms, adversarial (module 22 scope 7; R-GADS-1, R-GADS-2, R-TEN-3, R-PERM-5): body caps, prototype
// keys, markup / controls / bidi in values, no ids in webhook answers, the key nowhere but the Owner/Admin GET.
// Every payload is synthetic; nothing calls Google.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, freshReauth, leadsWorld } from '../leads/testing.js';
import { GOOGLE_LEAD_BODY_LIMIT, GOOGLE_LEAD_FORM_RESPONSE_SCHEMAS } from './routes.js';
import { type KeyIssued, col, enableGoogleForm, fakeLeadId, googlePayload, postGoogleLead } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let src: string;
let key: string;
const responses: string[] = [];

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'info' });
  w = await leadsWorld(h, { agents: 1, teamLead: true, others: ['admin'] });
  const r = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Google adversarial', kind: 'ads' });
  src = r.body.source.id;
  key = (await enableGoogleForm(h, w.owner, src)).key;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const post = async (body: unknown, o: { raw?: string } = {}) => {
  const r = await postGoogleLead(h, body, o);
  responses.push(r.body);
  return r;
};
const email = () => `adv.${randomUUID().slice(0, 12)}@example.com`;
const contactOf = async (address: string) =>
  (await h.su.query<{ id: string; display_name: string; first_name: string | null; last_name: string | null }>(
    'SELECT c.id, c.display_name, c.first_name, c.last_name FROM contacts c JOIN contact_points p ON p.contact_id = c.id WHERE c.tenant_id = $1 AND lower(p.address) = lower($2)',
    [w.tenantId, address],
  )).rows[0];

describe('R-GADS-2 adversarial bodies', () => {
  it('R-GADS-2: a body over the cap is 413 before anything is resolved or stored', async () => {
    const contacts = (await h.su.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
    const big = googlePayload({ key, columns: [col('FULL_NAME', 'Big Body'), col('EMAIL', email()), col('Q_PAD', 'p'.repeat(GOOGLE_LEAD_BODY_LIMIT))] });
    const r = await post(big);
    expect(r.statusCode).toBe(413);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(contacts);
    // just under the cap is a lead
    const fits = googlePayload({ key, columns: [col('FULL_NAME', 'Fits'), col('EMAIL', email())] });
    const pad = GOOGLE_LEAD_BODY_LIMIT - JSON.stringify(fits).length - 200;
    (fits.user_column_data as unknown[]).push(...Array.from({ length: Math.floor(pad / 3500) }, (_, n) => col(`Q_${n}`, 'q'.repeat(3400))));
    expect((await post(fits)).statusCode).toBe(200);
  });

  it('R-GADS-2: prototype keys never carry a key, a flag or a column, and nothing is polluted', async () => {
    const leadId = fakeLeadId();
    // a key only under __proto__ / constructor is no key
    const onlyProto = `{"lead_id":"${fakeLeadId()}","__proto__":{"google_key":"${key}"},"constructor":{"prototype":{"google_key":"${key}"}},"user_column_data":[]}`;
    expect((await post(null, { raw: onlyProto })).statusCode).toBe(403);
    // is_test under __proto__ is not a test; a column under __proto__ is not read; prototype entries in the array are skipped
    const a = email();
    const raw = `{"lead_id":"${leadId}","google_key":"${key}","__proto__":{"is_test":true,"campaign_id":1},"user_column_data":[{"__proto__":{"column_id":"FULL_NAME","string_value":"Proto Name"}},{"column_id":"__proto__","string_value":"x"},{"column_id":"FULL_NAME","string_value":"Real Name"},{"column_id":"EMAIL","string_value":"${a}"}]}`;
    expect((await post(null, { raw })).statusCode).toBe(200);
    const c = await contactOf(a);
    expect(c?.display_name).toBe('Real Name');
    const i = (await h.su.query('SELECT campaign_ref FROM lead_inquiries WHERE external_id = $1', [`gads:${leadId}`])).rows[0]!;
    expect(i.campaign_ref).toBeNull();
    expect(({} as Record<string, unknown>).google_key).toBeUndefined();
    expect(({} as Record<string, unknown>).is_test).toBeUndefined();
  });

  it('R-GADS-2: markup, controls and bidi characters in values are cleaned or harmless', async () => {
    const a = email();
    const name = '<img src=x onerror=alert(1)>\u202eEvil\u0007\u001b Name\r\nInjected: header\u2066';
    expect((await post(googlePayload({ key, columns: [col('FULL_NAME', name), col('EMAIL', ` ${a}\r\n`), col('PHONE_NUMBER', '+1 (415) 555-\u202e0199\u0085')] }))).statusCode).toBe(200);
    const c = await contactOf(a);
    expect(c).toBeDefined();
    expect(c!.display_name).toBe('<img src=x onerror=alert(1)>Evil Name Injected: header');
    // eslint-disable-next-line no-control-regex
    expect(c!.display_name).not.toMatch(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/);
    const points = (await h.su.query<{ address: string }>('SELECT address FROM contact_points WHERE contact_id = $1', [c!.id])).rows.map((p) => p.address);
    for (const p of points) expect(p).not.toMatch(/[\r\n\u202e]/);
    // a NUL anywhere in the body is refused by the server's JSON parser (422, before the key is even read): nothing stored
    const nul = email();
    expect((await post(googlePayload({ key, columns: [col('FULL_NAME', 'Nul\u0000Name'), col('EMAIL', nul)] }))).statusCode).toBe(422);
    expect(await contactOf(nul)).toBeUndefined();
    // a markup-only "email" is never a point
    const b = email();
    await post(googlePayload({ key, columns: [col('FULL_NAME', 'Markup Mail'), col('EMAIL', `<script>@example.com`), col('EMAIL', b)] }));
    const cb = await contactOf(b);
    const pts = (await h.su.query<{ address: string }>('SELECT address FROM contact_points WHERE contact_id = $1', [cb!.id])).rows.map((p) => p.address);
    expect(pts.some((p) => p.includes('<'))).toBe(false);
  });

  it('R-GADS-2: odd shapes never fail: wrong types everywhere answer 200 {} (unreadable) or 403 (no key), never 5XX', async () => {
    const shapes: unknown[] = [
      { ...googlePayload({ key }), user_column_data: 'nope' },
      { ...googlePayload({ key }), user_column_data: [null, 1, 'x', [], { column_id: 5, string_value: 'x' }, { column_id: 'EMAIL', string_value: { a: 1 } }] },
      { ...googlePayload({ key }), lead_id: { id: 1 } },
      { ...googlePayload({ key }), is_test: 'yes', lead_submit_time: 'not a time', form_id: -1, campaign_id: Number.POSITIVE_INFINITY, gcl_id: 7 },
      { ...googlePayload({ key }), lead_submit_time: '1970-01-01T00:00:00Z' },
    ];
    for (const s of shapes) {
      const r = await post(s);
      expect(r.statusCode, JSON.stringify(s).slice(0, 80)).toBe(200);
      expect(r.body).toBe('{}');
    }
    for (const s of [null, 'string', 42, true, []]) expect((await post(s)).statusCode).toBe(403);
  });
});

describe('R-TEN-3 R-GADS-1 nothing leaks', () => {
  it('R-TEN-3: no webhook response carries a tenant, contact or inquiry id', async () => {
    const a = email();
    responses.push((await post(googlePayload({ key, columns: [col('FULL_NAME', 'Id Check'), col('EMAIL', a)] }))).body);
    const c = await contactOf(a);
    const inquiryIds = (await h.su.query<{ id: string }>('SELECT id FROM lead_inquiries WHERE tenant_id = $1', [w.tenantId])).rows.map((r) => r.id);
    const all = responses.join('\n');
    expect(all).not.toContain(w.tenantId);
    expect(all).not.toContain(c!.id);
    for (const id of inquiryIds) expect(all).not.toContain(id);
    expect(all).not.toContain(src);
    for (const r of responses) expect(r === '{}' || /^\{"error":\{"code":"[A-Z_]+","requestId":"[0-9a-f-]+"\}\}$/.test(r), r).toBe(true);
    for (const [name, schema] of Object.entries(GOOGLE_LEAD_FORM_RESPONSE_SCHEMAS)) {
      expect(JSON.stringify(z.toJSONSchema(schema)), name).not.toMatch(/"confidence|"score|"tenantId|"tenant_id/i);
    }
  });

  it('R-GADS-1: the key is never in logs, errors, audit rows, the webhook_events payload or a webhook response', async () => {
    await freshReauth(h, w.owner);
    const rotated = await call<KeyIssued>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form/rotate`);
    const keys = [key, rotated.body.key];
    key = rotated.body.key;
    await post(googlePayload({ key, columns: [col('FULL_NAME', 'Log Check'), col('EMAIL', email())] }));
    await post(googlePayload({ key, isTest: true }));
    await post(googlePayload({ key, columns: [] }));
    await post(googlePayload({ key: keys[0] })); // retired: 403
    await post(googlePayload({ key: key.toUpperCase() })); // wrong: 403
    await freshReauth(h, w.owner);
    const patched = await call(w.owner, 'PATCH', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'value' });
    expect(patched.status).toBe(200);
    expect(JSON.stringify(patched.body)).not.toContain(key);
    const logs = h.logs.join('\n');
    expect(logs.length).toBeGreaterThan(0);
    const audit = (await h.su.query("SELECT coalesce(changes::text, '') || coalesce(reason, '') AS t FROM audit_log WHERE tenant_id = $1", [w.tenantId])).rows.map((r) => r.t).join('\n');
    const events = (await h.su.query<{ id: string; provider_event_id: string; payload_enc: Buffer | null; error_code: string | null }>("SELECT id, provider_event_id, payload_enc, error_code FROM webhook_events WHERE provider = 'lead'")).rows;
    expect(events.length).toBeGreaterThan(0);
    const payloads = events.map((e) => `${e.provider_event_id} ${e.error_code ?? ''} ${e.payload_enc ? Buffer.from(h.app.platform.envelope.decryptPlatform('webhook', { table: 'webhook_events', column: 'payload_enc', rowId: e.id }, e.payload_enc)).toString('utf8') : ''}`).join('\n');
    expect(payloads).toMatch(/google_lead_form/);
    const hashes = (await h.su.query<{ k: string }>("SELECT encode(key_hash, 'hex') AS k FROM google_lead_form_hooks WHERE tenant_id = $1", [w.tenantId])).rows.map((r) => r.k);
    for (const k of keys) {
      expect(logs).not.toContain(k);
      expect(audit).not.toContain(k);
      expect(payloads).not.toContain(k);
      expect(responses.join('\n')).not.toContain(k);
    }
    for (const hx of hashes) {
      expect(logs).not.toContain(hx);
      expect(payloads).not.toContain(hx);
    }
    // nothing of a lead's content is in the delivery record either
    expect(payloads).not.toMatch(/Log Check|example\.com/);
  });
});

describe('R-PERM-5 the key only for Owner/Admin', () => {
  it('R-PERM-5: GET with the key for Owner and Admin; Agent and Team Lead 404 on every Google form route', async () => {
    const owner = await call<{ key: string | null }>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    const admin = await call<{ key: string | null }>(w.others[0]!, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(owner.body.key).toBe(key);
    expect(admin.body.key).toBe(key);
    for (const c of [w.agents[0]!, w.teamLead!]) {
      await freshReauth(h, c);
      for (const [m, path, body] of [
        ['GET', `/lead-sources/${src}/google-lead-form`, undefined],
        ['POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' }],
        ['POST', `/lead-sources/${src}/google-lead-form/rotate`, undefined],
        ['PATCH', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' }],
        ['POST', `/lead-sources/${src}/google-lead-form/off`, undefined],
      ] as const) {
        const r = await call(c, m, path, body);
        expect(r.status, `${c.role} ${m} ${path}`).toBe(404);
        expect(JSON.stringify(r.body)).not.toContain(key);
      }
    }
    // still on, same key (nothing an agent did changed it)
    expect((await call<{ state: string; key: string }>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`)).body).toMatchObject({ state: 'on', key });
  });

  it('R-TEN-3: another tenant\'s source is 404 on every route and its key never resolves for this tenant', async () => {
    const other = await leadsWorld(h, { agents: 1, rule: false });
    const theirs = await enableGoogleForm(h, other.owner, other.sourceId);
    await freshReauth(h, w.owner);
    for (const [m, path, body] of [
      ['GET', `/lead-sources/${other.sourceId}/google-lead-form`, undefined],
      ['POST', `/lead-sources/${other.sourceId}/google-lead-form`, { inquiryType: 'buy' }],
      ['POST', `/lead-sources/${other.sourceId}/google-lead-form/rotate`, undefined],
      ['PATCH', `/lead-sources/${other.sourceId}/google-lead-form`, { inquiryType: 'buy' }],
      ['POST', `/lead-sources/${other.sourceId}/google-lead-form/off`, undefined],
    ] as const) {
      const r = await call(w.owner, m, path, body);
      expect(r.status, `${m} ${path}`).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(theirs.key);
    }
    const a = email();
    expect((await post(googlePayload({ key: theirs.key, columns: [col('FULL_NAME', 'Theirs'), col('EMAIL', a)] }))).statusCode).toBe(200);
    expect(await contactOf(a)).toBeUndefined(); // landed in the other tenant only
    expect((await h.su.query('SELECT c.tenant_id FROM contacts c JOIN contact_points p ON p.contact_id = c.id WHERE lower(p.address) = lower($1)', [a])).rows.map((r) => r.tenant_id)).toEqual([other.tenantId]);
  });
});
