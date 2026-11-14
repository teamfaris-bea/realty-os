// Batch 14 round 2, Q-PORTAL-19 (module 45; owner decision D11; the batch 14 review's F1, db-security): counsel's
// review reported on 2026-11-12 was of 0018's platform:portal placeholder, before module 45 was built, and module 45
// lists counsel items "before platform:portal is cleared". The conservative path, as 0084 did for
// platform:ai_isa_seller_data: 0091 retires platform:portal@2026.11.0 and publishes 2026.11.1 unreviewed, so a
// review recorded on 2026.11.0 (DEPLOY's D11 command, before this batch) can never clear the module-45 portal, and
// DEPLOY's D11 command names six keys. The doc check ties DEPLOY's pinned keys to the migrations: every
// `platform:<name>@<version>` DEPLOY gives the counsel-review command is the published version in a fresh database.
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCounselReview } from '../src/counselReview.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const THIS_MIGRATION = /_b14_round2_portal\.sql$/;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const deploy = readFileSync(resolve(repo, 'docs/DEPLOY.md'), 'utf8');
const D11_REFERENCE = 'counsel review reported by the owner, 2026-11-12 (owner decision D11)';

interface PackRow {
  key: string;
  version: string;
  status: string;
  reviewed_by_counsel_at: Date | null;
  notes: string | null;
}

async function query<T extends pg.QueryResultRow>(url: string, q: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows;
  } finally {
    await c.end();
  }
}

async function run(url: string, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCounselReview(argv, { url, log: (l) => out.push(l), error: (l) => err.push(l), now: new Date('2026-11-14T12:00:00Z') });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

/** The `--keys` lists of DEPLOY's D11 block (from "Owner decision D11" to the D10 outreach paragraph). */
function d11Block(): string {
  const start = deploy.indexOf('**Owner decision D11');
  const end = deploy.indexOf('The D10 outreach clearance', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return deploy.slice(start, end);
}

describe('Q-PORTAL-19: platform:portal@2026.11.1 ships unreviewed; a review recorded on 2026.11.0 clears nothing (0091)', () => {
  let dir: string;
  let db: TestDb;

  beforeAll(async () => {
    // a deployment at the migration before this one that ran DEPLOY's old seven-key D11 command, portal key included
    dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const all = listMigrations(MIGRATIONS_DIR);
    const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
    for (const m of all.slice(0, at < 0 ? all.length : at)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
    db = await createTestDb({ migrationsDir: dir });
    const recorded = await run(db.ownerUrl, ['--keys', 'platform:portal@2026.11.0', '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply']);
    expect(recorded.err).toBe('');
    expect(recorded.code).toBe(0);
    expect((await query<{ c: boolean }>(db.ownerUrl, "SELECT app.platform_cleared('platform:portal') AS c"))[0]!.c).toBe(true);
    await migrate(db.ownerUrl, MIGRATIONS_DIR);
  }, 600_000);
  afterAll(async () => {
    await db?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('Q-PORTAL-19 D11: after 0091 the recorded 2026.11.0 is retired with its record kept, 2026.11.1 is published unreviewed with the module 45 counsel items in its notes, and the portal is not cleared', async () => {
    const rows = await query<PackRow>(db.ownerUrl, "SELECT key, version, status, reviewed_by_counsel_at, notes FROM jurisdiction_packs WHERE key = 'platform:portal' ORDER BY version");
    expect(rows.map((r) => [r.version, r.status, r.reviewed_by_counsel_at?.toISOString() ?? null])).toEqual([
      ['2026.11.0', 'retired', '2026-11-12T00:00:00.000Z'],
      ['2026.11.1', 'published', null],
    ]);
    expect(rows[0]!.notes).toContain('Counsel review recorded ');
    const notes = rows[1]!.notes!;
    for (const item of ['module 45', 'VERIFY 1-6', 'Q-PORTAL-16', 'module 46', 'VERIFY WITH COUNSEL']) expect(notes, item).toContain(item);
    expect(notes).not.toContain('Counsel review recorded');
    expect((await query<{ c: boolean }>(db.ownerUrl, "SELECT app.platform_cleared('platform:portal') AS c"))[0]!.c).toBe(false);
  });

  it('Q-PORTAL-19 D11: the old D11 pin platform:portal@2026.11.0 is refused (retired), naming 2026.11.1 as needing its own counsel review; nothing changes', async () => {
    const before = await query<PackRow>(db.ownerUrl, 'SELECT key, version, status, reviewed_by_counsel_at, notes FROM jurisdiction_packs ORDER BY key, version');
    const r = await run(db.ownerUrl, ['--revoke', '--keys', 'platform:portal@2026.11.0', '--reference', 'x']);
    expect(r.code).toBe(1);
    const again = await run(db.ownerUrl, ['--keys', 'platform:portal@2026.11.0', '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply']);
    expect(again.code).toBe(1);
    expect(again.err).toContain(
      'platform:portal@2026.11.0 is not the published version 2026.11.1: 2026.11.0 is retired, so the version counsel reviewed is no longer the published one; 2026.11.1 needs its own counsel review',
    );
    expect(await query<PackRow>(db.ownerUrl, 'SELECT key, version, status, reviewed_by_counsel_at, notes FROM jurisdiction_packs ORDER BY key, version')).toEqual(before);
  });

  it('Q-PORTAL-19 (doc check): DEPLOY\'s D11 commands name no platform:portal key and its table row does not say the portal is cleared; every pinned key DEPLOY gives the counsel-review command is the published version, and the six D11 keys pass a dry run', async () => {
    const block = d11Block();
    expect(block).not.toMatch(/platform:portal@/);
    const row = block.split('\n').find((l) => l.startsWith('| The client portal |'));
    expect(row).toBeDefined();
    const after = row!.split('|')[3]!.trim();
    expect(after).not.toMatch(/^cleared/);
    expect(after).toContain('Q-PORTAL-19');

    const lists = [...block.matchAll(/--keys (\S+)/g)].map((m) => m[1]!);
    expect(lists.length).toBe(2);
    for (const list of lists) expect(list.split(',').length).toBe(6);
    const published = new Map(
      (await query<PackRow>(db.ownerUrl, "SELECT key, version, status, reviewed_by_counsel_at, notes FROM jurisdiction_packs WHERE status = 'published'")).map((p) => [p.key, p.version]),
    );
    const pins = [...new Set([...deploy.matchAll(/platform:[a-z_]+@\d{4}\.\d{2}\.\d+/g)].map((m) => m[0]))];
    expect(pins.length).toBeGreaterThan(6);
    for (const pinned of pins) {
      const [key, version] = pinned.split('@') as [string, string];
      expect(published.get(key), pinned).toBe(version);
    }
    const dry = await run(db.ownerUrl, ['--keys', lists[0]!, '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE]);
    expect(dry.err).toBe('');
    expect(dry.code).toBe(0);
    expect(dry.out).toContain('dry run: 6 would be recorded');
  });

  it('b15 (b14 low h, doc check): ARCHITECTURE §21.56 scopes "no function, policy or grant changes" to section 1 of 0091, whose section 2 replaces four definers', () => {
    const arch = readFileSync(resolve(repo, 'docs/ARCHITECTURE.md'), 'utf8');
    const start = arch.indexOf('### 21.56 ');
    const section = arch.slice(start, arch.indexOf('\n### ', start + 1));
    expect(start).toBeGreaterThan(0);
    expect(section).not.toMatch(/(^|[.)] )No function, policy or grant changes\./m);
    expect(section).toMatch(/Section 1 of `0091` changes no function, policy or grant/);
    expect(section).toMatch(/section 2 \(B14-OWN-1\) replaces four definers/);
    // and the migration says the same of itself
    const mig = readFileSync(resolve(repo, 'packages/db/migrations/0091_b14_round2_portal.sql'), 'utf8');
    expect(mig).toMatch(/Four\s+--\s+functions are replaced/);
  });
});
