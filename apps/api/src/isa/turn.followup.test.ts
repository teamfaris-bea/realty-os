// A follow-up timer's turn row (R-ISA-4, R-ISA-20; docs/AI_ISA.md §9.2, §9.3). Every follow-up of one epoch used to
// share one turn key (`timer:<epoch>:follow_up`), so the second one reused the first one's row, which was already
// decided: TX-B's attempt guard (`status = 'deciding' AND attempt = …`) matched nothing, the model call was made and
// thrown away (DISCARDED), and the machine was left awaiting the model, which makes core ignore every later follow-up
// until the person's next inbound. Each follow-up now has its own row, keyed by the timer's scheduled instant, and a
// row that was already decided is never the row of a new model call. With every follow-up able to run, an earlier
// timer that a later AI message superseded (nothing cancels it) must do nothing: only the one the assignment's
// next_follow_up_at names is the follow-up. Real Postgres via the API harness; the fake ISA model, telephony and
// consent fixtures; nothing real.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms } from '../comms/testing.js';
import { aiMessages, grantInitiated, initiatedDayNow, isaLead, isaWorld, type IsaLead, type IsaWorld, openZone, runIsa, startCare } from './testing.js';
import { runTurn, type TurnPayload, type TurnResult } from './turn.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

interface FollowUpTurn {
  id: string;
  trigger_key: string;
  status: string;
  attempt: number;
  ai_run_id: string | null;
  message_id: string | null;
  decision: Record<string, unknown>;
  denied: string[];
}
interface Machine {
  awaitingModel: boolean;
  phase: string;
  counters: { unansweredInitiated: number };
}

const followUpTurns = async (contactId: string) => (await h.su.query<FollowUpTurn>(`SELECT id, trigger_key, status, attempt, ai_run_id, message_id, decision, denied FROM ai_isa_turns
  WHERE contact_id = $1 AND trigger_kind = 'timer' AND trigger_key ~ '^timer:[0-9]+:follow_up' ORDER BY seq`, [contactId])).rows;
const careOf = async (contactId: string) => (await h.su.query<{ id: string; epoch: number; machine: Machine; ended_at: Date | null }>(
  `SELECT id, epoch, machine, ended_at FROM ai_isa_assignments WHERE contact_id = $1`, [contactId])).rows[0]!;
const pendingFollowUps = async (assignmentId: string) => (await h.su.query<{ id: string; payload: TurnPayload }>(
  `SELECT id, payload FROM jobs WHERE kind = 'ai_isa.turn' AND status = 'pending' AND payload->>'assignmentId' = $1 AND payload->>'timer' = 'follow_up' ORDER BY run_at`, [assignmentId])).rows;
const turn = (p: TurnPayload): Promise<TurnResult> => runTurn(depsFromPlatform(h.app.platform) as never, w.tenantId, p);

/** The cadence passes: every text so far went out three days earlier (there is no fake clock; the guard's initiated
 *  caps, one in 24 hours and three in 7 days, read messages.dispatched_at against the database's now()). */
const threeDaysPass = (l: IsaLead) => h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '3 days' WHERE contact_id = $1 AND direction = 'outbound' AND dispatched_at IS NOT NULL`, [l.id]);

/** A lead with the initiated tier (a follow-up is an initiated message) in care: the start turn ran and its text went out. */
async function inCare(): Promise<IsaLead> {
  // runIsa makes every pending job of the tenant due: an earlier case's next follow-up is not this case's to run
  await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND status = 'pending' AND kind LIKE 'ai_isa.%'`, [w.tenantId]);
  const l = await isaLead(h, w.agents[0]!);
  await grantInitiated(h, w.tenantId, l);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId, 1);
  expect((await aiMessages(h, l.id)).map((m) => m.status)).toEqual(['sent']);
  expect((await careOf(l.id)).machine.awaitingModel).toBe(false);
  return l;
}

/** What one follow-up must leave behind: its own decided row, one model call, a text that went out, and a machine that is not waiting. */
async function expectFollowUp(l: IsaLead, n: number, callsBefore: number): Promise<void> {
  const rows = await followUpTurns(l.id);
  expect(rows, `follow-up ${n}: one turn row each`).toHaveLength(n);
  expect(new Set(rows.map((r) => r.trigger_key)).size).toBe(n);
  const row = rows[n - 1]!;
  expect(row.trigger_key).toMatch(/^[A-Za-z0-9_:.-]{1,120}$/);
  expect(row.attempt).toBe(1);
  expect(row.ai_run_id, `follow-up ${n}: the model's answer was kept, not thrown away`).not.toBeNull();
  expect(w.ai.calls.length - callsBefore, `follow-up ${n}: one model call`).toBe(1);
  // it sent; a row with no message would have to say why (a code in its decision or its denied list)
  expect(row.message_id, `follow-up ${n}: ${JSON.stringify({ decision: row.decision, denied: row.denied })}`).not.toBeNull();
  expect(row.status).toBe('sent');
  const care = await careOf(l.id);
  expect(care.ended_at).toBeNull();
  expect(care.machine.awaitingModel, `follow-up ${n}: the machine is not left awaiting the model`).toBe(false);
  expect(care.machine.counters.unansweredInitiated).toBe(n);
  expect((await aiMessages(h, l.id)).filter((m) => m.status === 'sent')).toHaveLength(n + 1);
}

describe('R-ISA-4 R-ISA-20: every follow-up of one epoch is its own turn', () => {
  it('R-ISA-4 R-ISA-20: three follow-ups in a row, each the timer the last turn scheduled: each has its own turn row and one model call, sends, and leaves the machine not awaiting the model', () => initiatedDayNow(h, w.tenantId, openZone(), async () => {
    const l = await inCare();
    const care = await careOf(l.id);
    for (let n = 1; n <= 3; n += 1) {
      // the one follow-up the last turn scheduled, carrying its scheduled instant
      const due = await pendingFollowUps(care.id);
      expect(due, `follow-up ${n}: scheduled`).toHaveLength(1);
      expect(typeof due[0]!.payload.at).toBe('number');
      await threeDaysPass(l);
      const calls = w.ai.calls.length;
      await runIsa(h, w.tenantId, 1, { followUps: true });
      await expectFollowUp(l, n, calls);
      expect((await followUpTurns(l.id))[n - 1]!.trigger_key).toBe(`timer:${care.epoch}:follow_up:${due[0]!.payload.at}`);
    }
    expect((await careOf(l.id)).epoch).toBe(care.epoch);
  }));

  it('R-ISA-4 R-ISA-20: a follow-up job queued before the key carried the instant (no `at`), run twice in one epoch: the second is its own turn too, never DISCARDED', () => initiatedDayNow(h, w.tenantId, openZone(), async () => {
    const l = await inCare();
    const care = await careOf(l.id);
    for (let n = 1; n <= 3; n += 1) {
      // the turns are run by hand, as a job without `at` would be; the machine's own timer is dropped
      await h.su.query(`DELETE FROM jobs WHERE status = 'pending' AND kind = 'ai_isa.turn' AND payload->>'assignmentId' = $1 AND payload->>'timer' = 'follow_up'`, [care.id]);
      await threeDaysPass(l);
      const calls = w.ai.calls.length;
      expect(await turn({ assignmentId: care.id, trigger: 'timer', timer: 'follow_up', epoch: care.epoch }), `follow-up ${n}`).toEqual({ kind: 'done', code: 'QUEUED' });
      expect((await careOf(l.id)).machine.awaitingModel).toBe(false);
      await h.su.query(`DELETE FROM jobs WHERE status = 'pending' AND kind = 'ai_isa.turn' AND payload->>'assignmentId' = $1 AND payload->>'timer' = 'follow_up'`, [care.id]);
      await runIsa(h, w.tenantId, 1);
      await expectFollowUp(l, n, calls);
    }
  }));

  it('R-ISA-4 R-ISA-20: a follow-up job that runs again after its turn was decided makes no model call, writes no turn and leaves the machine as it was', () => initiatedDayNow(h, w.tenantId, openZone(), async () => {
    const l = await inCare();
    const care = await careOf(l.id);
    const [job] = await pendingFollowUps(care.id);
    expect(typeof job!.payload.at).toBe('number');
    await h.su.query(`DELETE FROM jobs WHERE id = $1`, [job!.id]);
    await threeDaysPass(l);
    const calls = w.ai.calls.length;
    expect(await turn(job!.payload)).toEqual({ kind: 'done', code: 'QUEUED' });
    await runIsa(h, w.tenantId, 1);
    await expectFollowUp(l, 1, calls);
    const before = { care: await careOf(l.id), rows: await followUpTurns(l.id), messages: await aiMessages(h, l.id), jobs: (await pendingFollowUps(care.id)).map((j) => j.id) };
    // the same job again (a worker that died after TX-B committed and before the job was marked done)
    expect(await turn(job!.payload)).toEqual({ kind: 'done', code: 'TURN_ALREADY_DECIDED' });
    expect(w.ai.calls.length - calls).toBe(1);
    expect({ care: await careOf(l.id), rows: await followUpTurns(l.id), messages: await aiMessages(h, l.id), jobs: (await pendingFollowUps(care.id)).map((j) => j.id) }).toEqual(before);
  }));

  it('R-ISA-4: after a reply two follow-up timers are pending: the earlier one does nothing (no model call, no turn, the machine as it was); the one the reply scheduled is the follow-up', () => initiatedDayNow(h, w.tenantId, openZone(), async () => {
    const l = await inCare();
    const care = await careOf(l.id);
    // fixture only, as gaps.test.ts does: runIsa ages an inbound's instant by minutes, so the care's start and the first
    // text's dispatch move back with it (an inbound older than the start is not this care's, and the guard keeps a gap
    // between two AI texts)
    await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '1 hour' WHERE contact_id = '${l.id}'; SET session_replication_role = origin`);
    await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '10 minutes' WHERE contact_id = $1 AND direction = 'outbound'`, [l.id]);
    // the person writes back and the AI answers: that answer schedules its own follow-up, and nothing cancels the first
    expect((await inboundSms(h, l.phone, w.mainNumber, 'We are looking for a place with a yard')).statusCode).toBe(200);
    await runIsa(h, w.tenantId, 2);
    expect((await aiMessages(h, l.id)).map((m) => [m.status, m.status_reason])).toEqual([['sent', null], ['sent', null]]);
    const [earlier, current, ...rest] = await pendingFollowUps(care.id);
    expect(rest).toHaveLength(0);
    expect(earlier!.payload.at).toBeLessThan(current!.payload.at!);
    const next = (await h.su.query<{ at: Date }>(`SELECT next_follow_up_at AS at FROM ai_isa_assignments WHERE id = $1`, [care.id])).rows[0]!.at.getTime();
    expect(next).toBe(current!.payload.at);
    await h.su.query(`DELETE FROM jobs WHERE id = ANY ($1::bigint[])`, [[earlier!.id, current!.id]]);
    await threeDaysPass(l);
    const calls = w.ai.calls.length;
    const before = { care: await careOf(l.id), messages: await aiMessages(h, l.id) };
    expect(await turn(earlier!.payload)).toEqual({ kind: 'done', code: 'FOLLOW_UP_SUPERSEDED' });
    expect(w.ai.calls.length).toBe(calls);
    expect(await followUpTurns(l.id)).toHaveLength(0);
    expect({ care: await careOf(l.id), messages: await aiMessages(h, l.id) }).toEqual(before);
    // the current one runs as a follow-up: one model call, its own row, a text that goes out
    expect(await turn(current!.payload)).toEqual({ kind: 'done', code: 'QUEUED' });
    await runIsa(h, w.tenantId, 1);
    const rows = await followUpTurns(l.id);
    expect(rows.map((r) => [r.trigger_key, r.status])).toEqual([[`timer:${care.epoch}:follow_up:${current!.payload.at}`, 'sent']]);
    expect(w.ai.calls.length - calls).toBe(1);
    expect((await careOf(l.id)).machine.awaitingModel).toBe(false);
    expect((await aiMessages(h, l.id)).map((m) => m.status)).toEqual(['sent', 'sent', 'sent']);
  }));

  it('R-ISA-4: two follow-up jobs queued before the payload carried `at`: the earlier one does nothing; only the job whose own run_at is next_follow_up_at sends', () => initiatedDayNow(h, w.tenantId, openZone(), async () => {
    const l = await inCare();
    const care = await careOf(l.id);
    const [current] = await pendingFollowUps(care.id);
    expect(typeof current!.payload.at).toBe('number');
    const next = (await h.su.query<{ at: Date }>(`SELECT next_follow_up_at AS at FROM ai_isa_assignments WHERE id = $1`, [care.id])).rows[0]!.at;
    // both jobs are the legacy shape: no `at`. Their run_at is the only instant each one has.
    const legacy = { ...current!.payload };
    delete legacy.at;
    await h.su.query(`UPDATE jobs SET payload = $2::jsonb, run_at = $3 WHERE id = $1`, [current!.id, JSON.stringify(legacy), next]);
    const earlier = (await h.su.query<{ id: string }>(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at, dedupe_key)
      VALUES ($1, 'default', 'ai_isa.turn', $2::jsonb, $3::timestamptz - interval '1 day', $4) RETURNING id`,
      [w.tenantId, JSON.stringify(legacy), next, `ai_isa.timer:${care.id}:follow_up:earlier`])).rows[0]!;
    await threeDaysPass(l);
    const calls = w.ai.calls.length;
    const before = { care: await careOf(l.id), messages: await aiMessages(h, l.id) };
    const run = (jobId: string) => runTurn(depsFromPlatform(h.app.platform) as never, w.tenantId, legacy, { jobId });
    expect(await run(earlier.id)).toEqual({ kind: 'done', code: 'FOLLOW_UP_SUPERSEDED' });
    expect(w.ai.calls.length).toBe(calls);
    expect(await followUpTurns(l.id)).toHaveLength(0);
    expect({ care: await careOf(l.id), messages: await aiMessages(h, l.id) }).toEqual(before);
    expect(await run(current!.id)).toEqual({ kind: 'done', code: 'QUEUED' });
    await runIsa(h, w.tenantId, 1);
    await expectFollowUp(l, 1, calls);
  }));
});
