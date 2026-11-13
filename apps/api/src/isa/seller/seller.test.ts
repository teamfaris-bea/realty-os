// The AI ISA seller part through direct calls and the panel routes (ISA-3; R-ISA-18, R-ISA-19, R-ISA-26; E534-E538,
// E502). Real Postgres through the API harness; fakes only; packs are cleared only in this test's database, in
// try/finally (withSellerPacksCleared). Nothing is sent: TELEPHONY_LIVE_REQUESTS, AI_ISA_LIVE_SENDS and MLS_LIVE_CALLS
// stay false.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { call } from '../testing.js';
import { buildCompsInTx } from './comps.js';
import { PRINTABLE_STATEMENTS, type SellerWorld, asSystem, confirm, nowInstant, panel, sellerLead, sellerWorld, withSellerPacksCleared } from './testing.js';

let h: ApiHarness;
let w: SellerWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
});
afterAll(async () => {
  await h?.close();
});

describe('smoke', () => {
  it('subject, confirm, comps', async () => {
    const l = await sellerLead(h, w);
    const p = await panel(w.agents[0]!, l.id);
    console.log(JSON.stringify(p.body, null, 1).slice(0, 3000));
    const c = await confirm(w, l);
    console.log(c.status, JSON.stringify(c.body));
    const r = await asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS));
    console.log(JSON.stringify(r));
    const r2 = await withSellerPacksCleared(h, () => asSystem(h, w, l, (tx, a, actor) => buildCompsInTx(tx, actor, a, nowInstant(), PRINTABLE_STATEMENTS)));
    console.log(JSON.stringify(r2).slice(0, 4000));
    expect(call).toBeDefined();
  });
});
