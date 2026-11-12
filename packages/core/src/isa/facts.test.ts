import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentGuard } from '../assistant/index.js';
import { at } from '../foundation/index.js';
import type { DisplayListing } from '../listings/index.js';
import {
  type CompGates,
  type IsaCompResult,
  type IsaCompView,
  SELLER_DATA_LINES,
  compSetHash,
  compsSmsPointer,
  factsMessage,
  fitsSms,
  nearbySaleLine,
  renderBuyerListing,
  renderCompetitor,
  renderCompsEmail,
  subjectLine,
} from './facts.js';
import { IDENTITY } from './testing/fixtures.js';

const AS_OF = at('2026-11-12T08:00:00Z');
const src = { mlsName: 'Sample MLS', teamName: 'Maple Team', asOf: AS_OF, fresh: true };
const listing = (o: Partial<DisplayListing> = {}): DisplayListing => ({
  audience: 'client',
  id: null,
  source: 'mls',
  sourceLabel: 'MLS',
  isTeamListing: false,
  listingBrokerageName: 'Other Brokerage Inc',
  attribution: 'Listing data courtesy of Sample MLS.',
  disclaimer: 'Information deemed reliable but not guaranteed.',
  addressHidden: true,
  omittedFields: ['address', 'description', 'photos'],
  status: 'active',
  listPriceCents: 45_000_000,
  beds: 3,
  bathsX10: 25,
  sqft: 1850,
  locality: { city: 'Springfield', region: 'IL', postalCode: '62701' },
  ...o,
});

describe('R-ISA-17 buyer listing lines', () => {
  it('asking price labelled, status, brokerage, own as-of and source', () => {
    expect(renderBuyerListing(listing(), src)).toEqual({
      ok: true,
      line: '3 bd · 2.5 ba · 1,850 sq ft · Springfield — listed at $450,000 (asking price) · Active · Listed by Other Brokerage Inc · listed as Active in the MLS as of Nov 12, 2026 · Source: Sample MLS via Maple Team',
    });
  });
  it('the address only when allowed; team listings carry the team as source', () => {
    const r = renderBuyerListing(listing({ addressHidden: false, address: { line1: '12 Elm St', line2: null } }), src);
    expect(r.ok && r.line.startsWith('12 Elm St, 3 bd')).toBe(true);
    const team = renderBuyerListing(listing({ isTeamListing: true, source: 'team', listingBrokerageName: null, attribution: null, disclaimer: null, status: 'coming_soon' }), src);
    expect(team.ok && team.line).toMatch(/Coming soon · Listed by Maple Team .* Source: Maple Team$/);
  });
  it('E535 omitted fields, a missing brokerage or attribution, an unshareable status or a stale row refuse the fact', () => {
    expect(renderBuyerListing(listing({ omittedFields: ['status'] }), src)).toEqual({ ok: false, refusal: 'STATUS_OMITTED' });
    expect(renderBuyerListing(listing({ omittedFields: ['listPrice'] }), src)).toEqual({ ok: false, refusal: 'PRICE_OMITTED' });
    expect(renderBuyerListing(listing({ listPriceCents: null }), src)).toEqual({ ok: false, refusal: 'PRICE_OMITTED' });
    expect(renderBuyerListing(listing({ listingBrokerageName: null }), src)).toEqual({ ok: false, refusal: 'BROKERAGE_MISSING' });
    expect(renderBuyerListing(listing({ attribution: null }), src)).toEqual({ ok: false, refusal: 'ATTRIBUTION_MISSING' });
    expect(renderBuyerListing(listing({ status: 'pending' }), src)).toEqual({ ok: false, refusal: 'STATUS_NOT_SHAREABLE' });
    expect(renderBuyerListing(listing(), { ...src, fresh: false })).toEqual({ ok: false, refusal: 'ROW_STALE' });
    const minimal = renderBuyerListing(listing({ beds: null, bathsX10: null, sqft: null, locality: undefined }), src);
    expect(minimal.ok && minimal.line.startsWith(' — listed at')).toBe(true);
  });
});

describe('R-ISA-18 competing listings', () => {
  it('a new competitor: asking price, not a sale price', () => {
    const r = renderCompetitor(listing(), src, 'new_competitor');
    expect(r.ok && r.line).toMatch(/^New listing near you: 3 bd .* listed at \$450,000 \(asking price, not a sale price\) · Active · Listed by Other Brokerage Inc/);
    expect(renderCompetitor(listing(), src, 'competitor_price_change').ok && 'x').toBe('x');
    expect((renderCompetitor(listing(), src, 'competitor_back_on_market') as { line: string }).line).toMatch(/^Back on the market near you/);
    expect((renderCompetitor(listing(), src, 'competitor_price_change') as { line: string }).line).toMatch(/^Price change near you/);
  });
  it('E537 pending is worded "Pending (not yet sold)", never "under contract"', () => {
    const r = renderCompetitor(listing({ status: 'pending' }), src, 'competitor_pending');
    expect(r.ok && r.line).toMatch(/^Now pending \(not yet sold\): .* last asking price \$450,000 .* listed as Pending \(not yet sold\) in the MLS/);
    expect(r.ok && r.line).not.toMatch(/contract/i);
    expect(renderCompetitor(listing({ status: 'active' }), src, 'competitor_pending')).toEqual({ ok: false, refusal: 'STATUS_NOT_SHAREABLE' });
  });
  it('a sold competitor never renders before the sold gates; off-market is not a client fact', () => {
    expect(renderCompetitor(listing({ status: 'sold' }), src, 'competitor_sold')).toEqual({ ok: false, refusal: 'SOLD_NOT_CLEARED' });
    expect(renderCompetitor(listing(), src, 'competitor_off_market')).toEqual({ ok: false, refusal: 'STATUS_NOT_SHAREABLE' });
    expect(renderCompetitor(listing({ status: 'pending' }), src, 'new_competitor')).toEqual({ ok: false, refusal: 'STATUS_NOT_SHAREABLE' });
  });
  it('every rendered template passes contentGuard (no money or contract topic, no human claim)', () => {
    const lines = [renderBuyerListing(listing(), src), renderCompetitor(listing(), src, 'new_competitor'), renderCompetitor(listing({ status: 'pending' }), src, 'competitor_pending')].map((r) => (r as { line: string }).line);
    const body = factsMessage({ intro: 'Here are homes that match what you told me:', lines, attribution: 'Courtesy of Sample MLS.', disclaimer: 'Deemed reliable.', channel: 'email' });
    const g = contentGuard(body, { channel: 'email', purpose: 'informational', maxLength: 8000 }, IDENTITY, { firstInThread: false, requireSignOff: false });
    expect(g.issues).toEqual([]);
    expect(factsMessage({ intro: 'x', lines: ['a'], attribution: null, disclaimer: '  ', channel: 'sms' })).toBe('x\na');
  });
  it('SMS facts only when they fit three segments', () => {
    expect(fitsSms('a'.repeat(459))).toBe(true);
    expect(fitsSms('a'.repeat(460))).toBe(false);
    expect(fitsSms('é'.repeat(200))).toBe(true);
    expect(fitsSms('😀'.repeat(150))).toBe(false);
    expect(fitsSms('a'.repeat(160), 1)).toBe(true);
    expect(fitsSms('😀'.repeat(36), 1)).toBe(false);
  });
});

const comp = (k: number, o: Partial<IsaCompView> = {}): IsaCompView => ({ identity: `id${k}`, closePriceCents: 40_000_000 + k * 1_000_000, closeDate: '2026-08-0' + ((k % 9) + 1), beds: 3, sqft: 1800, tier: 'within_1mi', locationLabel: null, listingBrokerageName: 'Other Brokerage Inc', why: 'Same type and size, within a mile', ...o });
const result = (n = 4, o: Partial<IsaCompResult> = {}): IsaCompResult => ({ methodVersion: 'cma/1', comps: Array.from({ length: n }, (_, k) => comp(k)), areaLookbackMonths: 12, sizeFilterApplied: true, bedsFilterApplied: true, sentences: ['Sales from the last 12 months.'], ...o });
const gates: CompGates = { blockers: [], packsCleared: true, subjectConfirmed: true };
const subject = { recordDate: '2019-05-01', beds: 3, sqft: 1850 };
const email = (o: Partial<Parameters<typeof renderCompsEmail>[0]> = {}) => renderCompsEmail({ result: result(), gates, subject, mlsName: 'Sample MLS', teamName: 'Maple Team', asOf: AS_OF, stateStatement: null, attribution: 'Courtesy of Sample MLS.', ...o });

describe('R-ISA-18 E534 E536 the comps email: the complete engine set or nothing', () => {
  it('exactly result.comps, in engine order, with sale-price labels, the subject line and the data lines', () => {
    const r = email();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.compIdentities).toEqual(['id0', 'id1', 'id2', 'id3']);
    expect(r.body).toContain("Compared using your home's MLS record from May 1, 2019: 3 bd, 1,850 sq ft. Tell me if that's changed.");
    expect(r.body).toContain('1. Sold for $400,000 on Aug 1, 2026 (sale price) · 3 bd · 1,800 sq ft · Listed by Other Brokerage Inc · Same type and size, within a mile');
    for (const l of SELLER_DATA_LINES) expect(r.body).toContain(l);
    expect(r.body).not.toMatch(/worth|estimate|range|adjusted|value of your/i);
    expect(r.hash).toBe(compSetHash(result()));
    expect(email({ updated: true }).ok && (email({ updated: true }) as { body: string }).body).toMatch(/\(Updated Nov 12, 2026\)/);
    expect((email({ stateStatement: 'State notice placeholder.' }) as { body: string }).body).toContain('State notice placeholder.');
  });
  it('property: the comps email contains exactly result.comps (every one, in order), or nothing', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 6 }), fc.boolean(), fc.constantFrom('within_1mi', 'subdivision', 'city'), (n, cleared, tier) => {
        const r = renderCompsEmail({ result: result(n, { comps: Array.from({ length: n }, (_, k) => comp(k, { tier: k === 0 ? tier : 'postal_code' })) }), gates: { ...gates, packsCleared: cleared }, subject, mlsName: 'M', teamName: 'T', asOf: AS_OF, stateStatement: null, attribution: null });
        if (!r.ok) return;
        expect(r.compIdentities).toEqual(Array.from({ length: n }, (_, k) => `id${k}`));
        for (let k = 0; k < n; k++) expect(r.body).toContain(`${k + 1}. Sold for`);
        expect(r.body).not.toContain(`${n + 1}. Sold for`);
      }),
    );
  });
  it('refused: packs uncleared, subject unconfirmed, any blocker, < 3 comps, a ceiling, a missing close or brokerage', () => {
    expect(email({ gates: { ...gates, packsCleared: false } })).toEqual({ ok: false, refusal: 'SOLD_NOT_CLEARED' });
    expect(email({ gates: { ...gates, subjectConfirmed: false } })).toEqual({ ok: false, refusal: 'SUBJECT_UNCONFIRMED' });
    expect(email({ gates: { ...gates, blockers: ['COMPS_HIDDEN'] } })).toEqual({ ok: false, refusal: 'COMPS_GATED' });
    expect(email({ result: result(2) })).toEqual({ ok: false, refusal: 'COMPS_TOO_FEW' });
    expect(email({ result: result(4, { areaLookbackMonths: 24 }) })).toEqual({ ok: false, refusal: 'COMPS_CEILING' });
    expect(email({ result: result(4, { sizeFilterApplied: false }) })).toEqual({ ok: false, refusal: 'COMPS_CEILING' });
    expect(email({ result: result(4, { comps: [comp(0, { tier: 'city' }), comp(1), comp(2)] }) })).toEqual({ ok: false, refusal: 'COMPS_CEILING' });
    expect(email({ result: result(4, { comps: [comp(0, { closePriceCents: null }), comp(1), comp(2)] }) })).toEqual({ ok: false, refusal: 'CLOSE_OMITTED' });
    expect(email({ result: result(4, { comps: [comp(0, { listingBrokerageName: ' ' }), comp(1), comp(2)] }) })).toEqual({ ok: false, refusal: 'BROKERAGE_MISSING' });
  });
  it('the SMS gets only the pointer; the hash changes with the set', () => {
    expect(compsSmsPointer(4)).toBe("I've emailed you the 4 recent sales I found.");
    expect(compSetHash(result(4))).not.toBe(compSetHash(result(5)));
    expect(subjectLine({ recordDate: '2020-01-02', beds: null, sqft: 900 })).toBe("Compared using your home's MLS record from Jan 2, 2020: 900 sq ft. Tell me if that's changed.");
  });
});

describe('R-ISA-18 E536 merely nearby sales: the reason whitelist', () => {
  it('whitelisted reasons render "not comparable"; any other goes to data_unavailable', () => {
    const ok = nearbySaleLine({ reason: 'size_not_similar', comp: comp(1), addressDisplayAllowed: true, gates });
    expect(ok).toEqual({ ok: true, line: 'Nearby sale, not comparable to your home: its size is different from yours. Sold for $410,000 on Aug 2, 2026 (sale price) · Listed by Other Brokerage Inc' });
    for (const reason of ['not_among_closest', 'implausible_price', 'sale_condition', 'lease', 'duplicate', 'outside_area']) expect(nearbySaleLine({ reason, comp: comp(1), addressDisplayAllowed: true, gates })).toEqual({ ok: false, refusal: 'NEARBY_REASON_NOT_ALLOWED' });
    expect(nearbySaleLine({ reason: 'beds_not_similar', comp: comp(1), addressDisplayAllowed: false, gates })).toEqual({ ok: false, refusal: 'ADDRESS_NOT_ALLOWED' });
    expect(nearbySaleLine({ reason: 'beds_not_similar', comp: comp(1), addressDisplayAllowed: true, gates: { ...gates, packsCleared: false } })).toEqual({ ok: false, refusal: 'SOLD_NOT_CLEARED' });
    expect(nearbySaleLine({ reason: 'beds_not_similar', comp: comp(1), addressDisplayAllowed: true, gates: { ...gates, blockers: ['X'] } })).toEqual({ ok: false, refusal: 'COMPS_GATED' });
    expect(nearbySaleLine({ reason: 'other_property_type', comp: comp(1, { closeDate: null }), addressDisplayAllowed: true, gates })).toEqual({ ok: false, refusal: 'CLOSE_OMITTED' });
    expect(nearbySaleLine({ reason: 'year_built_not_similar', comp: comp(1, { listingBrokerageName: null }), addressDisplayAllowed: true, gates })).toEqual({ ok: false, refusal: 'BROKERAGE_MISSING' });
  });
});
