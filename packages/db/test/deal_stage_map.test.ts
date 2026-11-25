// The idempotency backstop the deal-stage save relies on: one local deal per Follow Up Boss id
// (external_refs primary key). A second insert of the same id is refused and rolls back, so it
// cannot leave a second deal. The audit row for the save cannot be rewritten.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { closeDefaultDatabase } from '../src/client.js';
import { insertAuditRow } from '../src/repos/audit.js';
import { withTenantTx } from '../src/tenantTx.js';
import { type Harness, type World, createHarness, createWorld, ids, selfCreated, suRows, uuid } from './world.js';

let h: Harness;
let w: World;
let contactId: string;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
  contactId = await selfCreated(h.app, w, w.owner, 'Ada Lovelace');
});
afterAll(async () => {
  await closeDefaultDatabase();
  await h?.close();
});

describe('deal stage resolution', () => {
  it('a second external ref for the same Follow Up Boss deal does not create a second deal, and the audit row stays', async () => {
    const dealId = uuid();
    const otherId = uuid();
    const batchId = uuid();
    await withTenantTx(w.owner.actor, async (tx, now) => {
      await sql`INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id)
                VALUES (app.tenant_id(), ${batchId}, 'fub_api', 'connection_test', app.user_id())`.execute(tx);
      await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
                VALUES (app.tenant_id(), ${dealId}, 'Waiting deal', 'buy', 'active', now(), ${contactId}, ${w.owner.id}, ${w.owner.id})`.execute(tx);
      await sql`INSERT INTO external_refs (tenant_id, system, entity_type, external_id, entity_id, import_batch_id)
                VALUES (app.tenant_id(), 'fub', 'deal', '2', ${dealId}, ${batchId})`.execute(tx);
      await insertAuditRow(tx, w.owner.actor, ids, now, {
        action: 'settings.changed',
        entityType: 'import_batch',
        entityId: batchId,
        reason: 'DEAL_STAGE_MAP',
        changes: { deal_stage_map: { to: '{"Waiting On Lender":"active"}' } },
      });
    }, { db: h.app });

    await expect(
      withTenantTx(w.owner.actor, async (tx) => {
        await sql`INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
                  VALUES (app.tenant_id(), ${otherId}, 'Waiting deal again', 'buy', 'active', now(), ${contactId}, ${w.owner.id}, ${w.owner.id})`.execute(tx);
        await sql`INSERT INTO external_refs (tenant_id, system, entity_type, external_id, entity_id, import_batch_id)
                  VALUES (app.tenant_id(), 'fub', 'deal', '2', ${otherId}, ${batchId})`.execute(tx);
      }, { db: h.app }),
    ).rejects.toThrow(/duplicate key|unique/i);

    const deals = await suRows<{ name: string }>(h.su, 'SELECT name FROM deals WHERE tenant_id = $1 ORDER BY name', [w.tenantId]);
    expect(deals.map((d) => d.name)).toEqual(['Waiting deal']);
    const refs = await suRows<{ n: number }>(h.su, "SELECT count(*)::int AS n FROM external_refs WHERE tenant_id = $1 AND entity_type = 'deal' AND external_id = '2'", [w.tenantId]);
    expect(refs[0]!.n).toBe(1);
    await expect(withTenantTx(w.owner.actor, (tx) => sql`UPDATE audit_log SET reason = 'rewritten' WHERE reason = 'DEAL_STAGE_MAP'`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    const audit = await suRows<{ reason: string }>(h.su, 'SELECT reason FROM audit_log WHERE tenant_id = $1 AND entity_id = $2', [w.tenantId, batchId]);
    expect(audit.map((r) => r.reason)).toEqual(['DEAL_STAGE_MAP']);
  });
});
