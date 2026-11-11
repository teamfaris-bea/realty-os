// Bench-only phase profiling for the concurrent write benches (pnpm load:bench --profile).
//
// Per request, through AsyncLocalStorage (the request's async context follows app.inject into every
// pool.connect the server makes for it):
//   acquire  time waiting for a pooled connection (pool queueing)
//   hold     time a connection was checked out (BEGIN … COMMIT: DB work, round trips, lock waits, and
//            the Node work done between statements while the transaction is open)
//   other    the rest of the request (routing, Zod, core.decide outside a transaction, serialization)
// Alongside, a sampler polls pg_stat_activity of the bench's own connections (wait events: Lock, LWLock,
// Client/ClientRead = idle in transaction waiting for Node, IO, CPU = active with no wait event) and the
// machine's /proc/stat (CPU busy share of all cores, DB and API together).
// Profiling is instrumentation: timings of a --profile run are reported only as a breakdown.
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import type pg from 'pg';

export interface Phases {
  acquireMs: number;
  holdMs: number;
  checkouts: number;
  queries: number;
  /** LOAD_TRACE=1: the statements, in order (first line, 100 characters) */
  texts?: string[];
}

const store = new AsyncLocalStorage<Phases>();

export function runProfiled<T>(fn: () => Promise<T>): Promise<{ result: T; phases: Phases }> {
  const phases: Phases = { acquireMs: 0, holdMs: 0, checkouts: 0, queries: 0 };
  return store.run(phases, async () => ({ result: await fn(), phases }));
}

/** Wraps pool.connect() (the form Kysely's PostgresDialect uses) to attribute waits to the current request. */
export function instrumentPool(pool: pg.Pool): void {
  const original = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  (pool as unknown as { connect: (...a: unknown[]) => unknown }).connect = (...args: unknown[]) => {
    if (args.length > 0) return (original as (...a: unknown[]) => unknown)(...args);
    const ph = store.getStore();
    if (!ph) return original();
    const t0 = performance.now();
    return original().then((client) => {
      const t1 = performance.now();
      ph.acquireMs += t1 - t0;
      ph.checkouts += 1;
      const query = client.query;
      const release = client.release;
      client.query = function (this: pg.PoolClient, ...a: unknown[]) {
        ph.queries += 1;
        if (process.env.LOAD_TRACE === '1') {
          const q0 = a[0] as string | { text?: string };
          (ph.texts ??= []).push(String(typeof q0 === 'string' ? q0 : q0?.text).replace(/\s+/g, ' ').slice(0, 100));
        }
        return (query as (...x: unknown[]) => unknown).apply(this, a);
      } as typeof client.query;
      client.release = function (this: pg.PoolClient, err?: Error | boolean) {
        ph.holdMs += performance.now() - t1;
        client.query = query;
        client.release = release;
        return release.call(this, err);
      };
      return client;
    });
  };
}

function cpuTicks(): { busy: number; total: number } {
  const line = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1).map(Number);
  const idle = (line[3] ?? 0) + (line[4] ?? 0);
  const total = line.reduce((a, b) => a + b, 0);
  return { busy: total - idle, total };
}

/** utime + stime of a process in ms (/proc/<pid>/stat), 0 when it is gone or unreadable. */
function procCpuMs(pid: number): number {
  try {
    const f = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = f.slice(f.lastIndexOf(')') + 2).split(' ');
    return ((Number(rest[11]) + Number(rest[12])) * 1000) / 100; // fields 14, 15; CLK_TCK 100
  } catch {
    return 0;
  }
}

export interface Sample {
  /** CPU the bench's own Postgres backends used during the batch (same machine) */
  dbCpuMs: number;
  waits: Map<string, number>;
  samples: number;
  machineCpuBusy: number;
  nodeCpuMs: number;
  wallMs: number;
}

/** Samples the bench's own backends every `everyMs` while `fn` runs. */
export async function sampled<T>(su: pg.Pool, appName: string, fn: () => Promise<T>, everyMs = 10): Promise<{ result: T; sample: Sample }> {
  const waits = new Map<string, number>();
  let samples = 0;
  let stop = false;
  const pidsOf = async () => (await su.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE application_name = $1`, [appName])).rows.map((r) => r.pid);
  const cpu0 = new Map((await pidsOf()).map((pid) => [pid, procCpuMs(pid)]));
  const pids = new Set(cpu0.keys());
  const c0 = cpuTicks();
  const n0 = process.cpuUsage();
  const t0 = performance.now();
  const loop = (async () => {
    while (!stop) {
      const r = await su.query<{ k: string; n: string }>(
        `SELECT CASE WHEN state = 'active' THEN 'active:' || COALESCE(wait_event_type || '/' || wait_event, 'CPU')
                     ELSE state || ':' || COALESCE(wait_event_type || '/' || wait_event, '-') END AS k, count(*)::text AS n
           FROM pg_stat_activity WHERE application_name = $1 GROUP BY 1`, [appName]);
      samples += 1;
      for (const pid of await pidsOf()) pids.add(pid);
      for (const x of r.rows) waits.set(x.k, (waits.get(x.k) ?? 0) + Number(x.n));
      await new Promise((res) => setTimeout(res, everyMs));
    }
  })();
  const result = await fn();
  stop = true;
  await loop;
  for (const pid of await pidsOf()) pids.add(pid);
  let dbCpuMs = 0;
  for (const pid of pids) dbCpuMs += Math.max(0, procCpuMs(pid) - (cpu0.get(pid) ?? 0));
  const c1 = cpuTicks();
  const n1 = process.cpuUsage(n0);
  return {
    result,
    sample: { dbCpuMs, waits, samples, machineCpuBusy: (c1.busy - c0.busy) / Math.max(1, c1.total - c0.total), nodeCpuMs: (n1.user + n1.system) / 1000, wallMs: performance.now() - t0 },
  };
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))] ?? NaN;
};

export function describePhases(name: string, rows: { ms: number; phases: Phases }[], s: Sample): string {
  const f = (xs: number[]) => `p50 ${pct(xs, 0.5).toFixed(0)} / p95 ${pct(xs, 0.95).toFixed(0)}`;
  const acquire = rows.map((r) => r.phases.acquireMs);
  const hold = rows.map((r) => r.phases.holdMs);
  const other = rows.map((r) => r.ms - r.phases.acquireMs - r.phases.holdMs);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const waits = [...s.waits].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${(n / s.samples).toFixed(1)}`).join(', ');
  const traced = rows.find((r) => r.phases.texts);
  const trace = traced ? `\n    trace of one request:\n${traced.phases.texts!.map((t, i) => `      ${i + 1}. ${t}`).join('\n')}` : '';
  return [
    `  profile ${name}: total ${f(rows.map((r) => r.ms))} ms; pool wait ${f(acquire)} ms; connection held ${f(hold)} ms; outside a connection ${f(other)} ms`,
    `    per request: ${avg(rows.map((r) => r.phases.checkouts)).toFixed(1)} checkouts, ${avg(rows.map((r) => r.phases.queries)).toFixed(1)} statements`,
    `    backends (mean count per sample, ${s.samples} samples): ${waits}`,
    `    CPU per request: Postgres backends ${(s.dbCpuMs / rows.length).toFixed(1)} ms + bench process ${(s.nodeCpuMs / rows.length).toFixed(1)} ms; the batch's own CPU ${(s.dbCpuMs + s.nodeCpuMs).toFixed(0)} ms = ${((s.dbCpuMs + s.nodeCpuMs) / 4).toFixed(0)} ms of wall on 4 cores (CPU floor), observed wall ${s.wallMs.toFixed(0)} ms`,
    `    machine CPU busy ${(s.machineCpuBusy * 100).toFixed(0)}% of all cores over ${s.wallMs.toFixed(0)} ms wall; bench process CPU ${s.nodeCpuMs.toFixed(0)} ms (${((s.nodeCpuMs / s.wallMs) * 100).toFixed(0)}% of one core)`,
  ].join('\n') + trace;
}
