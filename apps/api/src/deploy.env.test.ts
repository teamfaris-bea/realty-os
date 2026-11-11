// The deploy env templates stay loadable (deploy rehearsal, docs/STAGING.md):
// - deploy/env.staging.example, with its empty secrets filled and its <placeholders> replaced, is a complete
//   fake-provider production configuration (the API, the worker and the metrics listener all accept it);
// - deploy/env.production.example names every variable that production asks for with its chosen vendors.
// The rehearsal found the fake-provider staging refused at start-up: TELEPHONY_WEBHOOK_SECRET and
// EMAIL_WEBHOOK_SECRET were in no template, and DEPLOY §4 called the first optional.
/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { loadObservabilityConfig } from './observability/config.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function parseEnvFile(rel: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(resolve(repo, rel), 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

const KEYS = new Set(['KEK_BASE64', 'SESSION_SECRET_BASE64']);
/** what an operator does with the template: generate every empty secret, replace every <placeholder> */
function filled(vars: Map<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of vars) {
    if (v === '' && KEYS.has(k)) env[k] = randomBytes(32).toString('base64');
    else if (v === '' && /SECRET|TOKEN|PASSWORD/.test(k)) env[k] = randomBytes(32).toString('hex');
    else env[k] = v.replace(/<staging-host>/g, 'staging.example.test').replace(/<db-host>/g, 'db.example.test').replace(/<[a-z-]+>/g, 'x'.repeat(24));
  }
  return env;
}

describe('deploy/env.staging.example', () => {
  const vars = parseEnvFile('deploy/env.staging.example');

  it('filled in, it is a complete production configuration with every provider fake and MLS live calls off', () => {
    const env = filled(vars);
    const c = loadConfig(env);
    expect(c.env).toBe('production');
    expect(c.allowFakeProviders).toBe(true);
    expect(c.providers).toEqual({ ai: 'fake', telephony: 'fake', email: 'fake', storage: 'local', push: 'fake' });
    expect(c.fub.provider).toBe('fake');
    expect(c.mls).toMatchObject({ provider: 'fake', liveCalls: false });
    expect(c.kekRef).toBe('staging-kek:v1');
    expect(c.cookieSecure).toBe(true);
    expect(loadObservabilityConfig(env).metrics).toMatchObject({ port: 9464 });
  });

  it('holds no value for any secret, and no real host', () => {
    for (const [k, v] of vars) if (/SECRET|TOKEN|PASSWORD|_BASE64$/.test(k)) expect(v, k).toBe('');
    for (const k of ['DATABASE_URL', 'MIGRATION_DATABASE_URL']) expect(vars.get(k)).toMatch(/<[a-z-]+-password>@<db-host>/);
    expect(vars.get('PUBLIC_BASE_URL')).toBe('https://<staging-host>');
  });

  it('every secret it leaves empty is needed: dropping any one of them is refused at start-up', () => {
    const env = filled(vars);
    for (const k of ['LEAD_WEBHOOK_SECRET', 'TELEPHONY_WEBHOOK_SECRET', 'EMAIL_WEBHOOK_SECRET', 'KEK_BASE64', 'SESSION_SECRET_BASE64']) {
      const { [k]: _drop, ...rest } = env;
      expect(() => loadConfig(rest), k).toThrow(ConfigError);
    }
  });
});

describe('deploy/fill-staging-env.sh', () => {
  it('prints a loadable staging configuration: every secret generated, every placeholder filled, two runs never share a key', () => {
    const run = () => {
      const out = execFileSync('sh', [resolve(repo, 'deploy/fill-staging-env.sh'), 'staging.example.test', 'postgres'], { encoding: 'utf8' });
      const env: Record<string, string> = {};
      for (const line of out.split('\n')) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m) env[m[1]!] = m[2]!;
      }
      return env;
    };
    const a = run();
    const b = run();
    expect(Object.values(a).join('\n')).not.toMatch(/<[a-z-]+>/);
    const c = loadConfig(a);
    expect(c.providers).toEqual({ ai: 'fake', telephony: 'fake', email: 'fake', storage: 'local', push: 'fake' });
    expect(c.publicBaseUrl).toBe('https://staging.example.test');
    expect(new URL(a.MIGRATION_DATABASE_URL!).password).toBe(a.POSTGRES_OWNER_PASSWORD);
    expect(new URL(a.DATABASE_URL!).username).toBe('app_user');
    for (const k of ['KEK_BASE64', 'SESSION_SECRET_BASE64', 'LEAD_WEBHOOK_SECRET', 'TELEPHONY_WEBHOOK_SECRET', 'EMAIL_WEBHOOK_SECRET', 'METRICS_TOKEN', 'POSTGRES_OWNER_PASSWORD']) {
      expect(a[k], k).toBeTruthy();
      expect(a[k], k).not.toBe(b[k]);
    }
    expect(loadObservabilityConfig(a).metrics).toMatchObject({ port: 9464, host: '0.0.0.0' });
  });
});

describe('deploy/env.production.example', () => {
  it('names every variable production reports missing for the vendors it selects', () => {
    const vars = parseEnvFile('deploy/env.production.example');
    const env: Record<string, string> = {};
    for (const [k, v] of vars) if (v !== '') env[k] = v;
    env.KEK_BASE64 = randomBytes(32).toString('base64');
    env.SESSION_SECRET_BASE64 = randomBytes(32).toString('base64');
    let msg = '';
    try {
      loadConfig(env);
    } catch (e) {
      msg = (e as Error).message;
    }
    const missing = /missing ([A-Z0-9_, ]+)/.exec(msg)?.[1]?.split(',').map((s) => s.trim()) ?? [];
    expect(missing.length).toBeGreaterThan(0);
    for (const k of missing) expect(vars.has(k), `${k} is required but not in the template`).toBe(true);
    expect(vars.get('MLS_LIVE_CALLS')).toBe('false');
    expect(vars.get('ALLOW_FAKE_PROVIDERS')).toBe('false');
  });
});
