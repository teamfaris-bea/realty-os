// Database TLS (H2; docs/DEPLOY.md §12, SECURITY.md §2; DATA_MODEL R-DEPLOY-5): one setting for every production
// database client (the api and worker pools, the release step, migrate, counsel-review, KEK rotation, the seed).
//
//   DATABASE_SSL_MODE     verify-full (default under NODE_ENV=production) or disable (default otherwise). Nothing
//                         else: pg treats require/prefer/verify-ca as verify-full unless uselibpqcompat is set, and
//                         no-verify turns verification off, so the two names that mean one thing are the only ones.
//                         disable is refused in production unless ALLOW_FAKE_PROVIDERS=true (staging only).
//   DATABASE_SSL_CA_FILE  optional absolute path to a PEM CA bundle; without it Node's default trust store is used.
//
// The URL must not carry the TLS settings: pg's parsed URL overrides an explicit `ssl` option, and query keys
// override the user and host too (pg-connection-string), so production refuses any query string (E484).
import { readFileSync } from 'node:fs';

export type DatabaseSslMode = 'verify-full' | 'disable';

export interface DatabaseTls {
  mode: DatabaseSslMode;
  /** DATABASE_SSL_CA_FILE: an absolute path (not secret), or null for Node's default trust store */
  caFile: string | null;
  /** the CA file's PEM text (never logged) */
  ca: string | null;
}

export const TLS_DISABLED: DatabaseTls = { mode: 'disable', caFile: null, ca: null };

/**
 * pg's `ssl` option: false, or verified TLS. Never sets servername: pg sets it from the host (connection.js), and
 * checks the certificate against that host.
 */
export function pgSsl(tls: DatabaseTls): false | { rejectUnauthorized: true; ca?: string } {
  if (tls.mode === 'disable') return false;
  return tls.ca ? { rejectUnauthorized: true, ca: tls.ca } : { rejectUnauthorized: true };
}

/**
 * E483: the libpq-style variables present (non-empty) in `env`. pg reads `PG` + KEY for any setting the URL lacks
 * (PGUSER, PGHOST, PGPASSWORD, PGSSLMODE, PGOPTIONS, PGPASSFILE, …; pg connection-parameters.js), so in production
 * one of them could change the login, the host or the TLS mode behind the checked URL. Names only, never values.
 */
export function libpqEnvNames(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.keys(env)
    .filter((k) => /^PG[A-Z][A-Z0-9_]*$/.test(k) && (env[k] ?? '') !== '')
    .sort();
}

const PROD = (env: Readonly<Record<string, string | undefined>>) => env.NODE_ENV === 'production';
const TRUE = (v: string | undefined) => v === 'true' || v === '1';

/**
 * The database TLS settings from `env`, and every problem with them (names only, never values; E485 E483). The
 * problems list is empty when the settings are usable. Pure apart from reading the CA file.
 */
export function databaseTlsProblems(env: Readonly<Record<string, string | undefined>>): { tls: DatabaseTls; problems: string[] } {
  const problems: string[] = [];
  const raw = (env.DATABASE_SSL_MODE ?? '').trim();
  let mode: DatabaseSslMode = PROD(env) ? 'verify-full' : 'disable';
  if (raw === 'verify-full' || raw === 'disable') mode = raw;
  else if (raw !== '') problems.push('DATABASE_SSL_MODE must be verify-full or disable (require, prefer, verify-ca and no-verify are refused: pg would not verify, or would verify under another name)');
  const caFile = (env.DATABASE_SSL_CA_FILE ?? '').trim() || null;
  let ca: string | null = null;
  if (caFile) {
    if (!caFile.startsWith('/')) problems.push('DATABASE_SSL_CA_FILE must be an absolute path');
    else {
      try {
        ca = readFileSync(caFile, 'utf8');
        if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
          problems.push('DATABASE_SSL_CA_FILE holds no PEM certificate (no -----BEGIN CERTIFICATE----- block)');
          ca = null;
        }
      } catch {
        problems.push('DATABASE_SSL_CA_FILE is not readable');
      }
    }
  }
  if (PROD(env) && mode === 'disable' && !TRUE(env.ALLOW_FAKE_PROVIDERS)) {
    problems.push('DATABASE_SSL_MODE=disable is refused in production unless ALLOW_FAKE_PROVIDERS=true (a staging stack whose database is on the same host)');
  }
  if (PROD(env)) {
    const libpq = libpqEnvNames(env);
    if (libpq.length) problems.push(`libpq variables must not be set in production (pg reads them in place of the database URL's own settings): remove ${libpq.join(', ')}`);
  }
  return { tls: { mode, caFile, ca: mode === 'verify-full' ? ca : null }, problems };
}

/** A refusal of the database TLS or URL settings (names only). */
export class DatabaseTlsError extends Error {
  override name = 'DatabaseTlsError';
}

/**
 * For the CLIs (release, preflight, migrate, counsel-review, KEK rotation): the TLS settings, after the production
 * URL-shape checks of `urlVars`. Throws DatabaseTlsError listing every problem.
 */
export function databaseTlsFromEnv(env: Readonly<Record<string, string | undefined>>, urlVars: readonly string[] = ['DATABASE_URL', 'MIGRATION_DATABASE_URL']): DatabaseTls {
  const { tls, problems } = databaseTlsProblems(env);
  if (PROD(env)) {
    for (const k of urlVars) {
      const v = env[k];
      if (v) {
        const p = databaseUrlShapeProblem(v, k);
        if (p) problems.push(p);
      }
    }
  }
  if (problems.length) throw new DatabaseTlsError(`database settings refused: ${problems.join('; ')}`);
  return tls;
}

/**
 * E484: a production database URL is postgres:// or postgresql:// with no query string and no fragment (a query key
 * overrides the user, the host and the TLS settings: `?user=other` logs in as other, `?sslmode=no-verify` turns
 * verification off). No host or database name is required. Returns the problem (naming `name`, never the value).
 */
export function databaseUrlShapeProblem(url: string, name: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return `${name} must be a postgres:// URL`;
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') return `${name} must be a postgres:// or postgresql:// URL`;
  if (url.includes('?') || url.includes('#')) return `${name} must not carry a query string or fragment in production (query keys override the user, host and TLS settings): use DATABASE_SSL_MODE and DATABASE_SSL_CA_FILE`;
  return null;
}

export function assertDatabaseUrlShape(url: string, name: string): void {
  const p = databaseUrlShapeProblem(url, name);
  if (p) throw new DatabaseTlsError(p);
}
