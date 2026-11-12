// A website chat follows a person merge (migration *_webchat_sessions_follow_merge; R-OWN-24, R-INBOX-1, E140; batch 6
// review findings optouts/F2, tenancy-public/F1). A database at the migration before it, with a chat lead merged into
// a person and a chat lead merged along a chain, then the migration as on a live deployment: the sessions merged
// before it move to the root survivor's copy of their own chat identity, and from then on the merge transaction itself
// moves them. Every merge goes through the ownership engine as app_user; the superuser pool only seeds what has no
// application path at this layer (the widget connection) and reads back.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, type Database } from '../src/client.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { type TestDb, createTestDb } from '../src/testing/index.js';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createWorld, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

const THIS_MIGRATION = /_webchat_sessions_follow_merge\.sql$/;

let dir: string;
let db: TestDb;
let app: Database;
let su: pg.Pool;
let w: World;
let connectionId: string;

/** A chat lead: a contact of its own holding only its session's chat identity, and the open session (system actor). */
async function chatLead(name: string): Promise<{ contactId: ContactId; sessionId: string; address: string; pointId: string }> {
  const contactId = await selfCreated(app, w, w.agents[0]!, name);
  const address = `wc:${uuid().replace(/-/g, '')}`;
  const pointId = uuid();
  const sessionId = uuid();
  await withTenantTx(w.system('provider'), async (tx) => {
    await sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label)
              VALUES (app.tenant_id(), ${pointId}, ${contactId}, 'web_chat', ${address}, decode(md5(${address}) || md5(${address}), 'hex'), 'other')`.execute(tx);
    await sql`INSERT INTO webchat_sessions (tenant_id, id, connection_id, token_hash, origin, started_at, last_seen_at, contact_id, contact_point_id, claimed_kind, claimed_address)
              VALUES (app.tenant_id(), ${sessionId}, ${connectionId}, decode(md5(${sessionId}) || md5(${sessionId}), 'hex'), 'https://www.team-site.test',
                      now(), now(), ${contactId}, ${pointId}, 'email', ${`${name.split(' ')[0]!.toLowerCase()}@example.test`})`.execute(tx);
  }, { db: app });
  return { contactId, sessionId, address, pointId };
}

const merge = async (survivor: ContactId, loser: ContactId) => {
  const r = await cmd(app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser, ownerChoice: null });
  expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
};
const session = async (id: string) => (await suRows<{ contact_id: string; contact_point_id: string }>(su, 'SELECT contact_id, contact_point_id FROM webchat_sessions WHERE id = $1', [id]))[0]!;
const copyOf = async (contactId: string, address: string) =>
  (await suRows<{ id: string }>(su, "SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'web_chat' AND address = $2", [contactId, address]))[0]?.id ?? null;

let merged: { lead: Awaited<ReturnType<typeof chatLead>>; survivor: ContactId };
let chained: { lead: Awaited<ReturnType<typeof chatLead>>; middle: ContactId; root: ContactId };

beforeAll(async () => {
  // a database at the migration before this one (later ones, from later batches, are applied with it below)
  dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
  const all = listMigrations(MIGRATIONS_DIR);
  const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
  expect(at).toBeGreaterThan(0);
  for (const m of all.slice(0, at)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
  db = await createTestDb({ migrationsDir: dir });
  app = createDatabase({ url: db.appUserUrl, max: 4 });
  su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  su.on('error', () => {});
  w = await createWorld(app, { agents: 1 });
  connectionId = uuid();
  await suFixture(su, `
    INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id, allowed_origins, widget_key_hash, status, connected_at)
      VALUES ($1, $2, 'web_chat_widget', 'Website chat', $3, ARRAY['https://www.team-site.test'], $4, 'connected', now());`, [w.tenantId, connectionId, w.leadSourceId, createHash('sha256').update(connectionId).digest()]);

  // before the migration: a chat lead merged into a person, and one merged into a record later merged on
  merged = { lead: await chatLead('Ivy Visitor'), survivor: await selfCreated(app, w, w.agents[0]!, 'Ivy Known') };
  await merge(merged.survivor, merged.lead.contactId);
  chained = { lead: await chatLead('Pat Visitor'), middle: await selfCreated(app, w, w.agents[0]!, 'Pat Middle'), root: await selfCreated(app, w, w.agents[0]!, 'Pat Root') };
  await merge(chained.middle, chained.lead.contactId);
  await merge(chained.root, chained.middle);
  // the gap: the sessions stayed on the merged-away records
  expect((await session(merged.lead.sessionId)).contact_id).toBe(merged.lead.contactId);
  expect((await session(chained.lead.sessionId)).contact_id).toBe(chained.lead.contactId);

  const applied = await migrate(db.ownerUrl, MIGRATIONS_DIR);
  expect(applied.applied[0]).toMatch(THIS_MIGRATION);
}, 600_000);
afterAll(async () => {
  await app?.close();
  await su?.end();
  await db?.drop();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('a website chat follows a person merge (R-OWN-24)', () => {
  it('R-OWN-24 E140: a session merged away before the migration moves to the survivor\'s copy of its own chat identity; along a chain, to the root survivor', async () => {
    const copy = await copyOf(merged.survivor, merged.lead.address);
    expect(copy).not.toBeNull();
    expect(await session(merged.lead.sessionId)).toEqual({ contact_id: merged.survivor, contact_point_id: copy });
    const rootCopy = await copyOf(chained.root, chained.lead.address);
    expect(rootCopy).not.toBeNull();
    expect(await session(chained.lead.sessionId)).toEqual({ contact_id: chained.root, contact_point_id: rootCopy });
  });

  it('R-OWN-24 R-INBOX-1: from then on the merge transaction itself moves the loser\'s sessions, whatever the merging actor may read, and leaves every other session alone', async () => {
    const lead = await chatLead('Sam Visitor');
    const other = await chatLead('Bo Bystander');
    const survivor = await selfCreated(app, w, w.agents[0]!, 'Sam Known');
    await merge(survivor, lead.contactId);
    expect(await session(lead.sessionId)).toEqual({ contact_id: survivor, contact_point_id: await copyOf(survivor, lead.address) });
    expect(await session(other.sessionId)).toEqual({ contact_id: other.contactId, contact_point_id: other.pointId });
    // the claim the visitor typed follows the person (it is read from the sessions of the record)
    expect(await suRows(su, 'SELECT claimed_address FROM webchat_sessions WHERE contact_id = $1', [survivor])).toEqual([{ claimed_address: 'sam@example.test' }]);
  });

  it('the definer is owned by app_definer with a pinned search_path, not executable by PUBLIC, and its trigger fires after the point copy', async () => {
    const f = (await suRows<{ secdef: boolean; owner: string; config: string[] }>(su, `
      SELECT p.prosecdef AS secdef, r.rolname AS owner, p.proconfig AS config FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
       WHERE p.oid = 'app.webchat_sessions_follow_merge()'::regprocedure`))[0]!;
    expect(f).toEqual({ secdef: true, owner: 'app_definer', config: ['search_path=pg_catalog, public'] });
    expect((await suRows<{ ok: boolean }>(su, "SELECT has_function_privilege('public', 'app.webchat_sessions_follow_merge()', 'EXECUTE') AS ok"))[0]!.ok).toBe(false);
    const order = await suRows<{ tgname: string }>(su, "SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.contacts'::regclass AND tgname LIKE 'contacts_merge_%' ORDER BY tgname");
    // + contacts_merge_roles (b7 review ownership-data/F1) and contacts_merge_work (backlog-gaps: tasks and
    // appointments), which read nothing the other two write
    expect(order.map((t) => t.tgname)).toEqual(['contacts_merge_children', 'contacts_merge_roles', 'contacts_merge_webchat_sessions', 'contacts_merge_work']);
    // app_user still writes no session itself (0018 webchat_system: the system actor only)
    await expect(withTenantTx(w.owner.actor, (tx) => sql`UPDATE webchat_sessions SET contact_id = contact_id WHERE tenant_id = app.tenant_id()`.execute(tx), { db: app })
      .then((r) => Number(r.numAffectedRows ?? 0n))).resolves.toBe(0);
  });
});
