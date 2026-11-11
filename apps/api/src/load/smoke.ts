// pnpm load:smoke — the CI-sized load check (lane scale-250k): seeds ~20k contacts into a throwaway
// database, runs every benchmark operation with fewer iterations, and fails on
//   - any correctness check (claim race has exactly one winner, offers accepted, sends go out,
//     opted-out numbers are never sent to, import counts reconcile), or
//   - any p95 above LOOSE_FACTOR × its budget (CI machines are slower and noisier than the reference box;
//     the real numbers live in docs/PERFORMANCE.md from the 250k run), or above the regression ceiling
//     of an operation that is known to miss its budget (KNOWN_MISS_CEILING_MS).
// The database is dropped at the end unless --keep is passed.
import pg from 'pg';
import { markdownTable, runBench } from './bench.js';
import { loadUrls } from './db.js';
import { argValue, seedLoad } from './seed.js';

export const LOOSE_FACTOR = 4;

/**
 * Operations that still miss their budget at scale (docs/PERFORMANCE.md, "Still missing"): the smoke
 * holds them to a regression ceiling instead, so CI catches them getting worse without pretending
 * they pass. Remove an entry once the operation meets LOOSE_FACTOR × budget.
 */
export const KNOWN_MISS_CEILING_MS: readonly { match: RegExp; ceilingMs: number }[] = [
  // accept / claim with 40+ simultaneous taps: CPU-bound on a 4-core box (docs/PERFORMANCE.md §7); 250k p95 637 / 382 ms
  { match: /^accept: /, ceilingMs: 900 },
  { match: /^claim: \d+ agents each claim/, ceilingMs: 600 },
];

/**
 * Paths lane perf-misses brought under budget at 250k (docs/PERFORMANCE.md §4): the smoke (20k contacts) holds
 * each to its own budget, not LOOSE_FACTOR × budget, so a regression of the fix fails CI.
 */
export const FIXED_PATH_CEILING_MS: readonly { match: RegExp; ceilingMs: number }[] = [
  { match: /^feed: /, ceilingMs: 150 },
  { match: /^search (name|phone|email): /, ceilingMs: 300 },
  { match: /^thread as the TC/, ceilingMs: 300 },
  { match: /^team scoreboard: /, ceilingMs: 300 },
];

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const db = argValue(args, 'db') ?? 'realty_load_smoke';
  const contacts = Number(argValue(args, 'contacts') ?? 20_000);
  const log = (s: string) => console.log(s);
  const t0 = Date.now();
  try {
    await seedLoad({ db, contacts, log: () => {} });
    log(`seeded ${contacts} contacts in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    const r = await runBench({ db, iterations: 15, sends: 150, importRows: 5_000, contested: 10, racers: 5, log });
    console.log(`\n${markdownTable(r)}\n`);
    const limitOf = (name: string, budget: number) =>
      FIXED_PATH_CEILING_MS.find((k) => k.match.test(name))?.ceilingMs ?? KNOWN_MISS_CEILING_MS.find((k) => k.match.test(name))?.ceilingMs ?? budget * LOOSE_FACTOR;
    const slow = r.results.filter((m) => m.budgetMs !== null && m.n > 0 && m.p95 > limitOf(m.name, m.budgetMs));
    const failed = r.checks.filter((c) => !c.ok);
    for (const m of slow) console.error(`TOO SLOW: ${m.name} p95 ${m.p95.toFixed(0)} ms > ${limitOf(m.name, m.budgetMs!)} ms`);
    for (const c of failed) console.error(`CHECK FAILED: ${c.name}: ${c.detail}`);
    console.log(`load:smoke ${slow.length + failed.length === 0 ? 'passed' : 'FAILED'} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    return slow.length + failed.length === 0 ? 0 : 1;
  } finally {
    if (!args.includes('--keep')) {
      const admin = new pg.Client({ connectionString: loadUrls(db).adminUrl });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
