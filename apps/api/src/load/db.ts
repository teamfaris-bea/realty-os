// Connection helpers for the load tooling (lane scale-250k). The load database is a normal migrated
// Realty OS database with its own name (default realty_load), created from scratch by `pnpm load:seed`.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TenantId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { type Database, withTenantTx } from '@realty/db';
import { migrate } from '@realty/db/migrate';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { recomputeExceptions } from '../accountability/exceptions.js';
import { systemActor } from '../worker/systemActor.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { materializeTenant, membersWithFeedWork } from '../workspace/feedJob.js';
import { runScoreboardRollup } from '../accountability/scoreboardRollup.js';

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/db/migrations');

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export interface LoadUrls {
  adminUrl: string;
  ownerUrl: string;
  appUserUrl: string;
}

export function loadUrls(db: string, env: NodeJS.ProcessEnv = process.env): LoadUrls {
  const owner = env.MIGRATION_DATABASE_URL;
  const app = env.DATABASE_URL;
  if (!owner || !app) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL must be set (run pnpm db:setup)');
  const adminUrl = env.TEST_ADMIN_DATABASE_URL ?? withDb(owner, 'postgres');
  return { adminUrl, ownerUrl: withDb(owner, db), appUserUrl: withDb(app, db) };
}

/** Drops and recreates `db`, then applies every migration as the owner role. */
export async function recreateDatabase(db: string, urls: LoadUrls, log: (s: string) => void): Promise<void> {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(db) || db === 'realty_dev' || db === 'postgres') throw new Error(`refusing to recreate database ${db}`);
  const admin = new pg.Client({ connectionString: urls.adminUrl });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db} TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  const r = await migrate(urls.ownerUrl, MIGRATIONS_DIR);
  log(`migrated ${db}: ${r.applied.length} migrations`);
}

/** Runs the real exception recompute (the 60 s job) once per tenant, as the worker does. */
export async function recomputeAll(database: Database, tenantIds: readonly string[]): Promise<{ tenantId: string; ms: number; upserted: number }[]> {
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const out: { tenantId: string; ms: number; upserted: number }[] = [];
  for (const t of tenantIds) {
    const t0 = performance.now();
    const r = await withTenantTx(systemActor(t as TenantId, 'worker'), (tx, now) => recomputeExceptions(tx, 'tenant', now, ids), { db: database });
    out.push({ tenantId: t, ms: performance.now() - t0, upserted: r.upserted });
  }
  return out;
}

/**
 * Runs the feed materializer (the feed.materialize job, lane perf-misses) for every member with work in each
 * tenant until none is left, as the worker would in the background: each member's feed is materialized in a
 * transaction of its own, as that member.
 */
export async function materializeAll(database: Database, envelope: EnvelopeService, tenantIds: readonly string[]): Promise<{ tenantId: string; ms: number; members: number }[]> {
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const out: { tenantId: string; ms: number; members: number }[] = [];
  for (const t of tenantIds) {
    const t0 = performance.now();
    let members = 0;
    for (;;) {
      const work = await withTenantTx(systemActor(t as TenantId, 'worker'), (tx, now) => membersWithFeedWork(tx, now), { db: database });
      if (work.length === 0) break;
      members += (await materializeTenant(t, work, { db: database, envelope, ids }, Infinity)).length;
    }
    out.push({ tenantId: t, ms: performance.now() - t0, members });
  }
  return out;
}

/**
 * Runs the scoreboard.rollup job (0027) for each tenant until the backfill is done: the first run takes the
 * horizon sample, later runs roll every closed day up to it (as the worker does every 10 min).
 */
export async function rollupAll(database: Database, tenantIds: readonly string[]): Promise<{ tenantId: string; ms: number; days: number }[]> {
  const out: { tenantId: string; ms: number; days: number }[] = [];
  for (const t of tenantIds) {
    const t0 = performance.now();
    let days = 0;
    for (let k = 0; k < 4; k++) {
      const r = await runScoreboardRollup((fn) => withTenantTx(systemActor(t as TenantId, 'worker'), (tx) => fn(tx), { db: database }), { maxCalls: 20 });
      days += r.daysRolled;
      if (k > 0 && r.daysRolled === 0) break;
    }
    out.push({ tenantId: t, ms: performance.now() - t0, days });
  }
  return out;
}
