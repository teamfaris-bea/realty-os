// The worker entrypoint boots against a migrated database as app_user, runs its loops, and shuts
// down cleanly on SIGTERM (in-flight jobs finish, the pool closes, exit code 0).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '@realty/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handlers } from './handlers/index.js';
import { HandlerRegistry } from './registry.js';

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db?.drop();
});

describe('worker entrypoint', () => {
  it('starts with the build handler list, runs worker + sweeper + maintenance, and exits 0 on SIGTERM', async () => {
    const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=@realty/source', main, '--concurrency', '2'], {
      env: { ...process.env, DATABASE_URL: db.appUserUrl, LOG_LEVEL: 'info', NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (b: Buffer) => (out += b.toString()));
    child.stderr.on('data', (b: Buffer) => (out += b.toString()));
    const until = Date.now() + 30_000;
    while (!/retention sweep/.test(out) && child.exitCode === null && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    const started = out.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const boot = started.find((l) => l.msg === 'starting worker');
    // the entrypoint registers exactly the build handler list (handlers/index.ts)
    expect(boot?.kind).toBe(new HandlerRegistry().registerAll(handlers).kinds().join(','));
    expect(String(boot?.kind).split(',')).toEqual(expect.arrayContaining(['comms.dispatch_stale', 'consent.drift_check', 'ownership.drift_check', 'ownership.followup', 'storage.blob_delete']));
    expect(started.some((l) => l.msg === 'retention sweep')).toBe(true); // the first maintenance pass ran
    expect(started.filter((l) => l.level === 'error')).toEqual([]);
    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (c) => resolve(c));
      child.kill('SIGTERM');
    });
    expect(code).toBe(0);
  }, 50_000);

  it('refuses to start on a superuser login (deploy rehearsal: only the API refused one), printing one JSON line that names DATABASE_URL only', async () => {
    const main = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');
    const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=@realty/source', main, '--concurrency', '1'], {
      env: { ...process.env, DATABASE_URL: db.ownerUrl, LOG_LEVEL: 'info', NODE_ENV: 'test' },
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
    expect(out).not.toContain('starting worker');
    const line = JSON.parse(err.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
    expect(line).toMatchObject({ level: 'fatal', msg: 'worker failed to start', type: 'ConfigError', detail: 'DATABASE_URL must be the RLS-bound app role (not superuser, no BYPASSRLS)' });
    expect(err).not.toContain(new URL(db.ownerUrl).password || '\u0000');
  }, 40_000);
});
