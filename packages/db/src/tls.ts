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
