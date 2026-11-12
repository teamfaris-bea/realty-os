// Property tests of module 29's pure decisions (decide.ts): honesty of the words (R-MKT-6, R-MKT-12), the provider
// outcome classification and the reconcile/retract decisions (E227), what is offered for publishing (R-INT-6), and
// the page slug shape (marketing_pieces.public_slug CHECK).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../providers/types.js';
import {
  PAGE_SLUG_RE,
  claimsPosted,
  classifyPublish,
  earlierPostNotice,
  errorCodeOf,
  pageSlug,
  publicationLabel,
  publishOptions,
  reconcileFromLookup,
  retractFromDelete,
} from './decide.js';

const STATUS = fc.constantFrom('publishing', 'published', 'failed', 'unknown', 'retracted') as fc.Arbitrary<'publishing' | 'published' | 'failed' | 'unknown' | 'retracted'>;
const TARGET = fc.constantFrom('facebook_page', 'instagram_business', 'gbp_location', 'web_chat_widget', 'x');
const KIND = fc.constantFrom('website_page', 'social_post', 'open_house_invite', 'flyer', 'marketplace_export', 'gbp_post') as fc.Arbitrary<'social_post'>;
const PSTATUS = fc.constantFrom('draft', 'approved', 'published', 'exported', 'retracted', 'superseded') as fc.Arbitrary<'approved'>;
const CONN = fc.constantFrom('not_configured', 'needs_partner_access', 'pending_review', 'connected', 'degraded', 'revoked', 'disconnected');

describe('R-MKT-12 R-MKT-6 honest words', () => {
  it('R-MKT-12 E227: a publication label says "Posted" exactly when the provider confirmed it (published with a post id)', () => {
    fc.assert(
      fc.property(STATUS, fc.option(fc.string({ minLength: 1, maxLength: 30 }), { nil: null }), TARGET, fc.option(fc.constantFrom('PUBLISH_TIMEOUT', 'POST_REJECTED'), { nil: null }), fc.boolean(), (status, postId, target, code, removeYourself) => {
        const label = publicationLabel({ status, externalPostId: postId, targetKind: target, errorCode: code, removeYourself });
        expect(claimsPosted(label)).toBe(status === 'published' && postId !== null);
      }),
      { numRuns: 2000 },
    );
  });

  it('R-MKT-12: the earlier-post notice exists exactly when an older version still has a live post, and never claims anything was removed', () => {
    fc.assert(
      fc.property(fc.array(fc.record({ targetKind: TARGET }), { maxLength: 5 }), (older) => {
        const n = earlierPostNotice(older);
        expect(n === null).toBe(older.length === 0);
        if (n) expect(n).toMatch(/^The earlier post stays on your /);
      }),
    );
  });
});

describe('E227 the provider outcome', () => {
  const published = fc.record({ kind: fc.constant('published' as const), providerRef: fc.string({ maxLength: 250 }), url: fc.constant(null) });
  const rejected = fc.record({ kind: fc.constant('rejected' as const), code: fc.string({ maxLength: 80 }) });
  const thrown = fc.oneof(
    fc.constantFrom('timeout', 'rejected', 'unavailable', 'not_configured').map((k) => new ProviderError(k as never, 'X')),
    fc.string().map((m) => new Error(m)),
    fc.anything(),
  );

  it('E227 R-MKT-12: "published" only with a usable provider post id; a timeout or anything unreadable is "unknown", never published or failed', () => {
    fc.assert(
      fc.property(fc.oneof(published.map((r) => ({ ok: true as const, result: r })), rejected.map((r) => ({ ok: true as const, result: r })), thrown.map((e) => ({ ok: false as const, error: e }))), (r) => {
        const o = classifyPublish(r);
        if (o.status === 'published') {
          expect(r.ok && r.result.kind === 'published').toBe(true);
          expect(o.externalPostId.length).toBeGreaterThan(0);
          expect(o.externalPostId.length).toBeLessThanOrEqual(200);
        }
        if (!r.ok && r.error instanceof ProviderError && r.error.kind === 'timeout') expect(o.status).toBe('unknown');
        if (!r.ok && !(r.error instanceof ProviderError)) expect(o.status).toBe('unknown');
        if (o.status !== 'published') expect(o.errorCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }),
      { numRuns: 3000 },
    );
  });

  it('E227: reconciling an unknown publication never yields a re-post; "unsupported" lookups and errors stay unknown; "not found" fails only after the give-up window', () => {
    const lookup = fc.oneof(
      fc.record({ kind: fc.constant('found' as const), providerRef: fc.string({ maxLength: 220 }) }),
      fc.constant({ kind: 'not_found' as const }),
      fc.constant({ kind: 'unsupported' as const }),
    );
    fc.assert(
      fc.property(fc.oneof(lookup.map((r) => ({ ok: true as const, result: r })), fc.anything().map((e) => ({ ok: false as const, error: e }))), fc.integer({ min: 0, max: 10 * 86_400_000 }), (r, age) => {
        const o = reconcileFromLookup(r, age);
        expect(['published', 'failed', 'unknown']).toContain(o.status);
        if (!r.ok || r.result.kind === 'unsupported') expect(o.status).toBe('unknown');
        if (r.ok && r.result.kind === 'not_found') expect(o.status).toBe(age >= 86_400_000 ? 'failed' : 'unknown');
        if (o.status === 'published') expect(r.ok && r.result.kind === 'found').toBe(true);
      }),
      { numRuns: 3000 },
    );
  });

  it('R-MKT-12: a retraction is recorded only when the provider confirmed the deletion; anything else is "remove it yourself"', () => {
    const del = fc.oneof(fc.constant({ kind: 'deleted' as const }), fc.constant({ kind: 'unsupported' as const }), fc.record({ kind: fc.constant('failed' as const), code: fc.string() }));
    fc.assert(
      fc.property(fc.oneof(del.map((r) => ({ ok: true as const, result: r })), fc.anything().map((e) => ({ ok: false as const, error: e }))), (r) => {
        const o = retractFromDelete(r);
        expect(o.kind === 'retracted').toBe(r.ok && r.result.kind === 'deleted');
      }),
    );
  });

  it('error codes are always the DB CHECK shape', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), (raw) => {
        expect(errorCodeOf(raw, 'FALLBACK')).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }),
    );
  });
});

describe('R-INT-6 R-MKT-12 what is offered', () => {
  it('R-INT-6 R-MKT-12: "publish" is offered only for an approved/published social post, to a connected/degraded Page or Instagram account, once the pack is cleared, not already live, and (VERIFY) Instagram only with an image', () => {
    fc.assert(
      fc.property(
        KIND,
        PSTATUS,
        fc.integer({ min: 0, max: 3 }),
        fc.array(fc.record({ connectionId: fc.uuid(), kind: TARGET, status: CONN, displayName: fc.constant('Acct') }), { maxLength: 4 }),
        fc.boolean(),
        fc.boolean(),
        (kind, status, images, targets, cleared, liveFirst) => {
          const live = new Set(liveFirst && targets[0] ? [targets[0].connectionId] : []);
          for (const o of publishOptions({ kind, status, imageCount: images }, targets, live, cleared)) {
            if (o.kind !== 'publish') {
              expect(o.sentence.length).toBeGreaterThan(0);
              continue;
            }
            const t = targets.find((x) => x.connectionId === o.connectionId)!;
            expect(kind).toBe('social_post');
            expect(['approved', 'published']).toContain(status);
            expect(['facebook_page', 'instagram_business']).toContain(t.kind);
            expect(['connected', 'degraded']).toContain(t.status);
            expect(cleared).toBe(true);
            expect(live.has(t.connectionId)).toBe(false);
            if (t.kind === 'instagram_business') expect(images).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });
});

describe('page slugs', () => {
  it('R-MKT-7: every generated page slug matches the public_slug CHECK, whatever the address', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.uuid(), (a, c, id) => {
        expect(pageSlug(a, c, id.replace(/-/g, '').slice(0, 8))).toMatch(PAGE_SLUG_RE);
      }),
      { numRuns: 3000 },
    );
  });
});

describe('VERIFY assumptions are configuration with strict defaults', () => {
  it('R-MKT-12 VERIFY: defaults are the strictest (Instagram needs an image, 1 h image links, 24 h before an unfound unknown fails); bad values fall back', async () => {
    const { assumptionsFrom } = await import('./assumptions.js');
    expect(assumptionsFrom({})).toEqual({ instagramRequiresImage: true, imageUrlTtlMs: 3_600_000, unknownGiveUpMs: 86_400_000 });
    expect(assumptionsFrom({ MARKETING_INSTAGRAM_REQUIRES_IMAGE: 'false', MARKETING_IMAGE_URL_TTL_MINUTES: '10', MARKETING_UNKNOWN_GIVE_UP_HOURS: '48' })).toEqual({ instagramRequiresImage: false, imageUrlTtlMs: 600_000, unknownGiveUpMs: 172_800_000 });
    expect(assumptionsFrom({ MARKETING_INSTAGRAM_REQUIRES_IMAGE: 'nope', MARKETING_IMAGE_URL_TTL_MINUTES: '-1', MARKETING_UNKNOWN_GIVE_UP_HOURS: 'x' })).toEqual({ instagramRequiresImage: true, imageUrlTtlMs: 3_600_000, unknownGiveUpMs: 86_400_000 });
  });
});

