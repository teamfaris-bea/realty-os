// The timing-cue scan and today's nudge list over real Postgres (b20 timing-cue lane; DATA_MODEL R-TCUE-1 to
// R-TCUE-8). Notes are written through the real notes route by the agent; the superuser pool only back-dates when the
// words were written, sets fixture facts that have no route here (a deal, do-not-contact, a closed stage) and reads
// state back. The model is the deterministic fake in the timing slot (`providers.timingAi`); nothing calls a network.
// Invented people and words only.
import { randomUUID } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setAiEnabled } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { actorOf } from '../coaching/testing.js';
import { suFixture } from '../leads/testing.js';
import { FAKE_TIMING_BAD_QUOTE } from '../providers/index.js';
import { ProviderError, type AiProvider } from '../providers/types.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { INSIGHTS_JOBS, TIMING_SCAN_EVERY_MS, TIMING_SCAN_OFFSET_MS, makeInsightsHandlers } from './handlers.js';
import { type InsightsWorld, call, insightsWorld } from './testing.js';
import { cuesForContact } from './repos/timing.js';
import { scanTimingCues } from './timing.js';

let h: ApiHarness;
let w: InsightsWorld;
const DAY = 86_400_000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "March 2027" for the month `days` from now */
const monthYear = (days: number) => {
  const d = new Date(Date.now() + days * DAY);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

async function person(agent: TestClient, firstName: string): Promise<string> {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName: 'Fixture', emails: [`${randomUUID().slice(0, 8)}@example.test`] });
  if (r.status !== 201 && r.status !== 200) throw new Error(`contact: ${r.status}`);
  return r.body.contact.id;
}

/** A note written by `agent` through the API, back-dated to `daysAgo` (when the words were written). */
async function note(agent: TestClient, contactId: string, body: string, daysAgo = 10): Promise<string> {
  const r = await call<{ note: { id: string } }>(agent, 'POST', `/contacts/${contactId}/notes`, { body });
  if (r.status !== 201) throw new Error(`note: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.note.id;
  await suFixture(h, [{ text: 'UPDATE notes SET created_at = now() - make_interval(days => $2) WHERE id = $1', values: [id, daysAgo] }]);
  return id;
}

function ctxOf(tenantId: string) {
  return { withTx: <T>(fn: (tx: Parameters<Parameters<typeof withTenantTx>[1]>[0], now: never) => Promise<T>) => withTenantTx(systemActor(tenantId as TenantId, 'timer'), fn as never, { db: h.database }) as Promise<T> };
}

const scan = (tenantId = w.tenantId, model: AiProvider | null = h.providers.timingAi) => scanTimingCues(ctxOf(tenantId), model, { ids: h.app.platform.ids });

interface CueRow {
  note_id: string;
  outcome: string;
  cue_snippet: string | null;
  intent: string | null;
  evidence: string | null;
  window_start: string | null;
  window_end: string | null;
  window_basis: string | null;
  model: string | null;
}
const rowOf = async (noteId: string): Promise<CueRow | undefined> =>
  (await h.su.query<CueRow>('SELECT note_id, outcome, cue_snippet, intent, evidence, window_start::text, window_end::text, window_basis, model FROM timing_cues WHERE note_id = $1', [noteId])).rows[0];

const N: Record<string, string> = {};
const P: Record<string, string> = {};

beforeAll(async () => {
  h = await createApiHarness();
  w = await insightsWorld(h, { timezone: 'America/New_York' });
  const [a0, a1] = w.agents as [TestClient, TestClient];
  P.lease = await person(a0, 'Alpha');
  P.pcs = await person(a0, 'Bravo');
  P.rental = await person(a0, 'Charlie');
  P.unsure = await person(a0, 'Delta');
  P.quiet = await person(a0, 'Echo');
  P.script = await person(a0, 'Foxtrot');
  P.vague = await person(a0, 'Golf');
  P.live = await person(a0, 'Hotel');
  P.past = await person(a0, 'India');
  P.later = await person(a0, 'Juliet');
  P.stale = await person(a0, 'Kilo');
  P.closed = await person(a0, 'Lima');
  P.dnc = await person(a0, 'Quebec');
  P.other = await person(a1, 'November');
  N.lease = await note(a0, P.lease, 'Spoke with them. Their lease ends March and they want to buy before then.', 30);
  N.pcs = await note(a0, P.pcs, 'Called back. PCS next summer, they want to sell the house first.', 40);
  N.rental = await note(a0, P.rental, 'PCS next summer. They plan on renting the house out instead of selling.', 20);
  N.unsure = await note(a0, P.unsure, 'Their lease ends June, not sure about buying yet.', 15);
  N.quiet = await note(a0, P.quiet, 'Left a voicemail.', 5);
  N.script = await note(a0, P.script, 'Day 2 - text: Hey [Name], checking in after the holidays!', 5);
  N.vague = await note(a0, P.vague, 'Wants to buy, maybe next spring, will see.', 8);
  N.live = await note(a0, P.live, `Met at the open house. They are selling in ${monthYear(60)} once the kids finish school.`, 20);
  N.past = await note(a0, P.past, `Said they are buying in ${monthYear(-120)} when the new job starts.`, 300);
  N.later = await note(a0, P.later, `They are selling in ${monthYear(330)}, wants a valuation first.`, 10);
  N.stale = await note(a0, P.stale, `They are selling in ${monthYear(45)}, wants to list soon.`, 25);
  N.closed = await note(a0, P.closed, `They are buying in ${monthYear(30)}.`, 25);
  N.dnc = await note(a0, P.dnc, `They are buying in ${monthYear(30)}.`, 25);
  N.other = await note(a1, P.other, `They are buying in ${monthYear(20)}, preapproved.`, 12);
});
afterAll(async () => {
  await h?.close();
});

describe('R-TCUE-1 R-TCUE-2 R-TCUE-3 R-TCUE-5 R-TCUE-8 the nightly scan', () => {
  it('R-TCUE-8: reads every note once, records an outcome per note, and sends, assigns and tasks nothing', async () => {
    const messagesBefore = Number((await h.su.query('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).rows[0].count);
    const tasksBefore = Number((await h.su.query('SELECT count(*) FROM tasks WHERE tenant_id = $1', [w.tenantId])).rows[0].count);
    const stagesBefore = (await h.su.query('SELECT id, stage, owner_user_id FROM contacts WHERE tenant_id = $1 ORDER BY id', [w.tenantId])).rows;
    const r = await scan();
    expect(r).toMatchObject({ kind: 'scanned', read: Object.keys(N).length, more: false, modelDown: false });
    expect(Number((await h.su.query('SELECT count(*) FROM messages WHERE tenant_id = $1', [w.tenantId])).rows[0].count)).toBe(messagesBefore);
    expect(Number((await h.su.query('SELECT count(*) FROM tasks WHERE tenant_id = $1', [w.tenantId])).rows[0].count)).toBe(tasksBefore);
    expect((await h.su.query('SELECT id, stage, owner_user_id FROM contacts WHERE tenant_id = $1 ORDER BY id', [w.tenantId])).rows).toEqual(stagesBefore);
  });

  it('R-TCUE-2: no timing words and templates never reach the model; the fixture phrases do', async () => {
    expect((await rowOf(N.quiet!))?.outcome).toBe('no_timing');
    expect((await rowOf(N.script!))?.outcome).toBe('boilerplate');
    const prompts = h.providers.timingAi.calls.map((c) => c.user);
    expect(prompts.some((u) => u.includes('Left a voicemail'))).toBe(false);
    expect(prompts.some((u) => u.includes('Hey [Name]'))).toBe(false);
    for (const phrase of ['lease ends March', 'PCS next summer']) expect(prompts.some((u) => u.includes(phrase)), phrase).toBe(true);
  });

  it('R-TCUE-3: the cue is the verbatim quote; the fake model\'s bad quote is never stored', async () => {
    expect(await rowOf(N.lease!)).toMatchObject({ outcome: 'cue', cue_snippet: 'lease ends March', intent: 'buy', evidence: 'client_stated', window_basis: 'stated', model: 'fake-assistant-1' });
    expect(await rowOf(N.pcs!)).toMatchObject({ outcome: 'cue', cue_snippet: 'PCS next summer', intent: 'sell' });
    expect((await rowOf(N.vague!))?.outcome).toBe('unverified');
    expect((await h.su.query('SELECT count(*) FROM timing_cues WHERE cue_snippet = $1', [FAKE_TIMING_BAD_QUOTE])).rows[0].count).toBe('0');
  });

  it('R-TCUE-5 R-TCUE-3: a plan to rent the house out is not a seller; a low-confidence cue is recorded and not listed', async () => {
    expect(await rowOf(N.rental!)).toMatchObject({ outcome: 'rental', cue_snippet: null, intent: null });
    expect(await rowOf(N.unsure!)).toMatchObject({ outcome: 'low_confidence', cue_snippet: null });
  });

  it('R-TCUE-4: the window is computed from the day the note was written', async () => {
    const lease = await rowOf(N.lease!);
    const written = (await h.su.query<{ d: string }>("SELECT (created_at AT TIME ZONE 'America/New_York')::date::text AS d FROM notes WHERE id = $1", [N.lease])).rows[0]!.d;
    const [y, m] = written.split('-').map(Number) as [number, number];
    expect(lease?.window_start).toBe(`${m <= 3 ? y : y + 1}-03-01`);
  });

  it('R-TCUE-8: a second run reads nothing and calls no model; an edited note is read again', async () => {
    const calls = h.providers.timingAi.calls.length;
    expect(await scan()).toMatchObject({ kind: 'scanned', read: 0, modelCalls: 0 });
    expect(h.providers.timingAi.calls.length).toBe(calls);
    const r = await call(w.agents[0]!, 'PATCH', `/notes/${N.quiet}`, { body: 'Called again. They said maybe next year for buying.' });
    expect(r.status).toBe(200);
    expect(await scan()).toMatchObject({ kind: 'scanned', read: 1, modelCalls: 1 });
    expect(await rowOf(N.quiet!)).toMatchObject({ outcome: 'cue', cue_snippet: 'maybe next year', intent: 'buy' });
  });

  it('R-TCUE-1: note text never reaches the cloud provider slot; without a local model or with AI off nothing is read', async () => {
    expect(h.providers.ai.calls.filter((c) => c.templateKey === 'timing_cue.extract')).toEqual([]);
    const id = await note(w.agents[0]!, P.lease!, 'Update: maybe next year after all.', 1);
    expect(await scan(w.tenantId, null)).toEqual({ kind: 'off', reason: 'NO_LOCAL_MODEL' });
    await setAiEnabled(h, w.tenantId, false);
    const calls = h.providers.timingAi.calls.length;
    expect(await scan()).toEqual({ kind: 'off', reason: 'AI_OFF' });
    expect(h.providers.timingAi.calls.length).toBe(calls);
    expect(await rowOf(id)).toBeUndefined();
    await setAiEnabled(h, w.tenantId, true);
    expect(await scan()).toMatchObject({ read: 1 });
  });

  it('R-TCUE-1: a local model that is down records nothing and asks for a later run; a malformed answer is model_error', async () => {
    const down: AiProvider = { complete: () => Promise.reject(new ProviderError('unavailable', 'CONNECTION')) };
    const id = await note(w.agents[0]!, P.pcs!, 'They confirmed: PCS next summer.', 2);
    expect(await scan(w.tenantId, down)).toMatchObject({ kind: 'scanned', read: 0, modelDown: true, more: false });
    expect(await rowOf(id)).toBeUndefined();
    h.providers.timingAi.scripted.push({ text: 'Sure! The person plans to move.' });
    expect(await scan()).toMatchObject({ read: 1 });
    expect(await rowOf(id)).toMatchObject({ outcome: 'model_error', cue_snippet: null });
  });

  it('R-TCUE-8: the periodic job is registered nightly, standalone, and runs through a real worker', async () => {
    const handlers = makeInsightsHandlers(h.app.platform.ids);
    const job = handlers.find((x) => x.kind === INSIGHTS_JOBS.timingScan)!;
    expect(job).toMatchObject({ mode: 'standalone', queue: 'default', every: { ms: TIMING_SCAN_EVERY_MS, offsetMs: TIMING_SCAN_OFFSET_MS } });
    const id = await note(w.agents[0]!, P.live!, 'Also: after the holidays they want to start.', 1);
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'default', $2, '{}', now() - interval '1 second')`, [w.tenantId, INSIGHTS_JOBS.timingScan]);
    const worker = createWorker({ db: h.database, registry: new HandlerRegistry().registerAll(handlers), providers: h.providers, queues: ['default'], concurrency: 1, worker: `timing-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
    await worker.drain(5);
    expect(await rowOf(id)).toMatchObject({ outcome: 'cue', cue_snippet: 'after the holidays' });
  });
});

describe('R-TCUE-6 R-TCUE-7 R-TCUE-8 today’s list (GET /owner/timing-nudges)', () => {
  interface Item {
    contactId: string;
    firstName: string | null;
    ask: string;
    window: { start: string; end: string; inWindowNow: boolean };
  }
  interface List {
    today: string;
    counts: { live: number; pastWindow: number; stale: number; later: number; dropped: Record<string, number> };
    agents: { ownerUserId: string; live: Item[]; pastWindow: Item[]; stale: Item[] }[];
    method: string;
  }

  beforeAll(async () => {
    // a deal for Kilo that went under contract after the words; Lima closed; Quebec asked not to be contacted
    await suFixture(h, [
      {
        text: `INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id) VALUES ($1, $2, 'Fixture deal', 'sell', 'under_contract', now() - interval '1 day', $3, $4)`,
        values: [w.tenantId, randomUUID(), P.stale, w.agents[0]!.userId],
      },
      { text: `UPDATE contacts SET stage = 'closed' WHERE id = $1`, values: [P.closed] },
    ]);
    const dnc = await call(w.agents[0]!, 'POST', `/contacts/${P.dnc}/do-not-contact`, { reason: 'asked_on_call' });
    expect(dnc.status).toBe(200);
    await scan();
  });

  it('R-TCUE-6: LIVE, PAST_WINDOW and STALE against today; LATER, closed and do-not-contact are left off', async () => {
    const r = await call<List>(w.owner, 'GET', '/owner/timing-nudges');
    expect(r.status).toBe(200);
    const a0 = r.body.agents.find((a) => a.ownerUserId === w.agents[0]!.userId)!;
    const ids = (xs: Item[]) => xs.map((x) => x.contactId);
    expect(ids(a0.live)).toEqual(expect.arrayContaining([P.live, P.lease]));
    expect(ids(a0.pastWindow)).toContain(P.past);
    expect(ids(a0.stale)).toEqual([P.stale]);
    const everywhere = [...a0.live, ...a0.pastWindow, ...a0.stale].map((x) => x.contactId);
    for (const off of [P.later, P.pcs, P.closed, P.dnc, P.rental, P.unsure, P.vague]) expect(everywhere).not.toContain(off);
    expect(r.body.counts.dropped).toMatchObject({ closed: 1, do_not_contact: 1 });
    expect(r.body.counts.later).toBeGreaterThanOrEqual(2); // Juliet, and Bravo's summer window opens past the 6-month horizon
    expect(a0.live.every((x) => x.ask === 'call_today') && a0.pastWindow.every((x) => x.ask === 'check_in')).toBe(true);
    expect(r.body.method).toMatch(/counted from the day the words were written/);
  });

  it('R-TCUE-7: grouped per agent; LIVE open-now first, then soonest start; first names only, no confidence', async () => {
    const r = await call<List>(w.owner, 'GET', '/owner/timing-nudges');
    const a0 = r.body.agents.find((a) => a.ownerUserId === w.agents[0]!.userId)!;
    const a1 = r.body.agents.find((a) => a.ownerUserId === w.agents[1]!.userId)!;
    expect(a1.live.map((x) => x.firstName)).toEqual(['November']);
    const firstNotOpen = a0.live.findIndex((x) => !x.window.inWindowNow && x.window.start > r.body.today);
    if (firstNotOpen >= 0) for (const x of a0.live.slice(firstNotOpen)) expect(x.window.start > r.body.today).toBe(true);
    const starts = a0.live.slice(Math.max(0, firstNotOpen)).map((x) => x.window.start);
    if (firstNotOpen >= 0) expect([...starts].sort()).toEqual(starts);
    expect(JSON.stringify(r.body)).not.toMatch(/confiden|Fixture|@example\.test/);
  });

  it('R-TCUE-8: only a human Owner or Admin reads the list; everyone else gets 404', async () => {
    expect((await call(w.admin, 'GET', '/owner/timing-nudges')).status).toBe(200);
    for (const c of [w.agents[0]!, w.teamLead, w.isa, w.tc]) expect((await call(c, 'GET', '/owner/timing-nudges')).status).toBe(404);
  });

  it('R-TCUE-8: a member reads only the cue rows of notes they can read; only the system writes them', async () => {
    const seen = (c: TestClient) => withTenantTx(actorOf(c), async (tx) => (await sql<{ note_id: string }>`SELECT note_id FROM timing_cues`.execute(tx)).rows.map((x) => x.note_id), { db: h.database });
    const a1Sees = await seen(w.agents[1]!);
    expect(a1Sees).toContain(N.other);
    expect(a1Sees).not.toContain(N.lease);
    expect(await seen(w.agents[0]!)).toContain(N.lease);
    const forLead = (c: TestClient, id: string) => withTenantTx(actorOf(c), (tx) => cuesForContact(tx, id), { db: h.database });
    expect((await forLead(w.agents[0]!, P.lease!)).map((x) => x.cue_snippet)).toEqual(['maybe next year', 'lease ends March']); // newest words first
    expect(await forLead(w.agents[1]!, P.lease!)).toEqual([]);
    await expect(
      withTenantTx(actorOf(w.owner), (tx) => sql`UPDATE timing_cues SET outcome = 'no_cue', evidence = NULL, intent = NULL, timeframe = NULL, cue_snippet = NULL, window_start = NULL, window_end = NULL, window_precision = NULL, window_basis = NULL, window_label = NULL, confidence = NULL WHERE note_id = ${N.lease}::uuid`.execute(tx), { db: h.database }),
    ).resolves.toMatchObject({ numAffectedRows: 0n });
    await expect(withTenantTx(actorOf(w.owner), (tx) => sql`DELETE FROM timing_cues WHERE note_id = ${N.lease}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
  });

  it('R-TCUE-8: another team sees none of it', async () => {
    const other = await insightsWorld(h, { timezone: 'America/New_York' });
    const r = await call<List>(other.owner, 'GET', '/owner/timing-nudges');
    expect(r.status).toBe(200);
    expect(r.body.agents).toEqual([]);
    expect(await scan(other.tenantId)).toMatchObject({ kind: 'scanned', read: 0 });
  });
});
