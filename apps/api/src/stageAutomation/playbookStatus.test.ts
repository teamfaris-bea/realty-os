// GET /contacts/:id/playbook-status (R-STG-4; E767, E769): the automated plan a person is in, what it does next and
// when, why it is not moving, who may pause, resume or stop it, and what the last stage change did. Through the real
// server as app_user; the superuser pool only reads back and makes clock fixtures. Fakes only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runJobs, smsStep, stepNow } from '../assistant/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, ownedContact, randomPhone } from '../comms/testing.js';
import { changeStage, enrollmentsOf, newContact, playbook, rawStageChange, reconcileAsJob, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient; // has a private plan of their own
let tl: TestClient;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;
const pb = {} as Record<'buyer' | 'twoStep' | 'secret' | 'draft', { id: string; versionId: string }>;
const SECRET_NAME = "Bo's private closing plan";
const DAY = 86_400_000;

interface Status {
  plan: {
    enrollmentId: string;
    name: string;
    state: string;
    startedBy: { how: string; userId: string | null; displayName: string | null };
    startedAt: string;
    next: { kind: string; channel: string; dueAt: string } | null;
    blocked: { code: string; sentence: string } | null;
    deliveryUnconfirmed: { channel: string; at: string; checking: boolean; sentence: string } | null;
    canPause: boolean;
    canResume: boolean;
    canStop: boolean;
  } | null;
  lastStageChange: { eventId: string; to: string; at: string; pending: boolean; decision: { outcome: string; plan: string; reason: string | null; sentence: string } | null } | null;
}
const status = (by: TestClient, contactId: string) => call<Status>(by, 'GET', `/contacts/${contactId}/playbook-status`);
const act = (by: TestClient, enrollmentId: string, verb: 'pause' | 'resume' | 'stop') => call(by, 'POST', `/enrollments/${enrollmentId}/${verb}`, {});
const flags = (s: Status) => (s.plan ? { canPause: s.plan.canPause, canResume: s.plan.canResume, canStop: s.plan.canStop } : null);

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  // team plans (Owner): Active → "Buyer plan" (one text, at once); Under contract → "Follow-up plan" (a text at once,
  // an email three days after it); Nurture → a draft-only plan. agent2's own plan: Closed → a private plan.
  pb.buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  pb.draft = await playbook(w.owner, { scope: 'team', name: 'Nurture plan', approve: false });
  pb.secret = await playbook(agent2, { scope: 'agent', name: SECRET_NAME });
  const two = await call<{ playbook: { id: string; versions: { id: string; contentSha256: string }[] } }>(w.owner, 'POST', '/playbooks', {
    kind: 'nurture', scope: 'team', name: 'Follow-up plan',
    steps: [
      smsStep({ key: 'hello', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, checking in.', slots: ['first_name'] }),
      { ...smsStep({ key: 'later', category: 'nurture_step', intent: 'check_in', purpose: 'marketing', template: 'Hi {{first_name}}, any questions so far?', slots: ['first_name'], anchor: 'previous_step', offsetSeconds: 3 * 86_400 }), channel: 'email', subject: 'Checking in' },
    ],
  });
  if (two.status !== 201) throw new Error(`two-step plan: ${two.status} ${JSON.stringify(two.body)}`);
  const v = two.body.playbook.versions[0]!;
  expect((await call(w.owner, 'POST', `/playbook-versions/${v.id}/approve`, { attestation: 'I reviewed these messages and approve them.', contentSha256: v.contentSha256 })).status).toBe(200);
  pb.twoStep = { id: two.body.playbook.id, versionId: v.id };
  for (const [p, s, by] of [[pb.buyer, 'active', w.owner], [pb.draft, 'nurture', w.owner], [pb.twoStep, 'under_contract', w.owner], [pb.secret, 'closed', agent2]] as const) {
    const r = await setStage(by, p.id, s);
    if (r.status !== 200) throw new Error(`set stage ${s}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}, 300_000);
afterAll(async () => {
  await h?.close();
});

describe('the plan a person is in, and what it does next (R-STG-4)', () => {
  it('R-STG-4 nobody in a plan and no stage change yet: both parts are null', async () => {
    const c = await newContact(agent);
    const s = await status(agent, c);
    expect(s.status).toBe(200);
    expect(s.body).toEqual({ plan: null, lastStageChange: null });
  });

  it('R-STG-4 a running plan: its name, who started it and when, the next real step and when it is due, and the stage change that started it', async () => {
    const c = await newContact(agent);
    const t0 = Date.now();
    const ch = await changeStage(agent, c, 'active');
    expect(ch.body.automation).toEqual({ started: 'Buyer plan' });
    const [e] = await enrollmentsOf(h, c);
    const s = (await status(agent, c)).body;
    expect(s.plan).toEqual({
      enrollmentId: e!.id, name: 'Buyer plan', state: 'active',
      startedBy: { how: 'stage_change', userId: agent.userId, displayName: expect.any(String) },
      startedAt: expect.any(String),
      next: { kind: 'message', channel: 'sms', dueAt: expect.any(String) },
      blocked: null, deliveryUnconfirmed: null, canPause: true, canResume: false, canStop: true,
    });
    expect(Math.abs(Date.parse(s.plan!.startedAt) - t0)).toBeLessThan(60_000);
    expect(Math.abs(Date.parse(s.plan!.next!.dueAt) - t0)).toBeLessThan(60_000);
    expect(s.lastStageChange).toEqual({ eventId: expect.any(String), to: 'active', at: expect.any(String), pending: false, decision: { outcome: 'started', plan: 'Buyer plan', reason: null, sentence: 'Buyer plan started.' } });
    // reading the status wrote nothing and queued nothing
    const jobs = (await h.su.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n;
    for (let i = 0; i < 3; i++) await status(agent, c);
    expect((await h.su.query('SELECT count(*)::int AS n FROM jobs')).rows[0].n).toBe(jobs);
    expect(await enrollmentsOf(h, c)).toHaveLength(1);
  });

  it('R-STG-4 "next" is the next real step, not the runner\'s wake-up: after the first text went out, the email three days later', async () => {
    const c = await ownedContact(agent); // texting consent on file, so the first step really goes out (fake provider)
    expect((await changeStage(agent, c.id, 'under_contract')).body.automation).toEqual({ started: 'Follow-up plan' });
    const [e] = await enrollmentsOf(h, c.id);
    expect((await status(agent, c.id)).body.plan!.next).toMatchObject({ kind: 'message', channel: 'sms' });
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    await stepNow(h, w.tenantId, e!.id);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    const row = (await h.su.query<{ state: string; current_step: number; next_step_due_at: Date }>('SELECT state, current_step, next_step_due_at FROM playbook_enrollments WHERE id = $1', [e!.id])).rows[0]!;
    expect(row).toMatchObject({ state: 'active', current_step: 1 });
    const ran = (await h.su.query<{ at: Date }>("SELECT updated_at AS at FROM playbook_step_runs WHERE enrollment_id = $1 AND step_key = 'hello'", [e!.id])).rows[0]!.at.getTime();
    const s = (await status(agent, c.id)).body.plan!;
    expect(s.state).toBe('active');
    expect(s.next).toEqual({ kind: 'message', channel: 'email', dueAt: expect.any(String) });
    // three days after the step before it, to the second
    expect(Math.abs(Date.parse(s.next!.dueAt) - (ran + 3 * DAY))).toBeLessThan(2_000);
    // and it is the time the runner itself scheduled the step for (its planning, read without writing)
    expect(Math.abs(Date.parse(s.next!.dueAt) - row.next_step_due_at.getTime())).toBeLessThan(2_000);
  });

  it('R-STG-4 while a step\'s text is still queued, that step is what is next (not the two-minute check-back the runner set for itself)', async () => {
    const c = await ownedContact(agent);
    expect((await changeStage(agent, c.id, 'under_contract')).body.automation).toEqual({ started: 'Follow-up plan' });
    const [e] = await enrollmentsOf(h, c.id);
    // the step runs (the default queue) but its send job (the realtime queue) has not run yet
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    const m = (await h.su.query<{ status: string }>('SELECT status FROM messages WHERE contact_id = $1', [c.id])).rows;
    expect(m.map((x) => x.status)).toEqual(['queued']);
    const row = (await h.su.query<{ current_step: number; next_step_due_at: Date }>('SELECT current_step, next_step_due_at FROM playbook_enrollments WHERE id = $1', [e!.id])).rows[0]!;
    const s = (await status(agent, c.id)).body.plan!;
    expect(s.next).toMatchObject({ kind: 'message', channel: 'sms' });
    // the runner's wake-up is two minutes out; the text itself is due now
    expect(row.next_step_due_at.getTime() - Date.parse(s.next!.dueAt)).toBeGreaterThan(60_000);
  });

  it('R-STG-4 a paused plan says why, and offers Resume only when the resume route would resume it', async () => {
    const phone = randomPhone();
    const c = await newContact(agent, { phones: [phone] });
    await changeStage(agent, c, 'active');
    const [e] = await enrollmentsOf(h, c);
    expect((await act(agent, e!.id, 'pause')).status).toBe(200);
    let s = (await status(agent, c)).body.plan!;
    expect(s).toMatchObject({ state: 'paused', next: null, blocked: { code: 'manual', sentence: expect.stringMatching(/paused/i) }, canPause: false, canResume: true, canStop: true });
    expect((await act(agent, e!.id, 'resume')).status).toBe(200);
    s = (await status(agent, c)).body.plan!;
    expect(s).toMatchObject({ state: 'active', blocked: null, canPause: true, canResume: false, canStop: true });
    // they text STOP: the plan pauses for the opt-out, and that pause is not one a person can lift
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    s = (await status(agent, c)).body.plan!;
    expect(s).toMatchObject({ state: 'paused', next: null, blocked: { code: 'opt_out', sentence: expect.stringMatching(/opted out/i) }, canPause: false, canResume: false, canStop: true });
    expect((await act(agent, e!.id, 'resume')).code).toBe('ENROLLMENT_NOT_RESUMABLE');
  });

  it('R-STG-4 a stopped plan is still shown, with why it stopped and nothing left to press', async () => {
    const c = await newContact(agent);
    await changeStage(agent, c, 'active');
    const [e] = await enrollmentsOf(h, c);
    expect((await act(agent, e!.id, 'stop')).status).toBe(200);
    const s = (await status(agent, c)).body.plan!;
    expect(s).toMatchObject({ enrollmentId: e!.id, name: 'Buyer plan', state: 'stopped', next: null, blocked: { code: 'manual', sentence: expect.stringMatching(/stopped/i) }, canPause: false, canResume: false, canStop: false });
    expect((await act(agent, e!.id, 'pause')).code).toBe('ENROLLMENT_NOT_LIVE');
    expect((await act(agent, e!.id, 'resume')).code).toBe('ENROLLMENT_NOT_LIVE');
  });
});

describe('a message whose delivery could not be confirmed (R-STG-4)', () => {
  const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone);
  // never "sent", "delivered", "not delivered", "retried" or "resent": only that it could not be confirmed
  const NEVER = /\bwas sent\b|\bdelivered\b|\bretried\b|\bresent\b|\bdid not send\b|\bnot sent\b/i;
  // the standard the thread and the compose notice are held to (apps/web reasons/unconfirmedDelivery.test.ts, E753)
  const CLAIMS_NOT_DELIVERED = /Not delivered|Not sent|didn't send|did not send|wasn't sent|was not sent|Nothing reached|refused it|went out\b|no record/i;
  const CHECK_FIRST = /[Cc]heck .*before (you send|sending) (it )?again/;

  it('R-STG-4 E768 the plan\'s last text was handed to the carrier and no answer came: the status says delivery could not be confirmed, in its own field; it is not "next", not sent and not sent again', async () => {
    // a plan whose text went out normally has nothing to say here
    const fine = await ownedContact(agent);
    await changeStage(agent, fine.id, 'under_contract');
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    await stepNow(h, w.tenantId, (await enrollmentsOf(h, fine.id))[0]!.id);
    await runJobs(h, w.tenantId, ['playbook.step'], 1, ['default']);
    // this one's text gets no answer from the carrier (the fake's timeout)
    const c = await ownedContact(agent);
    expect((await changeStage(agent, c.id, 'under_contract')).body.automation).toEqual({ started: 'Follow-up plan' });
    const [e] = await enrollmentsOf(h, c.id);
    h.providers.telephony.failNext('timeout');
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch']);
    const msg = async () => (await h.su.query<{ id: string; status: string; status_reason: string | null }>('SELECT id, status, status_reason FROM messages WHERE contact_id = $1', [c.id])).rows;
    expect((await msg()).map((m) => m.status)).toEqual(['dispatch_unknown']);

    let s = (await status(agent, c.id)).body.plan!;
    expect(s.state).toBe('active');
    expect(s.blocked).toBeNull();
    expect(s.deliveryUnconfirmed).toEqual({ channel: 'sms', at: expect.any(String), checking: true, sentence: expect.stringMatching(/could not be confirmed/i) });
    expect(s.deliveryUnconfirmed!.sentence).toMatch(/may have reached them/i);
    expect(s.deliveryUnconfirmed!.sentence).not.toMatch(NEVER);
    expect(s.deliveryUnconfirmed!.sentence).not.toMatch(CLAIMS_NOT_DELIVERED);
    expect(s.deliveryUnconfirmed!.sentence).toMatch(CHECK_FIRST);
    // the text is with the carrier: it is not the "next" step (that would promise a send), and nothing later is promised yet
    expect(s.next).toBeNull();
    const other = (await status(agent, fine.id)).body.plan!;
    expect(other.deliveryUnconfirmed).toBeNull();
    expect(other.next).toMatchObject({ channel: 'email' });

    // ten minutes of asking the carrier find nothing either way: still "could not be confirmed", never "not delivered"
    await h.su.query("UPDATE messages SET dispatched_at = now() - interval '11 minutes' WHERE contact_id = $1", [c.id]);
    await runJobs(h, w.tenantId, ['comms.reconcile']);
    expect((await msg()).map((m) => [m.status, m.status_reason])).toEqual([['failed', 'DISPATCH_UNKNOWN_UNRESOLVED']]);
    s = (await status(agent, c.id)).body.plan!;
    expect(s.deliveryUnconfirmed).toEqual({ channel: 'sms', at: expect.any(String), checking: false, sentence: expect.stringMatching(/could not be confirmed/i) });
    expect(s.deliveryUnconfirmed!.sentence).toMatch(/may have reached them/i);
    expect(s.deliveryUnconfirmed!.sentence).not.toMatch(NEVER);
    expect(s.deliveryUnconfirmed!.sentence).not.toMatch(CLAIMS_NOT_DELIVERED);
    expect(s.deliveryUnconfirmed!.sentence).toMatch(CHECK_FIRST);
    // the plan goes on to its next step; the unconfirmed text is not sent a second time by anything here
    expect(s.next).toMatchObject({ kind: 'message', channel: 'email' });
    await stepNow(h, w.tenantId, e!.id);
    await runJobs(h, w.tenantId, ['playbook.step', 'comms.dispatch', 'comms.reconcile'], 2);
    expect(await msg()).toHaveLength(1);
    expect(smsTo(c.phone)).toHaveLength(0);
    expect((await status(agent, c.id)).body.plan!.deliveryUnconfirmed).toMatchObject({ checking: false });
  });
});

describe('what the last stage change did (R-STG-4)', () => {
  it('R-STG-4 E767 a change the worker has not decided yet is pending: never "started", never "nothing happened"', async () => {
    const c = await newContact(agent);
    const ev = await rawStageChange(h, agent, c, 'active'); // as PATCH or a bulk action writes it: decided by the worker
    let s = (await status(agent, c)).body;
    expect(s.plan).toBeNull();
    expect(s.lastStageChange).toEqual({ eventId: ev, to: 'active', at: expect.any(String), pending: true, decision: null });
    await reconcileAsJob(h, w.tenantId, ev);
    s = (await status(agent, c)).body;
    expect(s.lastStageChange).toMatchObject({ eventId: ev, pending: false, decision: { outcome: 'started', plan: 'Buyer plan', reason: null } });
    expect(s.plan).toMatchObject({ name: 'Buyer plan', state: 'active' });
  });

  it('R-STG-4 a change to a stage no plan names has no decision and is not pending; a plan that did not start says why, in the past tense', async () => {
    const c = await newContact(agent);
    await changeStage(agent, c, 'connected');
    expect((await status(agent, c)).body.lastStageChange).toMatchObject({ to: 'connected', pending: false, decision: null });
    await changeStage(agent, c, 'nurture');
    const s = (await status(agent, c)).body;
    expect(s.plan).toBeNull();
    expect(s.lastStageChange).toMatchObject({ to: 'nurture', pending: false, decision: { outcome: 'skipped', plan: 'Nurture plan', reason: 'plan_not_approved', sentence: expect.stringMatching(/^Nurture plan did not start: .*approved/) } });
    // a system-made change (an import) is not something the worker will decide later
    const sysOnly = await newContact(agent);
    await h.su.query("UPDATE contacts SET stage = 'connected' WHERE id = $1", [sysOnly]);
    expect((await status(agent, sysOnly)).body.lastStageChange).toMatchObject({ to: 'connected', pending: false, decision: null });
  });
});

// b19 fix pass L5: one vocabulary for one decision. The stage route answers the SAME sentence the status then shows
// for that change (stageAutomation/sentences.ts decisionSentence), so the toast never words a decision its own way.
describe('L5 (E784): the stage change answers the sentence the panel then shows', () => {
  const sentenceOf = (r: { body: unknown }) => (r.body as { automationSentence: string | null }).automationSentence;

  it('L5 E784 started, did not start (with the reason), and nothing to say: the answer\'s sentence is the status\'s own; a repeat answers it again', async () => {
    const c = await newContact(agent);
    // no plan names "connected": nothing is said
    const none = await changeStage(agent, c, 'connected');
    expect(none.body.automation).toBeNull();
    expect(sentenceOf(none)).toBeNull();
    // a draft-only plan names "nurture": it did not start, and why
    const skipped = await changeStage(agent, c, 'nurture');
    expect(skipped.body.automation).toEqual({ skipped: 'plan_not_approved', plan: 'Nurture plan' });
    expect(sentenceOf(skipped)).toBe('Nurture plan did not start: it has no approved version yet, and only an approved plan runs.');
    expect(sentenceOf(skipped)).toBe((await status(agent, c)).body.lastStageChange!.decision!.sentence);
    // the same stage again (a retry) answers what is stored, in the same words
    expect(sentenceOf(await changeStage(agent, c, 'nurture'))).toBe(sentenceOf(skipped));
    // an approved plan names "active": it started
    const started = await changeStage(agent, c, 'active');
    expect(started.body.automation).toEqual({ started: 'Buyer plan' });
    expect(sentenceOf(started)).toBe('Buyer plan started.');
    expect(sentenceOf(started)).toBe((await status(agent, c)).body.lastStageChange!.decision!.sentence);
  });

  it('L5 E784 R-PERM-12 the sentence names a plan only as the caller may see it', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/collaborators`, { userId: agent.userId, role: 'co_agent' })).status).toBe(200);
    const mine = await changeStage(agent2, c, 'closed');
    expect(sentenceOf(mine)).toBe(`${SECRET_NAME} started.`);
    // the collaborator posts the same stage again: the stored decision, with the hidden plan's name withheld in both fields
    const theirs = await changeStage(agent, c, 'closed');
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain(SECRET_NAME);
    expect(theirs.body.automation).toEqual({ started: "the owner's plan" });
    expect(sentenceOf(theirs)).toBe("The owner's plan started.");
  });
});

describe('who may read the status and what they may press (R-STG-4)', () => {
  /** An agent-owned person in a running plan, with the ISA as a collaborator and the TC on their deal. */
  async function fixture(): Promise<{ id: string; enrollmentId: string }> {
    const c = await newContact(agent);
    await changeStage(agent, c, 'active');
    expect((await call(agent, 'POST', `/contacts/${c}/collaborators`, { userId: isa.userId, role: 'isa' })).status).toBe(200);
    const deal = await call<{ deal: { id: string } }>(agent, 'POST', '/deals', { primaryContactId: c, side: 'buy', name: 'Elm St purchase' });
    expect(deal.status).toBe(201);
    expect((await call(agent, 'POST', `/deals/${deal.body.deal.id}/members`, { userId: tc.userId, role: 'tc' })).status).toBe(200);
    const [e] = await enrollmentsOf(h, c);
    return { id: c, enrollmentId: e!.id };
  }

  it('R-STG-4 R-PERM-5 each role: Pause, Resume and Stop are offered exactly when that role\'s own request to the route would be answered', async () => {
    const who: [string, TestClient][] = [['owner', w.owner], ['admin', admin], ['team_lead', tl], ['agent (owns the person)', agent], ['agent (does not)', agent2], ['isa (collaborator)', isa], ['tc (on the deal)', tc]];
    const got: Record<string, unknown> = {};
    for (const [name, u] of who) {
      const f = await fixture();
      const running = await status(u, f.id);
      if (running.status !== 200) {
        got[name] = running.status;
        // whoever cannot read the status cannot act on the plan either
        for (const verb of ['pause', 'resume', 'stop'] as const) expect((await act(u, f.enrollmentId, verb)).status, `${name} ${verb}`).toBe(404);
        continue;
      }
      const a = flags(running.body)!;
      // Pause: offered iff the route pauses it for this role
      const pause = await act(u, f.enrollmentId, 'pause');
      expect(pause.status === 200, `${name} pause`).toBe(a.canPause);
      if (pause.status !== 200) expect((await act(agent, f.enrollmentId, 'pause')).status).toBe(200);
      const b = flags((await status(u, f.id)).body)!;
      const resume = await act(u, f.enrollmentId, 'resume');
      expect(resume.status === 200, `${name} resume`).toBe(b.canResume);
      const stop = await act(u, f.enrollmentId, 'stop');
      const c = flags((await status(u, f.id)).body)!;
      expect(stop.status === 200, `${name} stop`).toBe(b.canStop);
      got[name] = { running: a, paused: b, afterStop: c };
    }
    const all = { running: { canPause: true, canResume: false, canStop: true }, paused: { canPause: false, canResume: true, canStop: true }, afterStop: { canPause: false, canResume: false, canStop: false } };
    const none = { canPause: false, canResume: false, canStop: false };
    expect(got).toEqual({
      owner: all,
      admin: all,
      team_lead: all,
      'agent (owns the person)': all,
      'agent (does not)': 404,
      'isa (collaborator)': all,
      // a TC sees the person through the deal and reads the status, but may only send informational messages: a
      // plan is marketing, so none of the three is offered (and the routes answer 404, R-PERM-5)
      'tc (on the deal)': { running: none, paused: none, afterStop: all.afterStop },
    });
  });

  it('R-STG-4 R-PERM-5 the contact-detail permission: another tenant, an unknown person and a pond card are 404', async () => {
    const f = await fixture();
    const elsewhere = await commsWorld(h, { agents: 1 });
    expect((await status(elsewhere.owner, f.id)).status).toBe(404);
    expect((await status(agent, randomUUID())).status).toBe(404);
    expect((await status(agent2, f.id)).status).toBe(404);
    for (const u of [w.owner, admin, tl, agent, isa, tc]) expect((await status(u, f.id)).status).toBe(200);
  });

  it('R-STG-4 E769 R-PERM-12 a viewer who may not see the plan gets "the owner\'s plan" for its name everywhere, and no Resume the route would refuse', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/collaborators`, { userId: agent.userId, role: 'co_agent' })).status).toBe(200);
    expect((await changeStage(agent2, c, 'closed')).body.automation).toEqual({ started: SECRET_NAME });
    const [e] = await enrollmentsOf(h, c);
    const mine = (await status(agent2, c)).body;
    expect(mine.plan).toMatchObject({ name: SECRET_NAME, canPause: true, canStop: true });
    expect(mine.lastStageChange!.decision).toMatchObject({ plan: SECRET_NAME, sentence: `${SECRET_NAME} started.` });
    const theirs = await status(agent, c);
    expect(theirs.status).toBe(200);
    expect(JSON.stringify(theirs.body)).not.toContain(SECRET_NAME);
    expect(theirs.body.plan).toMatchObject({ enrollmentId: e!.id, name: "the owner's plan", state: 'active', next: { kind: 'message', channel: 'sms' } });
    expect(theirs.body.lastStageChange!.decision).toEqual({ outcome: 'started', plan: "the owner's plan", reason: null, sentence: "The owner's plan started." });
    // the Team Lead and the Owner see every plan
    expect((await status(tl, c)).body.plan!.name).toBe(SECRET_NAME);
    expect((await status(w.owner, c)).body.plan!.name).toBe(SECRET_NAME);
    // a collaborator may pause it, but the resume route cannot find a plan they cannot see: Resume is not offered
    const a = flags(theirs.body)!;
    expect((await act(agent, e!.id, 'pause')).status === 200).toBe(a.canPause);
    const paused = flags((await status(agent, c)).body)!;
    const resume = await act(agent, e!.id, 'resume');
    expect(resume.status === 200).toBe(paused.canResume);
    expect(paused.canResume).toBe(false);
    expect((await status(agent2, c)).body.plan).toMatchObject({ state: 'paused', canResume: true });
  });
});
