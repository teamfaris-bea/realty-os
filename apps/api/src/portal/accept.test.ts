// Module 45 acceptance (PHASE2_3_PLAN §5.4 #45; the lane's <accept>): on fakes, with platform:portal cleared in the test
// database, an agent invites a buyer, the buyer signs in and sees exactly their purchase, its confirmed milestones
// (published by portal.sync) and the shared document (downloaded once per token); foreign ids are 404; a revoke hides
// everything on the next request; no stored message keeps a token once the send is final; nginx logs no token. With
// the pack uncleared the same journey sends nothing and the portal says it is not available.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { systemActor } from '../worker/systemActor.js';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { portalSyncInTx } from './sync/sync.js';
import { askLink, call, client, deal, invite, json, milestone, portalWorld, publish, setPortalCleared, sharedDocument, signIn, slugOf, type PortalWorld } from './testing.js';

let h: ApiHarness;
let w: PortalWorld;
let other: PortalWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await portalWorld(h);
  other = await portalWorld(h);
}, 240_000);
afterAll(async () => {
  await setPortalCleared(h, false).catch(() => undefined);
  await h?.close();
});

const sync = (tenantId: string) =>
  withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => portalSyncInTx(tx, systemActor(tenantId, 'worker'), { linkSecret: h.config.sessionSecret, publicBaseUrl: h.config.publicBaseUrl }, now), { db: h.database });

describe('R-PORTAL-8 R-PORTAL-13 R-PORTAL-15 R-PORTAL-16 R-PORTAL-17 module 45 acceptance', () => {
  it('R-PORTAL-10 R-INT-6 E641 E653: with platform:portal uncleared the journey sends nothing and the portal says it is not available', async () => {
    await setPortalCleared(h, false);
    const agent = w.agents[0]!;
    const buyer = await client(agent, { firstName: 'Una' });
    const dealId = await deal(agent, buyer.id);
    const before = h.providers.email.sent.length + h.providers.telephony.sms.length;
    const inv = await invite(agent, dealId, buyer.id);
    expect(inv.status).toBe(200);
    expect(inv.body.notice).toMatchObject({ sent: false, text: "Una can't sign in until the client portal is turned on, so nothing was sent to them." });
    const preview = await call<{ visibleNow: boolean; why: string[] }>(agent, 'GET', `/portal-grants/${inv.body.grant.id}/preview`);
    expect(preview.body.visibleNow).toBe(false);
    expect(preview.body.why[0]).toMatch(/not turned on/);
    const r = await askLink(h, await slugOf(h, w.tenantId), buyer.email);
    expect(r.statusCode).toBe(503);
    expect(json<{ error: { code: string } }>(r).error.code).toBe('PORTAL_NOT_AVAILABLE');
    expect(h.providers.email.sent.length + h.providers.telephony.sms.length).toBe(before);
    expect((await h.su.query('SELECT 1 FROM portal_login_tokens')).rowCount).toBe(0);
  });

  it('R-PORTAL-13 R-PORTAL-15 R-PORTAL-16 R-PORTAL-17: invite, notice, sign-in, milestones by the sync, a shared document downloaded once, 404s, revoke hides everything', async () => {
    await setPortalCleared(h, true);
    try {
      const agent = w.agents[0]!;
      const buyer = await client(agent, { firstName: 'Jane' });
      const dealId = await deal(agent, buyer.id);
      const dateId = await milestone(agent, dealId, '2031-03-15');
      const doc = await sharedDocument(h, w, agent, dealId, 'Purchase contract.pdf');

      // one tap: the agent's own notice, no token
      const inv = await invite(agent, dealId, buyer.id);
      expect(inv.status, JSON.stringify(inv.body)).toBe(200);
      expect(inv.body.created).toEqual({ account: true, grant: true });
      expect(inv.body.grant.view).toMatchObject({ scope: 'purchase', title: 'Your home purchase' });
      expect(inv.body.notice.sent, JSON.stringify(inv.body.notice)).toBe(true);
      const notice = h.providers.email.sent.at(-1)!;
      expect(notice.to).toBe(buyer.email);
      expect(notice.subject).toBe('Follow your home purchase online');
      expect(notice.text).toContain('/portal.html?team=');
      expect(notice.text).not.toMatch(/#token=/);
      const grantId = inv.body.grant.id;

      // the agent shares the document; the sync publishes the confirmed milestone
      const pub = await publish(agent, 'document', doc.id, [grantId]);
      expect(pub.body.results).toEqual([expect.objectContaining({ grantId, result: 'published' })]);
      const s = await sync(w.tenantId);
      expect(s.published).toBe(1);

      // sign-in by the fake email
      const slug = await slugOf(h, w.tenantId);
      const pc = await signIn(h, slug, buyer.email);
      const me = json<{ grants: { id: string; scope: string; title: string }[] }>(await pc.get('/api/portal/me'));
      expect(me.grants).toEqual([expect.objectContaining({ id: grantId, scope: 'purchase', title: 'Your home purchase' })]);
      const tl = json<{ items: { kind: string; occursOn: string }[] }>(await pc.get(`/api/portal/timeline?grantId=${grantId}`));
      expect(tl.items).toEqual([expect.objectContaining({ kind: 'milestone', occursOn: '2031-03-15' })]);
      const docs = json<{ documents: { itemId: string; title: string }[] }>(await pc.get(`/api/portal/documents?grantId=${grantId}`));
      expect(docs.documents).toHaveLength(1);
      expect(dateId).toBeTruthy();

      // a stream token downloads the bytes once
      const st = await pc.post(`/api/portal/documents/${docs.documents[0]!.itemId}/stream-token`);
      expect(st.statusCode, st.body).toBe(200);
      const url = json<{ url: string }>(st).url;
      const dl = await pc.get(url);
      expect(dl.statusCode).toBe(200);
      expect(Buffer.compare(dl.rawPayload, Buffer.from(doc.bytes))).toBe(0);
      expect(dl.headers['content-disposition']).toMatch(/^attachment; /);
      expect((await pc.get(url)).statusCode).toBe(404);

      // another deal's or tenant's ids are 404
      const otherBuyer = await client(other.agents[0]!);
      const otherDeal = await deal(other.agents[0]!, otherBuyer.id);
      const otherInv = await invite(other.agents[0]!, otherDeal, otherBuyer.id);
      expect((await pc.get(`/api/portal/timeline?grantId=${otherInv.body.grant.id}`)).statusCode).toBe(404);
      expect((await pc.get(`/api/portal/documents?grantId=${dealId}`)).statusCode).toBe(404);

      // the stored link message never held the token (b14 audit F2: the URL is sealed beside it, never in the body)
      const rows = await h.su.query<{ body: string; status: string }>(`SELECT body, status FROM messages WHERE action_category = 'portal_login_link' AND contact_id = $1`, [buyer.id]);
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const m of rows.rows) {
        expect(m.status).toBe('sent');
        expect(m.body).not.toMatch(/token/);
        expect(m.body).toMatch(/\(the link itself is not kept in the message history\):$/);
      }

      // revoke: everything hidden on the next request
      expect((await call(agent, 'POST', `/portal-grants/${grantId}/revoke`)).status).toBe(200);
      expect(json<{ grants: unknown[] }>(await pc.get('/api/portal/me')).grants).toEqual([]);
      expect((await pc.get(`/api/portal/timeline?grantId=${grantId}`)).statusCode).toBe(404);
    } finally {
      await setPortalCleared(h, false);
    }
  });

  it('R-PORTAL-8: nginx would log no download token: deploy/nginx.conf\'s own $log_uri rules, applied to every /api/portal capability path of capabilityPaths.json, leave no secret in the logged URI (b14 F10; apps/web/src/security-headers.nginx.test.ts checks the whole file)', () => {
    const conf = readFileSync(resolve(__dirname, '../../../../deploy/nginx.conf'), 'utf8');
    const rules = [...conf.matchAll(/~(\^\(\?<redact_head>\S+\$)\s+"\$\{redact_head\}-\$\{redact_tail\}";/g)].map((m) => new RegExp(m[1]!));
    expect(rules.length).toBeGreaterThan(0);
    const logged = (uri: string): string => {
      for (const re of rules) {
        const m = re.exec(uri);
        if (m?.groups) return `${m.groups.redact_head}-${m.groups.redact_tail ?? ''}`;
      }
      return uri;
    };
    const caps = JSON.parse(readFileSync(resolve(__dirname, '../capabilityPaths.json'), 'utf8')) as { paths: { path: string; secrets: string[] }[] };
    const portal = caps.paths.filter((p) => p.path.startsWith('/api/portal/'));
    expect(portal.map((p) => p.path).sort()).toEqual(['/api/portal/documents/:itemId/stream-token', '/api/portal/files/:token']);
    for (const p of portal) {
      const secret = 'S3CRETs3cret_S3CRETs3cret_S3CRETs3cret_abc';
      const uri = p.path.replace(/:[A-Za-z]+/g, secret);
      expect(logged(uri), p.path).not.toContain(secret);
      expect(logged(`${uri}?x=1`), p.path).not.toContain(secret);
    }
  });
});
