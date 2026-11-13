// Batch 5 review F2 (docs/DEPLOY.md §2 "Start-up refusals", §3): the database owner's credentials never reach the
// internet-facing API and worker. docker-compose.prod.yml gave both of them the shared env file that held the
// superuser URL and password, and nothing refused it (assertRlsBoundLogin checks only DATABASE_URL's own role). Under
// NODE_ENV=production both entrypoints now refuse to start, before they read anything else, when an owner credential
// is in their environment, naming the variable and never its value.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { type Database, createDatabase } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NOT_RLS_BOUND, OWNER_CREDENTIAL_VARS, assertAppRoleModel, assertNoOwnerCredentials } from './dbRole.js';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = 'owner-pw-0f3a9c';
const OWNER_URL = `postgres://realty_owner:${SECRET}@postgres:5432/realty`;

describe('F2: owner database credentials never reach the API or the worker (DEPLOY §2, §3)', () => {
  it('under NODE_ENV=production each owner credential is refused (ConfigError naming the variable, never its value); the app role alone passes', () => {
    expect([...OWNER_CREDENTIAL_VARS]).toEqual(['MIGRATION_DATABASE_URL', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_PASSWORD']);
    for (const [k, v] of [['MIGRATION_DATABASE_URL', OWNER_URL], ['POSTGRES_OWNER_PASSWORD', SECRET], ['POSTGRES_PASSWORD', SECRET]] as const) {
      let err: Error | null = null;
      try {
        assertNoOwnerCredentials({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app_user:x@db/realty', [k]: v });
      } catch (e) {
        err = e as Error;
      }
      expect(err?.name, k).toBe('ConfigError');
      expect(err?.message, k).toContain(k);
      expect(err?.message, k).not.toContain(SECRET);
    }
    // all of them at once are all named
    expect(() => assertNoOwnerCredentials({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: OWNER_URL, POSTGRES_OWNER_PASSWORD: SECRET })).toThrow(/MIGRATION_DATABASE_URL, POSTGRES_OWNER_PASSWORD/);
    expect(() => assertNoOwnerCredentials({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app_user:x@db/realty', POSTGRES_OWNER_USER: 'realty_owner', POSTGRES_DB: 'realty' })).not.toThrow();
    // an empty value is not a credential (an operator's leftover `MIGRATION_DATABASE_URL=` line)
    expect(() => assertNoOwnerCredentials({ NODE_ENV: 'production', MIGRATION_DATABASE_URL: '' })).not.toThrow();
  });

  it('outside production (local development and tests run both roles from one .env) nothing is refused', () => {
    for (const env of ['development', 'test', undefined]) expect(() => assertNoOwnerCredentials({ NODE_ENV: env, MIGRATION_DATABASE_URL: OWNER_URL, POSTGRES_PASSWORD: SECRET }), String(env)).not.toThrow();
  });

  it('both entrypoints run the check first, before the configuration, the database or any provider', () => {
    for (const f of ['main.ts', 'worker/main.ts']) {
      const src = readFileSync(join(here, f), 'utf8');
      const body = src.slice(src.indexOf('async function main(): Promise<void> {'));
      const first = body.split('\n').slice(1).find((l) => l.trim() !== '' && !l.trim().startsWith('//'))!;
      expect(first.trim(), f).toBe('assertNoOwnerCredentials(process.env);');
    }
  });

  for (const [name, file, msg] of [['the API', 'main.ts', 'api failed to start'], ['the worker', 'worker/main.ts', 'worker failed to start']] as const) {
    it(`${name} exits 1 at start-up with the owner URL in its environment (NODE_ENV=production), printing one JSON line that names the variable only`, async () => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=@realty/source', join(here, file)], {
        env: { ...process.env, NODE_ENV: 'production', MIGRATION_DATABASE_URL: OWNER_URL, DATABASE_URL: 'postgres://app_user:x@127.0.0.1:1/realty' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (b: Buffer) => (out += b.toString()));
      child.stderr.on('data', (b: Buffer) => (err += b.toString()));
      const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
      const code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
      clearTimeout(timer);
      expect(code).toBe(1);
      const line = JSON.parse(err.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
      expect(line).toMatchObject({ level: 'fatal', msg, type: 'ConfigError' });
      expect(String(line.detail)).toContain('MIGRATION_DATABASE_URL');
      expect(out + err).not.toContain(SECRET);
    }, 40_000);
  }
});

describe('R-DEPLOY-1 E483: libpq variables never reach the api or the worker in production', () => {
  it('E483: PGPASSWORD or PGSSLMODE in a production env is refused, naming it and not its value; with MIGRATION_DATABASE_URL one error names both; outside production nothing is refused; POSTGRES_DB is not a libpq name', () => {
    const err = (env: Record<string, string>) => {
      try {
        assertNoOwnerCredentials({ NODE_ENV: 'production', DATABASE_URL: 'postgres://app_user:x@db/realty', ...env });
        return null;
      } catch (e) {
        return e as Error;
      }
    };
    for (const k of ['PGPASSWORD', 'PGSSLMODE', 'PGHOST', 'PGUSER', 'PGREPLICATION', 'PGOPTIONS']) {
      const e = err({ [k]: 'no-verify-0f3a9c' });
      expect(e?.name, k).toBe('ConfigError');
      expect(e?.message, k).toContain(k);
      expect(e?.message, k).not.toContain('no-verify-0f3a9c');
    }
    const both = err({ MIGRATION_DATABASE_URL: OWNER_URL, PGSSLMODE: 'no-verify' });
    expect(both?.message).toMatch(/remove MIGRATION_DATABASE_URL .*; libpq variables must not be set in production .*: remove PGSSLMODE$/);
    expect(both?.message).not.toContain(SECRET);
    expect(err({ POSTGRES_DB: 'realty', PGX: '' })).toBeNull();
    expect(() => assertNoOwnerCredentials({ NODE_ENV: 'development', PGPASSWORD: SECRET })).not.toThrow();
  });
});

describe('R-DEPLOY-1: the app role model at start-up (assertAppRoleModel)', () => {
  let db: TestDb;
  const handles: Database[] = [];
  const trial = `realty_trial_${process.pid}_login`;
  const password = randomBytes(12).toString('hex');
  const owner = async <T>(fn: (c: pg.Client) => Promise<T>): Promise<T> => {
    const c = new pg.Client({ connectionString: db.ownerUrl });
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const loginAs = (user: string, pw: string) => {
    const u = new URL(db.ownerUrl);
    u.username = user;
    u.password = pw;
    const h = createDatabase({ url: u.href, max: 1 });
    handles.push(h);
    return h;
  };
  const refusal = (h: Database, expected: string) => assertAppRoleModel(h, expected).then(() => null, (e: unknown) => e as Error);

  beforeAll(async () => {
    db = await createTestDb();
    await owner(async (c) => {
      await c.query(`CREATE ROLE ${trial} LOGIN NOINHERIT PASSWORD '${password}'`);
      // what the check reads, as app_user can (tenants through its RLS policies)
      await c.query(`GRANT USAGE ON SCHEMA app TO ${trial}`);
      await c.query(`GRANT SELECT ON tenants TO ${trial}`);
      await c.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${trial}`);
      await c.query(`CREATE SCHEMA realty_trial_s`);
    });
  }, 120_000);
  afterAll(async () => {
    for (const h of handles) await h.close();
    await owner(async (c) => {
      await c.query(`DROP SCHEMA IF EXISTS realty_trial_s CASCADE`);
      await c.query(`DROP OWNED BY ${trial}`);
    }).catch(() => {});
    await db?.drop();
    const admin = new pg.Client({ connectionString: db.ownerUrl.replace(/\/[^/]+$/, '/postgres') });
    await admin.connect();
    await admin.query(`DROP ROLE IF EXISTS ${trial}`);
    await admin.end();
  }, 60_000);

  it('R-DEPLOY-1: app_user on a migrated database passes every check; a superuser login gets the existing NOT_RLS_BOUND refusal first', async () => {
    await expect(assertAppRoleModel(loginAs(new URL(db.appUserUrl).username, decodeURIComponent(new URL(db.appUserUrl).password)))).resolves.toBeUndefined();
    const e = await refusal(createDatabase({ url: db.ownerUrl, max: 1 }), 'app_user');
    expect(e).toMatchObject({ name: 'ConfigError', message: NOT_RLS_BOUND });
  });

  it('R-DEPLOY-1 E480: a non-superuser login that is not the expected role is refused, naming the role it logs in as', async () => {
    const e = await refusal(loginAs(trial, password), 'app_user');
    expect(e).toMatchObject({ name: 'ConfigError', message: `DATABASE_URL must log in as app_user (the migrations grant to that role); it logs in as ${trial}` });
    expect(e?.message).not.toContain(password);
    // the same login, expected: clean
    await expect(assertAppRoleModel(loginAs(trial, password), trial)).resolves.toBeUndefined();
  });

  it('R-DEPLOY-1 E481: the expected role is refused with CREATEDB, with a membership, owning a table, or holding CREATE on a schema; each names the check', async () => {
    const cases: [string, string, string, RegExp][] = [
      ['CREATEDB', `ALTER ROLE ${trial} CREATEDB`, `ALTER ROLE ${trial} NOCREATEDB`, /has CREATEDB: it must be NOCREATEROLE NOCREATEDB NOREPLICATION, .*\(role-model check\)$/],
      ['membership', `GRANT pg_read_all_stats TO ${trial}`, `REVOKE pg_read_all_stats FROM ${trial}`, /is a member of 1 role\(s\)/],
      ['owned table', `CREATE TABLE realty_trial_s.t (id int); ALTER TABLE realty_trial_s.t OWNER TO ${trial}`, `DROP TABLE realty_trial_s.t`, /owns 1 relation\(s\)/],
      ['schema CREATE', `GRANT CREATE ON SCHEMA realty_trial_s TO ${trial}`, `REVOKE CREATE ON SCHEMA realty_trial_s FROM ${trial}`, /holds CREATE on schema realty_trial_s/],
    ];
    for (const [name, apply, undo, msg] of cases) {
      await owner((c) => c.query(apply));
      try {
        const e = await refusal(loginAs(trial, password), trial);
        expect(e?.name, name).toBe('ConfigError');
        expect(e?.message, name).toMatch(msg);
      } finally {
        await owner((c) => c.query(undo));
      }
    }
    await expect(assertAppRoleModel(loginAs(trial, password), trial)).resolves.toBeUndefined();
  });

  it('R-DEPLOY-1 E486: under verify-full a TLS connect failure becomes the named ConfigError, by code, without the host or password', async () => {
    // a trust anchor that did not sign the local cluster's certificate: verification fails before any query
    const u = new URL(db.appUserUrl);
    const h = createDatabase({ url: u.href, max: 1, ssl: { rejectUnauthorized: true, ca: rootCertificates[0]! } });
    handles.push(h);
    const e = await assertAppRoleModel(h, 'app_user', { mode: 'verify-full' }).then(() => null, (x: unknown) => x as Error);
    expect(e?.name).toBe('ConfigError');
    expect(e?.message).toMatch(/^database TLS failed \(DATABASE_SSL_MODE=verify-full\): [A-Za-z0-9_]+$/);
    expect(e?.message).not.toContain(u.hostname);
    expect(e?.message).not.toContain(decodeURIComponent(u.password));
  });

  it('R-DEPLOY-1 E482: a public table without FORCE ROW LEVEL SECURITY makes start-up refuse, naming the table', async () => {
    await owner((c) => c.query('ALTER TABLE contacts NO FORCE ROW LEVEL SECURITY'));
    try {
      const e = await refusal(loginAs(new URL(db.appUserUrl).username, decodeURIComponent(new URL(db.appUserUrl).password)), 'app_user');
      expect(e).toMatchObject({ name: 'ConfigError', message: 'public table contacts does not have ENABLE and FORCE ROW LEVEL SECURITY (every public table must)' });
    } finally {
      await owner((c) => c.query('ALTER TABLE contacts FORCE ROW LEVEL SECURITY'));
    }
  });
});
