// Production release step (docs/DEPLOY.md): run ONCE per deploy, before the new api/worker start.
//
//   MIGRATION_DATABASE_URL  owner role (creates roles, owns objects; never used by the app)
//   DATABASE_URL            the app's login: its role is created/aligned as app_user expects
//                           (LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT, member of no role, password from the URL)
//
// Steps: align the app role → apply pending migrations (each in one transaction, checksummed; an edited or
// missing applied migration aborts) → prove the app role is RLS-bound (not superuser, no BYPASSRLS, sees
// zero tenants without context). Unlike `pnpm db:setup` it never writes .env and never creates the database.
// Exit code 0 only when every step passed. Prints no secrets.
import pg from 'pg';
import { MIGRATIONS_DIR, ensureAppUserRole } from '../dbConfig.js';
import { migrate } from '../migrate.js';

async function main(): Promise<void> {
  const ownerUrl = process.env.MIGRATION_DATABASE_URL;
  const appUrl = process.env.DATABASE_URL;
  if (!ownerUrl || !appUrl) throw new Error('MIGRATION_DATABASE_URL and DATABASE_URL must be set');
  const app = new URL(appUrl);
  const appUser = { user: decodeURIComponent(app.username), password: decodeURIComponent(app.password) };
  if (!appUser.user || !appUser.password) throw new Error('DATABASE_URL must carry the app role name and password');
  if (new URL(ownerUrl).username === appUser.user) throw new Error('the owner and the app must be different roles');

  const admin = new pg.Client({ connectionString: ownerUrl });
  await admin.connect();
  try {
    await ensureAppUserRole(admin, appUser, (l) => console.log(l));
  } finally {
    await admin.end();
  }
  const r = await migrate(ownerUrl, MIGRATIONS_DIR, { log: (l) => console.log(l) });
  console.log(`migrations: ${r.applied.length} applied, ${r.alreadyApplied.length} already applied`);

  const c = new pg.Client({ connectionString: appUrl });
  await c.connect();
  try {
    const { rows } = await c.query<{ who: string; su: boolean; bypass: boolean; n: string }>(
      'SELECT current_user AS who, r.rolsuper AS su, r.rolbypassrls AS bypass, (SELECT count(*) FROM tenants) AS n FROM pg_roles r WHERE r.rolname = current_user',
    );
    const x = rows[0];
    if (!x || x.su || x.bypass || x.n !== '0') throw new Error('the app role is not RLS-bound (superuser, BYPASSRLS, or sees tenants without context)');
    console.log(`release ok: app connects as ${x.who}, RLS-bound`);
  } finally {
    await c.end();
  }
}

main().catch((err: unknown) => {
  console.error(`release failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
