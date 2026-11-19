// Synthetic PostgreSQL and FakeIsaAi only; spend counts calls, not messages.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import { assignmentById } from './repo.js';
import { budgetResumeSpreadMs, reserveForTurn } from './spend.js';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { call } from '../workspace/testing.js';
import { assignmentOf, isaLead, isaWorld, runIsa, startCare } from './testing.js';
import { runTurn } from './turn.js';
let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });
async function ready() {
  const w = await isaWorld(h);
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  await h.su.query(`DELETE FROM ai_runs WHERE tenant_id = $1`, [w.tenantId]);
  expect((await inboundSms(h, l.phone, w.mainNumber, 'We want to buy a home this spring.')).statusCode).toBe(200);
  await h.su.query(`UPDATE conversations SET last_inbound_at = now() - interval '1 minute' WHERE contact_id = $1`, [l.id]);
  await h.su.query(`UPDATE messages SET created_at = now() - interval '3 minutes' WHERE contact_id = $1 AND direction = 'inbound'`, [l.id]);
  const a = (await assignmentOf(h, l.id))!;
  const run = () => runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch });
  return { w, l, a, run };
}
async function seedCalls(tenant: string, assignment: string, n: number) {
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,input_tokens,output_tokens)
    SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded',7,3 FROM generate_series(1,$3::int)`, [tenant, assignment, n]);
}
it.each(['PERSON', 'TENANT'] as const)('R-ISA-20: %s limit holds before the provider and releases after the local date rolls over', async (scope) => {
  const { w, l, a, run } = await ready();
  const other = scope === 'TENANT' ? await isaLead(h, w.agents[0]!) : l;
  if (scope === 'TENANT') expect((await startCare(w.agents[0]!, other.id)).status).toBe(200);
  await seedCalls(w.tenantId, scope === 'PERSON' ? a.id : (await assignmentOf(h, other.id))!.id, scope === 'PERSON' ? 12 : 1000);
  const before = w.ai.calls.length;
  const held = await run();
  expect(w.ai.calls.length).toBe(before);
  expect(held.kind).toBe('retry');
  const panel = await call<{ lastDecision: { status: string; sentence: string } }>(w.agents[0]!, 'GET', `/contacts/${l.id}/ai-isa`);
  expect(panel.status).toBe(200);
  expect(panel.body.lastDecision.status).toBe('deferred');
  expect(panel.body.lastDecision.sentence).toContain('daily model-call budget');
  expect((await h.su.query(`SELECT decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound'`, [a.id])).rows)
    .toEqual([{ code: `ISA_MODEL_${scope}_DAILY_LIMIT` }]);
  const next = (await h.su.query<{ at: Date }>(`SELECT (((now() AT TIME ZONE default_timezone)::date + 1)::timestamp AT TIME ZONE default_timezone) AS at FROM tenant_settings WHERE tenant_id = $1`, [w.tenantId])).rows[0]!.at;
  // E794: the turn is held until the next team-local day exactly (not_before); the job that resumes it is parked a fixed
  // part of the first ten minutes later, derived from the assignment id (the resumes of a team do not all fire at once)
  if (held.kind === 'retry') expect(held.retryAt).toBe(next.getTime() + budgetResumeSpreadMs(a.id));
  expect(budgetResumeSpreadMs(a.id)).toBeLessThan(10 * 60_000);
  expect((await h.su.query<{ nb: Date }>(`SELECT not_before AS nb FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound'`, [a.id])).rows[0]!.nb.getTime()).toBe(next.getTime());
  // Model the date rollover by moving only the synthetic ledger into the preceding local day.
  await h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [w.tenantId]);
  expect((await run()).kind).toBe('done');
  expect(w.ai.calls.length).toBe(before + 1);
});
it('R-ISA-20: records exact tokens, with a separate row for the repair', async () => {
  const { w, a, run } = await ready();
  const complete = w.ai.complete.bind(w.ai);
  w.ai.script.push('invalid schema');
  const spy = vi.spyOn(w.ai, 'complete').mockImplementation(async (request) => ({ ...await complete(request), inputTokens: 137, outputTokens: 29 }));
  await run();
  expect(spy).toHaveBeenCalledTimes(2);
  expect((await h.su.query(`SELECT input_tokens,output_tokens FROM ai_runs WHERE input_refs->>'assignmentId' = $1 ORDER BY created_at,id`, [a.id])).rows)
    .toEqual([{ input_tokens: 137, output_tokens: 29 }, { input_tokens: 137, output_tokens: 29 }]);
  spy.mockRestore();
});

it('E793 R-ISA-20: every provider call of a turn (the original and the repair) asks the adapter for a single request, one per reservation', async () => {
  const { w, a, run } = await ready();
  w.ai.script.push('invalid schema');
  const spy = vi.spyOn(w.ai, 'complete');
  await run();
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls.map((c) => c[0].singleRequest)).toEqual([true, true]);
  expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_runs WHERE input_refs->>'assignmentId' = $1 AND purpose = 'ai_isa_turn'`, [a.id])).rows[0]!.n).toBe(2);
  spy.mockRestore();
});

it('R-ISA-20: the twelfth call cannot sneak in a thirteenth repair; held repair resumes next local day', async () => {
  const { w, a, run } = await ready();
  await seedCalls(w.tenantId, a.id, 11);
  w.ai.script.push('invalid schema');
  const before = w.ai.calls.length;
  expect((await run()).kind).toBe('retry');
  expect(w.ai.calls.length).toBe(before + 1);
  expect((await h.su.query(`SELECT decision->>'budgetRepair' AS repair FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound'`, [a.id])).rows)
    .toEqual([{ repair: 'true' }]);
  await h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [w.tenantId]);
  expect((await run()).kind).toBe('done');
  expect(w.ai.calls.length).toBe(before + 2);
});

it('R-ISA-20: failed provider attempts still consume the model-call budget and store unknown tokens as null', async () => {
  const { w, a, run } = await ready();
  w.ai.failing = true;
  const before = w.ai.calls.length;
  await run();
  expect(w.ai.calls.length).toBe(before + 1);
  expect((await h.su.query(`SELECT input_tokens,output_tokens,status FROM ai_runs WHERE input_refs->>'assignmentId' = $1`, [a.id])).rows)
    .toEqual([{ input_tokens: null, output_tokens: null, status: 'failed' }]);
});

it('R-ISA-20: two people racing for the final team call make only one provider call', async () => {
  const { w, run } = await ready();
  const competing = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, competing.id)).status).toBe(200);
  const competitor = (await assignmentOf(h, competing.id))!;
  const historical = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, historical.id)).status).toBe(200);
  await seedCalls(w.tenantId, (await assignmentOf(h, historical.id))!.id, 999);
  const before = w.ai.calls.length;
  const results = await Promise.all([
    run(),
    runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: competitor.id, trigger: 'start', epoch: competitor.epoch }),
  ]);
  expect(results.filter((r) => r.kind === 'retry')).toHaveLength(1);
  expect(w.ai.calls.length).toBe(before + 1);
  expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_runs WHERE tenant_id = $1 AND purpose = 'ai_isa_turn'`, [w.tenantId])).rows[0]!.n).toBe(1000);
});


it('R-ISA-4 R-ISA-20: reserving a replay never resurrects a terminal turn or erases its decision', async () => {
  // the production path (reserveForTurn: the reservation in its own transaction under the team lock, then the hold)
  const { w, l, a } = await ready();
  const deps = depsFromPlatform(h.app.platform);
  const actor = systemActor(w.tenantId as never, 'assistant');
  const { assignment, turn, pinnedSeq } = await withTenantTx(actor, async (tx) => {
    const assignment = (await assignmentById(tx, a.id))!;
    const turn = (await sql<{ id: string }>`SELECT id FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} ORDER BY seq DESC LIMIT 1`.execute(tx)).rows[0]!;
    await sql`UPDATE ai_isa_turns SET status = 'no_reply', decision = '{"code":"REPLAY_SENTINEL"}'::jsonb WHERE tenant_id = app.tenant_id() AND id = ${turn.id}`.execute(tx);
    const conv = (await sql<{ seq: string }>`SELECT inbound_seq AS seq FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${l.id}`.execute(tx)).rows[0]!;
    return { assignment, turn, pinnedSeq: Number(conv.seq) };
  }, { db: h.database });
  const call = { id: turn.id, pinnedSeq, repair: false, owner: null, park: true, inboundUnanswered: false };
  const state = async () => (await h.su.query(`SELECT status, decision FROM ai_isa_turns WHERE id = $1`, [turn.id])).rows;
  expect(await reserveForTurn(deps, w.tenantId, assignment, call)).toHaveProperty('runId');
  expect(await state()).toEqual([{ status: 'no_reply', decision: { code: 'REPLAY_SENTINEL' } }]);
  await seedCalls(w.tenantId, a.id, 12);
  expect(await reserveForTurn(deps, w.tenantId, assignment, call)).toEqual({ kind: 'done', code: 'DISCARDED' });
  expect(await state()).toEqual([{ status: 'no_reply', decision: { code: 'REPLAY_SENTINEL' } }]);
  // a refused replay tells nobody anything: nothing was held
  expect((await h.su.query(`SELECT 1 FROM notifications WHERE tenant_id = $1 AND kind = 'ai_isa_paused'`, [w.tenantId])).rows).toEqual([]);
});
