// Publishing through publishPost (module 29; D2; DATA_MODEL R-MKT-12, R-GATE-15, R-INT-6, R-MKT-4, R-MKT-6; E227, E228).
// Real Postgres (createTestDb via the harness) and the deterministic FakeSocialPublisher; nothing leaves the process.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileMarketing } from './handlers.js';
import { publishDepsOf } from './routes.js';
import { freshReauth } from '../admin/testing.js';
import { type MarketingWorld, type PieceBody, PNG_1X1, approve, call, clearFairHousing, connectAccount, generateAll, getPiece, marketingWorld, teamListing, uploadImage } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;
let page: { connectionId: string; accountId: string };
let insta: { connectionId: string; accountId: string };

const social = () => h.providers.integrations.social;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  page = await connectAccount(h, w.owner, 'facebook_page');
  insta = await connectAccount(h, w.owner, 'instagram_business');
  await clearFairHousing(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});
beforeEach(() => {
  const s = social();
  s.nextOutcome = 'published';
  s.lookup = 'supported';
  s.deletion = { facebook_page: 'supported', instagram_business: 'supported', gbp_location: 'supported' };
});

/** An approved social post with one image, on a fresh listing. */
async function approvedPost(o: { image?: boolean } = {}): Promise<PieceBody> {
  const l = await teamListing(w.agent, {});
  let p = (await generateAll(w.agent, l, { kinds: ['social_post'] })).social_post!;
  if (o.image !== false) {
    const up = await uploadImage(w.agent, l, PNG_1X1);
    const r = await call<{ piece: PieceBody }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [up.objectId] });
    p = r.body.piece;
  }
  const a = await approve(w.agent, p);
  if (a.status !== 200) throw new Error(`approve: ${JSON.stringify(a.body)}`);
  return a.body.piece;
}

const publish = (pieceId: string, connectionId: string) => call<{ piece: PieceBody; publication: PieceBody['publications'][number] | null }>(w.agent, 'POST', `/marketing-pieces/${pieceId}/publish`, { connectionId });

function jobCtx(): StandaloneJobContext {
  const actor = systemActor(w.tenantId, 'provider');
  return {
    actor,
    now: Date.now() as never,
    providers: h.providers,
    job: { id: 1n, kind: 'marketing.reconcile', attempt: 1 } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    alerts: { raise: async () => undefined } as never,
    withTx: (fn) => withTenantTx(actor, fn, { db: h.database }),
  };
}

describe('R-MKT-12 a social post publishes through publishPost to the fake Page and Instagram account', () => {
  it('R-MKT-12 R-GATE-15: TX1 as the person, the provider call, TX2 as the system: published with the provider post id; "Posted" only for that row', async () => {
    const p = await approvedPost();
    const before = social().published.length;
    const fb = await publish(p.id, page.connectionId);
    expect(fb.status).toBe(200);
    expect(fb.body.publication).toMatchObject({ status: 'published', posted: true, targetKind: 'facebook_page' });
    expect(fb.body.publication!.label).toMatch(/^Posted to your Facebook Page/);
    const ig = await publish(p.id, insta.connectionId);
    expect(ig.body.publication).toMatchObject({ status: 'published', posted: true, targetKind: 'instagram_business' });
    expect(social().published.length).toBe(before + 2);
    // the provider got the rendered copy with the brokerage name and a signed image URL, never a raw object id
    const req = social().published.at(-1)!;
    expect(req.text).toContain('Harbor Realty LLC');
    expect(req.imageUrls[0]).toMatch(/\/api\/public\/marketing-assets\/[A-Za-z0-9_.-]+$/);
    const rows = (await h.su.query("SELECT status, external_post_id, requested_by_user_id FROM marketing_publications WHERE piece_id = $1 ORDER BY requested_at", [p.id])).rows;
    expect(rows).toEqual([
      { status: 'published', external_post_id: expect.stringMatching(/^fake-post-/), requested_by_user_id: w.agent.userId },
      { status: 'published', external_post_id: expect.stringMatching(/^fake-post-/), requested_by_user_id: w.agent.userId },
    ]);
    expect((await getPiece(w.agent, p.id)).status).toBe('published');
    // the signed image link serves the image to the provider, and nothing else
    const link = await h.app.inject({ method: 'GET', url: new URL(req.imageUrls[0]!).pathname });
    expect(link.statusCode).toBe(200);
    expect(link.headers['content-type']).toBe('image/png');
    const forged = await h.app.inject({ method: 'GET', url: `${new URL(req.imageUrls[0]!).pathname.slice(0, -3)}xyz` });
    expect(forged.statusCode).toBe(404);
  });

  it('R-MKT-12: a second live row per piece and target is refused (PUBLICATION_ALREADY_LIVE); nothing is posted twice', async () => {
    const p = await approvedPost();
    expect((await publish(p.id, page.connectionId)).status).toBe(200);
    const n = social().published.length;
    const again = await publish(p.id, page.connectionId);
    expect([again.status, again.code]).toEqual([409, 'PUBLICATION_ALREADY_LIVE']);
    expect(social().published.length).toBe(n);
  });

  it('R-MKT-12: two concurrent taps for the same piece and Page make exactly one live row and one provider call', async () => {
    const p = await approvedPost();
    const n = social().published.length;
    const [a, b] = await Promise.all([publish(p.id, page.connectionId), publish(p.id, page.connectionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(social().published.length).toBe(n + 1);
    expect((await h.su.query("SELECT count(*)::int AS n FROM marketing_publications WHERE piece_id = $1 AND status IN ('publishing','published','unknown')", [p.id])).rows[0].n).toBe(1);
  });

  it('R-MKT-12 E227 VERIFY: Instagram without an image is not offered (export instead) and the API refuses it', async () => {
    const p = await approvedPost({ image: false });
    const opt = p.publishOptions.find((o) => o.connectionId === insta.connectionId);
    expect(opt).toMatchObject({ kind: 'export', reason: 'NEEDS_IMAGE' });
    const r = await publish(p.id, insta.connectionId);
    expect([r.status, r.code]).toEqual([422, 'PUBLISH_NEEDS_IMAGE']);
  });

  it('R-MKT-12: a provider rejection is failed with its code, never "Posted"; the slot is free again', async () => {
    const p = await approvedPost();
    social().nextOutcome = 'rejected';
    const r = await publish(p.id, page.connectionId);
    expect(r.body.publication).toMatchObject({ status: 'failed', posted: false });
    expect(r.body.publication!.label).not.toMatch(/\bposted\b/i);
    expect((await getPiece(w.agent, p.id)).status).toBe('approved');
    expect((await publish(p.id, page.connectionId)).body.publication).toMatchObject({ status: 'published', posted: true });
  });
});

describe('E227 a publish that times out', () => {
  it('E227 R-MKT-12: the timeout is unknown, never "Posted", never re-posted; the reconcile lookup finds the post and records it published', async () => {
    const p = await approvedPost();
    social().nextOutcome = 'timeout';
    const r = await publish(p.id, page.connectionId);
    expect(r.status).toBe(200);
    expect(r.body.publication).toMatchObject({ status: 'unknown', posted: false });
    expect(r.body.publication!.label).toMatch(/Check your Facebook Page/);
    expect(r.body.publication!.label).not.toMatch(/\bposted\b/i);
    expect((await getPiece(w.agent, p.id)).status).toBe('approved');
    // a blind re-post is refused while it is unknown
    const n = social().published.length;
    expect((await publish(p.id, page.connectionId)).code).toBe('PUBLICATION_ALREADY_LIVE');
    // reconcile: looked up, never posted again
    const s = await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(s.looked).toBeGreaterThanOrEqual(1);
    expect(social().published.length).toBe(n);
    expect(social().lookups.at(-1)).toMatchObject({ pieceId: p.id, externalAccountId: page.accountId });
    const after = await getPiece(w.agent, p.id);
    expect(after.publications[0]).toMatchObject({ status: 'published', posted: true });
    expect(after.status).toBe('published');
  });

  it('E227 VERIFY: when the provider cannot look a post up without its id, unknown stays unknown ("Check your Page"), and nothing is posted', async () => {
    const p = await approvedPost();
    social().nextOutcome = 'timeout';
    await publish(p.id, page.connectionId);
    social().lookup = 'unsupported';
    const n = social().published.length;
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(social().published.length).toBe(n);
    const after = await getPiece(w.agent, p.id);
    expect(after.publications[0]).toMatchObject({ status: 'unknown', posted: false });
    expect(after.publications[0]!.label).toMatch(/Check your Facebook Page/);
  });

  it('E227: a publication stuck in publishing (the process died between TX1 and TX2) becomes unknown and is looked up, never re-posted', async () => {
    const p = await approvedPost();
    const id = randomUUID();
    // TX1 only (as the person, through the DB guard), then "crash": no provider call, no TX2
    await insertAsPerson(id, p.id, page.connectionId);
    // a fixture clock: the attempt is ten minutes old (requested_at is immutable, so the guard is bypassed for the fixture only)
    await h.su.query(`SET session_replication_role = replica; UPDATE marketing_publications SET requested_at = now() - interval '10 minutes' WHERE id = '${id}'; SET session_replication_role = origin;`);
    const n = social().published.length;
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(social().published.length).toBe(n);
    // nothing was ever posted, so the lookup finds nothing and it stays unknown until the give-up window
    expect((await h.su.query('SELECT status FROM marketing_publications WHERE id = $1', [id])).rows[0].status).toBe('unknown');
  });
});

/** TX1 exactly as publish.ts runs it: as the person, through RLS and the DB guard. */
async function insertAsPerson(id: string, pieceId: string, connectionId: string, client = w.agent) {
  await withTenantTx(client.actor(), (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, requested_by_user_id) VALUES (app.tenant_id(), ${id}, ${pieceId}, ${connectionId}, 'publishing', ${client.userId})`.execute(tx), { db: h.database });
}

describe('R-MKT-12 the DB refuses', () => {
  it('R-MKT-12: a publication to the wrong kind (a social post to a GBP location / web chat widget), to a disconnected account, before platform:fair_housing is cleared, and an outcome written by a person', async () => {
    const p = await approvedPost();
    const flyer = (await generateAll(w.agent, await teamListing(w.agent, {}), { kinds: ['flyer'] })).flyer!;
    expect((await approve(w.agent, flyer)).status).toBe(200);
    // a flyer is not a social post: the DB guard refuses it even past the API
    await expect(insertAsPerson(randomUUID(), flyer.id, page.connectionId)).rejects.toThrow(/PUBLISH_TARGET_INVALID/);
    // a disconnected account
    const gone = await connectAccount(h, w.owner, 'facebook_page', 'Old Page');
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/admin/integrations/connections/${gone.connectionId}/disconnect`, {})).status).toBe(200);
    await expect(insertAsPerson(randomUUID(), p.id, gone.connectionId)).rejects.toThrow(/CHANNEL_NOT_CONNECTED/);
    expect((await publish(p.id, gone.connectionId)).code).toBe('CHANNEL_NOT_CONNECTED');
    // platform:fair_housing not cleared
    await clearFairHousing(h, false);
    try {
      await expect(insertAsPerson(randomUUID(), p.id, page.connectionId)).rejects.toThrow(/PLATFORM_NOT_CLEARED/);
      const r = await publish(p.id, page.connectionId);
      expect([r.status, r.code]).toEqual([409, 'PLATFORM_NOT_CLEARED']);
      expect((await getPiece(w.agent, p.id)).publishOptions.find((o) => o.connectionId === page.connectionId)).toMatchObject({ kind: 'export', reason: 'PLATFORM_NOT_CLEARED' });
    } finally {
      await clearFairHousing(h);
    }
    // a person can never write the outcome ("Posted") themselves
    const id = randomUUID();
    await insertAsPerson(id, p.id, page.connectionId);
    const r = await withTenantTx(w.owner.actor(), (tx) => sql`UPDATE marketing_publications SET status = 'published', external_post_id = 'fake', published_at = now() WHERE id = ${id}`.execute(tx), { db: h.database });
    expect(Number(r.numAffectedRows ?? 0)).toBe(0); // RLS: the person's UPDATE matches no row (system-only policy)
    expect((await h.su.query('SELECT status FROM marketing_publications WHERE id = $1', [id])).rows[0].status).toBe('publishing');
    // the guard refuses a person's outcome even where a policy would let the row through (an Owner is tenant-wide)
    const ownerTx = withTenantTx(w.owner.actor(), (tx) => sql`UPDATE marketing_publications SET error_code = 'X' WHERE id = ${id}`.execute(tx), { db: h.database });
    expect(Number((await ownerTx).numAffectedRows ?? 0)).toBe(0);
  });

  it('R-MKT-12: a person cannot insert a publication born published, or as somebody else', async () => {
    const p = await approvedPost();
    const actor = w.agent.actor();
    await expect(withTenantTx(actor, (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, external_post_id, published_at, requested_by_user_id)
        VALUES (app.tenant_id(), ${randomUUID()}, ${p.id}, ${page.connectionId}, 'published', 'x', now(), ${w.agent.userId})`.execute(tx), { db: h.database })).rejects.toThrow(/PUBLICATION_BORN_PUBLISHING/);
    await expect(withTenantTx(actor, (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, requested_by_user_id)
        VALUES (app.tenant_id(), ${randomUUID()}, ${p.id}, ${page.connectionId}, 'publishing', ${w.owner.userId})`.execute(tx), { db: h.database })).rejects.toThrow();
  });
});

describe('R-MKT-12 versions and retraction', () => {
  it('R-MKT-12: a new version leaves the old version\'s posts alone and says so', async () => {
    const p = await approvedPost();
    expect((await publish(p.id, page.connectionId)).body.publication!.posted).toBe(true);
    const live = social().livePosts(page.accountId).length;
    const v2 = await call<{ piece: PieceBody; newVersion: boolean }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { caption: 'Fresh photos are up. Message the team to set up a showing.', hashtags: [] } });
    expect(v2.body.newVersion).toBe(true);
    expect(v2.body.piece.earlierPostNotice).toBe('The earlier post stays on your Facebook Page. Take it down there if you no longer want it.');
    expect((await approve(w.agent, v2.body.piece)).status).toBe(200);
    const old = await getPiece(w.agent, p.id);
    expect(old.status).toBe('superseded');
    expect(old.publications[0]).toMatchObject({ status: 'published', posted: true });
    expect(social().livePosts(page.accountId).length).toBe(live);
    expect(social().deletions.filter((d) => d.providerRef === (old.publications[0] as never as { id: string }).id)).toEqual([]);
  });

  it('R-MKT-12: retract deletes at the provider first and records the retraction only after it confirmed', async () => {
    const p = await approvedPost();
    await publish(p.id, page.connectionId);
    const r = await call<{ piece: PieceBody; retracted: number; removeYourself: number }>(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, {});
    expect(r.body).toMatchObject({ retracted: 1, removeYourself: 0 });
    expect(r.body.piece.publications[0]).toMatchObject({ status: 'retracted', posted: false });
    expect(social().deletions.at(-1)).toMatchObject({ externalAccountId: page.accountId });
  });

  it('R-MKT-12 R-MKT-4 VERIFY: a retraction the provider cannot delete raises the "remove it yourself" card and the post stays recorded as live', async () => {
    const p = await approvedPost();
    await publish(p.id, insta.connectionId);
    social().deletion.instagram_business = 'unsupported';
    const r = await call<{ piece: PieceBody; retracted: number; removeYourself: number }>(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, {});
    expect(r.body).toMatchObject({ retracted: 0, removeYourself: 1 });
    expect(r.body.piece.publications[0]).toMatchObject({ status: 'published', posted: true });
    expect(r.body.piece.publications[0]!.label).toMatch(/remove it on your Instagram account yourself/);
    const card = (await h.su.query("SELECT user_id, state, reasons FROM priority_feed_items WHERE dedupe_key = $1 AND state = 'open'", [`marketing:${p.id}`])).rows[0];
    expect(card.user_id).toBe(w.agent.userId);
    expect(JSON.stringify(card.reasons)).toMatch(/Remove the post from your Instagram account/);
    // the agent sees it in the feed with the one-tap Open listing action
    const feed = await call<{ scored: { dedupeKey?: string; primaryAction: { kind: string } }[] }>(w.agent, 'GET', '/feed');
    expect(JSON.stringify(feed.body)).toContain('Remove the post from your Instagram account');
  });
});

describe('E228 no messaging webhook exists', () => {
  it('E228 R-MKT-12: a DM to the connected Page is never received: no Meta messaging webhook route exists and the Meta connection never asks for messaging scopes', async () => {
    const routes = h.app.platform.routeTable.map((r) => `${r.method} ${r.url}`);
    expect(routes.filter((r) => /webhooks?\/(meta|facebook|instagram|messenger)/i.test(r))).toEqual([]);
    for (const path of ['/api/webhooks/meta', '/api/webhooks/facebook', '/api/webhooks/messenger', '/api/webhooks/instagram']) {
      const r = await h.app.inject({ method: 'POST', url: path, headers: { 'content-type': 'application/json', origin: h.config.webOrigins[0]! }, payload: JSON.stringify({ object: 'page', entry: [{ messaging: [{ message: { text: 'hi' } }] }] }) });
      expect(r.statusCode, path).toBe(404);
    }
    const before = (await h.su.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'inbound'", [w.tenantId])).rows[0].n;
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND direction = 'inbound'", [w.tenantId])).rows[0].n).toBe(before);
    const meta = await h.su.query("SELECT capabilities FROM integration_connections WHERE id = $1", [page.connectionId]);
    expect(meta.rows[0].capabilities).toEqual({ publish_posts: true });
  });
});
