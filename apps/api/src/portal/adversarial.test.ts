// Module 45 adversarial tests (critical module duty, PHASE2_3_PLAN :240): tenancy, opt-outs (R-PAR-12 included), the
// assistant's autonomy and the portal's own risk rules, attacked through the real routes. Fakes only.
import { randomBytes, randomUUID } from 'node:crypto';
import { canContact } from '@realty/core/compliance';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { csrfTokenFor } from '../auth/tokens.js';
import { PortalClient, askLink, call, client, deal, invite, json, lastToken, portalWorld, publish, setPortalCleared, sharedDocument, signIn, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let wb: PortalWorld;
let slug: string;
let slugB: string;
let n = 0;
const ip = () => `198.18.0.${(++n % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  wb = await portalWorld(h);
  slug = await slugOf(h, w.tenantId);
  slugB = await slugOf(h, wb.tenantId);
  await setPortalCleared(h, true);
}, 240_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

async function signedIn(world = w, s = slug) {
  const a = world.agents[0]!;
  const c = await client(a, { firstName: 'Ada' });
  const d = await deal(a, c.id);
  const inv = await invite(a, d, c.id);
  const doc = await sharedDocument(h, world, a, d);
  const itemId = (await publish(a, 'document', doc.id, [inv.body.grant.id])).body.results[0]!.itemId!;
  const pc = await signIn(h, s, c.email, new PortalClient(h, ip()));
  return { a, c, d, grantId: inv.body.grant.id, accountId: inv.body.account.id, itemId, pc };
}

describe('adversarial: tenancy and the boundary (R-PORTAL-8, R-PORTAL-9, R-TEN-14, E126, E148)', () => {
  it('E126: tenant B\'s team slug with tenant A\'s client address sends nothing; B\'s staff cannot invite onto A\'s deal or read its portal', async () => {
    const s = await signedIn();
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'`);
    const before = lastToken(h, s.c.email);
    expect((await askLink(h, slugB, s.c.email, ip())).statusCode).toBe(202);
    expect(lastToken(h, s.c.email)).toBe(before);
    expect((await invite(wb.owner, s.d, s.c.id)).status).toBe(404);
    expect((await call(wb.owner, 'GET', `/deals/${s.d}/portal`)).status).toBe(404);
    expect((await call(wb.owner, 'GET', `/portal-grants/${s.grantId}/preview`)).status).toBe(404);
    expect((await call(wb.owner, 'POST', `/portal-items/${s.itemId}/retract`)).status).toBe(404);
    expect((await call(wb.owner, 'POST', `/portal-accounts/${s.accountId}/disable`, { reason: 'WRONG_PERSON' })).status).toBe(404);
  });

  it('R-PORTAL-9: a forged, truncated, oversized or staff cookie never resolves a client session', async () => {
    const s = await signedIn();
    for (const cookie of [`__Host-psid=${randomBytes(32).toString('base64url')}`, `__Host-psid=${s.pc.cookie!.slice(0, 20)}`, `__Host-psid=${'A'.repeat(4000)}`, `psid=${s.pc.cookie}`, `__Host-sid=${w.agents[0]!.cookie}`]) {
      const r = await new PortalClient(h, ip()).get('/api/portal/me', { cookie });
      expect(r.statusCode, cookie.slice(0, 30)).toBe(401);
    }
  });

  it('E148: a client with its portal cookie and its own CSRF token gets nothing from staff routes', async () => {
    const s = await signedIn();
    for (const [method, url] of [['GET', `/api/deals/${s.d}/portal`], ['POST', `/api/portal-grants/${s.grantId}/revoke`], ['POST', '/api/portal-items']] as const) {
      const r = await s.pc.request(method, url, method === 'POST' ? {} : undefined);
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('E647: a staff session\'s CSRF token, or the portal token of another session, never passes the portal check', async () => {
    const s = await signedIn();
    const t = await signedIn();
    const sid = (await h.su.query<{ id: string }>(`SELECT id FROM portal_sessions WHERE portal_account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [s.accountId])).rows[0]!.id;
    for (const csrf of [csrfTokenFor(h.config.sessionSecret, sid), t.pc.csrf!]) {
      expect((await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`, {}, { csrf })).statusCode).toBe(403);
    }
  });

  it('E648 E649: non-canonical ids, another account\'s item and another account\'s stream token are 404', async () => {
    const s = await signedIn();
    const t = await signedIn();
    for (const id of [s.itemId.toUpperCase(), `${s.itemId} `, `${s.itemId}%00`, '../../etc/passwd', t.itemId]) {
      expect((await s.pc.post(`/api/portal/documents/${encodeURIComponent(id)}/stream-token`)).statusCode, id).toBe(404);
    }
    const theirs = json<{ url: string }>(await t.pc.post(`/api/portal/documents/${t.itemId}/stream-token`)).url;
    expect((await s.pc.get(theirs)).statusCode).toBe(404);
    expect((await s.pc.get(`/api/portal/files/${'A'.repeat(43)}`)).statusCode).toBe(404);
    expect([404, 414]).toContain((await s.pc.get(`/api/portal/files/${'A'.repeat(500)}`)).statusCode); // too long for the router: refused before any route
    expect((await t.pc.get(theirs)).statusCode).toBe(200);
  });

  it('R-PORTAL-12: the client cannot exceed its stream-token budget (30 a minute per session)', async () => {
    const s = await signedIn();
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`)).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 200)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe('adversarial: opt-outs and autonomy (D1, R-PAR-12, R-GATE-14, R-PORTAL-11)', () => {
  it('R-PAR-12: a STOP on another of the client\'s phones, removed but not as a wrong number, still blocks a link by text; nothing reaches the provider', async () => {
    const a = w.agents[0]!;
    const c = await client(a, { firstName: 'Par' });
    const other = '+1415555' + String(1000 + Math.floor(Math.random() * 8999));
    const add = await call(a, 'PATCH', `/contacts/${c.id}`, { phones: [c.phone, other] });
    const otherPoint = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2`, [c.id, other])).rows[0]?.id;
    if (add.status !== 200 || !otherPoint) {
      // fall back to a superuser fixture for the second phone (the point's HMAC is not read by this test)
      await h.su.query(`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES ($1, $2, $3, 'phone', $4, $5)`, [w.tenantId, randomUUID(), c.id, other, randomBytes(32)]);
    }
    const op = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2`, [c.id, other])).rows[0]!.id;
    expect((await call(a, 'POST', `/contacts/${c.id}/consent`, { kind: 'revoke', pointId: op, channel: 'sms', purpose: 'all', evidence: { note: 'STOP from the other phone' } })).status).toBe(200);
    await h.su.query(`UPDATE contact_points SET status = 'removed', removed_at = now(), removed_reason = 'old' WHERE id = $1`, [op]);
    const d = await deal(a, c.id);
    const loginPhone = (await h.su.query<{ id: string }>(`SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2`, [c.id, c.phone])).rows[0]!.id;
    expect((await invite(a, d, c.id, { loginPointId: loginPhone })).status).toBe(200);
    const sms = h.providers.telephony.sms.length;
    expect((await askLink(h, slug, c.phone, ip())).statusCode).toBe(202);
    expect(h.providers.telephony.sms.length).toBe(sms);
    const m = await h.su.query<{ status: string }>(`SELECT status FROM messages WHERE contact_id = $1 AND action_category = 'portal_login_link'`, [c.id]);
    expect(m.rows.map((r) => r.status)).toEqual(['blocked']);
  });

  it('R-PORTAL-11: the label never frees the assistant or a person from the pause, and never skips an opt-out (core gate)', () => {
    const base = {
      now: Date.now() as never,
      recipient: { kind: 'contact' as const, addressHmac: '1'.repeat(64), channel: 'sms' as const },
      purpose: 'informational' as const,
      category: 'portal_login_link' as const,
      consent: [],
      suppressions: [],
      contactPoint: { status: 'active' as const, lineType: 'mobile' as const },
      automationPausedAt: (Date.now() - 1000) as never,
      sender: { kind: 'phone' as const, registration: 'ready' as const },
      tenant: { suspended: false, brokerageNamePresent: true, postalAddressPresent: true },
      rendered: { containsBrokerageName: true, containsOptOutHint: true, paymentInstructions: false },
      policy: { version: { policyId: 'p', packs: {} }, autonomous: new Set(['nurture_step']), recordingMode: 'announce_all', keywords: { optOut: ['STOP'], resubscribe: ['START'], help: ['HELP'] }, inquiryBasisDays: 90, recordingEnabled: true, optOutConfirmationSender: 'provider', unreviewedPacks: [] } as never,
      personDoNotContact: false,
      connection: null,
    };
    expect(canContact({ ...base, initiator: 'system' }).outcome).toBe('allow');
    expect(canContact({ ...base, initiator: 'assistant' }).reasons).toContain('AUTOMATION_PAUSED');
    expect(canContact({ ...base, initiator: 'system', personDoNotContact: true }).reasons).toEqual(['PERSON_DO_NOT_CONTACT']);
    expect(canContact({ ...base, initiator: 'system', purpose: 'marketing' }).reasons).toContain('AUTOMATION_PAUSED');
  });
});

describe('adversarial: copy and headers (R-PORTAL-18, R-PORTAL-17)', () => {
  it('R-PORTAL-18: a title with a header injection, a control character or over 120 characters is refused; the stored copy stays clean', async () => {
    const s = await signedIn();
    for (const title of ['Home\r\nSet-Cookie: x=1', 'Bell\u0007', 'x'.repeat(121)]) {
      expect((await call(s.a, 'PATCH', `/portal-grants/${s.grantId}/display`, { title })).status, JSON.stringify(title)).toBe(422);
      const c2 = await client(s.a);
      const d2 = await deal(s.a, c2.id);
      expect((await invite(s.a, d2, c2.id, { title })).status).toBe(422);
    }
    const me = await s.pc.get('/api/portal/me');
    expect(me.body).not.toMatch(/Set-Cookie|\\u0007/);
  });

  it('R-PORTAL-17: a document whose name tries to break the header downloads as a safe attachment', async () => {
    const s = await signedIn();
    const doc = await sharedDocument(h, w, s.a, s.d, 'x".pdf; filename=evil.html');
    const itemId = (await publish(s.a, 'document', doc.id, [s.grantId])).body.results[0]!.itemId!;
    const url = json<{ url: string }>(await s.pc.post(`/api/portal/documents/${itemId}/stream-token`)).url;
    const dl = await s.pc.get(url);
    expect(dl.statusCode).toBe(200);
    const cd = String(dl.headers['content-disposition']);
    expect(cd.startsWith('attachment; filename="x_.pdf_ filename=evil.html.pdf"; filename*=UTF-8\'\'')).toBe(true);
    expect(cd.match(/;/g)!.length).toBe(2);
    expect(dl.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
  });
});
