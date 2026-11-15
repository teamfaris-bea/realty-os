import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createDatabase } from '../src/client.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { applyOwnershipCommand } from '../src/ownership/apply.js';
import { closeCreateWindow, openCreateWindow } from '../src/rolePreflight.js';
import { createTestDb } from '../src/testing/index.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createWorld, selfCreated, uuid, type Harness, type World } from './world.js';

let h: Harness;
let dir: string;
const role = `realty_trial_${process.pid}_source_upgrade`;
const legacy: {tenant:string; id:string; repaired:boolean; ai:boolean}[] = [];
const fixtures: { world: World; contact: string; plan: string; action: string; run: string; expected: string | null }[] = [];

const feedFixtures: { world: World; ids: string[]; visible: string[]; other: string[] }[] = [];
const migrationLedger = async () => (await h.su.query('SELECT version,name,checksum FROM realty_migrations.schema_migrations ORDER BY version')).rows;
async function assertFeedVisibility() {
  await withTenantTx(feedFixtures[0]!.world.agents[0]!.actor,async tx => {
    expect((await sql<{ rolsuper:boolean; rolbypassrls:boolean }>`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`.execute(tx)).rows)
      .toEqual([{rolsuper:false,rolbypassrls:false}]);
    expect((await sql<{ relname:string; relforcerowsecurity:boolean }>`SELECT relname,relforcerowsecurity FROM pg_class
      WHERE oid IN ('public.contacts'::regclass,'public.priority_feed_items'::regclass) ORDER BY relname`.execute(tx)).rows)
      .toEqual([{relname:'contacts',relforcerowsecurity:true},{relname:'priority_feed_items',relforcerowsecurity:true}]);
  },{db:h.app});
  for (const f of feedFixtures) {
    for (const [member, expected] of [[f.world.agents[0]!, f.visible], [f.world.agents[1]!, f.other], [f.world.owner, f.ids]] as const) {
      // Deliberately no tenant predicate: FORCE RLS must isolate duplicate card/contact UUIDs.
      const rows = await withTenantTx(member.actor, async tx => (await sql<{ tenant_id: string; id: string }>`
        SELECT tenant_id,id FROM priority_feed_items WHERE id = ANY (${f.ids}::uuid[]) ORDER BY id`.execute(tx)).rows, { db:h.app });
      expect(rows).toEqual([...expected].sort().map(id => ({ tenant_id:f.world.tenantId,id })));
    }
  }
}

beforeEach(async () => {
  legacy.length = 0; fixtures.length = 0; feedFixtures.length = 0;
  const sharedContact = uuid() as ContactId;
  const sharedCardIds = Array.from({ length:10 }, () => uuid());
  dir = mkdtempSync(join(tmpdir(), 'realty-source-upgrade-'));
  for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0101')) copyFileSync(join(MIGRATIONS_DIR,name),join(dir,name));
  const db = await createTestDb({ migrationsDir: dir });
  const app = createDatabase({ url: db.appUserUrl });
  const su = new pg.Pool({ connectionString: db.ownerUrl });
  h = { db, app, su, async close() { await app.close(); await su.end(); await db.drop(); } };
  for (let tenant = 0; tenant < 2; tenant++) {
    const w = await createWorld(app, { agents: 2 });
    const own = await selfCreated(app,w,w.agents[0]!);
    const other = await selfCreated(app,w,w.agents[1]!);
    // Same UUID in both tenants, but owned by a different agent in the second tenant.
    const created = await applyOwnershipCommand(w.agents[tenant]!.actor,sharedContact,{kind:'create',via:'self'},
      {commandId:uuid(),newContact:{displayName:'Synthetic shared-id upgrade contact'},db:app});
    expect(created.outcome.ok).toBe(true);
    const visible: string[] = [], otherVisible: string[] = [];
    let cardIndex = 0;
    for (const state of ['open','snoozed']) {
      for (const [viewer,contact,canSee] of [
        [w.agents[0]!,own,true], [w.agents[0]!,other,false], [w.agents[0]!,null,true],
        [w.agents[1]!,other,true], [w.agents[0]!,sharedContact,tenant===0],
      ] as const) {
        const id = sharedCardIds[cardIndex++]!;
        await su.query(`INSERT INTO priority_feed_items
          (tenant_id,id,user_id,item_type,band,contact_id,subject_type,subject_id,reasons,dedupe_key,state,snoozed_until)
          VALUES ($1,$2::uuid,$3,'first_touch_due','scored',$4,'contact',$2::uuid,'["UPGRADE_VISIBILITY"]',$2::uuid::text,$5,
            CASE WHEN $5='snoozed' THEN now()+interval '1 hour' ELSE NULL END)`, [w.tenantId,id,viewer.id,contact,state]);
        if (canSee) (viewer.id===w.agents[0]!.id ? visible : otherVisible).push(id);
      }
    }
    feedFixtures.push({world:w,ids:sharedCardIds,visible,other:otherVisible});
    const pb = uuid(), version = uuid();
    await su.query("INSERT INTO playbooks (tenant_id,id,kind,scope,name) VALUES ($1,$2,'nurture','team','Synthetic upgrade plan')", [w.tenantId,pb]);
    await su.query("INSERT INTO playbook_versions (tenant_id,id,playbook_id,version_no,steps,content_sha256,created_by_user_id) VALUES ($1,$2,$3,1,'[]',$4,$5)", [w.tenantId,version,pb,'a'.repeat(64),w.owner.id]);
    await withTenantTx(w.owner.actor, async tx => {
      await sql`INSERT INTO playbook_approvals (tenant_id,id,playbook_version_id,decision,decided_by_user_id,decided_by_role,content_sha256,attestation,decided_at)
        VALUES (${w.tenantId},${uuid()},${version},'approve',${w.owner.id},'owner',${'a'.repeat(64)},'Synthetic migration fixture approval',now())`.execute(tx);
      await sql`UPDATE playbook_versions SET status = 'approved' WHERE tenant_id = ${w.tenantId} AND id = ${version}`.execute(tx);
    }, { db:app });
    for (const [label, expected] of [['Unknown upgrade','SOURCE_UNCLASSIFIED'], ['', 'SOURCE_UNCLASSIFIED'], ['Restricted upgrade','SOURCE_NO_AUTOMATED_CONTACT'], [null,null]] as const) {
      const contact = await selfCreated(app,w,w.agents[0]!);
      if (label !== null) await withTenantTx(w.system(), tx => sql`UPDATE contacts SET original_source_detail = ${JSON.stringify({ import_system:'csv', import_source:label })}::jsonb WHERE id = ${contact}`.execute(tx), { db: app });
      const plan = uuid(), action = uuid(), run = uuid();
      await su.query("INSERT INTO playbook_enrollments (tenant_id,id,playbook_id,playbook_version_id,contact_id,enrolled_by,state) VALUES ($1,$2,$3,$4,$5,'new_lead','active')", [w.tenantId,plan,pb,version,contact]);
      await su.query(`INSERT INTO assistant_actions (tenant_id,id,contact_id,kind,action_category,autonomy,status,owner_user_id,explanation,payload,trigger_ref)
        VALUES ($1,$2,$3,'message_draft','nurture_step','requires_approval','proposed',$4,'Synthetic legacy trigger draft','{}','{"kind":"trigger_run"}')`, [w.tenantId,action,contact,w.agents[0]!.id]);
      await su.query(`INSERT INTO playbook_step_runs (tenant_id,id,playbook_version_id,step_key,status,scheduled_for,assistant_action_id,contact_id,trigger_key,trigger_ref)
        VALUES ($1,$2,$3,'upgrade','converted_to_draft',now(),$4,$5,$5::uuid::text,$6::jsonb)`, [w.tenantId,run,version,action,contact,JSON.stringify({kind:"birthday",key:contact})]);
      await su.query(`INSERT INTO priority_feed_items (tenant_id,id,user_id,item_type,band,contact_id,subject_type,subject_id,assistant_action_id,reasons,dedupe_key)
        VALUES ($1,$2,$3,'assistant_draft','scored',$4,'assistant_action',$5::uuid,$5::uuid,'["synthetic"]',$5::uuid::text)`, [w.tenantId,uuid(),w.agents[0]!.id,contact,action]);
      fixtures.push({ world:w,contact,plan,action,run,expected });
    }

    // Actual pre-0102 failed submissions, including assistant accounting, in each tenant.
    const contact = await selfCreated(app,w,w.agents[0]!);
    const conversation=uuid(), number=uuid();
    await su.query("INSERT INTO phone_numbers (tenant_id,id,e164,provider,provider_ref,number_type,purpose,sms_capable,voice_capable,acquired_at) VALUES ($1,$2,$3,'fake','synthetic-upgrade','local','team_main',true,true,now())",[w.tenantId,number,`+1555555010${tenant}`]);
    await su.query('INSERT INTO conversations (tenant_id,id,contact_id) VALUES ($1,$2,$3)',[w.tenantId,conversation,contact]);
    for (const [ai,repaired] of [[false,true],[true,true],[false,false]] as const) {
      const id=uuid(), action=uuid();
      // Stage historical rows without dispatching; all constraints/triggers remain enabled.
      await su.query(`INSERT INTO messages (tenant_id,id,conversation_id,contact_id,channel,direction,phone_number_id,from_address,to_address,body,status,status_reason,initiator,purpose,dispatched_at,occurred_at)
        VALUES ($1,$2,$3,$4,'sms','outbound',$6,'+15555550100','+15555550101','Synthetic legacy outcome','canceled',$5,'system','informational',now()-interval '11 minutes',now())`,[w.tenantId,id,conversation,contact,repaired?'DISPATCH_UNKNOWN_UNRESOLVED':'PROVIDER_REJECTED',number]);
      await su.query("UPDATE messages SET status='failed' WHERE id=$1",[id]);
      if (ai) {
        await su.query(`INSERT INTO assistant_actions (tenant_id,id,contact_id,kind,action_category,autonomy,status,owner_user_id,explanation,payload,playbook_version_id,epoch)
          VALUES ($1,$2,$3,'ai_isa_message','ai_isa_message','ai_isa_mandate','executed',$4,'Synthetic legacy AI outcome','{}',$5,1)`,[w.tenantId,action,contact,w.agents[0]!.id,version]);
        await su.query("UPDATE messages SET initiator='assistant',action_category='ai_isa_message',assistant_action_id=$2 WHERE id=$1",[id,action]);
      }
      legacy.push({tenant:w.tenantId,id,repaired,ai});
    }
    // Published 0099 permits these Owner writes without stopping existing work: genuine pre-0101 state.
    await withTenantTx(w.owner.actor, tx => sql`UPDATE lead_sources SET import_labels = ARRAY['Restricted upgrade'], no_ai_care = true WHERE id = ${w.leadSourceId}`.execute(tx), { db: app });
  }
  // No new login or credential: exercise the supported NOSUPERUSER BYPASSRLS migration role via SET ROLE.
  const c = await su.connect();
  try {
    const ident = c.escapeIdentifier(role);
    await c.query(`CREATE ROLE ${ident} NOLOGIN NOSUPERUSER CREATEROLE BYPASSRLS`);
    await c.query(`GRANT app_definer, app_retention TO ${ident} WITH ADMIN OPTION, INHERIT TRUE, SET TRUE`);
    for (const schema of ['public','app','realty_migrations']) await c.query(`ALTER SCHEMA ${schema} OWNER TO ${ident}`);
    for (const table of ['lead_sources','contacts','import_records','messages','calls','playbook_enrollments','assistant_actions','priority_feed_items','playbook_step_runs']) await c.query(`ALTER TABLE public.${table} OWNER TO ${ident}`);
    await c.query(`ALTER TABLE realty_migrations.schema_migrations OWNER TO ${ident}`);
    for (const fn of ['playbook_enrollments_source_guard','messages_source_guard','calls_source_guard','lead_sources_import_labels_guard','reject_support_write']) await c.query(`ALTER FUNCTION app.${fn}() OWNER TO ${ident}`);
    await c.query(`GRANT CREATE ON DATABASE ${c.escapeIdentifier(new URL(h.db.ownerUrl).pathname.slice(1))} TO ${ident}`);
    await c.query(`SET ROLE ${ident}`);
    expect((await c.query('SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname = current_user')).rows[0]).toEqual({ rolsuper:false,rolbypassrls:true,rolcanlogin:false });
    await openCreateWindow(c, () => {});
  } finally { await c.query('RESET ROLE'); c.release(); }
}, 180_000);

afterEach(async () => {
  if (h) {
    const admin = new pg.Client({ connectionString: h.db.ownerUrl.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await h.close();
    try { await admin.query(`DROP ROLE IF EXISTS ${admin.escapeIdentifier(role)}`); } finally { await admin.end(); }
  }
  if (dir) rmSync(dir,{ recursive:true,force:true });
});

it.each([true,false])('blocked action alone: linked=%s aborts only the matching tenant dependency',async linked=>{
  const target=legacy.find(f=>f.ai)!;
  const other=legacy.find(f=>f.ai && f.tenant!==target.tenant)!;
  const c=await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${c.escapeIdentifier(role)}`);
    expect((await c.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0].rolsuper).toBe(false);
    const action=(await c.query('SELECT assistant_action_id AS id FROM messages WHERE tenant_id=$1 AND id=$2',[target.tenant,target.id])).rows[0].id;
    // No blocked turn, canceled fact or refused handoff may account for this refusal.
    expect((await c.query(`SELECT
      (SELECT count(*) FROM ai_isa_turns WHERE tenant_id=$1 AND message_id=$2) +
      (SELECT count(*) FROM ai_isa_shared_facts WHERE tenant_id=$1 AND message_id=$2) +
      (SELECT count(*) FROM ai_isa_handoffs WHERE tenant_id=$1 AND pending_message_id=$2) AS n`,[target.tenant,target.id])).rows[0].n).toBe('0');
    if (linked) await c.query("UPDATE assistant_actions SET status='blocked' WHERE tenant_id=$1 AND id=$2",[target.tenant,action]);
    else {
      // Same UUID in another tenant must not match the message's composite association.
      await c.query(`INSERT INTO assistant_actions (tenant_id,id,contact_id,kind,action_category,autonomy,status,owner_user_id,explanation,payload,playbook_version_id,epoch)
        SELECT tenant_id,$2,contact_id,kind,action_category,autonomy,'blocked',owner_user_id,'Synthetic unrelated blocked action',payload,playbook_version_id,epoch
          FROM assistant_actions WHERE tenant_id=$1 AND id=(SELECT assistant_action_id FROM messages WHERE tenant_id=$1 AND id=$3)`,[other.tenant,action,other.id]);
    }
    const migration=c.query(readFileSync(join(MIGRATIONS_DIR,'0102_preserve_unresolved_outcomes.sql'),'utf8'));
    if (linked) await expect(migration).rejects.toThrow('UNRESOLVED_LEGACY_DEPENDENCIES_REQUIRE_REVIEW');
    else {
      await migration;
      expect((await c.query('SELECT status FROM messages WHERE tenant_id=$1 AND id=$2',[target.tenant,target.id])).rows[0].status).toBe('dispatch_unknown');
    }
  } finally { await c.query('ROLLBACK'); c.release(); }
  expect((await h.su.query('SELECT status FROM messages WHERE tenant_id=$1 AND id=$2',[target.tenant,target.id])).rows[0].status).toBe('failed');
  expect((await h.su.query('SELECT a.status FROM assistant_actions a JOIN messages m ON m.tenant_id=a.tenant_id AND m.assistant_action_id=a.id WHERE m.tenant_id=$1 AND m.id=$2',[target.tenant,target.id])).rows[0].status).toBe('executed');
});

it.each([false,true])('upgrades populated 0100 as a non-superuser (staged=%s): preserves both tenants, source/outcome repairs and feed visibility', async staged => {
  const url = new URL(h.db.ownerUrl);
  url.searchParams.set('options',`-c role=${role}`);
  const before = await migrationLedger();
  expect(before.at(-1)?.name).toBe('0100_b18_automated_drafts_guard.sql');
  await assertFeedVisibility();
  let preserved = before;
  if (staged) {
    const prior = mkdtempSync(join(tmpdir(),'realty-pr3-upgrade-'));
    try {
      for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0103')) copyFileSync(join(MIGRATIONS_DIR,name),join(prior,name));
      expect((await migrate(url.href,prior)).applied).toEqual(['0101_b18_import_source_safety.sql','0102_preserve_unresolved_outcomes.sql']);
    } finally { rmSync(prior,{recursive:true,force:true}); }
    preserved = await migrationLedger();
    expect(preserved.at(-1)?.name).toBe('0102_preserve_unresolved_outcomes.sql');
    await assertFeedVisibility();
    // A completed PR #3 release closes its CREATE window before the later feed release reopens it.
    const stageClient = new pg.Client({connectionString:url.href});
    await stageClient.connect();
    try { await closeCreateWindow(stageClient,() => {}); await openCreateWindow(stageClient,() => {}); }
    finally { await stageClient.end(); }
  }
  const throughFeed = mkdtempSync(join(tmpdir(),'realty-feed-upgrade-'));
  try {
    for (const name of readdirSync(MIGRATIONS_DIR).filter(n => n.endsWith('.sql') && n < '0104')) copyFileSync(join(MIGRATIONS_DIR,name),join(throughFeed,name));
    expect((await migrate(url.href,throughFeed)).applied).toEqual(staged
      ? ['0103_feed_visibility_lookup.sql']
      : ['0101_b18_import_source_safety.sql','0102_preserve_unresolved_outcomes.sql','0103_feed_visibility_lookup.sql']);
  } finally { rmSync(throughFeed,{recursive:true,force:true}); }
  const feedLedger = await migrationLedger();
  expect(feedLedger.slice(0,preserved.length)).toEqual(preserved);
  expect(feedLedger.at(-1)?.name).toBe('0103_feed_visibility_lookup.sql');
  await assertFeedVisibility();
  expect((await migrate(url.href,MIGRATIONS_DIR)).applied).toEqual(['0104_import_sources_support_guard.sql']);
  preserved = feedLedger;
  const after = await migrationLedger();
  expect(after.slice(0,preserved.length)).toEqual(preserved);
  expect(after).toEqual(listMigrations(MIGRATIONS_DIR).map(({version,name,checksum}) => ({version,name,checksum})));
  expect((await migrate(url.href,MIGRATIONS_DIR)).applied).toEqual([]);
  expect(await migrationLedger()).toEqual(after);
  await assertFeedVisibility();
  const c = new pg.Client({ connectionString:url.href });
  await c.connect();
  try { await closeCreateWindow(c, () => {}); } finally { await c.end(); }
  for (const f of legacy) {
    expect((await h.su.query('SELECT status,status_reason FROM messages WHERE tenant_id=$1 AND id=$2',[f.tenant,f.id])).rows[0]).toEqual({status:f.repaired?'dispatch_unknown':'failed',status_reason:f.repaired?'DISPATCH_UNKNOWN_UNRESOLVED':'PROVIDER_REJECTED'});
    const jobs=(await h.su.query("SELECT payload->>'status' AS status FROM jobs WHERE tenant_id=$1 AND kind='ai_isa.send_result' AND payload->>'messageId'=$2",[f.tenant,f.id])).rows;
    expect(jobs).toEqual(f.ai?[{status:'dispatch_unknown'}]:[]);
  }
  for (const f of fixtures) {
    const plan = (await h.su.query('SELECT state,stop_reason FROM playbook_enrollments WHERE id = $1',[f.plan])).rows[0];
    const action = (await h.su.query("SELECT status,payload->'withdrawn'->>'reason' AS reason FROM assistant_actions WHERE id = $1",[f.action])).rows[0];
    const run = (await h.su.query("SELECT status,trigger_ref->'skip'->>'reason' AS reason FROM playbook_step_runs WHERE id = $1",[f.run])).rows[0];
    const card = (await h.su.query('SELECT state FROM priority_feed_items WHERE assistant_action_id = $1',[f.action])).rows[0];
    if (f.expected) {
      expect(plan).toEqual({ state:'stopped',stop_reason:f.expected.toLowerCase() });
      expect(action).toEqual({ status:'invalidated',reason:f.expected });
      expect(run).toEqual({ status:'skipped_ineligible',reason:f.expected });
      expect(card.state).toBe('done');
    } else {
      expect(plan.state).toBe('active'); expect(action.status).toBe('proposed'); expect(run.status).toBe('converted_to_draft'); expect(card.state).toBe('open');
    }
    if (f.expected === 'SOURCE_NO_AUTOMATED_CONTACT') {
      await withTenantTx(f.world.owner.actor, tx => sql`UPDATE lead_sources SET import_labels = '{}' WHERE id = ${f.world.leadSourceId}`.execute(tx), { db:h.app });
      const retained = await withTenantTx(f.world.system(), async tx => (await sql<{ reason:string }>`SELECT app.person_source_refusal(app.tenant_id(),${f.contact}::uuid) AS reason`.execute(tx)).rows[0]!.reason, { db:h.app });
      expect(retained).toBe(f.expected);
    }
  }
}, 120_000);
