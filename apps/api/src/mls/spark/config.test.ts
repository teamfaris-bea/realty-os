// MLS / Spark deployment settings (docs/DEPLOY.md "Spark MLS (read-only)"): nonsecret only, kill switch off by
// default, and an unusable Spark base URL refused at start-up (production included). No token is configuration.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig } from '../../config.js';

const base = (o: Record<string, string | undefined> = {}) => ({
  DATABASE_URL: 'postgres://app_user:pw@db/realty',
  KEK_BASE64: randomBytes(32).toString('base64'),
  SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
  ...o,
});

describe('MLS configuration (MLS_PROVIDER, MLS_LIVE_CALLS, SPARK_*)', () => {
  it('defaults: the fake feed, live calls OFF, sparkapi.com over https with Bearer (VERIFY)', () => {
    const c = loadConfig(base());
    expect(c.mls).toEqual({ provider: 'fake', liveCalls: false, spark: { baseUrl: 'https://sparkapi.com', allowedHosts: ['sparkapi.com'], authScheme: 'Bearer' } });
    expect(loadConfig(base({ MLS_PROVIDER: 'spark' })).mls.liveCalls).toBe(false);
  });

  it('accepts spark with an allow-listed https origin, the OAuth scheme and live calls on', () => {
    const c = loadConfig(base({ MLS_PROVIDER: 'spark', SPARK_API_BASE_URL: 'https://replication.example.com', SPARK_ALLOWED_HOSTS: 'sparkapi.com, replication.example.com', SPARK_AUTH_SCHEME: 'OAuth', MLS_LIVE_CALLS: 'true' }));
    expect(c.mls).toEqual({ provider: 'spark', liveCalls: true, spark: { baseUrl: 'https://replication.example.com', allowedHosts: ['sparkapi.com', 'replication.example.com'], authScheme: 'OAuth' } });
  });

  it('refuses MLS_PROVIDER=spark with a non-https, non-default-port, path-bearing or non-allow-listed base URL, in production too', () => {
    const cases: Record<string, RegExp> = {
      'http://sparkapi.com': /SPARK_API_BASE_URL must be https/,
      'https://sparkapi.com:8443': /SPARK_API_BASE_URL must be https/,
      'https://user:pw@sparkapi.com': /SPARK_API_BASE_URL must be https/,
      'https://sparkapi.com/Reso/OData': /SPARK_API_BASE_URL must be https/,
      'https://sparkapi.com?x=1': /SPARK_API_BASE_URL must be https/,
      'https://169.254.169.254': /SPARK_API_BASE_URL must be https/,
      'https://evil.example.com': /SPARK_API_BASE_URL host must be listed in SPARK_ALLOWED_HOSTS/,
      'not a url': /SPARK_API_BASE_URL must be https/,
    };
    for (const [url, re] of Object.entries(cases)) {
      expect(() => loadConfig(base({ MLS_PROVIDER: 'spark', SPARK_API_BASE_URL: url })), url).toThrow(re);
      expect(() => loadConfig(base({ NODE_ENV: 'production', MLS_PROVIDER: 'spark', SPARK_API_BASE_URL: url })), url).toThrow(ConfigError);
    }
    expect(() => loadConfig(base({ MLS_PROVIDER: 'spark', SPARK_ALLOWED_HOSTS: 'localhost' }))).toThrow(/SPARK_ALLOWED_HOSTS must list lowercase public host names/);
  });

  it('refuses unknown values and never echoes them', () => {
    for (const [k, v] of [
      ['MLS_PROVIDER', 'live'],
      ['SPARK_AUTH_SCHEME', 'Basic'],
      ['MLS_LIVE_CALLS', 'yes-please'],
    ] as const) {
      let msg = '';
      try {
        loadConfig(base({ [k]: v }));
      } catch (e) {
        msg = String(e);
      }
      expect(msg).toContain(k);
      expect(msg).not.toContain(v);
    }
  });

  it('no MLS setting is a credential: the token env names are ignored and the redacted config has no secret', () => {
    const c = loadConfig(base({ MLS_PROVIDER: 'spark', SPARK_ACCESS_TOKEN: 'CANARY-spark-token-DO-NOT-USE-0000', MLS_TOKEN: 'CANARY-spark-token-DO-NOT-USE-0000' }));
    expect(JSON.stringify(c.mls)).not.toContain('CANARY');
    expect(JSON.stringify(redactConfig(c))).not.toContain('CANARY');
    expect(redactConfig(c).mls).toEqual({ provider: 'spark', liveCalls: false, sparkBaseUrl: 'https://sparkapi.com', sparkAuthScheme: 'Bearer' });
  });
});
