// A turn left `deciding` between its first transaction and its last is picked up again (R-ISA-4, R-ISA-20; docs/AI_ISA.md
// §4.2; b19 review F5; E796). Synthetic PostgreSQL, FakeIsaAi, the real worker and handlers. A failure is injected where
// the review named it, by a database trigger that raises inside the transaction under test (the reservation's INSERT, the
// hold's UPDATE, the usage record's UPDATE); the trigger is dropped before the retry.
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms } from '../comms/testing.js';
import { ISA_TURN_MAX_ATTEMPTS } from './turn.js';
import { assignmentOf, feedItems, type IsaLead, isaLead, isaWorld, type IsaWorld, runIsa, startCare, sweepNow } from './testing.js';
import { runTurn } from './turn.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
  await h.su.query(`CREATE FUNCTION public.zz_b19_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'B19_INJECTED_FAILURE'; END $$`);
});
afterEach(async () => { await disarm(); });
afterAll(async () => { await h?.close(); });

const POINTS = {
  /** the reservation: the INSERT of the ai_runs row, under the team model-budget lock */
  reserve: `CREATE TRIGGER zz_b19_fail BEFORE INSERT ON ai_runs FOR EACH ROW WHEN (NEW.purpose = 'ai_isa_turn') EXECUTE FUNCTION public.zz_b19_injected_failure()`,
  /** the hold of a refused call: the turn's UPDATE to `deferred` */
  hold: `CREATE TRIGGER zz_b19_fail BEFORE UPDATE ON ai_isa_turns FOR EACH ROW WHEN (NEW.status = 'deferred' AND OLD.status = 'deciding') EXECUTE FUNCTION public.zz_b19_injected_failure()`,
  /** the usage record: the UPDATE of the reserved ai_runs row after the provider answered */
  usage: `CREATE TRIGGER zz_b19_fail BEFORE UPDATE ON ai_runs FOR EACH ROW WHEN (NEW.purpose = 'ai_isa_turn') EXECUTE FUNCTION public.zz_b19_injected_failure()`,
} as const;
const arm = (point: keyof typeof POINTS) => h.su.query(POINTS[point]);
async function disarm(): Promise<void> {
  await h.su.query(`DROP TRIGGER IF EXISTS zz_b19_fail ON ai_runs`);
  await h.su.query(`DROP TRIGGER IF EXISTS zz_b19_fail ON ai_isa_turns`);
}

interface Care { w: IsaWorld; lead: IsaLead; assignmentId: string; epoch: number }
async function care(): Promise<Care> {
  const w = await isaWorld(h);
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  await h.su.query(`DELETE FROM ai_runs WHERE tenant_id = $1`, [w.tenantId]);
  // the helpers age an inbound by three minutes (the debounce); care must have started before that
  await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '2 hours' WHERE contact_id = '${lead.id}' AND ended_at IS NULL; SET session_replication_role = origin`);
  const a = (await assignmentOf(h, lead.id))!;
  return { w, lead, assignmentId: a.id, epoch: a.epoch };
}
const text = async (c: Care, body: string) => { expect((await inboundSms(h, c.lead.phone, c.w.mainNumber, body)).statusCode).toBe(200); };
/** past the debounce, for a turn run outside the worker */
const settle = async (c: Care) => {
  await h.su.query(`UPDATE conversations SET last_inbound_at = now() - interval '1 minute' WHERE contact_id = $1`, [c.lead.id]);
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '3 minutes' WHERE contact_id = $1 AND direction = 'inbound'`, [c.lead.id]);
};
const inboundTurns = async (c: Care) => (await h.su.query<{ status: string; code: string | null; attempt: number }>(
  `SELECT status, decision->>'code' AS code, attempt FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound' ORDER BY seq`, [c.assignmentId])).rows;
const runs = async (c: Care) => (await h.su.query<{ status: string; error: string | null }>(
  `SELECT status, internal_signals->>'error' AS error FROM ai_runs WHERE purpose = 'ai_isa_turn' AND input_refs->>'assignmentId' = $1 ORDER BY created_at, id`, [c.assignmentId])).rows;
const outbound = async (c: Care) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'`, [c.lead.id])).rows[0]!.n;
const machine = async (c: Care) => (await h.su.query<{ awaiting: boolean; paused: string | null }>(
  `SELECT (machine->>'awaitingModel')::boolean AS awaiting, pause_reason AS paused FROM ai_isa_assignments WHERE id = $1`, [c.assignmentId])).rows[0]!;
const recordedToday = (c: Care, n: number) => h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,input_tokens,output_tokens)
  SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded',7,3 FROM generate_series(1,$3::int)`, [c.w.tenantId, c.assignmentId, n]);
/** The turn has sat `deciding` for nine minutes (the sweep's stuck threshold is eight). */
const ageTurns = (c: Care, o: { attempt?: number } = {}) => h.su.query(`SET session_replication_role = replica;
  UPDATE ai_isa_turns SET updated_at = now() - interval '9 minutes'${o.attempt ? `, attempt = ${o.attempt}` : ''} WHERE assignment_id = '${c.assignmentId}' AND status = 'deciding';
  SET session_replication_role = origin`);

it('E796 R-ISA-4 R-ISA-20: a throw in the reserve transaction leaves a deciding turn; the retry of its job adopts it and completes it with exactly one reply', async () => {
  const c = await care();
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await arm('reserve');
  await text(c, 'We want to buy a home near Ivy Lane this spring.');
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  expect(c.w.ai.calls.length).toBe(calls);
  expect(await runs(c)).toEqual([]);
  await disarm();
  // the job's retry (its backoff made due): the same job adopts its own turn again
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'sent', code: null, attempt: 2 }]);
  expect(c.w.ai.calls.length).toBe(calls + 1);
  expect(c.w.ai.calls.at(-1)!.user).toContain('Ivy Lane');
  expect(await outbound(c)).toBe(out + 1);
  expect(await runs(c)).toEqual([{ status: 'succeeded', error: null }]);
  expect((await machine(c)).awaiting).toBe(false);
});

it('E796 R-ISA-4 R-ISA-20: a throw in the usage record (the provider had answered): the retry makes a fresh reservation and one reply; the first reservation stays counted', async () => {
  const c = await care();
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await arm('usage');
  await text(c, 'We want to buy a home near Juniper Court this spring.');
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  expect(c.w.ai.calls.length).toBe(calls + 1);
  expect(await outbound(c)).toBe(out);
  // the reservation was committed before the call and is not refunded: it is counted with its outcome unknown
  expect(await runs(c)).toEqual([{ status: 'failed', error: 'CALL_OUTCOME_UNKNOWN' }]);
  await disarm();
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'sent', code: null, attempt: 2 }]);
  expect(c.w.ai.calls.length).toBe(calls + 2);
  expect(await outbound(c)).toBe(out + 1);
  expect(await runs(c)).toEqual([{ status: 'failed', error: 'CALL_OUTCOME_UNKNOWN' }, { status: 'succeeded', error: null }]);
});

it('E796 R-ISA-4 R-ISA-20: a throw in the hold transaction: the retry holds the turn, and after the rollover it is answered once; the budget held throughout', async () => {
  const c = await care();
  await recordedToday(c, 12);
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await arm('hold');
  await text(c, 'We want to buy a home near Kestrel Row this spring.');
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  await disarm();
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT', attempt: 2 }]);
  expect(c.w.ai.calls.length).toBe(calls);
  expect((await runs(c)).length).toBe(12);
  await h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [c.w.tenantId]);
  await runIsa(h, c.w.tenantId, 1);
  expect((await inboundTurns(c)).map((t) => t.status)).toEqual(['sent']);
  expect(c.w.ai.calls.length).toBe(calls + 1);
  expect(await outbound(c)).toBe(out + 1);
});

it('E796 R-ISA-4: a deciding turn whose job is gone is recovered by the sweep after eight minutes: adopted again, one reply; another job of the person never adopts a turn it does not own', async () => {
  const c = await care();
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await text(c, 'We want to buy a home near Larch Hill this spring.');
  await settle(c);
  await arm('reserve');
  // the run of a job that then dies (it is never retried)
  await expect(runTurn(depsFromPlatform(h.app.platform), c.w.tenantId, { assignmentId: c.assignmentId, trigger: 'inbound', epoch: c.epoch }, { jobId: 'job-that-died' })).rejects.toThrow(/B19_INJECTED_FAILURE/);
  await disarm();
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  // the inbound's own queued job is another job: it finds nothing to consume and does not adopt the turn
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  expect(c.w.ai.calls.length).toBe(calls);
  // not yet stuck: the sweep leaves it alone
  await sweepNow(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deciding', code: null, attempt: 1 }]);
  await ageTurns(c);
  await sweepNow(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'sent', code: null, attempt: 2 }]);
  expect(c.w.ai.calls.length).toBe(calls + 1);
  expect(await outbound(c)).toBe(out + 1);
  expect((await machine(c)).awaiting).toBe(false);
});

it('E796 R-ISA-4: a turn recovered too often is given up: care is paused for a person to check, the machine no longer awaits the model, and the unanswered reply is pinned for the owner', async () => {
  const c = await care();
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await text(c, 'We want to buy a home near Myrtle Bank this spring.');
  await settle(c);
  await arm('reserve');
  await expect(runTurn(depsFromPlatform(h.app.platform), c.w.tenantId, { assignmentId: c.assignmentId, trigger: 'inbound', epoch: c.epoch }, { jobId: 'job-that-died' })).rejects.toThrow(/B19_INJECTED_FAILURE/);
  await disarm();
  expect((await machine(c)).awaiting).toBe(true);
  await ageTurns(c, { attempt: ISA_TURN_MAX_ATTEMPTS });
  await sweepNow(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'canceled_paused', code: 'ISA_TURN_ABANDONED', attempt: ISA_TURN_MAX_ATTEMPTS }]);
  expect(await machine(c)).toEqual({ awaiting: false, paused: 'check_this' });
  expect((await feedItems(h, c.lead.id)).filter((f) => f.item_type === 'unanswered_inbound')).toEqual([{ item_type: 'unanswered_inbound', band: 'pinned', state: 'open', dedupe_key: `inbound:${c.lead.id}` }]);
  expect((await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM notifications WHERE tenant_id = $1 AND subject_id = $2 AND kind = 'ai_isa_paused'`, [c.w.tenantId, c.lead.id])).rows[0]!.n).toBe(1);
  expect(c.w.ai.calls.length).toBe(calls);
  expect(await outbound(c)).toBe(out);
});

it('E796 R-ISA-4: while a turn is in its model call, a second job of the same person (a text inside the debounce has its own job) does not adopt it: one provider call, one reply', async () => {
  const c = await care();
  const calls = c.w.ai.calls.length;
  const out = await outbound(c);
  await text(c, 'We want to buy a home near Nettle Yard this spring.');
  await settle(c);
  const real = c.w.ai.complete.bind(c.w.ai);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let enter!: () => void;
  const entered = new Promise<void>((r) => { enter = r; });
  const spy = vi.spyOn(c.w.ai, 'complete').mockImplementation(async (req) => { enter(); await gate; return real(req); });
  const deps = depsFromPlatform(h.app.platform);
  const first = runTurn(deps, c.w.tenantId, { assignmentId: c.assignmentId, trigger: 'inbound', epoch: c.epoch }, { jobId: 'job-one' });
  await entered;
  expect(await runTurn(deps, c.w.tenantId, { assignmentId: c.assignmentId, trigger: 'inbound', epoch: c.epoch }, { jobId: 'job-two' })).toEqual({ kind: 'done', code: 'NOTHING_TO_DO' });
  release();
  expect(await first).toEqual({ kind: 'done', code: 'QUEUED' });
  spy.mockRestore();
  expect(c.w.ai.calls.length).toBe(calls + 1);
  await runIsa(h, c.w.tenantId, 1, { hold: ['ai_isa.turn'] });
  expect(await outbound(c)).toBe(out + 1);
});
