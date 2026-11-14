// Batch 15 (module 46 `web/portal` ships): 0091 published platform:portal@2026.11.1 unreviewed with a note whose
// counsel items end "and module 46's client page, which is not shipped yet." The note is the pack's stored record,
// so 0092 rewords it in a new migration: the sentence names module 46's client page as built and its counsel and
// engineering items, only on the unreviewed 2026.11.1 row with no review history. Version, status and review are
// untouched, so the portal stays dark exactly as before; a note that already carries a counsel review is left as it was.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCounselReview } from '../src/counselReview.js';
import { MIGRATIONS_DIR } from '../src/dbConfig.js';
import { listMigrations, migrate } from '../src/migrate.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const THIS_MIGRATION = /_b15_portal_pack_note\.sql$/;
const OLD_SENTENCE = "and module 46's client page, which is not shipped yet.";
const NEW_SENTENCE_START = "and module 46's client page as built (batch 15, ARCHITECTURE §21.57): its VERIFY 1";

interface PackRow {
  key: string;
  version: string;
  status: string;
  reviewed_by_counsel_at: Date | null;
  rules: unknown;
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

const packs = (db: TestDb) =>
  query<PackRow>(db.ownerUrl, 'SELECT key, version, status, reviewed_by_counsel_at, rules, notes FROM jurisdiction_packs ORDER BY key, version');
const portal111 = (rows: PackRow[]) => rows.find((r) => r.key === 'platform:portal' && r.version === '2026.11.1')!;
const cleared = async (db: TestDb) => (await query<{ c: boolean }>(db.ownerUrl, "SELECT app.platform_cleared('platform:portal') AS c"))[0]!.c;

describe("0092: platform:portal@2026.11.1's note names module 46's client page as built, never \"not shipped yet\"", () => {
  let dir: string;
  let fresh: TestDb;
  let reviewed: TestDb;
  let freshBefore: PackRow[];
  let reviewedBefore: PackRow[];

  beforeAll(async () => {
    // two deployments at the migration before this one: one as shipped, one that recorded a counsel review of 2026.11.1
    dir = mkdtempSync(join(tmpdir(), 'realty-migrations-'));
    const all = listMigrations(MIGRATIONS_DIR);
    const at = all.findIndex((m) => THIS_MIGRATION.test(m.name));
    for (const m of all.slice(0, at < 0 ? all.length : at)) copyFileSync(join(MIGRATIONS_DIR, m.name), join(dir, m.name));
    fresh = await createTestDb({ migrationsDir: dir });
    reviewed = await createTestDb({ migrationsDir: dir });
    const out: string[] = [];
    const code = await runCounselReview(
      ['--keys', 'platform:portal@2026.11.1', '--reviewed-on', '2026-11-13', '--reference', 'a test review of the portal pack', '--apply'],
      { url: reviewed.ownerUrl, log: (l) => out.push(l), error: (l) => out.push(l), now: new Date('2026-11-14T12:00:00Z') },
    );
    expect(out.join('\n')).not.toContain('refused');
    expect(code).toBe(0);
    freshBefore = await packs(fresh);
    reviewedBefore = await packs(reviewed);
    expect(portal111(freshBefore).notes).toContain(OLD_SENTENCE);
    expect(portal111(reviewedBefore).notes).toContain(OLD_SENTENCE);
    await migrate(fresh.ownerUrl, MIGRATIONS_DIR);
    await migrate(reviewed.ownerUrl, MIGRATIONS_DIR);
  }, 600_000);
  afterAll(async () => {
    await fresh?.drop();
    await reviewed?.drop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("batch 15: the unreviewed note says module 46's client page ships and names its counsel items (VERIFY 1, VERIFY 2, Q-PORTALWEB-2) and the checks before clearing (VERIFY 4, VERIFY 5); module 45's items and the rest of the note stay", async () => {
    const before = portal111(freshBefore).notes!;
    const notes = portal111(await packs(fresh)).notes!;
    expect(notes).not.toContain('not shipped');
    expect(notes.startsWith(before.slice(0, before.indexOf(OLD_SENTENCE)) + NEW_SENTENCE_START)).toBe(true);
    for (const item of ['module 45', 'VERIFY 1-6', 'Q-PORTAL-16', 'Q-PORTALWEB-2', 'VERIFY 2', 'VERIFY 4', 'VERIFY 5', '"Shared {date}"', 'preview banner', 'VERIFY WITH COUNSEL']) {
      expect(notes, item).toContain(item);
    }
    expect(notes.endsWith('(SECURITY §3). Engineering placeholder. VERIFY WITH COUNSEL.')).toBe(true);
  });

  it('batch 15: only that note changes: version, status, rules and review of every pack stay, and the portal stays dark', async () => {
    const after = await packs(fresh);
    const strip = (rows: PackRow[]) => rows.map((r) => (r.key === 'platform:portal' && r.version === '2026.11.1' ? { ...r, notes: null } : r));
    expect(strip(after)).toEqual(strip(freshBefore));
    expect(after.filter((r) => r.key === 'platform:portal').map((r) => [r.version, r.status, r.reviewed_by_counsel_at])).toEqual([
      ['2026.11.0', 'retired', null],
      ['2026.11.1', 'published', null],
    ]);
    expect(await cleared(fresh)).toBe(false);
  });

  it('batch 15: a 2026.11.1 note that already carries a recorded counsel review is left exactly as it was reviewed (and stays cleared)', async () => {
    expect(await packs(reviewed)).toEqual(reviewedBefore);
    expect(portal111(reviewedBefore).notes).toContain('Counsel review recorded ');
    expect(await cleared(reviewed)).toBe(true);
  });
});
