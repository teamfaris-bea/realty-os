-- Cluster roles for restoring a LOGICAL backup (pg_dump) into a NEW Postgres instance (docs/DEPLOY.md §8).
-- Roles are cluster-wide, so pg_dump does not carry them; without them pg_restore fails every ownership and
-- grant statement, and the SECURITY DEFINER functions end up owned by the restoring superuser. Run it as the
-- owner role, on the new instance, BEFORE pg_restore (a physical / PITR restore carries the roles already):
--   psql "$RESTORE_OWNER_URL" -v ON_ERROR_STOP=1 -f deploy/restore-roles.sql
-- It is the role block of packages/db/migrations/0001_init.sql, verbatim (packages/db/test/restore_roles.test.ts
-- fails on drift), and it is idempotent. The release step then gives app_user LOGIN and its password.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    -- NOLOGIN placeholder; real environments: ALTER ROLE app_user LOGIN PASSWORD '...'
    CREATE ROLE app_user NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_definer') THEN
    -- owns ONLY the reviewed SECURITY DEFINER helpers; nothing logs in as it
    CREATE ROLE app_definer NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_retention') THEN
    -- owns ONLY retention/erasure functions; the one role append-only triggers let DELETE
    CREATE ROLE app_retention NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
