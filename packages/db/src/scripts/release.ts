// Production release step (docs/DEPLOY.md §3, §12): run ONCE per deploy, before the new api/worker start.
//
//   MIGRATION_DATABASE_URL  owner role (creates roles, owns objects; never used by the app)
//   DATABASE_URL            the app's login, which must be app_user: its role is created/aligned as 0001 expects
//                           (LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT, member of no role, password from the URL)
//
// What it does, in order, for a superuser and for a non-superuser BYPASSRLS owner: src/release.ts. Unlike
// `pnpm db:setup` it never writes .env and never creates the database. Exit code 0 only when every step passed.
// Prints no secrets.
import { MIGRATIONS_DIR } from '../dbConfig.js';
import { releaseFailure, runRelease } from '../release.js';
import { databaseTlsFromEnv } from '../tls.js';

try {
  await runRelease({
    ownerUrl: process.env.MIGRATION_DATABASE_URL,
    appUrl: process.env.DATABASE_URL,
    dir: MIGRATIONS_DIR,
    // DATABASE_SSL_MODE / DATABASE_SSL_CA_FILE; in production also the URL shape (E484) and no PG* variable (E483)
    tls: databaseTlsFromEnv(process.env),
    log: (l) => console.log(l),
  });
} catch (err) {
  console.error(`release failed: ${releaseFailure(err)}`);
  process.exit(1);
}
