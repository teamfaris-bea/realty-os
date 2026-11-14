// Publishing through publishPost (module 29; D2; DATA_MODEL R-MKT-12, R-GATE-15, R-INT-6, R-MKT-4, R-MKT-6; E227, E228).
// Real Postgres (createTestDb via the harness) and the deterministic FakeSocialPublisher; nothing leaves the process.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileMarketing } from './handlers.js';
import { DELETE_POST_TIMEOUT_MS, type PublishDeps, retractAllOf, retractPublication } from './publish.js';
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
  s.beforePublish = null;
  s.afterDelete = null;
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

describe('review fixes (publishing)', () => {
  it('R-MKT-12 R-MKT-6: a social post the agent exported first is still publishable (it stays approved; exported_at records the hand-over)', async () => {
    const p = await approvedPost();
    const ex = await call<{ piece: PieceBody }>(w.agent, 'POST', `/marketing-pieces/${p.id}/export`, {});
    expect(ex.body.piece).toMatchObject({ status: 'approved', statusLabel: 'Exported: post it yourself' });
    expect(ex.body.piece.publishOptions.find((o) => o.connectionId === page.connectionId)).toMatchObject({ kind: 'publish' });
    expect((await publish(p.id, page.connectionId)).body.publication).toMatchObject({ status: 'published', posted: true });
  });

  it('R-MKT-12: two posts of one piece the provider cannot delete each keep their own "remove it yourself" reason on the one card', async () => {
    const p = await approvedPost();
    await publish(p.id, page.connectionId);
    await publish(p.id, insta.connectionId);
    social().deletion = { facebook_page: 'unsupported', instagram_business: 'unsupported', gbp_location: 'supported' };
    const r = await call<{ piece: PieceBody; removeYourself: number }>(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, {});
    expect(r.body.removeYourself).toBe(2);
    expect(r.body.piece.publications.every((x) => /yourself/.test(x.label))).toBe(true);
    const reasons = (await h.su.query("SELECT reasons FROM priority_feed_items WHERE dedupe_key = $1 AND state = 'open'", [`marketing:${p.id}`])).rows[0].reasons as { code: string }[];
    expect(reasons.map((x) => x.code).sort()).toEqual(r.body.piece.publications.map((x) => `REMOVE_POST_YOURSELF:${x.id}`).sort());
    // and the reconcile pass does not ask the provider again for either
    const n = social().deletions.length;
    await call(w.agent, 'PATCH', `/listings/${r.body.piece.listingId}`, { status: 'sold' });
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(social().deletions.length).toBe(n);
  });

  it('R-MKT-12: a retraction request is audited as requested; "retracted" is audited only after the provider confirmed', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, insta.connectionId)).body.publication!;
    social().deletion.instagram_business = 'unsupported';
    await call(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, {});
    const acts = (await h.su.query("SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'marketing.retract%' ORDER BY occurred_at", [pub.id])).rows.map((r) => r.action);
    expect(acts).toEqual(['marketing.retract_requested']);
  });

  it('R-MKT-12: concurrent retractions of one post delete it once and raise no "remove it yourself" card for a post that is gone', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const deps = publishDepsOf(h.app.platform);
    const out = await Promise.all([retractPublication(deps, w.tenantId, pub.id, null), retractPublication(deps, w.tenantId, pub.id, null)]);
    expect(out.map((o) => o.outcome).filter((o) => o === 'retracted')).toHaveLength(1);
    expect(out.map((o) => o.outcome)).not.toContain('remove_yourself');
  });

  it('R-MKT-12 E227: a post the provider confirmed is recorded even if platform:fair_housing became uncleared between TX1 and TX2', async () => {
    const p = await approvedPost();
    social().beforePublish = () => clearFairHousing(h, false);
    try {
      const r = await publish(p.id, page.connectionId);
      expect(r.body.publication).toMatchObject({ status: 'published', posted: true });
    } finally {
      social().beforePublish = null;
      await clearFairHousing(h);
    }
  });

  it('E227: an unknown publication the provider cannot resolve goes to the back of the reconcile queue', async () => {
    const p = await approvedPost();
    social().nextOutcome = 'timeout';
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    social().lookup = 'unsupported';
    const before = (await h.su.query('SELECT updated_at FROM marketing_publications WHERE id = $1', [pub.id])).rows[0].updated_at as Date;
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    const after = (await h.su.query('SELECT updated_at, status FROM marketing_publications WHERE id = $1', [pub.id])).rows[0];
    expect(after.status).toBe('unknown');
    expect((after.updated_at as Date).getTime()).toBeGreaterThan(before.getTime());
  });
});

// ---- races, held deterministically (no luck): an injected provider hook or a held transaction fixes the interleaving ----

/** A promise the test opens by hand. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

interface Backend {
  pid: number;
  q: string;
  app: string;
  wait_event_type: string | null;
  blockers: number[];
}
const backends = async () =>
  (await h.su.query<Backend>(
    `SELECT pid, wait_event_type, query AS q, application_name AS app, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
      WHERE datname = current_database() AND backend_type = 'client backend' AND pid <> pg_backend_pid() AND state <> 'idle'`,
  )).rows;
async function waitFor(label: string, pred: (b: Backend) => boolean): Promise<Backend> {
  for (let i = 0; i < 400; i++) {
    const hit = (await backends()).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(await backends())}`);
}

const postIdOf = async (publicationId: string): Promise<string> => (await h.su.query('SELECT external_post_id FROM marketing_publications WHERE id = $1', [publicationId])).rows[0].external_post_id as string;
const removeCards = async (pieceId: string, publicationId: string): Promise<number> =>
  (await h.su.query("SELECT count(*)::int AS n FROM priority_feed_items f, jsonb_array_elements(f.reasons) x WHERE f.dedupe_key = $1 AND x->>'code' = $2", [`marketing:${pieceId}`, `REMOVE_POST_YOURSELF:${publicationId}`])).rows[0].n as number;
const claimOf = async (publicationId: string) => (await h.su.query('SELECT status, retract_claim_id, retract_claimed_at FROM marketing_publications WHERE id = $1', [publicationId])).rows[0] as { status: string; retract_claim_id: string | null; retract_claimed_at: Date | null };
/** As the system (through RLS and the 0025/0054 guard), exactly as publish.ts writes. */
const asSystemTx = <T>(fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(systemActor(w.tenantId, 'provider'), fn, { db: h.database });
/** "Remove it yourself" reasons for this publication on a card the agent still has open. */
const openRemoveCards = async (pieceId: string, publicationId: string): Promise<number> =>
  (await h.su.query("SELECT count(*)::int AS n FROM priority_feed_items f, jsonb_array_elements(f.reasons) x WHERE f.dedupe_key = $1 AND f.state IN ('open','snoozed') AND x->>'code' = $2", [`marketing:${pieceId}`, `REMOVE_POST_YOURSELF:${publicationId}`])).rows[0].n as number;
/** A fixture clock: the claim is ten minutes old (the guard stamps claim times, so it is bypassed for the fixture only). */
const ageClaim = (publicationId: string) => h.su.query(`SET session_replication_role = replica; UPDATE marketing_publications SET retract_claimed_at = now() - interval '10 minutes' WHERE id = '${publicationId}'; SET session_replication_role = origin;`);
const takeClaim = (publicationId: string) => asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() WHERE id = ${publicationId}`.execute(tx));
/** An 'unknown' publication: the provider made the post but its answer was lost (E227). Returns the provider's post id. */
async function unknownPost(pieceId: string): Promise<{ id: string; ref: string }> {
  social().nextOutcome = 'timeout';
  const pub = (await publish(pieceId, page.connectionId)).body.publication!;
  expect(pub.status).toBe('unknown');
  const ref = [...social().posts.entries()].find(([, v]) => v.pieceId === pieceId && v.externalAccountId === page.accountId)![0];
  return { id: pub.id, ref };
}

/**
 * PublishDeps whose database runs `between` once, after the call's `after`-th transaction committed and before the
 * next one begins (a test hook on the transaction builder; every query still runs through withTenantTx and RLS).
 */
function depsBetweenTransactions(after: number, between: () => Promise<void>): PublishDeps {
  const deps = publishDepsOf(h.app.platform);
  const k = deps.db.kysely;
  let n = 0;
  const kysely = new Proxy(k, {
    get(target, prop) {
      if (prop === 'transaction') {
        return () => {
          n += 1;
          const real = target.transaction();
          if (n !== after + 1) return real;
          // runTx's shape: transaction().setIsolationLevel(level).execute(fn)
          return {
            setIsolationLevel: (l: 'read committed') => ({
              execute: async (fn: never) => {
                await between();
                return real.setIsolationLevel(l).execute(fn);
              },
            }),
          };
        };
      }
      const v = Reflect.get(target, prop, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  return { ...deps, db: { ...deps.db, kysely } };
}

/**
 * Runs retractPublication (as the system) on an 'unknown' publication and, after its first transaction read the row
 * as 'unknown' and before its last one, commits the provider's confirmation (reconcile's lookup or a late answer:
 * 'published' with the post id) and, when `claim` is given, another retraction's claim.
 */
async function retractWhileConfirmed(publicationId: string, ref: string, claim: string | null): Promise<Awaited<ReturnType<typeof retractPublication>>> {
  let confirmed = false;
  const deps = depsBetweenTransactions(1, async () => {
    expect(await claimOf(publicationId)).toMatchObject({ status: 'unknown', retract_claim_id: null });
    // fixture: one statement for what two system transactions write (the guard is bypassed; the CHECKs still hold)
    const r = await h.su.query(
      `SET session_replication_role = replica;
       UPDATE marketing_publications SET status = 'published', external_post_id = '${ref}', published_at = now(), error_code = NULL,
              retract_claim_id = ${claim === null ? 'NULL' : `'${claim}'`}, retract_claimed_at = ${claim === null ? 'NULL' : 'now()'}
        WHERE id = '${publicationId}' AND status = 'unknown';
       SET session_replication_role = origin;`,
    );
    expect((r as unknown as pg.QueryResult[])[1]!.rowCount).toBe(1);
    confirmed = true;
  });
  const out = await retractPublication(deps, w.tenantId, publicationId, null);
  expect(confirmed).toBe(true);
  return out;
}

describe('R-MKT-12 R-GATE-15 races, held deterministically', () => {
  it('R-MKT-12: a retraction that starts while another is held after the provider deleted the post never calls the provider and raises no "remove it yourself" card', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const ref = await postIdOf(pub.id);
    const deps = publishDepsOf(h.app.platform);
    const gate = latch();
    const deleted = latch();
    social().afterDelete = async (d, r) => {
      if (d.providerRef !== ref) return;
      social().afterDelete = null;
      expect(r.kind).toBe('deleted');
      deleted.open();
      await gate.wait; // hold the first caller between the provider's confirmation and its last transaction
    };
    let second: Awaited<ReturnType<typeof retractPublication>>;
    try {
      const first = retractPublication(deps, w.tenantId, pub.id, null);
      await deleted.wait;
      second = await retractPublication(deps, w.tenantId, pub.id, null);
      gate.open();
      expect((await first).outcome).toBe('retracted');
    } finally {
      social().afterDelete = null;
      gate.open();
    }
    expect(second.outcome).toBe('in_progress');
    expect(social().deletions.filter((d) => d.providerRef === ref)).toHaveLength(1);
    expect(await removeCards(p.id, pub.id)).toBe(0);
    expect(await claimOf(pub.id)).toMatchObject({ status: 'retracted', retract_claim_id: null, retract_claimed_at: null });
    // the post is down now: the single-post route says there is nothing to take down (409), and never calls the provider
    const again = await call(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, { publicationId: pub.id });
    expect([again.status, again.code]).toEqual([409, 'PUBLICATION_NOT_LIVE']);
    expect(social().deletions.filter((d) => d.providerRef === ref)).toHaveLength(1);
  });

  it('R-MKT-12: while one retraction holds its claim, the retract route answers PUBLICATION_RETRACTING and the reconcile pass leaves the post to it', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const deps = publishDepsOf(h.app.platform);
    const gate = latch();
    const inCall = latch();
    social().afterDelete = async () => {
      social().afterDelete = null;
      inCall.open();
      await gate.wait;
    };
    try {
      const first = retractPublication(deps, w.tenantId, pub.id, null);
      await inCall.wait;
      const n = social().deletions.length;
      const r = await call(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, { publicationId: pub.id });
      expect([r.status, r.code]).toEqual([409, 'PUBLICATION_RETRACTING']);
      // take-down-all says the post is already coming down (never "nothing to take down")
      const all = await call<{ retracted: number; removeYourself: number; inProgress: number }>(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, {});
      expect([all.status, all.body.retracted, all.body.removeYourself, all.body.inProgress]).toEqual([200, 0, 0, 1]);
      expect((await call(w.agent, 'PATCH', `/listings/${p.listingId}`, { status: 'sold' })).status).toBe(200);
      // the reconcile pass picks the post (sold listing) and leaves it to the claim holder
      const s = await reconcileMarketing(jobCtx(), deps);
      expect([s.retracted, s.removeYourself, s.inProgress]).toEqual([0, 0, 1]);
      expect(social().deletions.length).toBe(n);
      gate.open();
      expect((await first).outcome).toBe('retracted');
    } finally {
      social().afterDelete = null;
      gate.open();
    }
    expect(await removeCards(p.id, pub.id)).toBe(0);
  });

  it('R-MKT-12: a claim left by a retraction that died is taken again only after the claim window, and the reconcile pass then retracts the post', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const ref = await postIdOf(pub.id);
    const deps = publishDepsOf(h.app.platform);
    // the claim step committed, then the process died before the provider call (no deletion, no last transaction)
    await asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() WHERE id = ${pub.id}`.execute(tx));
    const n = social().deletions.length;
    // a live claim is never taken: no second provider call while the first may still be in flight
    expect((await retractPublication(deps, w.tenantId, pub.id, null)).outcome).toBe('in_progress');
    expect((await call(w.agent, 'PATCH', `/listings/${p.listingId}`, { status: 'sold' })).status).toBe(200);
    expect((await reconcileMarketing(jobCtx(), deps)).retracted).toBe(0);
    expect(social().deletions.length).toBe(n);
    // a fixture clock: the claim is ten minutes old (the guard stamps claim times, so it is bypassed for the fixture only)
    await h.su.query(`SET session_replication_role = replica; UPDATE marketing_publications SET retract_claimed_at = now() - interval '10 minutes' WHERE id = '${pub.id}'; SET session_replication_role = origin;`);
    const s = await reconcileMarketing(jobCtx(), deps);
    expect(s.retracted).toBe(1);
    expect(social().deletions.filter((d) => d.providerRef === ref)).toHaveLength(1);
    expect(social().livePosts(page.accountId)).not.toContain(ref);
    expect(await claimOf(pub.id)).toMatchObject({ status: 'retracted', retract_claim_id: null, retract_claimed_at: null });
    expect(await removeCards(p.id, pub.id)).toBe(0);
  });

  it('R-MKT-12: a retraction the provider cannot do releases its claim with the card, so a later request asks the provider again', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, insta.connectionId)).body.publication!;
    social().deletion.instagram_business = 'unsupported';
    const deps = publishDepsOf(h.app.platform);
    expect((await retractPublication(deps, w.tenantId, pub.id, null)).outcome).toBe('remove_yourself');
    expect(await claimOf(pub.id)).toMatchObject({ status: 'published', retract_claim_id: null, retract_claimed_at: null });
    expect(await removeCards(p.id, pub.id)).toBe(1);
    social().deletion.instagram_business = 'supported';
    const n = social().deletions.length;
    expect((await retractPublication(deps, w.tenantId, pub.id, null)).outcome).toBe('retracted');
    expect(social().deletions.length).toBe(n + 1);
    // the provider took it down after all: the card no longer sends the agent to a post that is gone
    expect(await openRemoveCards(p.id, pub.id)).toBe(0);
  });

  it('R-MKT-12: a confirmed deletion takes only its own post off the "remove it yourself" card; the card closes with its last post', async () => {
    const p = await approvedPost();
    const fb = (await publish(p.id, page.connectionId)).body.publication!;
    const ig = (await publish(p.id, insta.connectionId)).body.publication!;
    social().deletion = { facebook_page: 'unsupported', instagram_business: 'unsupported', gbp_location: 'supported' };
    const deps = publishDepsOf(h.app.platform);
    expect((await retractAllOf(deps, w.tenantId, p.id, null)).removeYourself).toBe(2);
    // the piece's remove-it-yourself card (its review card closed at approval)
    const card = async () =>
      (await h.su.query("SELECT state, reasons FROM priority_feed_items f WHERE dedupe_key = $1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(f.reasons) x WHERE x->>'code' LIKE 'REMOVE_POST_YOURSELF:%') ORDER BY created_at", [`marketing:${p.id}`])).rows as { state: string; reasons: { code: string }[] }[];
    expect((await card()).map((c) => [c.state, c.reasons.map((x) => x.code).sort()])).toEqual([['open', [`REMOVE_POST_YOURSELF:${fb.id}`, `REMOVE_POST_YOURSELF:${ig.id}`].sort()]]);
    social().deletion.facebook_page = 'supported';
    expect((await retractPublication(deps, w.tenantId, fb.id, null)).outcome).toBe('retracted');
    expect((await card()).map((c) => [c.state, c.reasons.map((x) => x.code)])).toEqual([['open', [`REMOVE_POST_YOURSELF:${ig.id}`]]]);
    social().deletion.instagram_business = 'supported';
    expect((await retractPublication(deps, w.tenantId, ig.id, null)).outcome).toBe('retracted');
    expect((await card()).map((c) => c.state)).toEqual(['done']);
    expect((await getPiece(w.agent, p.id)).publications.map((x) => x.status)).toEqual(['retracted', 'retracted']);
  });

  it('R-MKT-12: a person\'s retraction that died after its claim, on a listing still for sale, is finished by the reconcile pass once the claim window has passed', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const ref = await postIdOf(pub.id);
    const deps = publishDepsOf(h.app.platform);
    // the person's claim step committed, then the process died (no provider call, no last transaction)
    await takeClaim(pub.id);
    const n = social().deletions.length;
    // while the claim is live the pass leaves it alone (the retraction may still be in flight)
    const s1 = await reconcileMarketing(jobCtx(), deps);
    expect([s1.retracted, s1.removeYourself]).toEqual([0, 0]);
    expect(social().deletions.length).toBe(n);
    await ageClaim(pub.id);
    const s2 = await reconcileMarketing(jobCtx(), deps);
    expect([s2.retracted, s2.removeYourself]).toEqual([1, 0]);
    expect(social().deletions.filter((d) => d.providerRef === ref)).toHaveLength(1);
    expect(social().livePosts(page.accountId)).not.toContain(ref);
    expect(await claimOf(pub.id)).toMatchObject({ status: 'retracted', retract_claim_id: null, retract_claimed_at: null });
    expect(await removeCards(p.id, pub.id)).toBe(0);
    // the listing is still for sale
    expect((await h.su.query('SELECT status FROM listings WHERE id = $1', [p.listingId])).rows[0].status).not.toMatch(/^(sold|withdrawn|expired)$/);
  });

  it('R-MKT-12: a died retraction is finished by the reconcile pass even when an earlier attempt already raised the card, and the card closes', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, insta.connectionId)).body.publication!;
    const deps = publishDepsOf(h.app.platform);
    social().deletion.instagram_business = 'unsupported';
    expect((await retractPublication(deps, w.tenantId, pub.id, null)).outcome).toBe('remove_yourself');
    expect(await openRemoveCards(p.id, pub.id)).toBe(1);
    // the agent asks again; that retraction's process dies after its claim
    social().deletion.instagram_business = 'supported';
    await takeClaim(pub.id);
    await ageClaim(pub.id);
    const s = await reconcileMarketing(jobCtx(), deps);
    expect([s.retracted, s.removeYourself]).toEqual([1, 0]);
    expect(await claimOf(pub.id)).toMatchObject({ status: 'retracted', retract_claim_id: null });
    expect(await openRemoveCards(p.id, pub.id)).toBe(0);
  });

  it('R-MKT-12: a provider deletion that never answers is given up after a bound well inside the claim window: the card is raised and the claim released', async () => {
    const window = (await h.su.query('SELECT extract(epoch FROM app.marketing_retract_claim_window()) * 1000 AS ms')).rows[0].ms as number;
    expect(DELETE_POST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DELETE_POST_TIMEOUT_MS * 4).toBeLessThanOrEqual(Number(window));
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const hang = latch();
    social().afterDelete = async () => {
      social().afterDelete = null;
      await hang.wait; // the provider never answers
    };
    try {
      const t0 = Date.now();
      const out = await retractPublication({ ...publishDepsOf(h.app.platform), deleteTimeoutMs: 300 }, w.tenantId, pub.id, null);
      expect(out.outcome).toBe('remove_yourself');
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      social().afterDelete = null;
      hang.open();
    }
    expect(await claimOf(pub.id)).toMatchObject({ status: 'published', retract_claim_id: null, retract_claimed_at: null });
    expect(await openRemoveCards(p.id, pub.id)).toBe(1);
  }, 15_000);

  it('R-MKT-12: a claim carries the time it was taken, not the start of a transaction that waited first', async () => {
    const p = await approvedPost();
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    const started = await asSystemTx(async (tx) => {
      const t = (await sql<{ t: Date }>`SELECT now() AS t`.execute(tx)).rows[0]!.t;
      await sql`SELECT pg_sleep(1.2)`.execute(tx); // e.g. a wait for the row lock
      await sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() WHERE id = ${pub.id}`.execute(tx);
      return t;
    });
    expect((await claimOf(pub.id)).retract_claimed_at!.getTime() - started.getTime()).toBeGreaterThanOrEqual(1_000);
  });

  it('R-MKT-12: an "unknown" post that is confirmed and claimed by another retraction while this one decides is left to that one: no card, no provider call', async () => {
    const p = await approvedPost();
    const u = await unknownPost(p.id);
    const n = social().deletions.length;
    const out = await retractWhileConfirmed(u.id, u.ref, randomUUID());
    expect(out.outcome).toBe('in_progress');
    expect(await removeCards(p.id, u.id)).toBe(0);
    expect(social().deletions.length).toBe(n);
  });

  it('R-MKT-12: an "unknown" post that is confirmed while its retraction decides is deleted at the provider, not handed to the agent', async () => {
    const p = await approvedPost();
    const u = await unknownPost(p.id);
    const out = await retractWhileConfirmed(u.id, u.ref, null);
    expect(out.outcome).toBe('retracted');
    expect(social().deletions.filter((d) => d.providerRef === u.ref)).toHaveLength(1);
    expect(social().livePosts(page.accountId)).not.toContain(u.ref);
    expect(await removeCards(p.id, u.id)).toBe(0);
    expect(await claimOf(u.id)).toMatchObject({ status: 'retracted', retract_claim_id: null });
  });

  it('R-MKT-12: the DB keeps the retraction claim the system\'s: never born with the row, only on a provider-confirmed post, never replaced while live, its time the DB\'s', async () => {
    const p = await approvedPost();
    // born with a claim: refused like any other outcome on insert
    await expect(withTenantTx(w.agent.actor(), (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, requested_by_user_id, retract_claim_id, retract_claimed_at)
        VALUES (app.tenant_id(), ${randomUUID()}, ${p.id}, ${page.connectionId}, 'publishing', ${w.agent.userId}, ${randomUUID()}, now())`.execute(tx), { db: h.database })).rejects.toThrow(/PUBLICATION_BORN_PUBLISHING/);
    // a claim on an attempt the provider never confirmed
    const attempt = randomUUID();
    await insertAsPerson(attempt, p.id, insta.connectionId);
    await expect(asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() WHERE id = ${attempt}`.execute(tx))).rejects.toThrow(/PUBLICATION_RETRACT_CLAIM:/);
    // a provider-confirmed post: one claim; a second one while it is live is refused; the claim time is the DB's
    const pub = (await publish(p.id, page.connectionId)).body.publication!;
    await asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() - interval '1 hour' WHERE id = ${pub.id}`.execute(tx));
    const c1 = await claimOf(pub.id);
    expect(Date.now() - c1.retract_claimed_at!.getTime()).toBeLessThan(60_000);
    await expect(asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${randomUUID()}, retract_claimed_at = now() WHERE id = ${pub.id}`.execute(tx))).rejects.toThrow(/PUBLICATION_RETRACT_CLAIMED/);
    await expect(asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claimed_at = now() - interval '1 hour' WHERE id = ${pub.id}`.execute(tx))).rejects.toThrow(/PUBLICATION_RETRACT_CLAIM:/);
    // a person never writes it, even an Owner (RLS: the system-only UPDATE policy; the guard behind it)
    const byOwner = await withTenantTx(w.owner.actor(), (tx) => sql`UPDATE marketing_publications SET retract_claim_id = NULL, retract_claimed_at = NULL WHERE id = ${pub.id}`.execute(tx), { db: h.database });
    expect(Number(byOwner.numAffectedRows ?? 0)).toBe(0);
    expect((await claimOf(pub.id)).retract_claim_id).toBe(c1.retract_claim_id);
    // a stale claim may be taken again
    await h.su.query(`SET session_replication_role = replica; UPDATE marketing_publications SET retract_claimed_at = now() - interval '10 minutes' WHERE id = '${pub.id}'; SET session_replication_role = origin;`);
    const c2 = randomUUID();
    await asSystemTx((tx) => sql`UPDATE marketing_publications SET retract_claim_id = ${c2}, retract_claimed_at = now() WHERE id = ${pub.id}`.execute(tx));
    expect((await claimOf(pub.id)).retract_claim_id).toBe(c2);
  });

  it('R-MKT-12: a tap whose TX1 holds the piece while the first tap records its confirmed post is refused (409 PUBLICATION_ALREADY_LIVE), never deadlocked into a 500', async () => {
    const p = await approvedPost();
    const n = social().published.length;
    const locker = new pg.Client({ connectionString: h.testDb.ownerUrl, application_name: 'publish-race-locker' });
    await locker.connect();
    let second = null as ReturnType<typeof publish> | null;
    social().beforePublish = async () => {
      social().beforePublish = null;
      // the first tap's TX1 committed its 'publishing' row. Hold the second tap's TX1 after it locked the piece (its
      // next read, platform:fair_housing, waits on the table lock) and before its INSERT
      await locker.query('BEGIN');
      await locker.query('LOCK TABLE jurisdiction_packs IN ACCESS EXCLUSIVE MODE');
      second = publish(p.id, page.connectionId);
      await waitFor('the second TX1 at the pack lock', (b) => b.wait_event_type === 'Lock' && /platform_cleared/.test(b.q));
      await expect(h.su.query('SELECT 1 FROM marketing_pieces WHERE id = $1 FOR KEY SHARE NOWAIT', [p.id])).rejects.toThrow(/could not obtain lock/);
    };
    try {
      const first = publish(p.id, page.connectionId);
      // the first tap's TX2 (as the system) waits for the piece the second tap's TX1 holds
      await waitFor('the first TX2 at the piece', (b) => b.wait_event_type === 'Lock' && /marketing_pieces/.test(b.q) && b.app !== 'publish-race-locker' && !/platform_cleared/.test(b.q));
      // past deadlock_timeout (1 s): that wait's one deadlock check has run and found no cycle yet
      await new Promise((r) => setTimeout(r, 1_300));
      await locker.query('COMMIT');
      const [a, b] = await Promise.all([first, second!]);
      expect([a.status, a.body.publication?.status]).toEqual([200, 'published']);
      expect([b.status, b.code]).toEqual([409, 'PUBLICATION_ALREADY_LIVE']);
    } finally {
      social().beforePublish = null;
      await locker.query('ROLLBACK').catch(() => undefined);
      await locker.end();
    }
    expect(social().published.length).toBe(n + 1);
    expect((await h.su.query("SELECT count(*)::int AS n FROM marketing_publications WHERE piece_id = $1 AND status IN ('publishing','published','unknown')", [p.id])).rows[0].n).toBe(1);
  }, 30_000);
});

// ---- module 53: the gbp_location branch (flagged edit) ------------------------------------------------------------

describe('module 53: a GBP post publishes through publishPost to a GBP location (R-GBP-2, R-GBP-3)', () => {
  const D11 = ['platform:fair_housing', 'platform:coaching', 'platform:gmail', 'platform:voice', 'platform:avm', 'platform:review_requests'];
  const packs = (keys: string[], on: boolean) => h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${on ? 'now()' : 'NULL'} WHERE key = ANY($1::text[]) AND status = 'published'`, [keys]);
  let loc: { connectionId: string; accountId: string };
  const gbp = () => h.providers.gbp;

  beforeAll(async () => {
    const accountId = `loc-${randomUUID().slice(0, 8)}`;
    const { connectFlow } = await import('../integrations/testing.js');
    const f = await connectFlow(h, w.owner, 'gbp_location', { externalAccountId: accountId, displayName: 'Example Realty Team location' }, [{ id: accountId }]);
    if (f.cb.result !== 'CONNECTED') throw new Error(`connect gbp: ${f.cb.result}`);
    loc = { connectionId: f.connectionId, accountId };
  });
  afterAll(async () => {
    await packs(['platform:gbp'], false);
    await packs(D11, false);
    await clearFairHousing(h);
  });
  beforeEach(() => {
    gbp().nextPublish = 'published';
    gbp().deletion = 'supported';
  });

  async function approvedGbpPost(): Promise<PieceBody> {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['gbp_post'] })).gbp_post!;
    const a = await approve(w.agent, p);
    if (a.status !== 200) throw new Error(`approve gbp: ${JSON.stringify(a.body)}`);
    return a.body.piece;
  }
  const rows = async (pieceId: string) => (await h.su.query('SELECT status, external_post_id FROM marketing_publications WHERE piece_id = $1 ORDER BY requested_at', [pieceId])).rows;

  it('R-GBP-2: a GBP post is generated only on explicit request; the default kinds stay Phase 2\'s', async () => {
    const l = await teamListing(w.agent, {});
    expect(Object.keys(await generateAll(w.agent, l)).sort()).toEqual(['flyer', 'marketplace_export', 'open_house_invite', 'social_post', 'website_page']);
    const p = (await generateAll(w.agent, l, { kinds: ['gbp_post'] })).gbp_post!;
    expect(p).toMatchObject({ kind: 'gbp_post', status: 'draft' });
  });

  it('b15 (b14 low j): this suite\'s D11 list is DEPLOY\'s D11 command\'s keys (six since 0091: platform:portal is not recorded by it)', () => {
    const block = readFileSync(new URL('../../../../docs/DEPLOY.md', import.meta.url), 'utf8').split('**Owner decision D11')[1]!;
    const keys = /--keys (\S+)/.exec(block)![1]!.split(',').map((k) => k.split('@')[0]);
    expect(keys).toHaveLength(6);
    expect([...D11].sort()).toEqual([...keys].sort());
  });

  it('E460 R-GBP-3: with D11\'s six packs recorded and platform:gbp not, a GBP post is export-only, the API refuses to publish with nothing inserted or called, and the database refuses a forced row', async () => {
    await packs(D11, true);
    const p = await approvedGbpPost();
    expect(p.publishOptions).toEqual([{ kind: 'export', connectionId: loc.connectionId, reason: 'PLATFORM_NOT_CLEARED', sentence: 'Google Business Profile posts stay off until counsel reviews them. Export it and copy it to your Business Profile yourself.' }]);
    const calls = gbp().calls.length;
    const r = await publish(p.id, loc.connectionId);
    expect([r.status, r.code]).toEqual([409, 'PLATFORM_NOT_CLEARED']);
    expect(await rows(p.id)).toEqual([]);
    expect(gbp().calls.length).toBe(calls);
    // the 0079 gate is the authority: a row the API would not write is refused by the database too
    await expect(
      withTenantTx({ kind: 'user', userId: w.agent.userId!, tenantId: w.agent.tenantId!, role: 'agent', sessionId: 's' }, (tx) => sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, requested_by_user_id) VALUES (app.tenant_id(), ${randomUUID()}, ${p.id}, ${loc.connectionId}, app.user_id())`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/PLATFORM_NOT_CLEARED: publishing to a Google Business Profile location waits for counsel review of the platform:gbp pack/);
    // exporting stays open
    expect((await call(w.agent, 'POST', `/marketing-pieces/${p.id}/export`)).status).toBe(200);
  });

  it('R-GBP-2 R-MKT-12: with platform:gbp also recorded, the approved GBP post goes to the fake location through publishPost; "Posted" only for the confirmed row', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    expect(p.publishOptions).toEqual([{ kind: 'publish', connectionId: loc.connectionId, target: 'gbp_location', displayName: 'Example Realty Team location' }]);
    const r = await publish(p.id, loc.connectionId);
    expect(r.status).toBe(200);
    expect(r.body.publication).toMatchObject({ status: 'published', posted: true, targetKind: 'gbp_location', label: 'Posted to your Google Business Profile' });
    expect(gbp().published.at(-1)).toMatchObject({ target: 'gbp_location', externalAccountId: loc.accountId, pieceId: p.id });
    expect(gbp().published.at(-1)!.text).toContain('Harbor Realty LLC');
    expect(await rows(p.id)).toEqual([{ status: 'published', external_post_id: expect.stringMatching(/^fake-gbp-post-/) }]);
    const piece = await getPiece(w.agent, p.id);
    expect(piece).toMatchObject({ status: 'published', statusLabel: 'Posted: see each account below' });
    expect(piece.publishOptions[0]).toMatchObject({ kind: 'export', reason: 'ALREADY_LIVE' });
    // a Meta account never sees the GBP post
    expect(social().published.some((x) => x.pieceId === p.id)).toBe(false);
  });

  it('R-GBP-2 R-MKT-12: a GBP post goes only to a GBP location and a social post only to Meta (PUBLISH_TARGET_INVALID, nothing inserted)', async () => {
    await packs(['platform:gbp'], true);
    const g = await approvedGbpPost();
    const s = await approvedPost();
    expect(await publish(g.id, page.connectionId)).toMatchObject({ status: 422, code: 'PUBLISH_TARGET_INVALID' });
    expect(await publish(s.id, loc.connectionId)).toMatchObject({ status: 422, code: 'PUBLISH_TARGET_INVALID' });
    expect([...(await rows(g.id)), ...(await rows(s.id))]).toEqual([]);
    expect(s.publishOptions.some((o) => o.connectionId === loc.connectionId)).toBe(false);
  });

  it('R-GBP-2: a post Google does not take (the rendered text is over its limit, VERIFY) is failed with the code, never "Posted"; the piece stays approved', async () => {
    await packs(['platform:gbp'], true);
    const l = await teamListing(w.agent, {});
    const d = (await generateAll(w.agent, l, { kinds: ['gbp_post'] })).gbp_post!;
    const long = 'A bright home near the water with room to grow and a quiet street. '.repeat(21).trim(); // ≤ 1500 as prose; the rendering adds facts and identity
    const patched = await call<{ piece: PieceBody }>(w.agent, 'PATCH', `/marketing-pieces/${d.id}`, { prose: { body: long } });
    const p = (await approve(w.agent, patched.body.piece)).body.piece;
    const r = await publish(p.id, loc.connectionId);
    expect(r.body.publication).toMatchObject({ status: 'failed', posted: false });
    expect(r.body.publication!.label).not.toMatch(/posted/i);
    expect((await h.su.query('SELECT error_code FROM marketing_publications WHERE piece_id = $1', [p.id])).rows).toEqual([{ error_code: 'POST_TOO_LONG' }]);
    expect((await getPiece(w.agent, p.id)).status).toBe('approved');
  });

  it('E462 E227 R-GBP-2: a timed-out GBP post is unknown ("Check your Google Business Profile"), never re-posted; the reconcile lookup goes through deps.gbp, and only while platform:gbp is cleared', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    gbp().nextPublish = 'timeout';
    const r = await publish(p.id, loc.connectionId);
    expect(r.body.publication).toMatchObject({ status: 'unknown', posted: false, label: expect.stringMatching(/^Check your Google Business Profile: we didn't hear back/) });
    const posts = gbp().published.length;
    await packs(['platform:gbp'], false);
    const looks = gbp().calls.filter((c) => c === 'lookupPost').length;
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(gbp().calls.filter((c) => c === 'lookupPost').length).toBe(looks);
    expect((await rows(p.id))[0]!.status).toBe('unknown');
    await packs(['platform:gbp'], true);
    await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(gbp().calls.filter((c) => c === 'lookupPost').length).toBe(looks + 1);
    expect(await rows(p.id)).toEqual([{ status: 'published', external_post_id: expect.stringMatching(/^fake-gbp-post-/) }]);
    expect(gbp().published.length).toBe(posts);
  });

  it('R-MKT-12: two concurrent taps for the same GBP post and location make one live row and one provider call', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    const n = gbp().published.length;
    const [a, b] = await Promise.all([publish(p.id, loc.connectionId), publish(p.id, loc.connectionId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(gbp().published.length).toBe(n + 1);
  });

  it('R-GBP-3 R-MKT-12: the system takes a live GBP post down through deps.gbp, even after platform:gbp went uncleared; an API that cannot delete it raises "remove it yourself"', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    await publish(p.id, loc.connectionId);
    const pub = (await getPiece(w.agent, p.id)).publications[0]!;
    await packs(['platform:gbp'], false);
    expect(await retractPublication(publishDepsOf(h.app.platform), w.tenantId, pub.id, null)).toEqual({ outcome: 'retracted' });
    expect(gbp().deletions.at(-1)).toMatchObject({ target: 'gbp_location', externalAccountId: loc.accountId });
    await packs(['platform:gbp'], true);
    const q = await approvedGbpPost();
    await publish(q.id, loc.connectionId);
    gbp().deletion = 'unsupported';
    expect(await retractPublication(publishDepsOf(h.app.platform), w.tenantId, (await getPiece(w.agent, q.id)).publications[0]!.id, null)).toEqual({ outcome: 'remove_yourself' });
  });

  it('E463 R-MKT-12 R-GBP-3: a listing that goes off market takes its live GBP post down through deps.gbp once Google confirms, even while platform:gbp is uncleared; a person\'s own retraction then calls nothing; an API that cannot delete it raises "remove it yourself"', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    await publish(p.id, loc.connectionId);
    const pub = (await getPiece(w.agent, p.id)).publications[0]!;
    await packs(['platform:gbp'], false);
    // a person's retraction while platform:gbp is uncleared: no provider call (R-GBP-3), the card instead
    const before = gbp().deletions.length;
    const mine = await call<{ removeYourself?: number }>(w.agent, 'POST', `/marketing-pieces/${p.id}/retract`, { publicationId: pub.id });
    expect(mine.status).toBe(200);
    expect(gbp().deletions.length).toBe(before);
    expect((await h.su.query('SELECT status FROM marketing_publications WHERE id = $1', [pub.id])).rows[0]).toEqual({ status: 'published' });
    // the listing must come down: the system's pass deletes it at Google and records it only after Google confirmed
    // (a post the agent already holds a "remove it yourself" card for is left to them, as in module 29: another post)
    await packs(['platform:gbp'], true);
    const p2 = await approvedGbpPost();
    await publish(p2.id, loc.connectionId);
    const pub2 = (await getPiece(w.agent, p2.id)).publications[0]!;
    await packs(['platform:gbp'], false);
    const l = (await h.su.query<{ listing_id: string }>('SELECT listing_id FROM marketing_pieces WHERE id = $1', [p2.id])).rows[0]!.listing_id;
    expect((await call(w.agent, 'PATCH', `/listings/${l}`, { status: 'sold' })).status).toBe(200);
    const s = await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(s.retracted).toBeGreaterThanOrEqual(1);
    expect(gbp().deletions.at(-1)).toMatchObject({ target: 'gbp_location', externalAccountId: loc.accountId });
    expect((await h.su.query('SELECT status FROM marketing_publications WHERE id = $1', [pub2.id])).rows[0]).toEqual({ status: 'retracted' });
    // Google cannot delete it: "remove it yourself"
    await packs(['platform:gbp'], true);
    const q = await approvedGbpPost();
    await publish(q.id, loc.connectionId);
    gbp().deletion = 'unsupported';
    const ql = (await h.su.query<{ listing_id: string }>('SELECT listing_id FROM marketing_pieces WHERE id = $1', [q.id])).rows[0]!.listing_id;
    expect((await call(w.agent, 'PATCH', `/listings/${ql}`, { status: 'sold' })).status).toBe(200);
    expect((await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform))).removeYourself).toBeGreaterThanOrEqual(1);
    expect((await getPiece(w.agent, q.id)).publications[0]!.label).toMatch(/remove it on your Google Business Profile yourself/);
  });

  it('E461 R-GBP-3: with no Google Business Profile adapter on the platform (production), publishing answers GBP_NOT_CONFIGURED before anything is inserted; nothing is looked up or deleted', async () => {
    await packs(['platform:gbp'], true);
    const p = await approvedGbpPost();
    await publish(p.id, loc.connectionId);
    const live = (await getPiece(w.agent, p.id)).publications[0]!;
    const q = await approvedGbpPost();
    const { UnconfiguredGbp } = await import('../gbp/provider.js');
    const fake = h.providers.gbp;
    (h.providers as { gbp: unknown }).gbp = new UnconfiguredGbp();
    try {
      const r = await publish(q.id, loc.connectionId);
      expect([r.status, r.code]).toEqual([409, 'GBP_NOT_CONFIGURED']);
      expect(await rows(q.id)).toEqual([]);
      expect(await retractPublication(publishDepsOf(h.app.platform), w.tenantId, live.id, null)).toEqual({ outcome: 'remove_yourself' });
    } finally {
      (h.providers as { gbp: unknown }).gbp = fake;
    }
    expect(fake.deletions.some((d) => d.providerRef === (live as { externalPostId?: string }).externalPostId)).toBe(false);
  });
});
