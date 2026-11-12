// Adversarial tests of module 71 api/cma (critical: MLS licence and client disclosure gates). Each tries to break
// tenancy, the comp rules (R-CMA-2), the strict input schemas (fair housing), the draft rules (R-CMA-8) or the near-match
// gate (F2), and expects the refusal or a harmless no-op. Nothing is sent in V1 (no comms path exists here).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;
let other: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([cmaWorld(h), cmaWorld(h)]);
  await Promise.all([localSales(w, 10), localSales(other, 4)]);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function seller(ww: CmaWorld = w) {
  const c = await contact(ww.agents[0]!);
  const line1 = `${2000 + Math.floor(Math.random() * 7000)} Sample Avenue`;
  const addr = await address(h, ww.tenantId, c, { line1 });
  await mlsSale(ww, { line1, closeDate: daysAgo(2500) });
  return { c, addr, line1 };
}

describe('forged ids', () => {
  it('R-PERM-5: a contactAddressId of another contact (same tenant) or of another tenant is 404 on both prepare paths, and nothing is stored', async () => {
    const mine = await seller();
    const theirs = await seller(); // another contact of the same agent's tenant
    const foreign = await seller(other);
    for (const addr of [theirs.addr, foreign.addr]) {
      const a = await call(w.agents[0]!, 'POST', '/cma', { subject: { kind: 'contact_address', contactAddressId: addr }, contactId: mine.c, purpose: 'listing_price' });
      const b = await oneTap(w.agents[0]!, mine.c, { contactAddressId: addr });
      expect([a.status, b.status]).toEqual([404, 404]);
    }
    expect((await h.su.query('SELECT count(*)::int AS n FROM cma_reports WHERE contact_id = $1', [mine.c])).rows[0].n).toBe(0);
  });

  it('R-CMA-2: include of a lease, a future sale or another tenant\'s listing never makes it a comp', async () => {
    const { c } = await seller();
    const lease = await mlsSale(w, { isLease: true, closePriceCents: 240_000, closeDate: daysAgo(10) });
    const future = await mlsSale(w, { closeDate: daysAgo(-10) });
    const foreign = await mlsSale(other, { closeDate: daysAgo(10) });
    const a = await oneTap(w.agents[0]!, c);
    const p = await call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { include: [lease, future, foreign, randomUUID()] });
    expect(p.status).toBe(200);
    const comps = p.body.cma.comps.map((x) => x.listingId);
    for (const id of [lease, future, foreign]) expect(comps).not.toContain(id);
    expect(JSON.stringify(p.body)).not.toContain(foreign);
  });

  it('E360: a lease the vocabulary missed (a "sale" at a rent-sized price) is not used: "the price looks like a rent or a data error"', async () => {
    const { c } = await seller();
    const rent = await mlsSale(w, { closePriceCents: 240_000, closeDate: daysAgo(12), sqft: 1500 });
    const a = await oneTap(w.agents[0]!, c);
    expect(a.body.cma.notUsed.find((x) => x.listingId === rent)).toMatchObject({ reason: 'implausible_price', sentence: 'Not used: the price looks like a rent or a data error.' });
  });
});

describe('stored values beyond the engine\'s bounds', () => {
  it('E361 R-CMA-2: an MLS sale the sync stored with a value beyond the engine\'s bounds (a $2 billion close price) is left out and said; the CMA is still prepared', async () => {
    const wb = await cmaWorld(h);
    await localSales(wb, 5);
    const bad = await mlsSale(wb, { closePriceCents: 200_000_000_000, closeDate: daysAgo(8), sqft: 1500 });
    expect((await h.su.query('SELECT close_price_cents FROM listings WHERE id = $1', [bad])).rows[0].close_price_cents).toBe('200000000000');
    const { c } = await seller(wb);
    const r = await oneTap(wb.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.area.recordsLeftOut).toBe(1);
    expect(r.body.cma.area.sentences).toContain('1 MLS record was left out because its stored values are outside what the valuation reads (for example a price above $1 billion).');
    expect(JSON.stringify(r.body)).not.toContain(bad);
    expect(r.body.cma.comps.length).toBeGreaterThanOrEqual(3);
  });
});

describe('strict inputs (R-CMA-2, fair housing)', () => {
  it('extra keys in entered facts are refused (no school, demographic, crime or listing-text field reaches the engine)', async () => {
    for (const extra of [{ schoolRating: 9 }, { neighborhoodDemographics: 'x' }, { crimeIndex: 3 }, { description: 'great family street' }, { photos: ['https://x.invalid/1.jpg'] }]) {
      const r = await call(w.agents[0]!, 'POST', '/cma', { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'condo', sqft: 900, ...extra } }, purpose: 'listing_price' });
      expect([Object.keys(extra)[0], r.status, r.code]).toEqual([Object.keys(extra)[0], 422, 'VALIDATION_FAILED']);
    }
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    const p = await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { subjectFacts: { ownerAge: 70 } });
    expect([p.status, p.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c}/cma`, { facts: { buyerRace: 'x' } })).status).toBe(422);
  });

  it('include, exclude and nearMatchDismissed hold at most 100 ids each', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    const ids = Array.from({ length: 101 }, () => randomUUID());
    for (const k of ['include', 'exclude', 'nearMatchDismissed']) {
      const r = await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { [k]: ids });
      expect([k, r.status, r.code]).toEqual([k, 422, 'VALIDATION_FAILED']);
    }
    expect((await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { include: ids.slice(0, 100) })).status).toBe(200);
  });
});

describe('near matches and drafts', () => {
  it('F2: nearMatchDismissed naming a listing that is not a near match is ignored (stored as nothing, not audited)', async () => {
    const { c } = await seller();
    const unrelated = await mlsSale(w, { line1: '1 Other Rd', status: 'active', closePriceCents: null, closeDate: null });
    const a = await oneTap(w.agents[0]!, c);
    const p = await call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { nearMatchDismissed: [unrelated, randomUUID()] });
    expect(p.status).toBe(200);
    expect(p.body.cma.subject.nearMatchDismissed).toEqual([]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'cma.near_match_dismissed' AND entity_id = $1", [a.body.cma.id])).rows[0].n).toBe(0);
  });

  it('E377 R-CMA-8: PATCH of a superseded CMA is CMA_NOT_DRAFT; the database guard also refuses a direct edit', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    await mlsSale(w, { closeDate: daysAgo(1), sqft: 1450 });
    expect((await oneTap(w.agents[0]!, c)).body.cma.id).not.toBe(a.body.cma.id);
    for (const body of [{ notes: 'x' }, { exclude: [] }, { nearMatchDismissed: [] }, { purpose: 'other' }]) {
      const p = await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, body);
      expect([p.status, p.code]).toEqual([409, 'CMA_NOT_DRAFT']);
    }
  });

  it('R-TEN-3 R-AST-13: no response carries a tenant id or a confidence, score or probability field', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    const text = JSON.stringify(a.body);
    expect(text).not.toContain(w.tenantId);
    expect(text).not.toMatch(/"[^"]*(confidence|score|probab)[^"]*":/i);
    const list = await call(w.agents[0]!, 'GET', `/contacts/${c}/cmas`);
    expect(JSON.stringify(list.body)).not.toContain(w.tenantId);
  });
});
