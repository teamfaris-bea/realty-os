// The exception queue's live counts (lane scale-250k) are now counted by repo.liveCounts instead of
// loading up to 10,000 full queue rows. For every viewer, with and without the owner filter, the counts
// must equal what the queue rows themselves add up to under the same RLS.
import type { Role, TenantId, UserId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { type Database, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listExceptions, recomputeExceptions } from '../accountability/exceptions.js';
import * as repo from '../accountability/repos/exceptions.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { systemActor } from '../worker/systemActor.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const T = loadUuid('load-big', 'tenant') as TenantId;
let db: TestDb;
let app: Database;
let viewers: { userId: string; role: Role }[] = [];

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(9_000, PH);
  spec.tenants = spec.tenants.slice(0, 1);
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  app = createDatabase({ url: db.appUserUrl, max: 2 });
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  await withTenantTx(systemActor(T, 'worker'), (tx, now) => recomputeExceptions(tx, 'tenant', now, ids), { db: app });
  const su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  viewers = (await su.query<{ user_id: string; role: Role }>(`SELECT DISTINCT ON (role) user_id, role FROM memberships WHERE tenant_id = $1 AND role IN ('owner','admin','team_lead','agent','isa') ORDER BY role, user_id`, [T])).rows
    .map((r) => ({ userId: r.user_id, role: r.role }));
  await su.end();
}, 300_000);
afterAll(async () => {
  await app?.close();
  await db?.drop();
});

describe('exception queue counts', () => {
  it('equal the live queue rows for every viewer, with and without the owner filter', async () => {
    const env = new EnvelopeService(kekFromEnv());
    let biggest = 0;
    for (const v of viewers) {
      const actor = { kind: 'user' as const, userId: v.userId as UserId, tenantId: T, role: v.role, sessionId: 'counts-test' };
      for (const owner of [undefined, 'me'] as const) {
        await withTenantTx(actor, async (tx, now) => {
          const rows = await repo.queueRows(tx, { ownerUserId: owner === 'me' ? v.userId : undefined, state: 'live', limit: 100_000 });
          const expected: Record<string, number> = { untouched_lead: 0, overdue_promise: 0, failed_send: 0, missing_outcome: 0 };
          for (const r of rows) expected[r.item_type]! += 1;
          // a type filter forces the counted path even for small queues
          const view = await listExceptions(tx, actor, env, { type: 'failed_send', ...(owner ? { owner } : {}) }, now);
          expect(view.counts.byType, `${v.role} ${owner ?? 'all'}`).toEqual(expected);
          expect(view.counts.live).toBe(rows.length);
          biggest = Math.max(biggest, rows.length);
        }, { db: app });
      }
    }
    // the tenant-wide queue is larger than one page, so the unfiltered view takes the counted path too
    expect(biggest).toBeGreaterThan(200);
  }, 300_000);
});
