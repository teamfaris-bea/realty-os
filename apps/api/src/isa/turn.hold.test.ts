// What happens to a turn held at a daily model-call budget, and around it (R-ISA-20; docs/AI_ISA.md §3.7, §4.2; b19 review
// F3, F4, F5, F7). Synthetic PostgreSQL, FakeIsaAi and the real worker over the real handlers; no fake clock: the next
// team-local day is modelled the way turn.spend.test.ts does it, by moving the day's ledger into the preceding day, and
// every pending job is made due (runIsa).
import { afterAll, beforeAll, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { inboundSms } from '../comms/testing.js';
import { BUDGET_HOLD_ACTIVITY, BUDGET_HOLD_OUTREACH, BUDGET_HOLD_REPLY } from './sentences.js';
import { aiMessages, assignmentOf, feedItems, handbacksOf, type IsaLead, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';
import { budgetResumeSpreadMs, BUDGET_RESUME_SPREAD_MS } from './spend.js';
import { runTurn } from './turn.js';

let h: ApiHarness;
beforeAll(async () => { h = await createApiHarness(); });
afterAll(async () => { await h?.close(); });

interface Care { w: IsaWorld; lead: IsaLead; assignmentId: string; epoch: number }

/** One person under live AI care whose start turn has run; no model call recorded yet today. */
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
/** `n` model calls already recorded today for this person's assignment. */
async function recordedToday(c: Care, n: number): Promise<void> {
  await h.su.query(`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,status,input_tokens,output_tokens)
    SELECT $1,gen_random_uuid(),'ai_isa_turn','fake-isa-1','synthetic','test',jsonb_build_object('assignmentId',$2::text),'succeeded',7,3 FROM generate_series(1,$3::int)`,
    [c.w.tenantId, c.assignmentId, n]);
}
/** The next team-local day: today's ledger becomes yesterday's. */
const rollover = (c: Care) => h.su.query(`UPDATE ai_runs SET created_at = created_at - interval '1 day' WHERE tenant_id = $1`, [c.w.tenantId]);
const text = async (c: Care, body: string, rounds = 2) => {
  expect((await inboundSms(h, c.lead.phone, c.w.mainNumber, body)).statusCode).toBe(200);
  await runIsa(h, c.w.tenantId, rounds);
  // texts over a day, not ten in ten minutes (the flood rule pauses care at the tenth inbound within ten minutes)
  await h.su.query(`UPDATE messages SET created_at = created_at - interval '15 minutes' WHERE contact_id = $1 AND direction = 'inbound'`, [c.lead.id]);
};
const inboundTurns = async (c: Care) => (await h.su.query<{ status: string; code: string | null }>(
  `SELECT status, decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'inbound' ORDER BY seq`, [c.assignmentId])).rows;
const turnJobs = async (c: Care) => (await h.su.query<{ status: string; run_at: Date }>(
  `SELECT status, run_at FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.turn' AND payload->>'assignmentId' = $2 AND status IN ('pending','running') AND payload->>'trigger' <> 'timer'`, [c.w.tenantId, c.assignmentId])).rows;
const todaysRuns = async (c: Care) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM ai_runs r JOIN tenant_settings s ON s.tenant_id = r.tenant_id
  WHERE r.tenant_id = $1 AND r.purpose = 'ai_isa_turn' AND r.created_at >= ((now() AT TIME ZONE s.default_timezone)::date::timestamp AT TIME ZONE s.default_timezone)`, [c.w.tenantId])).rows[0]!.n;

it('E794 R-ISA-20: two texts from a person at the limit: the older held turn is superseded, one job resumes, and after the rollover one provider call makes one reply that read both texts', async () => {
  const c = await care();
  await recordedToday(c, 12);
  const callsBefore = c.w.ai.calls.length;
  const sentBefore = (await aiMessages(h, c.lead.id)).length;
  await text(c, 'We want to buy a home near Alder Row this spring.');
  expect(await inboundTurns(c)).toEqual([{ status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  await text(c, 'Also we need three bedrooms near Birch Lane.');
  // two turns exist; the older one is superseded (stale), only the newer is held
  expect(await inboundTurns(c)).toEqual([{ status: 'stale', code: 'ISA_SUPERSEDED_BY_NEWER_TURN' }, { status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  // exactly one job is left to resume it
  expect(await turnJobs(c)).toHaveLength(1);
  expect(c.w.ai.calls.length).toBe(callsBefore);
  expect((await aiMessages(h, c.lead.id)).length).toBe(sentBefore);

  await rollover(c);
  // one round: every job due now runs, with what it enqueues for now (the dispatch); the follow-up timer the reply
  // schedules for three days later is not made due
  await runIsa(h, c.w.tenantId, 1);
  expect(c.w.ai.calls.length).toBe(callsBefore + 1);
  const prompt = c.w.ai.calls.at(-1)!.user;
  expect(prompt).toContain('Alder Row');
  expect(prompt).toContain('Birch Lane');
  expect((await aiMessages(h, c.lead.id)).length).toBe(sentBefore + 1);
  expect(await todaysRuns(c)).toBe(1);
  expect((await inboundTurns(c)).map((t) => t.status)).not.toContain('deferred');
  // nothing is left that could spend a second call for the same reply: no turn job but the follow-up timer
  expect(await turnJobs(c)).toEqual([]);
});

it('E794 R-ISA-20: at the rollover two jobs of the same person run at the same moment: only the job that owns the held turn calls the provider', async () => {
  const c = await care();
  await recordedToday(c, 12);
  const deps = depsFromPlatform(h.app.platform);
  const turn = (jobId: string) => runTurn(deps, c.w.tenantId, { assignmentId: c.assignmentId, trigger: 'inbound', epoch: c.epoch }, { jobId });
  // two texts, each read by its own job run (as two worker jobs would), both held today
  for (const [body, job] of [['We want to buy a home near Elm Walk this spring.', 'job-a'], ['Also near Fir Street if you have one.', 'job-b']] as const) {
    expect((await inboundSms(h, c.lead.phone, c.w.mainNumber, body)).statusCode).toBe(200);
    await h.su.query(`UPDATE conversations SET last_inbound_at = now() - interval '1 minute' WHERE contact_id = $1`, [c.lead.id]);
    await h.su.query(`UPDATE messages SET created_at = created_at - interval '15 minutes' WHERE contact_id = $1 AND direction = 'inbound'`, [c.lead.id]);
    expect((await turn(job)).kind).toBe('retry');
  }
  const callsBefore = c.w.ai.calls.length;
  await rollover(c);
  const results = await Promise.all([turn('job-a'), turn('job-b')]);
  expect(c.w.ai.calls.length).toBe(callsBefore + 1);
  expect(results.map((r) => (r.kind === 'done' ? r.code : r.kind)).sort()).toEqual(['NOTHING_TO_DO', 'QUEUED']);
  expect(c.w.ai.calls.at(-1)!.user).toContain('Elm Walk');
  expect(c.w.ai.calls.at(-1)!.user).toContain('Fir Street');
  expect(await todaysRuns(c)).toBe(1);
});

it('E794 R-ISA-20: twelve held texts spend one call after the rollover, not twelve, and the person is not at the limit again', async () => {
  const c = await care();
  await recordedToday(c, 12);
  const callsBefore = c.w.ai.calls.length;
  const sentBefore = (await aiMessages(h, c.lead.id)).length;
  for (let i = 1; i <= 12; i += 1) await text(c, `Question ${i}: is the house on Cedar Way number ${i} still for sale?`, 1);
  const held = await inboundTurns(c);
  expect(held).toHaveLength(12);
  expect(held.filter((t) => t.status === 'deferred')).toEqual([{ status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  expect(held.filter((t) => t.status === 'stale')).toHaveLength(11);
  expect(c.w.ai.calls.length).toBe(callsBefore);
  await runIsa(h, c.w.tenantId, 1);
  expect(await turnJobs(c)).toHaveLength(1);

  await rollover(c);
  await runIsa(h, c.w.tenantId, 1);
  expect(c.w.ai.calls.length).toBe(callsBefore + 1);
  expect(c.w.ai.calls.at(-1)!.user).toContain('Cedar Way number 12');
  expect(c.w.ai.calls.at(-1)!.user).toContain('Cedar Way number 1 ');
  expect(await todaysRuns(c)).toBe(1);
  expect((await aiMessages(h, c.lead.id)).length).toBe(sentBefore + 1);
  expect(await turnJobs(c)).toEqual([]);
}, 180_000);

it('E794 R-ISA-20: the resume of a held turn is spread over the first minutes after the rollover, by a fixed amount per assignment', async () => {
  const a = '0190aaaa-0000-7000-8000-000000000001';
  const b = '0190aaaa-0000-7000-8000-000000000002';
  expect(budgetResumeSpreadMs(a)).toBe(budgetResumeSpreadMs(a));
  for (const id of [a, b]) {
    expect(budgetResumeSpreadMs(id)).toBeGreaterThanOrEqual(0);
    expect(budgetResumeSpreadMs(id)).toBeLessThan(BUDGET_RESUME_SPREAD_MS);
  }
  // 200 assignments do not all resume at one instant
  const spreads = new Set(Array.from({ length: 200 }, (_, i) => budgetResumeSpreadMs(`0190aaaa-0000-7000-8000-${String(i).padStart(12, '0')}`)));
  expect(spreads.size).toBeGreaterThan(150);
  // the held job is parked at the rollover plus this assignment's spread
  const c = await care();
  await recordedToday(c, 12);
  await text(c, 'We want to buy a home near Dogwood Close this spring.');
  const reset = (await h.su.query<{ at: Date }>(`SELECT (((now() AT TIME ZONE default_timezone)::date + 1)::timestamp AT TIME ZONE default_timezone) AS at FROM tenant_settings WHERE tenant_id = $1`, [c.w.tenantId])).rows[0]!.at;
  const jobs = await turnJobs(c);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.run_at.getTime()).toBe(reset.getTime() + budgetResumeSpreadMs(c.assignmentId));
  expect((await h.su.query<{ nb: Date }>(`SELECT not_before AS nb FROM ai_isa_turns WHERE assignment_id = $1 AND status = 'deferred'`, [c.assignmentId])).rows[0]!.nb.getTime()).toBe(reset.getTime());
});

// ---- F4: a hold is visible to a human at once, and nothing about it goes to the person -------------------------------

const outbound = async (c: Care) => (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'`, [c.lead.id])).rows[0]!.n;
const notices = async (c: Care, kind: string) => (await h.su.query<{ title: string; body: string | null; priority: string; user_id: string }>(
  `SELECT title, body, priority, user_id FROM notifications WHERE tenant_id = $1 AND subject_id = $2 AND kind = $3 ORDER BY created_at`, [c.w.tenantId, c.lead.id, kind])).rows;
const activity = async (c: Care) => (await h.su.query<{ code: string; text: string }>(
  `SELECT reasons->0->>'code' AS code, reasons->0->>'text' AS text FROM priority_feed_items WHERE dedupe_key = $1 AND state = 'open'`, [`ai_isa_activity:${c.assignmentId}`])).rows;

it('E795 R-ISA-29 R-ISA-20: a reply held at a budget is visible at once: the pinned unanswered card, the handback and the notification are written with the hold, the activity card does not say the assistant is answering, and nothing goes to the person', async () => {
  const c = await care();
  await recordedToday(c, 12);
  const callsBefore = c.w.ai.calls.length;
  const outBefore = await outbound(c);
  expect((await inboundSms(h, c.lead.phone, c.w.mainNumber, 'We want to buy a home near Gum Tree Road this spring.')).statusCode).toBe(200);
  // while the text waits for its turn the card says the assistant is answering
  expect(await activity(c)).toEqual([{ code: 'AI_ISA_REPLY_RECEIVED', text: 'They replied; the AI assistant is answering' }]);
  // one round: the turn runs and is held; the text is three minutes old (the helper), not ten
  await runIsa(h, c.w.tenantId, 1);
  expect(await inboundTurns(c)).toEqual([{ status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  const m = (await h.su.query<{ id: string; age: number }>(`SELECT id, extract(epoch FROM now() - created_at)::int AS age FROM messages WHERE contact_id = $1 AND direction = 'inbound'`, [c.lead.id])).rows[0]!;
  expect(m.age).toBeLessThan(600);
  // the existing backstop, now: pinned card, handback, notification (each once)
  expect((await feedItems(h, c.lead.id)).filter((f) => f.item_type === 'unanswered_inbound')).toEqual([{ item_type: 'unanswered_inbound', band: 'pinned', state: 'open', dedupe_key: `inbound:${c.lead.id}` }]);
  expect(await handbacksOf(h, c.lead.id)).toEqual([expect.objectContaining({ status: 'proposed', dedupe_key: `handback:ai_isa:${c.assignmentId}:${m.id}` })]);
  expect((await h.su.query<{ explanation: string }>(`SELECT explanation FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'`, [c.lead.id])).rows).toEqual([{ explanation: `They replied. ${BUDGET_HOLD_REPLY}` }]);
  const told = await notices(c, 'inbound_message');
  expect(told.filter((n) => n.priority === 'high')).toHaveLength(1);
  expect(told.filter((n) => n.priority === 'high')[0]!.user_id).toBe(c.w.agents[0]!.userId);
  // the activity card is true while the turn is held
  expect(await activity(c)).toEqual([{ code: 'AI_ISA_REPLY_WAITING_BUDGET', text: BUDGET_HOLD_ACTIVITY }]);
  expect(BUDGET_HOLD_ACTIVITY).not.toMatch(/is answering/);
  // the job that is re-run while still held writes nothing twice
  await runIsa(h, c.w.tenantId, 2);
  expect(await handbacksOf(h, c.lead.id)).toHaveLength(1);
  expect((await notices(c, 'inbound_message')).filter((n) => n.priority === 'high')).toHaveLength(1);
  // nothing went to the person, and the model was not called
  expect(await outbound(c)).toBe(outBefore);
  expect(c.w.ai.calls.length).toBe(callsBefore);
  // a second text while held: the card still does not say the assistant is answering
  expect((await inboundSms(h, c.lead.phone, c.w.mainNumber, 'Are you there?')).statusCode).toBe(200);
  expect(await activity(c)).toEqual([{ code: 'AI_ISA_REPLY_WAITING_BUDGET', text: BUDGET_HOLD_ACTIVITY }]);
  await runIsa(h, c.w.tenantId, 1);
  expect(await outbound(c)).toBe(outBefore);
  // the next day the assistant answers, and the card says so again while it does
  await rollover(c);
  await runIsa(h, c.w.tenantId, 1);
  expect(c.w.ai.calls.length).toBe(callsBefore + 1);
  expect(await outbound(c)).toBe(outBefore + 1);
  expect(await activity(c)).toEqual([{ code: 'AI_ISA_REPLY_RECEIVED', text: 'They replied; the AI assistant is answering' }]);
  const sent = (await h.su.query<{ body: string }>(`SELECT body FROM messages WHERE contact_id = $1 AND direction = 'outbound' ORDER BY created_at DESC LIMIT 1`, [c.lead.id])).rows[0]!.body;
  expect(sent).not.toMatch(/budget|limit|tomorrow/i);
});

it('E795 R-ISA-20: a start turn held at a budget tells the lead\'s owner at once, by the pause notification, that AI care waits for tomorrow\'s budget and that they can reach out; nothing goes to the person', async () => {
  const w = await isaWorld(h);
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  const a = (await assignmentOf(h, lead.id))!;
  const c: Care = { w, lead, assignmentId: a.id, epoch: a.epoch };
  await h.su.query(`DELETE FROM ai_runs WHERE tenant_id = $1`, [w.tenantId]);
  await recordedToday(c, 12);
  await runIsa(h, w.tenantId, 1);
  expect((await h.su.query(`SELECT trigger_kind, status, decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1`, [a.id])).rows)
    .toEqual([{ trigger_kind: 'start', status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  const label = (await h.su.query<{ f: string; l: string }>(`SELECT first_name AS f, last_name AS l FROM contacts WHERE id = $1`, [lead.id])).rows[0]!;
  expect(await notices(c, 'ai_isa_paused')).toEqual([{ title: `AI care is waiting: ${label.f} ${label.l.slice(0, 1).toUpperCase()}.`, body: BUDGET_HOLD_OUTREACH, priority: 'normal', user_id: w.agents[0]!.userId }]);
  expect(BUDGET_HOLD_OUTREACH).toBe("AI care is waiting: today's AI budget is used up. It resumes tomorrow. You can reach out yourself now.");
  // held again on every re-run of the day: still one notification
  await runIsa(h, w.tenantId, 2);
  expect(await notices(c, 'ai_isa_paused')).toHaveLength(1);
  // no unanswered-inbound card (nobody wrote), nothing to the person, no model call
  expect((await feedItems(h, lead.id)).filter((f) => f.item_type === 'unanswered_inbound')).toEqual([]);
  expect(await outbound(c)).toBe(0);
  expect(w.ai.calls.length).toBe(0);
});

it('E795 R-ISA-20: a follow-up held at a budget tells the owner the same way, once for the day', async () => {
  const w = await isaWorld(h);
  const lead = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, lead.id)).status).toBe(200);
  // one round: the start turn runs; its follow-up timer is scheduled for later and has not run
  await runIsa(h, w.tenantId, 1);
  const a = (await assignmentOf(h, lead.id))!;
  const c: Care = { w, lead, assignmentId: a.id, epoch: a.epoch };
  expect((await h.su.query(`SELECT trigger_key FROM ai_isa_turns WHERE assignment_id = $1`, [a.id])).rows).toEqual([{ trigger_key: 'start:1:start' }]);
  await recordedToday(c, 12);
  const outBefore = await outbound(c);
  const callsBefore = w.ai.calls.length;
  expect(await notices(c, 'ai_isa_paused')).toEqual([]);
  const followUp = () => runTurn(depsFromPlatform(h.app.platform), w.tenantId, { assignmentId: a.id, trigger: 'timer', timer: 'follow_up', epoch: a.epoch });
  expect((await followUp()).kind).toBe('retry');
  expect((await h.su.query(`SELECT status, decision->>'code' AS code FROM ai_isa_turns WHERE assignment_id = $1 AND trigger_kind = 'timer'`, [a.id])).rows)
    .toEqual([{ status: 'deferred', code: 'ISA_MODEL_PERSON_DAILY_LIMIT' }]);
  expect((await notices(c, 'ai_isa_paused')).map((n) => n.body)).toEqual([BUDGET_HOLD_OUTREACH]);
  expect((await followUp()).kind).toBe('retry');
  expect(await notices(c, 'ai_isa_paused')).toHaveLength(1);
  expect(await outbound(c)).toBe(outBefore);
  expect(w.ai.calls.length).toBe(callsBefore);
});
