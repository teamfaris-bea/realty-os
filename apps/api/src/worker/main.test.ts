// The worker entrypoint boots against a migrated database as app_user, runs its loops, and shuts
// down cleanly on SIGTERM (in-flight jobs finish, the pool closes, exit code 0).
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from '@realty/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
    expect(boot?.kind).toBe('comms.dispatch_stale,consent.drift_check,ownership.drift_check,ownership.followup,storage.blob_delete');
    expect(started.some((l) => l.msg === 'retention sweep')).toBe(true); // the first maintenance pass ran
    expect(started.filter((l) => l.level === 'error')).toEqual([]);
    const code = await new Promise<number | null>((resolve) => {
      if (child.exitCode !== null) return resolve(child.exitCode);
      child.once('exit', (c) => resolve(c));
      child.kill('SIGTERM');
    });
    expect(code).toBe(0);
  }, 50_000);
});
