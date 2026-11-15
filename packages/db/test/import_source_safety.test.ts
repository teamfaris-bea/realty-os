import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, selfCreated, uuid, type Harness, type World } from './world.js';
let h: Harness;
let w: World;
let other: World;
beforeAll(async () => { h = await createHarness(); w = await createWorld(h.app, { agents: 1 }); other = await createWorld(h.app, { agents: 1 }); });
afterAll(async () => { await h?.close(); });
const reason = (id: string, world = w) => withTenantTx(world.owner.actor, async tx =>
  (await sql<{ reason: string | null }>`SELECT app.person_source_refusal(app.tenant_id(), ${id}::uuid) AS reason`.execute(tx)).rows[0]!.reason, { db: h.app });
const imported = async (label?: string) => {
  const id = await selfCreated(h.app, w, w.agents[0]!);
  await withTenantTx(w.system(), tx => sql`UPDATE contacts SET original_source_detail = ${JSON.stringify({ import_system: 'csv', ...(label === undefined ? {} : { import_source: label }) })}::jsonb WHERE id = ${id}`.execute(tx), { db: h.app });
  return id;
};
const map = (labels: string[]) => withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET import_labels = ${labels}::text[] WHERE id = ${w.leadSourceId}`.execute(tx), { db: h.app });
describe('imported source decision is fail closed', () => {
  it('blocks missing/unmapped imports, leaves ordinary contacts alone, and does not disclose another tenant', async () => {
    const id = await imported('Unknown test label');
    expect(await reason(id)).toBe('SOURCE_UNCLASSIFIED');
    expect(await reason(await imported())).toBe('SOURCE_UNCLASSIFIED');
    expect(await reason(await selfCreated(h.app, w, w.agents[0]!))).toBeNull();
    expect(await reason(id, other)).toBeNull();
  });
  it('applies only an exact Owner mapping retrospectively and re-blocks on unmapping', async () => {
    const id = await imported('Exact test');
    await map(['exact test']);
    expect(await reason(id)).toBe('SOURCE_UNCLASSIFIED');
    await map(['Exact test']);
    expect(await reason(id)).toBeNull();
    await map([]);
    expect(await reason(id)).toBe('SOURCE_UNCLASSIFIED');
  });
  it('retains proven source prohibitions after unmapping', async () => {
    const id = await imported('Restricted test');
    await map(['Restricted test']);
    await withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET no_ai_care = true WHERE id = ${w.leadSourceId}`.execute(tx), { db: h.app });
    expect(await reason(id)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    await map([]);
    expect(await reason(id)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
  });
});


describe('source mapping authority', () => {
  it('rejects system changes and source provenance writes, and fails closed on duplicate exact mappings', async () => {
    await withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET no_ai_care = false WHERE id = ${w.leadSourceId}`.execute(tx), { db: h.app });
    await map(['Ambiguous test']);
    const id = await imported('Ambiguous test');
    expect(await reason(id)).toBeNull();
    await expect(withTenantTx(w.system(), tx => sql`UPDATE lead_sources SET import_labels = ARRAY['Forged'] WHERE id = ${w.leadSourceId}`.execute(tx), { db: h.app })).rejects.toThrow(/OWNER_ONLY/);
    await expect(withTenantTx(w.owner.actor, tx => sql`DELETE FROM contact_import_sources WHERE contact_id = ${id}`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    await withTenantTx(w.owner.actor, tx => sql`INSERT INTO lead_sources (tenant_id,id,name,kind,import_labels)
      VALUES (${w.tenantId},${uuid()},'Ambiguous second source','website',ARRAY['Ambiguous test'])`.execute(tx), { db: h.app });
    expect(await reason(id)).toBe('SOURCE_UNCLASSIFIED');
  });
});

it('uses complete Unicode labels without JavaScript/PostgreSQL prefix collisions', async () => {
  await withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET no_ai_care = false WHERE id = ${w.leadSourceId}`.execute(tx), { db: h.app });
  const raw = '😀'.repeat(119) + ' A';
  const exact = await imported(raw);
  const different = await imported('😀'.repeat(119) + ' B');
  await map([raw]);
  expect(await reason(exact)).toBeNull();
  expect(await reason(different)).toBe('SOURCE_UNCLASSIFIED');
});

it('the dispatch guard covers INSERT, rejects missing tenant context, and preserves one-to-one exemptions', async () => {
  const id = await imported('Dispatch unclassified test');
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    // Exercise the real trigger function as app_user without unrelated message-shape constraints.
    await c.query(`CREATE TEMP TABLE source_guard_probe (
      tenant_id uuid, contact_id uuid, status text, direction text, imported boolean, initiator text,
      bulk_action_id uuid, marketing_piece_id uuid, action_category text, assistant_action_id uuid);
      CREATE TRIGGER probe BEFORE INSERT ON source_guard_probe FOR EACH ROW EXECUTE FUNCTION app.messages_source_guard();
      GRANT INSERT ON source_guard_probe TO app_user;
      SET LOCAL ROLE app_user`);
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_kind','system',true),set_config('app.principal_type','staff',true)", [w.tenantId]);
    const insert = (initiator: string) => c.query("INSERT INTO source_guard_probe (tenant_id,contact_id,status,direction,imported,initiator,action_category) VALUES ($1,$2,'dispatching','outbound',false,$3,'search_alert')", [w.tenantId,id,initiator]);
    await c.query('SAVEPOINT attempt');
    await expect(insert('system')).rejects.toThrow(/SOURCE_UNCLASSIFIED/);
    await c.query('ROLLBACK TO SAVEPOINT attempt');
    await expect(insert('human')).resolves.toBeDefined();
    await c.query("SELECT set_config('app.tenant_id','',true)");
    await c.query('SAVEPOINT missing_context');
    await expect(insert('system')).rejects.toThrow(/SOURCE_TENANT_CONTEXT_REQUIRED/);
    await c.query('ROLLBACK TO SAVEPOINT missing_context');
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
  const installed = await h.su.query<{ inserts: boolean }>("SELECT (tgtype::int & 4) <> 0 AS inserts FROM pg_trigger WHERE tgname = 'messages_source_guard' AND tgrelid = 'public.messages'::regclass");
  expect(installed.rows[0]?.inserts).toBe(true);
});

it('never classifies blank Unicode source evidence even if a legacy Owner mapping contains it', async () => {
  const blank = '\u00a0\ufeff';
  const id = await imported(blank);
  await map([blank]);
  expect(await reason(id)).toBe('SOURCE_UNCLASSIFIED');
});
