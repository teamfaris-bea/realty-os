// R-CMA-6 hardening (batch 10 review api-ui/F5): the routes that run V1-B's engine (POST /cma, POST
// /contacts/:id/cma, PATCH /cma/:id) carry a per-person and a per-team limit (auth/rateLimit.ts, the DB-backed limiter
// the Spark and MMS routes use); reading a stored CMA is not limited. Fakes only; nothing is sent.
import { fixedClock } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { enforceLimits } from '../auth/rateLimit.js';
import { type CmaBody, type CmaWorld, address, call, cmaWorld, contact, daysAgo, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  await localSales(w, 4);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const ENTERED = { purpose: 'listing_price', subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110', city: 'Oakland' }, facts: { propertyType: 'single_family', sqft: 1400 } } };

describe('R-CMA-6: per-route limits on the routes that run the engine (api-ui/F5)', () => {
  it('R-CMA-6: one person gets at most the per-person limit of engine runs a minute (429 RATE_LIMITED with retryAfterSeconds); a read is never limited, and another person is not affected', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'property', line1: '1701 Sample Avenue' });
    await mlsSale(w, { line1: '1701 Sample Avenue', closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
    // the burst is held inside one fixed window (the limiter's test seam, as the public listing page's)
    h.app.platform.cmaLimitClock = fixedClock(Date.now());
    try {
      const first = await oneTap(w.agents[0]!, c);
      expect(first.status).toBe(201);
      const id = first.body.cma.id;
      const statuses: number[] = [];
      for (let i = 0; i < 60; i++) statuses.push((await call(w.agents[0]!, 'PATCH', `/cma/${id}`, { notes: `pass ${i}` })).status);
      expect(statuses.filter((s) => s === 200).length).toBe(59); // the tap was the first of 60
      expect(statuses.slice(-1)).toEqual([429]);
      for (const r of [await call(w.agents[0]!, 'PATCH', `/cma/${id}`, { notes: 'again' }), await oneTap(w.agents[0]!, c), await call(w.agents[0]!, 'POST', '/cma', ENTERED)]) {
        expect([r.status, r.code]).toEqual([429, 'RATE_LIMITED']);
        expect((r.body as unknown as { error: { details: { retryAfterSeconds: number } } }).error.details.retryAfterSeconds).toBeGreaterThan(0);
      }
      expect((await call<CmaBody>(w.agents[0]!, 'GET', `/cma/${id}`)).status).toBe(200);
      expect((await call(w.agents[0]!, 'GET', `/contacts/${c}/cmas`)).status).toBe(200);
      expect((await call(w.agents[1]!, 'POST', '/cma', ENTERED)).status).toBe(201);
    } finally {
      delete h.app.platform.cmaLimitClock;
    }
  });

  it('R-CMA-6: the whole team shares a per-team limit', async () => {
    const wt = await cmaWorld(h); // a team of its own, so its window holds only what this test counts
    h.app.platform.cmaLimitClock = fixedClock(Date.now());
    try {
      const { CMA_RUN_LIMITS } = await import('./routes.js');
      const team = CMA_RUN_LIMITS(wt.tenantId, wt.teamLead.userId!).find((l) => l.kind === 'cma_run_tenant')!;
      // the team's other engine runs this minute, counted by the very limiter the routes call
      for (let i = 0; i < team.max; i++) await enforceLimits(h.app.platform.db, h.app.platform.config.sessionSecret, [team], h.app.platform.cmaLimitClock);
      const r = await call(wt.teamLead, 'POST', '/cma', ENTERED);
      expect([r.status, r.code]).toEqual([429, 'RATE_LIMITED']);
    } finally {
      delete h.app.platform.cmaLimitClock;
    }
  });
});
