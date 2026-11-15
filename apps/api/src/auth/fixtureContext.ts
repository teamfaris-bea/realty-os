// Synthetic fixture writes only. Application operations must use their real actor and withTenantTx.
// A checked-out connection keeps BEGIN, SET LOCAL and the write together even with a multi-client pool.
import pg from 'pg';

export async function tenantFixtureQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  pool: pg.Pool | pg.Client, tenantId: string, text: string, values: unknown[] = [],
): Promise<pg.QueryResult<R>> {
  // A standalone client must be idle; callers must not nest this fixture transaction.
  const client = pool instanceof pg.Pool ? await pool.connect() : pool;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', '', true),
      set_config('app.actor_kind', 'system', true), set_config('app.principal_type', 'staff', true),
      set_config('app.ownership_command', '', true)`, [tenantId]);
    const result = await client.query<R>(text, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    if (pool instanceof pg.Pool) (client as pg.PoolClient).release();
  }
}
