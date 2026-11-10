// pnpm load:smoke — the CI-sized load check (lane scale-250k): seeds ~20k contacts into a throwaway
// database, runs every benchmark operation with fewer iterations, and fails on
//   - any correctness check (claim race has exactly one winner, offers accepted, sends go out,
//     opted-out numbers are never sent to, import counts reconcile), or
//   - any p95 above LOOSE_FACTOR × its budget (CI machines are slower and noisier than the reference box;
//     the real numbers live in docs/PERFORMANCE.md from the 250k run).
// The database is dropped at the end unless --keep is passed.
import pg from 'pg';
import { markdownTable, runBench } from './bench.js';
import { loadUrls } from './db.js';
import { argValue, seedLoad } from './seed.js';

export const LOOSE_FACTOR = 4;

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
    const slow = r.results.filter((m) => m.budgetMs !== null && m.p95 > m.budgetMs * LOOSE_FACTOR);
    const failed = r.checks.filter((c) => !c.ok);
    for (const m of slow) console.error(`TOO SLOW: ${m.name} p95 ${m.p95.toFixed(0)} ms > ${LOOSE_FACTOR} × ${m.budgetMs} ms`);
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
