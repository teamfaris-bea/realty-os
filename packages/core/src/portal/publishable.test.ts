import { describe, expect, it } from 'vitest';
import { publishable } from './publishable.js';
import { KIND_SOURCE_TYPE, PORTAL_KINDS, type PortalKind, type PortalSource } from './types.js';
import { CLIENT, DEAL, LISTING, OTHER_BUYER, OTHER_DEAL, OTHER_LISTING, OWN_LISTING, dealGrant, documentSrc, facts, feedback, listingGrant, milestone, sellerUpdate, showing, task } from './testing/fixtures.js';

const KIND_OF: Record<PortalSource['type'], PortalKind> = {
  deal_date: 'milestone', document: 'document', showing: 'showing', showing_feedback: 'feedback', assistant_action: 'seller_update', task: 'next_step',
};
const one = (s: PortalSource) => (KIND_OF[s.type]);
const sources = (): PortalSource[] => [milestone(), documentSrc(), showing(), feedback(), sellerUpdate({ triggerListingId: LISTING }), task()];

describe('publishable', () => {
  it('R-PORTAL-3 E89: on the rule (system) path feedback and seller updates are never publishable; a person may publish them', () => {
    const g = dealGrant({ clientIsSellerSide: true });
    for (const s of [feedback(), sellerUpdate()]) {
      expect(publishable(one(s), facts(s, { grant: g, publisher: 'system' }))).toEqual({ ok: false, reason: 'PORTAL_PERSON_ONLY' });
      expect(publishable(one(s), facts(s, { grant: g, publisher: 'user' }))).toEqual({ ok: true });
    }
  });

  it('R-PORTAL-3: of the 36 kind × source-type combinations only the six 0018 pairs pass', () => {
    let passed = 0;
    for (const kind of PORTAL_KINDS) {
      for (const s of sources()) {
        const r = publishable(kind, facts(s, { grant: dealGrant({ clientIsSellerSide: true }) }));
        if (KIND_SOURCE_TYPE[kind] === s.type) expect(r).toEqual({ ok: true });
        else expect(r).toEqual({ ok: false, reason: 'PORTAL_KIND_SOURCE_MISMATCH' });
        if (r.ok) passed += 1;
      }
    }
    expect(passed).toBe(6);
  });

  it('R-PORTAL-3: unconfirmed, unclean, unshared, contact-scoped, unapproved and other-deal sources are refused with PORTAL_SOURCE_NOT_IN_GRANT', () => {
    const refused: PortalSource[] = [
      milestone({ status: 'proposed' }), milestone({ status: 'waived' }), milestone({ dealId: OTHER_DEAL }),
      documentSrc({ scanStatus: 'pending' }), documentSrc({ scanStatus: 'infected' }), documentSrc({ sharedToPortal: false }),
      documentSrc({ dealId: null, contactId: CLIENT }), documentSrc({ dealId: OTHER_DEAL }), documentSrc({ dealId: null, listingId: LISTING }),
      sellerUpdate({ status: 'pending' }), sellerUpdate({ status: 'rejected' }), sellerUpdate({ status: 'invalidated' }), sellerUpdate({ kind: 'message_draft' }),
      sellerUpdate({ triggerListingId: OTHER_LISTING }), sellerUpdate({ triggerListingId: null }),
      showing({ listingId: OTHER_LISTING, buyerContactId: OTHER_BUYER }), showing({ listingId: OTHER_LISTING, buyerContactId: null }),
      feedback({ listingId: OTHER_LISTING, buyerContactId: OTHER_BUYER }),
      task({ dealId: OTHER_DEAL }), task({ dealId: null, listingId: OTHER_LISTING }), task({ dealId: null, listingId: LISTING }),
    ];
    for (const s of refused) expect(publishable(one(s), facts(s, { grant: dealGrant({ clientIsSellerSide: true }) }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
  });

  it('R-PORTAL-3: a listing grant takes its own listing\'s document, showing, feedback, seller update and task, never a deal\'s', () => {
    const g = listingGrant();
    const ok: PortalSource[] = [documentSrc({ dealId: null, listingId: OWN_LISTING }), showing({ listingId: OWN_LISTING, buyerContactId: OTHER_BUYER }),
      feedback({ listingId: OWN_LISTING, buyerContactId: null }), sellerUpdate({ triggerListingId: OWN_LISTING }), task({ dealId: null, listingId: OWN_LISTING })];
    for (const s of ok) expect(publishable(one(s), facts(s, { grant: g }))).toEqual({ ok: true });
    for (const s of [milestone(), documentSrc(), task(), sellerUpdate({ triggerListingId: LISTING })]) {
      expect(publishable(one(s), facts(s, { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    }
  });

  // 2(a): the rule path publishes confirmed milestones only.
  it('the rule path publishes a confirmed milestone, and no document, showing or next step (stricter 2(a), 2(d))', () => {
    const g = dealGrant({ clientIsSellerSide: true });
    expect(publishable('milestone', facts(milestone(), { publisher: 'system', grant: g }))).toEqual({ ok: true });
    expect(publishable('milestone', facts(milestone({ status: 'proposed' }), { publisher: 'system', grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    expect(publishable('document', facts(documentSrc(), { publisher: 'system', grant: g }))).toEqual({ ok: false, reason: 'PORTAL_RULE_MILESTONES_ONLY' });
    expect(publishable('showing', facts(showing(), { publisher: 'system', grant: g }))).toEqual({ ok: false, reason: 'PORTAL_RULE_MILESTONES_ONLY' });
    expect(publishable('next_step', facts(task(), { publisher: 'system', grant: g }))).toEqual({ ok: false, reason: 'PORTAL_PERSON_ONLY' });
    expect(publishable('next_step', facts(task(), { publisher: 'user', grant: g }))).toEqual({ ok: true });
  });

  // 2(b), conflict note 1: through the deal's listing only a seller-side party is reached.
  it('a buyer on a deal naming a listing gets only the showings they attended and their feedback (stricter 2(b))', () => {
    const buyer = dealGrant({ clientIsSellerSide: false });
    const seller = dealGrant({ clientIsSellerSide: true });
    const othersShowing = showing({ listingId: LISTING, buyerContactId: OTHER_BUYER });
    const othersFeedback = feedback({ listingId: LISTING, buyerContactId: OTHER_BUYER });
    const update = sellerUpdate({ triggerListingId: LISTING });
    for (const s of [othersShowing, othersFeedback, update]) {
      expect(publishable(one(s), facts(s, { grant: buyer }))).toEqual({ ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' });
      expect(publishable(one(s), facts(s, { grant: seller }))).toEqual({ ok: true });
    }
    for (const s of [showing({ listingId: OTHER_LISTING, buyerContactId: CLIENT }), feedback({ listingId: LISTING, buyerContactId: CLIENT })]) {
      expect(publishable(one(s), facts(s, { grant: buyer }))).toEqual({ ok: true });
    }
  });

  // R-PORTAL-6 (publish-time half), 2(c): no new item into a revoked or lapsed grant, or for a disabled account.
  it('a revoked or lapsed grant, or a disabled account, takes no new item (stricter 2(c))', () => {
    for (const over of [{ revoked: true }, { lapsed: true }, { accountDisabled: true }]) {
      for (const s of sources()) {
        expect(publishable(one(s), facts(s, { grant: dealGrant({ clientIsSellerSide: true, ...over }) }))).toEqual({ ok: false, reason: 'PORTAL_GRANT_INACTIVE' });
      }
    }
  });

  it('verbatim text over 4000 code points, or with a control character, is refused, never cut', () => {
    const g = dealGrant({ clientIsSellerSide: true });
    expect(publishable('feedback', facts(feedback({}, { comments: 'x'.repeat(4000) }), { grant: g }))).toEqual({ ok: true });
    expect(publishable('feedback', facts(feedback({}, { comments: 'x'.repeat(4001) }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_TEXT_TOO_LONG' });
    expect(publishable('seller_update', facts(sellerUpdate({ text: '😀'.repeat(4000) }), { grant: g }))).toEqual({ ok: true });
    expect(publishable('seller_update', facts(sellerUpdate({ text: '😀'.repeat(4001) }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_TEXT_TOO_LONG' });
    expect(publishable('seller_update', facts(sellerUpdate({ text: 'a\u0000b' }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_TEXT_NOT_PLAIN' });
    expect(publishable('seller_update', facts(sellerUpdate({ text: 'a\uD800b' }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_TEXT_NOT_PLAIN' });
    expect(publishable('seller_update', facts(sellerUpdate({ text: 'line one\r\nline two\ttab' }), { grant: g }))).toEqual({ ok: true });
    expect(publishable('feedback', facts(feedback({}, { comments: null, rating: null }), { grant: g }))).toEqual({ ok: true });
  });

  it('a deal-grant document of the deal passes; the deal grant reaches a document only through the deal', () => {
    expect(publishable('document', facts(documentSrc({ dealId: DEAL })))).toEqual({ ok: true });
  });
});
