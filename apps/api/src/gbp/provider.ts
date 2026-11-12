// The Google Business Profile adapter (module 53; PHASE2_3_PLAN §5.4 #53; DATA_MODEL R-GBP-1..5).
//
// This build ships ONLY the deterministic fake (testing.ts) and an "unconfigured" adapter that refuses every call:
// no Google OAuth app exists, no Business Profile API access was granted (N15), and no real Google endpoint is ever
// called. Every shape here is GBP-*shaped* (reviews with a star rating, a comment, a reviewer, times and an owner
// reply) and marked VERIFY: the real adapter must be checked against Google's current API before it is written.
//
// Reserved outbound names (R-GATE-15, lint realty/no-provider-outbound, marketing/architecture.test.ts):
// publishPost, lookupPost, deletePost and postReviewReply are called only from apps/api/src/marketing/publish.ts
// (deps.gbp). Nothing in apps/api/src/gbp/** calls them; gbp/replies.ts reaches postReviewReply through
// publish.ts's sendReviewReply. Adapters take explicit account ids and the token the caller decrypted as the
// system (providers/integrations/types.ts): they never see tenant context.
import { ProviderError } from '../providers/types.js';
import type { SocialPublisher } from '../providers/integrations/types.js';

/** One review, cut down to what module 53 stores (0018 gbp_reviews limits). VERIFY every field. */
export interface GbpReview {
  externalReviewId: string;
  rating: 1 | 2 | 3 | 4 | 5;
  body: string | null;
  reviewerDisplay: string | null;
  /** ISO instant: the review's last change at Google (VERIFY: updateTime, else createTime) */
  reviewedAt: string;
  /** the business's public reply, if any (written in Realty OS or outside it) */
  ownerReply: { text: string } | null;
}

export interface ListReviewsRequest {
  externalAccountId: string;
  accessToken: string;
  /** null starts a sweep from the newest review */
  cursor: string | null;
}

/** One page. `reviews` are raw provider objects: the caller runs each through parseGbpReview. */
export interface ReviewPage {
  reviews: unknown[];
  cursor: string | null;
  /** true on the last page of a sweep */
  complete: boolean;
}

export interface ReviewReplyRequest {
  externalAccountId: string;
  accessToken: string;
  externalReviewId: string;
  text: string;
}

/** An explicit answer. A timeout or a lost answer is thrown as ProviderError('timeout'): the reply may exist. */
export type ReviewReplyResult = { kind: 'replied' } | { kind: 'rejected'; code: string };

/**
 * publishPost / lookupPost / deletePost for target 'gbp_location' (a GBP "local post", VERIFY), plus the review
 * calls. RESERVED: only marketing/publish.ts calls the publishing methods and postReviewReply.
 */
export interface GbpProvider extends SocialPublisher {
  /** false in production until a reviewed Google app and N15 access exist: nothing is read or posted */
  readonly configured: boolean;
  /** the adapter's state in words (GET /gbp/status) */
  readonly statusText: string;
  /** One page of the location's reviews. Throws ProviderError on a failure. */
  listReviews(i: ListReviewsRequest): Promise<ReviewPage>;
  /** RESERVED: only marketing/publish.ts (sendReviewReply). Replaces any earlier owner reply (VERIFY). */
  postReviewReply(r: ReviewReplyRequest): Promise<ReviewReplyResult>;
}

export const GBP_NOT_SET_UP = 'Google Business Profile is not set up on this platform yet';

/** VERIFY: Google's limit for a local post's text. Posts over it are refused by the fake and exported instead. */
export const GBP_POST_MAX_CHARS = 1500;
/** VERIFY: Google's limit for a review reply. */
export const GBP_REPLY_MAX_CHARS = 1500;

/** Production without ALLOW_FAKE_PROVIDERS (R-INT-1, N15): every call refuses; nothing leaves the process. */
export class UnconfiguredGbp implements GbpProvider {
  readonly configured = false;
  readonly statusText = GBP_NOT_SET_UP;
  #refuse(): never {
    throw new ProviderError('not_configured', 'GBP_NOT_CONFIGURED');
  }
  async listReviews(): Promise<ReviewPage> {
    return this.#refuse();
  }
  async postReviewReply(): Promise<ReviewReplyResult> {
    return this.#refuse();
  }
  async publishPost(): Promise<never> {
    return this.#refuse();
  }
  async lookupPost(): Promise<never> {
    return this.#refuse();
  }
  async deletePost(): Promise<never> {
    return this.#refuse();
  }
}

// ---- the strict parser ---------------------------------------------------------------------------------------

/** 0018 gbp_reviews limits */
export const REVIEW_BODY_MAX = 5000;
export const REVIEWER_MAX = 120;
const ID_RE = /^[A-Za-z0-9._:/-]{1,200}$/;
// VERIFY: Google sends starRating as an enum word; a bare number is accepted too
const STARS: Record<string, 1 | 2 | 3 | 4 | 5> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.replace(CONTROL, '').trim();
  if (t === '') return null;
  // cut on a code point, never inside a surrogate pair
  return [...t].length > max ? [...t].slice(0, max).join('').trimEnd() : t;
}
function instant(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
function stars(v: unknown): 1 | 2 | 3 | 4 | 5 | null {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) return v as 1 | 2 | 3 | 4 | 5;
  if (typeof v === 'string') return STARS[v] ?? null;
  return null;
}

/**
 * A raw provider review → the stored shape, built field by field (every other field is dropped). Text is cut to the
 * 0018 limits. A review without a usable id, rating or time is unreadable: the sync records GBP_REVIEW_UNREADABLE
 * and removes nothing in that pass (it is never silently dropped).
 */
export function parseGbpReview(raw: unknown): { ok: true; review: GbpReview } | { ok: false; externalReviewId: string | null } {
  if (!isObj(raw)) return { ok: false, externalReviewId: null };
  const id = typeof raw.reviewId === 'string' && ID_RE.test(raw.reviewId) ? raw.reviewId : null;
  const rating = stars(raw.starRating);
  const at = instant(raw.updateTime) ?? instant(raw.createTime);
  if (id === null || rating === null || at === null) return { ok: false, externalReviewId: id };
  const reviewer = isObj(raw.reviewer) ? text(raw.reviewer.displayName, REVIEWER_MAX) : null;
  const replyText = isObj(raw.reviewReply) ? text(raw.reviewReply.comment, GBP_REPLY_MAX_CHARS * 4) : null;
  return {
    ok: true,
    review: { externalReviewId: id, rating, body: text(raw.comment, REVIEW_BODY_MAX), reviewerDisplay: reviewer, reviewedAt: at, ownerReply: replyText === null ? null : { text: replyText } },
  };
}

/** Whitespace-normalised text, for "is this the reply we posted" (VERIFY: Google may normalise whitespace). */
export function sameReplyText(a: string, b: string): boolean {
  const n = (s: string) => s.replace(/\s+/g, ' ').trim();
  return n(a) === n(b);
}
