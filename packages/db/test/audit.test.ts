// audit_log writes from db/client, the default database handle, transaction retries.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDefaultDatabase, configureDatabase } from '../src/client.js';
import { defaultIds } from '../src/ownership/apply.js';
import { insertAuditRow } from '../src/repos/audit.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, selfCreated, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
const ids = defaultIds();
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
});
afterAll(async () => {
  await closeDefaultDatabase();
  await h?.close();
});

describe('audit', () => {
  it('R-AUDIT-2: a user context writes only its own user rows; a system row needs the system actor', async () => {
    const entity = uuid();
    await withTenantTx(w.owner.actor, (tx, now) => insertAuditRow(tx, w.owner.actor, ids, now, { action: 'settings.changed', entityType: 'tenant_settings', entityId: entity, changes: { offer_window_seconds: { from: 300, to: 240 } } }), { db: h.app });
    await withTenantTx(w.system(), (tx, now) => insertAuditRow(tx, w.system(), ids, now, { action: 'ownership.drift_detected', entityType: 'contact', entityId: entity }), { db: h.app });
    // a user context forging a system row, or another user's row, is rejected by RLS
    await expect(withTenantTx(w.owner.actor, (tx, now) => insertAuditRow(tx, w.system(), ids, now, { action: 'settings.changed', entityType: 'x', entityId: entity }), { db: h.app })).rejects.toThrow(/row-level security/);
    await expect(withTenantTx(w.owner.actor, (tx, now) => insertAuditRow(tx, w.agents[0]!.actor, ids, now, { action: 'settings.changed', entityType: 'x', entityId: entity }), { db: h.app })).rejects.toThrow(/row-level security/);
    const rows = await suRows<{ actor_kind: string; actor_via: string; actor_role: string | null }>(h.su, 'SELECT actor_kind, actor_via, actor_role FROM audit_log WHERE entity_id = $1 ORDER BY seq', [entity]);
    expect(rows).toEqual([{ actor_kind: 'user', actor_via: 'api', actor_role: 'owner' }, { actor_kind: 'system', actor_via: 'worker', actor_role: null }]);
  });

  it('R-AUDIT-1: app_user cannot UPDATE or DELETE audit rows; R-AUDIT-3: an action whose audit insert fails rolls back with it', async () => {
    await expect(withTenantTx(w.owner.actor, (tx) => sql`UPDATE audit_log SET reason = 'x'`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    await expect(withTenantTx(w.owner.actor, (tx) => sql`DELETE FROM audit_log`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    await selfCreated(h.app, w, w.agents[0]!);
    await expect(
      withTenantTx(w.agents[0]!.actor, async (tx, now) => {
        await sql`UPDATE contacts SET pond_summary = 'changed' WHERE owner_user_id = ${w.agents[0]!.id}`.execute(tx);
        await insertAuditRow(tx, w.system(), ids, now, { action: 'settings.changed', entityType: 'x', entityId: null }); // forged: fails
      }, { db: h.app }),
    ).rejects.toThrow();
    expect(await suRows(h.su, `SELECT count(*)::int AS n FROM contacts WHERE pond_summary = 'changed'`)).toEqual([{ n: 0 }]);
    await expect(insertAuditRow(null as never, w.system(), ids, 0 as never, { action: 'Bad Action' as never, entityType: 'x', entityId: null })).rejects.toThrow(/area\.verb/);
  });

  it('withTenantTx retries serialization failures; free functions use the configured default database', async () => {
    let calls = 0;
    const r = await withTenantTx(w.system(), async (tx) => {
      calls++;
      await sql`SELECT 1`.execute(tx);
      if (calls < 3) throw Object.assign(new Error('could not serialize access'), { code: '40001' });
      return 'done';
    }, { db: h.app, retries: 3 });
    expect([r, calls]).toEqual(['done', 3]);
    configureDatabase({ url: h.db.appUserUrl, max: 2 });
    const id = await selfCreated(h.app, w, w.agents[0]!);
    const n = await withTenantTx(w.agents[0]!.actor, async (tx) => (await sql<{ n: string }>`SELECT count(*) AS n FROM contacts WHERE id = ${id}`.execute(tx)).rows[0]!.n);
    expect(Number(n)).toBe(1);
  });
});
