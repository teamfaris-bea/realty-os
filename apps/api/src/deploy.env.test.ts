// The deploy env templates stay loadable (deploy rehearsal, docs/STAGING.md):
// - deploy/env.staging.example, with its empty secrets filled and its <placeholders> replaced, is a complete
//   fake-provider production configuration (the API, the worker and the metrics listener all accept it);
// - deploy/env.production.example names every variable that production asks for with its chosen vendors.
// The rehearsal found the fake-provider staging refused at start-up: TELEPHONY_WEBHOOK_SECRET and
// EMAIL_WEBHOOK_SECRET were in no template, and DEPLOY §4 called the first optional.
/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';
import { assertNoOwnerCredentials } from './dbRole.js';
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
    expect(vars.get('DATABASE_URL')).toMatch(/<[a-z-]+-password>@<db-host>/);
    // the owner's URL is in deploy/env.owner.example only (batch 5 review F2)
    expect(parseEnvFile('deploy/env.owner.example').get('MIGRATION_DATABASE_URL')).toMatch(/<owner-password>@<db-host>/);
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

const fillStaging = (...args: string[]) => {
  const out = execFileSync('sh', [resolve(repo, 'deploy/fill-staging-env.sh'), ...args], { encoding: 'utf8' });
  const env: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!;
  }
  return env;
};

describe('deploy/fill-staging-env.sh', () => {
  it('prints a loadable staging configuration: every secret generated, every placeholder filled, two runs never share a key', () => {
    const a = fillStaging('staging.example.test', 'postgres');
    const b = fillStaging('staging.example.test', 'postgres');
    expect(Object.values(a).join('\n')).not.toMatch(/<[a-z-]+>/);
    const c = loadConfig(a);
    expect(c.providers).toEqual({ ai: 'fake', telephony: 'fake', email: 'fake', storage: 'local', push: 'fake' });
    expect(c.publicBaseUrl).toBe('https://staging.example.test');
    expect(new URL(a.DATABASE_URL!).username).toBe('app_user');
    expect(new URL(a.DATABASE_URL!).hostname).toBe('postgres');
    for (const k of ['KEK_BASE64', 'SESSION_SECRET_BASE64', 'LEAD_WEBHOOK_SECRET', 'TELEPHONY_WEBHOOK_SECRET', 'EMAIL_WEBHOOK_SECRET', 'METRICS_TOKEN']) {
      expect(a[k], k).toBeTruthy();
      expect(a[k], k).not.toBe(b[k]);
    }
    expect(loadObservabilityConfig(a).metrics).toMatchObject({ port: 9464, host: '0.0.0.0' });
    // batch 5 review F2: the app's file holds no owner credential (the API and the worker refuse to start with one)
    for (const k of OWNER_VARS) expect(a[k], k).toBeUndefined();
    expect(() => assertNoOwnerCredentials(a)).not.toThrow();
  });

  it('`owner` prints the owner file the postgres and release services read: a generated password, the same inside MIGRATION_DATABASE_URL, the <db-host> filled, nothing else', () => {
    const a = fillStaging('staging.example.test', 'postgres', 'owner');
    const b = fillStaging('staging.example.test', 'postgres', 'owner');
    expect(Object.keys(a).sort()).toEqual([...OWNER_VARS].sort());
    expect(Object.values(a).join('\n')).not.toMatch(/<[a-z-]+>/);
    expect(a.POSTGRES_OWNER_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
    expect(a.POSTGRES_OWNER_PASSWORD).not.toBe(b.POSTGRES_OWNER_PASSWORD);
    const u = new URL(a.MIGRATION_DATABASE_URL!);
    expect([u.username, u.password, u.hostname, u.pathname]).toEqual([a.POSTGRES_OWNER_USER, a.POSTGRES_OWNER_PASSWORD, 'postgres', `/${a.POSTGRES_DB}`]);
    // the app's file of the same run shares no secret with it
    expect(Object.values(fillStaging('staging.example.test', 'postgres')).join('\n')).not.toContain(a.POSTGRES_OWNER_PASSWORD!);
  });
});

/** The database owner's (superuser's) credentials: only the postgres and release services may hold them. */
const OWNER_VARS = ['POSTGRES_OWNER_USER', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_DB', 'MIGRATION_DATABASE_URL'] as const;

function dockerCompose(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe('batch 5 review F2: owner credentials reach only the postgres and release services (docker-compose.prod.yml, DEPLOY §3)', () => {
  const compose = readFileSync(resolve(repo, 'docker-compose.prod.yml'), 'utf8');
  /** a top-level service's block (2-space key, 4-space body), as the security-headers stack test reads it */
  const block = (svc: string) => new RegExp(`^  ${svc}:\\n((?:    .*\\n|\\s*\\n)*)`, 'm').exec(compose)?.[1] ?? '';

  it('the app env templates hold no owner credential; deploy/env.owner.example holds exactly them, with no value', () => {
    for (const f of ['deploy/env.production.example', 'deploy/env.staging.example']) {
      const vars = parseEnvFile(f);
      for (const k of OWNER_VARS) expect(vars.has(k), `${f} ${k}`).toBe(false);
    }
    const owner = parseEnvFile('deploy/env.owner.example');
    expect([...owner.keys()].sort()).toEqual([...OWNER_VARS].sort());
    expect(owner.get('POSTGRES_OWNER_PASSWORD')).toBe('');
    expect(owner.get('MIGRATION_DATABASE_URL')).toBe('postgres://realty_owner:<owner-password>@<db-host>:5432/realty');
  });

  it('the compose file: api, worker and release take the app\'s env file only; the owner URL reaches release, and the owner password postgres, by interpolation from --env-file .env.owner', () => {
    expect(/^x-app: &app\n {2}env_file: \.env\.production\n/m.test(compose)).toBe(true);
    expect(compose).not.toMatch(/env_file:.*\.env\.owner/);
    for (const svc of ['api', 'worker', 'web']) {
      for (const k of [...OWNER_VARS, 'POSTGRES_PASSWORD', '.env.owner']) expect(block(svc), `${svc} ${k}`).not.toContain(k);
    }
    expect(block('release')).toMatch(/^ {6}MIGRATION_DATABASE_URL: \$\{MIGRATION_DATABASE_URL:\?/m);
    expect(block('postgres')).toMatch(/^ {6}POSTGRES_PASSWORD: \$\{POSTGRES_OWNER_PASSWORD:\?/m);
    expect(compose).toMatch(/--env-file \.env\.owner/);
  });

  it.skipIf(!dockerCompose())('rendered by `docker compose config` from the filled templates: api, worker and web carry no owner credential; release carries the owner URL and the app role; postgres the owner password', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realty-compose-'));
    try {
      copyFileSync(resolve(repo, 'docker-compose.prod.yml'), join(dir, 'docker-compose.prod.yml'));
      const app = filled(parseEnvFile('deploy/env.production.example'));
      writeFileSync(join(dir, '.env.production'), Object.entries(app).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      const owner = fillStaging('staging.example.test', 'postgres', 'owner');
      writeFileSync(join(dir, '.env.owner'), Object.entries(owner).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      // compose prefers the shell's variables over --env-file: run it without the test process's own database settings
      const shell = Object.fromEntries(Object.entries(process.env).filter(([k]) => !(OWNER_VARS as readonly string[]).includes(k) && !k.startsWith('POSTGRES_') && k !== 'DATABASE_URL'));
      const out = execFileSync('docker', ['compose', '-f', join(dir, 'docker-compose.prod.yml'), '--env-file', join(dir, '.env.owner'), 'config', '--format', 'json'], { encoding: 'utf8', env: { ...shell, WEB_PORT: '8080' } });
      const services = (JSON.parse(out) as { services: Record<string, { environment?: Record<string, string | null> }> }).services;
      for (const svc of ['api', 'worker', 'web']) {
        const env = services[svc]!.environment ?? {};
        for (const k of [...OWNER_VARS, 'POSTGRES_PASSWORD']) expect(env[k], `${svc} ${k}`).toBeUndefined();
        expect(JSON.stringify(env), svc).not.toContain(owner.POSTGRES_OWNER_PASSWORD!);
      }
      expect(services.api!.environment?.DATABASE_URL).toBe(app.DATABASE_URL);
      expect(services.release!.environment?.MIGRATION_DATABASE_URL).toBe(owner.MIGRATION_DATABASE_URL);
      expect(services.release!.environment?.DATABASE_URL).toBe(app.DATABASE_URL);
      expect(services.postgres!.environment?.POSTGRES_PASSWORD).toBe(owner.POSTGRES_OWNER_PASSWORD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
