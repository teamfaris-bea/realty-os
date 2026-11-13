// Authorization of api/cma, role × route, checked against core can() (R-PERM-5, R-CMA-6; DATA_MODEL §8 "Prepare, edit or
// view a CMA (cma.prepare)": ✅ | ✅ | T | O | — | — | —). A denial is 404, never 403. Also cross-tenant isolation of every
// route (R-TEN-1, R-TEN-3), research CMAs (creator only), and the route table.
import { randomUUID } from 'node:crypto';
import { type ResourceFacts, type Role, can } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;
let other: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  [w, other] = await Promise.all([cmaWorld(h), cmaWorld(h)]);
  await Promise.all([localSales(w, 8), localSales(other, 8)]);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function sellerOf(ww: CmaWorld, agent: TestClient): Promise<{ c: string; addr: string }> {
  const c = await contact(agent);
  const line1 = `${1000 + Math.floor(Math.random() * 8000)} Sample Avenue`;
  const addr = await address(h, ww.tenantId, c, { line1 });
  await mlsSale(ww, { line1, closeDate: daysAgo(2000) });
  return { c, addr };
}

const entered = { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'single_family', sqft: 1400 } };

describe('R-PERM-5 R-CMA-6 role × route against can()', () => {
  it('cma.prepare: Owner/Admin any contact, Team Lead the team\'s, an agent own and collaborated, ISA and TC never (404)', async () => {
    const { c } = await sellerOf(w, w.agents[0]!);
    const seed = await oneTap(w.agents[0]!, c);
    expect(seed.status).toBe(201);
    const roles: { name: string; role: Role; client: TestClient; facts: ResourceFacts }[] = [
      { name: 'owner', role: 'owner', client: w.owner, facts: {} },
      { name: 'admin', role: 'admin', client: w.admin, facts: {} },
      { name: 'team lead (team member\'s contact)', role: 'team_lead', client: w.teamLead, facts: { team: true } },
      { name: 'agent (own)', role: 'agent', client: w.agents[0]!, facts: { own: true } },
      { name: 'agent (not theirs)', role: 'agent', client: w.agents[1]!, facts: {} },
      { name: 'isa', role: 'isa', client: w.isa, facts: {} },
      { name: 'tc', role: 'tc', client: w.tc, facts: {} },
    ];
    for (const r of roles) {
      const allowed = can(r.client.actor(), 'cma.prepare', { tenantId: r.client.actor().tenantId, ...r.facts }).ok;
      const routes: { method: 'GET' | 'POST' | 'PATCH'; url: string; body?: unknown }[] = [
        { method: 'POST', url: `/contacts/${c}/cma` },
        { method: 'GET', url: `/contacts/${c}/cmas` },
        { method: 'GET', url: `/cma/${seed.body.cma.id}` },
        { method: 'POST', url: '/cma', body: { subject: entered, contactId: c, purpose: 'listing_price' } },
      ];
      for (const x of routes) {
        const res = await call(r.client, x.method, x.url, x.body);
        expect([r.name, x.method, x.url.replace(/[0-9a-f-]{36}/g, ':id'), allowed ? 'allowed' : 404]).toEqual([r.name, x.method, x.url.replace(/[0-9a-f-]{36}/g, ':id'), allowed ? (res.status === 404 ? 'denied' : 'allowed') : res.status]);
      }
    }
  });

  it('R-PERM-5: an agent collaborating on a contact may prepare a CMA for it', async () => {
    const { c } = await sellerOf(w, w.agents[0]!);
    expect((await oneTap(w.agents[1]!, c)).status).toBe(404);
    expect((await call(w.agents[0]!, 'POST', `/contacts/${c}/collaborators`, { userId: w.agents[1]!.userId, role: 'co_agent' })).status).toBeLessThan(300);
    expect(can(w.agents[1]!.actor(), 'cma.prepare', { tenantId: w.agents[1]!.actor().tenantId, collaborator: true }).ok).toBe(true);
    expect((await oneTap(w.agents[1]!, c)).status).toBe(201);
  });

  it('R-CMA-6: agent B cannot read or edit agent A\'s research CMA (no contact); the Owner can read it', async () => {
    const a = await call<CmaBody>(w.agents[0]!, 'POST', '/cma', { subject: entered, purpose: 'other' });
    expect(a.status).toBe(201);
    expect(a.body.cma.contactId).toBeNull();
    expect((await call(w.agents[1]!, 'GET', `/cma/${a.body.cma.id}`)).status).toBe(404);
    expect((await call(w.agents[1]!, 'PATCH', `/cma/${a.body.cma.id}`, { notes: 'x' })).status).toBe(404);
    expect((await call(w.teamLead, 'GET', `/cma/${a.body.cma.id}`)).status).toBe(404);
    expect((await call(w.owner, 'GET', `/cma/${a.body.cma.id}`)).status).toBe(200);
    expect((await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { notes: 'mine' })).status).toBe(200);
  });

  it('R-PERM-5: a pond lead the agent can see but whose detail they cannot is 404 (no CMA from a pond card)', async () => {
    const { intake, contactState } = await import('../leads/testing.js');
    const c = (await intake(h, w.leads)).contactId; // no routing rule: the lead waits in the default pond
    expect((await contactState(h, c)).ownership_state).toBe('in_pond');
    expect((await call(w.agents[1]!, 'GET', `/contacts/${c}`)).status).toBe(200);
    expect((await oneTap(w.agents[1]!, c)).status).toBe(404);
  });
});

describe('R-TEN-1 R-TEN-3: another tenant', () => {
  it('every route is 404 for another tenant\'s contact, address, listing or CMA, and the other tenant\'s rows are unchanged', async () => {
    const { c, addr } = await sellerOf(other, other.agents[0]!);
    const theirs = await oneTap(other.agents[0]!, c);
    expect(theirs.status).toBe(201);
    const theirListing = await mlsSale(other, { status: 'active', closePriceCents: null, closeDate: null });
    const mine = await sellerOf(w, w.owner);
    const before = (await h.su.query('SELECT content_sha256, updated_at FROM cma_reports WHERE id = $1', [theirs.body.cma.id])).rows[0];
    const attempts: [string, string, unknown?][] = [
      ['POST', `/contacts/${c}/cma`],
      ['GET', `/contacts/${c}/cmas`],
      ['GET', `/cma/${theirs.body.cma.id}`],
      ['PATCH', `/cma/${theirs.body.cma.id}`, { notes: 'x' }],
      ['POST', '/cma', { subject: entered, contactId: c, purpose: 'listing_price' }],
      ['POST', '/cma', { subject: { kind: 'listing', listingId: theirListing }, purpose: 'listing_price' }],
      ['POST', '/cma', { subject: { kind: 'contact_address', contactAddressId: addr }, contactId: mine.c, purpose: 'listing_price' }],
      ['POST', `/contacts/${mine.c}/cma`, { contactAddressId: addr }],
    ];
    for (const [m, u, b] of attempts) {
      const r = await call(w.owner, m as 'GET', u, b);
      expect([m, u.replace(/[0-9a-f-]{36}/g, ':id'), r.status]).toEqual([m, u.replace(/[0-9a-f-]{36}/g, ':id'), 404]);
    }
    expect((await h.su.query('SELECT content_sha256, updated_at FROM cma_reports WHERE id = $1', [theirs.body.cma.id])).rows[0]).toEqual(before);
  });

  it('R-TEN-3: no body accepts a tenant id (strict schemas refuse it)', async () => {
    const r = await call(w.owner, 'POST', '/cma', { subject: entered, purpose: 'listing_price', tenantId: randomUUID() });
    expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
  });
});

describe('route table', () => {
  it('every CMA route declares cma.prepare, and the V2-A share routes cma.share', () => {
    const rows = h.app.platform.routeTable.filter((r) => /^\/api\/(cma|contacts\/:id\/cmas?)(\/|$)/.test(r.url) && r.method !== 'HEAD');
    expect(rows.map((r) => `${r.method} ${r.url} → ${r.auth}`).sort()).toEqual(
      [
        'GET /api/cma/:id → cma.prepare',
        'GET /api/contacts/:id/cmas → cma.prepare',
        'PATCH /api/cma/:id → cma.prepare',
        'POST /api/cma → cma.prepare',
        'POST /api/contacts/:id/cma → cma.prepare',
        'GET /api/cma/:id/share-preview → cma.share',
        'POST /api/cma/:id/share → cma.share',
        'GET /api/cma/:id/report.pdf → cma.share',
      ].sort(),
    );
  });
});
