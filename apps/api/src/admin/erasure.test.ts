// Privacy erasure through the real server and real Postgres as app_user (R-DATA-4, E59, R-PERM-13).
import type { ContactId } from '@realty/core/foundation';
import { applyOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from './testing.js';

let h: ApiHarness;
let owner: TestClient;
let admin: TestClient;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  admin = await inviteViaApi(h, owner, 'admin');
  agent = await inviteViaApi(h, owner, 'agent');
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function lead(name: string): Promise<ContactId> {
  const id = randomUUID() as ContactId;
  const r = await applyOwnershipCommand(agent.actor(), id, { kind: 'create', via: 'self' }, { commandId: randomUUID(), newContact: { displayName: name }, db: h.database });
  if (!r.outcome.ok) throw new Error('self create rejected');
  return id;
}

/** A deal for `contact` (primary + party) reaching `stage`, written by the Owner under RLS. */
async function deal(contact: ContactId, stage: string): Promise<string> {
  const id = randomUUID();
  await withTenantTx(owner.actor(), async (tx) => {
    await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
              VALUES (app.tenant_id(), ${id}, 'Maple St purchase', 'buy', 'active', now(), ${contact}, ${agent.userId})`.execute(tx);
    await sql`INSERT INTO deal_contacts (tenant_id, deal_id, contact_id, role) VALUES (app.tenant_id(), ${id}, ${contact}, 'buyer')`.execute(tx);
    await sql`UPDATE deals SET stage = ${stage}, closed_at = CASE WHEN ${stage} = 'closed' THEN now() END WHERE id = ${id}`.execute(tx);
  }, { db: h.database });
  return id;
}

const exists = async (contact: string) => (await h.su.query('SELECT 1 FROM contacts WHERE id = $1', [contact])).rowCount === 1;

describe('E59 R-DATA-4 erasure of a contact on a closed deal', () => {
  it('E59 R-DATA-4: erasure of a contact on a closed deal is refused with CONTACT_ON_DEAL naming the deal; nothing is deleted', async () => {
    const c = await lead('Closed Deal Buyer');
    const d = await deal(c, 'closed');
    await freshReauth(h, owner);
    const pre = await call<{ erasable: boolean; deals: { id: string; link: string; closed: boolean; name: string }[] }>(owner, 'GET', `/contacts/${c}/erasure`);
    expect(pre.status).toBe(200);
    expect(pre.body).toMatchObject({ erasable: false, deals: [{ id: d, link: 'primary_and_party', closed: true, name: 'Maple St purchase' }] });
    const r = await call<{ error: { details: { deals: { id: string; stage: string }[] } } }>(owner, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([r.status, r.code]).toEqual([409, 'CONTACT_ON_DEAL']);
    expect(r.body.error.details).toEqual({ deals: [{ id: d, stage: 'closed' }] }); // ids and codes only, no names
    expect(await exists(c)).toBe(true);
  });

  it('E59 R-DATA-4: the Owner removes the deal link, then erasure succeeds; the deal record stays; both steps are audited', async () => {
    const c = await lead('Erase Me');
    const d = await deal(c, 'closed');
    await freshReauth(h, owner);
    const rm = await call(owner, 'POST', `/deals/${d}/contacts/${c}/remove`, { reason: 'PRIVACY_REQUEST' });
    expect(rm.status).toBe(200);
    expect((await call<{ erasable: boolean }>(owner, 'GET', `/contacts/${c}/erasure`)).body.erasable).toBe(true);
    const er = await call(owner, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([er.status, er.body]).toEqual([200, { erased: true }]);
    expect(await exists(c)).toBe(false);
    expect((await h.su.query('SELECT stage, primary_contact_id FROM deals WHERE id = $1', [d])).rows).toEqual([{ stage: 'closed', primary_contact_id: null }]);
    const tenant = owner.actor().tenantId;
    expect((await auditRows(h, tenant, 'deal.contact_removed')).map((a) => a.entity_id)).toContain(d);
    expect((await auditRows(h, tenant, 'contact.erase')).map((a) => a.entity_id)).toContain(c);
  });

  it('E59: only the Owner removes a deal link; an Admin gets OWNER_REQUIRED and an Agent NOT_FOUND', async () => {
    const c = await lead('Linked');
    const d = await deal(c, 'closed');
    await freshReauth(h, admin);
    expect((await call(admin, 'POST', `/deals/${d}/contacts/${c}/remove`, { reason: 'PRIVACY_REQUEST' })).code).toBe('OWNER_REQUIRED');
    expect((await call(agent, 'POST', `/deals/${d}/contacts/${c}/remove`, { reason: 'PRIVACY_REQUEST' })).code).toBe('NOT_FOUND');
    expect((await call(agent, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' })).code).toBe('NOT_FOUND');
    expect((await h.su.query('SELECT primary_contact_id FROM deals WHERE id = $1', [d])).rows).toEqual([{ primary_contact_id: c }]);
  });

  it('E59: the primary contact of an open deal is not removed (DEAL_STILL_OPEN); R-PERM-13 erasure needs a fresh re-auth', async () => {
    const c = await lead('Open Deal');
    const d = await deal(c, 'under_contract');
    await freshReauth(h, owner);
    expect((await call(owner, 'POST', `/deals/${d}/contacts/${c}/remove`, { reason: 'PRIVACY_REQUEST' })).code).toBe('DEAL_STILL_OPEN');
    await staleReauth(h, owner);
    expect((await call(owner, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' })).code).toBe('REAUTH_REQUIRED');
    expect(await exists(c)).toBe(true);
  });

  it('erasure without any deal succeeds for an Admin; an unknown contact is 404', async () => {
    const c = await lead('No Deals');
    await freshReauth(h, admin);
    expect((await call(admin, 'POST', `/contacts/${c}/erase`, { reason: 'ENTERED_IN_ERROR' })).status).toBe(200);
    expect(await exists(c)).toBe(false);
    expect((await call(admin, 'POST', `/contacts/${randomUUID()}/erase`, { reason: 'ENTERED_IN_ERROR' })).code).toBe('NOT_FOUND');
  });
});
