// Database TLS (H2; docs/DEPLOY.md §12, SECURITY.md): one setting for every production database client.

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
