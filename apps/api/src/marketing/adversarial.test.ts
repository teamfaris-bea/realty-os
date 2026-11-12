// Adversarial tests of module 29 (critical module): tenancy of every route, the public page and the handlers;
// listing-writer authorization; fair housing obfuscation; the publishing state machine under hostile input
// (R-TEN-1, R-PERM-5, R-MKT-1, R-MKT-7, R-MKT-12, R-GATE-15, R-FH-1). Real Postgres, fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { ownedContact } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { assetLinkToken } from './assetLinks.js';
import { reconcileMarketing } from './handlers.js';
import { publishDepsOf } from './routes.js';
import { type MarketingWorld, type PieceBody, PNG_1X1, approve, call, clearFairHousing, connectAccount, generateAll, marketingWorld, publicPage, teamListing, uploadImage } from './testing.js';

let h: ApiHarness;
let a: MarketingWorld;
let b: MarketingWorld;
let aPage: { connectionId: string; accountId: string };
let bPage: { connectionId: string; accountId: string };
let aPost: PieceBody;
let aSite: PieceBody;
let aImage: string;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  a = await marketingWorld(h);
  b = await marketingWorld(h, { brokerage: 'Bay Brokers Inc', team: 'Bay Team' });
  await clearFairHousing(h);
  aPage = await connectAccount(h, a.owner, 'facebook_page');
  bPage = await connectAccount(h, b.owner, 'facebook_page');
  const pieces = await generateAll(a.agent, a.listingId);
  const up = await uploadImage(a.agent, a.listingId, PNG_1X1);
  aImage = up.objectId!;
  const withImg = await call<{ piece: PieceBody }>(a.agent, 'PATCH', `/marketing-pieces/${pieces.social_post!.id}`, { assetObjectIds: [aImage] });
  aPost = (await approve(a.agent, withImg.body.piece)).body.piece;
  aSite = (await approve(a.agent, pieces.website_page!)).body.piece;
  await call(a.agent, 'POST', `/marketing-pieces/${aSite.id}/publish`, {});
  aSite = (await call<{ piece: PieceBody }>(a.agent, 'GET', `/marketing-pieces/${aSite.id}`)).body.piece;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const routesOf = (pieceId: string, listingId: string): [string, string, Record<string, unknown> | undefined][] => [
  ['GET', `/listings/${listingId}/marketing`, undefined],
  ['POST', `/listings/${listingId}/marketing/generate`, {}],
  ['GET', `/marketing-pieces/${pieceId}`, undefined],
  ['PATCH', `/marketing-pieces/${pieceId}`, { prose: { caption: 'Hijack', hashtags: [] } }],
  ['POST', `/marketing-pieces/${pieceId}/approve`, { contentSha256: 'a'.repeat(64) }],
  ['POST', `/marketing-pieces/${pieceId}/publish`, { connectionId: randomUUID() }],
  ['POST', `/marketing-pieces/${pieceId}/export`, {}],
  ['POST', `/marketing-pieces/${pieceId}/retract`, {}],
  ['POST', `/marketing-pieces/${pieceId}/invite/send`, { recipientContactIds: [randomUUID()] }],
  ['GET', `/marketing-pieces/${pieceId}/flyer.pdf`, undefined],
  ['GET', `/marketing-pieces/${pieceId}/assets/1`, undefined],
];

async function hit(c: TestClient, method: string, url: string, body?: Record<string, unknown>) {
  return call(c, method as 'GET', url, body);
}

describe('R-TEN-1 R-PERM-5 tenant isolation of every route', () => {
  it('R-TEN-1 R-PERM-5: another tenant\'s Owner gets 404 on every marketing route for tenant A\'s pieces and listing, and nothing changes', async () => {
    const before = (await h.su.query('SELECT id, status, content_sha256 FROM marketing_pieces WHERE tenant_id = $1 ORDER BY id', [a.tenantId])).rows;
    const pubs = (await h.su.query('SELECT count(*)::int AS n FROM marketing_publications WHERE tenant_id = $1', [a.tenantId])).rows[0].n;
    for (const [m, url, body] of routesOf(aPost.id, a.listingId)) {
      const r = await hit(b.owner, m, url, body);
      expect([r.status, r.code], `${m} ${url}`).toEqual([404, 'NOT_FOUND']);
    }
    expect((await h.su.query('SELECT id, status, content_sha256 FROM marketing_pieces WHERE tenant_id = $1 ORDER BY id', [a.tenantId])).rows).toEqual(before);
    expect((await h.su.query('SELECT count(*)::int AS n FROM marketing_publications WHERE tenant_id = $1', [a.tenantId])).rows[0].n).toBe(pubs);
    // B's approvals inbox never lists A's drafts
    const inbox = await call<{ pieces: PieceBody[] }>(b.owner, 'GET', '/marketing/approvals');
    expect(inbox.body.pieces.every((p) => p.listingId !== a.listingId)).toBe(true);
  });

  it('R-TEN-1 R-MKT-12: A cannot publish to B\'s Page (an id of another tenant is 404 and the DB guard sees no such account)', async () => {
    const n = h.providers.integrations.social.published.length;
    const r = await call(a.agent, 'POST', `/marketing-pieces/${aPost.id}/publish`, { connectionId: bPage.connectionId });
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    await expect(withTenantTx(a.agent.actor(), (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, requested_by_user_id) VALUES (app.tenant_id(), ${randomUUID()}, ${aPost.id}, ${bPage.connectionId}, 'publishing', ${a.agent.userId})`.execute(tx), { db: h.database })).rejects.toThrow();
    expect(h.providers.integrations.social.published.length).toBe(n);
  });

  it('R-TEN-1 R-MKT-1: B cannot attach A\'s image to a B piece (the asset is not B\'s: refused), nor read it through B\'s piece', async () => {
    const p = (await generateAll(b.agent, b.listingId, { kinds: ['flyer'] })).flyer!;
    const r = await call(b.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [aImage] });
    // the same answer as for an id that does not exist at all (no oracle on other tenants' objects)
    const none = await call(b.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [randomUUID()] });
    expect([r.status, r.code]).toEqual([none.status, none.code]);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await h.su.query('SELECT count(*)::int AS n FROM marketing_piece_assets WHERE piece_id = $1', [p.id])).rows[0].n).toBe(0);
  });

  it('R-MKT-7 R-TEN-12: A\'s page under B\'s tenant slug is 404; a signed image link forged for another tenant is 404', async () => {
    const slug = aSite.publicPath!.split('/')[3]!;
    expect((await publicPage(h, aSite.publicPath!)).statusCode).toBe(200);
    expect((await publicPage(h, `/p/${b.tenantSlug}/${slug}`)).statusCode).toBe(404);
    const forged = assetLinkToken(new Uint8Array(32), { tenantId: a.tenantId, objectId: aImage, expiresAt: Date.now() + 60_000 });
    expect((await h.app.inject({ method: 'GET', url: `/api/public/marketing-assets/${forged}` })).statusCode).toBe(404);
    const crossed = assetLinkToken(h.config.sessionSecret, { tenantId: b.tenantId, objectId: aImage, expiresAt: Date.now() + 60_000 });
    expect((await h.app.inject({ method: 'GET', url: `/api/public/marketing-assets/${crossed}` })).statusCode).toBe(404);
    const expired = assetLinkToken(h.config.sessionSecret, { tenantId: a.tenantId, objectId: aImage, expiresAt: Date.now() - 1000 });
    expect((await h.app.inject({ method: 'GET', url: `/api/public/marketing-assets/${expired}` })).statusCode).toBe(404);
    const good = assetLinkToken(h.config.sessionSecret, { tenantId: a.tenantId, objectId: aImage, expiresAt: Date.now() + 60_000 });
    expect((await h.app.inject({ method: 'GET', url: `/api/public/marketing-assets/${good}` })).statusCode).toBe(200);
  });

  it('R-TEN-1: tenant B\'s reconcile pass never reads or changes tenant A\'s publications', async () => {
    h.providers.integrations.social.nextOutcome = 'timeout';
    const r = await call<{ publication: { id: string; status: string } }>(a.agent, 'POST', `/marketing-pieces/${aPost.id}/publish`, { connectionId: aPage.connectionId });
    expect(r.body.publication.status).toBe('unknown');
    const lookups = h.providers.integrations.social.lookups.length;
    const actor = systemActor(b.tenantId, 'provider');
    const ctx = { actor, now: Date.now(), providers: h.providers, job: { id: 1n }, log: { info: () => undefined }, alerts: {}, withTx: (fn: never) => withTenantTx(actor, fn, { db: h.database }) } as unknown as StandaloneJobContext;
    const s = await reconcileMarketing(ctx, publishDepsOf(h.app.platform));
    expect(s.looked).toBe(0);
    expect(h.providers.integrations.social.lookups.length).toBe(lookups);
    expect((await h.su.query('SELECT status FROM marketing_publications WHERE id = $1', [r.body.publication.id])).rows[0].status).toBe('unknown');
  });
});

describe('R-PERM-5 listing writers only', () => {
  it('R-PERM-5: an agent who is not the listing agent cannot approve, publish, export or edit another agent\'s piece (404), but can see the listing\'s pieces', async () => {
    const other = a.agents[1]!;
    const p = (await generateAll(a.agent, a.listingId, { kinds: ['marketplace_export'] })).marketplace_export!;
    for (const [m, url, body] of routesOf(p.id, a.listingId).filter(([m]) => m !== 'GET')) {
      const r = await hit(other, m, url, body);
      expect(r.status, `${m} ${url}`).toBe(404);
    }
    expect((await call(other, 'GET', `/listings/${a.listingId}/marketing`)).status).toBe(200);
  });

  it('R-MKT-1: a person approves only as themselves (the DB refuses an approval naming someone else)', async () => {
    const p = (await generateAll(a.agent, a.listingId, { kinds: ['marketplace_export'] })).marketplace_export!;
    const sha = (await call<{ piece: PieceBody }>(a.agent, 'GET', `/marketing-pieces/${p.id}`)).body.piece;
    await expect(
      withTenantTx(a.agent.actor(), async (tx) => {
        await sql`UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = ${a.owner.userId}, approved_at = now() WHERE id = ${p.id}`.execute(tx);
      }, { db: h.database }),
    ).rejects.toThrow(/MARKETING_HUMAN_APPROVAL/);
    void sha;
  });
});

describe('R-FH-1 fair housing cannot be hidden', () => {
  it('R-FH-1 E93: obfuscated or split wording ("Perfect for y0ung" / "fam1lies", #AdultsOnly, a soft hyphen) is still a hard match and blocks approval', async () => {
    const l = await teamListing(a.agent, {});
    const pieces = await generateAll(a.agent, l, { kinds: ['website_page', 'social_post'] });
    const cases: [string, Record<string, unknown>][] = [
      [pieces.website_page!.id, { headline: 'Perfect for y0ung', body: 'fam1lies looking for space.', highlights: [] }],
      [pieces.social_post!.id, { caption: 'Quiet street.', hashtags: ['#AdultsOnly'] }],
      [pieces.social_post!.id, { caption: 'A quiet home for adults­only living.', hashtags: [] }],
    ];
    for (const [id, prose] of cases) {
      const r = await call<{ piece: PieceBody }>(a.agent, 'PATCH', `/marketing-pieces/${id}`, { prose });
      expect(r.status).toBe(200);
      expect(r.body.piece.guard.approvable, JSON.stringify(prose)).toBe(false);
      expect((await approve(a.agent, r.body.piece)).code).toBe('MARKETING_GUARD_FAILED');
    }
  });

  it('R-MKT-3: price and date numerals typed into the copy block approval (facts come from the listing)', async () => {
    const l = await teamListing(a.agent, {});
    const p = (await generateAll(a.agent, l, { kinds: ['social_post'] })).social_post!;
    const r = await call<{ piece: PieceBody }>(a.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { caption: 'Only $450k! Open Saturday 3/14.', hashtags: [] } });
    expect(r.body.piece.guard.approvable).toBe(false);
    expect(r.body.piece.guard.reasons.join(' ')).toMatch(/Prices, dates and times come from the listing facts/);
  });
});

describe('hostile input', () => {
  it('unknown prose keys, a guard result in the body, and oversized uploads are refused before they reach the DB', async () => {
    const l = await teamListing(a.agent, {});
    const p = (await generateAll(a.agent, l, { kinds: ['social_post'] })).social_post!;
    const extra = await call(a.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { caption: 'Hi there friend.', hashtags: [], price: 1 } });
    expect(extra.status).toBe(422);
    const smuggled = await call(a.agent, 'PATCH', `/marketing-pieces/${p.id}`, { guard_result: { hard_count: 0 } });
    expect(smuggled.status).toBe(422);
    const big = await uploadImage(a.agent, l, Buffer.concat([PNG_1X1, Buffer.alloc(11 * 1024 * 1024)]));
    expect(big.status).toBe(413);
    const svg = await uploadImage(a.agent, l, Buffer.from('<svg/>'), 'image/svg+xml');
    expect(svg.status).toBe(415);
  });

  it('an invite to a contact of another tenant counts as "no email" and sends nothing', async () => {
    const pieces = await generateAll(a.agent, await teamListing(a.agent, {}), { kinds: ['open_house_invite'] });
    expect((await approve(a.agent, pieces.open_house_invite!)).status).toBe(200);
    const foreign = await ownedContact(b.agent, { consent: false });
    const r = await call<{ sent: number; noEmail: number }>(a.agent, 'POST', `/marketing-pieces/${pieces.open_house_invite!.id}/invite/send`, { recipientContactIds: [foreign.id] });
    expect(r.body).toMatchObject({ sent: 0, noEmail: 1 });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [foreign.id])).rows[0].n).toBe(0);
  });
});
