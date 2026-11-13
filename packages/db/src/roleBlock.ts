// The cluster-role block of 0001_init.sql: the first DO block that creates app_user, app_definer and app_retention.
// The release step runs it for a non-superuser owner before migrating (so the owner creates the roles and holds
// ADMIN on them), reading it from the migrations directory the image ships (Dockerfile copies the migrations, not
// deploy/). deploy/restore-roles.sql is the same block verbatim (packages/db/test/restore_roles.test.ts).

const ROLE_BLOCK = /DO \$\$\nBEGIN\n {2}IF NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'app_user'\)[\s\S]*?\nEND \$\$;/;

/** The role block of `sql` (0001_init.sql's text). Throws when the block is absent. */
export function roleBlockOf(sql: string): string {
  const m = ROLE_BLOCK.exec(sql);
  if (!m) throw new Error('the cluster-role block of 0001_init.sql was not found (DO $$ … CREATE ROLE app_user … END $$;)');
  return m[0];
}
