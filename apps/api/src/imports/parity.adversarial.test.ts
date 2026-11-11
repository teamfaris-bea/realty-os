// api/import-parity adversarial (PARITY_PLAN §4 critical module 65): tenancy and roles on the parity routes,
// the revert-tags definer, a map that cannot be smuggled past a committed stage, fair-housing field protection,
// and the R-PAR-10 column drop leaving no reader of contacts.tags anywhere in the code.
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { TenantId, UserActor, UserId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BatchView, type ImportWorld, type ImportsHarness, batchOf, call, fubFixture, fullStage, importWorld, importsHarness, mapAgents } from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
let other: ImportWorld;
let b: BatchView;

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
  other = await importWorld(ih);
  const key = `fub-adv-${randomUUID().slice(0, 8)}`;
  ih.fub.add(key, fubFixture({ prefix: 8800, phoneSeed: 8 }));
  const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: key });
  await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`);
  await ih.drain();
  b = await batchOf(w.admin, r.body.batch.id);
}, 180_000);
afterAll(async () => {
  await ih?.close();
});

const actorOf = (c: { tenantId: TenantId | null; userId: UserId | null; role: string | null }): UserActor => ({ kind: 'user', tenantId: c.tenantId as TenantId, userId: c.userId as UserId, role: c.role as UserActor['role'] }) as UserActor;
const body = { stageMap: { 'Waiting On Lender': 'nurture' }, keepStageAsTag: true, fields: {} };

describe('tenancy and roles', () => {
  it('R-TEN-1 R-PERM-5: another tenant\'s Owner/Admin gets 404 on the parity read and write, and nothing changes', async () => {
    expect((await call(other.admin, 'GET', `/imports/${b.id}/parity`)).status).toBe(404);
    expect((await call(other.admin, 'PUT', `/imports/${b.id}/parity`, body)).status).toBe(404);
    expect(((await ih.h.su.query<{ p: unknown }>(`SELECT options->'parity' AS p FROM import_batches WHERE id = $1`, [b.id])).rows[0]!.p)).toBeNull();
  });

  it('R-PERM-13: an agent (no import.run) gets 404; a strict body refuses a tenant id or an unknown stage', async () => {
    expect((await call(w.agents[0]!, 'GET', `/imports/${b.id}/parity`)).status).toBe(404);
    expect((await call(w.agents[0]!, 'PUT', `/imports/${b.id}/parity`, body)).status).toBe(404);
    expect((await call(w.admin, 'PUT', `/imports/${b.id}/parity`, { ...body, tenantId: other.tenantId })).status).toBe(422);
    expect((await call(w.admin, 'PUT', `/imports/${b.id}/parity`, { ...body, stageMap: { Lead: 'archived' } })).status).toBe(422);
    expect((await call(w.admin, 'PUT', `/imports/${b.id}/parity`, { ...body, fields: { customX: { action: 'existing', fieldId: randomUUID() } } })).status).toBe(422);
  });

  it('R-PAR-18: a field label that reads like a protected attribute is refused whatever its spelling (CUSTOM_FIELD_PROTECTED)', async () => {
    for (const label of ['Military status', 'Familial status', 'Has kids', 'Religion']) {
      const r = await call(w.admin, 'PUT', `/imports/${b.id}/parity`, { ...body, fields: { customBirthday: { action: 'create', type: 'text', label } } });
      expect([r.status, r.code]).toEqual([422, 'CUSTOM_FIELD_PROTECTED']);
    }
  });
});

describe('the map cannot change a committed import', () => {
  it('R-PAR-46 R-IMPORT-4: once the contacts stage is committed, the parity map is frozen (IMPORT_STATE_CONFLICT)', async () => {
    await mapAgents(w.admin, b.id, w);
    await fullStage(ih, w.admin, b.id, 'contacts');
    const r = await call(w.admin, 'PUT', `/imports/${b.id}/parity`, { ...body, stageMap: { 'Waiting On Lender': 'lost' } });
    expect([r.status, r.code]).toEqual([409, 'IMPORT_STATE_CONFLICT']);
  }, 60_000);
});

describe('app.import_revert_tags (SECURITY DEFINER)', () => {
  it('R-PAR-46 R-IMPORT-10: deletes nothing for a batch that is not being reverted, for another tenant, or for an agent', async () => {
    const before = (await ih.h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM tags WHERE tenant_id = $1`, [w.tenantId])).rows[0]!.n;
    expect(before).toBeGreaterThan(0);
    // committed (not reverting): nothing
    const n1 = await withTenantTx(actorOf(w.admin), (tx) => sql<{ n: number }>`SELECT app.import_revert_tags(${b.id}::uuid) AS n`.execute(tx), { db: ih.h.app.platform.db });
    expect(n1.rows[0]!.n).toBe(0);
    // another tenant naming this batch: nothing (the batch is not in its tenant)
    await ih.h.su.query(`UPDATE import_batches SET status = 'reverting' WHERE id = $1`, [b.id]);
    await ih.h.su.query(`DELETE FROM contact_tags WHERE import_batch_id = $1`, [b.id]); // so the batch's tags are unused
    const n2 = await withTenantTx(actorOf(other.admin), (tx) => sql<{ n: number }>`SELECT app.import_revert_tags(${b.id}::uuid) AS n`.execute(tx), { db: ih.h.app.platform.db });
    expect(n2.rows[0]!.n).toBe(0);
    // an agent: refused outright
    await expect(withTenantTx(actorOf(w.agents[0]!), (tx) => sql`SELECT app.import_revert_tags(${b.id}::uuid)`.execute(tx), { db: ih.h.app.platform.db })).rejects.toThrow(/IMPORT_REVERT_FORBIDDEN/);
    // a human-made tag is never deleted, even if unused
    const mine = randomUUID();
    await ih.h.su.query(`INSERT INTO tags (tenant_id, id, name, created_by_kind, created_by_user_id) VALUES ($1, $2, 'Mine', 'user', $3)`, [w.tenantId, mine, w.owner.userId]);
    const n3 = await withTenantTx(actorOf(w.admin), (tx) => sql<{ n: number }>`SELECT app.import_revert_tags(${b.id}::uuid) AS n`.execute(tx), { db: ih.h.app.platform.db });
    expect(n3.rows[0]!.n).toBeGreaterThan(0);
    expect((await ih.h.su.query(`SELECT 1 FROM tags WHERE id = $1`, [mine])).rows).toHaveLength(1);
    expect((await ih.h.su.query(`SELECT 1 FROM tags WHERE tenant_id = $1 AND created_by_kind = 'user'`, [w.tenantId])).rows.length).toBeGreaterThan(0);
  });
});

describe('R-PAR-10: contacts.tags is gone and nothing reads it', () => {
  it('R-PAR-10: the column-drop migration leaves no reader: no SQL in apps/ or packages/ source names contacts.tags (grep test)', () => {
    const root = resolve(__dirname, '../../../..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (['node_modules', 'dist', '.git', 'test-results', 'migrations', '__snapshots__'].includes(name)) continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|sql)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          const text = readFileSync(p, 'utf8');
          // SQL only (template literals that read like SQL): contacts.tags / c.tags, a tags column written on
          // contacts, or the old array operations on it; contact_tags and TS objects never match
          for (const lit of text.match(/`[^`]*`/gs) ?? []) {
            if (!/\b(SELECT|INSERT|UPDATE|FROM)\b/.test(lit)) continue;
            if (/\bc\.tags\b|\bcontacts\.tags\b|unnest\(\s*tags\b|\btags\s*\|\||\btags\s*=|INSERT INTO contacts\s*\([^)]*\btags\b/.test(lit)) offenders.push(p.slice(root.length + 1));
          }
        }
      }
    };
    for (const d of ['apps/api/src', 'apps/web/src', 'packages/db/src', 'packages/core/src']) walk(join(root, d));
    expect(offenders).toEqual([]);
  });

  it('R-PAR-10: the database has no contacts.tags column and no index on it', async () => {
    expect((await ih.h.su.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'tags'`)).rows).toEqual([]);
    expect((await ih.h.su.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'contacts_tags_idx'`)).rows).toEqual([]);
  });
});
