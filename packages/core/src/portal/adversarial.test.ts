// Adversarial cases for core/portal (critical: isolation). Core takes no tenant input and adds no route,
// handler or SQL; tenancy is RLS's (module 43). These try to make publishable() or renderPortalItem()
// reach another deal, listing or buyer, copy a field it must not, or emit text the CHECKs refuse.
import { describe, expect, it } from 'vitest';
import { publishable } from './publishable.js';
import { renderPortalItem } from './render.js';
import { rowChecksAccept } from './testing/guard.js';
import { CLIENT, DEAL, LISTING, OTHER_BUYER, OTHER_DEAL, OTHER_LISTING, dealGrant, documentSrc, facts, feedback, milestone, sellerUpdate, showing, task } from './testing/fixtures.js';
import type { PortalKind, SourceFacts } from './types.js';

describe('core/portal adversarial', () => {
  it('forged kind/source pairs are refused', () => {
    const g = dealGrant({ clientIsSellerSide: true });
    expect(publishable('milestone', facts(documentSrc(), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_KIND_SOURCE_MISMATCH' });
    expect(publishable('next_step', facts(feedback(), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_KIND_SOURCE_MISMATCH' });
    expect(publishable('document', facts({ ...documentSrc(), type: 'task' } as never, { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    expect(publishable('portal_admin' as PortalKind, facts(task(), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    expect(publishable('milestone', facts({ ...milestone(), type: 'deal_dates' } as never))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    // the rule path cannot launder a person-only kind through a forged publisher value
    expect(publishable('feedback', { ...facts(feedback()), publisher: 'User' as never })).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
  });

  it('ids that differ by case or whitespace are refused, never matched loosely', () => {
    const hexDeal = '0000abcd-0000-7000-8000-00000000beef';
    const g0 = dealGrant({ dealId: hexDeal as never });
    expect(publishable('milestone', facts(milestone({ dealId: hexDeal as never }), { grant: g0 }))).toEqual({ ok: true });
    expect(publishable('milestone', facts(milestone({ dealId: hexDeal.toUpperCase() as never }), { grant: g0 }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    expect(publishable('milestone', facts(milestone({ dealId: hexDeal as never }), { grant: dealGrant({ dealId: hexDeal.toUpperCase() as never }) }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    expect(publishable('milestone', facts(milestone({ dealId: ` ${DEAL}` as never })))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    expect(publishable('milestone', facts(milestone(), { grant: dealGrant({ dealId: `${DEAL}\n` as never }) }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    // trigger_ref->>'listing_id' is compared as text in the guard: an upper-case copy matches neither there nor here
    const hexListing = '0000abcd-0000-7000-8000-00000000cafe';
    const g = dealGrant({ clientIsSellerSide: true, dealListingId: hexListing as never });
    expect(publishable('seller_update', facts(sellerUpdate({ triggerListingId: hexListing }), { grant: g }))).toEqual({ ok: true });
    expect(publishable('seller_update', facts(sellerUpdate({ triggerListingId: hexListing.toUpperCase() }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    expect(publishable('seller_update', facts(sellerUpdate({ triggerListingId: ` ${hexListing}` }), { grant: g }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
  });

  it('__proto__ and unknown keys are never copied or obeyed', () => {
    const json = `{"type":"task","id":"${task().id}","dealId":"${DEAL}","listingId":null,"title":"Sign","dueAt":null,"status":"open",
      "__proto__":{"dealId":"${OTHER_DEAL}","isAdmin":true},"notes":"secret","tenant_id":"t-1","assigneeUserId":"u-1","contactPhone":"+15555550100"}`;
    const src = JSON.parse(json) as SourceFacts['source'];
    const f = facts(src);
    expect(publishable('next_step', f)).toEqual({ ok: true });
    const out = renderPortalItem(f);
    expect(Object.keys(out).sort()).toEqual(['body', 'documentId', 'kind', 'occursOn', 'sourceId', 'sourceType', 'sourceVersion', 'title']);
    const text = JSON.stringify(out);
    for (const leak of ['secret', 't-1', 'u-1', '5555550100', 'isAdmin', OTHER_DEAL]) expect(text).not.toContain(leak);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    // a JSON "__proto__" key on the facts themselves does not supply a missing grant
    const forged = JSON.parse(`{"source":${JSON.stringify(task())},"publisher":"user","zone":"${f.zone}","__proto__":{"grant":${JSON.stringify(dealGrant())}}}`) as SourceFacts;
    expect(publishable('next_step', forged)).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
  });

  it('zero-width, RTL, control and HTML text stays plain and within the limits', () => {
    const nasty = ['\u200B\u200B\u200B', '\u202Egnp.exe\u202C', '\u0000\u0001\u001B[31m', '<script>alert(1)</script>', '&lt;b&gt;', '\uFEFF\u00A0\u3000', '\uD800', 'a'.repeat(5000), '😀'.repeat(200)];
    for (const s of nasty) {
      for (const f of [facts(task({ title: s })), facts(documentSrc({ displayName: s })), facts(milestone({ kind: 'custom', label: s })), facts(feedback({}, { comments: s })), facts(sellerUpdate({ text: s }))]) {
        const o = renderPortalItem(f);
        expect(rowChecksAccept(o)).toBe(true);
        // eslint-disable-next-line no-control-regex -- detecting control characters is the point
        expect(o.title).not.toMatch(/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/);
        expect(o.title.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')).not.toMatch(/[\uD800-\uDFFF]/);
        // eslint-disable-next-line no-control-regex -- detecting control characters is the point
        if (o.body !== null) expect(o.body).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/);
      }
    }
    // HTML is text, not markup: copied as typed and never interpreted or escaped by core
    expect(renderPortalItem(facts(task({ title: '<b>Sign</b> & return' }))).title).toBe('<b>Sign</b> & return');
    // an RTL override cannot reverse a title: it is dropped from the one-line title
    expect(renderPortalItem(facts(documentSrc({ displayName: 'invoice\u202Efdp.exe' }))).title).toBe('invoicefdp.exe');
  });

  it('another deal\'s grant reaches nothing of this deal', () => {
    const other = dealGrant({ dealId: OTHER_DEAL, dealListingId: OTHER_LISTING, clientIsSellerSide: true });
    for (const [kind, s] of [['milestone', milestone()], ['document', documentSrc()], ['next_step', task()], ['showing', showing({ buyerContactId: OTHER_BUYER })],
      ['feedback', feedback({ buyerContactId: null })], ['seller_update', sellerUpdate()]] as [PortalKind, SourceFacts['source']][]) {
      expect(publishable(kind, facts(s, { grant: other }))).toEqual({ ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' });
    }
  });

  it('a buyer never reaches another buyer\'s showing, its feedback, or the seller\'s update', () => {
    // A buy-side deal that names the listing (createDeal accepts listingId for buy deals): conflict note 1.
    const buyer = dealGrant({ clientContactId: CLIENT, clientIsSellerSide: false });
    expect(publishable('showing', facts(showing({ listingId: LISTING, buyerContactId: OTHER_BUYER }), { grant: buyer }))).toEqual({ ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' });
    expect(publishable('showing', facts(showing({ listingId: LISTING, buyerContactId: null }), { grant: buyer }))).toEqual({ ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' });
    expect(publishable('feedback', facts(feedback({ listingId: LISTING, buyerContactId: OTHER_BUYER }), { grant: buyer }))).toEqual({ ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' });
    expect(publishable('seller_update', facts(sellerUpdate({ triggerListingId: LISTING }), { grant: buyer }))).toEqual({ ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' });
    // and the rule path cannot publish those showings either
    expect(publishable('showing', facts(showing({ listingId: LISTING, buyerContactId: OTHER_BUYER }), { grant: buyer, publisher: 'system' })).ok).toBe(false);
  });

  it('malformed facts never throw from publishable and are refused', () => {
    for (const bad of [null, undefined, 42, 'x', [], {}, { source: null }, { ...facts(task()), zone: 'Mars/Olympus' }, { ...facts(task()), grant: { ...dealGrant(), listingId: OTHER_LISTING } },
      facts(milestone({ dueVersion: 2 ** 31 })), facts(documentSrc({ versionNo: 0 })), facts(feedback({}, { rating: 6 })), facts(showing({}, { startsAt: Number.NaN as never }))]) {
      expect(publishable('next_step', bad as never)).toEqual({ ok: false, reason: 'PORTAL_SOURCE_INVALID' });
    }
  });
});
