// Database role checks shared by the migration runner, the release step (release.ts), the read-only preflight CLI
// (scripts/preflight.ts) and the API and worker start-up (apps/api/src/dbRole.ts). docs/DEPLOY.md §3 and §12,
// DATA_MODEL R-DEPLOY-1..4.
//
// Why these exist. The migrations assume a superuser owner. A managed Postgres usually gives a non-superuser admin
// role instead. Two things then go wrong silently or late:
//   - an owner that is subject to row-level security (no BYPASSRLS) runs the data backfills of 0032, 0034, 0035
//     and 0045 against FORCE-RLS tables and updates ZERO rows, without an error; and 0001 cannot create the
//     BYPASSRLS definer roles (E475);
//   - a CREATEROLE + BYPASSRLS owner can migrate, but only with ADMIN on the three cluster roles, SET and INHERIT
//     membership in the two definer roles, and CREATE on the schemas for them while function ownership moves
//     (the "CREATE window", opened and closed by the release step around migrate() only).
// Every message names a role, a check or an attribute, never a URL, a password or a host.
import type pg from 'pg';

export const APP_ROLE = 'app_user';
export const DEFINER_ROLES = ['app_definer', 'app_retention'] as const;
export const CLUSTER_ROLES = [APP_ROLE, ...DEFINER_ROLES] as const;
export type ClusterRole = (typeof CLUSTER_ROLES)[number];

/** A refusal of a role check: `check` is a stable label (edge-case id or check name); the message names no secret. */
export class RolePreflightError extends Error {
  override name = 'RolePreflightError';
  constructor(
    readonly check: string,
    message: string,
  ) {
    super(message);
  }
}

/** E475: the owner is neither superuser nor BYPASSRLS. Same wording style as counselReview.ts. */
export function rlsSubjectMessage(role: string): string {
  return `the migration role ${role} is subject to row-level security (not superuser, no BYPASSRLS): migration backfills would update zero rows under FORCE RLS, and 0001 cannot create the BYPASSRLS roles; nothing was applied`;
}

export interface RoleAttrs {
  rolcanlogin: boolean;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolinherit: boolean;
  rolreplication: boolean;
}

export interface ClusterRoleInspection {
  exists: boolean;
  attrs: RoleAttrs | null;
  /** pg_has_role(owner, role, 'MEMBER WITH ADMIN OPTION'): the owner may alter it and grant it */
  admin: boolean;
  /** pg_has_role(owner, role, 'SET') */
  set: boolean;
  /** pg_has_role(owner, role, 'USAGE'): the owner inherits its privileges */
  usage: boolean;
}

export interface OwnerInspection {
  role: string;
  su: boolean;
  bypass: boolean;
  createrole: boolean;
  createdb: boolean;
  replication: boolean;
  /** has_database_privilege(current_database(), 'CREATE') */
  createOnDatabase: boolean;
  ownsDatabase: boolean;
  roles: Record<ClusterRole, ClusterRoleInspection>;
}

const ATTRS = 'rolcanlogin, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole, rolinherit, rolreplication';

/** Reads the owner's attributes and its standing towards the three cluster roles. Read-only. */
export async function inspectOwnerRole(c: pg.ClientBase): Promise<OwnerInspection> {
  const me = (
    await c.query<{ role: string; su: boolean; bypass: boolean; createrole: boolean; createdb: boolean; replication: boolean; create_db: boolean; owns_db: boolean }>(
      `SELECT current_user::text AS role, r.rolsuper AS su, r.rolbypassrls AS bypass, r.rolcreaterole AS createrole,
              r.rolcreatedb AS createdb, r.rolreplication AS replication,
              has_database_privilege(current_database(), 'CREATE') AS create_db,
              (SELECT d.datdba = r.oid FROM pg_database d WHERE d.datname = current_database()) AS owns_db
         FROM pg_roles r WHERE r.rolname = current_user`,
    )
  ).rows[0]!;
  const rows = (
    await c.query<RoleAttrs & { rolname: string; admin: boolean; set: boolean; usage: boolean }>(
      `SELECT rolname, ${ATTRS},
              pg_has_role(current_user, oid, 'MEMBER WITH ADMIN OPTION') AS admin,
              pg_has_role(current_user, oid, 'SET') AS set,
              pg_has_role(current_user, oid, 'USAGE') AS usage
         FROM pg_roles WHERE rolname = ANY ($1::text[])`,
      [[...CLUSTER_ROLES]],
    )
  ).rows;
  const roles = {} as Record<ClusterRole, ClusterRoleInspection>;
  for (const name of CLUSTER_ROLES) {
    const r = rows.find((x) => x.rolname === name);
    roles[name] = r
      ? {
          exists: true,
          attrs: { rolcanlogin: r.rolcanlogin, rolsuper: r.rolsuper, rolbypassrls: r.rolbypassrls, rolcreatedb: r.rolcreatedb, rolcreaterole: r.rolcreaterole, rolinherit: r.rolinherit, rolreplication: r.rolreplication },
          admin: r.admin,
          set: r.set,
          usage: r.usage,
        }
      : { exists: false, attrs: null, admin: false, set: false, usage: false };
  }
  return { role: me.role, su: me.su, bypass: me.bypass, createrole: me.createrole, createdb: me.createdb, replication: me.replication, createOnDatabase: me.create_db, ownsDatabase: me.owns_db === true, roles };
}

/**
 * E477: what a non-superuser BYPASSRLS owner lacks to run the release step (CREATEROLE, CREATE on the database,
 * ADMIN on each cluster role that already exists). One line per missing item, naming the grant to ask for.
 */
export function ownerCapabilityProblems(o: OwnerInspection): string[] {
  if (o.su) return [];
  const out: string[] = [];
  if (!o.createrole) out.push(`the migration role ${o.role} lacks CREATEROLE: 0001 creates app_user, app_definer and app_retention (ask an administrator to run ALTER ROLE ${o.role} CREATEROLE; VERIFY per provider)`);
  if (!o.createOnDatabase) out.push(`the migration role ${o.role} lacks CREATE on the database: 0001 creates schemas and extensions (ask an administrator to run GRANT CREATE ON DATABASE <database> TO ${o.role}, or make it the database owner)`);
  for (const name of CLUSTER_ROLES) {
    const r = o.roles[name];
    if (r.exists && !r.admin) out.push(`the migration role ${o.role} lacks ADMIN OPTION on the existing role ${name}: it cannot align or grant it (ask an administrator to run GRANT ${name} TO ${o.role} WITH ADMIN OPTION; VERIFY per provider)`);
  }
  return out;
}

/** Runs `fn` inside a savepoint when a transaction is open, else inside its own transaction; always rolled back. */
async function rolledBack<T>(c: pg.ClientBase, inTx: boolean, fn: () => Promise<T>): Promise<T> {
  await c.query(inTx ? 'SAVEPOINT realty_probe' : 'BEGIN');
  try {
    return await fn();
  } finally {
    await c.query(inTx ? 'ROLLBACK TO SAVEPOINT realty_probe' : 'ROLLBACK').catch(() => {});
  }
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/**
 * E476: the FORCE-RLS update probe. In a rolled-back transaction with row_security on: a TEMP table, one row,
 * ENABLE and FORCE row-level security (no policy), UPDATE. A role that bypasses RLS updates 1 row; one that is
 * subject to it updates 0, exactly what the migration backfills would do. An error is reported by SQLSTATE.
 */
export async function forceRlsProbe(c: pg.ClientBase, opts: { inTransaction?: boolean } = {}): Promise<ProbeResult> {
  try {
    const n = await rolledBack(c, opts.inTransaction ?? false, async () => {
      await c.query('SET LOCAL row_security = on');
      await c.query('CREATE TEMP TABLE realty_rls_probe (x int) ON COMMIT DROP');
      await c.query('INSERT INTO realty_rls_probe VALUES (1)');
      await c.query('ALTER TABLE realty_rls_probe ENABLE ROW LEVEL SECURITY');
      await c.query('ALTER TABLE realty_rls_probe FORCE ROW LEVEL SECURITY');
      return (await c.query('UPDATE realty_rls_probe SET x = 2')).rowCount ?? 0;
    });
    return n === 1 ? { ok: true } : { ok: false, reason: `the FORCE-RLS update probe updated ${n} rows, not 1` };
  } catch (err) {
    return { ok: false, reason: `the FORCE-RLS update probe failed: SQLSTATE ${sqlstate(err)}` };
  }
}

export function probeMessage(role: string, reason: string): string {
  return `the migration role ${role} does not bypass row-level security on its own tables (${reason}): migration backfills would update zero rows; nothing was applied`;
}

/** The SQLSTATE of a pg error, or a fixed label; never err.message (it can carry a host name). */
export function sqlstate(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'none';
}

// ---------------------------------------------------------------------------------------------------------------
// The schema CREATE window (non-superuser owner only). ALTER FUNCTION … OWNER TO app_definer needs the new owner to
// hold CREATE on the function's schema; the definer roles hold it only between "window opened" and "window closed",
// which bracket migrate() alone.

const DEFINERS_SQL = `SELECT oid FROM pg_roles WHERE rolname IN ('app_definer', 'app_retention')`;

export interface CreateWindowState {
  /** a default privilege (any granting role) that gives the definer roles CREATE on new schemas */
  defaultAcl: boolean;
  /** schemas on which either definer role holds a direct CREATE grant (aclexplode: PUBLIC's grants are not theirs) */
  schemas: string[];
  open: boolean;
}

export async function inspectCreateWindow(c: pg.ClientBase): Promise<CreateWindowState> {
  const r = (
    await c.query<{ default_acl: boolean; schemas: string[] }>(
      `SELECT EXISTS (SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
                       WHERE d.defaclobjtype = 'n' AND a.privilege_type = 'CREATE' AND a.grantee IN (${DEFINERS_SQL})) AS default_acl,
              coalesce((SELECT array_agg(DISTINCT n.nspname::text ORDER BY n.nspname::text)
                          FROM pg_namespace n, aclexplode(n.nspacl) a
                         WHERE a.privilege_type = 'CREATE' AND a.grantee IN (${DEFINERS_SQL})), '{}') AS schemas`,
    )
  ).rows[0]!;
  return { defaultAcl: r.default_acl, schemas: r.schemas, open: r.default_acl || r.schemas.length > 0 };
}

/** Opens the window: CREATE on future schemas (default privilege) and on each existing schema the owner owns. */
export async function openCreateWindow(c: pg.ClientBase, log: (line: string) => void): Promise<void> {
  await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER GRANT CREATE ON SCHEMAS TO app_definer, app_retention');
  const own = (
    await c.query<{ nspname: string }>(
      `SELECT nspname::text AS nspname FROM pg_namespace
        WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
          AND nspname <> 'realty_migrations' AND nspname <> 'information_schema' AND nspname !~ '^pg_'
        ORDER BY 1`,
    )
  ).rows;
  for (const s of own) await c.query(`GRANT CREATE ON SCHEMA ${c.escapeIdentifier(s.nspname)} TO app_definer, app_retention`);
  log('schema CREATE window opened for app_definer, app_retention');
}

/** Closes the window: revokes the default privilege and every direct CREATE grant either definer role holds. */
export async function closeCreateWindow(c: pg.ClientBase, log: (line: string) => void, line = 'schema CREATE window closed'): Promise<void> {
  await c.query('ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER REVOKE CREATE ON SCHEMAS FROM app_definer, app_retention');
  const { schemas } = await inspectCreateWindow(c);
  for (const s of schemas) await c.query(`REVOKE CREATE ON SCHEMA ${c.escapeIdentifier(s)} FROM app_definer, app_retention`);
  log(line);
}

/**
 * E479: the release step's post-checks (both paths). A SECURITY DEFINER function owned by anyone but the definer
 * roles (outside pg_catalog and information_schema, and not an extension member, so a provider's extension functions
 * are not refused); a definer role holding CREATE on a schema or a default privilege for it; a definer role that can
 * log in, is superuser or lacks BYPASSRLS (0001's check runs only once, when 0001 itself runs).
 */
export async function postReleaseProblems(c: pg.ClientBase): Promise<string[]> {
  const out: string[] = [];
  const fns = (
    await c.query<{ fn: string; owner: string }>(
      `SELECT n.nspname || '.' || p.proname AS fn, r.rolname::text AS owner
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
          AND r.rolname NOT IN ('app_definer', 'app_retention')
        ORDER BY 1 LIMIT 5`,
    )
  ).rows;
  for (const f of fns) out.push(`SECURITY DEFINER function ${f.fn} is owned by ${f.owner}, not app_definer or app_retention`);
  const w = await inspectCreateWindow(c);
  if (w.schemas.length) out.push(`the definer roles still hold CREATE on schema ${w.schemas.join(', ')} (the schema CREATE window is not closed)`);
  if (w.defaultAcl) out.push('a default privilege still gives the definer roles CREATE on new schemas (the schema CREATE window is not closed)');
  const bad = (
    await c.query<{ rolname: string }>(
      `SELECT rolname::text AS rolname FROM pg_roles WHERE rolname IN ('app_definer', 'app_retention') AND (rolcanlogin OR rolsuper OR NOT rolbypassrls) ORDER BY 1`,
    )
  ).rows;
  for (const r of bad) out.push(`${r.rolname} must be NOLOGIN NOSUPERUSER BYPASSRLS`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// R-DEPLOY-1: the app role model, checked by the API and worker at start-up, by the release step over DATABASE_URL
// and by `preflight --app`. One read-only query; app_user can read every catalog it uses (pg_roles, pg_auth_members,
// pg_class, pg_proc, pg_namespace, its own pg_stat_ssl row).

export const NOT_RLS_BOUND = 'DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)';

/** a namespace that is not some session's temporary schema (other sessions' pg_temp_* objects must not refuse start) */
const NOT_TEMP = (col: string) => `${col} !~ '^pg_(toast_)?temp_'`;

export const APP_ROLE_CHECK_SQL = `
SELECT current_user::text AS current_user, session_user::text AS session_user,
       r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
       (SELECT count(*) FROM pg_auth_members am WHERE am.member = r.oid)::int AS memberships,
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE c.relowner = r.oid AND ${NOT_TEMP('n.nspname')})::int AS owned_relations,
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE p.proowner = r.oid AND ${NOT_TEMP('n.nspname')})::int AS owned_functions,
       (SELECT count(*) FROM pg_namespace n WHERE n.nspowner = r.oid AND ${NOT_TEMP('n.nspname')})::int AS owned_schemas,
       coalesce((SELECT array_agg(n.nspname::text ORDER BY n.nspname::text) FROM pg_namespace n
                  WHERE ${NOT_TEMP('n.nspname')} AND has_schema_privilege(n.oid, 'CREATE')), '{}') AS create_schemas,
       (SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
         ORDER BY c.relname LIMIT 1) AS unforced_table,
       (SELECT count(*) FROM tenants)::int AS tenants_visible,
       coalesce((SELECT s.ssl FROM pg_stat_ssl s WHERE s.pid = pg_backend_pid()), false) AS ssl
  FROM pg_roles r WHERE r.rolname = current_user`;

export interface AppRoleRow {
  current_user: string;
  session_user: string;
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  memberships: number;
  owned_relations: number;
  owned_functions: number;
  owned_schemas: number;
  create_schemas: string[];
  unforced_table: string | null;
  tenants_visible: number;
  ssl: boolean;
}

export interface AppRoleProblem {
  /** stable label: rls_bound | login_role (E480) | role_model (E481) | force_rls (E482) | tenants | tls (E486) */
  check: 'rls_bound' | 'login_role' | 'role_model' | 'force_rls' | 'tenants' | 'tls';
  message: string;
}

/**
 * The R-DEPLOY-1 checks over one APP_ROLE_CHECK_SQL row, in their fixed order (the first is the existing
 * NOT_RLS_BOUND refusal, which a superuser login must keep getting first). Pure.
 */
export function appRoleProblems(row: AppRoleRow | undefined, expectedRole: string, tls: { mode: 'verify-full' | 'disable' }): AppRoleProblem[] {
  if (!row || row.rolsuper || row.rolbypassrls) return [{ check: 'rls_bound', message: NOT_RLS_BOUND }];
  const out: AppRoleProblem[] = [];
  if (row.current_user !== expectedRole || row.session_user !== expectedRole) {
    out.push({ check: 'login_role', message: `DATABASE_URL must log in as ${expectedRole} (the migrations grant to that role); it logs in as ${row.session_user}` });
  }
  const attrs = [row.rolcreaterole && 'CREATEROLE', row.rolcreatedb && 'CREATEDB', row.rolreplication && 'REPLICATION'].filter(Boolean);
  const model = (what: string) => ({ check: 'role_model' as const, message: `the app role ${row.current_user} ${what}: it must be NOCREATEROLE NOCREATEDB NOREPLICATION, a member of no role, own nothing and hold CREATE on no schema (role-model check)` });
  if (attrs.length) out.push(model(`has ${attrs.join(', ')}`));
  if (row.memberships > 0) out.push(model(`is a member of ${row.memberships} role(s)`));
  const owned = [row.owned_relations && `${row.owned_relations} relation(s)`, row.owned_functions && `${row.owned_functions} function(s)`, row.owned_schemas && `${row.owned_schemas} schema(s)`].filter(Boolean);
  if (owned.length) out.push(model(`owns ${owned.join(', ')}`));
  if (row.create_schemas.length) out.push(model(`holds CREATE on schema ${row.create_schemas.join(', ')}`));
  if (row.unforced_table) out.push({ check: 'force_rls', message: `public table ${row.unforced_table} does not have ENABLE and FORCE ROW LEVEL SECURITY (every public table must)` });
  if (row.tenants_visible !== 0) out.push({ check: 'tenants', message: 'the app role sees tenants without a tenant context (it must see zero)' });
  if (tls.mode === 'verify-full' && !row.ssl) out.push({ check: 'tls', message: 'database TLS failed (DATABASE_SSL_MODE=verify-full): the session is not encrypted (pg_stat_ssl)' });
  return out;
}

/** The label of a connection failure: err.code, SERVER_NO_SSL for pg's 'N' reply, or CONNECT_FAILED. Never the message. */
export function connectFailureCode(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (typeof e?.message === 'string' && /does not support SSL connections/.test(e.message)) return 'SERVER_NO_SSL';
  return typeof e?.code === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(e.code) ? e.code : 'CONNECT_FAILED';
}

export function tlsFailureMessage(err: unknown): string {
  return `database TLS failed (DATABASE_SSL_MODE=verify-full): ${connectFailureCode(err)}`;
}

// ---------------------------------------------------------------------------------------------------------------
// `preflight --trial` (G1, on a throwaway database): proves, in ONE rolled-back transaction, that the owner can do
// what 0001 and the release step need. Nothing is committed.

export interface TrialCheck {
  name: string;
  status: 'ok' | 'failed' | 'not checked';
  detail?: string;
}

export async function trialProbe(c: pg.ClientBase, suffix: string): Promise<TrialCheck[]> {
  if (!/^[a-z0-9]{4,16}$/.test(suffix)) throw new Error('trial suffix must be 4-16 lowercase letters or digits');
  const name = `realty_probe_${suffix}`;
  const role = c.escapeIdentifier(name);
  const out: TrialCheck[] = [];
  const info = (await c.query<{ v: number; create_db: boolean }>(`SELECT current_setting('server_version_num')::int AS v, has_database_privilege(current_database(), 'CREATE') AS create_db`)).rows[0]!;
  out.push(info.v >= 160000 ? { name: 'server version 16 or later', status: 'ok' } : { name: 'server version 16 or later', status: 'failed', detail: `server_version_num ${info.v}` });
  out.push(info.create_db ? { name: 'CREATE on the database', status: 'ok' } : { name: 'CREATE on the database', status: 'failed', detail: 'has_database_privilege(CREATE) is false' });
  await c.query('BEGIN');
  try {
    let failed: string | null = null;
    const step = async (label: string, sqls: string[]) => {
      if (failed) {
        out.push({ name: label, status: 'not checked', detail: `${failed} failed` });
        return;
      }
      await c.query('SAVEPOINT realty_trial_step');
      try {
        for (const s of sqls) await c.query(s);
        await c.query('RELEASE SAVEPOINT realty_trial_step');
        out.push({ name: label, status: 'ok' });
      } catch (err) {
        await c.query('ROLLBACK TO SAVEPOINT realty_trial_step');
        out.push({ name: label, status: 'failed', detail: `SQLSTATE ${sqlstate(err)}` });
        failed = label;
      }
    };
    await step('create a NOLOGIN BYPASSRLS role', [`CREATE ROLE ${role} NOLOGIN NOSUPERUSER BYPASSRLS NOCREATEDB NOCREATEROLE`]);
    await step('grant it to the owner WITH INHERIT, SET', [`GRANT ${role} TO CURRENT_USER WITH INHERIT TRUE, SET TRUE`]);
    await step('create a schema with CREATE for that role', [`CREATE SCHEMA ${role}`, `GRANT CREATE, USAGE ON SCHEMA ${role} TO ${role}`]);
    await step('move a SECURITY DEFINER function to that role', [
      `CREATE FUNCTION ${role}.probe() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS 'SELECT 1'`,
      `ALTER FUNCTION ${role}.probe() OWNER TO ${role}`,
      `GRANT EXECUTE ON FUNCTION ${role}.probe() TO PUBLIC`,
    ]);
    const probe = await forceRlsProbe(c, { inTransaction: true });
    out.push(probe.ok ? { name: 'FORCE-RLS update probe', status: 'ok' } : { name: 'FORCE-RLS update probe', status: 'failed', detail: probe.reason });
    failed = null;
    for (const ext of ['pgcrypto', 'pg_trgm', 'citext']) await step(`CREATE EXTENSION IF NOT EXISTS ${ext}`, [`CREATE EXTENSION IF NOT EXISTS ${ext}`]).then(() => (failed = null));
  } finally {
    await c.query('ROLLBACK').catch(() => {});
  }
  return out;
}
