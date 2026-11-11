// provider_credentials least privilege (lane spark-prep migration): readable and writable only by the system
// actor and Owner/Admin. A support session, even with an active read-only grant, sees no row and writes
// nothing; agents and other tenants see nothing; definer paths (BYPASSRLS) are unaffected.
import type { SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, PH, suRows, uuid, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
let support: SupportActor;
const credIds: string[] = [];

type Actor = Parameters<typeof withTenantTx>[0];
const visible = (actor: Actor) =>
  withTenantTx(actor, async (tx) => (await sql<{ id: string; provider: string }>`SELECT id, provider FROM provider_credentials ORDER BY provider`.execute(tx)).rows, { db: h.app });

beforeAll(async () => {
  h = await createHarness(6);
  a = await createWorld(h.app, { agents: 1 });
  b = await createWorld(h.app, { agents: 0 });
  for (const provider of ['mls', 'telephony']) {
    const id = uuid();
    credIds.push(id);
    await withTenantTx(
      a.owner.actor,
      (tx) => sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, created_by_user_id)
                  VALUES (app.tenant_id(), ${id}, ${provider}, ${Buffer.from('ciphertext-only')}, 1, app.user_id())`.execute(tx),
      { db: h.app },
    );
  }
  const supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`s-${uuid()}@platform.test`}, 'Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
  const grantId = uuid();
  await withTenantTx(
    a.owner.actor,
    (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
                VALUES (${a.tenantId}, ${grantId}, ${supportUserId}, ${a.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx),
    { db: h.app },
  );
  support = { kind: 'support', userId: supportUserId, tenantId: a.tenantId as TenantId, grantId };
});
afterAll(async () => {
  await h?.close();
});

describe('provider_credentials: system and Owner/Admin only (never support)', () => {
  it('Owner and the system actor still read every credential of their tenant (telephony flows included)', async () => {
    expect((await visible(a.owner.actor)).map((r) => r.provider)).toEqual(['mls', 'telephony']);
    expect((await visible(a.system())).map((r) => r.provider)).toEqual(['mls', 'telephony']);
  });

  it('a support session with an active grant gets zero rows and cannot insert, update or delete', async () => {
    // the grant is live: support still sees tenant-wide data elsewhere (e.g. integration status)
    expect(await withTenantTx(support, async (tx) => (await sql<{ ok: boolean }>`SELECT app.is_tenant_wide() AS ok`.execute(tx)).rows[0]!.ok, { db: h.app })).toBe(true);
    expect(await visible(support)).toEqual([]);
    await expect(
      withTenantTx(support, (tx) => sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (app.tenant_id(), ${uuid()}, 'mls', ${Buffer.from('x')}, 1)`.execute(tx), { db: h.app }),
    ).rejects.toThrow();
    const upd = await withTenantTx(support, async (tx) => (await sql`UPDATE provider_credentials SET external_account_ref = 'x'`.execute(tx)).numAffectedRows, { db: h.app }).catch(() => 0n);
    expect(Number(upd)).toBe(0);
    const del = await withTenantTx(support, async (tx) => (await sql`DELETE FROM provider_credentials`.execute(tx)).numAffectedRows, { db: h.app }).catch(() => 0n);
    expect(Number(del)).toBe(0);
    expect(await suRows(h.su, 'SELECT id FROM provider_credentials WHERE id = ANY($1::uuid[]) AND external_account_ref IS NULL', [credIds])).toHaveLength(2);
  });

  it('an agent and another tenant see nothing', async () => {
    expect(await visible(a.agents[0]!.actor)).toEqual([]);
    expect(await visible(b.owner.actor)).toEqual([]);
    expect(await visible(b.system())).toEqual([]);
  });

  it('the retention sweep (definer, BYPASSRLS) still purges due credentials', async () => {
    await h.su.query("UPDATE provider_credentials SET status = 'revoked', purge_after = now() - interval '1 minute' WHERE id = $1", [credIds[0]]);
    await h.su.query('SELECT app.retention_sweep(now())');
    expect(await suRows<{ status: string; secret_enc: Buffer | null }>(h.su, 'SELECT status, secret_enc FROM provider_credentials WHERE id = $1', [credIds[0]])).toEqual([{ status: 'purged', secret_enc: null }]);
  });
});
