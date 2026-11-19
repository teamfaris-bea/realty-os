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
import { SKIP_REASONS, reachableOn, unreachableCause } from './decide.js';
import { changerView, decideEntry, stageChangerOf } from './reconcile.js';
import { skipSentence } from './sentences.js';
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

  // b19 fix pass L6: "cannot be reached" is one decision reason with three real causes, and the person is told which.
  // The cause is read with the decision's own facts (reach.ts reachOfVersion: the channels the plan messages on and
  // the gate's reasons on each), kept with the decision row (unreachable_cause, migration 0105), and worded by one
  // function for the preview (will), the stage route's answer and the status (did). No new decision reason code.
  it('L6 E787 a person who texted STOP is told THAT is the reason, before the change (the preview), in the change\'s answer and afterwards on the status; the decision row keeps the cause', async () => {
    const phone = randomPhone();
    const c = await newContact(agent, { phones: [phone] });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const p = await preview(agent, c, 'active');
    expect(p.body.wontStart).toMatchObject({ reason: 'cannot_be_reached', sentence: 'Buyer plan will not start: they texted STOP or otherwise opted out, and a plan never messages over an opt-out.' });
    const r = await changeStage(agent, c, 'active');
    expect(r.body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
    const did = 'Buyer plan did not start: they texted STOP or otherwise opted out, and a plan never messages over an opt-out.';
    expect(r.body.automationSentence).toBe(did);
    const st = await call<{ lastStageChange: { decision: { reason: string; sentence: string } } }>(agent, 'GET', `/contacts/${c}/playbook-status`);
    expect(st.body.lastStageChange.decision).toMatchObject({ reason: 'cannot_be_reached', sentence: did });
    expect((await h.su.query('SELECT reason, unreachable_cause FROM stage_automation_decisions WHERE contact_id = $1', [c])).rows).toEqual([{ reason: 'cannot_be_reached', unreachable_cause: 'opted_out' }]);
    // a retry of the same stage answers the stored decision in the same words
    expect((await changeStage(agent, c, 'active')).body.automationSentence).toBe(did);
    expect(did).not.toMatch(/do not contact|no phone/);
  });

  it('L6 E787 a person marked do-not-contact is told that, and a person with no phone this plan could text is told that: each in the preview, the answer, the status and the decision row', async () => {
    const dnc = await newContact(agent);
    expect((await call(agent, 'POST', `/contacts/${dnc}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    const emailOnly = await newContact(agent, { phones: [], emails: [`only-${randomUUID().slice(0, 8)}@example.test`] });
    for (const [c, cause, why] of [
      [dnc, 'do_not_contact', 'they are marked do not contact.'],
      [emailOnly, 'no_address', 'they have no phone or email this plan could use.'],
    ] as const) {
      const p = await preview(agent, c, 'active');
      expect(p.body.wontStart, cause).toMatchObject({ reason: 'cannot_be_reached', sentence: `Buyer plan will not start: ${why}` });
      const r = await changeStage(agent, c, 'active');
      expect(r.body.automationSentence, cause).toBe(`Buyer plan did not start: ${why}`);
      const st = await call<{ lastStageChange: { decision: { sentence: string } } }>(agent, 'GET', `/contacts/${c}/playbook-status`);
      expect(st.body.lastStageChange.decision.sentence, cause).toBe(`Buyer plan did not start: ${why}`);
      expect((await h.su.query('SELECT unreachable_cause FROM stage_automation_decisions WHERE contact_id = $1', [c])).rows, cause).toEqual([{ unreachable_cause: cause }]);
      expect(await enrollmentsOf(h, c), cause).toHaveLength(0);
    }
  });

  it('L6 E787 the worker decides the same cause when the request path could not (the cause is on the decision row, not in the request)', async () => {
    const phone = randomPhone();
    const c = await newContact(agent, { phones: [phone] });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const ev = await rawStageChange(h, agent, c, 'active');
    await reconcileAsJob(h, w.tenantId, ev);
    expect((await h.su.query('SELECT reason, unreachable_cause FROM stage_automation_decisions WHERE stage_event_id = $1', [ev])).rows).toEqual([{ reason: 'cannot_be_reached', unreachable_cause: 'opted_out' }]);
    const st = await call<{ lastStageChange: { decision: { sentence: string } } }>(agent, 'GET', `/contacts/${c}/playbook-status`);
    expect(st.body.lastStageChange.decision.sentence).toBe('Buyer plan did not start: they texted STOP or otherwise opted out, and a plan never messages over an opt-out.');
  });

  it('L6 E787 the cause is the pure reading of the channels the plan messages on; a decision stored without one keeps the three-way sentence, and the database refuses a cause on any other reason', async () => {
    const stop = { hasAddress: true, reasons: ['CONSENT_REVOKED'] };
    const suppressed = { hasAddress: true, reasons: ['SUPPRESSED'] };
    const dnc = { hasAddress: true, reasons: ['PERSON_DO_NOT_CONTACT', 'CONSENT_REVOKED'] };
    const wrong = { hasAddress: true, reasons: ['WRONG_NUMBER'] };
    const none = { hasAddress: false, reasons: [] };
    const fine = { hasAddress: true, reasons: ['QUIET_HOURS'] };
    expect(unreachableCause([stop])).toBe('opted_out');
    expect(unreachableCause([suppressed, none])).toBe('opted_out');
    expect(unreachableCause([dnc, none])).toBe('do_not_contact');
    expect(unreachableCause([stop, dnc])).toBe('do_not_contact');
    expect(unreachableCause([wrong])).toBe('wrong_number');
    expect(unreachableCause([wrong, stop])).toBe('opted_out');
    expect(unreachableCause([none, none])).toBe('no_address');
    // reachable on some channel, or a plan that messages nobody: no cause
    expect(unreachableCause([stop, fine])).toBeNull();
    expect(unreachableCause([])).toBeNull();
    for (const ch of [[stop], [dnc, none], [wrong], [none], [stop, fine], []]) expect(unreachableCause(ch) === null, JSON.stringify(ch)).toBe(reachableOn(ch));
    // words
    expect(skipSentence('cannot_be_reached', 'P', 'did', undefined, 'wrong_number')).toBe('P did not start: their number was reported as a wrong number.');
    expect(skipSentence('cannot_be_reached', 'P', 'did')).toBe('P did not start: they opted out, are marked do not contact, or have no phone or email this plan could use.');
    expect(skipSentence('cannot_be_reached', 'P', 'did', undefined, null)).toBe(skipSentence('cannot_be_reached', 'P', 'did'));
    // a cause never rewords another reason
    expect(skipSentence('plan_not_approved', 'P', 'did', undefined, 'opted_out')).toBe(skipSentence('plan_not_approved', 'P', 'did'));
    // the database: a cause only with cannot_be_reached, and only one of the four
    const c = await newContact(agent);
    const ev = await rawStageChange(h, agent, c, 'connected');
    const insert = (reason: string, cause: string | null) => h.su.query(`INSERT INTO stage_automation_decisions (tenant_id, stage_event_id, contact_id, to_stage, outcome, reason, playbook_id, unreachable_cause) VALUES ($1, $2, $3, 'connected', 'skipped', $4, $5, $6)`, [w.tenantId, ev, c, reason, pb.buyer.id, cause]);
    await expect(insert('plan_not_approved', 'opted_out')).rejects.toThrow(/unreachable_cause/);
    await expect(insert('cannot_be_reached', 'because')).rejects.toThrow(/unreachable_cause/);
    await insert('cannot_be_reached', null);
    const st = await call<{ lastStageChange: { decision: { sentence: string } } }>(agent, 'GET', `/contacts/${c}/playbook-status`);
    expect(st.body.lastStageChange.decision.sentence).toBe('Buyer plan did not start: they opted out, are marked do not contact, or have no phone or email this plan could use.');
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
        const e = (await sql<{ contact_id: string; to_stage: string; actor_kind: 'user' | 'system' | 'support' | 'none'; bulk: boolean; undo: boolean }>`
          SELECT contact_id, to_stage, actor_kind, bulk_action_id IS NOT NULL AS bulk, undo_of_event_id IS NOT NULL AS undo FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND id = ${eventId}`.execute(tx)).rows[0]!;
        return decideEntry(tx, { contactId: e.contact_id, toStage: e.to_stage, actorKind: e.actor_kind, bulk: force?.bulk ?? e.bulk, undo: e.undo, playbooksOf: { eventId }, assumeEntered: false }, view, now);
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

    // the change is the undo of the person's last stage change (R-STG-5; the mark is on the event, migration 0105)
    const undone = await newContact(agent);
    const away = await rawStageChange(h, agent, undone, 'connected');
    const uev = await withTenantTx(agent.actor(), async (tx) => {
      await sql`SELECT set_config('app.stage_undo_of', ${away}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = 'new' WHERE tenant_id = app.tenant_id() AND id = ${undone}`.execute(tx);
      await sql`SELECT set_config('app.stage_undo_of', '', true)`.execute(tx);
      return (await sql<{ id: string }>`SELECT id FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${undone} AND undo_of_event_id = ${away}`.execute(tx)).rows[0]!.id;
    }, { db: h.database });
    // "new" has no plan in this world, so give the undo a stage that has one: undo a move away from Active
    const undone2 = await newContact(agent);
    await rawStageChange(h, agent, undone2, 'active');
    const away2 = await rawStageChange(h, agent, undone2, 'connected');
    const uev2 = await withTenantTx(agent.actor(), async (tx) => {
      await sql`SELECT set_config('app.stage_undo_of', ${away2}, true)`.execute(tx);
      await sql`UPDATE contacts SET stage = 'active' WHERE tenant_id = app.tenant_id() AND id = ${undone2}`.execute(tx);
      return (await sql<{ id: string }>`SELECT id FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${undone2} AND undo_of_event_id = ${away2}`.execute(tx)).rows[0]!.id;
    }, { db: h.database });
    expect((await decideEvent(uev)).kind).toBe('none');
    await check('undo', undone2, uev2);

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
      undo: ['undo', 'undo'],
    });
  });

  it('R-STG-3 every skip reason the decision has is named by one of the tests above (a new reason needs its own preview test)', () => {
    const covered = ['cannot_be_reached', 'source_no_automated_contact', 'source_unclassified', 'plan_not_approved', 'already_in_a_plan', 'ai_isa_active', 'not_a_person_change', 'stage_changed_again', 'not_visible', 'person_removed', 'protected_audience', 'undo'];
    expect([...SKIP_REASONS].filter((r) => !covered.includes(r))).toEqual([]);
  });
});

describe('already in a plan: the preview names the plan they are in and says the new one will not start (R-STG-3)', () => {
  type Named = { wontStart: { plan: string; reason: string; sentence: string; alreadyIn: { enrollmentId: string; plan: string } | null } | null; keepsRunning: { enrollmentId: string; plan: string; state: string } | null };
  const named = (by: TestClient, contactId: string, to: string) => call<Named>(by, 'GET', `/contacts/${contactId}/stage/preview?to=${to}`);

  it('R-STG-3 E763 the running plan is named, the new one is said not to start, and the change then leaves the first running and starts nothing', async () => {
    const c = await newContact(agent);
    expect((await changeStage(agent, c, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    const [live] = await enrollmentsOf(h, c);
    const p = (await named(agent, c, 'under_contract')).body;
    expect(p.wontStart).toEqual({
      plan: 'Contract plan', reason: 'already_in_a_plan',
      alreadyIn: { enrollmentId: live!.id, plan: 'Buyer plan' },
      sentence: 'Contract plan will not start: they are already in Buyer plan, and a person is in one plan at a time. Stop Buyer plan first if you want Contract plan.',
    });
    expect(p.keepsRunning).toMatchObject({ enrollmentId: live!.id, plan: 'Buyer plan', state: 'active' });
    // a paused plan is still the plan they are in
    expect((await call(agent, 'POST', `/enrollments/${live!.id}/pause`, {})).status).toBe(200);
    const paused = (await named(agent, c, 'under_contract')).body;
    expect(paused.wontStart).toMatchObject({ reason: 'already_in_a_plan', alreadyIn: { enrollmentId: live!.id, plan: 'Buyer plan' } });
    expect(paused.keepsRunning).toMatchObject({ state: 'paused' });
    // and that is what happens
    const r = await changeStage(agent, c, 'under_contract');
    expect(r.body.automation).toEqual({ skipped: 'already_in_a_plan', plan: 'Contract plan' });
    expect((await enrollmentsOf(h, c)).map((e) => [e.id, e.state])).toEqual([[live!.id, 'paused']]);
  });

  it('R-STG-3 E763 E769 R-PERM-12 a running plan the viewer may not see is named "the owner\'s plan", in the field and in the sentence', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/collaborators`, { userId: agent.userId, role: 'co_agent' })).status).toBe(200);
    expect((await changeStage(agent2, c, 'closed')).body.automation).toEqual({ started: SECRET_NAME });
    const [live] = await enrollmentsOf(h, c);
    const theirs = await named(agent, c, 'active');
    expect(JSON.stringify(theirs.body)).not.toContain(SECRET_NAME);
    expect(theirs.body.wontStart).toEqual({
      plan: 'Buyer plan', reason: 'already_in_a_plan',
      alreadyIn: { enrollmentId: live!.id, plan: "the owner's plan" },
      sentence: "Buyer plan will not start: they are already in the owner's plan, and a person is in one plan at a time. Stop the owner's plan first if you want Buyer plan.",
    });
    // the plan's owner is told its name
    expect((await named(agent2, c, 'active')).body.wontStart).toMatchObject({ alreadyIn: { plan: SECRET_NAME }, sentence: expect.stringContaining(`they are already in ${SECRET_NAME}`) });
  });

  it('R-STG-3 a plan that will not start for any other reason names no running plan', async () => {
    const c = await newContact(agent);
    expect((await named(agent, c, 'nurture')).body.wontStart).toMatchObject({ reason: 'plan_not_approved', alreadyIn: null });
    expect((await named(agent, c, 'active')).body.wontStart).toBeNull();
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
