// R-DEPLOY-5 (docs/DATA_MODEL.md §9; DEPLOY §12, SECURITY §2): database TLS for every production client. One mode
// that verifies (verify-full) and one that is off (disable, refused in production without the staging flag); no
// query string in a production URL (pg-connection-string lets ?user=, ?host=, ?sslmode= override the URL and the
// explicit ssl option); no libpq variables in production; and verify-full never falls back to plaintext.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { rootCertificates } from 'node:tls';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionSettings } from '../src/dbConfig.js';
import { type AppRoleRow, appRoleProblems, connectFailureCode, tlsFailureMessage } from '../src/rolePreflight.js';
import { DatabaseTlsError, assertDatabaseUrlShape, databaseTlsFromEnv, databaseTlsProblems, databaseUrlShapeProblem, libpqEnvNames, pgSsl } from '../src/tls.js';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBfakefakefake\n-----END CERTIFICATE-----\n';
let dir: string;
let ca: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'realty-tls-'));
  ca = join(dir, 'ca.pem');
  writeFileSync(ca, PEM);
  writeFileSync(join(dir, 'not-a-cert.pem'), 'hello\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const prod = { NODE_ENV: 'production' };

describe('R-DEPLOY-5: DATABASE_SSL_MODE and DATABASE_SSL_CA_FILE', () => {
  it('R-DEPLOY-5 E485: verify-full by default in production, disable by default elsewhere; the CA file is read when absolute, readable and PEM', () => {
    expect(databaseTlsProblems(prod)).toEqual({ tls: { mode: 'verify-full', caFile: null, ca: null }, problems: [] });
    expect(databaseTlsProblems({ NODE_ENV: 'test' })).toEqual({ tls: { mode: 'disable', caFile: null, ca: null }, problems: [] });
    expect(databaseTlsProblems({})).toMatchObject({ tls: { mode: 'disable' }, problems: [] });
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_CA_FILE: ca })).toEqual({ tls: { mode: 'verify-full', caFile: ca, ca: PEM }, problems: [] });
    expect(databaseTlsProblems({ DATABASE_SSL_MODE: 'verify-full' }).tls.mode).toBe('verify-full');
    expect(pgSsl({ mode: 'verify-full', caFile: ca, ca: PEM })).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(pgSsl({ mode: 'verify-full', caFile: null, ca: null })).toEqual({ rejectUnauthorized: true });
    expect(pgSsl({ mode: 'disable', caFile: null, ca: null })).toBe(false);
    // never servername: pg sets it from the host and checks the certificate against it
    expect(JSON.stringify(pgSsl({ mode: 'verify-full', caFile: ca, ca: PEM }))).not.toContain('servername');
  });

  it('R-DEPLOY-5 E485: every refusal names the variable, never the value: other modes, a relative, unreadable or non-PEM CA file, disable in production without the staging flag', () => {
    for (const m of ['require', 'prefer', 'verify-ca', 'no-verify', 'allow', 'VERIFY-FULL']) {
      expect(databaseTlsProblems({ DATABASE_SSL_MODE: m }).problems, m).toEqual([expect.stringMatching(/^DATABASE_SSL_MODE must be verify-full or disable/)]);
    }
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_CA_FILE: 'certs/ca.pem' }).problems).toEqual(['DATABASE_SSL_CA_FILE must be an absolute path']);
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_CA_FILE: join(dir, 'missing.pem') }).problems).toEqual(['DATABASE_SSL_CA_FILE is not readable']);
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_CA_FILE: join(dir, 'not-a-cert.pem') }).problems).toEqual(['DATABASE_SSL_CA_FILE holds no PEM certificate (no -----BEGIN CERTIFICATE----- block)']);
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_MODE: 'disable' }).problems).toEqual([expect.stringMatching(/^DATABASE_SSL_MODE=disable is refused in production unless ALLOW_FAKE_PROVIDERS=true/)]);
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_MODE: 'disable', ALLOW_FAKE_PROVIDERS: 'true' })).toMatchObject({ tls: { mode: 'disable' }, problems: [] });
    expect(databaseTlsProblems({ ...prod, DATABASE_SSL_MODE: 'disable', ALLOW_FAKE_PROVIDERS: 'false' }).problems).toHaveLength(1);
    // all at once
    const all = databaseTlsProblems({ ...prod, DATABASE_SSL_MODE: 'no-verify', DATABASE_SSL_CA_FILE: 'x.pem', PGSSLMODE: 'no-verify' }).problems;
    expect(all).toHaveLength(3);
    expect(all.join('\n')).not.toContain('x.pem');
  });

  it('R-DEPLOY-5 E484: production refuses ?user=, ?host=, ?sslmode=no-verify, ?uselibpqcompat=true, a fragment and a socket: URL; postgres://x passes', () => {
    for (const u of [
      'postgres://app_user:pw@db.example.com:5432/realty?user=other',
      'postgres://app_user:pw@db.example.com:5432/realty?host=evil.example.com',
      'postgres://app_user:pw@db.example.com:5432/realty?sslmode=no-verify',
      'postgres://app_user:pw@db.example.com:5432/realty?uselibpqcompat=true&sslmode=require',
      'postgres://app_user:pw@db.example.com:5432/realty?',
      'postgres://app_user:pw@db.example.com:5432/realty#x',
    ]) {
      const p = databaseUrlShapeProblem(u, 'DATABASE_URL');
      expect(p, u).toMatch(/^DATABASE_URL must not carry a query string or fragment in production/);
      expect(p, u).not.toMatch(/pw|example|other/);
    }
    expect(databaseUrlShapeProblem('socket:/var/run/postgresql?db=realty', 'MIGRATION_DATABASE_URL')).toBe('MIGRATION_DATABASE_URL must be a postgres:// or postgresql:// URL');
    expect(databaseUrlShapeProblem('not a url', 'DATABASE_URL')).toBe('DATABASE_URL must be a postgres:// URL');
    for (const u of ['postgres://x', 'postgresql://app_user:pw@db.example.com/realty', 'postgres://app_user:p%3Fw@db.example.com:5432/realty']) expect(databaseUrlShapeProblem(u, 'DATABASE_URL'), u).toBeNull();
    expect(() => assertDatabaseUrlShape('postgres://a@b/c?user=x', 'DATABASE_URL')).toThrow(DatabaseTlsError);
    // the CLIs: production checks both URLs; outside production a query string is left to the developer
    expect(() => databaseTlsFromEnv({ ...prod, DATABASE_URL: 'postgres://x', MIGRATION_DATABASE_URL: 'postgres://o@h/d?user=app_user' })).toThrow(/MIGRATION_DATABASE_URL must not carry a query string/);
    expect(databaseTlsFromEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://x?sslmode=disable' }).mode).toBe('disable');
  });

  it('R-DEPLOY-5 E483: libpqEnvNames finds PGPASSWORD, PGSSLMODE and PGREPLICATION (non-empty) and ignores POSTGRES_DB; production refuses them by name', () => {
    expect(libpqEnvNames({ PGPASSWORD: 'x', PGSSLMODE: 'no-verify', PGREPLICATION: 'database', POSTGRES_DB: 'realty', PGHOST: '', PG: 'x', PGX: 'y', pgpassword: 'z' })).toEqual(['PGPASSWORD', 'PGREPLICATION', 'PGSSLMODE', 'PGX']);
    const p = databaseTlsProblems({ ...prod, PGPASSWORD: 'secret-0f3a9c' }).problems;
    expect(p).toEqual(["libpq variables must not be set in production (pg reads them in place of the database URL's own settings): remove PGPASSWORD"]);
    expect(databaseTlsProblems({ NODE_ENV: 'development', PGPASSWORD: 'x' }).problems).toEqual([]);
  });
});

describe('R-DEPLOY-5 E486: verify-full never runs a query in plaintext', () => {
  it('E486: a verify-full client against the local test cluster whose certificate the trust anchor does not sign is rejected before any query, named by code without the host; with the default trust store a session that connects is encrypted', async () => {
    const url = new URL(connectionSettings().adminUrl);
    // a trust anchor that did not sign the cluster's certificate (any public root): verification must fail
    const c = new pg.Client({ connectionString: url.href, ssl: pgSsl({ mode: 'verify-full', caFile: '/x', ca: rootCertificates[0]! }) });
    c.on('error', () => {});
    let ran = false;
    const err = await c
      .connect()
      .then(async () => {
        ran = true;
        await c.query('SELECT 1');
      })
      .then(() => null, (e: unknown) => e);
    await c.end().catch(() => {});
    expect(ran).toBe(false);
    const e = err as Error & { code?: string };
    expect(`${e.message} ${String(e.code)}`).toMatch(/does not support SSL|certificate|CERT|self[- ]signed/i);
    const msg = tlsFailureMessage(err);
    expect(msg).toMatch(/^database TLS failed \(DATABASE_SSL_MODE=verify-full\): [A-Za-z0-9_]+$/);
    expect(msg).not.toContain(url.hostname);

    // the default trust store: either refused the same way, or (when this machine trusts the cluster's certificate)
    // an encrypted session; never a plaintext one
    const d = new pg.Client({ connectionString: url.href, ssl: pgSsl({ mode: 'verify-full', caFile: null, ca: null }) });
    d.on('error', () => {});
    const ok = await d.connect().then(() => true, () => false);
    if (ok) expect((await d.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]?.ssl).toBe(true);
    await d.end().catch(() => {});
  }, 30_000);

  it("E486: a server that answers 'N' to the TLS request fails the client (SERVER_NO_SSL), never a plaintext fallback", async () => {
    const server = createServer((sock) => {
      sock.once('data', () => sock.write('N'));
      sock.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const c = new pg.Client({ connectionString: `postgres://app_user:pw@127.0.0.1:${port}/realty`, ssl: { rejectUnauthorized: true } });
    c.on('error', () => {});
    const err = await c.connect().then(() => null, (e: unknown) => e);
    await c.end().catch(() => {});
    server.close();
    expect((err as Error).message).toMatch(/does not support SSL connections/);
    expect(connectFailureCode(err)).toBe('SERVER_NO_SSL');
    expect(tlsFailureMessage(err)).toBe('database TLS failed (DATABASE_SSL_MODE=verify-full): SERVER_NO_SSL');
  });

  it('E486: a session that is not encrypted fails the verify-full app check (pg_stat_ssl), and passes with disable', () => {
    const row: AppRoleRow = { current_user: 'app_user', session_user: 'app_user', rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, memberships: 0, owned_relations: 0, owned_functions: 0, owned_schemas: 0, create_schemas: [], unforced_table: null, tenants_visible: 0, ssl: false };
    expect(appRoleProblems(row, 'app_user', { mode: 'verify-full' })).toEqual([{ check: 'tls', message: 'database TLS failed (DATABASE_SSL_MODE=verify-full): the session is not encrypted (pg_stat_ssl)' }]);
    expect(appRoleProblems(row, 'app_user', { mode: 'disable' })).toEqual([]);
    expect(appRoleProblems({ ...row, ssl: true }, 'app_user', { mode: 'verify-full' })).toEqual([]);
  });
});
