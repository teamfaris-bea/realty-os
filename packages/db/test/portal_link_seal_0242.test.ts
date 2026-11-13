// api-portal, batch 14 audit F2 (orchestrator decision (a)), the DB half: portal_link_seals (migration 0242) is
// definer-only, holds a sealed link for at most 15 minutes, and is reached only through portal.seal_link,
// portal.link_for_send, portal.unseal_link and portal.sweep_link_seals, each of which refuses or answers nothing to anyone
// but the system actor of the tenant. The behaviour with real messages (rendered at the provider send, dropped at a
// final status, after 15 minutes and on erasure) is apps/api/src/portal/seal.test.ts.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { type ClientActor, withPortalTx } from '../src/portalTx.js';
import { createParty, setPortalCleared, signIn } from './portalFixture.js';
import { createHarness, createWorld, type Harness, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let client: ClientActor;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
  const jane = await createParty(h, w, w.agents[0]!, 'Jane Buyer');
  await setPortalCleared(h, true);
  client = (await signIn(h, w, jane)).client;
}, 120_000);
afterAll(async () => {
  try {
    await setPortalCleared(h, false);
  } finally {
    await h?.close();
  }
});

const errCode = (e: { message?: string; code?: string }) => (/^[A-Z_]+:/.test(e.message ?? '') ? e.message!.split(':')[0] : e.code);

describe('b14 F2: the sealed sign-in link (portal_link_seals, 0242)', () => {
  it('F2: app_user has no privilege on portal_link_seals: no staff role, not the system actor, not a client principal', async () => {
    for (const actor of [w.owner.actor, w.agents[0]!.actor, w.system('worker')]) {
      for (const q of [sql`SELECT * FROM portal_link_seals`, sql`DELETE FROM portal_link_seals`, sql`INSERT INTO portal_link_seals (tenant_id, message_id, url_enc, expires_at) VALUES (app.tenant_id(), ${uuid()}, ${Buffer.alloc(48)}, now())`]) {
        await expect(withTenantTx(actor, (tx) => q.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
      }
    }
    await expect(withPortalTx(client, (tx) => sql`SELECT * FROM portal_link_seals`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
  });

  it('F2: the four portal functions are definers owned by app_definer with a pinned search_path, executable by app_user, never by PUBLIC; the trigger function and the internal check are not executable by app_user', async () => {
    const rows = await suRows<{ fn: string; owner: string; pinned: boolean; definer: boolean; public_exec: boolean; app_user_exec: boolean }>(h.su, `
      SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner,
             EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search_path=%') AS pinned, p.prosecdef AS definer,
             has_function_privilege('public', p.oid, 'EXECUTE') AS public_exec, has_function_privilege('app_user', p.oid, 'EXECUTE') AS app_user_exec
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE (n.nspname = 'portal' AND p.proname IN ('seal_link','link_for_send','unseal_link','sweep_link_seals','link_seal_caller_ok_internal'))
          OR (n.nspname = 'app' AND p.proname = 'portal_link_seal_on_final')
       ORDER BY 1`);
    expect(rows.map((r) => r.fn)).toEqual([
      'app.portal_link_seal_on_final()', 'portal.link_for_send(uuid)', 'portal.link_seal_caller_ok_internal()', 'portal.seal_link(uuid,bytea)',
      'portal.sweep_link_seals()', 'portal.unseal_link(uuid)',
    ]);
    for (const r of rows) {
      const internal = r.fn.startsWith('app.') || r.fn.includes('_internal(');
      expect(r, r.fn).toMatchObject({ owner: 'app_definer', pinned: true, public_exec: false, app_user_exec: !internal, definer: !r.fn.includes('_internal(') });
    }
    const trig = await suRows<{ enabled: string; def: string }>(h.su, `SELECT tgenabled AS enabled, pg_get_triggerdef(oid) AS def FROM pg_trigger WHERE tgname = 'messages_portal_link_seal_final'`);
    expect(trig).toHaveLength(1);
    expect(trig[0]!.def).toMatch(/AFTER UPDATE OF status ON public\.messages FOR EACH ROW WHEN .*portal_login_link/);
  });

  it('F2: only the system seals or reads a link; a person, and a client principal, are refused or get nothing; the system cannot seal what is not a queued link', async () => {
    const someId = uuid();
    for (const actor of [w.owner.actor, w.agents[0]!.actor]) {
      await expect(withTenantTx(actor, (tx) => sql`SELECT portal.seal_link(${someId}::uuid, ${Buffer.alloc(48)})`.execute(tx), { db: h.app })).rejects.toSatisfy((e: Error) => errCode(e) === 'PORTAL_LINK_SEAL');
      const read = await withTenantTx(actor, async (tx) => (await sql<{ c: Buffer | null }>`SELECT portal.link_for_send(${someId}::uuid) AS c`.execute(tx)).rows[0]!.c, { db: h.app });
      expect(read).toBeNull();
      const un = await withTenantTx(actor, async (tx) => (await sql<{ ok: boolean }>`SELECT portal.unseal_link(${someId}::uuid) AS ok`.execute(tx)).rows[0]!.ok, { db: h.app });
      expect(un).toBe(false);
      const swept = await withTenantTx(actor, async (tx) => (await sql<{ n: number }>`SELECT portal.sweep_link_seals() AS n`.execute(tx)).rows[0]!.n, { db: h.app });
      expect(swept).toBe(0);
    }
    await expect(withPortalTx(client, (tx) => sql`SELECT portal.seal_link(${someId}::uuid, ${Buffer.alloc(48)})`.execute(tx), { db: h.app })).rejects.toSatisfy((e: Error) => errCode(e) === 'PORTAL_LINK_SEAL');
    // the system, for a message id that is not a queued sign-in link of its tenant
    await expect(withTenantTx(w.system('worker'), (tx) => sql`SELECT portal.seal_link(${someId}::uuid, ${Buffer.alloc(48)})`.execute(tx), { db: h.app })).rejects.toSatisfy((e: Error) => errCode(e) === 'PORTAL_LINK_SEAL');
  });

  it('F2: a seal never outlives the link (15 minutes, CHECK) and never holds a short plaintext', async () => {
    const insert = (lifetime: string, bytes: number) =>
      suFixture(h.su, `INSERT INTO portal_link_seals (tenant_id, message_id, url_enc, created_at, expires_at) VALUES ($1, $2, $3, now(), now() + $4::interval)`, [w.tenantId, uuid(), Buffer.alloc(bytes, 1), lifetime]);
    await expect(insert('16 minutes', 48)).rejects.toThrow(/check constraint/);
    await expect(insert('15 minutes', 16)).rejects.toThrow(/check constraint/);
    await expect(insert('0 seconds', 48)).rejects.toThrow(/check constraint/);
  });
});
