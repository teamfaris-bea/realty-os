// Bench-only: one tap at a time (accept, then claim), so per-statement times are CPU and I/O, not queueing.
// With pg_stat_statements loaded (track = all) it prints the statements of each phase by total time,
// nested trigger and function statements included. Consumes offers and pond leads like the bench.
//
//   pnpm --filter @realty/api exec tsx --env-file-if-exists=../../.env --conditions=@realty/source src/load/tapProfile.ts [--db realty_load] [--n 60]
import { randomUUID } from 'node:crypto';
import { LoadBench } from './bench.js';
import { loadUuid } from './generate.js';
import { argValue } from './seed.js';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;

async function top(b: LoadBench, label: string): Promise<void> {
  const rows = await b.q<{ calls: string; tot: string; mean: string; plan: string; top: boolean; q: string }>(
    `SELECT calls::text, round(total_exec_time::numeric, 1)::text AS tot, round(mean_exec_time::numeric, 3)::text AS mean, round(total_plan_time::numeric, 1)::text AS plan, toplevel AS top,
            left(regexp_replace(query, '\\s+', ' ', 'g'), 140) AS q
       FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      ORDER BY total_exec_time + total_plan_time DESC LIMIT 40`).catch(() => []);
  const tl = await b.q<{ n: string; t: string; p: string }>(`SELECT sum(calls)::text AS n, round(sum(total_exec_time)::numeric, 1)::text AS t, round(sum(total_plan_time)::numeric, 1)::text AS p FROM pg_stat_statements
       WHERE toplevel AND dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`).catch(() => [{ n: '?', t: '?', p: '?' }]);
  console.log(`\n== ${label}: top-level statements ${tl[0]!.n}, execution ${tl[0]!.t} ms, planning ${tl[0]!.p} ms (track_planning)`);
  for (const r of rows) console.log(`${r.calls.padStart(6)} ${r.tot.padStart(9)} ${r.mean.padStart(8)} ${(r.plan ?? '').padStart(8)} ${r.top ? 'T' : ' '} ${r.q}`);
  await b.q('SELECT pg_stat_statements_reset()').catch(() => []);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const n = Number(argValue(args, 'n') ?? 60);
  const b = await LoadBench.open({ db: argValue(args, 'db') ?? 'realty_load', iterations: 1, log: () => {} });
  try {
    const T = b.tenantId;
    const agents = await b.q<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'agent' ORDER BY user_id`, [T]);
    const s = new Map<string, Awaited<ReturnType<LoadBench['session']>>>();
    for (const [i, a] of agents.entries()) s.set(a.user_id, await b.session(`agent${i}`, a.user_id, 'agent'));
    await b.q('SELECT pg_stat_statements_reset()').catch(() => []);
    const offers = await b.q<{ id: string; offer_id: string; offered_to_user_id: string; ownership_seq: string }>(
      `SELECT id, offer_id, offered_to_user_id, ownership_seq::text FROM contacts WHERE tenant_id = $1 AND ownership_state = 'offered' ORDER BY id LIMIT $2`, [T, n]);
    const acc: number[] = [];
    for (const c of offers) {
      const r = await b.req(s.get(c.offered_to_user_id)!, 'POST', `/leads/${c.id}/accept`, { commandId: randomUUID(), offerId: c.offer_id, expectedSeq: Number(c.ownership_seq) });
      if (r.status !== 200) throw new Error(`accept ${r.status}`);
      acc.push(r.ms);
    }
    console.log(`accept, one at a time: n ${acc.length}, p50 ${pct(acc, 50).toFixed(1)} ms, p95 ${pct(acc, 95).toFixed(1)} ms`);
    await top(b, `accept ×${acc.length}`);
    const pond = loadUuid('load-big', 'pond:default');
    const leads = await b.q<{ id: string }>(`SELECT id FROM contacts WHERE tenant_id = $1 AND ownership_state = 'in_pond' AND pond_id = $2 AND deleted_at IS NULL ORDER BY id LIMIT $3`, [T, pond, n]);
    const cl: number[] = [];
    for (const [i, l] of leads.entries()) {
      const r = await b.req(s.get(agents[i % agents.length]!.user_id)!, 'POST', `/leads/${l.id}/claim`, { commandId: randomUUID(), pondId: pond });
      if (r.status === 200) cl.push(r.ms);
    }
    console.log(`claim, one at a time: n ${cl.length}, p50 ${pct(cl, 50).toFixed(1)} ms, p95 ${pct(cl, 95).toFixed(1)} ms`);
    await top(b, `claim ×${cl.length}`);
  } finally {
    await b.close();
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
