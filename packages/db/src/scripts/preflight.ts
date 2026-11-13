// pnpm db:preflight [-- --owner] [--app] [--trial]     (in the api image: node packages/db/dist/scripts/preflight.js …)
//
// Read-only database checks before a release (docs/DEPLOY.md §12, G1 and G2). It never commits a write.
//   --owner  MIGRATION_DATABASE_URL: the owner is superuser or BYPASSRLS (E475); a non-superuser owner has
//            CREATEROLE, CREATE on the database and ADMIN on each existing cluster role (E477); the FORCE-RLS update
//            probe (E476, rolled back); whether a schema CREATE window is open (reported, not closed)
//   --app    DATABASE_URL: the R-DEPLOY-1 app-role checks, with the app's TLS settings (DATABASE_SSL_*)
//   --trial  MIGRATION_DATABASE_URL on a THROWAWAY database: one rolled-back transaction that creates a BYPASSRLS
//            role, grants it to the owner, creates a schema and moves a SECURITY DEFINER function to it, runs the
//            probe and the three CREATE EXTENSIONs of 0001; plus CREATE on the database and server version >= 16
// The default is --owner --app. One line per check (`ok`, `failed: <reason>`, `not checked: <why>`), then
// `preflight ok` or `preflight failed: <n> checks`; exit 0 or 1. It prints no URL, host or password.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { loadRootEnv } from '../dbConfig.js';
import {
  APP_ROLE,
  APP_ROLE_CHECK_SQL,
  type AppRoleProblem,
  type AppRoleRow,
  appRoleProblems,
  connectFailureCode,
  forceRlsProbe,
  inspectCreateWindow,
  inspectOwnerRole,
  ownerCapabilityProblems,
  rlsSubjectMessage,
  sqlstate,
  trialProbe,
} from '../rolePreflight.js';
import { type DatabaseTls, TLS_DISABLED, databaseTlsFromEnv, pgSsl } from '../tls.js';

export interface PreflightIo {
  ownerUrl: string | undefined;
  appUrl: string | undefined;
  tls?: DatabaseTls;
  out: (line: string) => void;
}

type Status = { status: 'ok' } | { status: 'failed'; reason: string } | { status: 'not checked'; why: string };

export async function runPreflight(rawArgv: readonly string[], io: PreflightIo): Promise<number> {
  const argv = rawArgv.filter((a) => a !== '--'); // `pnpm db:preflight -- --trial` passes the separator through
  const known = new Set(['--owner', '--app', '--trial']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) {
    io.out(`preflight failed: unknown option ${unknown[0]} (use --owner, --app, --trial)`);
    return 1;
  }
  const picked = argv.length ? new Set(argv) : new Set(['--owner', '--app']);
  const tls = io.tls ?? TLS_DISABLED;
  let failed = 0;
  const line = (name: string, s: Status) => {
    if (s.status === 'failed') failed++;
    io.out(`${name}: ${s.status === 'ok' ? 'ok' : s.status === 'failed' ? `failed: ${s.reason}` : `not checked: ${s.why}`}`);
  };
  const connect = async (name: string, url: string | undefined, variable: string, ssl: pg.ClientConfig['ssl']): Promise<pg.Client | null> => {
    if (!url) {
      line(name, { status: 'failed', reason: `${variable} is not set` });
      return null;
    }
    const c = new pg.Client({ connectionString: url, ssl, application_name: 'realty-preflight' });
    try {
      await c.connect();
      return c;
    } catch (err) {
      line(name, { status: 'failed', reason: `cannot connect with ${variable}: ${connectFailureCode(err)}` });
      return null;
    }
  };

  if (picked.has('--owner')) {
    const c = await connect('owner connection', io.ownerUrl, 'MIGRATION_DATABASE_URL', pgSsl(tls));
    if (c) {
      try {
        const o = await inspectOwnerRole(c);
        const bound = !o.su && !o.bypass;
        line('owner bypasses row-level security', bound ? { status: 'failed', reason: rlsSubjectMessage(o.role) } : { status: 'ok' });
        if (o.su) line('owner capabilities (CREATEROLE, CREATE on the database, ADMIN on the cluster roles)', { status: 'not checked', why: 'the owner is superuser' });
        else if (bound) line('owner capabilities (CREATEROLE, CREATE on the database, ADMIN on the cluster roles)', { status: 'not checked', why: 'the owner is subject to row-level security' });
        else {
          const p = ownerCapabilityProblems(o);
          line('owner capabilities (CREATEROLE, CREATE on the database, ADMIN on the cluster roles)', p.length ? { status: 'failed', reason: p.join('; ') } : { status: 'ok' });
        }
        const probe = await forceRlsProbe(c);
        line('FORCE-RLS update probe (rolled back)', probe.ok ? { status: 'ok' } : { status: 'failed', reason: probe.reason });
        const w = await inspectCreateWindow(c);
        line('schema CREATE window closed', w.open ? { status: 'failed', reason: 'left open by an earlier run (the release step closes it first)' } : { status: 'ok' });
      } catch (err) {
        line('owner checks', { status: 'failed', reason: `SQLSTATE ${sqlstate(err)}` });
      } finally {
        await c.end().catch(() => {});
      }
    }
  }

  if (picked.has('--app')) {
    const c = await connect('app connection', io.appUrl, 'DATABASE_URL', pgSsl(tls));
    if (c) {
      try {
        const row = (await c.query<AppRoleRow>(APP_ROLE_CHECK_SQL)).rows[0];
        const problems = appRoleProblemsByCheck(row, tls);
        const labels: [AppRoleProblem['check'], string][] = [
          ['rls_bound', 'app role is RLS-bound (not superuser, no BYPASSRLS)'],
          ['login_role', `app logs in as ${APP_ROLE}`],
          ['role_model', 'app role model (no CREATEROLE, CREATEDB, REPLICATION, membership, owned object or schema CREATE)'],
          ['force_rls', 'every public table forces row-level security'],
          ['tenants', 'zero tenants visible without context'],
          ['tls', 'tls'],
        ];
        const rlsFailed = problems.has('rls_bound');
        for (const [check, name] of labels) {
          const p = problems.get(check);
          if (check === 'tls' && tls.mode === 'disable') line(name, { status: 'not checked', why: 'DATABASE_SSL_MODE=disable (staging only)' });
          else if (rlsFailed && check !== 'rls_bound') line(name, { status: 'not checked', why: 'the app role is not RLS-bound' });
          else line(name, p ? { status: 'failed', reason: p } : { status: 'ok' });
        }
      } catch (err) {
        const code = sqlstate(err);
        line('app role checks', code === '42P01' ? { status: 'not checked', why: 'SQLSTATE 42P01: the schema is not migrated yet (run the release step first)' } : { status: 'failed', reason: `SQLSTATE ${code}` });
      } finally {
        await c.end().catch(() => {});
      }
    }
  }

  if (picked.has('--trial')) {
    const c = await connect('owner connection (trial)', io.ownerUrl, 'MIGRATION_DATABASE_URL', pgSsl(tls));
    if (c) {
      try {
        for (const t of await trialProbe(c, randomBytes(5).toString('hex'))) {
          line(`trial: ${t.name}`, t.status === 'ok' ? { status: 'ok' } : t.status === 'failed' ? { status: 'failed', reason: t.detail ?? 'failed' } : { status: 'not checked', why: t.detail ?? '' });
        }
      } catch (err) {
        line('trial', { status: 'failed', reason: `SQLSTATE ${sqlstate(err)}` });
      } finally {
        await c.end().catch(() => {});
      }
    }
  }

  io.out(failed === 0 ? 'preflight ok' : `preflight failed: ${failed} checks`);
  return failed === 0 ? 0 : 1;
}

/** the app-role problems keyed by check (several role-model problems join into one line) */
function appRoleProblemsByCheck(row: AppRoleRow | undefined, tls: DatabaseTls): Map<AppRoleProblem['check'], string> {
  const m = new Map<AppRoleProblem['check'], string>();
  for (const p of appRoleProblems(row, APP_ROLE, tls)) m.set(p.check, m.has(p.check) ? `${m.get(p.check)}; ${p.message}` : p.message);
  return m;
}

const isEntry = process.argv[1] !== undefined && /scripts[\\/]preflight\.(t|j)s$/.test(process.argv[1]);
if (isEntry) {
  loadRootEnv();
  let tls: DatabaseTls;
  try {
    tls = databaseTlsFromEnv(process.env);
  } catch (err) {
    console.log(`database settings: failed: ${(err as Error).message}`);
    console.log('preflight failed: 1 checks');
    process.exit(1);
  }
  const code = await runPreflight(process.argv.slice(2), { ownerUrl: process.env.MIGRATION_DATABASE_URL, appUrl: process.env.DATABASE_URL, tls, out: (l) => console.log(l) });
  process.exit(code);
}
