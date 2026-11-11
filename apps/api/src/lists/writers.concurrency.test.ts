// Module 60's fill-empty writer under concurrency (E41, R-PAR-46), as module 65's import uses it: an import
// that finds no value must still never overwrite one another session writes before the import does (the
// import's own interim writer guaranteed this with ON CONFLICT DO NOTHING; the shared writer now does too).
import { randomUUID } from 'node:crypto';
import type { Actor, TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { setFieldValue } from './index.js';
import * as catalog from './repos/catalog.js';
import { call, listsWorld, type ListsWorld } from './testing.js';

let h: ApiHarness;
let w: ListsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await listsWorld(h, { perAgent: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** Resolves once some session of this test database waits on a row lock (the import's insert behind the agent's). */
async function someoneWaitsOnALock(ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const r = await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if ((r.rows[0]?.n ?? 0) > 0) return;
    if (Date.now() > until) throw new Error('the import never waited on the agent\'s row');
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

describe('setFieldValue fillEmptyOnly (module 60 writer for module 65)', () => {
  it('R-PAR-46 E41: fill-empty never overwrites a value another session writes between the import\'s read and its write', async () => {
    const batch = randomUUID();
    await h.su.query(`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1, $2, 'csv', 'committing', $3, repeat('a', 64))`, [w.tenantId, batch, w.owner.userId]);
    const f = await call<{ field: { id: string; key: string } }>(w.admin, 'POST', '/custom-fields', { label: 'Budget', fieldType: 'number' });
    expect(f.status).toBe(201);
    const def = { id: f.body.field.id, key: f.body.field.key, label: 'Budget', fieldType: 'number' as const, options: [], annual: false, archived: false };
    const contactId = w.aContacts[0]!;

    // the agent's value is written but not committed yet when the import reads "no value"
    let release!: () => void;
    const held = new Promise<void>((ok) => (release = ok));
    let written!: () => void;
    const agentWrote = new Promise<void>((ok) => (written = ok));
    const agent = withTenantTx(
      w.agentA.actor(),
      async (tx) => {
        await catalog.upsertFieldValue(tx, contactId, def.id, { type: 'number', number: 900 }, { kind: 'user', userId: w.agentA.userId! });
        written();
        await held;
      },
      { db: h.database },
    );
    await agentWrote;
    const sys: Actor = { kind: 'system', tenantId: w.tenantId as TenantId, via: 'import' };
    const imported = withTenantTx(sys, (tx) => setFieldValue(tx, contactId, def, 100, { kind: 'import', importBatchId: batch }, { fillEmptyOnly: true }), { db: h.database });
    await someoneWaitsOnALock(); // the import found no value and its insert now waits behind the agent's row
    release();
    await agent;
    expect(await imported).toEqual({ ok: true, changed: false, skipped: 'not_empty' });
    const row = (await h.su.query('SELECT value_number::int AS n, updated_by_kind, import_batch_id FROM contact_field_values WHERE contact_id = $1 AND field_id = $2', [contactId, def.id])).rows[0];
    expect(row).toEqual({ n: 900, updated_by_kind: 'user', import_batch_id: null });
  });
});
