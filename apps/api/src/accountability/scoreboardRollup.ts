// The scoreboard's daily rollup (migration 0027; docs/PERFORMANCE.md §7 item 3).
//
// The read path (repos/scoreboard.ts) takes whole past days from the rollup and counts the rest live. This
// module keeps the rollup current. One run, per tenant, as the tenant's system actor:
//   1. roll   app.scoreboard_rollup_roll: consumes the previous horizon sample once every transaction
//             older than it has ended, then (re)computes the closed safe days that are missing, rolled in
//             another zone, or marked dirty by a late/backdated write; at most ROLL_CHUNK_DAYS days per
//             transaction (each a statement well inside the 30 s pool timeout), repeated until done.
//   2. sample app.scoreboard_rollup_sample in a transaction of its own (its xid must be newer than every
//             xid assigned before its clock reading).
// Idempotent: a day is recomputed from the base tables and replaced whole, so re-running, overlapping
// runs (serialized by an advisory lock in the function) and crashes between the steps change nothing.
// The backfill is the same job: every day of the window without a rollup row is "missing", so the first
// runs on an existing database roll the last ROLLUP_WINDOW_DAYS days (after one sample has become safe).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** Days kept (the 90 d range plus margin). */
export const ROLLUP_WINDOW_DAYS = 92;
/** Days recomputed per transaction. */
export const ROLL_CHUNK_DAYS = 31;

export interface RollResult {
  daysRolled: number;
  activityRows: number;
  speedRows: number;
  marksCleared: number;
  /** candidate days left for the next call (more than the chunk) */
  pendingDays: number;
  safeUntil: Date | null;
}

export async function rollScoreboard(tx: Tx, o: { windowDays?: number; maxDays?: number } = {}): Promise<RollResult> {
  const r = await sql<{ days_rolled: number; activity_rows: number; speed_rows: number; marks_cleared: number; pending_days: number; safe_until: Date | null }>`
    SELECT * FROM app.scoreboard_rollup_roll(${o.windowDays ?? ROLLUP_WINDOW_DAYS}::int, ${o.maxDays ?? ROLL_CHUNK_DAYS}::int)`.execute(tx);
  const x = r.rows[0]!;
  return { daysRolled: x.days_rolled, activityRows: x.activity_rows, speedRows: x.speed_rows, marksCleared: x.marks_cleared, pendingDays: x.pending_days, safeUntil: x.safe_until };
}

/** Must be the first write of its transaction. Returns whether a new sample was recorded. */
export async function sampleScoreboardHorizon(tx: Tx): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT app.scoreboard_rollup_sample() AS ok`.execute(tx);
  return r.rows[0]!.ok;
}

export interface RollupRun {
  calls: number;
  daysRolled: number;
  activityRows: number;
  speedRows: number;
  marksCleared: number;
  sampled: boolean;
}

/** One job run: roll in chunks until nothing is left (bounded), then take the next horizon sample. */
export async function runScoreboardRollup(withTx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, o: { maxCalls?: number; windowDays?: number; maxDays?: number } = {}): Promise<RollupRun> {
  const out: RollupRun = { calls: 0, daysRolled: 0, activityRows: 0, speedRows: 0, marksCleared: 0, sampled: false };
  const maxCalls = o.maxCalls ?? 8;
  for (;;) {
    const r = await withTx((tx) => rollScoreboard(tx, o));
    out.calls += 1;
    out.daysRolled += r.daysRolled;
    out.activityRows += r.activityRows;
    out.speedRows += r.speedRows;
    out.marksCleared += r.marksCleared;
    if (r.pendingDays === 0 || out.calls >= maxCalls) break;
  }
  out.sampled = await withTx((tx) => sampleScoreboardHorizon(tx));
  return out;
}
