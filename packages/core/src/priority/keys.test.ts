// The Phase 2/3 extension point (module 18a): each owning module writes its card under its own key
// family, and the feed reads the ids back from the key. Keys are pure strings; no I/O.
import { describe, expect, it } from 'vitest';
import type { ContactId, ListingId, UserId } from '../foundation/index.js';
import {
  FOREIGN_CARD_LABEL,
  FOREIGN_FEED_ITEM_TYPES,
  FOREIGN_KEY_PREFIX,
  coachingFixFeedKey,
  likelyFeedKey,
  marketingFeedKey,
  milestoneKey,
  parseForeignFeedKey,
  sellerUpdateFeedKey,
  weeklyPlanFeedKey,
} from './index.js';
import { contact, dealDate, user } from './testing/fixtures.js';

const LISTING = 'b1000000-0000-7000-8000-000000000001' as ListingId;
const PIECE = 'b2000000-0000-7000-8000-000000000001';

describe('foreign feed key families', () => {
  it('each of the five families builds its key and reads its ids back', () => {
    expect(sellerUpdateFeedKey(LISTING, '2026-11-09')).toBe(`seller_update:${LISTING}:2026-11-09`);
    expect(parseForeignFeedKey(sellerUpdateFeedKey(LISTING, '2026-11-09'))).toEqual({ itemType: 'seller_update', listingId: LISTING, period: '2026-11-09' });
    expect(parseForeignFeedKey(marketingFeedKey(PIECE))).toEqual({ itemType: 'marketing_review', pieceId: PIECE });
    expect(parseForeignFeedKey(weeklyPlanFeedKey(user(1) as UserId, '2026-W46'))).toEqual({ itemType: 'weekly_plan', userId: user(1), week: '2026-W46' });
    expect(parseForeignFeedKey(coachingFixFeedKey(user(1) as UserId, '2026-11-11'))).toEqual({ itemType: 'coaching_fix', userId: user(1), date: '2026-11-11' });
    expect(parseForeignFeedKey(likelyFeedKey(contact(3) as ContactId, 'predict/1.0'))).toEqual({ itemType: 'likely_to_move', contactId: contact(3), modelVersion: 'predict/1.0' });
  });

  it('scorer keys, exception keys and malformed keys are not foreign', () => {
    for (const k of [
      `task:${PIECE}`,
      `deal_date:${PIECE}`,
      `inbound:${contact(1)}:${PIECE}`,
      milestoneKey(dealDate(1), 2),
      'marketing:not-a-uuid',
      `marketing:${PIECE}:extra`,
      `likely:${contact(1)}`,
      `likely:${contact(1)}:a:b`,
      `weekly_plan:${user(1)}:`,
    ]) {
      expect(parseForeignFeedKey(k)).toBeNull();
    }
  });

  it('a key part may not carry a separator', () => {
    expect(() => weeklyPlanFeedKey(user(1) as UserId, '2026:W46')).toThrow(RangeError);
    expect(() => likelyFeedKey(contact(1) as ContactId, '')).toThrow(RangeError);
  });

  it('every foreign card type has a key prefix and a plain-words label (no numbers)', () => {
    for (const t of FOREIGN_FEED_ITEM_TYPES) {
      expect(FOREIGN_KEY_PREFIX[t]).toMatch(/^[a-z_]+$/);
      expect(FOREIGN_CARD_LABEL[t]).toMatch(/^[^0-9%]+$/);
    }
  });

  it('R-ACC-6: the milestone key carries the due version', () => {
    expect(milestoneKey(dealDate(1), 3)).toBe(`milestone:${dealDate(1)}:3`);
  });
});
