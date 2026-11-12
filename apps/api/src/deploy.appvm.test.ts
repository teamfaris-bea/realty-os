// The app-VM production stack (docs/DEPLOY.md §12): docker-compose.app-vm.yml, the settings and secret-reference
// templates in deploy/app-vm/, deploy/render-secrets.sh, the TLS edge (deploy/edge/edge.conf) and the database host's
// examples (deploy/db-host/). The database runs on its own host over verify-full TLS; the owner's credential reaches
// the release profile only (R-DEPLOY-6, E489); secrets are rendered from references into a 0600 file with one
// charset both env-file readers agree on (R-DEPLOY-7, E487), and owner names stay out of the app's file (E488).
/// <reference types="node" />
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string) => readFileSync(resolve(repo, rel), 'utf8');

const COMPOSE = 'docker-compose.app-vm.yml';
const SETTINGS = 'deploy/app-vm/app.settings.example';
const REFS = 'deploy/app-vm/app.secrets.refs.example';
const OWNER_REFS = 'deploy/app-vm/owner.secrets.refs.example';
const RENDER = resolve(repo, 'deploy/render-secrets.sh');

const OWNER_NAMES = ['MIGRATION_DATABASE_URL', 'POSTGRES_OWNER_PASSWORD', 'POSTGRES_PASSWORD', 'POSTGRES_OWNER_USER', 'POSTGRES_DB'];
const SECRET_KEYS = [
  'DATABASE_URL', 'KEK_BASE64', 'SESSION_SECRET_BASE64', 'LEAD_WEBHOOK_SECRET', 'EMAIL_WEBHOOK_SECRET', 'TELEPHONY_WEBHOOK_SECRET',
  'ANTHROPIC_API_KEY', 'VAPID_PRIVATE_KEY', 'TWILIO_AUTH_TOKEN', 'SMTP_PASSWORD', 'EMAIL_WEBHOOK_BASIC_PASSWORD',
  'MAILGUN_WEBHOOK_SIGNING_KEY', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'FUB_SYSTEM_KEY',
];

/** KEY=value lines of an env-style file, in order (comments and blanks skipped); duplicates kept so a test can see them */
function entries(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const line of text.split('\n')) {
    if (/^\s*(#|$)/.test(line)) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) throw new Error(`not KEY=value: ${line}`);
    out.push([m[1]!, m[2]!]);
  }
  return out;
}
const keysOf = (rel: string) => entries(read(rel)).map(([k]) => k);
const mapOf = (rel: string) => new Map(entries(read(rel)));

function dockerCompose(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasCompose = dockerCompose();

// ---------- the renderer, with a fake secret store ----------

interface Store {
  dir: string;
  fetchCmd: string;
  /** stores `value` under `ref` exactly as given (a CLI typically prints one trailing newline) */
  put(ref: string, value: string): void;
}

function makeStore(dir: string): Store {
  const vals = join(dir, 'store');
  mkdirSync(vals, { recursive: true });
  const script = join(dir, 'fake-fetch.sh');
  // a stand-in for the operator's secret store CLI: prints the stored value, or a noisy error for an unknown ref
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'f="$FAKE_STORE/$(printf %s "$1" | tr "/:@." "____")"',
      'if [ -f "$f" ]; then cat "$f"; else echo "FAKE-STORE-ERROR: no secret $1 (store said: hunter2-leak)" >&2; exit 3; fi',
      '',
    ].join('\n'),
  );
  return {
    dir,
    fetchCmd: `sh '${script}'`,
    put: (ref, value) => writeFileSync(join(vals, ref.replace(/[/:@.]/g, '_')), value),
  };
}

interface Result {
  status: number | null;
  stdout: string;
  stderr: string;
}

function render(store: Store, settings: string, refs: string, out: string, env: Record<string, string | undefined> = {}): Result {
  const shell = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'SECRET_FETCH_CMD'));
  const r = spawnSync('sh', [RENDER, settings, refs, out], {
    encoding: 'utf8',
    env: { ...shell, FAKE_STORE: join(store.dir, 'store'), SECRET_FETCH_CMD: store.fetchCmd, ...env } as NodeJS.ProcessEnv,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const b64 = () => randomBytes(32).toString('base64');
const hex = () => randomBytes(32).toString('hex');

/** a test-only value for each secret, every one inside the renderer's charset */
function fakeSecrets(): Record<string, string> {
  return {
    DATABASE_URL: `postgres://app_user:${hex()}@db.example.test:5432/realty`,
    KEK_BASE64: b64(),
    SESSION_SECRET_BASE64: b64(),
    LEAD_WEBHOOK_SECRET: hex(),
    EMAIL_WEBHOOK_SECRET: hex(),
    TELEPHONY_WEBHOOK_SECRET: hex(),
    ANTHROPIC_API_KEY: `sk-test-${hex()}`,
    VAPID_PRIVATE_KEY: randomBytes(32).toString('base64url'),
    TWILIO_AUTH_TOKEN: randomBytes(16).toString('hex'),
    SMTP_PASSWORD: hex(),
    EMAIL_WEBHOOK_BASIC_PASSWORD: hex(),
    MAILGUN_WEBHOOK_SIGNING_KEY: hex(),
    S3_ACCESS_KEY_ID: randomBytes(10).toString('hex').toUpperCase(),
    S3_SECRET_ACCESS_KEY: b64(),
    FUB_SYSTEM_KEY: hex(),
  };
}

const refFor = (k: string) => `test/app/${k.toLowerCase()}`;

/** what an operator does with the refs template: one real reference per line (and the secret stored under it) */
function fillRefs(store: Store, template: string, values: Record<string, string>): string {
  return template.replace(/^([A-Z_][A-Z0-9_]*)=<secret-ref>$/gm, (_m, k: string) => {
    store.put(refFor(k), `${values[k]!}\n`);
    return `${k}=${refFor(k)}`;
  });
}

/** what an operator does with the settings template: fill the values their vendors need, a CA file for the DB */
function fillSettings(template: string, caFile: string): string {
  const fills: Record<string, string> = {
    DATABASE_SSL_CA_FILE: caFile,
    VAPID_PUBLIC_KEY: randomBytes(65).toString('base64url'),
    TWILIO_ACCOUNT_SID: `AC${randomBytes(16).toString('hex')}`,
    TWILIO_PLATFORM_SENDER: '+15005550006',
    SMTP_HOST: 'smtp.example.test',
    EMAIL_SPF_INCLUDE: 'spf.example.test',
    SMTP_USERNAME: 'test-smtp-user',
    EMAIL_WEBHOOK_BASIC_USER: 'test-hook-user',
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'test-region-1',
    FUB_SYSTEM_NAME: 'realty-test',
  };
  return template.replace(/^([A-Z_][A-Z0-9_]*)=(.*)$/gm, (m, k: string) => (k in fills ? `${k}=${fills[k]!}` : m));
}

describe('deploy/app-vm templates (R-DEPLOY-7)', () => {
  const prod = keysOf('deploy/env.production.example');
  const settings = keysOf(SETTINGS);
  const refs = keysOf(REFS);

  it('the settings and the secret references hold exactly the keys of deploy/env.production.example, each key in one file only, none twice', () => {
    expect(new Set(settings).size).toBe(settings.length);
    expect(new Set(refs).size).toBe(refs.length);
    expect(settings.filter((k) => refs.includes(k))).toEqual([]);
    expect([...settings, ...refs].sort()).toEqual([...new Set(prod)].sort());
  });

  it('the refs file names exactly the secret-valued keys, each as <secret-ref>; the owner refs hold MIGRATION_DATABASE_URL only (E488)', () => {
    expect([...refs].sort()).toEqual([...SECRET_KEYS].sort());
    for (const [k, v] of entries(read(REFS))) expect(v, k).toBe('<secret-ref>');
    expect(entries(read(OWNER_REFS))).toEqual([['MIGRATION_DATABASE_URL', '<secret-ref>']]);
    // the optional secrets are named for operators who enable them, never as keys
    expect(read(REFS)).toMatch(/METRICS_TOKEN/);
    expect(read(REFS)).toMatch(/ERROR_REPORTING_DSN/);
  });

  it('the settings are the app VM\'s: production, verify-full TLS with the mounted CA, s3, uniquelocal, every live switch off, no owner or PG* name, no unsafe value', () => {
    const s = mapOf(SETTINGS);
    expect(Object.fromEntries([...s].filter(([k]) => ['NODE_ENV', 'DATABASE_SSL_MODE', 'DATABASE_SSL_CA_FILE', 'STORAGE_PROVIDER', 'STORAGE_DIR', 'TRUST_PROXY'].includes(k)))).toEqual({
      NODE_ENV: 'production',
      DATABASE_SSL_MODE: 'verify-full',
      DATABASE_SSL_CA_FILE: '/run/realty/db-ca.pem',
      STORAGE_PROVIDER: 's3',
      STORAGE_DIR: '/var/lib/realty/storage',
      TRUST_PROXY: 'uniquelocal',
    });
    for (const k of ['MLS_LIVE_CALLS', 'ALLOW_FAKE_PROVIDERS', 'TELEPHONY_LIVE_REQUESTS']) expect(s.get(k), k).toBe('false');
    for (const k of [...settings, ...refs]) {
      expect(OWNER_NAMES.includes(k), k).toBe(false);
      expect(k, k).not.toMatch(/^PG[A-Z][A-Z0-9_]*$/);
    }
    for (const [k, v] of s) expect(v, k).not.toMatch(/[$'"]| #/);
    expect(read(SETTINGS)).toMatch(/AI ISA lane's enable switches go here/);
  });

  it('the templates hold no secret value and no real host', () => {
    for (const rel of [SETTINGS, REFS, OWNER_REFS]) {
      for (const [k, v] of entries(read(rel))) {
        expect(v, `${rel} ${k}`).not.toMatch(/[A-Za-z0-9+=]{20,}/);
        const hosts: string[] = [];
        if (/^[a-z]+:\/\//.test(v)) hosts.push(new URL(v).hostname);
        else if (v.includes('@')) hosts.push(v.slice(v.lastIndexOf('@') + 1));
        else if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(v)) hosts.push(v);
        for (const h of hosts) expect(h, `${rel} ${k}`).toMatch(/^(<[a-z-]+>|(.+\.)?example\.com|.+\.invalid|.+\.test|api|web)$/);
      }
    }
    for (const rel of [COMPOSE, 'deploy/edge/edge.conf', 'deploy/db-host/pg_hba.conf.example', 'deploy/db-host/postgresql.realty.conf.example', SETTINGS, REFS, OWNER_REFS]) {
      const ips = read(rel).match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) ?? [];
      for (const ip of ips) expect(ip, rel).toBe('127.0.0.1');
      expect(read(rel), rel).not.toMatch(/-----BEGIN/);
    }
  });
});

// ---------- docker-compose.app-vm.yml ----------

describe('docker-compose.app-vm.yml: the owner file reaches the release profile only (R-DEPLOY-6, E489)', () => {
  const compose = read(COMPOSE);
  const code = compose.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const block = (svc: string) => new RegExp(`^  ${svc}:\\n((?:    .*\\n|\\s*\\n)*)`, 'm').exec(compose)?.[1] ?? '';

  it('R-DEPLOY-6 E489 static: only release names owner.env (required), no ${...:?} names an owner variable, no postgres service, no storage or named volume, api and worker do not depend on release', () => {
    expect(code).toMatch(/^name: realty$/m);
    const ownerLines = code.split('\n').filter((l) => l.includes('owner.env'));
    expect(ownerLines).toHaveLength(1);
    expect(block('release')).toContain(ownerLines[0]);
    expect(block('release')).toMatch(/owner\.env\n\s+required: true/);
    expect(block('release')).toMatch(/profiles: \[release\]/);
    expect(block('release')).toMatch(/restart: "no"/);
    for (const svc of ['api', 'worker', 'web', 'edge']) {
      expect(block(svc), svc).not.toMatch(/owner|MIGRATION_DATABASE_URL|POSTGRES_/);
      // no depends_on release: `up` never runs the owner's step
      expect(block(svc), svc).not.toMatch(/^\s+(- )?release\b/m);
    }
    const required = [...code.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*):\?/g)].map((m) => m[1]!);
    expect(required.length).toBeGreaterThan(0);
    for (const k of required) {
      expect(OWNER_NAMES.includes(k), k).toBe(false);
      expect(k, k).not.toMatch(/^POSTGRES_/);
    }
    expect(code).not.toMatch(/MIGRATION_DATABASE_URL|POSTGRES_/);
    expect(code).not.toMatch(/^ {2}postgres:/m);
    expect(code).not.toMatch(/image: postgres/);
    expect(code).not.toMatch(/\/var\/lib\/realty\/storage/);
    expect(code).not.toMatch(/^volumes:/m);
    // every service logs through the rotated json-file anchor
    expect(code).toMatch(/^x-logging: &logging\n {2}driver: json-file\n/m);
    for (const svc of ['web', 'edge']) expect(block(svc), svc).toMatch(/logging: \*logging/);
    expect(code).toMatch(/^x-app: &app\n(?: {2}.*\n)*? {2}logging: \*logging/m);
  });

  it.skipIf(!hasCompose)('R-DEPLOY-6 E489 rendered by `docker compose config`: no release service without its profile; with it only release holds MIGRATION_DATABASE_URL; a missing owner file fails the release profile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'realty-appvm-compose-'));
    try {
      const app: Record<string, string> = { ...fakeSecrets(), NODE_ENV: 'production', DATABASE_SSL_MODE: 'verify-full' };
      const owner = `postgres://realty_owner:${hex()}@db.example.test:5432/realty`;
      writeFileSync(join(dir, 'app.env'), Object.entries(app).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
      writeFileSync(join(dir, 'owner.env'), `MIGRATION_DATABASE_URL=${owner}\n`);
      // compose prefers the shell's variables: run it without the test process's own database settings
      const shell = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !OWNER_NAMES.includes(k) && !k.startsWith('POSTGRES_') && !/^PG[A-Z]/.test(k) && k !== 'DATABASE_URL' && !k.startsWith('REALTY_') && !k.startsWith('WEB_')),
      );
      const env = { ...shell, REALTY_ENV_DIR: dir, REALTY_VERSION: 'test-1' } as NodeJS.ProcessEnv;
      type Svc = { environment?: Record<string, string | null>; image?: string };
      const config = (...profiles: string[]) => {
        const args = ['compose', '-f', resolve(repo, COMPOSE), '--project-directory', repo, ...profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'];
        return spawnSync('docker', args, { encoding: 'utf8', env });
      };

      const plain = config();
      expect(plain.status, plain.stderr).toBe(0);
      const base = (JSON.parse(plain.stdout) as { services: Record<string, Svc>; volumes?: unknown }).services;
      expect(Object.keys(base).sort()).toEqual(['api', 'web', 'worker']);

      const all = config('release', 'edge');
      expect(all.status, all.stderr).toBe(0);
      const parsed = JSON.parse(all.stdout) as { services: Record<string, Svc>; volumes?: Record<string, unknown> };
      const services = parsed.services;
      expect(Object.keys(services).sort()).toEqual(['api', 'edge', 'release', 'web', 'worker']);
      expect(Object.keys(parsed.volumes ?? {})).toEqual([]);
      expect(services.release!.environment?.MIGRATION_DATABASE_URL).toBe(owner);
      expect(services.release!.environment?.DATABASE_URL).toBe(app.DATABASE_URL);
      for (const svc of ['api', 'worker', 'web', 'edge']) {
        const e = services[svc]!.environment ?? {};
        expect(e.MIGRATION_DATABASE_URL, svc).toBeUndefined();
        expect(JSON.stringify(e), svc).not.toContain(owner);
      }
      expect(services.api!.environment?.DATABASE_URL).toBe(app.DATABASE_URL);
      expect(services.api!.image).toBe('realty-api:test-1');
      expect(services.web!.image).toBe('realty-web:test-1');

      rmSync(join(dir, 'owner.env'));
      // without the release profile the owner file is not needed (it is removed after the release step)
      expect(config().status).toBe(0);
      const missing = config('release');
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toMatch(/owner\.env/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------- deploy/render-secrets.sh ----------

describe('deploy/render-secrets.sh renders references into a 0600 env file and refuses what either reader would misread (R-DEPLOY-7, E487, E488)', () => {
  let dir: string;
  let store: Store;
  let outDir: string;
  let caFile: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'realty-render-'));
    store = makeStore(dir);
    outDir = join(dir, 'run');
    mkdirSync(outDir);
    chmodSync(outDir, 0o700);
    caFile = join(dir, 'db-ca.pem');
    writeFileSync(caFile, `-----BEGIN CERTIFICATE-----\n${randomBytes(48).toString('base64')}\n-----END CERTIFICATE-----\n`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** a fresh pair of input files; returns their paths */
  const inputs = (name: string, settings: string, refs: string) => {
    const s = join(dir, `${name}.settings`);
    const r = join(dir, `${name}.refs`);
    writeFileSync(s, settings);
    writeFileSync(r, refs);
    return { s, r, out: join(outDir, `${name}.env`) };
  };
  const expectRefused = (res: Result, out: string, needle: RegExp | string) => {
    expect(res.status).toBe(1);
    const lines = res.stderr.trim().split('\n');
    expect(lines, res.stderr).toHaveLength(1);
    expect(lines[0]).toMatch(/^render-secrets: refused: /);
    expect(lines[0]).toMatch(needle);
    expect(res.stdout).toBe('');
    expect(existsSync(out)).toBe(false);
  };

  it('R-DEPLOY-7: the filled templates render to a 0600 file that loadConfig accepts in production, with no value on stdout or stderr and no temp file left', () => {
    const values = fakeSecrets();
    const { s, r, out } = inputs('full', fillSettings(read(SETTINGS), caFile), fillRefs(store, read(REFS), values));
    const res = render(store, s, r, out);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).toBe('');
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).not.toMatch(/^#/m);
    const env = parseEnv(readFileSync(out, 'utf8'));
    for (const [k, v] of Object.entries(values)) expect(env[k], k).toBe(v);
    expect(new URL(env.DATABASE_URL!).search).toBe('');
    expect(Object.keys(env).sort()).toEqual([...new Set(keysOf('deploy/env.production.example'))].sort());
    const c = loadConfig(env);
    expect(c.env).toBe('production');
    expect(c.providers.storage).toBe('s3');
    expect(c.allowFakeProviders).toBe(false);
    expect(c.telephonyLiveRequests).toBe(false);
    expect(c.mls).toMatchObject({ liveCalls: false });
    // a re-render replaces the file in place; only the output is left in the directory
    expect(render(store, s, r, out).status).toBe(0);
    expect(readFileSync(out, 'utf8')).toContain(`KEK_BASE64=${values.KEK_BASE64!}`);
    expect(spawnSync('ls', ['-A', outDir], { encoding: 'utf8' }).stdout.trim()).toBe('full.env');
  });

  it('R-DEPLOY-7 E488: owner mode (`-`) renders MIGRATION_DATABASE_URL alone; anything else in owner mode is refused', () => {
    const url = `postgres://realty_owner:${hex()}@db.example.test:5432/realty`;
    store.put('test/owner/url', `${url}\n`);
    const { r, out } = inputs('owner', '', 'MIGRATION_DATABASE_URL=test/owner/url\n');
    const res = render(store, '-', r, out);
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout + res.stderr).toBe('');
    expect(readFileSync(out, 'utf8')).toBe(`MIGRATION_DATABASE_URL=${url}\n`);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    store.put('test/app/kek', `${b64()}\n`);
    for (const extra of ['KEK_BASE64=test/app/kek\n', 'POSTGRES_OWNER_PASSWORD=test/app/kek\n']) {
      const x = inputs('owner-extra', '', `MIGRATION_DATABASE_URL=test/owner/url\n${extra}`);
      expectRefused(render(store, '-', x.r, x.out), x.out, /E488 .*owner mode/);
    }
    const none = inputs('owner-none', '', '# nothing\n');
    expectRefused(render(store, '-', none.r, none.out), none.out, /E488 .*MIGRATION_DATABASE_URL/);
  });

  it('E487: a fetched value with `$`, a space, a newline or a quote, or an empty one, is refused naming the variable, never the value', () => {
    for (const [i, bad] of ['pa$word\n', 'two words\n', 'line1\nline2\n', "it's\n", 'say"hi"\n', 'x #y\n', '\n', ''].entries()) {
      store.put(`test/bad/${i}`, bad);
      const { s, r, out } = inputs(`bad${i}`, 'NODE_ENV=production\n', `SMTP_PASSWORD=test/bad/${i}\n`);
      const res = render(store, s, r, out);
      expectRefused(res, out, /E487 SMTP_PASSWORD/);
      const shown = bad.replace(/\n$/, '');
      if (shown.length > 1) expect(res.stderr).not.toContain(shown);
    }
  });

  it('E488: an owner credential or a libpq PG* name in the settings or the app refs file is refused', () => {
    store.put('test/any', `${hex()}\n`);
    for (const k of [...OWNER_NAMES, 'PGPASSWORD', 'PGSSLMODE', 'PGHOST']) {
      const a = inputs(`own-r-${k}`, 'NODE_ENV=production\n', `${k}=test/any\n`);
      expectRefused(render(store, a.s, a.r, a.out), a.out, new RegExp(`E488 ${k} `));
      const b = inputs(`own-s-${k}`, `${k}=x\n`, 'SMTP_PASSWORD=test/any\n');
      expectRefused(render(store, b.s, b.r, b.out), b.out, new RegExp(`E488 ${k} `));
    }
  });

  it('R-DEPLOY-7: refuses a group- or other-accessible target directory, an unset SECRET_FETCH_CMD, a key in both files, duplicates, a bad line, an unsafe setting and a bad reference', () => {
    store.put('test/any', `${hex()}\n`);
    for (const mode of [0o750, 0o705, 0o770, 0o777]) {
      const open = join(dir, `open-${mode.toString(8)}`);
      mkdirSync(open, { recursive: true });
      chmodSync(open, mode);
      const { s, r } = inputs('open', 'NODE_ENV=production\n', 'SMTP_PASSWORD=test/any\n');
      const out = join(open, 'app.env');
      expectRefused(render(store, s, r, out), out, /group or others/);
    }
    const ok = inputs('nocmd', 'NODE_ENV=production\n', 'SMTP_PASSWORD=test/any\n');
    expectRefused(render(store, ok.s, ok.r, ok.out, { SECRET_FETCH_CMD: undefined }), ok.out, /SECRET_FETCH_CMD/);
    expectRefused(render(store, ok.s, ok.r, ok.out, { SECRET_FETCH_CMD: '' }), ok.out, /SECRET_FETCH_CMD/);
    const cases: Array<[string, string, string, RegExp]> = [
      ['both', 'SMTP_PASSWORD=x\n', 'SMTP_PASSWORD=test/any\n', /SMTP_PASSWORD is in both/],
      ['dup-s', 'LOG_LEVEL=info\nLOG_LEVEL=debug\n', 'SMTP_PASSWORD=test/any\n', /duplicate key LOG_LEVEL in the settings/],
      ['dup-r', 'NODE_ENV=production\n', 'SMTP_PASSWORD=test/any\nSMTP_PASSWORD=test/any\n', /duplicate key SMTP_PASSWORD in the refs/],
      ['line', 'NODE_ENV=production\njust words\n', 'SMTP_PASSWORD=test/any\n', /settings line 2 is not KEY=value/],
      ['lower', 'node_env=production\n', 'SMTP_PASSWORD=test/any\n', /settings line 1 is not KEY=value/],
      ['export', 'export NODE_ENV=production\n', 'SMTP_PASSWORD=test/any\n', /settings line 1 is not KEY=value/],
      ['dollar', 'SMTP_HOST=${HOST}\n', 'SMTP_PASSWORD=test/any\n', /settings value of SMTP_HOST/],
      ['quote', "SMTP_HOST='smtp.example.test'\n", 'SMTP_PASSWORD=test/any\n', /settings value of SMTP_HOST/],
      ['dquote', 'SMTP_HOST="smtp.example.test"\n', 'SMTP_PASSWORD=test/any\n', /settings value of SMTP_HOST/],
      ['hash', 'LOG_LEVEL=info #debug\n', 'SMTP_PASSWORD=test/any\n', /settings value of LOG_LEVEL/],
      ['ref', 'NODE_ENV=production\n', 'SMTP_PASSWORD=$(id)\n', /reference of SMTP_PASSWORD/],
      ['ref-space', 'NODE_ENV=production\n', 'SMTP_PASSWORD=a b\n', /reference of SMTP_PASSWORD/],
      ['ref-empty', 'NODE_ENV=production\n', 'SMTP_PASSWORD=\n', /reference of SMTP_PASSWORD/],
      ['ref-placeholder', 'NODE_ENV=production\n', 'SMTP_PASSWORD=<secret-ref>\n', /reference of SMTP_PASSWORD/],
    ];
    for (const [name, settings, refs, needle] of cases) {
      const c = inputs(name, settings, refs);
      expectRefused(render(store, c.s, c.r, c.out), c.out, needle);
    }
  });

  it('R-DEPLOY-7: a failed fetch names the variable and the reference, not the store\'s error text; nothing is written', () => {
    store.put('test/good', `${hex()}\n`);
    const { s, r, out } = inputs('fetchfail', 'NODE_ENV=production\n', 'SMTP_PASSWORD=test/good\nS3_SECRET_ACCESS_KEY=test/missing/key\n');
    const res = render(store, s, r, out);
    expectRefused(res, out, /fetch failed for S3_SECRET_ACCESS_KEY \(reference test\/missing\/key\)/);
    expect(res.stderr).not.toMatch(/FAKE-STORE-ERROR|hunter2/);
    expect(spawnSync('ls', ['-A', outDir], { encoding: 'utf8' }).stdout).not.toMatch(/render-secrets/);
  });

  it('R-DEPLOY-7: the reference reaches the fetch command as its last argument, one trailing newline stripped', () => {
    const { s, r, out } = inputs('argv', 'NODE_ENV=production\n', 'SMTP_PASSWORD=test/argv:v1@x\n');
    const res = render(store, s, r, out, { SECRET_FETCH_CMD: "printf 'v-%s\\n'" });
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe('NODE_ENV=production\nSMTP_PASSWORD=v-test/argv:v1@x\n');
  });
});

// ---------- deploy/edge/edge.conf and the database host ----------

describe('deploy/edge/edge.conf: the optional TLS edge (R-DEPLOY-6)', () => {
  const conf = read('deploy/edge/edge.conf');
  const code = conf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

  it('R-DEPLOY-6: HSTS without subdomains, X-Forwarded-For replaced by $remote_addr, no log at all, a 444 default server that rejects unknown TLS names', () => {
    expect(code).toContain('add_header Strict-Transport-Security "max-age=31536000" always;');
    expect(code).not.toMatch(/includeSubDomains|preload/);
    expect(code).toMatch(/proxy_set_header X-Forwarded-For \$remote_addr;/);
    expect(conf).not.toContain('$proxy_add_x_forwarded_for');
    expect(code).toMatch(/proxy_set_header Host \$host;/);
    expect(code).toMatch(/proxy_set_header X-Forwarded-Proto https;/);
    expect(code).toMatch(/^access_log off;$/m);
    expect(code).toMatch(/^error_log \/dev\/null;$/m);
    expect(code).not.toMatch(/access_log (?!off)/);
    expect(code).not.toMatch(/error_log (?!\/dev\/null)/);
    expect(code).not.toMatch(/log_format/);
    for (const m of code.matchAll(/log_format[^;]*;/g)) expect(m[0]).not.toMatch(/\$args|\$request_uri|\$query_string/);
    const dflt = /server \{\n(?:(?!\n\}).)*default_server(?:(?!\n\}).)*\n\}/s.exec(code)?.[0] ?? '';
    expect(dflt).toMatch(/listen 80 default_server;/);
    expect(dflt).toMatch(/listen 443 ssl default_server;/);
    expect(dflt).toMatch(/ssl_reject_handshake on;/);
    expect(dflt).toMatch(/return 444;/);
    expect(code).toMatch(/return 301 https:\/\/\$server_name\$request_uri;/);
    expect(code).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
    expect(code).toMatch(/ssl_certificate \/etc\/realty\/tls\/fullchain\.pem;/);
    expect(code).toMatch(/ssl_certificate_key \/etc\/realty\/tls\/privkey\.pem;/);
    expect(code).toMatch(/client_max_body_size 11m;/);
    expect(code).toMatch(/server_tokens off;/);
    expect(code).toMatch(/proxy_pass http:\/\/web:8080;/);
    expect([...code.matchAll(/server_name ([^;]+);/g)].map((m) => m[1])).toEqual(['app.example.com', 'app.example.com']);
  });
});

describe('deploy/db-host examples: TLS and SCRAM only', () => {
  it('R-DEPLOY-6: pg_hba has hostssl scram-sha-256 lines from the app VM only, no plain host line, no password-less method; the server config turns TLS on', () => {
    const hba = read('deploy/db-host/pg_hba.conf.example');
    const conf = read('deploy/db-host/postgresql.realty.conf.example');
    for (const text of [hba, conf]) {
      expect(text).not.toMatch(/^host /m);
      expect(text).not.toMatch(/trust/);
    }
    const rules = hba.split('\n').filter((l) => !/^\s*(#|$)/.test(l)).map((l) => l.trim().split(/\s+/));
    for (const r of rules) {
      if (r[0] === 'local') expect(r, r.join(' ')).toEqual(['local', 'all', 'postgres', 'peer']);
      else expect(r, r.join(' ')).toEqual(['hostssl', 'realty', r[2], '<app-vm-ip>/32', 'scram-sha-256']);
    }
    expect(rules.filter((r) => r[0] === 'hostssl').map((r) => r[2])).toEqual(['app_user', '<owner-role>']);
    for (const line of ["ssl = on", "ssl_min_protocol_version = 'TLSv1.2'", 'password_encryption = scram-sha-256', "listen_addresses = '<private-ip>'"]) expect(conf).toContain(line);
    expect(conf).toMatch(/^ssl_cert_file = '<[a-z-]+>'$/m);
    expect(conf).toMatch(/^ssl_key_file = '<[a-z-]+>'$/m);
    expect(conf).toMatch(/DEPLOY\.md §12.*PITR/);
  });
});
