// The lead-handling follow-up migration (0037 when written) at the database: the address delete grant and its RESTRICTIVE policy,
// and erasure / purge of a merge survivor (R-DATA-4, R-DATA-5). Every write goes through app_user (RLS) and the
// ownership engine; the superuser pool only reads, and builds the one corrupt state no application path can
// reach (a merge cycle) to show the merge tree still ends.
import { randomUUID } from 'node:crypto';
import type { Actor, ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, type Harness, type Member, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let agent: Member;

beforeAll(async () => {
  h = await createHarness(4);
  w = await createWorld(h.app, { agents: 1 });
  agent = w.agents[0]!;
}, 120_000);
afterAll(async () => {
  await h?.close();
});

const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });
const exists = async (id: string) => (await suRows(h.su, 'SELECT 1 FROM contacts WHERE id = $1', [id])).length === 1;

async function merge(survivor: ContactId, loser: ContactId): Promise<void> {
  const r = await cmd(h.app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser, ownerChoice: null });
  expect(r.outcome.ok).toBe(true);
}

describe('lead-handling follow-ups: address delete (module 57)', () => {
  it('app_user may DELETE contact_addresses, and only through the RESTRICTIVE contact_addresses_delete policy (detail visible, a user actor in an editing role)', async () => {
    expect((await suRows<{ ok: boolean }>(h.su, "SELECT has_table_privilege('app_user', 'public.contact_addresses', 'DELETE') AS ok"))[0]!.ok).toBe(true);
    const pol = await suRows<{ permissive: string; cmd: string; qual: string }>(h.su, `
      SELECT permissive, cmd, qual FROM pg_policies WHERE tablename = 'contact_addresses' AND policyname = 'contact_addresses_delete'`);
    expect(pol).toHaveLength(1);
    expect(pol[0]).toMatchObject({ permissive: 'RESTRICTIVE', cmd: 'DELETE' });
    expect(pol[0]!.qual).toMatch(/contact_detail_visible/);
    expect(pol[0]!.qual).toMatch(/actor_kind\(\).*'user'/s);
    expect(pol[0]!.qual).toMatch(/'owner'.*'admin'.*'team_lead'.*'agent'.*'isa'/s);
    expect(pol[0]!.qual).not.toMatch(/'tc'/);
  });

  it('the owning agent deletes an address of their own person; the system actor deletes none', async () => {
    const c = await selfCreated(h.app, w, agent, 'Ada Dress');
    const id = uuid();
    await as(agent.actor, (tx) => sql`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, city) VALUES (app.tenant_id(), ${id}, ${c}, 'home', 'Reno')`.execute(tx));
    const del = (actor: Actor) => as(actor, async (tx) => Number((await sql`DELETE FROM contact_addresses WHERE id = ${id}::uuid`.execute(tx)).numAffectedRows ?? 0));
    expect(await del({ kind: 'system', tenantId: w.tenantId, via: 'worker' } as Actor)).toBe(0);
    expect(await del(agent.actor)).toBe(1);
  });
});

describe('lead-handling follow-ups: erasure and purge take the person with every record merged into it (R-DATA-4, R-DATA-5)', () => {
  it('R-DATA-4: app.erase_contact of a survivor erases its merged records (along a chain), writes one contact.erase row per record, and refuses CONTACT_ON_DEAL when a merged record is on a deal', async () => {
    const [a, b, c] = [await selfCreated(h.app, w, agent, 'A'), await selfCreated(h.app, w, agent, 'B'), await selfCreated(h.app, w, agent, 'C')];
    await merge(b, a);
    await merge(c, b);
    const tree = await suRows<{ contact_id: string; depth: number }>(h.su, 'SELECT contact_id, depth FROM app.contact_merge_tree($1, $2) ORDER BY depth', [w.tenantId, c]);
    expect(tree).toEqual([{ contact_id: c, depth: 0 }, { contact_id: b, depth: 1 }, { contact_id: a, depth: 2 }]);
    const audit = randomUUID();
    await as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${c}::uuid, ${audit}::uuid, 'PRIVACY_REQUEST')`.execute(tx));
    expect([await exists(a), await exists(b), await exists(c)]).toEqual([false, false, false]);
    const rows = await suRows<{ entity_id: string; changes: Record<string, unknown> }>(h.su, "SELECT entity_id, changes FROM audit_log WHERE action = 'contact.erase' AND entity_id = ANY ($1::uuid[]) ORDER BY seq", [[a, b, c]]);
    expect(rows).toEqual([
      { entity_id: c, changes: { erased: true } },
      { entity_id: b, changes: { erased: true, erased_with_contact_id: c } },
      { entity_id: a, changes: { erased: true, erased_with_contact_id: c } },
    ]);

    const [s, l] = [await selfCreated(h.app, w, agent, 'S'), await selfCreated(h.app, w, agent, 'L')];
    const deal = uuid();
    await as(w.owner.actor, (tx) => sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id)
      VALUES (app.tenant_id(), ${deal}, 'Purchase', 'buy', 'active', now(), ${l}, ${agent.id})`.execute(tx));
    await merge(s, l);
    await expect(as(w.owner.actor, (tx) => sql`SELECT app.erase_contact(${s}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx))).rejects.toThrow(/CONTACT_ON_DEAL/);
    expect([await exists(s), await exists(l)]).toEqual([true, true]);
  });

  it('R-DATA-5: the retention sweep purges a soft-deleted survivor with its merged record instead of failing on the contacts CHECK', async () => {
    const [s, l] = [await selfCreated(h.app, w, agent, 'Sweep S'), await selfCreated(h.app, w, agent, 'Sweep L')];
    await merge(s, l);
    const del = await cmd(h.app, w.owner.actor, s, { kind: 'soft_delete' });
    expect(del.outcome.ok).toBe(true);
    await suFixture(h.su, "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", [s]);
    // as the worker calls it: app_user, no tenant context (the definer runs as app_retention)
    const swept = await withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(now()) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
    expect(swept.contacts_purged).toBeGreaterThanOrEqual(1);
    expect([await exists(s), await exists(l)]).toEqual([false, false]);
  });

  it('the merge tree ends even on a merge cycle no application path can make (CYCLE clause)', async () => {
    const [x, y] = [await selfCreated(h.app, w, agent, 'Cycle X'), await selfCreated(h.app, w, agent, 'Cycle Y')];
    // corrupt state, superuser with triggers off: X merged into Y and Y merged into X
    await suFixture(h.su, `UPDATE contacts SET ownership_state = 'closed', closed_reason = 'merged', owner_user_id = NULL, owned_at = NULL, ownership_period_seq = NULL,
                                  first_touch_due_at = NULL, release_due_at = NULL, inactivity_warn_at = NULL, inactivity_release_at = NULL,
                                  merged_into_contact_id = CASE WHEN id = $1::uuid THEN $2::uuid ELSE $1::uuid END
                            WHERE id IN ($1::uuid, $2::uuid)`, [x, y]);
    const tree = await suRows<{ contact_id: string }>(h.su, 'SELECT contact_id FROM app.contact_merge_tree($1, $2)', [w.tenantId, x]);
    expect(tree.map((t) => t.contact_id).sort()).toEqual([x, y].sort());
  });
});
