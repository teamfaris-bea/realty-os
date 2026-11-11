// Observability settings (lane ops-observability). Read from the same environment map as config.ts, by
// the two entrypoints only (main.ts, worker/main.ts); kept apart from the shared Config so this lane does
// not reshape the platform's schema. Messages name variables, never values.
//
//   METRICS_PORT         serve GET /metrics on this port (empty = no metrics listener)
//   METRICS_HOST         bind address (default 127.0.0.1; anything else requires METRICS_TOKEN)
//   METRICS_TOKEN        shared secret: scrapers send `Authorization: Bearer <token>` (≥ 24 chars;
//                        required in production)
//   ERROR_REPORTING_DSN  Sentry-compatible DSN (https://<key>@<host>/<project>); empty = in-memory fake
//   RELEASE              release tag on metrics and error reports (e.g. the git sha of the image)
//   DEPLOY_ENVIRONMENT   environment tag on error reports (default: NODE_ENV)
import { ConfigError } from '../config.js';

export interface ObservabilityConfig {
  metrics: { port: number; host: string; token: string | null } | null;
  errorReporting: { dsn: string | null; release: string; environment: string };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

export function parseDsn(dsn: string): { endpoint: string; publicKey: string; projectId: string } {
  let u: URL;
  try {
    u = new URL(dsn);
  } catch {
    throw new ConfigError('ERROR_REPORTING_DSN is not a valid URL');
  }
  const projectId = u.pathname.split('/').filter(Boolean).at(-1) ?? '';
  const prefix = u.pathname.split('/').filter(Boolean).slice(0, -1).join('/');
  if (!u.username || !/^\d+$/.test(projectId) || (u.protocol !== 'https:' && u.protocol !== 'http:')) {
    throw new ConfigError('ERROR_REPORTING_DSN must look like https://<public key>@<host>/<project id>');
  }
  return { endpoint: `${u.protocol}//${u.host}/${prefix ? `${prefix}/` : ''}api/${projectId}/envelope/`, publicKey: decodeURIComponent(u.username), projectId };
}

export function loadObservabilityConfig(env: NodeJS.ProcessEnv): ObservabilityConfig {
  const prod = env.NODE_ENV === 'production';
  const problems: string[] = [];
  let metrics: ObservabilityConfig['metrics'] = null;
  const portRaw = (env.METRICS_PORT ?? '').trim();
  if (portRaw !== '') {
    const port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('METRICS_PORT must be a port number');
    const host = (env.METRICS_HOST ?? '').trim() || '127.0.0.1';
    const token = (env.METRICS_TOKEN ?? '').trim() || null;
    if (token !== null && token.length < 24) problems.push('METRICS_TOKEN must be at least 24 characters');
    if (token === null && (prod || !LOOPBACK.has(host))) problems.push(prod ? 'METRICS_TOKEN is required in production' : 'METRICS_TOKEN is required when METRICS_HOST is not loopback');
    if (env.API_PORT && Number(env.API_PORT) === port) problems.push('METRICS_PORT must differ from API_PORT (metrics are never served on the public port)');
    metrics = { port, host, token };
  }
  const dsn = (env.ERROR_REPORTING_DSN ?? '').trim() || null;
  if (dsn) {
    try {
      parseDsn(dsn);
    } catch (e) {
      problems.push((e as Error).message);
    }
    if (prod && !dsn.startsWith('https://')) problems.push('ERROR_REPORTING_DSN must be https in production');
  }
  const release = (env.RELEASE ?? '').trim() || 'dev';
  if (!/^[A-Za-z0-9_.+-]{1,64}$/.test(release)) problems.push('RELEASE must be 1-64 characters of letters, digits, _ . + -');
  const environment = (env.DEPLOY_ENVIRONMENT ?? '').trim() || (prod ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development');
  if (problems.length) throw new ConfigError(`observability configuration is invalid: ${problems.join('; ')}`);
  return { metrics, errorReporting: { dsn, release, environment } };
}
