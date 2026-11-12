// The operator command that records counsel review of named platform clearance packs on a deployment (R-INT-6;
// owner decision D11). Each key is pinned to the version counsel reviewed (platform:<name>@<version>) and is
// recorded only while that version is the published one. It writes reviewed_by_counsel_at on that version and
// appends a dated note naming the version and the reported source, as the database owner role only, dry run by
// default; --revoke withdraws a recorded review the same way. It never touches rules.vendor_ready_at (voice and
// Gmail also wait for their vendor checks). Packs still ship unreviewed: the migrations are unchanged and every
// pack starts NULL in a fresh database (asserted below).
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
/** published platform packs D11's run does not record: Meta (D2 cut) and the D10 outreach pack, recorded by its own run */
const NOT_D11 = ['platform:meta', 'platform:public_records_outreach'];
const VENDOR_CHECKED = ['platform:voice', 'platform:gmail'];
const D11_REFERENCE = 'counsel review reported by the owner, 2026-11-12';
/** the version every platform pack ships at (0018, 0025): the version D11's review covers */
const V = '2026.11.0';
const pin = (key: string) => `${key}@${V}`;
const DAY = 86_400_000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

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
  // one published version per key: restore the rows that are not published first, then the published ones
  for (const p of [...snapshot.filter((s) => s.status !== 'published'), ...snapshot.filter((s) => s.status === 'published')]) {
    await query(db.ownerUrl, 'UPDATE jurisdiction_packs SET status = $3, reviewed_by_counsel_at = $4, rules = $5, notes = $6 WHERE key = $1 AND version = $2', [
      p.key,
      p.version,
      p.status,
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
    // D9 S0 adds platform:cma (client CMAs and seller-update value ranges) and module 52 adds platform:ads; D11 lists neither (F8)
    // the AI ISA migration (D12 proposed) adds platform:ai_isa and platform:ai_isa_seller_data, also unreviewed
    expect(platform.map((p) => p.key).sort()).toEqual([...D11_KEYS, ...NOT_D11, 'platform:cma', 'platform:ads', 'platform:ai_isa', 'platform:ai_isa_seller_data'].sort());
    for (const p of snapshot) expect(p.reviewed_by_counsel_at, p.key).toBeNull();
    for (const p of platform) expect(p.rules, p.key).not.toHaveProperty('vendor_ready_at');
  });

  it('R-INT-6 D11: --apply sets reviewed_by_counsel_at on each named key\'s published version only, appends a dated note with the reported source, and a second run changes nothing and says so', async () => {
    const r = await run(args([pin('platform:fair_housing'), pin('platform:coaching')], ['--apply']));
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const after = await packs();
    for (const key of ['platform:fair_housing', 'platform:coaching']) {
      const before = snapshot.find((p) => p.key === key && p.status === 'published')!;
      const now = after.find((p) => p.key === key && p.status === 'published')!;
      expect(now.reviewed_by_counsel_at?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
      expect(now.notes!.startsWith(`${before.notes!} Counsel review recorded `)).toBe(true);
      expect(now.notes).toContain(`: version ${V} reviewed on 2026-11-12; source: ${D11_REFERENCE}.`);
      expect(now.rules).toEqual(before.rules);
      expect(r.out).toContain(`${key} (version ${now.version})`);
    }
    // every other row (other keys, and the draft and retired versions of fair_housing) is untouched
    const untouched = (rows: PackRow[]) => rows.filter((p) => !(['platform:fair_housing', 'platform:coaching'].includes(p.key) && p.status === 'published'));
    expect(untouched(after)).toEqual(untouched(snapshot));
    expect(r.out).toContain('before: not reviewed by counsel; not cleared');
    expect(r.out).toContain('after:  reviewed by counsel on 2026-11-12; cleared');
    expect(r.out).toContain('applied: 2 recorded, 0 already recorded');

    const again = await run(args([pin('platform:fair_housing'), pin('platform:coaching')], ['--apply']));
    expect(again.code).toBe(0);
    expect(await packs()).toEqual(after);
    expect(again.out).toContain('unchanged: already recorded as reviewed by counsel on 2026-11-12; cleared');
    expect(again.out).toContain('nothing to change: 2 already recorded; nothing was changed');

    // a different review date for a pack already recorded is refused, never overwritten
    const conflict = await run(['--keys', `${pin('platform:coaching')},${pin('platform:avm')}`, '--reviewed-on', '2026-11-10', '--reference', D11_REFERENCE, '--apply']);
    expect(conflict.code).toBe(1);
    expect(conflict.err).toContain('platform:coaching is already recorded as reviewed by counsel on 2026-11-12 (version 2026.11.0); this command never overwrites a recorded review');
    expect(conflict.err).toContain('withdraw it with --revoke');
    expect(await packs()).toEqual(after);
  });

  it('R-INT-6: it refuses a key that is not platform:<name>, a key without a valid version pin or with two, an unknown key, a key with no published version, a pin that is not the published version and the never-cleared platform:meta, and then changes nothing at all', async () => {
    const cases: [string, string][] = [
      ['US', "'US' is not a platform pack key (platform:<name>@<version>)"],
      ['US@2026.11.0', "'US' is not a platform pack key (platform:<name>@<version>)"],
      ['fair_housing@2026.11.0', "'fair_housing' is not a platform pack key (platform:<name>@<version>)"],
      ['platform:Fair-Housing@2026.11.0', "'platform:Fair-Housing' is not a platform pack key (platform:<name>@<version>)"],
      ['platform:%@2026.11.0', "'platform:%' is not a platform pack key"],
      ['platform:*', "'platform:*' is not a platform pack key"],
      ['platform:', "'platform:' is not a platform pack key"],
      ['platform:avm', 'platform:avm names no version: pin the version counsel reviewed'],
      ['platform:coaching@', 'platform:coaching names no version: pin the version counsel reviewed'],
      ['platform:coaching@2026.11.0;x', "'2026.11.0;x' is not a pack version"],
      ['platform:avm@2026.11.1', 'platform:avm is named with two versions (2026.11.0, 2026.11.1)'],
      ['platform:nonexistent@2026.11.0', 'platform:nonexistent: no such pack on this deployment'],
      ['platform:draft_only@2026.11.0', 'platform:draft_only has no published version (draft 2026.11.0)'],
      ['platform:portal@2026.11.9', 'platform:portal@2026.11.9 is not the published version 2026.11.0: there is no version 2026.11.9'],
      [
        'platform:fair_housing@2026.10.0',
        'platform:fair_housing@2026.10.0 is not the published version 2026.11.0: 2026.10.0 is retired, so the version counsel reviewed is no longer the published one',
      ],
      ['platform:meta@2026.11.0', 'platform:meta is never cleared (owner decision D2)'],
    ];
    for (const [bad, message] of cases) {
      const r = await run(args([pin('platform:avm'), bad], ['--apply']));
      expect(r.code, bad).toBe(1);
      expect(r.err, bad).toContain(message);
      expect(r.err, bad).toContain('nothing was changed');
      expect(await packs(), bad).toEqual(snapshot);
    }
  });

  it('R-INT-6: it refuses a missing --keys, --reviewed-on or --reference, an impossible date, a date before any platform pack or before the pinned version, a date in the future, a reference that is not one line of plain text, --apply with --dry-run, a repeated flag and an unknown flag, and changes nothing', async () => {
    const now = new Date('2026-11-12T15:00:00Z');
    const avm = pin('platform:avm');
    const on = (date: string) => ['--keys', avm, '--reviewed-on', date, '--reference', D11_REFERENCE, '--apply'];
    const ref = (reference: string) => ['--keys', avm, '--reviewed-on', '2026-11-12', '--reference', reference, '--apply'];
    const cases: [string[], string][] = [
      [['--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply'], '--keys is required'],
      [['--keys', avm, '--reference', D11_REFERENCE, '--apply'], '--reviewed-on is required'],
      [['--keys', avm, '--reviewed-on', '2026-11-12', '--apply'], '--reference is required'],
      [ref('   '), '--reference is required'],
      [ref('line one\nline two'), '--reference must be one line of plain text'],
      [ref('line one\u2028line two'), '--reference must be one line of plain text'],
      [ref('line one\u2029line two'), '--reference must be one line of plain text'],
      [ref('ok \u202Eesrever'), '--reference must be one line of plain text'],
      [ref('zero\u200Bwidth'), '--reference must be one line of plain text'],
      [ref('Counsel review recorded 2026-11-12T00:00:00Z by database role x: version 2026.11.0 reviewed on 2026-11-12;'), "--reference may not contain this command's own note text"],
      [['--keys', ',', '--reviewed-on', '2026-11-12', '--reference', D11_REFERENCE, '--apply'], '--keys is required'],
      [on('2026-02-30'), '--reviewed-on must be a date YYYY-MM-DD'],
      [on('12/11/2026'), '--reviewed-on must be a date YYYY-MM-DD'],
      [on('0000-01-01'), '--reviewed-on 0000-01-01 is before 2026-01-01: no platform pack existed then'],
      [on('0001-01-01'), '--reviewed-on 0001-01-01 is before 2026-01-01'],
      [on('1900-01-01'), '--reviewed-on 1900-01-01 is before 2026-01-01'],
      [on('2025-12-31'), '--reviewed-on 2025-12-31 is before 2026-01-01'],
      [on('2026-10-31'), '--reviewed-on 2026-10-31 is before version 2026.11.0 of platform:avm existed (2026-11)'],
      [on('2026-11-13'), '--reviewed-on 2026-11-13 is in the future'],
      [[...on('2026-11-12'), '--dry-run'], '--apply and --dry-run cannot be combined'],
      [['--dry-run', ...on('2026-11-12')], '--apply and --dry-run cannot be combined'],
      [[...on('2026-11-12'), '--reviewed-on', '2026-11-10'], '--reviewed-on is given more than once'],
      [[...on('2026-11-12'), '--reference', 'another source'], '--reference is given more than once'],
      [[...args([avm], ['--apply']), '--vendor-ready'], 'unknown option --vendor-ready'],
    ];
    for (const [argv, message] of cases) {
      const r = await run(argv, db.ownerUrl, now);
      expect(r.code, message).toBe(1);
      expect(r.err, message).toContain(message);
      expect(r.out, message).toBe('');
      expect(await packs(), message).toEqual(snapshot);
    }
    // today (UTC), and the first day of the pinned version's month, are accepted
    expect((await run(args([avm]), db.ownerUrl, now)).code).toBe(0);
    expect((await run(['--keys', avm, '--reviewed-on', '2026-11-01', '--reference', D11_REFERENCE], db.ownerUrl, now)).code).toBe(0);
  });

  it('R-INT-6: a review is pinned to the version counsel reviewed: after a newer version is published, the old pin (the standing D11 command) is refused and the new version stays unreviewed', async () => {
    // a pack bump: 2026.11.0 retired, 2026.12.0 published (unreviewed, as every new version ships)
    await query(db.ownerUrl, "UPDATE jurisdiction_packs SET status = 'retired' WHERE key = 'platform:fair_housing' AND version = '2026.11.0'");
    await query(db.ownerUrl, "UPDATE jurisdiction_packs SET status = 'published' WHERE key = 'platform:fair_housing' AND version = '2026.12.0'");
    const bumped = await packs();
    for (const extra of [[], ['--apply']]) {
      const old = await run(args([pin('platform:fair_housing'), pin('platform:coaching')], extra));
      expect(old.code).toBe(1);
      expect(old.err).toContain(
        'platform:fair_housing@2026.11.0 is not the published version 2026.12.0: 2026.11.0 is retired, so the version counsel reviewed is no longer the published one; 2026.12.0 needs its own counsel review',
      );
      expect(old.out).toBe('');
      expect(await packs()).toEqual(bumped);
    }
    expect(await cleared('platform:fair_housing', false)).toBe(false);
    // an old review date on the new version is refused before it reaches the database
    const early = await run(['--keys', 'platform:fair_housing@2026.12.0', '--reviewed-on', '2026-01-01', '--reference', D11_REFERENCE, '--apply']);
    expect(early.code).toBe(1);
    expect(early.err).toContain('--reviewed-on 2026-01-01 is before version 2026.12.0 of platform:fair_housing existed (2026-12)');
    expect(await packs()).toEqual(bumped);
  });

  it('R-INT-6: a pin of a draft is refused, and the review date may not be after today on the database clock, whatever the client clock says', async () => {
    const dbToday = (await query<{ d: string }>(db.ownerUrl, "SELECT to_char((now() AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS d"))[0]!.d;
    const ahead = new Date(Date.parse(`${dbToday}T12:00:00Z`) + 60 * DAY); // a client clock two months fast
    const draft = await run(['--keys', 'platform:fair_housing@2026.12.0', '--reviewed-on', '2026-12-01', '--reference', D11_REFERENCE, '--apply'], db.ownerUrl, ahead);
    expect(draft.code).toBe(1);
    expect(draft.err).toContain('platform:fair_housing@2026.12.0 is not the published version 2026.11.0: 2026.12.0 is a draft, not yet published');
    const future = utcDay(Date.parse(`${dbToday}T00:00:00Z`) + 2 * DAY);
    const r = await run(['--keys', pin('platform:avm'), '--reviewed-on', future, '--reference', D11_REFERENCE, '--apply'], db.ownerUrl, ahead);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`--reviewed-on ${future} is after today on the database clock`);
    expect(r.out).toBe('');
    expect(await packs()).toEqual(snapshot);
  });

  it('R-INT-6: a review set outside the command (no note of its own) is never reported as recorded: the command refuses and says so; --revoke withdraws it and it can then be recorded properly', async () => {
    const portal = pin('platform:portal');
    for (const at of ['2026-11-12T15:30:00Z', '2026-11-12T00:00:00Z']) {
      await query(db.ownerUrl, "UPDATE jurisdiction_packs SET reviewed_by_counsel_at = $1 WHERE key = 'platform:portal' AND status = 'published'", [at]);
      const hand = await packs();
      const r = await run(args([portal], ['--apply']));
      expect(r.code, at).toBe(1);
      expect(r.err, at).toContain(
        'platform:portal has reviewed_by_counsel_at on 2026-11-12 (version 2026.11.0) but no note from this command recording that review: it was set outside this command',
      );
      expect(r.out, at).toBe('');
      expect(await packs(), at).toEqual(hand);
    }
    // a recorded note for another version (notes copied to a new version) does not count
    await query(
      db.ownerUrl,
      "UPDATE jurisdiction_packs SET notes = notes || ' Counsel review recorded 2026-11-12T01:00:00Z by database role x: version 2026.10.0 reviewed on 2026-11-12; source: s.' WHERE key = 'platform:portal' AND status = 'published'",
    );
    expect((await run(args([portal], ['--apply']))).err).toContain('it was set outside this command');

    const w = await run(['--revoke', '--keys', portal, '--reference', 'set outside the command; withdrawn by the owner', '--apply']);
    expect(w.err).toBe('');
    expect(w.code).toBe(0);
    expect((await published('platform:portal')).reviewed_by_counsel_at).toBeNull();
    const again = await run(args([portal], ['--apply']));
    expect(again.code).toBe(0);
    expect(again.out).toContain('applied: 1 recorded, 0 already recorded');
    const rerun = await run(args([portal], ['--apply']));
    expect(rerun.code).toBe(0);
    expect(rerun.out).toContain('unchanged: already recorded as reviewed by counsel on 2026-11-12; cleared');
  });

  it('R-INT-6: --revoke withdraws a recorded review (dry run first, then --apply): reviewed_by_counsel_at back to NULL on the pinned published version, a withdrawal note appended, the capability held back again, rules untouched; a second run changes nothing', async () => {
    const keys = [pin('platform:avm'), pin('platform:voice')];
    expect((await run(args(keys, ['--apply']))).code).toBe(0);
    const recorded = await packs();
    const reference = 'avm included by mistake, reported by the owner, 2026-11-12';
    const rev = ['--revoke', '--keys', keys.join(','), '--reference', reference];
    const dry = await run(rev);
    expect(dry.err).toBe('');
    expect(dry.code).toBe(0);
    expect(await packs()).toEqual(recorded);
    expect(dry.out).toMatch(/^counsel-review --revoke: dry run as database role /);
    expect(dry.out).toContain('platform:avm (version 2026.11.0)');
    expect(dry.out).toContain('before: reviewed by counsel on 2026-11-12; cleared');
    expect(dry.out).toContain('before: reviewed by counsel on 2026-11-12; not cleared: still waits for the vendor check');
    expect(dry.out).toContain('after:  not reviewed by counsel; not cleared');
    expect(dry.out).toContain('dry run: 2 would be withdrawn, 0 not reviewed by counsel; nothing was changed (run again with --apply to withdraw)');

    const applied = await run([...rev, '--apply']);
    expect(applied.err).toBe('');
    expect(applied.code).toBe(0);
    expect(applied.out).toContain('applied: 2 withdrawn, 0 not reviewed by counsel');
    const role = (await query<{ role: string }>(db.ownerUrl, 'SELECT current_user AS role'))[0]!.role;
    const after = await packs();
    for (const key of ['platform:avm', 'platform:voice']) {
      const was = recorded.find((p) => p.key === key && p.status === 'published')!;
      const now = after.find((p) => p.key === key && p.status === 'published')!;
      expect(now.reviewed_by_counsel_at, key).toBeNull();
      expect(now.rules, key).toEqual(was.rules);
      expect(now.notes!.startsWith(`${was.notes!} Counsel review withdrawn `), key).toBe(true);
      expect(now.notes, key).toMatch(
        new RegExp(`Counsel review withdrawn \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z by database role ${role}: version 2026\\.11\\.0, recorded as reviewed on 2026-11-12; source: ${reference}\\.$`),
      );
    }
    const untouched = (rows: PackRow[]) => rows.filter((p) => !(['platform:avm', 'platform:voice'].includes(p.key) && p.status === 'published'));
    expect(untouched(after)).toEqual(untouched(recorded));
    expect(await cleared('platform:avm', false)).toBe(false);

    const again = await run([...rev, '--apply']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('unchanged: not reviewed by counsel; not cleared (nothing to withdraw)');
    expect(again.out).toContain('nothing to change: 2 not reviewed by counsel; nothing was changed');
    expect(await packs()).toEqual(after);

    // a withdrawn review set again by hand is not taken for the recorded one
    await query(db.ownerUrl, "UPDATE jurisdiction_packs SET reviewed_by_counsel_at = '2026-11-12T00:00:00Z' WHERE key = 'platform:avm' AND status = 'published'");
    expect((await run(args([pin('platform:avm')], ['--apply']))).err).toContain('it was set outside this command');

    // --revoke may withdraw platform:meta (cleared by hand); it refuses --reviewed-on, an unpinned key and an old pin
    await query(db.ownerUrl, "UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:meta' AND status = 'published'");
    const meta = await run(['--revoke', '--keys', pin('platform:meta'), '--reference', 'never cleared (D2)', '--apply']);
    expect(meta.code).toBe(0);
    expect(await cleared('platform:meta', false)).toBe(false);
    const before = await packs();
    const refusals: [string[], string][] = [
      [['--revoke', '--keys', pin('platform:voice'), '--reviewed-on', '2026-11-12', '--reference', reference, '--apply'], '--reviewed-on is not used with --revoke'],
      [['--revoke', '--keys', 'platform:voice', '--reference', reference, '--apply'], 'platform:voice names no version'],
      [['--revoke', '--keys', 'platform:fair_housing@2026.10.0', '--reference', reference, '--apply'], 'platform:fair_housing@2026.10.0 is not the published version 2026.11.0'],
      [['--revoke', '--keys', pin('platform:voice'), '--apply'], '--reference is required'],
      [['--revoke', '--revoke', '--keys', pin('platform:voice'), '--reference', reference], '--revoke is given more than once'],
    ];
    for (const [argv, message] of refusals) {
      const r = await run(argv);
      expect(r.code, message).toBe(1);
      expect(r.err, message).toContain(message);
      expect(await packs(), message).toEqual(before);
    }
  });

  it('R-INT-6 D11: it never sets or changes rules.vendor_ready_at: after the seven D11 packs are recorded, platform_cleared is true for the five counsel-only packs and stays false for voice and Gmail until their vendor checks pass', async () => {
    const r = await run(args(D11_KEYS.map(pin), ['--apply']));
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
    const v = await run(args([pin('platform:voice')], ['--apply']));
    expect(v.code).toBe(0);
    expect((await published('platform:voice')).rules).toEqual(rulesWithVendor);
    expect(await cleared('platform:voice', true)).toBe(true);
    expect(v.out).toContain('before: not reviewed by counsel; not cleared');
    expect(v.out).toContain('after:  reviewed by counsel on 2026-11-12; cleared');
  });

  it('R-HOME-8 R-INT-6 D11: platform:public_records_outreach ships unreviewed with {"states":["SC"]}; the seven-key D11 run leaves it alone, and only its own command run records it', async () => {
    const before = await published('platform:public_records_outreach');
    expect(before.reviewed_by_counsel_at).toBeNull();
    expect(before.rules).toEqual({ states: ['SC'] });
    expect(before.notes).toContain('Gates nothing in this build');
    const d11 = await run(args(D11_KEYS.map(pin), ['--apply']));
    expect(d11.code).toBe(0);
    expect(d11.out).toContain('applied: 7 recorded');
    expect(await published('platform:public_records_outreach')).toEqual(before);
    expect(await cleared('platform:public_records_outreach', false)).toBe(false);
    const own = await run(args([pin('platform:public_records_outreach')], ['--apply']));
    expect(own.err).toBe('');
    expect(own.code).toBe(0);
    const after = await published('platform:public_records_outreach');
    expect(after.reviewed_by_counsel_at?.toISOString()).toBe('2026-11-12T00:00:00.000Z');
    expect(after.rules).toEqual(before.rules);
    expect(await cleared('platform:public_records_outreach', false)).toBe(true);
  });

  it('R-INT-6: a dry run (the default) prints what would change and changes nothing; --apply then changes it', async () => {
    const reference = 'counsel letter of 2026-11-12, filed with the deploy log';
    const argv = ['--keys', `${pin('platform:portal')},${pin('platform:gmail')}`, '--reviewed-on', '2026-11-12', '--reference', reference];
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
    const revoke = ['--revoke', '--keys', pin('platform:avm'), '--reference', D11_REFERENCE];
    for (const argv of [args([pin('platform:avm')]), args([pin('platform:avm')], ['--apply']), revoke, [...revoke, '--apply']]) {
      const r = await run(argv, db.appUserUrl);
      expect(r.code).toBe(1);
      expect(r.err).toContain('database role app_user cannot update jurisdiction_packs: run this as the database owner role (MIGRATION_DATABASE_URL)');
      expect(r.err).toContain('nothing was changed');
      expect(await packs()).toEqual(snapshot);
    }
    await expect(query(db.appUserUrl, "UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:avm'")).rejects.toThrow(/permission denied/);
    expect(await packs()).toEqual(snapshot);
  });

  it('R-INT-6: the audit trail is the pack\'s own notes, which the platform (app_user included) reads: when it was recorded, by which database role, the review date and the source', async () => {
    const r = await run(args([pin('platform:review_requests')], ['--apply']));
    expect(r.code).toBe(0);
    const role = (await query<{ role: string }>(db.ownerUrl, 'SELECT current_user AS role'))[0]!.role;
    const [row] = await query<{ notes: string; reviewed_by_counsel_at: Date }>(
      db.appUserUrl,
      "SELECT notes, reviewed_by_counsel_at FROM jurisdiction_packs WHERE key = 'platform:review_requests' AND status = 'published'",
    );
    expect(row!.reviewed_by_counsel_at.toISOString().slice(0, 10)).toBe('2026-11-12');
    expect(row!.notes).toMatch(
      new RegExp(`Counsel review recorded \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z by database role ${role}: version 2026\\.11\\.0 reviewed on 2026-11-12; source: ${D11_REFERENCE}\\.$`),
    );
    expect(r.out).toContain(`counsel-review: --apply as database role ${role}`);
    expect(r.out).toContain(`reviewed on 2026-11-12; source: ${D11_REFERENCE}`);
  });

  it('R-INT-6: the package script reads the owner URL from MIGRATION_DATABASE_URL, as migrate does, and is a dry run by default', async () => {
    const env = { ...process.env, MIGRATION_DATABASE_URL: db.ownerUrl };
    const r = spawnSync(process.execPath, ['--import', 'tsx', script, '--', ...args([pin('platform:avm')])], { env, encoding: 'utf8', timeout: 60_000 });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('dry run: 1 would be recorded, 0 already recorded; nothing was changed');
    expect(await packs()).toEqual(snapshot);
    // never --apply here: an empty variable must be refused, but if it were ever dropped from the child's
    // environment, loadRootEnv would fill it from the checkout's .env (a developer database), and this case must
    // then at worst have been a dry run; it must also never have connected (no header line on stdout)
    const missing = spawnSync(process.execPath, ['--import', 'tsx', script, ...args([pin('platform:avm')])], {
      env: { ...process.env, MIGRATION_DATABASE_URL: '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(missing.stdout).toBe('');
    expect(missing.stderr).toContain('MIGRATION_DATABASE_URL is not set');
    expect(missing.status).toBe(1);
  }, 70_000);
});
