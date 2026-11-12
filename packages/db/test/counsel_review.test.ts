// The operator command that records counsel review of named platform clearance packs on a deployment (R-INT-6;
// owner decision D11). It writes reviewed_by_counsel_at on each named key's published version and appends a dated
// note naming the reported source, as the database owner role only, dry run by default; it never touches
// rules.vendor_ready_at (voice and Gmail also wait for their vendor checks). Packs still ship unreviewed: the
// migrations are unchanged and every pack starts NULL in a fresh database (asserted below).
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runCounselReview } from '../src/counselReview.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

const script = join(dirname(fileURLToPath(import.meta.url)), '../src/scripts/counsel-review.ts');

const D11_KEYS = [
  'platform:fair_housing',
  'platform:coaching',
  'platform:gmail',
  'platform:voice',
  'platform:avm',
  'platform:review_requests',
  'platform:portal',
];
const VENDOR_CHECKED = ['platform:voice', 'platform:gmail'];
const D11_REFERENCE = 'counsel review reported by the owner, 2026-11-12';

interface PackRow {
  key: string;
  version: string;
  status: string;
  reviewed_by_counsel_at: Date | null;
  rules: Record<string, unknown>;
  notes: string | null;
}

let db: TestDb;
let snapshot: PackRow[];

async function query<T extends pg.QueryResultRow>(url: string, q: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return (await c.query<T>(q, params)).rows;
  } finally {
    await c.end();
  }
}

const packs = () =>
  query<PackRow>(db.ownerUrl, 'SELECT key, version, status, reviewed_by_counsel_at, rules, notes FROM jurisdiction_packs ORDER BY key, version');
const published = async (key: string) => (await packs()).find((p) => p.key === key && p.status === 'published')!;
const cleared = async (key: string, vendor: boolean) =>
  (await query<{ c: boolean }>(db.ownerUrl, 'SELECT app.platform_cleared($1, $2) AS c', [key, vendor]))[0]!.c;

async function run(argv: string[], url = db.ownerUrl, now?: Date) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCounselReview(argv, { url, log: (l) => out.push(l), error: (l) => err.push(l), now });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const args = (keys: string[], extra: string[] = []) => ['--keys', keys.join(','), '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, ...extra];

beforeAll(async () => {
  db = await createTestDb();
  // other versions of a pack the command must never touch, and a key that has no published version
  await query(
    db.ownerUrl,
    `INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
       ('platform:fair_housing', '2026.12.0', 'draft',   '{"lexicon_version": "fh/2"}', NULL, 'next draft'),
       ('platform:fair_housing', '2026.10.0', 'retired', '{"lexicon_version": "fh/0"}', NULL, 'old version'),
       ('platform:draft_only',   '2026.11.0', 'draft',   '{}', NULL, 'never published')`,
  );
  snapshot = await packs();
});
afterEach(async () => {
  for (const p of snapshot) {
    await query(db.ownerUrl, 'UPDATE jurisdiction_packs SET reviewed_by_counsel_at = $3, rules = $4, notes = $5 WHERE key = $1 AND version = $2', [
      p.key,
      p.version,
      p.reviewed_by_counsel_at,
      p.rules,
      p.notes,
    ]);
  }
});
afterAll(async () => {
  await db?.drop();
});

describe('counsel-review: recording counsel review of platform packs (R-INT-6, D11)', () => {
  it('R-INT-6: every platform pack still ships unreviewed (the code default is unchanged)', () => {
    const platform = snapshot.filter((p) => p.key.startsWith('platform:') && p.status === 'published');
    expect(platform.map((p) => p.key).sort()).toEqual([...D11_KEYS, 'platform:meta'].sort());
    for (const p of snapshot) expect(p.reviewed_by_counsel_at, p.key).toBeNull();
    for (const p of platform) expect(p.rules, p.key).not.toHaveProperty('vendor_ready_at');
  });

  it('R-INT-6 D11: --apply sets reviewed_by_counsel_at on each named key\'s published version only, appends a dated note with the reported source, and a second run changes nothing and says so', async () => {
    const r = await run(args(['platform:fair_housing', 'platform:coaching'], ['--apply']));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const after = await packs();
    for (const key of ['platform:fair_housing', 'platform:coaching']) {
      const before = snapshot.find((p) => p.key === key && p.status === 'published')!;
      const now = after.find((p) => p.key === key && p.status === 'published')!;
      expect(now.reviewed_by_counsel_at?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
      expect(now.notes!.startsWith(`${before.notes!} Counsel review recorded `)).toBe(true);
      expect(now.notes).toContain(`reviewed on 2026-11-12; source: ${D11_REFERENCE}.`);
      expect(now.rules).toEqual(before.rules);
      expect(r.out).toContain(`${key} (version ${now.version})`);
    }
    // every other row (other keys, and the draft and retired versions of fair_housing) is untouched
    const untouched = (rows: PackRow[]) => rows.filter((p) => !(['platform:fair_housing', 'platform:coaching'].includes(p.key) && p.status === 'published'));
    expect(untouched(after)).toEqual(untouched(snapshot));
    expect(r.out).toContain('before: not reviewed by counsel; not cleared');
    expect(r.out).toContain('after:  reviewed by counsel on 2026-11-12; cleared');
    expect(r.out).toContain('applied: 2 recorded, 0 already recorded');

    const again = await run(args(['platform:fair_housing', 'platform:coaching'], ['--apply']));
    expect(again.code).toBe(0);
    expect(await packs()).toEqual(after);
    expect(again.out).toContain('unchanged: already recorded as reviewed by counsel on 2026-11-12; cleared');
    expect(again.out).toContain('nothing to change: 2 already recorded; nothing was changed');

    // a different review date for a pack already recorded is refused, never overwritten
    const conflict = await run(['--keys', 'platform:coaching,platform:avm', '--reviewed-on', '2026-11-10', '--reference', D11_REFERENCE, '--apply']);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain('platform:coaching is already recorded as reviewed by counsel on 2026-11-12');
    expect(await packs()).toEqual(after);
  });

  it('R-INT-6: it refuses a key that is not platform:<name>, an unknown key, a key with no published version and the never-cleared platform:meta, and then changes nothing at all', async () => {
    const cases: [string, string][] = [
      ['US', "'US' is not a platform pack key (platform:<name>)"],
      ['fair_housing', "'fair_housing' is not a platform pack key (platform:<name>)"],
      ['platform:Fair-Housing', "'platform:Fair-Housing' is not a platform pack key (platform:<name>)"],
      ['platform:nonexistent', 'platform:nonexistent: no such pack on this deployment'],
      ['platform:draft_only', 'platform:draft_only has no published version (draft 2026.11.0)'],
      ['platform:meta', 'platform:meta is never cleared (owner decision D2)'],
    ];
    for (const [bad, message] of cases) {
      const r = await run(args(['platform:avm', bad], ['--apply']));
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain(message);
      expect(r.err, bad).toContain('nothing was changed');
      expect(await packs(), bad).toEqual(snapshot);
    }
  });

  it('R-INT-6: it refuses a missing --keys, --reviewed-on or --reference, an impossible date, a date in the future and an unknown flag, and changes nothing', async () => {
    const now = new Date('2026-11-12T15:00:00Z');
    const cases: [string[], string][] = [
      [['--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply'], '--keys is required'],
      [['--keys', 'platform:avm', '--reference', D11_REFERENCE, '--apply'], '--reviewed-on is required'],
      [['--keys', 'platform:avm', '--reviewed-on', '2026-11-12', '--apply'], '--reference is required'],
      [['--keys', 'platform:avm', '--reviewed-on', '2026-11-12', '--reference', '   ', '--apply'], '--reference is required'],
      [['--keys', 'platform:avm', '--reviewed-on', '2026-11-12', '--reference', 'line one\nline two', '--apply'], '--reference must be one line'],
      [['--keys', ',', '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply'], '--keys is required'],
      [['--keys', 'platform:avm', '--reviewed-on', '2026-02-30', '--reference', D11_REFERENCE, '--apply'], '--reviewed-on must be a date YYYY-MM-DD'],
      [['--keys', 'platform:avm', '--reviewed-on', '12/11/2026', '--reference', D11_REFERENCE, '--apply'], '--reviewed-on must be a date YYYY-MM-DD'],
      [['--keys', 'platform:avm', '--reviewed-on', '2026-11-13', '--reference', D11_REFERENCE, '--apply'], '--reviewed-on 2026-11-13 is in the future'],
      [[...args(['platform:avm'], ['--apply']), '--vendor-ready'], 'unknown option --vendor-ready'],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv, db.ownerUrl, now);
      expect(r.code, message).toBe(1);
      expect(r.err, message).toContain(message);
      expect(await packs(), message).toEqual(snapshot);
    }
    // today (UTC) is accepted
    expect((await run(args(['platform:avm']), db.ownerUrl, now)).code).toBe(0);
  });

  it('R-INT-6 D11: it never sets or changes rules.vendor_ready_at: after the seven D11 packs are recorded, platform_cleared is true for the five counsel-only packs and stays false for voice and Gmail until their vendor checks pass', async () => {
    const r = await run(args(D11_KEYS, ['--apply']));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const after = await packs();
    for (const key of D11_KEYS) {
      const before = snapshot.find((p) => p.key === key && p.status === 'published')!;
      const now = after.find((p) => p.key === key && p.status === 'published')!;
      expect(now.rules, key).toEqual(before.rules);
      expect(now.reviewed_by_counsel_at?.toISOString(), key).toBe('2026-11-12T00:00:00.000Z');
      if (VENDOR_CHECKED.includes(key)) {
        expect(await cleared(key, true), key).toBe(false);
        expect(now.notes, key).toContain('The vendor check (rules.vendor_ready_at) is separate and was not recorded.');
      } else {
        expect(await cleared(key, false), key).toBe(true);
      }
    }
    expect(await cleared('platform:meta', false)).toBe(false);
    expect(r.out).toContain('after:  reviewed by counsel on 2026-11-12; not cleared: still waits for the vendor check (rules.vendor_ready_at; this command never sets it)');
    expect(r.out.match(/still waits for the vendor check/g)).toHaveLength(2);
    expect(r.out).toContain('applied: 7 recorded, 0 already recorded');

    // a vendor check recorded separately is kept as it is, and only then is the capability cleared
    await query(db.ownerUrl, `UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL, rules = rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' WHERE key = 'platform:voice' AND status = 'published'`);
    const rulesWithVendor = (await published('platform:voice')).rules;
    const v = await run(args(['platform:voice'], ['--apply']));
    expect(v.code).toBe(0);
    expect((await published('platform:voice')).rules).toEqual(rulesWithVendor);
    expect(await cleared('platform:voice', true)).toBe(true);
    expect(v.out).toContain('before: not reviewed by counsel; not cleared');
    expect(v.out).toContain('after:  reviewed by counsel on 2026-11-12; cleared');
  });

  it('R-INT-6: a dry run (the default) prints what would change and changes nothing; --apply then changes it', async () => {
    const reference = 'counsel letter of 2026-11-12, filed with the deploy log';
    const argv = ['--keys', 'platform:portal,platform:gmail', '--reviewed-on', '2026-11-12', '--reference', reference];
    const dry = await run(argv);
    expect(dry.err).toBe('');
    expect(dry.code).toBe(0);
    expect(await packs()).toEqual(snapshot);
    expect(dry.out).toContain('dry run');
    expect(dry.out).toContain('platform:portal (version 2026.11.0)');
    expect(dry.out).toContain('before: not reviewed by counsel; not cleared');
    expect(dry.out).toContain('after:  reviewed by counsel on 2026-11-12; cleared');
    expect(dry.out).toContain('still waits for the vendor check');
    expect(dry.out).toContain('dry run: 2 would be recorded, 0 already recorded; nothing was changed (run again with --apply to record)');

    const applied = await run([...argv, '--apply']);
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('applied: 2 recorded, 0 already recorded');
    for (const key of ['platform:portal', 'platform:gmail']) {
      const p = await published(key);
      expect(p.reviewed_by_counsel_at?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
      expect(p.notes).toContain(`source: ${reference}.`);
    }
    expect(await cleared('platform:portal', false)).toBe(true);
    expect(await cleared('platform:gmail', true)).toBe(false);
  });

  it('R-INT-6: only the database owner role can run it: as app_user it refuses in a dry run and with --apply, and app_user cannot write the column itself', async () => {
    for (const extra of [[], ['--apply']]) {
      const r = await run(args(['platform:avm'], extra), db.appUserUrl);
      expect(r.code).toBe(1);
      expect(r.err).toContain('database role app_user cannot update jurisdiction_packs: run this as the database owner role (MIGRATION_DATABASE_URL)');
      expect(r.err).toContain('nothing was changed');
      expect(await packs()).toEqual(snapshot);
    }
    await expect(query(db.appUserUrl, "UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:avm'")).rejects.toThrow(/permission denied/);
    expect(await packs()).toEqual(snapshot);
  });

  it('R-INT-6: the audit trail is the pack\'s own notes, which the platform (app_user included) reads: when it was recorded, by which database role, the review date and the source', async () => {
    const r = await run(args(['platform:review_requests'], ['--apply']));
    expect(r.code).toBe(0);
    const role = (await query<{ role: string }>(db.ownerUrl, 'SELECT current_user AS role'))[0]!.role;
    const [row] = await query<{ notes: string; reviewed_by_counsel_at: Date }>(
      db.appUserUrl,
      "SELECT notes, reviewed_by_counsel_at FROM jurisdiction_packs WHERE key = 'platform:review_requests' AND status = 'published'",
    );
    expect(row!.reviewed_by_counsel_at.toISOString().slice(0, 10)).toBe('2026-11-12');
    expect(row!.notes).toMatch(
      new RegExp(`Counsel review recorded \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z by database role ${role}: reviewed on 2026-11-12; source: ${D11_REFERENCE}\\.$`),
    );
    expect(r.out).toContain(`counsel-review: --apply as database role ${role}`);
    expect(r.out).toContain(`reviewed on 2026-11-12; source: ${D11_REFERENCE}`);
  });

  it('R-INT-6: the package script reads the owner URL from MIGRATION_DATABASE_URL, as migrate does, and is a dry run by default', async () => {
    const env = { ...process.env, MIGRATION_DATABASE_URL: db.ownerUrl };
    const r = spawnSync(process.execPath, ['--import', 'tsx', script, '--', ...args(['platform:avm'])], { env, encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dry run: 1 would be recorded, 0 already recorded; nothing was changed');
    expect(await packs()).toEqual(snapshot);
    const missing = spawnSync(process.execPath, ['--import', 'tsx', script, ...args(['platform:avm'], ['--apply'])], {
      env: { ...process.env, MIGRATION_DATABASE_URL: '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('MIGRATION_DATABASE_URL is not set');
  }, 70_000);
});
