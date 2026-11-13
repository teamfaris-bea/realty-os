// The GBP adapter: the strict review parser, the deterministic fake's reads, and the honest unconfigured adapter
// (module 53; R-INT-1). Gbp tests never call the reserved publishing or reply methods (marketing/architecture.test.ts):
// those are exercised through marketing/publish.ts in publish.test.ts and gbp/replies.test.ts.
import { describe, expect, it } from 'vitest';
import { testConfig } from '../auth/testHarness.js';
import { createFakeProviders, createProviders } from '../providers/index.js';
import { ProviderError } from '../providers/types.js';
import { GBP_NOT_SET_UP, REVIEWER_MAX, REVIEW_BODY_MAX, UnconfiguredGbp, parseGbpReview, sameReplyText } from './provider.js';
import { FakeGbp, rawReview } from './testing.js';

describe('parseGbpReview: built field by field from an untrusted payload (VERIFY shapes)', () => {
  it('reads a GBP-shaped review: enum or numeric stars, comment, reviewer, update time, owner reply; drops every other field', () => {
    const r = parseGbpReview({ ...rawReview('rev-1', { stars: 'FOUR', reply: '  Thank you!  ' }), name: 'accounts/x/locations/y/reviews/rev-1', reviewer: { displayName: 'Reviewer A', profilePhotoUrl: 'https://example.test/p.png' }, extra: { nested: 1 } });
    expect(r).toEqual({ ok: true, review: { externalReviewId: 'rev-1', rating: 4, body: 'Great to work with.', reviewerDisplay: 'Reviewer A', reviewedAt: '2026-11-01T12:00:00.000Z', ownerReply: { text: 'Thank you!' } } });
    expect(parseGbpReview(rawReview('rev-2', { stars: 2 }))).toMatchObject({ ok: true, review: { rating: 2 } });
  });

  it('a review without text or reviewer is readable (a bare star rating); text is cut to the 0018 limits on a code point', () => {
    expect(parseGbpReview(rawReview('rev-3', { comment: null, reviewer: null }))).toMatchObject({ ok: true, review: { body: null, reviewerDisplay: null, ownerReply: null } });
    const long = parseGbpReview(rawReview('rev-4', { comment: '😀'.repeat(REVIEW_BODY_MAX + 10), reviewer: 'R'.repeat(500) }));
    if (!long.ok) throw new Error('unreadable');
    expect([...long.review.body!].length).toBe(REVIEW_BODY_MAX);
    expect(long.review.reviewerDisplay!.length).toBe(REVIEWER_MAX);
    // control characters are stripped, whitespace-only text is no text
    expect(parseGbpReview(rawReview('rev-5', { comment: ' \u0000\u0007 ', reviewer: '\u0001' }))).toMatchObject({ ok: true, review: { body: null, reviewerDisplay: null } });
  });

  it('an unreadable review is reported with its id when it has one, never silently dropped', () => {
    expect(parseGbpReview(null)).toEqual({ ok: false, externalReviewId: null });
    expect(parseGbpReview([rawReview('x')])).toEqual({ ok: false, externalReviewId: null });
    expect(parseGbpReview({ ...rawReview('rev-6'), starRating: 'SIX' })).toEqual({ ok: false, externalReviewId: 'rev-6' });
    expect(parseGbpReview({ ...rawReview('rev-7'), starRating: 0 })).toEqual({ ok: false, externalReviewId: 'rev-7' });
    expect(parseGbpReview({ ...rawReview('rev-8'), updateTime: 'yesterday', createTime: undefined })).toEqual({ ok: false, externalReviewId: 'rev-8' });
    expect(parseGbpReview({ ...rawReview('x'), reviewId: 'has space' })).toEqual({ ok: false, externalReviewId: null });
    expect(parseGbpReview({ ...rawReview('x'), reviewId: 'a'.repeat(201) })).toEqual({ ok: false, externalReviewId: null });
  });

  it('sameReplyText compares after whitespace normalisation only', () => {
    expect(sameReplyText(' Thank  you\nfor the review ', 'Thank you for the review')).toBe(true);
    expect(sameReplyText('Thank you', 'thank you')).toBe(false);
  });
});

describe('FakeGbp reads (deterministic)', () => {
  it('pages through a location\'s reviews with a cursor, says when the sweep is complete, and fails a scripted page', async () => {
    const run = async () => {
      const f = new FakeGbp();
      f.pageSize = 2;
      f.seed('loc-1', [rawReview('a'), rawReview('b'), rawReview('c')]);
      f.seed('loc-2', [rawReview('z')]);
      const p1 = await f.listReviews({ externalAccountId: 'loc-1', accessToken: 't', cursor: null });
      const p2 = await f.listReviews({ externalAccountId: 'loc-1', accessToken: 't', cursor: p1.cursor });
      return { p1, p2, calls: [...f.calls] };
    };
    const a = await run();
    expect(a.p1).toMatchObject({ cursor: 'page:1', complete: false });
    expect((a.p1.reviews as { reviewId: string }[]).map((r) => r.reviewId)).toEqual(['a', 'b']);
    expect(a.p2).toMatchObject({ cursor: null, complete: true });
    expect(await run()).toEqual(a);
    const f = new FakeGbp();
    f.seed('loc-1', [rawReview('a')]);
    f.failPage = 0;
    await expect(f.listReviews({ externalAccountId: 'loc-1', accessToken: 't', cursor: null })).rejects.toMatchObject({ kind: 'timeout' });
    f.failPage = null;
    f.removeReview('loc-1', 'a');
    expect(await f.listReviews({ externalAccountId: 'loc-1', accessToken: 't', cursor: null })).toEqual({ reviews: [], cursor: null, complete: true });
  });
});

describe('UnconfiguredGbp (production without ALLOW_FAKE_PROVIDERS; N15)', () => {
  it('R-INT-1: says it is not set up and refuses every call with ProviderError(not_configured); production gets it, dev and tests the fake', async () => {
    const u = new UnconfiguredGbp();
    expect(u).toMatchObject({ configured: false, statusText: GBP_NOT_SET_UP });
    await expect(u.listReviews()).rejects.toBeInstanceOf(ProviderError);
    await expect(u.listReviews()).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'GBP_NOT_CONFIGURED' });
    expect(createFakeProviders().gbp).toBeInstanceOf(FakeGbp);
    expect(createProviders(testConfig(), { clock: { now: () => 0 as never } }).gbp).toBeInstanceOf(FakeGbp);
    const prod = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, { clock: { now: () => 0 as never } });
    expect(prod.gbp).toBeInstanceOf(UnconfiguredGbp);
    const staging = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, { clock: { now: () => 0 as never } });
    expect(staging.gbp).toBeInstanceOf(FakeGbp);
  });
});
