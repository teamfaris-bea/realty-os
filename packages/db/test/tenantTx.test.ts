// withTenantTx / withPreTenant: request context, pool hygiene, the DB clock.
import { at, type TenantId, type UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { ActorContextError, actorGucs, withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, selfCreated, uuid, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
let single: Database;
let aContact: string; // one connection: proves what a REUSED pooled connection sees
beforeAll(async () => {
  h = await createHarness();
  a = await createWorld(h.app, { agents: 2 });
  b = await createWorld(h.app, { agents: 1 });
  aContact = await selfCreated(h.app, a, a.agents[0]!);
  await selfCreated(h.app, b, b.agents[0]!);
  single = createDatabase({ url: h.db.appUserUrl, max: 1 });
});
afterAll(async () => {
  await single?.close();
  await h?.close();
});

const count = (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], table: string) =>
  sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(tx).then((r) => Number(r.rows[0]!.n));

describe('withTenantTx', () => {
  it('R-TEN-3: tenant, user and actor kind come only from the Actor and are transaction-local (set_config(..., true))', async () => {
    const owner = a.owner.actor;
    const gucs = await withTenantTx(owner, async (tx) => {
      const r = await sql<{ t: string; u: string; k: string; p: string; local: string }>`
        SELECT current_setting('app.tenant_id') AS t, current_setting('app.user_id') AS u, current_setting('app.actor_kind') AS k,
               current_setting('app.principal_type') AS p,
               (SELECT count(*)::text FROM pg_settings WHERE name = 'app.tenant_id') AS local`.execute(tx);
      return r.rows[0]!;
    }, { db: single });
    expect(gucs).toMatchObject({ t: a.tenantId, u: a.owner.id, k: 'user', p: 'staff' });
    // role is never a GUC: it is looked up from memberships by app.my_role()
    const role = await withTenantTx(owner, async (tx) => (await sql<{ r: string | null }>`SELECT current_setting('app.role', true) AS r`.execute(tx)).rows[0]!.r, { db: single });
    expect(role === null || role === '').toBe(true);
  });

  it('R-TEN-2 E57: a pooled connection reused after the transaction (committed or aborted) sees zero rows', async () => {
    await withTenantTx(a.owner.actor, async (tx) => expect(await count(tx, 'contacts')).toBeGreaterThan(0), { db: single });
    await expect(
      withTenantTx(a.owner.actor, async (tx) => {
        await sql`SELECT 1/0`.execute(tx);
      }, { db: single }),
    ).rejects.toThrow(/division by zero/);
    // the same single connection, outside any tenant transaction
    const c = await single.pool.connect();
    try {
      const r = await c.query(`SELECT current_setting('app.tenant_id', true) AS t, (SELECT count(*) FROM contacts) AS n,
                                     (SELECT count(*) FROM tenants) AS tn, (SELECT count(*) FROM memberships) AS mn`);
      expect(r.rows[0].t ?? '').toBe('');
      expect(Number(r.rows[0].n) + Number(r.rows[0].tn) + Number(r.rows[0].mn)).toBe(0);
    } finally {
      c.release();
    }
  });

  it('R-TEN-6: one transaction is one tenant: a tenant B system context sees none of tenant A', async () => {
    const seen = await withTenantTx(b.system(), async (tx) => {
      const r = await sql<{ n: string }>`SELECT count(*) AS n FROM contacts WHERE tenant_id = ${a.tenantId}`.execute(tx);
      return Number(r.rows[0]!.n);
    }, { db: h.app });
    expect(seen).toBe(0);
    const own = await withTenantTx(b.system(), (tx) => count(tx, 'contacts'), { db: h.app });
    expect(own).toBe(1);
  });

  it('R-TEN-10: a user without an active membership in the context tenant sees nothing whatever the GUCs say', async () => {
    // a tenant-B user forged into a tenant-A actor
    const forged = { ...b.agents[0]!.actor, tenantId: a.tenantId };
    const n = await withTenantTx(forged, async (tx) => (await count(tx, 'contacts')) + (await count(tx, 'memberships')) + (await count(tx, 'tenant_settings')), { db: h.app });
    expect(n).toBe(0);
    // a member who was removed by the Owner loses everything at once
    const victim = a.agents[1]!;
    await withTenantTx(a.owner.actor, async (tx) => {
      await sql`UPDATE memberships SET status = 'removed', removed_at = now(), accepting_leads = false
                 WHERE tenant_id = ${a.tenantId} AND user_id = ${victim.id}`.execute(tx);
    }, { db: h.app });
    const after = await withTenantTx(victim.actor, async (tx) => (await count(tx, 'contacts')) + (await count(tx, 'memberships')), { db: h.app });
    expect(after).toBe(0);
  });

  it('R-OWN-6 E63: `now` is the database clock_timestamp(), never the app server clock', async () => {
    const r = await withTenantTx(a.owner.actor, async (tx, now) => {
      const db = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
      return { now, db: db.rows[0]!.now.getTime() };
    }, { db: h.app });
    expect(r.db - r.now).toBeGreaterThanOrEqual(0);
    expect(r.db - r.now).toBeLessThan(5_000);
    // independent of a skewed process clock: Date.now() is not consulted for `now`
    const realNow = Date.now;
    Date.now = () => at('2001-01-01T00:00:00Z');
    try {
      const skewed = await withTenantTx(a.owner.actor, async (_tx, now) => now, { db: h.app });
      expect(Math.abs(skewed - realNow())).toBeLessThan(60_000);
    } finally {
      Date.now = realNow;
    }
  });

  it('R-TEN-3: malformed actor ids are refused before any SQL runs (never a guessed tenant)', () => {
    expect(() => actorGucs({ kind: 'user', userId: 'x' as UserId, tenantId: a.tenantId, role: 'agent', sessionId: 's' })).toThrow(ActorContextError);
    expect(() => actorGucs({ kind: 'system', tenantId: "x'; DROP TABLE contacts; --" as TenantId, via: 'worker' })).toThrow(ActorContextError);
    expect(() => actorGucs({ kind: 'system', tenantId: a.tenantId, via: 'worker' }, 'not-a-uuid')).toThrow(ActorContextError);
    expect(actorGucs({ kind: 'system', tenantId: a.tenantId, via: 'worker' })).toMatchObject({ actorKind: 'system', userId: '' });
  });

  it('R-TEN-2: withPreTenant runs with no tenant context: every tenant table is empty, definers still work', async () => {
    const r = await withPreTenant(async (tx) => {
      const n = await count(tx, 'contacts');
      const t = await count(tx, 'tenants');
      const pack = await sql<{ n: string }>`SELECT count(*) AS n FROM jurisdiction_packs`.execute(tx);
      return { n, t, packs: Number(pack.rows[0]!.n) };
    }, { db: h.app });
    expect(r).toEqual({ n: 0, t: 0, packs: 1 });
  });

  it('support actors are read-only (RESTRICTIVE support_read_only_* policies)', async () => {
    const support = { kind: 'support' as const, userId: a.owner.id, tenantId: a.tenantId, grantId: uuid() };
    await expect(
      withTenantTx(support, async (tx) => {
        await sql`INSERT INTO notes (tenant_id, id, contact_id, author_user_id, body)
                  VALUES (${a.tenantId}, ${uuid()}, ${aContact}, ${a.owner.id}, 'x')`.execute(tx);
      }, { db: h.app }),
    ).rejects.toThrow(/row-level security|violates/);
  });
});
