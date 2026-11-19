// GET /contacts/:id/stage/preview (R-STG-3; E762, E763, E769): what a stage change would start, not start or leave
// running, shown BEFORE the agent saves it. Through the real server as app_user; the superuser pool only reads back
// and makes fixtures that have no application path here. Fakes only.
//
// The preview decides with the function the change decides with (reconcile.ts decideEntry: readEntryFacts, then the
// pure decideStageEntry), so "preview equals outcome" is asserted for every skip reason the decision has: through the
// route for the reasons a single person's stage change can meet, and on the shared function itself for the reasons
// only an import, a bulk action, a merge or a race produce.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { smsStep } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { call, freshReauth, inboundSms, randomPhone } from '../comms/testing.js';
import { type IsaWorld, isaLead, isaWorld, startCare } from '../isa/testing.js';
import { command, contactState, importedPerson, intake } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { SKIP_REASONS } from './decide.js';
import { changerView, decideEntry, stageChangerOf } from './reconcile.js';
import { changeStage, decisionsOf, enrollmentsOf, newContact, playbook, rawStageChange, reconcileAsJob, setStage } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;
let agent: TestClient; // opted in to AI care (isaWorld); team plans only
let agent2: TestClient; // has a private plan of their own
let tl: TestClient;
let tc: TestClient;
let marked: string;
const pb = {} as Record<'buyer' | 'nurtureDraft' | 'contract' | 'secret' | 'later', { id: string; versionId: string }>;
const SECRET_NAME = "Bo's private closing plan";

interface Preview {
  allowed: boolean;
  lockedReason: string | null;
  sameStage: boolean;
  starts: { plan: string; firstStep: { channel: string; dueAt: string } | null } | null;
  wontStart: { plan: string; reason: string; sentence: string } | null;
  keepsRunning: { enrollmentId: string; plan: string; state: string; canStop: boolean } | null;
  stops: unknown[];
  aiCare: string;
  tasks: string;
}
const preview = (by: TestClient, contactId: string, to: string) => call<Preview>(by, 'GET', `/contacts/${contactId}/stage/preview?to=${to}`);

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  tc = await h.invite(w.owner, 'tc');
  // team plans (Owner): Active → "Buyer plan" (approved); Nurture → "Nurture plan" (draft only); Under contract →
  // "Contract plan" (approved); Lost → "Check back plan" (approved, first text an hour after the plan starts).
  // agent2's own plan: Closed → a private plan no other agent can see.
  pb.buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  pb.nurtureDraft = await playbook(w.owner, { scope: 'team', name: 'Nurture plan', approve: false });
  pb.contract = await playbook(w.owner, { scope: 'team', name: 'Contract plan' });
  pb.secret = await playbook(agent2, { scope: 'agent', name: SECRET_NAME });
  const later = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', {
    kind: 'nurture', scope: 'team', name: 'Check back plan',
    steps: [smsStep({ key: 'check_back', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking back in.', slots: ['first_name'], offsetSeconds: 3600 })],
  });
  const v = later.body.playbook.versions[0]!;
  expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  pb.later = { id: later.body.playbook.id, versionId: v.id };
  for (const [p, s, by] of [[pb.buyer, 'active', w.owner], [pb.nurtureDraft, 'nurture', w.owner], [pb.contract, 'under_contract', w.owner], [pb.secret, 'closed', agent2], [pb.later, 'lost', w.owner]] as const) {
    const r = await setStage(by, p.id, s);
    if (r.status !== 200) throw new Error(`set stage ${s}: ${r.status} ${JSON.stringify(r.body)}`);
  }
  // a made-up lead source the Owner marked "No automated contact for leads from this source"
  const src = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Partner referral (test)', kind: 'portal' });
  marked = src.body.source.id;
  await freshReauth(h, w.owner);
  expect((await call(w.owner, 'PUT', `/lead-sources/${marked}/ai-care`, { noAiCare: true })).status).toBe(200);
}, 300_000);
afterAll(async () => {
  await h?.close();
});

/** Exact row counts of every table of the application schema (the preview must change none of them). */
async function tableCounts(): Promise<Record<string, number>> {
  const tables = (await h.su.query<{ t: string }>(`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1`)).rows.map((x) => x.t);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (await h.su.query<{ n: number }>(`SELECT count(*)::int AS n FROM public."${t}"`)).rows[0]!.n;
  return out;
}

/** The decision row the stage change just wrote for this person (the newest), or null. */
async function previewThenChange(by: TestClient, contactId: string, to: string) {
  const p = await preview(by, contactId, to);
  expect(p.status).toBe(200);
  const before = new Set((await decisionsOf(h, contactId)).map((d) => d.stage_event_id));
  const enrolledBefore = (await enrollmentsOf(h, contactId)).length;
  const r = await changeStage(by, contactId, to);
  expect(r.status).toBe(200);
  const d = (await decisionsOf(h, contactId)).find((x) => !before.has(x.stage_event_id)) ?? null;
  return { p: p.body, automation: r.body.automation, d, newEnrollments: (await enrollmentsOf(h, contactId)).length - enrolledBefore };
}

/** Preview equals outcome for a skip: the same reason in the preview, in the stage route's answer and in the decision row. */
async function expectSameSkip(by: TestClient, contactId: string, to: string, reason: string, plan: string) {
  const x = await previewThenChange(by, contactId, to);
  expect(x.p).toMatchObject({ allowed: true, lockedReason: null, starts: null, wontStart: { plan, reason, sentence: expect.stringMatching(/\.$/) }, stops: [], aiCare: 'unchanged', tasks: 'unchanged' });
  expect(x.d).toMatchObject({ outcome: 'skipped', reason: x.p.wontStart!.reason });
  expect(x.automation).toEqual({ skipped: x.p.wontStart!.reason, plan: x.p.wontStart!.plan });
  expect(x.newEnrollments).toBe(0);
  return x;
}

describe('the preview says what the change will start (R-STG-3)', () => {
  it('R-STG-3 a stage with an approved plan: the preview names the plan and its first step, and the change then starts exactly that plan', async () => {
    const c = await newContact(agent);
    const t0 = Date.now();
    const x = await previewThenChange(agent, c, 'active');
    expect(x.p).toEqual({
      allowed: true, lockedReason: null, sameStage: false,
      starts: { plan: 'Buyer plan', firstStep: { channel: 'sms', dueAt: expect.any(String) } },
      wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged',
    });
    // the first step of this plan is due as soon as the plan starts
    expect(Math.abs(Date.parse(x.p.starts!.firstStep!.dueAt) - t0)).toBeLessThan(60_000);
    expect(x.automation).toEqual({ started: x.p.starts!.plan });
    expect(x.d).toMatchObject({ outcome: 'started', reason: null, playbook_id: pb.buyer.id });
    expect(x.newEnrollments).toBe(1);
  });

  it('R-STG-3 the first step is the runner\'s own next step: a plan whose first text waits an hour says so', async () => {
    const c = await newContact(agent);
    const t0 = Date.now();
    const p = await preview(agent, c, 'lost');
    expect(p.body.starts).toEqual({ plan: 'Check back plan', firstStep: { channel: 'sms', dueAt: expect.any(String) } });
    const due = Date.parse(p.body.starts!.firstStep!.dueAt) - t0;
    expect(due).toBeGreaterThan(3600_000 - 60_000);
    expect(due).toBeLessThan(3600_000 + 60_000);
  });

  it('R-STG-3 a stage no plan names: nothing starts and nothing is refused; the same stage again changes nothing', async () => {
    const c = await newContact(agent);
    const p = await preview(agent, c, 'connected');
    expect(p.body).toEqual({ allowed: true, lockedReason: null, sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged' });
    expect((await changeStage(agent, c, 'connected')).body.automation).toBeNull();
    // previewing the stage the person is already in: the change would be a no-op, so no plan is promised
    expect((await changeStage(agent, c, 'new')).status).toBe(200);
    expect((await changeStage(agent, c, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    const same = await preview(agent, c, 'active');
    expect(same.body).toMatchObject({ allowed: true, sameStage: true, starts: null, wontStart: null, keepsRunning: { plan: 'Buyer plan', state: 'active' } });
  });
});

describe('the preview writes nothing and queues nothing (R-STG-3)', () => {
  it('R-STG-3 no table of the schema gains or loses a row, no job is queued, and the person is unchanged, whether a plan would start or not', async () => {
    const starts = await newContact(agent);
    const phone = randomPhone();
    const stopped = await newContact(agent, { phones: [phone] });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const inPlan = await newContact(agent);
    expect((await changeStage(agent, inPlan, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    const rowOf = async (id: string) => (await h.su.query('SELECT stage, row_version, updated_at, last_human_touch_at, first_touch_at FROM contacts WHERE id = $1', [id])).rows[0];
    const before = await tableCounts();
    const rows = [await rowOf(starts), await rowOf(stopped), await rowOf(inPlan)];
    const jobs = (await h.su.query<{ n: number; m: string | null }>('SELECT count(*)::int AS n, max(id)::text AS m FROM jobs')).rows[0]!;

    expect((await preview(agent, starts, 'active')).body.starts).toMatchObject({ plan: 'Buyer plan' });
    expect((await preview(agent, stopped, 'active')).body.wontStart).toMatchObject({ reason: 'cannot_be_reached' });
    expect((await preview(agent, inPlan, 'under_contract')).body.wontStart).toMatchObject({ reason: 'already_in_a_plan' });
    expect((await preview(agent, starts, 'connected')).body.starts).toBeNull();
    for (let i = 0; i < 3; i++) expect((await preview(tl, starts, 'active')).status).toBe(200);

    expect(await tableCounts()).toEqual(before);
    expect([await rowOf(starts), await rowOf(stopped), await rowOf(inPlan)]).toEqual(rows);
    expect((await h.su.query<{ n: number; m: string | null }>('SELECT count(*)::int AS n, max(id)::text AS m FROM jobs')).rows[0]).toEqual(jobs);
    // nothing was decided, enrolled or sent for the person only previewed
    expect(await decisionsOf(h, starts)).toEqual([]);
    expect(await enrollmentsOf(h, starts)).toEqual([]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_stage_events WHERE contact_id = $1', [starts])).rows[0].n).toBe(0);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [starts])).rows[0].n).toBe(0);
    // and nothing went out to anyone (the STOP itself is the only message these people have)
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = ANY($1::uuid[]) AND direction = 'outbound' AND initiator <> 'system'", [[starts, stopped, inPlan]])).rows[0].n).toBe(0);
  });
});

describe('preview equals outcome, for every reason a plan does not start (R-STG-3)', () => {
  it('R-STG-3 E762 a person who texted STOP: the preview says the plan will not start (cannot_be_reached) and the change writes that reason', async () => {
    const phone = randomPhone();
    const c = await newContact(agent, { phones: [phone] });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const x = await expectSameSkip(agent, c, 'active', 'cannot_be_reached', 'Buyer plan');
    expect(x.p.wontStart!.sentence).toMatch(/opted out|do not contact/i);
  });

  it('R-STG-3 a person marked do-not-contact: cannot_be_reached in the preview and in the decision', async () => {
    const c = await newContact(agent);
    expect((await call(agent, 'POST', `/contacts/${c}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    await expectSameSkip(agent, c, 'active', 'cannot_be_reached', 'Buyer plan');
  });

  it('R-STG-3 R-LSRC-8 a person from a source marked "No automated contact": source_no_automated_contact in the preview and in the decision', async () => {
    const c = await newContact(agent);
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [c, marked]); // fixture only: the intake writes it
    const x = await expectSameSkip(agent, c, 'active', 'source_no_automated_contact', 'Buyer plan');
    expect(x.p.wontStart!.sentence).toMatch(/No automated contact/);
  });

  it('R-STG-3 R-LSRC-9 an imported person whose source nobody reviewed yet: source_unclassified in the preview and in the decision', async () => {
    const c = await newContact(agent);
    await importedPerson(h, w.tenantId, w.owner.userId!, c);
    const x = await expectSameSkip(agent, c, 'active', 'source_unclassified', 'Buyer plan');
    expect(x.p.wontStart!.sentence).toMatch(/import/i);
  });

  it('R-STG-3 a draft-only plan: plan_not_approved in the preview and in the decision; approval is never bypassed', async () => {
    const c = await newContact(agent);
    const x = await expectSameSkip(agent, c, 'nurture', 'plan_not_approved', 'Nurture plan');
    expect(x.p.wontStart!.sentence).toMatch(/approved/);
  });

  it('R-STG-3 a person already in a plan: already_in_a_plan in the preview and in the decision, and the running plan is shown as kept', async () => {
    const c = await newContact(agent);
    expect((await changeStage(agent, c, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    const [live] = await enrollmentsOf(h, c);
    const x = await expectSameSkip(agent, c, 'under_contract', 'already_in_a_plan', 'Contract plan');
    expect(x.p.keepsRunning).toEqual({ enrollmentId: live!.id, plan: 'Buyer plan', state: 'active', canStop: true });
    // a stage change never stops a plan: the one that was running still is
    expect((await enrollmentsOf(h, c)).map((e) => [e.id, e.state])).toEqual([[live!.id, 'active']]);
  });

  it('R-STG-3 R-ISA-2 a person under live AI care: ai_isa_active in the preview and in the decision', async () => {
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    const x = await expectSameSkip(agent, l.id, 'active', 'ai_isa_active', 'Buyer plan');
    expect(x.p.wontStart!.sentence).toMatch(/AI/);
    expect(x.p.aiCare).toBe('unchanged');
  });

  it('R-STG-3 the reasons only an import, a bulk action, a merge or a race produce: the shared decision on the event equals the row the reconcile then writes', async () => {
    const sys = systemActor(w.tenantId, 'assistant');
    /** what the preview's own decision function says about a stage event, read-only, before the reconcile runs */
    const decideEvent = async (eventId: string, force?: { bulk: boolean; view: { sees: boolean; protectedAudience: boolean } }) => {
      const who = await withTenantTx(sys, (tx) => stageChangerOf(tx, eventId), { db: h.database });
      const view = force?.view ?? (who ? await changerView({ db: h.database }, w.tenantId, who) : { sees: false, protectedAudience: false });
      return withTenantTx(sys, async (tx, now) => {
        await sql`SET LOCAL transaction_read_only = on`.execute(tx);
        const e = (await sql<{ contact_id: string; to_stage: string; actor_kind: 'user' | 'system' | 'support' | 'none'; bulk: boolean }>`
          SELECT contact_id, to_stage, actor_kind, bulk_action_id IS NOT NULL AS bulk FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND id = ${eventId}`.execute(tx)).rows[0]!;
        return decideEntry(tx, { contactId: e.contact_id, toStage: e.to_stage, actorKind: e.actor_kind, bulk: force?.bulk ?? e.bulk, playbooksOf: { eventId }, assumeEntered: false }, view, now);
      }, { db: h.database });
    };
    const got: Record<string, [string | null, string | null]> = {};
    const check = async (name: string, contactId: string, eventId: string) => {
      const d = await decideEvent(eventId);
      await reconcileAsJob(h, w.tenantId, eventId);
      const row = (await decisionsOf(h, contactId)).find((x) => x.stage_event_id === eventId) ?? null;
      got[name] = [d.kind === 'skip' ? d.reason : d.kind, row?.reason ?? null];
    };

    // an import (the system) changed the stage
    const imported = await newContact(agent);
    const sysEvent = await withTenantTx(systemActor(w.tenantId, 'import'), async (tx) => {
      await sql`UPDATE contacts SET stage = 'active' WHERE tenant_id = app.tenant_id() AND id = ${imported}`.execute(tx);
      return (await sql<{ id: string }>`SELECT id FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${imported}`.execute(tx)).rows[0]!.id;
    }, { db: h.database });
    await check('not_a_person_change', imported, sysEvent);

    // the stage moved on before the plan could start
    const moved = await newContact(agent);
    const first = await rawStageChange(h, agent, moved, 'active');
    await rawStageChange(h, agent, moved, 'new');
    await check('stage_changed_again', moved, first);

    // whoever changed the stage no longer sees the person (the lead was reassigned)
    const gone = await newContact(agent);
    const ev = await rawStageChange(h, agent, gone, 'active');
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/leads/${gone}/reassign`, { commandId: randomUUID(), toUserId: agent2.userId, reason: 'MANUAL_REASSIGN' })).status).toBe(200);
    await check('not_visible', gone, ev);

    // the person was merged into another record
    const loser = await newContact(agent);
    const survivor = await newContact(agent);
    const lev = await rawStageChange(h, agent, loser, 'active');
    expect((await command(w.owner, survivor, 'merge', { loserId: loser, ownerChoice: agent.userId })).status).toBe(200);
    await check('person_removed', loser, lev);

    // a bulk action whose audience is built from a protected tag made the change (the fact the bulk runner's view
    // carries; bulk/secreview.stageplan.test.ts covers the real bulk path through this same function)
    const bulk = await newContact(agent);
    const bev = await rawStageChange(h, agent, bulk, 'active');
    const view = { sees: true, protectedAudience: true };
    const d = await decideEvent(bev, { bulk: true, view });
    got.protected_audience = [d.kind === 'skip' ? d.reason : d.kind, 'protected_audience'];

    expect(got).toEqual({
      not_a_person_change: ['not_a_person_change', 'not_a_person_change'],
      stage_changed_again: ['stage_changed_again', 'stage_changed_again'],
      not_visible: ['not_visible', 'not_visible'],
      person_removed: ['person_removed', 'person_removed'],
      protected_audience: ['protected_audience', 'protected_audience'],
    });
  });

  it('R-STG-3 every skip reason the decision has is named by one of the tests above (a new reason needs its own preview test)', () => {
    const covered = ['cannot_be_reached', 'source_no_automated_contact', 'source_unclassified', 'plan_not_approved', 'already_in_a_plan', 'ai_isa_active', 'not_a_person_change', 'stage_changed_again', 'not_visible', 'person_removed', 'protected_audience'];
    expect([...SKIP_REASONS].filter((r) => !covered.includes(r))).toEqual([]);
  });
});

describe('who may preview, and what they are shown (R-STG-3)', () => {
  it('R-STG-3 R-PAR-14 a stage the rule would refuse: allowed false with the reason, and no plan is promised', async () => {
    const r = await intake(h, w);
    const st = await contactState(h, r.contactId);
    const owner = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    expect((await command(owner, r.contactId, 'accept', { offerId: st.offer_id, expectedSeq: Number(st.ownership_seq) })).status).toBe(200);
    const p = await preview(owner, r.contactId, 'active');
    expect(p.body).toEqual({ allowed: false, lockedReason: 'STAGE_NEEDS_CONTACT', sameStage: false, starts: null, wontStart: null, keepsRunning: null, stops: [], aiCare: 'unchanged', tasks: 'unchanged' });
    expect((await changeStage(owner, r.contactId, 'active')).code).toBe('STAGE_NEEDS_CONTACT');
    // "attempting" stays open, and a Team Lead is not held by the rule
    expect((await preview(owner, r.contactId, 'attempting')).body).toMatchObject({ allowed: true, lockedReason: null });
    expect((await preview(tl, r.contactId, 'active')).body).toMatchObject({ allowed: true, starts: { plan: 'Buyer plan' } });
  });

  it('R-STG-3 R-PERM-5 the same permission and visibility as the stage route: 404 for whoever could not change the stage, 422 for an unknown stage', async () => {
    const c = await newContact(agent);
    expect((await preview(agent2, c, 'active')).status).toBe(404);
    expect((await preview(tc, c, 'active')).status).toBe(404);
    const elsewhere = await isaWorld(h);
    expect((await preview(elsewhere.owner, c, 'active')).status).toBe(404);
    expect((await preview(agent, randomUUID(), 'active')).status).toBe(404);
    expect((await preview(agent, c, 'parked')).status).toBe(422);
    expect((await call(agent, 'GET', `/contacts/${c}/stage/preview`)).status).toBe(422);
    for (const who of [w.owner, tl]) expect((await preview(who, c, 'active')).status).toBe(200);
    // a merged-away record takes no stage change, so it has no preview either
    const loser = await newContact(agent);
    const survivor = await newContact(agent);
    expect((await command(w.owner, survivor, 'merge', { loserId: loser, ownerChoice: agent.userId })).status).toBe(200);
    expect((await preview(w.owner, loser, 'active')).status).toBe(404);
  });

  it('R-STG-3 E769 R-PERM-12 a plan the viewer may not see is never named: a collaborator is told "the owner\'s plan", before and after', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/collaborators`, { userId: agent.userId, role: 'co_agent' })).status).toBe(200);
    expect((await call(agent, 'GET', `/playbooks/${pb.secret.id}`)).status).toBe(404);
    const mine = await preview(agent2, c, 'closed');
    expect(mine.body.starts).toMatchObject({ plan: SECRET_NAME });
    const theirs = await preview(agent, c, 'closed');
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain(SECRET_NAME);
    expect(theirs.body.starts).toEqual({ plan: "the owner's plan", firstStep: { channel: 'sms', dueAt: expect.any(String) } });
    // the Team Lead sees every plan (playbooks_select), so they are told its name
    expect((await preview(tl, c, 'closed')).body.starts).toMatchObject({ plan: SECRET_NAME });
    // the change says the same thing to the same viewer
    const r = await changeStage(agent, c, 'closed');
    expect(r.body.automation).toEqual({ started: theirs.body.starts!.plan });
    // and the running plan is not named to them afterwards either
    const after = await preview(agent, c, 'active');
    expect(JSON.stringify(after.body)).not.toContain(SECRET_NAME);
    expect(after.body.keepsRunning).toMatchObject({ plan: "the owner's plan", state: 'active' });
    expect(after.body.wontStart).toMatchObject({ plan: 'Buyer plan', reason: 'already_in_a_plan' });
  });
});
