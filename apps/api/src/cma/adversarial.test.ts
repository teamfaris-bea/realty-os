// Adversarial tests of module 71 api/cma (critical: MLS licence and client disclosure gates). Each tries to break
// tenancy, the comp rules (R-CMA-2), the strict input schemas (fair housing), the draft rules (R-CMA-8) or the near-match
// gate (F2), and expects the refusal or a harmless no-op. Nothing is sent in V1 (no comms path exists here).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap, saleReso, syncSales } from './testing.js';

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

  it('E361 R-CMA-2: the subject\'s own newest MLS record with values beyond the engine\'s bounds (a 1.9 billion sq ft lot, 1,500 garage spaces, a 250-character subdivision, 1,200 bedrooms) gives a CMA on both prepare paths, those facts left out and said', async () => {
    const wb = await cmaWorld(h);
    await localSales(wb, 5);
    const c = await contact(wb.agents[0]!);
    const line1 = '3100 Sample Avenue';
    const addr = await address(h, wb.tenantId, c, { line1 });
    // stored through V1-A's sync, which keeps these values (SMALLINT, bigint and unbounded text columns)
    const [rec] = await syncSales(wb, [{ ...saleReso({ line1, closeDate: daysAgo(2500), sqft: 1500 }), LotSizeAcres: '43560', GarageSpaces: '1500', SubdivisionName: 'Sample '.repeat(36), BedroomsTotal: 1200 }]);
    const stored = (await h.su.query('SELECT lot_sqft, garage_spaces_x10, length(subdivision_name) AS sub, beds FROM listings WHERE id = $1', [rec])).rows[0];
    expect(stored).toEqual({ lot_sqft: '1897473600', garage_spaces_x10: 15000, sub: 251, beds: 1200 });
    const tap = await oneTap(wb.agents[0]!, c);
    const post = await call<CmaBody>(wb.agents[0]!, 'POST', '/cma', { subject: { kind: 'contact_address', contactAddressId: addr }, contactId: c, purpose: 'other' });
    for (const r of [tap, post]) {
      expect(r.status).toBe(201);
      const s = r.body.cma.subject;
      for (const k of ['lotSqft', 'garageSpacesX10', 'subdivision', 'beds']) expect([k, s.facts[k]]).toEqual([k, { value: null, source: null }]);
      expect(s.facts['sqft']).toEqual({ value: 1500, source: 'mls' });
      expect(s.factSentences).toEqual([
        'The MLS record’s bedroom count of this home is outside what the valuation reads, so it is not used. Enter it to use it.',
        'The MLS record’s lot size of this home is outside what the valuation reads, so it is not used. Enter it to use it.',
        'The MLS record’s garage spaces of this home is outside what the valuation reads, so it is not used. Enter it to use it.',
        'The MLS record’s subdivision name of this home is outside what the valuation reads, so it is not used. Enter it to use it.',
      ]);
    }
    // the agent can enter a bounded value instead
    const fixed = await oneTap(wb.agents[0]!, c, { facts: { beds: 3, lotSqft: 6000 } });
    expect(fixed.body.cma.subject.facts['beds']).toEqual({ value: 3, source: 'agent' });
  });

  it('E361 R-CMA-2: a subject size beyond the engine\'s bounds asks for the size (CMA_SUBJECT_INCOMPLETE), and an address part longer than the engine reads is refused by name: never a 500', async () => {
    const wb = await cmaWorld(h);
    await localSales(wb, 3);
    const c = await contact(wb.agents[0]!);
    const line1 = '3200 Sample Avenue';
    await address(h, wb.tenantId, c, { line1 });
    await mlsSale(wb, { line1, closeDate: daysAgo(2500), sqft: 2_000_000_000 });
    const big = await oneTap(wb.agents[0]!, c);
    const e1 = big.body as unknown as { error: { details: { missing: string[]; sentence: string } } };
    expect([big.status, big.code, e1.error.details.missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['sqft']]);
    expect(e1.error.details.sentence).toBe('The MLS record’s size of this home is outside what the valuation reads. Enter the size to prepare a CMA.');
    expect((await oneTap(wb.agents[0]!, c, { facts: { sqft: 1500 } })).status).toBe(201);
    // a contact address an import stored with a 220-character city (the people API stops at 120)
    const c2 = await contact(wb.agents[0]!);
    await address(h, wb.tenantId, c2, { line1: '3300 Sample Avenue', city: 'Sampletown '.repeat(20).trim() });
    const long = await oneTap(wb.agents[0]!, c2, { facts: { propertyType: 'single_family', sqft: 1500 } });
    const e2 = long.body as unknown as { error: { details: { missing: string[] } } };
    expect([long.status, long.code]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE']);
    expect(e2.error.details.missing).toContain('city');
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

  // E377 (a PATCH after share) is V2's sharing lane: no V1 path makes a shared CMA, so this tests the superseded case
  it('R-CMA-8: PATCH of a superseded CMA is CMA_NOT_DRAFT; the database guard also refuses a direct edit', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    await mlsSale(w, { closeDate: daysAgo(1), sqft: 1450 });
    expect((await oneTap(w.agents[0]!, c)).body.cma.id).not.toBe(a.body.cma.id);
    for (const body of [{ notes: 'x' }, { exclude: [] }, { nearMatchDismissed: [] }, { purpose: 'other' }]) {
      const p = await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, body);
      expect([p.status, p.code]).toEqual([409, 'CMA_NOT_DRAFT']);
    }
    // a direct edit below the API, as the table owner (RLS does not stop it, the guard trigger does)
    const before = (await h.su.query('SELECT status, agent_notes, content_sha256, updated_at FROM cma_reports WHERE id = $1', [a.body.cma.id])).rows[0];
    expect(before.status).toBe('superseded');
    await expect(h.su.query("UPDATE cma_reports SET agent_notes = 'direct edit' WHERE id = $1", [a.body.cma.id])).rejects.toThrow(/CMA_NOT_DRAFT/);
    expect((await h.su.query('SELECT status, agent_notes, content_sha256, updated_at FROM cma_reports WHERE id = $1', [a.body.cma.id])).rows[0]).toEqual(before);
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
