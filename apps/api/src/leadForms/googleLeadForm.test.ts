// Google Ads lead forms (module 22 scope 7; DATA_MODEL R-GADS-1..4, E313–E319, E338, E591–E593) through the real
// server as app_user. Every payload is synthetic (leadForms/testing.ts); nothing calls Google.
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rateKey } from '../auth/tokens.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, freshReauth, jobs, leadsWorld, randomPhone } from '../leads/testing.js';
import { GOOGLE_LEAD_REJECT_LIMIT } from './auth.js';
import { parseGoogleLead } from './google.js';
import { receiveGoogleLead } from './service.js';
import { type KeyIssued, col, enableGoogleForm, fakeLeadId, googlePayload, postGoogleLead } from './testing.js';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, others: ['admin'] });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const newSource = async (name = `Google ${randomUUID().slice(0, 8)}`) => {
  const r = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name, kind: 'ads' });
  if (r.status !== 201) throw new Error(`source: ${r.status}`);
  return r.body.source.id;
};
const email = () => `lead.${randomUUID().slice(0, 12)}@example.com`;
const codeOf = (r: { body: string }) => (JSON.parse(r.body) as { error?: { code?: string } }).error?.code ?? null;
const rejectedRows = async () => (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE provider = 'lead' AND tenant_id IS NULL AND NOT signature_valid")).rows[0]!.n;
const tenantEvents = async () => (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM webhook_events WHERE provider = 'lead' AND tenant_id = $1", [w.tenantId])).rows[0]!.n;
const contactCount = async () => (await h.su.query<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n;
const contactsWith = async (address: string) => (await h.su.query<{ contact_id: string }>('SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND lower(address) = lower($2)', [w.tenantId, address])).rows.map((r) => r.contact_id);
interface InquiryRow {
  id: string;
  contact_id: string;
  outcome: string;
  external_id: string | null;
  inquiry_type: string;
  campaign_ref: string | null;
  ad_ref: string | null;
  source_detail: Record<string, unknown>;
  consent_disclosure_id: string | null;
  postal_code: string | null;
  property_text: string | null;
  received_at: Date;
}
const inquiries = async (sourceId: string) => (await h.su.query<InquiryRow>('SELECT * FROM lead_inquiries WHERE lead_source_id = $1 ORDER BY received_at, id', [sourceId])).rows;
const hookRow = async (sourceId: string) =>
  (await h.su.query<{ id: string; last_test_at: Date | null; last_unreadable_at: Date | null; unreadable_count: number }>('SELECT * FROM google_lead_form_hooks WHERE lead_source_id = $1 AND retired_at IS NULL', [sourceId])).rows[0] ?? null;
const ok = (r: { statusCode: number; body: string }) => {
  expect([r.statusCode, r.body]).toEqual([200, '{}']);
};

describe('R-GADS-1 the key is the only routing input', () => {
  it('R-GADS-1 E315: a wrong, retired, missing, non-string or 300-char key is 403 with a tenant-less rejected row and nothing else', async () => {
    const src = await newSource();
    const first = await enableGoogleForm(h, w.owner, src);
    await freshReauth(h, w.owner);
    const rotated = await call<KeyIssued>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form/rotate`);
    expect(rotated.status).toBe(200);
    ok(await postGoogleLead(h, googlePayload({ key: rotated.body.key })));
    const cases: [string, Record<string, unknown>][] = [
      ['wrong', googlePayload({ key: randomBytes(20).toString('hex') })],
      ['retired', googlePayload({ key: first.key })],
      ['missing', googlePayload({})],
      ['non-string', googlePayload({ key: 1234567890 })],
      ['array', googlePayload({ key: [rotated.body.key] })],
      ['empty', googlePayload({ key: '' })],
      ['300 chars', googlePayload({ key: 'a'.repeat(300) })],
      ['valid key plus 300 chars', googlePayload({ key: rotated.body.key + 'a'.repeat(260) })],
    ];
    for (const [name, body] of cases) {
      const rej = await rejectedRows();
      const events = await tenantEvents();
      const contacts = await contactCount();
      const r = await postGoogleLead(h, body);
      expect([r.statusCode, codeOf(r)], name).toEqual([403, 'WEBHOOK_SIGNATURE_INVALID']);
      expect(await rejectedRows(), name).toBe(rej + 1);
      expect(await tenantEvents(), name).toBe(events);
      expect(await contactCount(), name).toBe(contacts);
      expect(r.body).not.toContain(w.tenantId);
    }
    // a non-JSON-object body is the same refusal
    const arr = await postGoogleLead(h, [googlePayload({ key: rotated.body.key })]);
    expect(arr.statusCode).toBe(403);
  });

  it('R-GADS-1 E591: a lookup that fails is 503 WEBHOOK_UNAVAILABLE with no rejected row; any other guard failure is still 403', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const rej = await rejectedRows();
    await h.su.query('ALTER FUNCTION app.resolve_google_lead_form(bytea) RENAME TO resolve_google_lead_form_e345');
    try {
      const r = await postGoogleLead(h, googlePayload({ key: k.key }));
      expect([r.statusCode, codeOf(r)]).toEqual([503, 'WEBHOOK_UNAVAILABLE']);
      expect(r.body).not.toContain(k.key);
      const wrong = await postGoogleLead(h, googlePayload({ key: randomBytes(20).toString('hex') }));
      expect(wrong.statusCode).toBe(503);
      expect(await rejectedRows()).toBe(rej);
    } finally {
      await h.su.query('ALTER FUNCTION app.resolve_google_lead_form_e345(bytea) RENAME TO resolve_google_lead_form');
    }
    ok(await postGoogleLead(h, googlePayload({ key: k.key })));
    // the rejected-delivery counter failing is not the lookup: still the plain 403 with its row
    await h.su.query('ALTER FUNCTION auth.rate_limit_hit(text, timestamptz, integer) RENAME TO rate_limit_hit_e345');
    try {
      const r = await postGoogleLead(h, googlePayload({ key: randomBytes(20).toString('hex') }));
      expect([r.statusCode, codeOf(r)]).toEqual([403, 'WEBHOOK_SIGNATURE_INVALID']);
      expect(await rejectedRows()).toBe(rej + 1);
    } finally {
      await h.su.query('ALTER FUNCTION auth.rate_limit_hit_e345(text, timestamptz, integer) RENAME TO rate_limit_hit');
    }
  });
});

describe('R-GADS-2 a delivery is one inquiry', () => {
  it('R-GADS-2 E313: the same lead_id twice is one contact; the second is duplicate_ignored; both 200 {}', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const addr = email();
    const body = googlePayload({ key: k.key, columns: [col('FULL_NAME', 'Dana Retry'), col('EMAIL', addr)] });
    ok(await postGoogleLead(h, body));
    ok(await postGoogleLead(h, body));
    expect(await contactsWith(addr)).toHaveLength(1);
    // the intake's own idempotency under the webhook record (a re-armed delivery runs the intake again)
    const hook = (await hookRow(src))!;
    const p = h.app.platform;
    const again = await receiveGoogleLead({ db: p.db, envelope: p.envelope, ids: p.ids, publicBaseUrl: p.config.publicBaseUrl }, { tenantId: w.tenantId, hookId: hook.id, leadSourceId: src }, parseGoogleLead(body));
    expect(again).toBe('duplicate_ignored');
    expect(await contactsWith(addr)).toHaveLength(1);
    const rows = await inquiries(src);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.external_id).toBe(`gads:${body.lead_id as string}`);
  });

  it('R-GADS-2: names, emails, phones, ZIP, refs and source detail as specified; the first response is queued', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src, { inquiryType: 'buy' });
    const addr = email();
    const phone = randomPhone();
    const submit = new Date(Date.now() - 60_000).toISOString();
    const body = googlePayload({
      key: k.key,
      campaignId: 10000000077,
      creativeId: 30000000077,
      adgroupId: 20000000077,
      formId: 40000000077,
      gclId: 'TeSt-gclid-77',
      leadSource: 'LEAD_FORM',
      submitTime: submit,
      columns: [col('FIRST_NAME', 'Jordan'), col('LAST_NAME', 'Sample'), col('WORK_EMAIL', addr), col('PHONE_NUMBER', phone), col('POSTAL_CODE', '94105-1234'), col('STREET_ADDRESS', '1 Example Way')],
    });
    ok(await postGoogleLead(h, body));
    const [i] = await inquiries(src);
    expect(i).toMatchObject({ outcome: 'new_contact', inquiry_type: 'buy', campaign_ref: 'gads:10000000077', ad_ref: 'gads:30000000077', postal_code: '94105-1234', property_text: null });
    expect(i!.source_detail).toEqual({ channel: 'google_lead_form', form_id: '40000000077', google_lead_source: 'LEAD_FORM', gclid: 'TeSt-gclid-77', unread_columns: 1 });
    expect(i!.received_at.toISOString()).toBe(submit);
    const c = (await h.su.query('SELECT display_name, first_name, last_name, original_campaign_ref, original_ad_ref FROM contacts WHERE id = $1', [i!.contact_id])).rows[0]!;
    expect(c).toMatchObject({ display_name: 'Jordan Sample', first_name: 'Jordan', last_name: 'Sample', original_campaign_ref: 'gads:10000000077', original_ad_ref: 'gads:30000000077' });
    expect(await contactsWith(addr)).toEqual([i!.contact_id]);
    expect(await contactsWith(phone)).toEqual([i!.contact_id]);
    const fr = (await jobs(h, w.tenantId, 'assistant.first_response')).filter((j) => j.payload.contactId === i!.contact_id);
    expect(fr).toHaveLength(1);
    // without a creative id, the ad group
    const k2body = googlePayload({ key: k.key, creativeId: null, adgroupId: 20000000088, columns: [col('FULL_NAME', 'Ad Group Only'), col('EMAIL', email())] });
    ok(await postGoogleLead(h, k2body));
    expect((await inquiries(src)).find((x) => x.external_id === `gads:${k2body.lead_id as string}`)!.ad_ref).toBe('gads:20000000088');
  });

  it('R-GADS-2 E316: unknown column ids, custom answers and new top-level fields are ignored and counted; nothing fails', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const addr = email();
    const body = googlePayload({
      key: k.key,
      columns: [
        { column_id: 'FULL_NAME', string_value: 'Casey Custom', column_name: 'Ignored label' },
        col('EMAIL', addr),
        col('COMPANY_NAME', 'Example Co'),
        col('JOB_TITLE', 'Buyer'),
        col('WHEN_ARE_YOU_LOOKING_TO_BUY', 'Within 3 months'),
        col('CITY', 'Exampleville'),
        col('POSTAL_CODE', 'SW1A 1AA'),
        { column_id: 'EMAIL', string_value: 42 },
        { column_name: 'no id', string_value: 'x' } as never,
      ],
      extra: { new_field_2027: { nested: true }, asset_group_id: 99, rmkt: [1, 2] },
    });
    ok(await postGoogleLead(h, body));
    const [i] = await inquiries(src);
    expect(i!.outcome).toBe('new_contact');
    expect(i!.postal_code).toBeNull();
    expect(i!.source_detail.unread_columns).toBe(5);
    expect(JSON.stringify(i!.source_detail)).not.toMatch(/Example Co|Exampleville|3 months/);
  });

  it('R-GADS-2 E318: an id sent as a JSON number above 2^53 is dropped, never rounded; a digit string is kept', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const leadId = fakeLeadId();
    const raw = `{"lead_id":"${leadId}","google_key":"${k.key}","campaign_id":9007199254740993,"creative_id":"9007199254740993","form_id":12345678901234567890,"user_column_data":[{"column_id":"FULL_NAME","string_value":"Big Number"},{"column_id":"EMAIL","string_value":"${email()}"}]}`;
    ok(await postGoogleLead(h, null, { raw }));
    const [i] = await inquiries(src);
    expect(i!.campaign_ref).toBeNull();
    expect(i!.ad_ref).toBe('gads:9007199254740993');
    expect(i!.source_detail.form_id).toBeUndefined();
    expect(JSON.stringify(i)).not.toContain('9007199254740992');
  });

  it('R-GADS-2 E592: values longer than the intake limits are truncated; the lead is created; never a 4XX', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src, { inquiryType: 'sell' });
    const addr = email();
    const body = googlePayload({
      key: k.key,
      gclId: 'g'.repeat(900),
      leadSource: 'L'.repeat(300),
      columns: [col('FULL_NAME', `Long ${'n'.repeat(500)}`), col('EMAIL', addr), col('STREET_ADDRESS', `1 ${'Long '.repeat(400)}Road`), col('PHONE_NUMBER', '1'.repeat(80)), ...Array.from({ length: 150 }, (_, n) => col(`Q_${n}`, 'x'.repeat(300)))],
    });
    ok(await postGoogleLead(h, body));
    const [i] = await inquiries(src);
    expect(i!.outcome).toBe('new_contact');
    expect(i!.property_text!.length).toBeLessThanOrEqual(500);
    expect((i!.source_detail.gclid as string).length).toBe(200);
    expect((i!.source_detail.google_lead_source as string).length).toBeLessThanOrEqual(200);
    expect(i!.source_detail.unread_columns).toBe(96); // 100 columns read: name, email, address used; the over-long phone dropped (a known column)
    const c = (await h.su.query<{ display_name: string }>('SELECT display_name FROM contacts WHERE id = $1', [i!.contact_id])).rows[0]!;
    expect(c.display_name.length).toBeLessThanOrEqual(120);
  });

  it('R-GADS-2: citesSourceDisclosure false ⇒ no disclosure cited and no grant; true ⇒ the source\'s text is cited', async () => {
    const src = await newSource();
    const patch = await call(w.owner, 'PATCH', `/lead-sources/${src}`, { consentDisclosure: { text: 'By submitting you agree that Example Team may contact you.', namesSeller: 'Example Team' } });
    expect(patch.status).toBe(200);
    const disclosure = (await h.su.query<{ consent_disclosure_id: string }>('SELECT consent_disclosure_id FROM lead_sources WHERE id = $1', [src])).rows[0]!.consent_disclosure_id;
    const k = await enableGoogleForm(h, w.owner, src, { citesSourceDisclosure: false });
    const a = email();
    ok(await postGoogleLead(h, googlePayload({ key: k.key, columns: [col('FULL_NAME', 'No Text'), col('EMAIL', a)] })));
    const [ca] = await contactsWith(a);
    const ia = (await inquiries(src)).find((x) => x.contact_id === ca)!;
    expect(ia.consent_disclosure_id).toBeNull();
    expect((await h.su.query("SELECT 1 FROM consent_events WHERE contact_id = $1 AND event_type = 'grant'", [ca])).rows).toHaveLength(0);

    const p = await call<{ citesSourceDisclosure: boolean }>(w.owner, 'PATCH', `/lead-sources/${src}/google-lead-form`, { citesSourceDisclosure: true });
    expect([p.status, p.body.citesSourceDisclosure]).toEqual([200, true]);
    const b = email();
    ok(await postGoogleLead(h, googlePayload({ key: k.key, columns: [col('FULL_NAME', 'With Text'), col('EMAIL', b)] })));
    const [cb] = await contactsWith(b);
    const ib = (await inquiries(src)).find((x) => x.contact_id === cb)!;
    expect(ib.consent_disclosure_id).toBe(disclosure);
    expect((await h.su.query("SELECT 1 FROM consent_events WHERE contact_id = $1 AND event_type = 'grant'", [cb])).rows.length).toBeGreaterThan(0);
    const audits = (await h.su.query("SELECT changes::text AS c FROM audit_log WHERE tenant_id = $1 AND action = 'google_lead_form.changed'", [w.tenantId])).rows;
    expect(audits).toHaveLength(1);
  });

  it('R-GADS-2: a "Home value" form lead becomes a seller contact routed by the source\'s own rule', async () => {
    const src = await newSource();
    const agent = w.agents[1]!;
    await freshReauth(h, w.owner);
    const rule = await call<{ rule: { id: string } }>(w.owner, 'POST', '/routing-rules', { name: `Google value ${src.slice(0, 6)}`, strategy: 'direct', directUserId: agent.userId, match: { sources: [src] } });
    expect(rule.status).toBe(201);
    await h.su.query('UPDATE routing_rules SET position = -10 WHERE id = $1', [rule.body.rule.id]);
    const k = await enableGoogleForm(h, w.owner, src, { inquiryType: 'value' });
    const addr = email();
    ok(await postGoogleLead(h, googlePayload({ key: k.key, columns: [col('FULL_NAME', 'Val Owner'), col('EMAIL', addr), col('STREET_ADDRESS', '9 Example Court')] })));
    const [i] = await inquiries(src);
    expect(i).toMatchObject({ inquiry_type: 'value', property_text: '9 Example Court' });
    const c = (await h.su.query('SELECT intent, offered_to_user_id, ownership_state FROM contacts WHERE id = $1', [i!.contact_id])).rows[0]!;
    expect(c).toMatchObject({ intent: 'seller', offered_to_user_id: agent.userId });
    await h.su.query('UPDATE routing_rules SET enabled = false WHERE id = $1', [rule.body.rule.id]);
  });
});

describe('R-GADS-3 tests and unreadable leads', () => {
  it('R-GADS-3 E314: is_test creates no contact, inquiry or job and records the test time (every time)', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const before = { contacts: await contactCount(), jobs: (await jobs(h, w.tenantId)).length };
    const test = googlePayload({ key: k.key, isTest: true, leadId: 'TeSter-123-ABCDEFGHIJKLMNOPQRSTUVWXYZ-abcdefghijklmnopqrstuvwxyz-0123456789-AaBbCcDdEe' });
    ok(await postGoogleLead(h, test));
    const t1 = (await hookRow(src))!.last_test_at;
    expect(t1).not.toBeNull();
    ok(await postGoogleLead(h, test));
    expect((await hookRow(src))!.last_test_at!.getTime()).toBeGreaterThan(t1!.getTime());
    expect(await contactCount()).toBe(before.contacts);
    expect((await jobs(h, w.tenantId)).length).toBe(before.jobs);
    expect(await inquiries(src)).toHaveLength(0);
    const g = await call<{ lastTestAt: string | null }>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(g.body.lastTestAt).toBe((await hookRow(src))!.last_test_at!.toISOString());
  });

  it('R-GADS-3 E317: no usable lead_id, name, phone or email (incl. only an invalid phone) is 200 {}, nothing stored, counted with its time', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    const contacts = await contactCount();
    const cases: Record<string, unknown>[] = [
      googlePayload({ key: k.key, leadId: null }),
      googlePayload({ key: k.key, leadId: 12.5 }),
      googlePayload({ key: k.key, leadId: 'has spaces in it' }),
      googlePayload({ key: k.key, columns: [] }),
      googlePayload({ key: k.key, columns: [col('PHONE_NUMBER', '123')] }),
      googlePayload({ key: k.key, columns: [col('PHONE_NUMBER', '+1 555 0100'), col('EMAIL', 'not-an-email')] }),
      googlePayload({ key: k.key, columns: [col('FULL_NAME', ' \u200b\u202e '), col('COMPANY_NAME', 'Only Company')] }),
    ];
    for (const [n, body] of cases.entries()) {
      ok(await postGoogleLead(h, body));
      const row = (await hookRow(src))!;
      expect(row.unreadable_count, String(n)).toBe(n + 1);
      expect(row.last_unreadable_at).not.toBeNull();
    }
    // a retry of an unreadable lead is not counted twice
    ok(await postGoogleLead(h, cases[4]!));
    expect((await hookRow(src))!.unreadable_count).toBe(cases.length);
    expect(await contactCount()).toBe(contacts);
    expect(await inquiries(src)).toHaveLength(0);
    // nothing of the content in an audit row or the delivery record
    const audit = (await h.su.query('SELECT changes::text AS c FROM audit_log WHERE tenant_id = $1', [w.tenantId])).rows.map((r) => r.c).join('\n');
    expect(audit).not.toMatch(/Only Company|not-an-email/);
    const g = await call<{ unreadableCount: number; lastUnreadableAt: string | null }>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(g.body).toMatchObject({ unreadableCount: cases.length, lastUnreadableAt: (await hookRow(src))!.last_unreadable_at!.toISOString() });
  });
});

describe('R-GADS-4 turning on, rotating, turning off', () => {
  it('R-GADS-4: GET shows the state, URL and key; turn-on twice is ALREADY_ON with the state and no key; audited without the key', async () => {
    const src = await newSource();
    const off = await call<Record<string, unknown>>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(off.body).toEqual({
      state: 'off',
      webhookUrl: 'https://api.test.invalid/api/webhooks/google-ads/lead-form',
      key: null,
      createdAt: null,
      inquiryType: null,
      citesSourceDisclosure: null,
      lastTestAt: null,
      lastLeadAt: null,
      lastUnreadableAt: null,
      unreadableCount: 0,
      sourceHasConsentText: false,
    });
    const k = await enableGoogleForm(h, w.owner, src, { inquiryType: 'sell', citesSourceDisclosure: true });
    expect(k.key).toMatch(/^[0-9a-f]{40}$/);
    expect(k.webhookUrl).toBe('https://api.test.invalid/api/webhooks/google-ads/lead-form');
    const on = await call<Record<string, unknown>>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(on.body).toMatchObject({ state: 'on', key: k.key, createdAt: k.createdAt, inquiryType: 'sell', citesSourceDisclosure: true });
    await freshReauth(h, w.owner);
    const again = await call<{ error: { details: { googleLeadForm: Record<string, unknown> } } }>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' });
    expect([again.status, again.code]).toEqual([409, 'GOOGLE_LEAD_FORM_ALREADY_ON']);
    expect(JSON.stringify(again.body)).not.toContain(k.key);
    ok(await postGoogleLead(h, googlePayload({ key: k.key, columns: [col('FULL_NAME', 'Last Lead'), col('EMAIL', email())] })));
    const after = await call<{ lastLeadAt: string | null }>(w.owner, 'GET', `/lead-sources/${src}/google-lead-form`);
    expect(after.body.lastLeadAt).not.toBeNull();
    const audits = (await h.su.query("SELECT action, changes::text AS c FROM audit_log WHERE tenant_id = $1 AND action LIKE 'google_lead_form.%'", [w.tenantId])).rows;
    expect(audits.some((a) => a.action === 'google_lead_form.enabled')).toBe(true);
    for (const a of audits) expect(a.c).not.toContain(k.key);
  });

  it('R-GADS-4: 🔒 turn-on needs a fresh re-authentication; a not-https deployment is not_available; an off source is LEAD_SOURCE_OFF', async () => {
    const src = await newSource();
    await h.su.query('UPDATE sessions SET reauthenticated_at = NULL WHERE user_id = $1', [w.owner.userId]);
    const stale = await call(w.owner, 'POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' });
    expect([stale.status, stale.code]).toEqual([401, 'REAUTH_REQUIRED']);
    await freshReauth(h, w.owner);
    await call(w.owner, 'POST', `/lead-sources/${src}/off`);
    const offSrc = await call(w.owner, 'POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' });
    expect([offSrc.status, offSrc.code]).toEqual([409, 'LEAD_SOURCE_OFF']);
    await call(w.owner, 'POST', `/lead-sources/${src}/on`);
  });

  it('R-GADS-4 E339: without a public https address the state is not_available and turn-on is refused', async () => {
    const h2 = await createApiHarness({ config: { publicBaseUrl: 'http://localhost:3000' } });
    try {
      const w2 = await leadsWorld(h2, { agents: 1, rule: false });
      const g = await call<{ state: string; webhookUrl: string | null }>(w2.owner, 'GET', `/lead-sources/${w2.sourceId}/google-lead-form`);
      expect(g.body).toMatchObject({ state: 'not_available', webhookUrl: null });
      await freshReauth(h2, w2.owner);
      const r = await call(w2.owner, 'POST', `/lead-sources/${w2.sourceId}/google-lead-form`, { inquiryType: 'buy' });
      expect([r.status, r.code]).toEqual([409, 'GOOGLE_LEAD_FORM_NOT_AVAILABLE']);
    } finally {
      await h2.close();
    }
  }, 120_000);

  it('R-GADS-4 E319: source off ⇒ 403; on again ⇒ the same key works; form off ⇒ the key is retired forever', async () => {
    const src = await newSource();
    const k = await enableGoogleForm(h, w.owner, src);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/lead-sources/${src}/off`)).status).toBe(200);
    const r = await postGoogleLead(h, googlePayload({ key: k.key }));
    expect(r.statusCode).toBe(403);
    expect((await call(w.owner, 'POST', `/lead-sources/${src}/on`)).status).toBe(200);
    ok(await postGoogleLead(h, googlePayload({ key: k.key })));
    const off = await call<{ state: string; key: string | null }>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form/off`);
    expect([off.status, off.body.state, off.body.key]).toEqual([200, 'off', null]);
    expect((await postGoogleLead(h, googlePayload({ key: k.key }))).statusCode).toBe(403);
    const k2 = await enableGoogleForm(h, w.owner, src);
    expect(k2.key).not.toBe(k.key);
    expect((await postGoogleLead(h, googlePayload({ key: k.key }))).statusCode).toBe(403);
    ok(await postGoogleLead(h, googlePayload({ key: k2.key })));
    // a retired row takes no writes, ever
    await expect(h.su.query('UPDATE google_lead_form_hooks SET retired_at = NULL WHERE lead_source_id = $1 AND retired_at IS NOT NULL', [src])).rejects.toThrow(/GOOGLE_LEAD_FORM_RETIRED/);
    expect((await h.su.query("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'google_lead_form.disabled'", [w.tenantId])).rows.length).toBeGreaterThan(0);
  });

  it('R-GADS-4 E338: two rotations at once both answer 200; only the later-committed key resolves', async () => {
    const src = await newSource();
    await enableGoogleForm(h, w.owner, src);
    const admin = w.others[0]!;
    await freshReauth(h, w.owner);
    await freshReauth(h, admin);
    const [a, b] = await Promise.all([
      call<KeyIssued>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form/rotate`),
      call<KeyIssued>(admin, 'POST', `/lead-sources/${src}/google-lead-form/rotate`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const [first, later] = Date.parse(a.body.createdAt) <= Date.parse(b.body.createdAt) ? [a, b] : [b, a];
    expect(first.body.key).not.toBe(later.body.key);
    ok(await postGoogleLead(h, googlePayload({ key: later.body.key })));
    expect((await postGoogleLead(h, googlePayload({ key: first.body.key }))).statusCode).toBe(403);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'google_lead_form.key_rotated' AND changes::text LIKE '%' || $2 || '%'", [w.tenantId, src])).rows[0]!.n).toBe(2);
  });

  it('R-GADS-4 E593: two turn-ons at once ⇒ one 200 with the key, one 409 ALREADY_ON with the state; never a 500', async () => {
    const src = await newSource();
    const admin = w.others[0]!;
    await freshReauth(h, w.owner);
    await freshReauth(h, admin);
    const rs = await Promise.all([
      call<KeyIssued>(w.owner, 'POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'buy' }),
      call<KeyIssued>(admin, 'POST', `/lead-sources/${src}/google-lead-form`, { inquiryType: 'sell' }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = rs.find((r) => r.status === 409)!;
    expect(loser.code).toBe('GOOGLE_LEAD_FORM_ALREADY_ON');
    expect((loser.body as unknown as { error: { details: { googleLeadForm: { state: string; key: null } } } }).error.details.googleLeadForm).toMatchObject({ state: 'on', key: null });
  });
});

describe('R-GADS-1 limiters', () => {
  it('R-GADS-1: a rejected IP is counted and limited; a valid key from that IP is never refused (nor by the global limiter)', async () => {
    const h2 = await createApiHarness({ config: { globalRateLimitPerMinute: 10 }, logLevel: 'warn' });
    try {
      const w2 = await leadsWorld(h2, { agents: 1 });
      const k = await enableGoogleForm(h2, w2.owner, w2.sourceId);
      const ip = '198.51.100.77';
      for (let n = 0; n <= GOOGLE_LEAD_REJECT_LIMIT.max; n++) expect((await postGoogleLead(h2, googlePayload({ key: randomBytes(20).toString('hex') }), { ip })).statusCode).toBe(403);
      // the same 403 over the limit, with a warning line (no key, no IP)
      const over = await postGoogleLead(h2, googlePayload({ key: randomBytes(20).toString('hex') }), { ip });
      expect([over.statusCode, codeOf(over)]).toEqual([403, 'WEBHOOK_SIGNATURE_INVALID']);
      const windowStart = Math.floor(Date.now() / 1000 / GOOGLE_LEAD_REJECT_LIMIT.windowSeconds) * GOOGLE_LEAD_REJECT_LIMIT.windowSeconds;
      const count = (await h2.su.query<{ count: number }>('SELECT count FROM auth_attempts WHERE key = $1 AND window_start = to_timestamp($2)', [rateKey(h2.config.sessionSecret, GOOGLE_LEAD_REJECT_LIMIT.kind, ip), windowStart])).rows[0]?.count;
      expect(count).toBeGreaterThan(GOOGLE_LEAD_REJECT_LIMIT.max);
      expect(h2.logs.join('\n')).toContain('GOOGLE_LEAD_KEY_REJECTS_LIMITED');
      // valid deliveries from the limited IP, beyond the global per-minute budget: all 200, and never counted
      for (let n = 0; n < 15; n++) ok(await postGoogleLead(h2, googlePayload({ key: k.key, columns: [col('FULL_NAME', `Burst ${n}`), col('EMAIL', email())] }), { ip }));
      const after = (await h2.su.query<{ count: number }>('SELECT count FROM auth_attempts WHERE key = $1 AND window_start = to_timestamp($2)', [rateKey(h2.config.sessionSecret, GOOGLE_LEAD_REJECT_LIMIT.kind, ip), windowStart])).rows[0]?.count;
      expect(after).toBe(count);
    } finally {
      await h2.close();
    }
  }, 120_000);
});
