// Batch 5 review F2 (docs/DEPLOY.md §2 "Start-up refusals", §3): the database owner's credentials never reach the
// internet-facing API and worker. docker-compose.prod.yml gave both of them the shared env file that held the
// superuser URL and password, and nothing refused it (assertRlsBoundLogin checks only DATABASE_URL's own role). Under
// NODE_ENV=production both entrypoints now refuse to start, before they read anything else, when an owner credential
// is in their environment, naming the variable and never its value.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OWNER_CREDENTIAL_VARS, assertNoOwnerCredentials } from './dbRole.js';

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
