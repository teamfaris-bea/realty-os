// Undoing a stage change, and repeating one (R-STG-5; E764, E765, E766). POST /contacts/:id/stage answers the stage
// event it wrote; the same stage again answers the stored decision; `undoOf` marks the change as the undo of the
// person's most recent stage change, and an undo never starts a plan. Through the real server as app_user; the
// superuser pool only reads back. Fakes only.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import fc from 'fast-check';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld } from '../comms/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { type StageEntryFacts, type StagePlaybook, decideStageEntry } from './decide.js';
import { decisionsOf, enrollmentsOf, newContact, playbook, reconcileAsJob, scanPending, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let tl: TestClient;
const pb = {} as Record<'buyer' | 'contract' | 'secret', { id: string; versionId: string }>;
const SECRET_NAME = "Bo's private closing plan";

interface StageRes {
  stage: { stage: string };
  previousStage: string;
  rowVersion: number;
  eventId: string | null;
  automation: { started: string } | { skipped: string; plan: string } | null;
  stillRunning: { enrollmentId: string; plan: string; canStop: boolean } | null;
}
const post = (by: TestClient, contactId: string, body: Record<string, unknown>) => call<StageRes>(by, 'POST', `/contacts/${contactId}/stage`, body);
const stageOf = async (id: string) => (await h.su.query<{ stage: string }>('SELECT stage FROM contacts WHERE id = $1', [id])).rows[0]!.stage;
const eventsOf = async (id: string) => (await h.su.query<{ id: string; from_stage: string | null; to_stage: string; undo_of_event_id: string | null }>('SELECT id, from_stage, to_stage, undo_of_event_id FROM contact_stage_events WHERE contact_id = $1 ORDER BY occurred_at, id', [id])).rows;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  pb.buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  pb.contract = await playbook(w.owner, { scope: 'team', name: 'Contract plan' });
  pb.secret = await playbook(agent2, { scope: 'agent', name: SECRET_NAME });
  for (const [p, s, by] of [[pb.buyer, 'active', w.owner], [pb.contract, 'under_contract', w.owner], [pb.secret, 'closed', agent2]] as const) {
    const r = await setStage(by, p.id, s);
    if (r.status !== 200) throw new Error(`set stage ${s}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}, 300_000);
afterAll(async () => {
  await h?.close();
});

describe('the stage route names the event it wrote, and a repeat answers what is stored (R-STG-5)', () => {
  it('R-STG-5 a stage change answers its stage event id; a change to a stage no plan names has no decision', async () => {
    const c = await newContact(agent);
    const r = await post(agent, c, { stage: 'connected' });
    expect(r.status).toBe(200);
    const [e] = await eventsOf(c);
    expect(r.body).toMatchObject({ stage: { stage: 'connected' }, previousStage: 'new', eventId: e!.id, automation: null, stillRunning: null });
    expect(e).toMatchObject({ from_stage: 'new', to_stage: 'connected', undo_of_event_id: null });
  });

  it('R-STG-5 E766 two identical posts (a double tap, a refresh) make one stage event and one decision, and both answer the same thing', async () => {
    const c = await newContact(agent);
    const first = await post(agent, c, { stage: 'active' });
    const again = await post(agent, c, { stage: 'active' });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(first.body.automation).toEqual({ started: 'Buyer plan' });
    // the repeat answers the stored decision of the event that put the person in this stage, not null
    expect(again.body).toMatchObject({ stage: { stage: 'active' }, previousStage: 'active', eventId: first.body.eventId, automation: { started: 'Buyer plan' } });
    expect(await eventsOf(c)).toHaveLength(1);
    expect(await decisionsOf(h, c)).toHaveLength(1);
    expect(await enrollmentsOf(h, c)).toHaveLength(1);
    // the same at the same moment: one of them changes the stage, neither fails, still one of each
    const d = await newContact(agent);
    const both = await Promise.all([post(agent, d, { stage: 'active' }), post(agent, d, { stage: 'active' })]);
    expect(both.map((x) => x.status)).toEqual([200, 200]);
    expect(new Set(both.map((x) => x.body.eventId)).size).toBe(1);
    expect(both.map((x) => x.body.automation)).toEqual([{ started: 'Buyer plan' }, { started: 'Buyer plan' }]);
    expect(await eventsOf(d)).toHaveLength(1);
    expect(await decisionsOf(h, d)).toHaveLength(1);
    expect(await enrollmentsOf(h, d)).toHaveLength(1);
  });

  it('R-STG-5 E766 a repeat with the row version of the first post is the same request again, not a stale edit; a different stage with a stale version still is', async () => {
    const c = await newContact(agent);
    const rv = (await call<{ details: { rowVersion: number } }>(agent, 'GET', `/contacts/${c}/details`)).body.details.rowVersion;
    const first = await post(agent, c, { stage: 'active', rowVersion: rv });
    const again = await post(agent, c, { stage: 'active', rowVersion: rv });
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(again.body).toMatchObject({ eventId: first.body.eventId, automation: first.body.automation, rowVersion: first.body.rowVersion });
    expect(await eventsOf(c)).toHaveLength(1);
    expect((await post(agent, c, { stage: 'nurture', rowVersion: rv })).code).toBe('STALE_CONTACT');
    expect(await stageOf(c)).toBe('active');
  });

  it('R-STG-5 a repeat of a change whose plan did not start answers that stored reason; a person who never changed stage has nothing stored', async () => {
    const c = await newContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    const first = await post(agent, c, { stage: 'active' });
    expect(first.body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
    expect((await post(agent, c, { stage: 'active' })).body).toMatchObject({ eventId: first.body.eventId, automation: { skipped: 'cannot_be_reached', plan: 'Buyer plan' } });
    const fresh = await newContact(agent);
    expect((await post(agent, fresh, { stage: 'new' })).body).toMatchObject({ stage: { stage: 'new' }, previousStage: 'new', eventId: null, automation: null, stillRunning: null });
    expect(await eventsOf(fresh)).toHaveLength(0);
  });
});

describe('an undo never starts a plan (R-STG-5)', () => {
  it('R-STG-5 E764 an undo after a plan started leaves the plan running, starts nothing, and says so; stopping it afterwards is a separate step that works', async () => {
    const c = await newContact(agent);
    const change = await post(agent, c, { stage: 'active' });
    expect(change.body.automation).toEqual({ started: 'Buyer plan' });
    const [live] = await enrollmentsOf(h, c);
    const undo = await post(agent, c, { stage: 'new', undoOf: change.body.eventId });
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ stage: { stage: 'new' }, previousStage: 'active', automation: null, stillRunning: { enrollmentId: live!.id, plan: 'Buyer plan', canStop: true } });
    expect(undo.body.eventId).not.toBe(change.body.eventId);
    // the stage went back; the plan did not stop and nothing new started
    expect(await stageOf(c)).toBe('new');
    expect((await enrollmentsOf(h, c)).map((e) => [e.id, e.state])).toEqual([[live!.id, 'active']]);
    expect((await eventsOf(c)).map((e) => [e.to_stage, e.undo_of_event_id])).toEqual([['active', null], ['new', change.body.eventId]]);
    // stopping the plan is its own action
    expect((await call(agent, 'POST', `/enrollments/${live!.id}/stop`, {})).status).toBe(200);
    expect((await enrollmentsOf(h, c)).map((e) => e.state)).toEqual(['stopped']);
  });

  it('R-STG-5 E764 an undo back INTO a stage that has a plan does not start it: the decision is skipped with reason undo; the same move without undoOf starts it', async () => {
    const setUp = async () => {
      const c = await newContact(agent);
      await post(agent, c, { stage: 'active' });
      const [e] = await enrollmentsOf(h, c);
      expect((await call(agent, 'POST', `/enrollments/${e!.id}/stop`, {})).status).toBe(200);
      const away = await post(agent, c, { stage: 'connected' });
      return { c, away: away.body.eventId! };
    };
    const a = await setUp();
    const undo = await post(agent, a.c, { stage: 'active', undoOf: a.away });
    expect(undo.status).toBe(200);
    expect(undo.body).toMatchObject({ stage: { stage: 'active' }, previousStage: 'connected', automation: { skipped: 'undo', plan: 'Buyer plan' }, stillRunning: null });
    expect((await decisionsOf(h, a.c)).find((d) => d.stage_event_id === undo.body.eventId)).toMatchObject({ outcome: 'skipped', reason: 'undo', playbook_id: pb.buyer.id, enrollment_id: null });
    expect((await enrollmentsOf(h, a.c)).map((e) => e.state)).toEqual(['stopped']);
    expect(await scanPending(h, w.tenantId)).not.toContain(undo.body.eventId);
    // a replay of the undo (a double tap) answers the same stored result and writes nothing more
    const again = await post(agent, a.c, { stage: 'active', undoOf: a.away });
    expect(again.body).toMatchObject({ eventId: undo.body.eventId, automation: { skipped: 'undo', plan: 'Buyer plan' }, stillRunning: null });
    expect(await eventsOf(a.c)).toHaveLength(3);
    // the contrast: the same move as an ordinary stage change starts the plan
    const b = await setUp();
    const plain = await post(agent, b.c, { stage: 'active' });
    expect(plain.body.automation).toEqual({ started: 'Buyer plan' });
  });

  it('R-STG-5 the undo is on the stage event itself, so the worker decides it the same way when the request could not (a crash after the change committed)', async () => {
    const c = await newContact(agent);
    await post(agent, c, { stage: 'active' });
    const [e] = await enrollmentsOf(h, c);
    await call(agent, 'POST', `/enrollments/${e!.id}/stop`, {});
    const away = (await post(agent, c, { stage: 'connected' })).body.eventId!;
    // what the route's transaction does, without the request path's reconcile after it
    const undoEvent = await withTenantTx(agent.actor(), async (tx) => {
      await sql`SELECT set_config('app.stage_undo_of', ${away}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = 'active' WHERE tenant_id = app.tenant_id() AND id = ${c}`.execute(tx);
      return (await sql<{ id: string; undo_of_event_id: string | null }>`SELECT id, undo_of_event_id FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${c} ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx)).rows[0]!;
    }, { db: h.database });
    expect(undoEvent.undo_of_event_id).toBe(away);
    expect(await scanPending(h, w.tenantId)).toContain(undoEvent.id);
    expect((await reconcileAsJob(h, w.tenantId, undoEvent.id)).automation).toEqual({ skipped: 'undo', plan: 'Buyer plan' });
    expect((await enrollmentsOf(h, c)).map((x) => x.state)).toEqual(['stopped']);
  });

  it('R-STG-5 E769 the plan left running is named only to a viewer who may see it, and canStop is the stop route\'s own answer', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/collaborators`, { userId: agent.userId, role: 'co_agent' })).status).toBe(200);
    const change = await post(agent, c, { stage: 'closed' });
    expect(change.body.automation).toEqual({ started: "the owner's plan" });
    const [live] = await enrollmentsOf(h, c);
    const undo = await post(agent, c, { stage: 'new', undoOf: change.body.eventId });
    expect(JSON.stringify(undo.body)).not.toContain(SECRET_NAME);
    expect(undo.body.stillRunning).toEqual({ enrollmentId: live!.id, plan: "the owner's plan", canStop: true });
    expect((await call(agent, 'POST', `/enrollments/${live!.id}/stop`, {})).status).toBe(200);
  });
});

describe('undoOf must be this person\'s most recent stage change (R-STG-5)', () => {
  it('R-STG-5 E765 a forged undoOf (another person\'s event, another team\'s, an older one, an unknown one, or a stage it did not come from) is refused STAGE_UNDO_INVALID and changes nothing', async () => {
    const c = await newContact(agent);
    const first = (await post(agent, c, { stage: 'connected' })).body.eventId!;
    const latest = (await post(agent, c, { stage: 'active' })).body.eventId!;
    const other = await newContact(agent);
    const otherEvent = (await post(agent, other, { stage: 'active' })).body.eventId!;
    const elsewhere = await commsWorld(h, { agents: 1 });
    const foreignContact = await newContact(elsewhere.agents[0]!);
    const foreignEvent = (await post(elsewhere.agents[0]!, foreignContact, { stage: 'active' })).body.eventId!;
    const before = { stage: await stageOf(c), events: await eventsOf(c), decisions: await decisionsOf(h, c), enrollments: await enrollmentsOf(h, c) };
    const tries: [string, Record<string, unknown>][] = [
      ['another person\'s event', { stage: 'connected', undoOf: otherEvent }],
      ['another team\'s event', { stage: 'connected', undoOf: foreignEvent }],
      ['an older event of this person', { stage: 'new', undoOf: first }],
      ['an unknown event', { stage: 'connected', undoOf: randomUUID() }],
      ['the latest event, but not back to the stage it came from', { stage: 'nurture', undoOf: latest }],
      ['the latest event, to the stage the person is already in', { stage: 'active', undoOf: latest }],
    ];
    for (const [name, body] of tries) {
      const r = await post(agent, c, body);
      expect(r.status, name).toBe(409);
      expect(r.code, name).toBe('STAGE_UNDO_INVALID');
    }
    expect((await post(agent, c, { stage: 'connected', undoOf: 'not-a-uuid' })).status).toBe(422);
    expect({ stage: await stageOf(c), events: await eventsOf(c), decisions: await decisionsOf(h, c), enrollments: await enrollmentsOf(h, c) }).toEqual(before);
    // the real undo of the latest change still works afterwards
    expect((await post(agent, c, { stage: 'connected', undoOf: latest })).status).toBe(200);
  });

  it('R-STG-5 the database keeps the mark only for a true undo: a change that names an event it does not reverse is an ordinary stage change', async () => {
    const c = await newContact(agent);
    const first = (await post(agent, c, { stage: 'connected' })).body.eventId!;
    const other = await newContact(agent);
    const otherEvent = (await post(agent, other, { stage: 'active' })).body.eventId!;
    const mark = async (to: string, undoOf: string) =>
      withTenantTx(agent.actor(), async (tx) => {
        await sql`SELECT set_config('app.stage_undo_of', ${undoOf}, true)`.execute(tx);
        await sql`UPDATE contacts SET stage = ${to} WHERE tenant_id = app.tenant_id() AND id = ${c}`.execute(tx);
        return (await sql<{ u: string | null }>`SELECT undo_of_event_id AS u FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${c} ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx)).rows[0]!.u;
      }, { db: h.database });
    expect(await mark('nurture', otherEvent)).toBeNull(); // another person's event
    expect(await mark('lost', first)).toBeNull(); // not the latest, and not a reversal
    expect(await mark('new', 'not-a-uuid')).toBeNull();
    // the system (an import) never marks an undo
    const latest = (await eventsOf(c)).at(-1)!;
    const sys = await withTenantTx(systemActor(w.tenantId, 'import'), async (tx) => {
      await sql`SELECT set_config('app.stage_undo_of', ${latest.id}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = ${latest.from_stage} WHERE tenant_id = app.tenant_id() AND id = ${c}`.execute(tx);
      return (await sql<{ u: string | null }>`SELECT undo_of_event_id AS u FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${c} ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx)).rows[0]!.u;
    }, { db: h.database });
    expect(sys).toBeNull();
  });

  it('R-STG-5 anyone who may change the stage may undo the latest change (a Team Lead undoing the agent\'s); the stage rule and the permission still apply', async () => {
    const c = await newContact(agent);
    const change = await post(agent, c, { stage: 'active' });
    const undo = await post(tl, c, { stage: 'new', undoOf: change.body.eventId });
    expect(undo.status).toBe(200);
    expect(undo.body.stillRunning).toMatchObject({ plan: 'Buyer plan', canStop: true });
    // an agent who does not see the person gets 404, with or without undoOf
    const latest = (await eventsOf(c)).at(-1)!.id;
    expect((await post(agent2, c, { stage: 'active', undoOf: latest })).status).toBe(404);
    expect(await stageOf(c)).toBe('new');
  });
});

describe('the decision itself: an undo is skipped before every other condition (R-STG-5)', () => {
  const plan: StagePlaybook = { id: '00000000-0000-4000-8000-000000000001', name: 'Buyer plan', scope: 'team', ownerUserId: null, approvedVersionId: '00000000-0000-4000-8000-000000000002' };
  const ok: StageEntryFacts = { actorKind: 'user', protectedAudience: false, toStage: 'active', contact: { exists: true, deleted: false, merged: false, stage: 'active', ownerUserId: 'u1' }, changerSeesDetail: true, candidates: [plan], liveEnrollment: false, reachable: true, sourceRefusal: null };

  it('R-STG-5 facts that would start a plan skip with reason undo when the event is an undo; without the mark they start', () => {
    expect(decideStageEntry(ok)).toMatchObject({ kind: 'start' });
    expect(decideStageEntry({ ...ok, undo: false })).toMatchObject({ kind: 'start' });
    expect(decideStageEntry({ ...ok, undo: true })).toEqual({ kind: 'skip', reason: 'undo', playbook: plan });
    // a stage no plan names has nothing to skip
    expect(decideStageEntry({ ...ok, undo: true, candidates: [] })).toEqual({ kind: 'none' });
  });

  it('R-STG-5 property: whatever else is true, an undo never starts a plan', () => {
    const facts = fc.record({
      actorKind: fc.constantFrom('user' as const, 'system' as const, 'support' as const, 'none' as const),
      protectedAudience: fc.boolean(),
      toStage: fc.constantFrom('new', 'active', 'nurture'),
      contact: fc.record({ exists: fc.boolean(), deleted: fc.boolean(), merged: fc.boolean(), stage: fc.constantFrom('new', 'active', 'nurture'), ownerUserId: fc.constantFrom<string | null>('u1', 'u2', null) }),
      changerSeesDetail: fc.boolean(),
      candidates: fc.constantFrom<StagePlaybook[]>([plan], [{ ...plan, approvedVersionId: null }], []),
      liveEnrollment: fc.boolean(),
      reachable: fc.boolean(),
      aiIsaActive: fc.boolean(),
      sourceRefusal: fc.constantFrom<StageEntryFacts['sourceRefusal']>(null, 'SOURCE_NO_AUTOMATED_CONTACT', 'SOURCE_UNCLASSIFIED'),
    });
    fc.assert(
      fc.property(facts, (f) => {
        const d = decideStageEntry({ ...f, undo: true });
        expect(d.kind).not.toBe('start');
        // a person's undo of a stage a plan names always says "undo", never another reason
        if (f.actorKind === 'user' && f.candidates.length > 0) expect(d).toMatchObject({ kind: 'skip', reason: 'undo' });
      }),
      { numRuns: 1000 },
    );
  });
});
