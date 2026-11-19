// R-ISA-20, E760 (docs/AI_ISA.md §3.7, §4.2): the team's model-budget lock is held only while one call is reserved.
// Synthetic PostgreSQL and FakeIsaAi only. Each case makes ONE turn slow at a point the test controls (the provider
// call, or the person's own contact lock) and shows that nobody else in the team waits behind it, and that the
// 12-per-person and 1,000-per-team budgets still hold exactly on reserved calls.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { lockModelBudget } from './spend.js';
import { aiMessages, assignmentOf, call, type IsaLead, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';
import { runTurn, type TurnResult } from './turn.js';

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

const WAIT_MS = 6_000;
/** The promise's value, or 'TIMEOUT' when it has not settled in time (a turn queued behind a lock). */
const within = <T>(p: Promise<T>, ms = WAIT_MS): Promise<T | 'TIMEOUT'> => Promise.race([p, new Promise<'TIMEOUT'>((r) => setTimeout(() => r('TIMEOUT'), ms))]);

interface Person { lead: IsaLead; marker: string; assignmentId: string; turn: () => Promise<TurnResult> }

/** One team, `n` people under live AI care, each with one unanswered inbound that needs a model call; no call recorded yet today. */
async function team(n: number): Promise<{ w: IsaWorld; people: Person[] }> {
  const w = await isaWorld(h);
  const leads: IsaLead[] = [];
  for (let i = 0; i < n; i += 1) {
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    leads.push(l);
  }
  await runIsa(h, w.tenantId);
  await h.su.query(`DELETE FROM ai_runs WHERE tenant_id = $1`, [w.tenantId]);
  const people: Person[] = [];
  for (const [i, lead] of leads.entries()) {
    const marker = `Maple Court number ${i + 1}`;
    expect((await inboundSms(h, lead.phone, w.mainNumber, `We want to buy a home near ${marker} this spring.`)).statusCode).toBe(200);
    const a = (await assignmentOf(h, lead.id))!;
    people.push({ lead, marker, assignmentId: a.id, turn: () => runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch }) });
  }
  // past the debounce
  await h.su.query(`UPDATE conversations SET last_inbound_at = now() - interval '1 minute' WHERE tenant_id = $1`, [w.tenantId]);
  await h.su.query(`UPDATE messages SET created_at = now() - interval '3 minutes' WHERE tenant_id = $1 AND direction = 'inbound'`, [w.tenantId]);
  return { w, people };
}

/** The fake provider waits, for requests whose prompt holds `marker`, until `release()`; `entered` resolves at the first such request. */
function slowProvider(w: IsaWorld, marker: string) {
  const real = w.ai.complete.bind(w.ai);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let enter!: () => void;
  const entered = new Promise<true>((r) => { enter = () => r(true); });
  const spy = vi.spyOn(w.ai, 'complete').mockImplementation(async (req) => {
    if (req.user.includes(marker)) { enter(); await gate; }
    return real(req);
  });
  return { release, entered, restore: () => spy.mockRestore() };
}

const callsFor = (w: IsaWorld, marker: string) => w.ai.calls.filter((c) => c.user.includes(marker)).length;
const runsOf = async (assignmentId: string) => (await h.su.query<{ status: string; error: string | null; input_tokens: number | null }>(
  `SELECT status, internal_signals->>'error' AS error, input_tokens FROM ai_runs WHERE purpose = 'ai_isa_turn' AND input_refs->>'assignmentId' = $1 ORDER BY created_at, id`, [assignmentId])).rows;
const teamRuns = async (tenantId: string) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_runs WHERE tenant_id = $1 AND purpose = 'ai_isa_turn'`, [tenantId])).rows[0]!.n;
/** `n` calls already recorded today against another person of the team (never against the people under test). */
async function recordedToday(w: IsaWorld, n: number): Promise<void> {
  const other = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, other.id)).status).toBe(200);
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,input_tokens,output_tokens)
    SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded',7,3 FROM generate_series(1,$3::int)`,
    [w.tenantId, (await assignmentOf(h, other.id))!.id, n]);
}
const heldCodes = async (assignmentId: string) => (await h.su.query<{ status: string; code: string | null }>(
  `SELECT status, decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound' ORDER BY seq`, [assignmentId])).rows;

it('R-ISA-20 R-ISA-31 E760: while one person\'s model call is slow, another person\'s turn reserves and completes, and that person\'s STOP is recorded at once', async () => {
  const { w, people: [a, b] } = await team(2);
  const slow = slowProvider(w, a!.marker);
  const sentBefore = (await aiMessages(h, a!.lead.id)).length;
  let aSettled = false;
  const runA = a!.turn().finally(() => { aSettled = true; });
  try {
    expect(await within(slow.entered)).toBe(true);
    // A's call is reserved before the provider is asked: the row is there, its outcome not yet known
    expect(await runsOf(a!.assignmentId)).toEqual([{ status: 'failed', error: 'CALL_OUTCOME_UNKNOWN', input_tokens: null }]);
    const rb = await within(b!.turn());
    expect(rb).toMatchObject({ kind: 'done' });
    expect(callsFor(w, b!.marker)).toBe(1);
    expect((await runsOf(b!.assignmentId)).map((r) => r.status)).toEqual(['succeeded']);
    expect(aSettled).toBe(false);
    const stop = await within(inboundSms(h, a!.lead.phone, w.mainNumber, 'STOP'));
    expect(stop).not.toBe('TIMEOUT');
    expect((stop as { statusCode: number }).statusCode).toBe(200);
    expect((await h.su.query(`SELECT reason FROM ai_isa_stop_signals WHERE tenant_id = $1`, [w.tenantId])).rows).toEqual([{ reason: 'opted_out' }]);
    expect((await h.su.query(`SELECT opt_out_keyword IS NOT NULL AS stop FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC, id DESC LIMIT 1`, [a!.lead.id])).rows).toEqual([{ stop: true }]);
    expect(aSettled).toBe(false);
  } finally {
    slow.release();
  }
  const ra = await runA;
  slow.restore();
  // the answer that came back after the STOP is discarded: nothing is queued for A, and the call stays counted
  expect(ra.kind).toBe('done');
  expect(ra).not.toMatchObject({ code: 'QUEUED' });
  expect((await aiMessages(h, a!.lead.id)).length).toBe(sentBefore);
  expect((await runsOf(a!.assignmentId)).map((r) => r.status)).toEqual(['succeeded']);
  expect(await teamRuns(w.tenantId)).toBe(2);
});

it('R-ISA-20 R-ISA-31 E760: a turn waiting on its own person\'s lock holds up nobody else: another person\'s model turn and a third person\'s stop turn both finish', async () => {
  const { w, people: [a, b, c] } = await team(3);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let holding!: () => void;
  const held = new Promise<void>((r) => { holding = r; });
  // any in-flight write on person A (an inbound being recorded, a send's TX1): it holds lock 2 for A
  const other = withTenantTx(systemActor(w.tenantId as never, 'worker'), async (tx) => {
    await sql`SELECT app.lock_contact(${a!.lead.id}::uuid)`.execute(tx);
    holding();
    await gate;
  }, { db: h.database });
  await held;
  let aSettled = false;
  const runA = a!.turn().finally(() => { aSettled = true; });
  const started: Promise<unknown>[] = [];
  const start = <T>(p: Promise<T>): Promise<T> => { started.push(p.catch(() => undefined)); return p; };
  try {
    await new Promise((r) => setTimeout(r, 400));
    expect(aSettled).toBe(false); // TX-A is waiting on lock 2
    const rb = await within(start(b!.turn()));
    // C says STOP; the turn that applies the stop signal (the sweep's path through TX-A) makes no model call
    expect((await inboundSms(h, c!.lead.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const cAssignment = (await assignmentOf(h, c!.lead.id))!;
    const rc = await within(start(runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: cAssignment.id, trigger: 'sweep', epoch: cAssignment.epoch })));
    expect({ modelTurnOfB: rb, stopTurnOfC: rc, aSettled }).toMatchObject({ modelTurnOfB: { kind: 'done' }, stopTurnOfC: { kind: 'done' }, aSettled: false });
    expect(callsFor(w, b!.marker)).toBe(1);
    expect((await assignmentOf(h, c!.lead.id))!.end_reason).toBe('opted_out');
    expect(callsFor(w, c!.marker)).toBe(0);
  } finally {
    release();
    await other;
    await Promise.all(started);
  }
  expect(await runA).toMatchObject({ kind: 'done' });
  expect(callsFor(w, a!.marker)).toBe(1);
});

it('R-ISA-20 E760: with 1,000 team calls recorded today, concurrent turns make no provider call and each is held until the next team-local day; the held turn then runs once', async () => {
  const { w, people } = await team(3);
  await recordedToday(w, 1000);
  const before = w.ai.calls.length;
  const results = await Promise.all(people.map((p) => p.turn()));
  expect(results.map((r) => r.kind)).toEqual(['retry', 'retry', 'retry']);
  expect(w.ai.calls.length).toBe(before);
  expect(await teamRuns(w.tenantId)).toBe(1000);
  for (const p of people) expect(await heldCodes(p.assignmentId)).toEqual([{ status: 'deferred', code: 'ISA_MODEL_TENANT_DAILY_LIMIT' }]);
  // the next team-local day: the held turn makes its one call, with the inbound it was held on, and is counted once
  await h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [w.tenantId]);
  const p = people[0]!;
  expect(await p.turn()).toMatchObject({ kind: 'done' });
  expect(callsFor(w, p.marker)).toBe(1);
  expect((await runsOf(p.assignmentId)).map((r) => r.status)).toEqual(['succeeded']);
  expect((await heldCodes(p.assignmentId)).map((t) => t.status)).not.toContain('deferred');
  // a replay of the same job finds nothing left to do: no second call for the same inbound
  expect(await p.turn()).toMatchObject({ kind: 'done' });
  expect(callsFor(w, p.marker)).toBe(1);
});

it('R-ISA-20 E760: with 999 recorded, two concurrent turns: exactly one calls the provider, and the other is held while that call is still in flight (reserved calls are what is counted)', async () => {
  const { w, people: [a, b] } = await team(2);
  await recordedToday(w, 999);
  const slow = slowProvider(w, 'Maple Court number');
  const before = w.ai.calls.length;
  const settled: TurnResult[] = [];
  const runs = [a!, b!].map((p) => p.turn().then((r) => { settled.push(r); return r; }));
  try {
    expect(await within(slow.entered)).toBe(true);
    // the loser is held without waiting for the winner's provider call
    const deadline = Date.now() + WAIT_MS;
    while (settled.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(settled.map((r) => r.kind)).toEqual(['retry']);
    expect(await teamRuns(w.tenantId)).toBe(1000);
  } finally {
    slow.release();
  }
  const results = await Promise.all(runs);
  slow.restore();
  expect(results.map((r) => r.kind).sort()).toEqual(['done', 'retry']);
  expect(w.ai.calls.length).toBe(before + 1);
  expect(await teamRuns(w.tenantId)).toBe(1000);
});

it('R-ISA-20 E760: a provider failure keeps its reservation, recorded as failed with the PROVIDER error and no token counts, so the next turn is held at the limit', async () => {
  const { w, people: [a, b] } = await team(2);
  await recordedToday(w, 999);
  w.ai.failing = true;
  const before = w.ai.calls.length;
  expect(await a!.turn()).toMatchObject({ kind: 'done' });
  expect(w.ai.calls.length).toBe(before + 1);
  expect(await runsOf(a!.assignmentId)).toEqual([{ status: 'failed', error: 'PROVIDER', input_tokens: null }]);
  expect(await teamRuns(w.tenantId)).toBe(1000);
  w.ai.failing = false;
  expect((await b!.turn()).kind).toBe('retry');
  expect(w.ai.calls.length).toBe(before + 1);
  expect(await heldCodes(b!.assignmentId)).toEqual([{ status: 'deferred', code: 'ISA_MODEL_TENANT_DAILY_LIMIT' }]);
  expect(await teamRuns(w.tenantId)).toBe(1000);
});

it('R-ISA-20 R-ISA-4 R-ISA-31 E760: a reservation waiting for the team lock holds none of the person\'s own locks: their STOP is recorded and a pause applies while it waits', async () => {
  const { w, people: [a, b] } = await team(2);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let holding!: () => void;
  const held = new Promise<void>((r) => { holding = r; });
  // someone else in the team is inside the reservation moment (the test holds the team lock open)
  const other = withTenantTx(systemActor(w.tenantId as never, 'assistant'), async (tx) => {
    await lockModelBudget(tx);
    holding();
    await gate;
  }, { db: h.database });
  await held;
  const before = w.ai.calls.length;
  const sentBefore = (await aiMessages(h, a!.lead.id)).length;
  let aSettled = false;
  const runA = a!.turn().finally(() => { aSettled = true; });
  const runB = b!.turn();
  try {
    // TX-A does not need the team lock: both turns are decided (their rows are `deciding`) and now wait to reserve
    const deadline = Date.now() + WAIT_MS;
    const deciding = async () => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_isa_turns WHERE assignment_id = ANY ($1::uuid[]) AND trigger_kind = 'inbound' AND status = 'deciding'`, [[a!.assignmentId, b!.assignmentId]])).rows[0]!.n;
    while ((await deciding()) < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
    expect(await deciding()).toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    expect(aSettled).toBe(false);
    expect(w.ai.calls.length).toBe(before);
    expect(await teamRuns(w.tenantId)).toBe(0);
    // A's STOP (lock 1, lock 2, the assignment FOR SHARE) and B's pause (lock 2, the assignment row) do not wait
    const stop = await within(inboundSms(h, a!.lead.phone, w.mainNumber, 'STOP'));
    expect(stop).toMatchObject({ statusCode: 200 });
    expect((await h.su.query(`SELECT reason FROM ai_isa_stop_signals WHERE tenant_id = $1`, [w.tenantId])).rows).toEqual([{ reason: 'opted_out' }]);
    const pause = await within(call(w.agents[0]!, 'POST', `/contacts/${b!.lead.id}/ai-isa/pause`, {}));
    expect(pause).toMatchObject({ status: 200 });
    expect((await assignmentOf(h, b!.lead.id))!.paused_at).not.toBeNull();
  } finally {
    release();
    await other;
  }
  const [ra, rb] = await Promise.all([runA, runB]);
  // neither answer is used: A said STOP and B's care was paused while their calls waited
  expect([ra.kind, rb.kind]).toEqual(['done', 'done']);
  expect(ra).not.toMatchObject({ code: 'QUEUED' });
  expect(rb).not.toMatchObject({ code: 'QUEUED' });
  expect((await aiMessages(h, a!.lead.id)).length).toBe(sentBefore);
  expect((await aiMessages(h, b!.lead.id)).filter((m) => m.status === 'queued' || m.status === 'scheduled')).toEqual([]);
});

it('R-ISA-20 E760: a held call resumes on the retry of the job that owns its turn, also when that job is the start job that read the first inbound', async () => {
  const w = await isaWorld(h);
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  // the start job has not run yet when the person writes
  expect((await inboundSms(h, lead.phone, w.mainNumber, 'We want to buy a home near Maple Court number 7 this spring.')).statusCode).toBe(200);
  await h.su.query(`UPDATE conversations SET last_inbound_at = now() - interval '1 minute' WHERE tenant_id = $1`, [w.tenantId]);
  await h.su.query(`UPDATE messages SET created_at = now() - interval '3 minutes' WHERE tenant_id = $1 AND direction = 'inbound'`, [w.tenantId]);
  await h.su.query(`DELETE FROM ai_runs WHERE tenant_id = $1`, [w.tenantId]);
  await recordedToday(w, 1000);
  const a = (await assignmentOf(h, lead.id))!;
  const start = () => runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: a.id, trigger: 'start', epoch: a.epoch });
  expect((await start()).kind).toBe('retry');
  expect(w.ai.calls.length).toBe(0);
  expect((await h.su.query(`SELECT trigger_kind, status, decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1`, [a.id])).rows)
    .toEqual([{ trigger_kind: 'inbound', status: 'deferred', code: 'ISA_MODEL_TENANT_DAILY_LIMIT' }]);
  await h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [w.tenantId]);
  expect(await start()).toMatchObject({ kind: 'done' });
  expect(callsFor(w, 'Maple Court number 7')).toBe(1);
  expect((await runsOf(a.id)).map((r) => r.status)).toEqual(['succeeded']);
});
