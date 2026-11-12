import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { publishable } from './publishable.js';
import { renderPortalItem } from './render.js';
import { checksAccept, dbAccepts, guardCaseAccepts, rowChecksAccept } from './testing/guard.js';
import { anyText, factsArb, grantArb, kindArb } from './testing/arbitraries.js';
import { CLIENT, DEAL, LISTING, OTHER_BUYER, OTHER_DEAL, OTHER_LISTING, dealGrant, documentSrc, facts, feedback, milestone, sellerUpdate, showing, task } from './testing/fixtures.js';
import { KIND_SOURCE_TYPE, type PortalKind, type PortalSource, type SourceFacts } from './types.js';

const KIND_OF = Object.fromEntries(Object.entries(KIND_SOURCE_TYPE).map(([k, t]) => [t, k])) as Record<PortalSource['type'], PortalKind>;

/** The stricter-than-DB refusals 2(a)–(d) and the verbatim limits, written independently of publishable.ts. */
function stricterRefuses(kind: PortalKind, f: SourceFacts): boolean {
  const g = f.grant;
  const s = f.source;
  if (f.publisher === 'system' && kind !== 'milestone') return true; // (a), (d)
  if (g.revoked || g.lapsed || g.accountDisabled) return true; // (c)
  if (s.type === 'showing' || s.type === 'showing_feedback') {
    const own = g.listingId !== null && s.listingId === g.listingId;
    const attended = s.buyerContactId !== null && s.buyerContactId === g.clientContactId;
    if (!own && !attended && !g.clientIsSellerSide) return true; // (b)
  }
  if (s.type === 'assistant_action' && !(g.listingId !== null && s.triggerListingId === g.listingId) && !g.clientIsSellerSide) return true; // (b)
  if (s.type === 'document' && s.contactId !== null) return true;
  const text = s.type === 'showing_feedback' ? s.feedback.comments : s.type === 'assistant_action' ? s.text : null;
  // eslint-disable-next-line no-control-regex -- detecting control characters is the point
  if (text !== null && (Array.from(text).length > 4000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/.test(text) || /[\uD800-\uDFFF]/.test(text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')))) return true;
  return false;
}

describe('publishable (properties)', () => {
  it('R-PORTAL-3: never accepts what the CHECKs and the guard\'s CASE refuse, and accepts exactly that minus the stricter refusals', () => {
    fc.assert(fc.property(kindArb, factsArb(anyText), (kind, f) => {
      const r = publishable(kind, f);
      if (r.ok) expect(dbAccepts(kind, f)).toBe(true);
      expect(r.ok).toBe(dbAccepts(kind, f) && !stricterRefuses(kind, f));
    }), { numRuns: 5000 });
  });

  it('a refusal by the CHECKs or the guard is never ok, whatever the other facts', () => {
    fc.assert(fc.property(kindArb, factsArb(), (kind, f) => {
      if (!checksAccept(kind, f) || !guardCaseAccepts(f)) expect(publishable(kind, f).ok).toBe(false);
    }), { numRuns: 3000 });
  });

  it('breaking any one binding or state fact of a publishable item never yields ok', () => {
    const seller = dealGrant({ clientIsSellerSide: true });
    type Case = { base: SourceFacts; breaks: ((f: SourceFacts) => SourceFacts)[] };
    const withSource = (f: SourceFacts, over: object): SourceFacts => ({ ...f, source: { ...f.source, ...over } as PortalSource });
    const withGrant = (f: SourceFacts, over: object): SourceFacts => ({ ...f, grant: { ...f.grant, ...over } });
    const grantBreaks = [(f: SourceFacts) => withGrant(f, { revoked: true }), (f: SourceFacts) => withGrant(f, { lapsed: true }), (f: SourceFacts) => withGrant(f, { accountDisabled: true })];
    const cases: Case[] = [
      { base: facts(milestone(), { grant: seller }), breaks: [(f) => withSource(f, { status: 'proposed' }), (f) => withSource(f, { status: 'waived' }), (f) => withSource(f, { dealId: OTHER_DEAL }), (f) => withGrant(f, { dealId: OTHER_DEAL })] },
      { base: facts(documentSrc(), { grant: seller }), breaks: [(f) => withSource(f, { scanStatus: 'pending' }), (f) => withSource(f, { scanStatus: 'infected' }), (f) => withSource(f, { sharedToPortal: false }), (f) => withSource(f, { dealId: null, contactId: CLIENT }), (f) => withSource(f, { dealId: OTHER_DEAL })] },
      { base: facts(showing({ listingId: LISTING, buyerContactId: OTHER_BUYER }), { grant: seller }), breaks: [(f) => withSource(f, { listingId: OTHER_LISTING }), (f) => withGrant(f, { clientIsSellerSide: false }), (f) => withGrant(f, { dealListingId: null })] },
      { base: facts(feedback({ listingId: OTHER_LISTING, buyerContactId: CLIENT }), { grant: seller }), breaks: [(f) => withSource(f, { buyerContactId: OTHER_BUYER }), (f) => withSource(f, { buyerContactId: null }), (f) => withGrant(f, { clientContactId: OTHER_BUYER }), (f) => ({ ...f, publisher: 'system' })] },
      { base: facts(sellerUpdate(), { grant: seller }), breaks: [(f) => withSource(f, { status: 'pending' }), (f) => withSource(f, { kind: 'next_step' }), (f) => withSource(f, { triggerListingId: OTHER_LISTING }), (f) => withGrant(f, { clientIsSellerSide: false }), (f) => ({ ...f, publisher: 'system' })] },
      { base: facts(task(), { grant: seller }), breaks: [(f) => withSource(f, { dealId: OTHER_DEAL }), (f) => withGrant(f, { dealId: OTHER_DEAL }), (f) => ({ ...f, publisher: 'system' })] },
    ];
    for (const c of cases) {
      const kind = KIND_OF[c.base.source.type];
      expect(publishable(kind, c.base)).toEqual({ ok: true });
      for (const brk of [...c.breaks, ...grantBreaks]) expect(publishable(kind, brk(c.base)).ok).toBe(false);
    }
    expect(DEAL).not.toBe(OTHER_DEAL);
  });
});

describe('renderPortalItem (properties)', () => {
  it('is total over arbitrary Unicode and always within the portal_items CHECKs', () => {
    fc.assert(fc.property(factsArb(anyText), (f) => {
      const o = renderPortalItem(f);
      expect(rowChecksAccept(o)).toBe(true);
      expect(o.title).toBe(o.title.trim());
      expect(o.kind).toBe(KIND_OF[f.source.type]);
    }), { numRuns: 3000 });
  });

  it('does not depend on the publisher or the grant', () => {
    fc.assert(fc.property(factsArb(anyText), grantArb, fc.constantFrom('user', 'system' as const), (f, g, p) => {
      expect(renderPortalItem({ ...f, grant: g, publisher: p })).toEqual(renderPortalItem(f));
    }), { numRuns: 1000 });
  });

  it('a publishable verbatim text is copied exactly', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 500 }), (text) => {
      const f = facts(sellerUpdate({ text }), { grant: dealGrant({ clientIsSellerSide: true }) });
      if (publishable('seller_update', f).ok) expect(renderPortalItem(f).body).toBe(text === '' ? null : text);
    }));
  });
});
