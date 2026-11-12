// The deterministic Google Business Profile fake (module 53). In-memory only: nothing leaves the process.
// It never delegates to FakeSocialPublisher (the GBP location is its own provider, and gbp tests never call the
// reserved methods: marketing/architecture.test.ts).
//
//   seed(accountId, raws)     reviews the "location" holds, as raw GBP-shaped objects (VERIFY shapes, provider.ts)
//   removeReview(acct, id)    the "removed at Google" switch: the review disappears from the list
//   pageSize                  reviews per listReviews page (cursor = "page:<n>")
//   failPage                  a page index that throws ProviderError('timeout') (a failed sweep)
//   nextReply                 'replied' | 'rejected' | 'timeout' (a timeout still applies the reply when replyAppliesOnTimeout)
//   nextPublish               'published' | 'rejected' | 'timeout'; a post over GBP_POST_MAX_CHARS is rejected (VERIFY)
//   deletion                  'supported' | 'unsupported'
//   calls                     every method called, in order (tests prove "calls nothing")
//   replies / published       the outboxes
import { ProviderError } from '../providers/types.js';
import type { DeleteRequest, DeleteResult, LookupRequest, LookupResult, PublishRequest, PublishResult } from '../providers/integrations/types.js';
import { GBP_POST_MAX_CHARS, type GbpProvider, type ListReviewsRequest, type ReviewPage, type ReviewReplyRequest, type ReviewReplyResult } from './provider.js';

type Raw = Record<string, unknown>;

/** A GBP-shaped raw review (synthetic; reserved names only). */
export function rawReview(id: string, o: { stars?: number | string; comment?: string | null; reviewer?: string | null; updateTime?: string; reply?: string | null } = {}): Raw {
  return {
    reviewId: id,
    starRating: o.stars ?? 'FIVE',
    ...(o.comment === null ? {} : { comment: o.comment ?? 'Great to work with.' }),
    ...(o.reviewer === null ? {} : { reviewer: { displayName: o.reviewer ?? 'Reviewer A' } }),
    createTime: '2026-11-01T12:00:00Z',
    updateTime: o.updateTime ?? '2026-11-01T12:00:00Z',
    ...(o.reply ? { reviewReply: { comment: o.reply, updateTime: '2026-11-02T12:00:00Z' } } : {}),
  };
}

export class FakeGbp implements GbpProvider {
  readonly configured = true;
  readonly statusText = 'Google Business Profile: deterministic fake (dev and tests only)';
  readonly calls: string[] = [];
  readonly replies: ReviewReplyRequest[] = [];
  readonly published: PublishRequest[] = [];
  readonly deletions: DeleteRequest[] = [];
  readonly posts = new Map<string, { externalAccountId: string; pieceId: string; contentSha256: string }>();
  pageSize = 50;
  failPage: number | null = null;
  nextReply: 'replied' | 'rejected' | 'timeout' = 'replied';
  replyRejectCode = 'REPLY_REJECTED';
  replyAppliesOnTimeout = true;
  nextPublish: 'published' | 'rejected' | 'timeout' = 'published';
  deletion: 'supported' | 'unsupported' = 'supported';
  /** tests: runs inside postReviewReply before it answers (e.g. a second tap) */
  beforeReply: (() => Promise<void>) | null = null;
  readonly #reviews = new Map<string, Raw[]>();

  seed(accountId: string, raws: Raw[]): void {
    this.#reviews.set(accountId, [...(this.#reviews.get(accountId) ?? []), ...raws.map((r) => ({ ...r }))]);
  }
  /** Replace one review's raw object (an edit at Google). */
  edit(accountId: string, reviewId: string, patch: Raw): void {
    const list = this.#reviews.get(accountId) ?? [];
    const i = list.findIndex((r) => r.reviewId === reviewId);
    if (i >= 0) list[i] = { ...list[i], ...patch };
  }
  removeReview(accountId: string, reviewId: string): void {
    this.#reviews.set(accountId, (this.#reviews.get(accountId) ?? []).filter((r) => r.reviewId !== reviewId));
  }
  /** The owner reply Google shows now (what a person would see). */
  ownerReplyOf(accountId: string, reviewId: string): string | null {
    const r = (this.#reviews.get(accountId) ?? []).find((x) => x.reviewId === reviewId);
    const rr = r?.reviewReply as { comment?: string } | undefined;
    return rr?.comment ?? null;
  }

  async listReviews(i: ListReviewsRequest): Promise<ReviewPage> {
    this.calls.push('listReviews');
    const page = i.cursor === null ? 0 : Number(/^page:(\d+)$/.exec(i.cursor)?.[1] ?? NaN);
    if (!Number.isInteger(page)) throw new ProviderError('rejected', 'BAD_CURSOR');
    if (this.failPage === page) throw new ProviderError('timeout', 'LIST_TIMEOUT');
    const all = this.#reviews.get(i.externalAccountId) ?? [];
    const slice = all.slice(page * this.pageSize, (page + 1) * this.pageSize).map((r) => structuredClone(r));
    const complete = (page + 1) * this.pageSize >= all.length;
    return { reviews: slice, cursor: complete ? null : `page:${page + 1}`, complete };
  }

  async postReviewReply(r: ReviewReplyRequest): Promise<ReviewReplyResult> {
    this.calls.push('postReviewReply');
    this.replies.push({ ...r });
    if (this.beforeReply) await this.beforeReply();
    const outcome = this.nextReply;
    this.nextReply = 'replied';
    if (outcome === 'rejected') return { kind: 'rejected', code: this.replyRejectCode };
    const list = this.#reviews.get(r.externalAccountId) ?? [];
    const review = list.find((x) => x.reviewId === r.externalReviewId);
    if (!review) return { kind: 'rejected', code: 'REVIEW_NOT_FOUND' };
    if (outcome === 'replied' || this.replyAppliesOnTimeout) review.reviewReply = { comment: r.text, updateTime: '2026-11-03T12:00:00Z' };
    if (outcome === 'timeout') throw new ProviderError('timeout', 'REPLY_TIMEOUT');
    return { kind: 'replied' };
  }

  async publishPost(p: PublishRequest): Promise<PublishResult> {
    this.calls.push('publishPost');
    this.published.push({ ...p, imageUrls: [...p.imageUrls] });
    if (p.target !== 'gbp_location') return { kind: 'rejected', code: 'TARGET_NOT_GBP' };
    if ([...p.text].length > GBP_POST_MAX_CHARS) return { kind: 'rejected', code: 'POST_TOO_LONG' };
    const outcome = this.nextPublish;
    this.nextPublish = 'published';
    if (outcome === 'rejected') return { kind: 'rejected', code: 'POST_REJECTED' };
    const ref = `fake-gbp-post-${this.published.length}`;
    this.posts.set(ref, { externalAccountId: p.externalAccountId, pieceId: p.pieceId, contentSha256: p.contentSha256 });
    if (outcome === 'timeout') throw new ProviderError('timeout', 'PUBLISH_TIMEOUT');
    return { kind: 'published', providerRef: ref, url: null };
  }

  async lookupPost(p: LookupRequest): Promise<LookupResult> {
    this.calls.push('lookupPost');
    for (const [ref, post] of this.posts) {
      if (post.externalAccountId === p.externalAccountId && post.pieceId === p.pieceId && post.contentSha256 === p.contentSha256) return { kind: 'found', providerRef: ref };
    }
    return { kind: 'not_found' };
  }

  async deletePost(p: DeleteRequest): Promise<DeleteResult> {
    this.calls.push('deletePost');
    this.deletions.push({ ...p });
    if (this.deletion === 'unsupported') return { kind: 'unsupported' };
    const post = this.posts.get(p.providerRef);
    if (!post || post.externalAccountId !== p.externalAccountId) return { kind: 'failed', code: 'POST_NOT_FOUND' };
    this.posts.delete(p.providerRef);
    return { kind: 'deleted' };
  }
}
