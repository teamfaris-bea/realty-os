// The public listing page, the approval CHECK and the reconcile handler's take-downs (module 29; DATA_MODEL R-MKT-1,
// R-MKT-4, R-MKT-7, R-MKT-9, R-GATE-12, R-INT-6; E91, E92). Real Postgres; fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { marketingReady } from '../bulk/testing.js';
import { composeHumanMessage } from '../comms/compose.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { ownedContact } from '../comms/testing.js';
import { suFixture } from '../leads/testing.js';
import { mlsConnection } from '../mls/testing.js';
import { systemActor } from '../worker/systemActor.js';
import type { StandaloneJobContext } from '../worker/types.js';
import { reconcileMarketing } from './handlers.js';
import { publishDepsOf } from './routes.js';
import { type MarketingWorld, type PieceBody, PNG_1X1, approve, call, clearFairHousing, connectAccount, generateAll, getPiece, marketingWorld, publicPage, teamListing, uploadImage } from './testing.js';

let h: ApiHarness;
let w: MarketingWorld;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await marketingWorld(h);
  await marketingReady(h, w);
  await clearFairHousing(h);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

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

async function livePage(o: { image?: boolean } = {}): Promise<{ piece: PieceBody; listingId: string; path: string }> {
  const listingId = await teamListing(w.agent, {});
  let p = (await generateAll(w.agent, listingId, { kinds: ['website_page'] })).website_page!;
  if (o.image) {
    const up = await uploadImage(w.agent, listingId, PNG_1X1);
    p = (await call<{ piece: PieceBody }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [up.objectId] })).body.piece;
  }
  expect((await approve(w.agent, p)).status).toBe(200);
  const pub = await call<{ piece: PieceBody }>(w.agent, 'POST', `/marketing-pieces/${p.id}/publish`, {});
  expect(pub.status).toBe(200);
  return { piece: pub.body.piece, listingId, path: pub.body.piece.publicPath! };
}

describe('R-MKT-7 the public page is served only through app.public_listing_page', () => {
  it('R-MKT-7: the page shows the approved prose, the bound facts, the identity block and the piece\'s own images, never contact data', async () => {
    const lp = await livePage({ image: true });
    const contact = await ownedContact(w.agent, { firstName: 'Zebulon' });
    await call(w.agent, 'POST', `/listings/${lp.listingId}/contacts`, { contactId: contact.id, role: 'seller' }).catch(() => undefined);
    const r = await publicPage(h, lp.path);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['content-security-policy']).not.toMatch(/script-src/);
    expect(r.body).toContain('Harbor Realty LLC');
    expect(r.body).toContain('License #BRK-0042');
    expect(r.body).toContain('Equal Housing Opportunity');
    expect(r.body).toContain(String(lp.piece.prose['headline']));
    expect(r.body).not.toContain('Zebulon');
    expect(r.body).not.toContain(contact.email);
    expect(r.body).not.toContain('<script');
    const img = await publicPage(h, `${lp.path}/photos/1`);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect((await publicPage(h, `${lp.path}/photos/2`)).statusCode).toBe(404);
  });

  it('R-MKT-7 R-TEN-12: the definer answers only by both slugs; a draft, an approved-not-published page, a wrong tenant slug and bad slug shapes are 404', async () => {
    const lp = await livePage();
    const [, , tenant, slug] = lp.path.split('/');
    expect((await publicPage(h, `/p/${tenant}/does-not-exist`)).statusCode).toBe(404);
    expect((await publicPage(h, `/p/other-tenant-x/${slug}`)).statusCode).toBe(404);
    expect((await publicPage(h, `/p/${tenant}/${slug}%27%20OR%201=1`)).statusCode).toBe(404);
    expect((await publicPage(h, `/p/${tenant}/..%2F..%2Fetc`)).statusCode).toBe(404);
    // the definer itself: minimal columns, nothing for an unknown pair
    const r = await withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => sql<Record<string, unknown>>`SELECT * FROM app.public_listing_page(${tenant}, ${slug})`.execute(tx), { db: h.database });
    expect(Object.keys(r.rows[0]!)).not.toContain('listing_agent_user_id');
    expect(JSON.stringify(r.rows[0])).not.toMatch(/@/);
  });

  it('R-MKT-7 R-INT-6: a later unreviewed fair-housing pack takes every page down (404) until it is cleared again', async () => {
    const lp = await livePage();
    await clearFairHousing(h, false);
    try {
      expect((await publicPage(h, lp.path)).statusCode).toBe(404);
    } finally {
      await clearFairHousing(h);
    }
    expect((await publicPage(h, lp.path)).statusCode).toBe(200);
  });

  it('R-MKT-7: a retracted page is 410 with its notice', async () => {
    const lp = await livePage();
    const r = await call<{ piece: PieceBody }>(w.agent, 'POST', `/marketing-pieces/${lp.piece.id}/retract`, {});
    expect(r.body.piece.status).toBe('retracted');
    const g = await publicPage(h, lp.path);
    expect(g.statusCode).toBe(410);
    expect(g.body).toContain('This page was taken down.');
    expect((await publicPage(h, `${lp.path}/photos/1`)).statusCode).toBe(410);
  });

  it('R-MKT-7: abuse limits: the page is rate-limited per IP (429) and slugs are shape-checked before any query', async () => {
    const lp = await livePage();
    const ip = '198.18.0.77';
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await publicPage(h, lp.path, ip)).statusCode;
    expect(last).toBe(429);
    expect((await publicPage(h, lp.path, '198.18.0.78')).statusCode).toBe(200);
  });
});

describe('E91 R-MKT-9 a listing goes off market', () => {
  it('E91 R-MKT-9 R-MKT-7: withdrawn with invites unsent: the invites are canceled, the page is 410 and says so, exports are flagged "may be out of date"', async () => {
    const lp = await livePage();
    const inv = (await generateAll(w.agent, lp.listingId, { kinds: ['open_house_invite', 'flyer'] }));
    expect((await approve(w.agent, inv.open_house_invite!)).status).toBe(200);
    expect((await approve(w.agent, inv.flyer!)).status).toBe(200);
    // an invite that is still unsent (scheduled), through the one send path
    const c = await ownedContact(w.agent, { consent: false });
    const queued = await composeHumanMessage(w.agent.actor(), c.id, { channel: 'email', subject: 'Open house', body: 'Come by.', idempotencyKey: `inv-${randomUUID()}`, scheduleAt: new Date(Date.now() + 86_400_000).toISOString(), purposeOverride: 'marketing', marketingPieceId: inv.open_house_invite!.id }, depsFromPlatform(h.app.platform));
    expect(queued.message?.status).toBe('scheduled');
    expect((await call(w.agent, 'PATCH', `/listings/${lp.listingId}`, { status: 'withdrawn' })).status).toBe(200);
    const g = await publicPage(h, lp.path);
    expect(g.statusCode).toBe(410);
    expect(g.body).toContain('This home is no longer for sale.');
    const ex = await call<{ export: { label: string; flags: string[] } }>(w.agent, 'POST', `/marketing-pieces/${inv.flyer!.id}/export`, {});
    expect(ex.body.export.flags).toEqual(['may_be_out_of_date']);
    expect(ex.body.export.label).toMatch(/May be out of date/);
    // no new invites go out, and the unsent one is canceled by the reconcile pass
    const send = await call(w.agent, 'POST', `/marketing-pieces/${inv.open_house_invite!.id}/invite/send`, { recipientContactIds: [c.id] });
    expect(send.code).toBe('LISTING_OFF_MARKET');
    const s = await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
    expect(s.invitesCanceled).toBeGreaterThanOrEqual(1);
    expect((await h.su.query('SELECT status, status_reason FROM messages WHERE id = $1', [queued.message!.id])).rows[0]).toEqual({ status: 'canceled', status_reason: 'LISTING_OFF_MARKET' });
  });

  it('R-MKT-9: the reconcile handler cancels unsent invites of an off-market listing and retracts its external posts (or raises the remove-it-yourself card)', async () => {
    const page = await connectAccount(h, w.owner, 'facebook_page');
    const insta = await connectAccount(h, w.owner, 'instagram_business');
    const l = await teamListing(w.agent, {});
    let p = (await generateAll(w.agent, l, { kinds: ['social_post'] })).social_post!;
    const up = await uploadImage(w.agent, l, PNG_1X1);
    p = (await call<{ piece: PieceBody }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { assetObjectIds: [up.objectId] })).body.piece;
    expect((await approve(w.agent, p)).status).toBe(200);
    expect((await call(w.agent, 'POST', `/marketing-pieces/${p.id}/publish`, { connectionId: page.connectionId })).status).toBe(200);
    expect((await call(w.agent, 'POST', `/marketing-pieces/${p.id}/publish`, { connectionId: insta.connectionId })).status).toBe(200);
    h.providers.integrations.social.deletion.instagram_business = 'unsupported';
    try {
      expect((await call(w.agent, 'PATCH', `/listings/${l}`, { status: 'sold' })).status).toBe(200);
      const s = await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
      expect(s.retracted).toBeGreaterThanOrEqual(1);
      expect(s.removeYourself).toBeGreaterThanOrEqual(1);
      const after = await getPiece(w.agent, p.id);
      expect(after.publications.find((x) => x.targetKind === 'facebook_page')).toMatchObject({ status: 'retracted', posted: false });
      expect(after.publications.find((x) => x.targetKind === 'instagram_business')).toMatchObject({ status: 'published', posted: true });
      // asked once: a second pass does not try the provider again for the same post
      const n = h.providers.integrations.social.deletions.length;
      await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
      expect(h.providers.integrations.social.deletions.length).toBe(n);
    } finally {
      h.providers.integrations.social.deletion.instagram_business = 'supported';
    }
  });
});

describe('R-MKT-4 an identity or pack change re-renders live pieces', () => {
  it('R-MKT-4: a live page that no longer passes (the licence number was removed) is taken down within one reconcile pass and needs a new version', async () => {
    const lp = await livePage();
    expect((await publicPage(h, lp.path)).statusCode).toBe(200);
    await suFixture(h, [{ text: 'UPDATE tenant_settings SET brokerage_license_number = NULL WHERE tenant_id = $1', values: [w.tenantId] }]);
    try {
      // not served at once (the live re-check), and taken down by the reconcile pass
      expect((await publicPage(h, lp.path)).statusCode).toBe(404);
      const s = await reconcileMarketing(jobCtx(), publishDepsOf(h.app.platform));
      expect(s.pagesTakenDown).toBeGreaterThanOrEqual(1);
      expect((await getPiece(w.agent, lp.piece.id)).status).toBe('retracted');
      expect((await publicPage(h, lp.path)).statusCode).toBe(410);
    } finally {
      await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_license_number = 'BRK-0042' WHERE tenant_id = $1", values: [w.tenantId] }]);
    }
  });
});

describe('R-MKT-1 the DB refuses approval', () => {
  /** A direct approval UPDATE as the person (past the API), so only the DB CHECK and trigger decide. */
  const approveRaw = async (pieceId: string, guard: unknown) =>
    withTenantTx(w.agent.actor(), async (tx) => {
      await sql`UPDATE marketing_pieces SET guard_result = ${JSON.stringify(guard)}::jsonb WHERE id = ${pieceId}`.execute(tx);
      await sql`UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = ${w.agent.userId}, approved_at = now() WHERE id = ${pieceId}`.execute(tx);
    }, { db: h.database });

  it('R-MKT-1 R-GATE-12 R-FH-1: with a hard fair-housing term, with the brokerage name missing, or with a stale guard result (computed over other content)', async () => {
    const l = await teamListing(w.agent, {});
    const p = (await generateAll(w.agent, l, { kinds: ['social_post'] })).social_post!;
    const good = { content_sha256: p.contentSha256, brokerage_name_present: true, hard_count: 0, hard: [], soft: [], pack_rule_failures: [], numeral_issues: [], lexicon_version: 'fh/1', fair_housing_reviewed: true };
    await expect(approveRaw(p.id, { ...good, hard_count: 1, hard: [{ term_id: 'familial', text: 'young families' }] })).rejects.toThrow(/check constraint/);
    await expect(approveRaw(p.id, { ...good, brokerage_name_present: false })).rejects.toThrow(/check constraint/);
    await expect(approveRaw(p.id, { ...good, content_sha256: 'a'.repeat(64) })).rejects.toThrow(/check constraint/);
    await expect(approveRaw(p.id, { ...good, pack_rule_failures: [{ rule_id: 'license_number', pack_id: 'US', reason: 'x' }] })).rejects.toThrow(/check constraint/);
    await expect(approveRaw(p.id, {})).rejects.toThrow(/check constraint/);
    // the same, after the content changed under a once-valid result: stale
    await withTenantTx(w.agent.actor(), (tx) => sql`UPDATE marketing_pieces SET guard_result = ${JSON.stringify(good)}::jsonb WHERE id = ${p.id}`.execute(tx), { db: h.database });
    await call(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: { caption: 'A new caption for the post. Message us.', hashtags: [] } });
    await expect(approveRaw(p.id, good)).rejects.toThrow(/check constraint/);
    expect((await getPiece(w.agent, p.id)).status).toBe('draft');
  });

  it('E92 R-MKT-1: a pack that requires the brokerage name at least as prominent as the team name, and a flyer that fails it: approval is refused and the reason shown', async () => {
    await h.su.query("UPDATE jurisdiction_packs SET rules = rules || jsonb_build_object('advertising', jsonb_build_object('brokerage_name_at_least_as_prominent_as_team', true)) WHERE key = 'US' AND status = 'published'");
    try {
      const l = await teamListing(w.agent, {});
      const p = (await generateAll(w.agent, l, { kinds: ['flyer'] })).flyer!;
      await h.su.query("UPDATE marketing_pieces SET template_key = 'flyer.team_forward' WHERE id = $1", [p.id]);
      const fresh = await call<{ piece: PieceBody }>(w.agent, 'PATCH', `/marketing-pieces/${p.id}`, { prose: p.prose });
      expect(fresh.body.piece.guard.approvable).toBe(false);
      expect(fresh.body.piece.guard.reasons.join(' ')).toMatch(/must be at least as prominent as the team name/);
      const r = await approve(w.agent, fresh.body.piece);
      expect([r.status, r.code]).toEqual([422, 'MARKETING_GUARD_FAILED']);
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET rules = rules - 'advertising' WHERE key = 'US' AND status = 'published'");
    }
  });

  it('R-MKT-5: an MLS listing never gets marketing (MARKETING_TEAM_LISTING_ONLY)', async () => {
    const id = randomUUID();
    const conn = await mlsConnection(h, w.tenantId, w.owner.userId!);
    await h.su.query(
      "INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, city, region, postal_code, mls_connection_id, mls_modified_at, listing_brokerage_name) VALUES ($1, $2, 'mls', $3, 'active', '9 Other St', 'Charleston', 'SC', '29401', $4, now(), 'Other Brokerage')",
      [w.tenantId, id, `M-${id.slice(0, 6)}`, conn],
    );
    const r = await call(w.owner, 'POST', `/listings/${id}/marketing/generate`, {});
    expect([r.status, r.code]).toEqual([422, 'MARKETING_TEAM_LISTING_ONLY']);
  });
});
