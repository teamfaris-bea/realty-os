import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { applyOwnershipCommand } from '../src/ownership/apply.js';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, selfCreated, uuid, type Harness, type World } from './world.js';

let h: Harness;
let work: World;
let w: World;
let foreign: World;
let target: ContactId;
let loser: ContactId;
let foreignOnly: ContactId;
let exact: ContactId;
let merged: ContactId;
let mergedLoser: ContactId;
let wrongCase: ContactId;
let blank: ContactId;
let raw: ContactId;
let history: ContactId;
let historySource: string;
const rawLabel = '😀'.repeat(119) + ' A';
const originalMigration = readFileSync(join(MIGRATIONS_DIR, readdirSync(MIGRATIONS_DIR).find(n => n.startsWith('0101_'))!), 'utf8');
const originalCapture = originalMigration.slice(originalMigration.indexOf('CREATE FUNCTION app.capture_import_sources('), originalMigration.indexOf('CREATE OR REPLACE FUNCTION app.person_from_lead_source('))
  .replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');

beforeAll(async () => {
  h = await createHarness();
  work = await createWorld(h.app, { agents: 1 });
  const people: ContactId[] = [];
  for (let i = 0; i < 40; i++) people.push(await selfCreated(h.app, work, work.agents[0]!));
  target = people[0]!; loser = people[1]!;
  expect((await cmd(h.app, work.owner.actor, target, { kind: 'merge', survivorId: target, loserId: loser, ownerChoice: null })).outcome.ok).toBe(true);
  w = await createWorld(h.app, { agents: 1 });
  foreign = await createWorld(h.app, { agents: 1 });
  foreignOnly = await selfCreated(h.app, foreign, foreign.agents[0]!);
  const imported = async (label: string) => {
    const id = await selfCreated(h.app, w, w.agents[0]!);
    await withTenantTx(w.system(), tx => sql`UPDATE contacts SET original_source_detail = ${JSON.stringify({ import_system: 'csv', import_source: label })}::jsonb WHERE id = ${id}`.execute(tx), { db: h.app });
    return id;
  };
  exact = await imported('Exact synthetic'); wrongCase = await imported('exact synthetic');
  blank = await imported(' \t'); raw = await imported(rawLabel.slice(0, 120));
  merged = await imported('Exact synthetic'); mergedLoser = await imported('unknown synthetic'); history = await imported('Historical synthetic');
  expect((await cmd(h.app, w.owner.actor, merged, { kind: 'merge', survivorId: merged, loserId: mergedLoser, ownerChoice: null })).outcome.ok).toBe(true);
  // Same contact UUID in another tenant: every result must retain its tenant key.
  expect((await applyOwnershipCommand(foreign.agents[0]!.actor, exact, { kind: 'create', via: 'self' },
    { commandId: uuid(), newContact: { displayName: 'Synthetic duplicate-id contact' }, db: h.app })).outcome.ok).toBe(true);
  await withTenantTx(foreign.system(), tx => sql`UPDATE contacts SET original_source_detail = '{"import_system":"csv","import_source":"Exact synthetic"}'::jsonb WHERE id = ${exact}`.execute(tx), { db: h.app });
  await withTenantTx(foreign.owner.actor, tx => sql`UPDATE lead_sources SET import_labels = ARRAY['Exact synthetic'] WHERE id = ${foreign.leadSourceId}`.execute(tx), { db: h.app });
  const batch = uuid(), stage = uuid();
  await h.su.query("INSERT INTO import_batches(tenant_id,id,source,status,created_by_user_id,source_snapshot_sha256) VALUES($1,$2,'csv','committed',$3,$4)", [w.tenantId,batch,w.owner.id,'a'.repeat(64)]);
  await h.su.query("INSERT INTO import_stages(tenant_id,id,batch_id,category,seq,status) VALUES($1,$2,$3,'contacts',1,'pending')", [w.tenantId,stage,batch]);
  await withTenantTx(w.system(), tx => sql`INSERT INTO import_records(tenant_id,id,stage_id,source_ref,outcome,raw_purged_at,normalized,target_table,target_id,match_contact_id)
    VALUES (${w.tenantId},${uuid()},${stage},'synthetic.csv#row=1','imported',now(),${JSON.stringify({category:'contacts',leadSourceLabel:rawLabel})}::jsonb,'contacts',${raw},${raw})`.execute(tx), { db: h.app });
  historySource = uuid();
  await withTenantTx(w.owner.actor, async tx => {
    await sql`UPDATE lead_sources SET import_labels = ${['Exact synthetic',rawLabel,' \t']}::text[] WHERE id = ${w.leadSourceId}`.execute(tx);
    await sql`INSERT INTO lead_sources(tenant_id,id,name,kind,import_labels,no_ai_care) VALUES (${w.tenantId},${historySource},'Synthetic historical source','website',ARRAY['Historical synthetic'],true)`.execute(tx);
    await sql`UPDATE lead_sources SET import_labels = ARRAY[]::text[] WHERE id = ${historySource}`.execute(tx);
  }, { db: h.app });
});
afterAll(async () => { await h?.close(); });

it.each([['target',1],['merged-loser',1],['whole-tenant',0],['foreign-tenant',0]] as const)('capture computes the targeted family once under a generic plan: %s', async (scope, expected) => {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN'); await c.query("SET LOCAL track_functions='all'"); await c.query('SET LOCAL plan_cache_mode=force_generic_plan');
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_kind','system',true),set_config('app.principal_type','staff',true)", [work.tenantId]);
    const count = async () => Number((await c.query("SELECT calls FROM pg_stat_xact_user_functions WHERE schemaname='app' AND funcname='contact_person_ids'")).rows[0]?.calls ?? 0);
    const before = await count(); await c.query('SET LOCAL ROLE app_definer');
    await c.query('SELECT app.capture_import_sources($1,$2)', [scope === 'foreign-tenant' ? foreign.tenantId : work.tenantId, scope === 'whole-tenant' ? null : scope === 'merged-loser' ? loser : target]);
    await c.query('RESET ROLE'); expect(await count() - before).toBe(expected);
  } finally { await c.query('ROLLBACK'); c.release(); }
});

it.each(['target','merged-survivor','merged-loser','raw','blank','wrong-case','foreign-id','foreign-tenant','whole-tenant'] as const)('capture preserves exact association and refusal results versus 0101: %s', async scope => {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_kind','system',true),set_config('app.principal_type','staff',true)", [w.tenantId]);
    // Retain historical provenance; remove only fresh synthetic associations to exercise capture.
    await c.query('DELETE FROM contact_import_sources WHERE tenant_id=$1 AND lead_source_id<>$2', [w.tenantId,historySource]);
    const tenant = scope === 'foreign-tenant' ? foreign.tenantId : w.tenantId;
    const contact = ({target:exact,'merged-survivor':merged,'merged-loser':mergedLoser,raw,blank,'wrong-case':wrongCase,'foreign-id':foreignOnly,'foreign-tenant':exact,'whole-tenant':null})[scope];
    const variants = [];
    for (const variant of ['candidate','0101']) {
      await c.query('SAVEPOINT variant');
      if (variant === '0101') await c.query(originalCapture);
      await c.query('SET LOCAL ROLE app_definer');
      await c.query('SELECT app.capture_import_sources($1,$2)', [tenant,contact]);
      const reasons = (await c.query('SELECT id,app.person_source_refusal($1,id) AS reason FROM contacts WHERE tenant_id=$1 ORDER BY id', [w.tenantId])).rows;
      await c.query('RESET ROLE');
      const rows = (await c.query('SELECT tenant_id,contact_id,lead_source_id FROM contact_import_sources ORDER BY tenant_id,contact_id,lead_source_id')).rows;
      variants.push({rows,reasons}); await c.query('ROLLBACK TO SAVEPOINT variant');
    }
    expect(variants[0]).toEqual(variants[1]);
    const result = variants[0]!;
    const captured = result.rows.filter(r => r.tenant_id === w.tenantId && r.lead_source_id === w.leadSourceId).map(r => r.contact_id).sort();
    const expected = scope === 'whole-tenant' ? [exact,merged,mergedLoser,raw,blank] : scope.startsWith('merged-') ? [merged,mergedLoser] : scope === 'target' ? [exact] : scope === 'raw' ? [raw] : scope === 'blank' ? [blank] : [];
    expect(captured).toEqual(expected.sort());
    expect(result.rows).toContainEqual({tenant_id:w.tenantId,contact_id:history,lead_source_id:historySource});
    expect(result.rows).toContainEqual({tenant_id:foreign.tenantId,contact_id:exact,lead_source_id:foreign.leadSourceId});
    expect(result.reasons.find(r => r.id === history)?.reason).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(result.reasons.find(r => r.id === blank)?.reason).toBe('SOURCE_UNCLASSIFIED');
  } finally { await c.query('ROLLBACK'); c.release(); }
});

it('keeps the capture definer private and preserves the support-write backstop', async () => {
  const row = (await h.su.query("SELECT pg_get_userbyid(proowner) AS owner,prosecdef,proconfig,has_function_privilege('app_user',oid,'EXECUTE') AS app_execute FROM pg_proc WHERE oid='app.capture_import_sources(uuid,uuid)'::regprocedure")).rows[0];
  expect(row).toEqual({owner:'app_definer',prosecdef:true,proconfig:['search_path=pg_catalog, public'],app_execute:false});
  const c = await h.su.connect();
  try {
    await c.query('BEGIN'); await c.query('SET LOCAL ROLE app_definer');
    await c.query("SELECT set_config('app.tenant_id',$1,true),set_config('app.actor_kind','support',true),set_config('app.principal_type','staff',true)", [w.tenantId]);
    await expect(c.query('SELECT app.capture_import_sources($1,NULL)', [w.tenantId])).rejects.toMatchObject({code:'42501',message:expect.stringContaining('SUPPORT_READ_ONLY')});
  } finally { await c.query('ROLLBACK'); c.release(); }
});
