import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { tenantFixtureQuery } from './fixtureContext.js';
import { type ApiHarness, createApiHarness } from './testHarness.js';

let h: ApiHarness;
let pool: pg.Pool;
let tenants: string[];
beforeAll(async () => {
  h = await createApiHarness();
  tenants = [(await h.signup()).tenantId!, (await h.signup()).tenantId!];
  // Force both tenants and the next unscoped write to reuse the very same connection.
  pool = new pg.Pool({ connectionString: h.testDb.ownerUrl, max: 1 });
});
afterAll(async () => { await pool?.end(); await h?.close(); });

it('keeps concurrent fixture writes in their own tenant and leaves the next unscoped write guarded', async () => {
  const insert = "INSERT INTO lead_sources (tenant_id,id,name,kind) VALUES ($1,$2::uuid,'Synthetic context fixture ' || $2::uuid::text,'website') RETURNING tenant_id";
  const results = await Promise.all(tenants.map(tenant => tenantFixtureQuery(pool, tenant, insert, [tenant, randomUUID()])));
  expect(results.map(r => r.rows[0]!.tenant_id)).toEqual(tenants);
  await expect(pool.query(insert, [tenants[0], randomUUID()])).rejects.toMatchObject({ code: '42501', message: 'SOURCE_TENANT_CONTEXT_REQUIRED' });
});

it('still rejects a mismatched tenant and rolls back without leaking context', async () => {
  await expect(tenantFixtureQuery(pool, tenants[0]!,
    "INSERT INTO lead_sources (tenant_id,id,name,kind) VALUES ($1,$2,'Foreign fixture','website')", [tenants[1], randomUUID()]))
    .rejects.toMatchObject({ code: '42501', message: 'SOURCE_TENANT_CONTEXT_REQUIRED' });
  expect((await pool.query('SELECT app.tenant_id() AS tenant')).rows).toEqual([{ tenant: null }]);
  expect((await tenantFixtureQuery(pool, tenants[1]!, 'SELECT app.tenant_id() AS tenant')).rows).toEqual([{ tenant: tenants[1] }]);
});
