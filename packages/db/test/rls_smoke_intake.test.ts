// RLS smoke of the lead-intake migration (google_lead_form_hooks, lead_source_webhook_secrets, phone_numbers.lead_source_id,
// app.resolve_google_lead_form, app.rearm_webhook_event; DATA_MODEL R-GADS-1, R-LSRC-3, R-LSRC-7, R-TRK-1). Every
// application step runs as app_user through withTenantTx / withPreTenant; the superuser pool only reads back and sets
// up fixtures that have no application path in this package. No test names the migration's file.
import { createHash, randomBytes } from 'node:crypto';
import type { Actor, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { type Harness, type World, createHarness, createWorld, suRows, uuid } from './world.js';

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest();

describe('lead intake RLS smoke (R-GADS-1 R-LSRC-3 R-LSRC-7 R-TRK-1)', () => {
  let h: Harness;
  let w: World;
  let other: World;
  const key = randomBytes(20).toString('hex');
  let hookId: string;
  const support = (): Actor => ({ kind: 'support', userId: w.owner.id as UserId, tenantId: w.tenantId, grantId: 'g' }) as Actor;

  beforeAll(async () => {
    h = await createHarness();
    w = await createWorld(h.app, { agents: 1, teamLead: true });
    other = await createWorld(h.app, { agents: 1 });
    hookId = uuid();
    await withTenantTx(w.system('provider'), async (tx) => {
      await sql`INSERT INTO google_lead_form_hooks (tenant_id, id, lead_source_id, key_hash, key_enc) VALUES (${w.tenantId}, ${hookId}, ${w.leadSourceId}, ${sha(key)}, '\\x01'::bytea)`.execute(tx);
      await sql`INSERT INTO lead_source_webhook_secrets (tenant_id, lead_source_id, secret_enc) VALUES (${w.tenantId}, ${w.leadSourceId}, '\\x02'::bytea)`.execute(tx);
    }, { db: h.app });
  });
  afterAll(async () => {
    await h?.close();
  });

  const count = (actor: Actor, table: string) => withTenantTx(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM ${sql.table(table)}`.execute(tx)).rows[0]!.n), { db: h.app });
  const resolve = (k: string) => withPreTenant(async (tx) => (await sql<{ tenant_id: string; hook_id: string; lead_source_id: string }>`SELECT * FROM app.resolve_google_lead_form(${sha(k)})`.execute(tx)).rows, { db: h.app });

  it('FORCE RLS and the support statement trigger on both tables', async () => {
    const rows = await suRows<{ relname: string; f: boolean; trg: boolean }>(h.su, `
      SELECT c.relname, c.relforcerowsecurity AS f,
             EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only') AS trg
        FROM pg_class c WHERE c.relname IN ('google_lead_form_hooks','lead_source_webhook_secrets') ORDER BY 1`);
    expect(rows).toEqual([{ relname: 'google_lead_form_hooks', f: true, trg: true }, { relname: 'lead_source_webhook_secrets', f: true, trg: true }]);
  });

  it('R-GADS-1: Owner reads the hook; agents, Team Leads and support never do', async () => {
    expect(await count(w.owner.actor, 'google_lead_form_hooks')).toBe(1);
    expect(await count(w.agents[0]!.actor, 'google_lead_form_hooks')).toBe(0);
    expect(await count(w.tl!.actor, 'google_lead_form_hooks')).toBe(0);
    expect(await count(support(), 'google_lead_form_hooks')).toBe(0);
    expect(await count(other.owner.actor, 'google_lead_form_hooks')).toBe(0);
  });

  it('R-LSRC-3: nobody but the system reads or writes lead_source_webhook_secrets', async () => {
    expect(await count(w.system('provider'), 'lead_source_webhook_secrets')).toBe(1);
    for (const a of [w.owner.actor, w.agents[0]!.actor, w.tl!.actor, support()]) expect(await count(a, 'lead_source_webhook_secrets')).toBe(0);
    await expect(withTenantTx(w.owner.actor, (tx) => sql`INSERT INTO lead_source_webhook_secrets (tenant_id, lead_source_id, secret_enc) VALUES (${w.tenantId}, ${uuid()}, '\\x02'::bytea)`.execute(tx), { db: h.app })).rejects.toThrow();
    await expect(withTenantTx(w.owner.actor, (tx) => sql`INSERT INTO google_lead_form_hooks (tenant_id, id, lead_source_id, key_hash, key_enc) VALUES (${w.tenantId}, ${uuid()}, ${w.leadSourceId}, ${randomBytes(32)}, '\\x01'::bytea)`.execute(tx), { db: h.app })).rejects.toThrow(/row-level security/);
    await expect(withTenantTx(w.system('provider'), (tx) => sql`DELETE FROM lead_source_webhook_secrets`.execute(tx), { db: h.app })).rejects.toThrow();
  });

  it('R-GADS-1: the key and identity are immutable; no DELETE; a non-32-byte input resolves nothing', async () => {
    await expect(withTenantTx(w.system('provider'), (tx) => sql`UPDATE google_lead_form_hooks SET key_hash = ${randomBytes(32)} WHERE id = ${hookId}`.execute(tx), { db: h.app })).rejects.toThrow(/GOOGLE_LEAD_FORM_IMMUTABLE/);
    await expect(withTenantTx(w.system('provider'), (tx) => sql`DELETE FROM google_lead_form_hooks WHERE id = ${hookId}`.execute(tx), { db: h.app })).rejects.toThrow();
    expect(await withPreTenant(async (tx) => (await sql`SELECT * FROM app.resolve_google_lead_form(${Buffer.alloc(31)})`.execute(tx)).rows, { db: h.app })).toEqual([]);
  });

  it('R-GADS-1: the resolver returns the current key of an active source in an active tenant, and nothing for an off source, an inactive tenant or a retired key', async () => {
    expect(await resolve(key)).toEqual([{ tenant_id: w.tenantId, hook_id: hookId, lead_source_id: w.leadSourceId }]);
    expect(await resolve('nope')).toEqual([]);
    await h.su.query('UPDATE lead_sources SET active = false WHERE id = $1', [w.leadSourceId]);
    expect(await resolve(key)).toEqual([]);
    await h.su.query('UPDATE lead_sources SET active = true WHERE id = $1', [w.leadSourceId]);
    await h.su.query(`UPDATE tenants SET status = 'suspended' WHERE id = $1`, [w.tenantId]);
    expect(await resolve(key)).toEqual([]);
    await h.su.query(`UPDATE tenants SET status = 'active' WHERE id = $1`, [w.tenantId]);
    expect(await resolve(key)).toHaveLength(1);
    await withTenantTx(w.system('provider'), (tx) => sql`UPDATE google_lead_form_hooks SET retired_at = now() WHERE id = ${hookId}`.execute(tx), { db: h.app });
    expect(await resolve(key)).toEqual([]);
    // a retired hook takes no further writes
    await expect(withTenantTx(w.system('provider'), (tx) => sql`UPDATE google_lead_form_hooks SET unreadable_count = 1 WHERE id = ${hookId}`.execute(tx), { db: h.app })).rejects.toThrow(/GOOGLE_LEAD_FORM_RETIRED/);
  });

  it('R-TRK-1: phone_numbers refuses a lead source on a non-tracking number', async () => {
    const insert = (purpose: string) => withTenantTx(w.owner.actor, (tx) => sql`
      INSERT INTO phone_numbers (tenant_id, id, e164, provider, provider_ref, number_type, purpose, sms_capable, voice_capable, acquired_at, lead_source_id)
      VALUES (${w.tenantId}, ${uuid()}, ${'+1555' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}, 'fake', ${uuid()}, 'local', ${purpose}, true, true, now(), ${w.leadSourceId})`.execute(tx), { db: h.app });
    await expect(insert('team_main')).rejects.toThrow(/phone_numbers_lead_source_tracking/);
    await expect(insert('tracking')).resolves.toBeDefined();
  });

  describe('R-LSRC-7: app.rearm_webhook_event', () => {
    const rec = (provider: string, ev: string, tenant: string | null, valid = true) =>
      withPreTenant((tx) => sql`SELECT app.record_webhook_event(${uuid()}::uuid, ${provider}, ${ev}, ${tenant}::uuid, ${valid}, NULL, now())`.execute(tx), { db: h.app });
    const rearm = (provider: string, ev: string, at = 'now()') =>
      withPreTenant(async (tx) => (await sql<{ id: string | null }>`SELECT app.rearm_webhook_event(${provider}, ${ev}, ${sql.raw(at)}) AS id`.execute(tx)).rows[0]!.id, { db: h.app });
    const status = async (ev: string) => (await suRows<{ status: string }>(h.su, 'SELECT status FROM webhook_events WHERE provider_event_id = $1', [ev]))[0]!.status;

    it('re-arms a failed row once, a stale received row, and never a processed, fresh, unrouted or rejected one', async () => {
      await rec('email', 'f1', w.tenantId);
      await h.su.query(`UPDATE webhook_events SET status = 'failed', error_code = 'X' WHERE provider_event_id = 'f1'`);
      const [a, b] = await Promise.all([rearm('email', 'f1'), rearm('email', 'f1')]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect(await status('f1')).toBe('received');

      await rec('email', 'fresh', w.tenantId);
      expect(await rearm('email', 'fresh')).toBeNull();
      expect(await rearm('email', 'fresh', `now() + interval '6 minutes'`)).not.toBeNull();

      await rec('email', 'p1', w.tenantId);
      await h.su.query(`UPDATE webhook_events SET status = 'processed' WHERE provider_event_id = 'p1'`);
      expect(await rearm('email', 'p1', `now() + interval '1 day'`)).toBeNull();

      await rec('email', 'u1', null);
      expect(await status('u1')).toBe('unrouted');
      expect(await rearm('email', 'u1', `now() + interval '1 day'`)).toBeNull();

      await rec('email', 'r1', null, false);
      expect(await status('r1')).toBe('rejected');
      expect(await rearm('email', 'r1', `now() + interval '1 day'`)).toBeNull();
    });

    it('is a reviewed definer: app_definer, pinned search_path, app_user may execute, PUBLIC may not', async () => {
      const rows = await suRows<{ fn: string; owner: string; secdef: boolean; cfg: string[]; pub: boolean; usr: boolean }>(h.su, `
        SELECT p.proname AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS secdef, p.proconfig AS cfg,
               has_function_privilege('public', p.oid, 'EXECUTE') AS pub, has_function_privilege('app_user', p.oid, 'EXECUTE') AS usr
          FROM pg_proc p WHERE p.proname IN ('rearm_webhook_event','resolve_google_lead_form') ORDER BY 1`);
      expect(rows).toEqual([
        { fn: 'rearm_webhook_event', owner: 'app_definer', secdef: true, cfg: ['search_path=pg_catalog, public'], pub: false, usr: true },
        { fn: 'resolve_google_lead_form', owner: 'app_definer', secdef: true, cfg: ['search_path=pg_catalog, public'], pub: false, usr: true },
      ]);
    });
  });
});
