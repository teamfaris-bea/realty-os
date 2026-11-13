// Review sync (module 53): real Postgres through the API harness and the deterministic FakeGbp; nothing leaves the
// process. DATA_MODEL R-GBP-3..5; E460, E461, E467, E468.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { systemActor } from '../worker/systemActor.js';
import { type GbpProvider, UnconfiguredGbp } from './provider.js';
import { syncReviews } from './sync.js';
import { rawReview } from './testing.js';
import { D11, type GbpWorld, call, connectLocation, gbpWorld, jobCtx, leadsWorldFor, makeDue, resetFake, resetPacks, reviewRows, setPacks, syncDeps } from './testing/world.js';

let h: ApiHarness;
let w: GbpWorld;
const fake = () => h.providers.gbp;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await gbpWorld(h);
}, 180_000);
afterAll(async () => {
  await resetPacks(h).catch(() => undefined);
  await h?.close();
});
beforeEach(async () => {
  resetFake(fake());
  await makeDue(h, w.tenantId);
});

const sync = (tenantId = w.tenantId, gbp: GbpProvider = fake()) => syncReviews(jobCtx(h, tenantId), syncDeps(h, gbp));
const status = (c = w.owner) => call<{ status: { state: string; sentence: string; locations: { sentence: string }[] } }>(c, 'GET', '/gbp/status');

/** a waiting reply draft for a stored review (fixture through the system actor, as gbp/replies.ts TX2 writes it) */
async function draftFor(reviewId: string): Promise<string> {
  const id = randomUUID();
  await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
    await sql`INSERT INTO assistant_actions (tenant_id, id, kind, action_category, autonomy, status, explanation, payload)
              VALUES (app.tenant_id(), ${id}, 'review_reply_draft', 'novel_message', 'requires_approval', 'proposed', 'A reply to a Google review, waiting for a tap.',
                      ${JSON.stringify({ review_id: reviewId, text: 'Thank you.' })}::jsonb)`.execute(tx);
    await sql`UPDATE gbp_reviews SET reply_status = 'drafted', reply_action_id = ${id} WHERE tenant_id = app.tenant_id() AND id = ${reviewId}`.execute(tx);
  }, { db: h.database });
  return id;
}
const actionStatus = async (id: string) => (await h.su.query<{ status: string }>('SELECT status FROM assistant_actions WHERE id = $1', [id])).rows[0]!.status;

describe('GBP stays dark until platform:gbp is reviewed (R-GBP-3)', () => {
  it('E460 R-GBP-3: with every pack unreviewed, and with D11\'s seven packs recorded, the sync calls nothing and stores nothing; the status says why', async () => {
    fake().seed(w.location.accountId, [rawReview('dark-1')]);
    await resetPacks(h);
    expect(await sync()).toMatchObject({ locations: 0, pages: 0 });
    await setPacks(h, D11, true);
    try {
      expect(await sync()).toMatchObject({ locations: 0, pages: 0 });
      expect(fake().calls).toEqual([]);
      expect(await reviewRows(h, w.location.connectionId)).toEqual([]);
      const s = await status();
      expect(s.status).toBe(200);
      expect(s.body.status).toEqual({ state: 'not_cleared', sentence: 'Google Business Profile stays off until counsel reviews it (pack platform:gbp 2026.11.0). Nothing is read from or posted to Google.', locations: [] });
      // the database refuses a forced row too (the 0079 guard)
      await expect(withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => sql`INSERT INTO gbp_reviews (tenant_id, id, connection_id, external_review_id, rating, reviewed_at) VALUES (app.tenant_id(), ${randomUUID()}, ${w.location.connectionId}, 'forced', 5, now())`.execute(tx), { db: h.database })).rejects.toThrow(/GBP_NOT_CLEARED/);
    } finally {
      await resetPacks(h);
    }
  });

  it('E461 R-GBP-3 R-INT-1: with platform:gbp reviewed but no adapter on the platform (production), nothing is called and the status says it is not set up', async () => {
    await setPacks(h, ['platform:gbp'], true);
    try {
      expect(await sync(w.tenantId, new UnconfiguredGbp())).toMatchObject({ locations: 0 });
      const prev = h.providers.gbp;
      (h.providers as { gbp: unknown }).gbp = new UnconfiguredGbp();
      try {
        expect((await status()).body.status).toEqual({ state: 'not_set_up', sentence: 'Google Business Profile is not set up on this platform yet. Export posts and copy them to your Business Profile yourself.', locations: [] });
      } finally {
        (h.providers as { gbp: unknown }).gbp = prev;
      }
    } finally {
      await resetPacks(h);
    }
  });
});

describe('review sync with platform:gbp reviewed (R-GBP-5)', () => {
  beforeAll(async () => {
    await setPacks(h, ['platform:gbp'], true);
  });
  afterAll(async () => {
    await resetPacks(h);
  });

  it('R-GBP-5: a sweep stores new reviews (replied at Google when Google shows an owner reply), records the time, and the status says when it last checked', async () => {
    const loc = await connectLocation(h, w.owner, 'Second location');
    fake().seed(loc.accountId, [rawReview('n-1', { stars: 'FIVE', reviewer: 'Reviewer A' }), rawReview('n-2', { stars: 2, comment: 'Slow to call back.', reply: 'Thank you for telling us.' })]);
    expect((await status()).body.status.locations.find((l) => l)).toBeTruthy();
    const s = await sync();
    expect(s.inserted).toBeGreaterThanOrEqual(2);
    expect((await reviewRows(h, loc.connectionId)).map((r) => [r.external_review_id, r.rating, r.reply_status])).toEqual([['n-1', 5, 'none'], ['n-2', 2, 'replied']]);
    const st = (await status()).body.status;
    expect(st.state).toBe('connected');
    expect(st.locations.every((l) => /^Reviews last checked /.test(l.sentence))).toBe(true);
    // the next pass waits for the stored next_sync_at: nothing is read before it
    const n = fake().calls.length;
    await sync();
    expect(fake().calls.length).toBe(n);
  });

  it('R-GBP-5: an edited review takes Google\'s rating, text, reviewer and time', async () => {
    fake().seed(w.location.accountId, [rawReview('e-1', { stars: 'FOUR', comment: 'Good.' })]);
    await sync();
    fake().edit(w.location.accountId, 'e-1', { starRating: 'ONE', comment: 'Changed my mind.', reviewer: { displayName: 'Reviewer B' }, updateTime: '2026-11-05T10:00:00Z' });
    await makeDue(h, w.tenantId);
    expect((await sync()).updated).toBeGreaterThanOrEqual(1);
    expect((await reviewRows(h, w.location.connectionId)).find((r) => r.external_review_id === 'e-1')).toMatchObject({ rating: 1, body: 'Changed my mind.', reviewer_display: 'Reviewer B' });
  });

  it('E468 R-GBP-5: a review answered at Google outside Realty OS is marked replied (no action) and its waiting draft is superseded; nothing is posted', async () => {
    fake().seed(w.location.accountId, [rawReview('o-1')]);
    await sync();
    const row = (await reviewRows(h, w.location.connectionId)).find((r) => r.external_review_id === 'o-1')!;
    const draft = await draftFor(row.id);
    fake().edit(w.location.accountId, 'o-1', { reviewReply: { comment: 'Answered by hand at Google.' } });
    await makeDue(h, w.tenantId);
    await sync();
    expect((await reviewRows(h, w.location.connectionId)).find((r) => r.id === row.id)).toMatchObject({ reply_status: 'replied', reply_action_id: null });
    expect(await actionStatus(draft)).toBe('superseded');
    expect(fake().calls).not.toContain('postReviewReply');
  });

  it('R-GBP-5: an owner reply deleted at Google brings the review back to "needs a reply"', async () => {
    fake().seed(w.location.accountId, [rawReview('d-1', { reply: 'Thanks!' })]);
    await sync();
    expect((await reviewRows(h, w.location.connectionId)).find((r) => r.external_review_id === 'd-1')!.reply_status).toBe('replied');
    fake().edit(w.location.accountId, 'd-1', { reviewReply: undefined });
    await makeDue(h, w.tenantId);
    await sync();
    expect((await reviewRows(h, w.location.connectionId)).find((r) => r.external_review_id === 'd-1')).toMatchObject({ reply_status: 'none', reply_action_id: null });
  });
});

describe('removal only after a complete, clean sweep (E467, R-GBP-5)', () => {
  let loc: { connectionId: string; accountId: string };
  beforeAll(async () => {
    await setPacks(h, ['platform:gbp'], true);
  });
  afterAll(async () => {
    await resetPacks(h);
  });
  beforeEach(async () => {
    // one live location at a time, so the pass's counts are this location's
    await h.su.query("UPDATE integration_connections SET status = 'disconnected', disconnected_at = now() WHERE tenant_id = $1 AND kind = 'gbp_location'", [w.tenantId]);
    loc = await connectLocation(h, w.owner, `Removal ${randomUUID().slice(0, 4)}`);
    fake().seed(loc.accountId, [rawReview('r-1'), rawReview('r-2'), rawReview('r-3')]);
    await sync();
    await makeDue(h, w.tenantId);
    fake().removeReview(loc.accountId, 'r-2');
  });
  const r2 = async () => (await reviewRows(h, loc.connectionId)).find((r) => r.external_review_id === 'r-2')!;

  it('E467 R-GBP-5: a review missing from a complete sweep from the top is blanked "Removed at Google" and its waiting draft invalidated', async () => {
    const draft = await draftFor((await r2()).id);
    expect((await sync()).removed).toBe(1);
    expect(await r2()).toMatchObject({ rating: null, body: null, reviewer_display: null, reply_status: 'none', reply_action_id: null });
    expect(await actionStatus(draft)).toBe('invalidated');
    // the other reviews are untouched
    expect((await reviewRows(h, loc.connectionId)).filter((r) => r.rating !== null).map((r) => r.external_review_id)).toEqual(['r-1', 'r-3']);
  });

  it('E467: a failed page removes nothing; the cursor stays with the last page applied and the next pass resumes there', async () => {
    fake().pageSize = 1;
    fake().failPage = 1;
    const s = await sync();
    expect(s.removed).toBe(0);
    expect((await r2()).rating).not.toBeNull();
    const [c] = (await h.su.query<{ sync_cursor: string | null; last_error_code: string | null }>('SELECT sync_cursor, last_error_code FROM integration_connections WHERE id = $1', [loc.connectionId])).rows;
    expect(c).toEqual({ sync_cursor: 'page:1', last_error_code: 'LIST_TIMEOUT' });
    expect((await status()).body.status.locations.some((l) => l.sentence === 'Last check failed (LIST_TIMEOUT); we will try again.')).toBe(true);
    // resumed mid-sweep: it completes, but it did not start at the top, so it still removes nothing
    fake().failPage = null;
    await makeDue(h, w.tenantId);
    expect((await sync()).removed).toBe(0);
    expect((await r2()).rating).not.toBeNull();
    // the next sweep starts at the top and completes cleanly: now it is removed
    await makeDue(h, w.tenantId);
    expect((await sync()).removed).toBe(1);
  });

  it('E467: a list longer than one pass (more than 5 pages) removes nothing in that pass', async () => {
    fake().seed(loc.accountId, Array.from({ length: 8 }, (_, i) => rawReview(`r-x${i}`)));
    fake().pageSize = 1;
    const s = await sync();
    expect(s.pages).toBe(5);
    expect(s.removed).toBe(0);
    expect((await r2()).rating).not.toBeNull();
  });

  it('E467: an unreadable review removes nothing and is recorded (GBP_REVIEW_UNREADABLE)', async () => {
    fake().seed(loc.accountId, [{ reviewId: 'bad-1', starRating: 'SIX', createTime: 'never' }]);
    expect((await sync()).removed).toBe(0);
    expect((await r2()).rating).not.toBeNull();
    expect((await h.su.query('SELECT last_error_code FROM integration_connections WHERE id = $1', [loc.connectionId])).rows[0]).toEqual({ last_error_code: 'GBP_REVIEW_UNREADABLE' });
  });
});

describe('tenancy (R-TEN-1)', () => {
  it('R-GBP-5: a tenant\'s pass reads only its own locations, never another tenant\'s', async () => {
    await setPacks(h, ['platform:gbp'], true);
    try {
      const other = await leadsWorldFor(h);
      const theirs = await connectLocation(h, other.owner, 'Other team location');
      fake().seed(theirs.accountId, [rawReview('t-1')]);
      fake().calls.length = 0;
      const before = (await h.su.query('SELECT count(*)::int AS n FROM gbp_reviews WHERE connection_id = $1', [theirs.connectionId])).rows[0].n;
      await sync(w.tenantId);
      expect(fake().listed).not.toContain(theirs.accountId);
      expect((await h.su.query('SELECT count(*)::int AS n FROM gbp_reviews WHERE connection_id = $1', [theirs.connectionId])).rows[0].n).toBe(before);
      expect((await h.su.query('SELECT count(*)::int AS n FROM gbp_reviews WHERE connection_id = $1 AND tenant_id <> $2', [theirs.connectionId, other.tenantId])).rows[0].n).toBe(0);
    } finally {
      await resetPacks(h);
    }
  });
});
