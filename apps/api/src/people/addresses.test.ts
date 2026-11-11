// Address delete (PARITY_PLAN module 57; FUB lets an agent delete a person's address). DELETE
// /contacts/:id/addresses/:addressId is contact.edit (the role matrix is in matrix.test.ts) and audited; the
// database grants app_user DELETE only through the RESTRICTIVE contact_addresses_delete policy (migration 0037):
// the person's detail visible AND an editing role acting as itself. So a TC, the system, support, another tenant
// and a caller who cannot see the person delete nothing, with the API bypassed too. Real Postgres, the real
// server, fake providers.
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows } from '../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, leadsWorld, randomPhone } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;
let agent2: TestClient;
let tc: TestClient;
let tenantId: string;

beforeAll(async () => {
  h = await createApiHarness();
  const w = await leadsWorld(h, { agents: 2, rule: false, others: ['tc'] });
  [owner, agent, agent2, tc] = [w.owner, w.agents[0]!, w.agents[1]!, w.others[0]!];
  tenantId = w.tenantId;
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function personWithAddress(by: TestClient = agent): Promise<{ id: string; addressId: string }> {
  const c = await call<{ contact: { id: string } }>(by, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Ada', lastName: 'Dress', phones: [randomPhone()] });
  expect([200, 201]).toContain(c.status);
  const a = await call<{ address: { id: string } }>(by, 'POST', `/contacts/${c.body.contact.id}/addresses`, { kind: 'home', line1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610' });
  expect(a.status, JSON.stringify(a.body)).toBe(201);
  return { id: c.body.contact.id, addressId: a.body.address.id };
}
const exists = async (addressId: string) => (await h.su.query('SELECT 1 FROM contact_addresses WHERE id = $1', [addressId])).rowCount === 1;
/** A DELETE straight through RLS as `actor` (the API bypassed): the number of rows it removed, or the error. */
const rawDelete = (actor: Actor, addressId: string) =>
  withTenantTx(actor, async (tx) => Number((await sql`DELETE FROM contact_addresses WHERE id = ${addressId}::uuid`.execute(tx)).numAffectedRows ?? 0), { db: h.database });

describe('address delete (module 57)', () => {
  it('R-PAR-43 the owning agent deletes an address of their person: 200, the address is gone from the details and the database, audited as contact.update with ids and the kind only (no address text)', async () => {
    const p = await personWithAddress();
    const before = await call<{ details: { addresses: { id: string }[] } }>(agent, 'GET', `/contacts/${p.id}/details`);
    expect(before.body.details.addresses.map((a) => a.id)).toEqual([p.addressId]);
    const r = await call(agent, 'DELETE', `/contacts/${p.id}/addresses/${p.addressId}`);
    expect([r.status, r.body]).toEqual([200, { ok: true }]);
    expect(await exists(p.addressId)).toBe(false);
    expect((await call<{ details: { addresses: unknown[] } }>(agent, 'GET', `/contacts/${p.id}/details`)).body.details.addresses).toEqual([]);
    const rows = (await auditRows(h, tenantId, 'contact.update')).filter((a) => a.entity_id === p.id);
    const del = rows.find((a) => JSON.stringify(a.changes).includes(p.addressId))!;
    expect(del).toMatchObject({ actor_user_id: agent.userId, entity_type: 'contact' });
    expect(del.changes).toEqual({ address_action: { changed: true }, address_id: { from: p.addressId, to: null }, kind: { from: 'home', to: null } });
    expect(JSON.stringify(del.changes)).not.toMatch(/Oak|Oakland|94610/);
    // a second delete finds nothing: 404, not an error
    expect((await call(agent, 'DELETE', `/contacts/${p.id}/addresses/${p.addressId}`)).status).toBe(404);
  });

  it('R-PERM-5: an address is deleted only through its own person: another person’s address id under my person, and my person’s address under a person I cannot see, are 404; nothing is deleted', async () => {
    const mine = await personWithAddress();
    const theirs = await personWithAddress(agent2);
    expect((await call(agent, 'DELETE', `/contacts/${mine.id}/addresses/${theirs.addressId}`)).status).toBe(404);
    expect((await call(agent, 'DELETE', `/contacts/${theirs.id}/addresses/${theirs.addressId}`)).status).toBe(404);
    expect((await call(agent2, 'DELETE', `/contacts/${theirs.id}/addresses/${mine.addressId}`)).status).toBe(404);
    expect(await exists(mine.addressId)).toBe(true);
    expect(await exists(theirs.addressId)).toBe(true);
    // with the API bypassed, RLS shows the other agent nothing to delete
    expect(await rawDelete(agent2.actor(), mine.addressId)).toBe(0);
    expect(await exists(mine.addressId)).toBe(true);
  });

  it('R-TEN-1 R-TEN-3: another tenant’s person and address ids are 404 for delete, from the API and through RLS; the row stays', async () => {
    const other = await leadsWorld(h, { agents: 1, rule: false });
    const theirs = await personWithAddress(other.agents[0]!);
    for (const c of [owner, agent]) {
      expect((await call(c, 'DELETE', `/contacts/${theirs.id}/addresses/${theirs.addressId}`)).status).toBe(404);
      expect(await rawDelete(c.actor(), theirs.addressId)).toBe(0);
    }
    expect(await exists(theirs.addressId)).toBe(true);
  });

  it('a TC who collaborates on the person (so the database shows them the address) cannot delete it: 404 from the API (contact.edit), and the DB delete policy removes nothing with the API bypassed', async () => {
    const p = await personWithAddress();
    expect((await call(agent, 'POST', `/contacts/${p.id}/collaborators`, { userId: tc.userId })).status).toBe(200);
    // the database shows the collaborating TC the person's detail, the address included (the API's view_detail is deal-only for a TC)
    const seen = await withTenantTx(tc.actor(), async (tx) => (await sql<{ id: string }>`SELECT id FROM contact_addresses WHERE id = ${p.addressId}::uuid`.execute(tx)).rows, { db: h.database });
    expect(seen).toEqual([{ id: p.addressId }]);
    expect((await call(tc, 'DELETE', `/contacts/${p.id}/addresses/${p.addressId}`)).status).toBe(404);
    expect(await rawDelete(tc.actor(), p.addressId)).toBe(0);
    expect(await exists(p.addressId)).toBe(true);
  });

  it('R-PERM-11: support and the system actor delete nothing, even with the API bypassed (support is refused by the database; the system is not an editor)', async () => {
    const p = await personWithAddress();
    const support: Actor = { kind: 'support', userId: owner.userId!, tenantId: tenantId as TenantId, grantId: randomUUID() };
    await expect(rawDelete(support, p.addressId)).rejects.toThrow(/SUPPORT_READ_ONLY/);
    expect(await rawDelete(systemActor(tenantId, 'worker'), p.addressId)).toBe(0);
    expect(await exists(p.addressId)).toBe(true);
    // an Owner can, and so can the person's owner through RLS (the editing roles), while their detail is visible
    expect(await rawDelete(owner.actor(), p.addressId)).toBe(1);
  });
});
