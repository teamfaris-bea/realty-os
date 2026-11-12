// pnpm db:migrate — applies packages/db/migrations/*.sql to MIGRATION_DATABASE_URL (owner role).
import { MIGRATIONS_DIR, loadRootEnv } from '../dbConfig.js';
import { migrate } from '../migrate.js';
import { databaseTlsFromEnv, pgSsl } from '../tls.js';

loadRootEnv();
const url = process.env.MIGRATION_DATABASE_URL;
if (!url) {
  console.error('MIGRATION_DATABASE_URL is not set (copy .env.example to .env, or run pnpm db:setup)');
  process.exit(1);
}
try {
  const r = await migrate(url, MIGRATIONS_DIR, { log: (l) => console.log(l), ssl: pgSsl(databaseTlsFromEnv(process.env, ['MIGRATION_DATABASE_URL'])) });
  console.log(`migrations: ${r.applied.length} applied, ${r.alreadyApplied.length} already applied`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
