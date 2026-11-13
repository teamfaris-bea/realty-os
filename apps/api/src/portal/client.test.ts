// Module 45 client session and client routes (R-PORTAL-9, R-PORTAL-16, R-PORTAL-17; E125, E126, E147, E148,
// E687-E689, E699). Fakes only; platform:portal cleared in the per-test database inside try/finally.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { csrfTokenFor } from '../auth/tokens.js';
import { generateTenantKeys, wrapTenantKeys } from '../crypto/envelope.js';
import { localKek } from '../crypto/kek.js';
import { randomBytes, sealGcm } from '../crypto/primitives.js';
import { portalObjectEnvelope } from './client/objectKey.js';
import * as S from './shared/schemas.js';
import { PortalClient, call, client, deal, invite, json, milestone, portalWorld, publish, setPortalCleared, sharedDocument, signIn, slugOf, type PortalWorld } from './testing.js';
import { withTenantTx } from '@realty/db';
import { systemActor } from '../worker/systemActor.js';
import { portalSyncInTx } from './sync/sync.js';

let h: ApiHarness;
let w: PortalWorld;
let w2: PortalWorld;
let slug: string;
let n = 0;
const ip = () => `203.0.113.${(++n % 200) + 20}`;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  w2 = await portalWorld(h);
  slug = await slugOf(h, w.tenantId);
  await setPortalCleared(h, true);
}, 240_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

const sync = (tenantId: string) => withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => portalSyncInTx(tx, systemActor(tenantId, 'worker'), { linkSecret: h.config.sessionSecret, publicBaseUrl: h.config.publicBaseUrl }, now), { db: h.database });

/** A buyer of agent 0 with a deal, a milestone, a shared published document, signed in. */
async function setup(agentIdx = 0) {
  const agent = w.agents[agentIdx]!;
  const c = await client(agent, { firstName: 'Jo' });
  const dealId = await deal(agent, c.id);
  await milestone(agent, dealId, '2031-05-01');
  const doc = await sharedDocument(h, w, agent, dealId);
  const inv = await invite(agent, dealId, c.id);
  const grantId = inv.body.grant.id;
  const pub = await publish(agent, 'document', doc.id, [grantId]);
  const itemId = pub.body.results[0]!.itemId!;
  await sync(w.tenantId);
  const pc = await signIn(h, slug, c.email, new PortalClient(h, ip()));
  return { agent, c, dealId, grantId, itemId, doc, accountId: inv.body.account.id, pc };
}

describe('R-PORTAL-9 the portal session and its CSRF token', () => {
  it('R-PORTAL-9: the cookie is __Host-psid, HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age the absolute expiry (14 days)', async () => {
    const s = await setup();
    const { askLink, lastToken } = await import('./testing.js');
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'`);
    await askLink(h, slug, s.c.email, ip());
    const set = await new PortalClient(h, ip()).post('/api/portal/session', { token: lastToken(h, s.c.email)! });
    const header = String(set.headers['set-cookie']);
    expect(header).toMatch(/^__Host-psid=[A-Za-z0-9_-]{43};/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/Secure/);
    expect(header).toMatch(/SameSite=Strict/);
    expect(header).toMatch(/Path=\//);
    const maxAge = Number(/Max-Age=(\d+)/.exec(header)![1]);
    expect(maxAge).toBeGreaterThan(14 * 86400 - 120);
    expect(maxAge).toBeLessThanOrEqual(14 * 86400);
    expect(S.SessionResponse.safeParse(json(set)).success).toBe(true);
  });

  it('E148: a staff cookie on a client route and a portal cookie on a staff route are both 401', async () => {
    const s = await setup();
    const staffCookie = `__Host-sid=${w.agents[0]!.cookie}`;
    const a = await new PortalClient(h, ip()).get('/api/portal/me', { cookie: staffCookie });
    expect(a.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(a).error.code).toBe('PORTAL_SESSION_REQUIRED');
    // the portal cookie, renamed to the staff name or sent as itself, never authenticates a staff route
    for (const cookie of [`__Host-psid=${s.pc.cookie}`, `__Host-sid=${s.pc.cookie}`]) {
      const b = await h.app.inject({ method: 'GET', url: `/api/deals/${s.dealId}/portal`, headers: { cookie } });
      expect(b.statusCode, cookie).toBe(401);
    }
  });

  it('E687: an unsafe client route with no, a wrong, or the staff-derived CSRF token is 403 CSRF_INVALID', async () => {
    const s = await setup();
    const sessionId = (await h.su.query<{ id: string }>(`SELECT id FROM portal_sessions WHERE portal_account_id = $1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1`, [s.accountId])).rows[0]!.id;
    const staffDerived = csrfTokenFor(h.config.sessionSecret, sessionId);
    for (const csrf of [null, 'x'.repeat(43), staffDerived]) {
      const r = await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`, {}, { csrf });
      expect(r.statusCode, String(csrf)).toBe(403);
      expect(json<{ error: { code: string } }>(r).error.code).toBe('CSRF_INVALID');
      expect((await s.pc.post('/api/portal/logout', {}, { csrf })).statusCode).toBe(403);
    }
    expect((await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`)).statusCode).toBe(200);
  });

  it('R-PORTAL-9: an unsafe portal request from another origin is refused by the Origin allowlist', async () => {
    const s = await setup();
    expect((await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`, {}, { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await new PortalClient(h, ip()).post('/api/portal/session', { token: 'A'.repeat(43) }, { origin: null })).statusCode).toBe(403);
  });

  it('R-PORTAL-9: a new sign-in ends the presented session (rotation); logout ends this one and clears the cookie', async () => {
    const s = await setup();
    const old = s.pc.cookie!;
    await h.su.query(`UPDATE portal_login_tokens SET created_at = created_at - interval '2 hours', expires_at = expires_at - interval '2 hours'`);
    await signIn(h, slug, s.c.email, s.pc); // presents the old cookie
    expect(s.pc.cookie).not.toBe(old);
    expect((await new PortalClient(h, ip()).get('/api/portal/me', { cookie: `__Host-psid=${old}` })).statusCode).toBe(401);
    expect((await s.pc.get('/api/portal/me')).statusCode).toBe(200);
    const cur = s.pc.cookie!;
    const out = await s.pc.post('/api/portal/logout');
    expect(out.statusCode).toBe(204);
    expect(String(out.headers['set-cookie'])).toMatch(/__Host-psid=;/);
    expect((await new PortalClient(h, ip()).get('/api/portal/me', { cookie: `__Host-psid=${cur}` })).statusCode).toBe(401);
  });

  it('E699 R-INT-6: withdrawing the pack ends the session at the next request and refuses a download between token and file', async () => {
    const s = await setup();
    const st = json<{ url: string }>(await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`));
    await setPortalCleared(h, false);
    try {
      expect((await s.pc.get('/api/portal/me')).statusCode).toBe(401);
      expect((await s.pc.get(st.url)).statusCode).toBe(401);
    } finally {
      await setPortalCleared(h, true);
    }
    expect((await s.pc.get(st.url)).statusCode).toBe(200); // the token was not burnt by the refused try
  });

  it('R-PORTAL-12: a 5 KB body on a public portal route is 413', async () => {
    const r = await new PortalClient(h, ip()).request('POST', '/api/portal/session', undefined, { raw: JSON.stringify({ token: 'a'.repeat(5000) }) });
    expect(r.statusCode).toBe(413);
  });
});

describe('R-PORTAL-16 what the client sees', () => {
  it('R-PORTAL-16: /me, /timeline and /documents match the contract schemas and carry portal ids only', async () => {
    const s = await setup();
    const me = await s.pc.get('/api/portal/me');
    expect(S.MeResponse.safeParse(json(me)).success).toBe(true);
    const tl = await s.pc.get(`/api/portal/timeline?grantId=${s.grantId}`);
    expect(S.TimelineResponse.safeParse(json(tl)).success).toBe(true);
    const docs = await s.pc.get(`/api/portal/documents?grantId=${s.grantId}`);
    expect(S.DocumentsResponse.safeParse(json(docs)).success).toBe(true);
    const all = `${me.body}${tl.body}${docs.body}`;
    for (const id of [s.dealId, s.c.id, s.doc.id, s.accountId]) expect(all).not.toContain(id);
  });

  it('E688 E126: another grant, a deal id, another tenant\'s grant and a non-canonical id are all 404', async () => {
    const s = await setup();
    const t = await setup(1); // another buyer of the same tenant
    const o = await (async () => {
      const c = await client(w2.agents[0]!);
      const d = await deal(w2.agents[0]!, c.id);
      return (await invite(w2.agents[0]!, d, c.id)).body.grant.id;
    })();
    for (const g of [t.grantId, s.dealId, o, s.grantId.toUpperCase(), ` ${s.grantId}`, 'not-a-uuid']) {
      expect((await s.pc.get(`/api/portal/timeline?grantId=${encodeURIComponent(g)}`)).statusCode, g).toBe(404);
      expect((await s.pc.get(`/api/portal/documents?grantId=${encodeURIComponent(g)}`)).statusCode, g).toBe(404);
    }
    for (const i of [t.itemId, s.doc.id, s.itemId.toUpperCase()]) expect((await s.pc.post(`/api/portal/documents/${i}/stream-token`)).statusCode, i).toBe(404);
  });

  it('E125 E147: a revoke, a party removed, a disabled account and a lapse each hide everything at once', async () => {
    // revoke
    const a = await setup();
    await call(a.agent, 'POST', `/portal-grants/${a.grantId}/revoke`);
    expect(json<{ grants: unknown[] }>(await a.pc.get('/api/portal/me')).grants).toEqual([]);
    expect((await a.pc.get(`/api/portal/timeline?grantId=${a.grantId}`)).statusCode).toBe(404);
    // party removed: the client leaves the deal (another person becomes its primary contact)
    const b = await setup();
    const other = await client(b.agent, { firstName: 'Ola' });
    await withTenantTx(b.agent.actor(), async (tx) => {
      const { sql } = await import('kysely');
      await sql`DELETE FROM deal_contacts WHERE deal_id = ${b.dealId} AND contact_id = ${b.c.id}`.execute(tx);
      await sql`UPDATE deals SET primary_contact_id = ${other.id} WHERE id = ${b.dealId}`.execute(tx);
    }, { db: h.database });
    expect(json<{ grants: unknown[] }>(await b.pc.get('/api/portal/me')).grants).toEqual([]);
    expect((await b.pc.get(`/api/portal/timeline?grantId=${b.grantId}`)).statusCode).toBe(404);
    // disabled: the session stops at the next request
    const c = await setup();
    expect((await call(c.agent, 'POST', `/portal-accounts/${c.accountId}/disable`, { reason: 'NO_LONGER_A_CLIENT' })).status).toBe(200);
    expect((await c.pc.get('/api/portal/me')).statusCode).toBe(401);
    // lapse
    const d = await setup();
    await h.su.query(`ALTER TABLE portal_grants DISABLE TRIGGER portal_grants_guard; UPDATE portal_grants SET granted_at = now() - interval '2 days', expires_at = now() - interval '1 minute' WHERE id = '${d.grantId}'; ALTER TABLE portal_grants ENABLE TRIGGER portal_grants_guard`);
    expect(json<{ grants: unknown[] }>(await d.pc.get('/api/portal/me')).grants).toEqual([]);
  });
});

describe('R-PORTAL-17 downloads (E689)', () => {
  it('R-PORTAL-17: the bytes equal the stored object, the headers are an attachment that is never rendered, the download is audited', async () => {
    const s = await setup();
    const st = await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`);
    expect(S.StreamTokenResponse.safeParse(json(st)).success).toBe(true);
    const body = json<{ url: string; fileName: string; contentType: string; byteSize: number }>(st);
    expect(body).toMatchObject({ fileName: 'Purchase contract.pdf', contentType: 'application/pdf', byteSize: s.doc.bytes.length });
    const dl = await s.pc.get(body.url);
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, Buffer.from(s.doc.bytes))).toBe(0);
    expect(dl.headers).toMatchObject({
      'content-type': 'application/pdf',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'private, no-store',
      'referrer-policy': 'no-referrer',
      'cross-origin-resource-policy': 'same-origin',
    });
    expect(dl.headers['content-disposition']).toBe(`attachment; filename="Purchase contract.pdf"; filename*=UTF-8''Purchase%20contract.pdf`);
    const audits = await h.su.query<{ action: string }>(`SELECT action FROM audit_log WHERE tenant_id = $1 AND action IN ('portal.document_downloaded','portal.document_stream_issued') AND (entity_id = $2 OR entity_id = $3)`, [w.tenantId, s.doc.id, s.itemId]);
    expect(audits.rows.map((r) => r.action).sort()).toEqual(['portal.document_downloaded', 'portal.document_stream_issued']);
  });

  it('E689 (b14 F8): a HEAD on a download URL never redeems the single-use token (no download audited); the GET after it still downloads, once', async () => {
    const s = await setup();
    const url = json<{ url: string }>(await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`)).url;
    const audited = async () => Number((await h.su.query<{ n: string }>(`SELECT count(*) AS n FROM audit_log WHERE tenant_id = $1 AND action = 'portal.document_downloaded' AND entity_id = $2`, [w.tenantId, s.doc.id])).rows[0]!.n);
    const head = await s.pc.request('HEAD', url);
    expect(head.statusCode).toBe(404);
    expect(head.body).not.toContain('PDF'); // nothing of the file
    expect(await audited()).toBe(0);
    expect((await h.su.query('SELECT 1 FROM portal_stream_tokens WHERE portal_item_id = $1 AND used_at IS NOT NULL', [s.itemId])).rowCount).toBe(0);
    const dl = await s.pc.get(url);
    expect(dl.statusCode).toBe(200);
    expect(Buffer.compare(dl.rawPayload, Buffer.from(s.doc.bytes))).toBe(0);
    expect(await audited()).toBe(1);
    expect((await s.pc.get(url)).statusCode).toBe(404);
  });

  it('E689: a reused token, one past 60 s, and a document unshared, an item retracted or a grant revoked before the download are 404 with nothing streamed', async () => {
    const s = await setup();
    const token = async () => json<{ url: string }>(await s.pc.post(`/api/portal/documents/${s.itemId}/stream-token`)).url;
    const used = await token();
    expect((await s.pc.get(used)).statusCode).toBe(200);
    expect((await s.pc.get(used)).statusCode).toBe(404);
    const late = await token();
    await h.su.query(`UPDATE portal_stream_tokens SET created_at = created_at - interval '61 seconds', expires_at = expires_at - interval '61 seconds' WHERE used_at IS NULL AND portal_item_id = $1`, [s.itemId]);
    expect((await s.pc.get(late)).statusCode).toBe(404);
    const unshared = await token();
    await call(s.agent, 'POST', `/documents/${s.doc.id}/share`, { shared: false });
    const r1 = await s.pc.get(unshared);
    expect(r1.statusCode).toBe(404);
    expect(r1.body).not.toContain('PDF');
    await call(s.agent, 'POST', `/documents/${s.doc.id}/share`, { shared: true });
    const retracted = await token();
    await call(s.agent, 'POST', `/portal-items/${s.itemId}/retract`);
    expect((await s.pc.get(retracted)).statusCode).toBe(404);
    const t = await setup();
    const revoked = json<{ url: string }>(await t.pc.post(`/api/portal/documents/${t.itemId}/stream-token`)).url;
    await call(t.agent, 'POST', `/portal-grants/${t.grantId}/revoke`);
    expect((await t.pc.get(revoked)).statusCode).toBe(404);
    // another account's stream token
    const u = await setup();
    const theirs = json<{ url: string }>(await u.pc.post(`/api/portal/documents/${u.itemId}/stream-token`)).url;
    expect((await s.pc.get(theirs)).statusCode).toBe(404);
    expect((await u.pc.get(theirs)).statusCode).toBe(200);
  });

  it('R-PORTAL-17: the download envelope refuses a key version mismatch, another object, and every other method', async () => {
    const kek = localKek(randomBytes(32), 'k');
    const tenant = '01a1d527-588b-713f-914b-8241c9cbd2ba';
    const keys = generateTenantKeys();
    const wrapped = await wrapTenantKeys(kek, tenant, keys);
    const object = '01a1d527-5953-7d68-94b9-0a3fb9753a9d';
    const { encodeAad } = await import('../crypto/envelope.js');
    const dek = randomBytes(32);
    const dekWrapped = sealGcm(keys.object, 1, encodeAad(tenant, { table: 'stored_objects', column: 'dek_wrapped', rowId: object }), dek);
    const env = portalObjectEnvelope(kek, { tenantId: tenant as never, objectId: object, objectKeyWrapped: wrapped.object, objectKeyVersion: 1 });
    expect(Buffer.compare(Buffer.from(await env.unwrapObjectKey(tenant as never, object, dekWrapped)), Buffer.from(dek))).toBe(0);
    const v2 = portalObjectEnvelope(kek, { tenantId: tenant as never, objectId: object, objectKeyWrapped: wrapped.object, objectKeyVersion: 2 });
    await expect(v2.unwrapObjectKey(tenant as never, object, dekWrapped)).rejects.toThrow();
    await expect(env.unwrapObjectKey(tenant as never, '01a1d527-5953-7d68-94b9-0a3fb9753a9e', dekWrapped)).rejects.toThrow();
    await expect(env.decrypt(tenant as never, { table: 't', column: 'c', rowId: 'r' }, dekWrapped)).rejects.toThrow(/only unwraps/);
    await expect(env.encrypt(tenant as never, { table: 't', column: 'c', rowId: 'r' }, dek)).rejects.toThrow(/only unwraps/);
    await expect(env.hmacAddress(tenant as never, 'x')).rejects.toThrow(/only unwraps/);
    await expect(env.wrapObjectKey(tenant as never, object, dek)).rejects.toThrow(/only unwraps/);
  });

  it('R-PORTAL-17: a client download opens no staff or system transaction (the client route module imports neither)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('./client/routes.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/withTenantTx|asSystem|systemActor|withPreTenant|tenant_key_material/);
  });
});
