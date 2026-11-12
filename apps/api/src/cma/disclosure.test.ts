// V2-A deliverable 2 against real Postgres: the inspection date and agent-text checks (E607, VERIFY 1), the view's
// disclosure list (E606), its new fields, and readinessOf (the view's readiness is unchanged by the refactor).
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { getCma } from './repos.js';
import { readinessOf } from './service.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  await localSales(w, 8);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

type View = CmaBody['cma'] & { contentSha256: string; disclosureMissing: string[]; share: unknown; pdfAvailable: boolean; inspectedOn: string | null; inspection: string; disclosure: Record<string, string | null>; purpose: string };
const view = (b: CmaBody) => b.cma as View;

async function draft(): Promise<string> {
  const c = await contact(w.agents[0]!);
  const line1 = `${1000 + Math.floor(Math.random() * 8000)} Sample Avenue`;
  await address(h, w.tenantId, c, { line1 });
  await mlsSale(w, { line1, closeDate: daysAgo(2000) });
  const r = await oneTap(w.agents[0]!, c);
  expect(r.status).toBe(201);
  return r.body.cma.id;
}

const patch = (id: string, body: Record<string, unknown>) => call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${id}`, body);
const issues = (r: { body: unknown }) => (r.body as { error: { details?: { issues?: { path: string; code: string }[] } } }).error.details?.issues ?? [];

describe('E607 R-CMA-8: the inspection date', () => {
  it('E607 VERIFY 1: 2026-02-30 on PATCH or POST /cma is a 422 naming /inspectedOn, never a 500 (it was a 500 at the ::date cast)', async () => {
    const id = await draft();
    const p = await patch(id, { inspection: 'exterior', inspectedOn: '2026-02-30' });
    expect([p.status, p.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(JSON.stringify(p.body)).toContain('inspectedOn');
    const q = await call(w.agents[0]!, 'POST', '/cma', { purpose: 'other', inspection: 'exterior', inspectedOn: '2026-02-30', subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect([q.status, q.code]).toEqual([422, 'VALIDATION_FAILED']);
    expect(JSON.stringify(q.body)).toContain('inspectedOn');
    for (const bad of ['2026-13-01', '2026-00-10', '2025-02-29', 'tomorrow']) expect([bad, (await patch(id, { inspection: 'exterior', inspectedOn: bad })).status]).toEqual([bad, 422]);
    expect((await patch(id, { inspection: 'exterior', inspectedOn: '2024-02-29' })).status).toBe(200); // a real leap day
  });

  it('E607: a date after today or before 1900 is refused (out_of_range); a date with inspection none is refused (no_inspection), never dropped', async () => {
    const id = await draft();
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const f = await patch(id, { inspection: 'exterior', inspectedOn: future });
    expect([f.status, issues(f)]).toEqual([422, [{ path: '/inspectedOn', code: 'out_of_range' }]]);
    expect(issues(await patch(id, { inspection: 'exterior', inspectedOn: '1899-12-31' }))).toEqual([{ path: '/inspectedOn', code: 'out_of_range' }]);
    const n = await patch(id, { inspection: 'none', inspectedOn: daysAgo(3) });
    expect([n.status, issues(n)]).toEqual([422, [{ path: '/inspectedOn', code: 'no_inspection' }]]);
    // the stored inspection is none: a date alone is refused too
    expect(issues(await patch(id, { inspectedOn: daysAgo(3) }))).toEqual([{ path: '/inspectedOn', code: 'no_inspection' }]);
    const q = await call(w.agents[0]!, 'POST', '/cma', { purpose: 'listing_price', inspectedOn: daysAgo(1), subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect([q.status, issues(q)]).toEqual([422, [{ path: '/inspectedOn', code: 'no_inspection' }]]);
  });

  it('E607: switching to none clears the stored date; today is accepted', async () => {
    const id = await draft();
    const today = (await patch(id, { inspection: 'interior_and_exterior', inspectedOn: daysAgo(0) })).body;
    expect(view(today).inspectedOn).not.toBeNull();
    const none = await patch(id, { inspection: 'none' });
    expect([none.status, view(none.body).inspectedOn]).toEqual([200, null]);
    expect((await h.su.query('SELECT inspected_on FROM cma_reports WHERE id = $1', [id])).rows[0].inspected_on).toBeNull();
  });

  it('R-CMA-9: the agent\'s notes and SoP text refuse control characters other than a line break', async () => {
    const id = await draft();
    for (const bad of ['tab\there', 'bell\u0007', 'cr\rhere', 'nul\u0000']) {
      expect([bad, (await patch(id, { notes: `x ${bad} y` })).status]).toEqual([bad, 422]);
      expect([bad, (await patch(id, { disclosure: { intendedUsers: `x ${bad} y` } })).status]).toEqual([bad, 422]);
    }
    expect((await patch(id, { notes: 'line one\nline two' })).status).toBe(200);
  });
});

describe('E606: the view lists the missing disclosure', () => {
  it('E606: (a) purpose other names each missing SoP item; (b) an inspection without a date names inspectedOn; (c) listing_price with no inspection needs nothing', async () => {
    const id = await draft();
    const c0 = await call<CmaBody>(w.agents[0]!, 'GET', `/cma/${id}`);
    expect(view(c0.body)).toMatchObject({ purpose: 'listing_price', inspection: 'none', disclosureMissing: [] }); // (c)
    const a = await patch(id, { purpose: 'other', disclosure: { agentInterest: 'Listing agent', conflicts: '  ' } });
    expect(view(a.body).disclosureMissing).toEqual(['intendedUsers', 'conflicts', 'valueDefinition', 'limitingConditions']); // (a): blank counts as missing
    const b = await patch(id, { purpose: 'buyer_offer', inspection: 'exterior' });
    expect(view(b.body).disclosureMissing).toEqual(['inspectedOn']); // (b)
    // a purpose change kept the stored SoP items
    expect(view(b.body).disclosure).toMatchObject({ agentInterest: 'Listing agent' });
    const full = await patch(id, { purpose: 'other', inspectedOn: daysAgo(2), disclosure: { intendedUsers: 'The sellers', conflicts: 'None', valueDefinition: 'Market value', limitingConditions: 'Exterior only' } });
    expect(view(full.body).disclosureMissing).toEqual([]);
  });

  it('R-CMA-9: a draft view carries contentSha256, no share, and no PDF', async () => {
    const id = await draft();
    const v = view((await call<CmaBody>(w.agents[0]!, 'GET', `/cma/${id}`)).body);
    const stored = (await h.su.query('SELECT content_sha256 FROM cma_reports WHERE id = $1', [id])).rows[0].content_sha256;
    expect(v).toMatchObject({ contentSha256: stored, share: null, pdfAvailable: false });
  });
});

describe('readinessOf', () => {
  it('R-CMA-7: readinessOf of a stored CMA equals the view\'s readiness, with and without connections passed in', async () => {
    const id = await draft();
    const v = view((await call<CmaBody>(w.agents[0]!, 'GET', `/cma/${id}`)).body);
    const a = w.agents[0]!.actor();
    const [one, two] = await withTenantTx(a, async (tx, now) => {
      const row = (await getCma(tx, id))!;
      const r1 = await readinessOf(tx, now, row);
      const r2 = await readinessOf(tx, now, row, r1.input.conns);
      return [r1, r2];
    }, { db: h.app.platform.db });
    expect(one.share).toEqual(v.clientShare);
    expect(two.share).toEqual(one.share);
    expect(one.input.compSales.map((c) => c.saleListingId)).toEqual(v.comps.map((c) => c.saleListingId));
  });
});
