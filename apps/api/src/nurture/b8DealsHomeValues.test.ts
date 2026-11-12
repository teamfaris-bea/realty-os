// b8 deals review fixes for home values over real Postgres: K2 (sends/F2, db-public/F4, ownership-data/F2-K2,
// ui/F2-K2; R-AVM-3) and the merge dedupe (ownership-data/F4). The deterministic fake AVM and fake email only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call } from '../assistant/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { command, freshReauth } from '../leads/testing.js';
import { type NurtureWorld, type PastClient, approveTemplate, avmCallsFor, avmPass, beforeThisMonth, closedDeal, firingsDue, nurtureWorld, pastClient, reconcileAndRun, triggerRuns, withAvmCleared } from './testing.js';

let h: ApiHarness;
let w: NurtureWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await nurtureWorld(h);
  await approveTemplate(w.agents[0]!, 'after_closing_alerts');
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const avmFirings = async (c: { id: string }) => (await triggerRuns(h, c.id)).filter((r) => r.trigger_key.startsWith('avm:'));
const nothingFor = async (c: PastClient) => {
  expect(avmCallsFor(h, c.line1), c.line1).toBe(0);
  expect(await avmFirings(c)).toEqual([]);
};

describe('b8 deals sends/F2 db-public/F4 ownership-data/F2-K2 ui/F2-K2 R-AVM-3: home values only for a home the team\'s buy-side client bought', () => {
  it('K2 negative: a past seller whose home is the house they sold, a lease client, a primary contact with no client role, and the other side\'s seller on a buy deal get nothing', async () => {
    const a0 = w.agents[0]!;
    const seller = await pastClient(h, w, a0, { side: 'sell', listingAtHome: true });
    const lease = await pastClient(h, w, a0, { side: 'lease' });
    const leaseBuyerRole = await pastClient(h, w, a0, { side: 'lease', role: 'buyer' });
    const primaryOnly = await pastClient(h, w, a0, { role: null });
    const otherSideSeller = await pastClient(h, w, a0, { side: 'buy', role: 'seller' });
    await avmPass(h, w.tenantId);
    for (const c of [seller, lease, leaseBuyerRole, primaryOnly, otherSideSeller]) await nothingFor(c);
  });

  it('K2 negative: a buyer whose recorded home is a house they later sold through the team gets nothing for it', async () => {
    const a0 = w.agents[0]!;
    const c = await pastClient(h, w, a0, { side: 'buy' }); // bought, no listing known: their 'home' would qualify...
    await closedDeal(h, w.tenantId, c.id, a0.userId!, beforeThisMonth(2), { side: 'sell', listing: { line1: c.line1.toUpperCase(), postalCode: `${c.postalCode}-1234` } }); // ...but they sold it through the team
    await avmPass(h, w.tenantId);
    await nothingFor(c);
  });

  it('K2 positive: a dual deal\'s buyer is valued; the purchased property (the listing address) wins over another home address', async () => {
    const a0 = w.agents[0]!;
    const dual = await pastClient(h, w, a0, { side: 'dual' });
    // a buyer whose purchased house is recorded as a 'property' address matching the deal's listing; their 'home' is the old place
    const bought = await pastClient(h, w, a0, { side: 'buy', kind: 'property', listingAtHome: true });
    const old = await call<{ address: { id: string } }>(a0, 'POST', `/contacts/${bought.id}/addresses`, { kind: 'home', line1: '9 Old Rd', city: 'Springfield', region: 'SC', postalCode: '29401' });
    expect(old.status).toBe(201);
    await avmPass(h, w.tenantId);
    expect(avmCallsFor(h, dual.line1)).toBe(1);
    expect(avmCallsFor(h, bought.line1)).toBe(1);
    expect(avmCallsFor(h, '9 Old Rd')).toBe(0);
    expect((await avmFirings(bought)).map((r) => r.trigger_key)).toEqual([expect.stringContaining(`avm:${bought.addressId}:`)]);
  });

  it('K2 send time: a planned note for a house the client then sells through the team is skipped (ADDRESS_NOT_CURRENT)', async () => {
    const a0 = w.agents[0]!;
    const c = await pastClient(h, w, a0, { side: 'buy' });
    await withAvmCleared(h, async () => {
      await avmPass(h, w.tenantId);
      expect(await avmFirings(c)).toHaveLength(1);
      await closedDeal(h, w.tenantId, c.id, a0.userId!, new Date(), { side: 'sell', listing: { line1: c.line1, postalCode: c.postalCode } });
      await firingsDue(h, c.id);
      await reconcileAndRun(h, w.tenantId);
    });
    const [run] = await avmFirings(c);
    expect(run!.status).toBe('skipped_ineligible');
    expect((run!.trigger_ref['skip'] as { reason: string }).reason).toBe('ADDRESS_NOT_CURRENT');
  });
});

describe('b8 deals ownership-data/F4 R-AVM-3: one home value per person, house and month across a merge', () => {
  it('ownership-data/F4: duplicates sharing a home address are merged after the month\'s note: no second request, no second firing', async () => {
    const a0 = w.agents[0]!;
    const loser = await pastClient(h, w, a0, { side: 'buy' });
    const survivor = await pastClient(h, w, a0, { side: 'buy', role: null }); // the duplicate record: primary contact only, not a candidate on its own
    await h.su.query('UPDATE contact_addresses SET line1 = $1, postal_code = $2 WHERE id = $3', [`  ${loser.line1.toLowerCase()} `, loser.postalCode, survivor.addressId]);
    await avmPass(h, w.tenantId);
    expect(avmCallsFor(h, loser.line1)).toBe(1);
    await freshReauth(h, w.owner);
    const m = await command(w.owner, survivor.id, 'merge', { loserId: loser.id });
    expect(m.status).toBe(200);
    // the deal role moved to the survivor (0053), so the survivor's copy of the address now qualifies, but the house was done this month
    await avmPass(h, w.tenantId);
    const norm = (x: string) => x.trim().toLowerCase();
    expect(h.providers.integrations.avm.calls.filter((x) => norm(x.line1) === norm(loser.line1))).toHaveLength(1);
    expect(await avmFirings(survivor)).toEqual([]);
  });
});

describe('b8 deals db-public/F3 R-AVM-1 R-AVM-3: home_valuations writes are system-only', () => {
  it('db-public/F3: an agent who sees the contact cannot insert or update a valuation; the system can; people still read it; deleting the address still works', async () => {
    const a0 = w.agents[0]!;
    const c = await pastClient(h, w, a0, { side: 'buy' });
    const ins = (id: string) => sql`
      INSERT INTO home_valuations (tenant_id, id, contact_id, contact_address_id, provider, value_cents, low_cents, high_cents, valued_at, status, as_of, display_allowed)
      VALUES (app.tenant_id(), ${id}, ${c.id}, ${c.addressId}, 'Test source', 100, 90, 110, now() - interval '40 days', 'ok', (now() - interval '40 days')::date, true)`;
    await expect(withTenantTx(a0.actor(), (tx) => ins(randomUUID()).execute(tx), { db: h.database })).rejects.toThrow(/row-level security/);
    const id = randomUUID();
    await withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => ins(id).execute(tx), { db: h.database });
    const upd = await withTenantTx(a0.actor(), async (tx) => Number((await sql`UPDATE home_valuations SET value_cents = 1, display_allowed = true WHERE id = ${id}`.execute(tx)).numAffectedRows ?? 0n), { db: h.database });
    expect(upd).toBe(0);
    const seen = await withTenantTx(a0.actor(), async (tx) => (await sql<{ v: string }>`SELECT value_cents::text AS v FROM home_valuations WHERE id = ${id}`.execute(tx)).rows, { db: h.database });
    expect(seen).toEqual([{ v: '100' }]);
    expect((await call(a0, 'DELETE', `/contacts/${c.id}/addresses/${c.addressId}`)).status).toBe(200);
    expect((await h.su.query('SELECT contact_address_id FROM home_valuations WHERE id = $1', [id])).rows).toEqual([{ contact_address_id: null }]);
  });
});
