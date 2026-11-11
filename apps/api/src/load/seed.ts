// pnpm load:seed [--contacts 250000] [--db realty_load]
// Recreates the load database, migrates it, bulk-loads the synthetic data (generate.ts), runs the real
// exception recompute once per tenant (so the exception queue has its derived rows), and ANALYZEs.
import { createDatabase } from '@realty/db';
import pg from 'pg';
import { hashPassword } from '../auth/password.js';
import { localKek } from '../crypto/kek.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { materializeAll, recomputeAll, loadUrls, recreateDatabase, rollupAll } from './db.js';
import { LOAD_PASSWORD, defaultSpec, generateLoad, loadUuid } from './generate.js';

export function argValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  return eq?.slice(name.length + 3);
}

export function kekFromEnv(env: NodeJS.ProcessEnv = process.env) {
  const raw = Buffer.from(env.KEK_BASE64 ?? '', 'base64');
  if (raw.length !== 32) throw new Error('KEK_BASE64 must be a 32-byte base64 key (run pnpm db:setup)');
  return localKek(new Uint8Array(raw), env.KEK_REF ?? 'local-kek:v1');
}

export async function seedLoad(o: { db: string; contacts: number; log: (s: string) => void }) {
  const urls = loadUrls(o.db);
  await recreateDatabase(o.db, urls, o.log);
  const spec = defaultSpec(o.contacts, await hashPassword(LOAD_PASSWORD));
  const gen = await generateLoad(urls.ownerUrl, kekFromEnv(), spec, o.log);
  const database = createDatabase({ url: urls.appUserUrl, max: 2, applicationName: 'load-seed', statementTimeoutMs: 600_000 });
  try {
    const rec = await recomputeAll(database, spec.tenants.map((t) => loadUuid(t.slug, 'tenant')));
    for (const r of rec) o.log(`exception recompute ${r.tenantId}: ${r.upserted} items in ${r.ms.toFixed(0)} ms`);
    // the feed.materialize job catching up after the bulk load (every member's first materialization)
    const feed = await materializeAll(database, new EnvelopeService(kekFromEnv()), spec.tenants.map((t) => loadUuid(t.slug, 'tenant')));
    for (const r of feed) o.log(`feed materialized ${r.tenantId}: ${r.members} members in ${r.ms.toFixed(0)} ms`);
    // the scoreboard.rollup job's backfill (0027): every closed day of the window rolled up
    const roll = await rollupAll(database, spec.tenants.map((t) => loadUuid(t.slug, 'tenant')));
    for (const r of roll) o.log(`scoreboard rollup ${r.tenantId}: ${r.days} days in ${r.ms.toFixed(0)} ms`);
    // statistics for the rows the jobs just wrote (the bulk load's ANALYZE ran before them)
    const su = new pg.Client({ connectionString: urls.ownerUrl });
    await su.connect();
    try {
      await su.query('ANALYZE priority_feed_items, feed_groups, feed_dirty, exception_items, scoreboard_activity_daily, scoreboard_speed_daily, scoreboard_rollup_days');
    } finally {
      await su.end();
    }
    return { spec, gen, recompute: rec, feed, roll, urls };
  } finally {
    await database.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  const args = process.argv.slice(2);
  const contacts = Number(argValue(args, 'contacts') ?? 250_000);
  const db = argValue(args, 'db') ?? 'realty_load';
  if (!Number.isInteger(contacts) || contacts < 100) throw new Error('--contacts must be an integer >= 100');
  const t0 = Date.now();
  seedLoad({ db, contacts, log: (s) => console.log(s) })
    .then((r) => {
      console.log(JSON.stringify(r.gen.rows, null, 2));
      console.log(`load:seed done in ${((Date.now() - t0) / 1000).toFixed(0)} s (bulk load ${r.gen.seconds.toFixed(0)} s), anchor ${r.gen.anchor.toISOString()}`);
      console.log(`log in as agent01@load-big.load.test / ${LOAD_PASSWORD}`);
    })
    .catch((e: unknown) => {
      console.error(e);
      process.exitCode = 1;
    });
}
