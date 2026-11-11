// pnpm --filter @realty/api exec tsx --conditions=@realty/source src/load/materialize.ts [--db realty_load]
// Applies pending migrations to an existing load database and runs the feed materializer for every member
// (what `pnpm load:seed` does at its end), then ANALYZEs the feed tables. For re-measuring the feed on a seed
// made before the incremental feed existed.
import { createDatabase } from '@realty/db';
import { migrate } from '@realty/db/migrate';
import pg from 'pg';
import { EnvelopeService } from '../crypto/envelope.js';
import { MIGRATIONS_DIR, loadUrls, materializeAll } from './db.js';
import { argValue, kekFromEnv } from './seed.js';

const db = argValue(process.argv.slice(2), 'db') ?? 'realty_load';
const urls = loadUrls(db);
const r = await migrate(urls.ownerUrl, MIGRATIONS_DIR);
console.log(`migrated ${db}: ${r.applied.length} applied`);
const su = new pg.Client({ connectionString: urls.ownerUrl });
await su.connect();
const tenants = (await su.query<{ id: string }>('SELECT id FROM tenants ORDER BY id')).rows.map((x) => x.id);
const database = createDatabase({ url: urls.appUserUrl, max: 2, applicationName: 'load-materialize', statementTimeoutMs: 600_000 });
try {
  for (const x of await materializeAll(database, new EnvelopeService(kekFromEnv()), tenants)) console.log(`feed materialized ${x.tenantId}: ${x.members} members in ${x.ms.toFixed(0)} ms`);
  await su.query('ANALYZE priority_feed_items, feed_groups, feed_dirty');
} finally {
  await database.close();
  await su.end();
}
