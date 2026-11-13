// Module 55 verify 5: GET /gbp/reviews?filter=needs_reply (the Approvals review-reply card and the /gbp default
// filter) includes a drafted review and excludes a replied one and one without a rating (repos/gbp.ts). Real Postgres,
// the fake GBP provider and the fake model only; packs cleared through the superuser and reset afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { syncReviews } from '../gbp/sync.js';
import { rawReview } from '../gbp/testing.js';
import { type GbpWorld, call, gbpWorld, jobCtx, makeDue, resetPacks, setPacks, syncDeps } from '../gbp/testing/world.js';

let h: ApiHarness;
let w: GbpWorld;
beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'error' });
  w = await gbpWorld(h);
  await setPacks(h, ['platform:gbp'], true);
  await h.su.query('UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1', [w.tenantId]);
}, 180_000);
afterAll(async () => {
  await resetPacks(h).catch(() => undefined);
  await h?.close();
});

type Reviews = { reviews: { state: string; reviews: { id: string; rating: number | null }[] } };

describe('needs_reply (module 55 verify 5)', () => {
  it('R-STAFF-2 E663: needs_reply lists a drafted and an undrafted rated review, and leaves out a replied one and one without a rating', async () => {
    h.providers.gbp.seed(w.location.accountId, [
      rawReview('vr-plain', { stars: 'FOUR' }),
      rawReview('vr-drafted', { stars: 'FIVE' }),
      rawReview('vr-replied', { stars: 'FIVE', reply: 'Thank you for the kind words.' }),
      rawReview('vr-unrated', { stars: 'THREE' }),
    ]);
    await makeDue(h, w.tenantId);
    await syncReviews(jobCtx(h, w.tenantId), syncDeps(h));
    const ids = Object.fromEntries((await h.su.query<{ id: string; external_review_id: string; rating: number | null }>('SELECT id, external_review_id, rating FROM gbp_reviews WHERE connection_id = $1', [w.location.connectionId])).rows.map((r) => [r.external_review_id, r]));
    expect(ids['vr-unrated'], 'the review is stored').toBeDefined();
    // removed at Google: the sync blanks it exactly so (repos/gbp.ts blankReview); done here as the superuser
    await h.su.query('UPDATE gbp_reviews SET rating = NULL, body = NULL, reviewer_display = NULL WHERE id = $1', [ids['vr-unrated']!.id]);
    ids['vr-unrated']!.rating = null;
    expect(ids['vr-unrated']!.rating).toBeNull();
    const d = await call(w.owner, 'POST', `/gbp/reviews/${ids['vr-drafted']!.id}/draft`, { mode: 'manual', text: 'Thank you for working with us.' });
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const r = await call<Reviews>(w.owner, 'GET', '/gbp/reviews?filter=needs_reply');
    expect(r.status).toBe(200);
    const listed = r.body.reviews.reviews.map((x) => x.id);
    expect(listed).toEqual(expect.arrayContaining([ids['vr-plain']!.id, ids['vr-drafted']!.id]));
    expect(listed).not.toContain(ids['vr-replied']!.id);
    expect(listed).not.toContain(ids['vr-unrated']!.id);
  });
});
