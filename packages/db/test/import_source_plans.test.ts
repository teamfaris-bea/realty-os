import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, selfCreated, type Harness, type World } from './world.js';

let h: Harness;
let w: World;
let target: string;
let family: ContactId;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
  const people: ContactId[] = [];
  for (let i=0;i<40;i++) people.push(await selfCreated(h.app,w,w.agents[0]!));
  target = people.at(-1)!;
  family = people[0]!;
  expect((await cmd(h.app,w.owner.actor,family,{kind:'merge',survivorId:family,loserId:people[1]!,ownerChoice:null})).outcome.ok).toBe(true);
  await withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET import_labels=ARRAY['Synthetic plan fixture']
    WHERE tenant_id=${w.tenantId} AND id=${w.leadSourceId}`.execute(tx), { db:h.app });
});
afterAll(async () => { await h?.close(); });

it.each([
  ['stop_import_automation','person_source_refusal','target',1],
  ['capture_import_sources','person_from_lead_source','target',1],
  ['stop_import_automation','person_source_refusal','family',2],
  ['stop_import_automation','person_source_refusal','all',40],
  ['stop_import_automation','person_source_refusal','foreign',0],
] as const)('%s under a generic plan preserves %s coverage for scope %s', async (fn, counter, scope, expected) => {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL track_functions='all'");
    await c.query('SET LOCAL plan_cache_mode=force_generic_plan');
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_kind','system',true),set_config('app.principal_type','staff',true)", [w.tenantId]);
    const count = async () => Number((await c.query("SELECT calls FROM pg_stat_xact_user_functions WHERE schemaname='app' AND funcname=$1", [counter])).rows[0]?.calls ?? 0);
    const before = await count();
    await c.query('SET LOCAL ROLE app_definer');
    await c.query(`SELECT app.${fn}($1,$2)`, [scope === 'foreign' ? '00000000-0000-4000-8000-000000000001' : w.tenantId,scope === 'all' ? null : scope === 'family' ? family : target]);
    await c.query('RESET ROLE');
    // A deterministic query-work invariant, independent of machine speed and timing thresholds.
    expect(await count()-before).toBe(expected);
  } finally { await c.query('ROLLBACK'); c.release(); }
});
