// INSERT that tolerates a duplicate of ONE named unique constraint, without ON CONFLICT.
//
// ON CONFLICT is not usable for app_user in two places: `jobs` (INSERT privilege only; the arbiter
// needs SELECT) and rows written for OTHER users (notifications): with ON CONFLICT, PG16 also checks
// the new row against the SELECT policy, which hides other users' notifications. A savepoint keeps
// the surrounding transaction usable when the duplicate is detected.
import { type RawBuilder, sql } from 'kysely';
import type { Tx } from './tenantTx.js';

let n = 0;

/** Returns true when inserted, false when `constraint` reported a duplicate; other errors propagate. */
export async function insertUnlessDuplicate(tx: Tx, insert: RawBuilder<unknown>, constraint: string): Promise<boolean> {
  const name = sql.raw(`realty_sp_${(n = (n + 1) % 1_000_000)}`);
  await sql`SAVEPOINT ${name}`.execute(tx);
  try {
    await insert.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    return true;
  } catch (err) {
    await sql`ROLLBACK TO SAVEPOINT ${name}`.execute(tx);
    await sql`RELEASE SAVEPOINT ${name}`.execute(tx);
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === constraint) return false;
    throw err;
  }
}
