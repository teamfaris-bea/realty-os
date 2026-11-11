// The dry run's whole-book read runs under a bulk-sized statement timeout, scoped to its own transaction
// (lane scale-250k: at 250k contacts the 30 s pool default failed every dry run).
import { createDatabase, withTenantTx } from '@realty/db';
import { createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { systemActor } from '../worker/systemActor.js';
import { BULK_STATEMENT_TIMEOUT, loadContacts } from './repos/existing.js';

describe('dry-run book read', () => {
  it('raises the statement timeout for its transaction only; targeted reads keep the default', async () => {
    const db = await createTestDb();
    const app = createDatabase({ url: db.appUserUrl, max: 1 });
    try {
      const t = '0190a3c4-0000-7000-8000-000000000001';
      const inTx = await withTenantTx(systemActor(t, 'import'), async (tx) => {
        await loadContacts(tx);
        return (await sql<{ v: string }>`SELECT current_setting('statement_timeout') AS v`.execute(tx)).rows[0]!.v;
      }, { db: app });
      expect(inTx).toBe(BULK_STATEMENT_TIMEOUT);
      const targeted = await withTenantTx(systemActor(t, 'import'), async (tx) => {
        await loadContacts(tx, []);
        return (await sql<{ v: string }>`SELECT current_setting('statement_timeout') AS v`.execute(tx)).rows[0]!.v;
      }, { db: app });
      expect(targeted).toBe('30s');
      const after = (await sql<{ v: string }>`SELECT current_setting('statement_timeout') AS v`.execute(app.kysely)).rows[0]!.v;
      expect(after).toBe('30s');
    } finally {
      await app.close();
      await db.drop();
    }
  });
});
