// api/stage-automation end to end (PARITY_PLAN module 67; R-PAR-16, E172, R-PAR-12, R-PAR-5, D1) through the
// real server as app_user. The superuser pool only reads state back.
import { randomUUID } from 'node:crypto';
import { ROLES, type Role, can } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, inboundSms, randomPhone } from '../comms/testing.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { makeStageAutomationHandlers } from './handlers.js';
import { reconcileStageEvent } from './reconcile.js';
import { changeStage, decisionsOf, nurtureStep, enrollmentsOf, newContact, playbook, rawStageChange, reconcileAsJob, scanPending, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient; // has their own plans (E172)
let agent2: TestClient; // team plans only
let tl: TestClient;
let admin: TestClient;
let isa: TestClient;
let tc: TestClient;
const pb = {} as Record<'buyer' | 'agentBuyer' | 'nurtureDraft' | 'contract' | 'agentContractDraft', { id: string; versionId: string }>;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'] });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tl = w.teamLead!;
  [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  // team plans (Owner): Active → "Buyer plan" (approved); Nurture → "Nurture plan" (draft only);
  // Under contract → "Contract plan" (approved). The agent's own plans: Active (approved), Under contract (draft).
  pb.buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  pb.nurtureDraft = await playbook(w.owner, { scope: 'team', name: 'Nurture plan', approve: false });
  pb.contract = await playbook(w.owner, { scope: 'team', name: 'Contract plan' });
  pb.agentBuyer = await playbook(agent, { scope: 'agent', name: "Ana's buyer plan" });
  pb.agentContractDraft = await playbook(agent, { scope: 'agent', name: "Ana's contract plan", approve: false });
  for (const [p, s, by] of [[pb.buyer, 'active', w.owner], [pb.nurtureDraft, 'nurture', w.owner], [pb.contract, 'under_contract', admin], [pb.agentBuyer, 'active', agent], [pb.agentContractDraft, 'under_contract', agent]] as const) {
    const r = await setStage(by, p.id, s);
    if (r.status !== 200) throw new Error(`set stage ${s}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-PAR-16 the auto_enroll_stage setting', () => {
  it('R-PAR-16 one active playbook per scope, owner and stage; clearing frees the stage; audited', async () => {
    const other = await playbook(w.owner, { scope: 'team', name: 'Second buyer plan' });
    const taken = await setStage(w.owner, other.id, 'active');
    expect(taken.status).toBe(409);
    expect(taken.code).toBe('AUTO_ENROLL_STAGE_TAKEN');
    // the DB unique index is the backstop for a race the pre-check cannot see
    await expect(h.su.query("UPDATE playbooks SET auto_enroll_stage = 'active' WHERE id = $1", [other.id])).rejects.toThrow(/playbooks_auto_enroll_one/);
    const lost = await setStage(w.owner, other.id, 'lost');
    expect(lost.status).toBe(200);
    expect(lost.body.playbook.autoEnrollStage).toBe('lost');
    expect((await setStage(w.owner, other.id, null)).body.playbook.autoEnrollStage).toBeNull();
    const a = await h.su.query<{ action: string; reason: string; changes: Record<string, unknown> }>("SELECT action, reason, changes FROM audit_log WHERE entity_type = 'playbook' AND entity_id = $1 ORDER BY occurred_at", [other.id]);
    expect(a.rows.map((x) => [x.action, x.reason])).toEqual([['settings.changed', 'AUTO_ENROLL_STAGE'], ['settings.changed', 'AUTO_ENROLL_STAGE']]);
    expect(JSON.stringify(a.rows[0]!.changes)).toContain('lost');
    // an agent's own playbook may hold the same stage as the team's (different scope/owner)
    expect((await call<{ playbook: { autoEnrollStage: string } }>(agent, 'GET', '/playbooks')).status).toBe(200);
  });

  it('R-PAR-16 never for a new-lead-response playbook', async () => {
    const c = await call<{ playbook: { id: string } }>(w.owner, 'POST', '/playbooks', { templateKey: 'new_lead_response' });
    expect(c.status).toBe(201);
    const r = await setStage(w.owner, c.body.playbook.id, 'active');
    expect(r.status).toBe(422);
    expect(r.code).toBe('AUTO_ENROLL_NOT_ALLOWED');
    await expect(h.su.query("UPDATE playbooks SET auto_enroll_stage = 'connected' WHERE id = $1", [c.body.playbook.id])).rejects.toThrow(/playbooks_auto_enroll_not_new_lead/);
  });

  it('R-PAR-16 R-PERM-5 role × route: team playbooks Owner/Admin; an agent their own agent playbook only; TL, ISA, TC never (404)', async () => {
    const team = await playbook(w.owner, { scope: 'team', name: `Matrix team ${randomUUID().slice(0, 4)}` });
    const own: Record<string, string> = {};
    const users: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: tl, agent: agent2, isa, tc };
    for (const role of ROLES) {
      // each role tries its own agent playbook where it can create one, and the team playbook
      const mine = await call<{ playbook: { id: string } }>(users[role], 'POST', '/playbooks', { kind: 'nurture', scope: 'agent', name: `Mine ${role}`, steps: [nurtureStep()] });
      if (mine.status === 201) own[role] = mine.body.playbook.id;
    }
    const got: Record<string, number> = {};
    const want: Record<string, number> = {};
    const status = (ok: boolean) => (ok ? 200 : 404);
    for (const role of ROLES) {
      const u = users[role];
      const actor = { kind: 'user' as const, userId: u.userId!, tenantId: u.tenantId!, role, sessionId: 'x' };
      got[`${role} team`] = (await setStage(u, team.id, 'closed')).status;
      want[`${role} team`] = status(can(actor, 'playbook.auto_enroll_stage', { teamPlaybook: true }).ok);
      if (got[`${role} team`] === 200) await setStage(u, team.id, null);
      if (own[role]) {
        got[`${role} own`] = (await setStage(u, own[role]!, 'closed')).status;
        want[`${role} own`] = status(can(actor, 'playbook.auto_enroll_stage', { own: true }).ok);
        if (got[`${role} own`] === 200) await setStage(u, own[role]!, null);
      }
      // someone else's agent playbook is never theirs to set (agent2 → the first agent's plan)
      got[`${role} other agent`] = (await setStage(u, pb.agentBuyer.id, 'closed')).status;
      want[`${role} other agent`] = 404;
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner team': 200, 'admin team': 200, 'team_lead team': 404, 'agent team': 404, 'isa team': 404, 'tc team': 404, 'agent own': 200 });
    // nothing changed on the other agent's plan
    expect((await h.su.query('SELECT auto_enroll_stage FROM playbooks WHERE id = $1', [pb.agentBuyer.id])).rows[0].auto_enroll_stage).toBe('active');
  });

  it('R-PAR-16 R-PERM-5 GET shows the saved stage to whoever sees the playbook, and canChange is the same can() as PUT (a playbook the caller cannot see is 404)', async () => {
    type Got = { playbook: { id: string; name: string; scope: string; autoEnrollStage: string | null }; canChange: boolean };
    const read = (u: TestClient, id: string) => call<Got>(u, 'GET', `/playbooks/${id}/auto-enroll-stage`);
    const users: Record<Role, TestClient> = { owner: w.owner, admin, team_lead: tl, agent, isa, tc };
    const got: Record<string, string> = {};
    const want: Record<string, string> = {};
    for (const role of ROLES) {
      const u = users[role];
      const actor = { kind: 'user' as const, userId: u.userId!, tenantId: u.tenantId!, role, sessionId: 'x' };
      // the team "Buyer plan" starts on Active: every member reads it (team playbooks are visible to members)
      const team = await read(u, pb.buyer.id);
      got[`${role} team`] = `${team.status} ${team.body.playbook?.autoEnrollStage} ${team.body.canChange}`;
      want[`${role} team`] = `200 active ${can(actor, 'playbook.auto_enroll_stage', { teamPlaybook: true }).ok}`;
      // the agent's own "Ana's buyer plan" (also Active): the agent sees it, and so do Owner, Admin and Team
      // Leads (playbooks_select: app.sees_all_detail()); only the agent may change it
      const own = await read(u, pb.agentBuyer.id);
      got[`${role} agent plan`] = own.status === 200 ? `200 ${own.body.playbook.autoEnrollStage} ${own.body.canChange}` : String(own.status);
      const ownFacts = { own: u.userId === agent.userId, teamPlaybook: false };
      const seesIt = role === 'owner' || role === 'admin' || role === 'team_lead' || u.userId === agent.userId;
      want[`${role} agent plan`] = seesIt ? `200 active ${can(actor, 'playbook.auto_enroll_stage', ownFacts).ok}` : '404';
    }
    expect(got).toEqual(want);
    expect(want).toMatchObject({ 'owner team': '200 active true', 'admin team': '200 active true', 'team_lead team': '200 active false', 'agent team': '200 active false', 'tc team': '200 active false', 'agent agent plan': '200 active true', 'owner agent plan': '200 active false', 'team_lead agent plan': '200 active false', 'isa agent plan': '404', 'tc agent plan': '404' });
    // another agent's plan stays invisible; another tenant sees nothing; an unknown id is 404
    expect((await read(agent2, pb.agentBuyer.id)).status).toBe(404);
    const elsewhere = await commsWorld(h, { agents: 1 });
    expect((await read(elsewhere.owner, pb.buyer.id)).status).toBe(404);
    expect((await read(w.owner, randomUUID())).status).toBe(404);
    // a saved change is what the next GET shows; clearing it shows no stage
    const p = await playbook(w.owner, { scope: 'team', name: `Read back ${randomUUID().slice(0, 4)}` });
    expect((await read(w.owner, p.id)).body).toEqual({ playbook: { id: p.id, name: expect.any(String), scope: 'team', autoEnrollStage: null }, canChange: true });
    expect((await setStage(w.owner, p.id, 'lost')).status).toBe(200);
    expect((await read(admin, p.id)).body.playbook.autoEnrollStage).toBe('lost');
    expect((await setStage(admin, p.id, null)).status).toBe(200);
    expect((await read(w.owner, p.id)).body.playbook.autoEnrollStage).toBeNull();
  });
});

describe('R-PAR-16 stage entry enrolls only from an approved version, told to the person who changed the stage', () => {
  it('R-PAR-16 Stage → Active starts the buyer plan (approved version, enrolled_by stage_change); nothing is sent by this module', async () => {
    const c = await newContact(agent2);
    const r = await changeStage(agent2, c, 'active');
    expect(r.status).toBe(200);
    expect(r.body.automation).toEqual({ started: 'Buyer plan' });
    const e = await enrollmentsOf(h, c);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ playbook_id: pb.buyer.id, playbook_version_id: pb.buyer.versionId, enrolled_by: 'stage_change', enrolled_by_user_id: agent2.userId, state: 'active' });
    // the first step is the playbook engine's job; no message exists until it runs (then dispatch decides)
    const jobs = await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE kind = 'playbook.step' AND payload->>'enrollmentId' = $1", [e[0]!.id]);
    expect(jobs.rows[0].n).toBe(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE contact_id = $1', [c])).rows[0].n).toBe(0);
    // R-PAR-5: nothing here is a touch
    expect((await h.su.query('SELECT first_touch_at, last_human_touch_at FROM contacts WHERE id = $1', [c])).rows[0]).toMatchObject({ first_touch_at: null, last_human_touch_at: null });
    // the enrollment is audited as the system acting for the stage change
    const a = await h.su.query("SELECT reason FROM audit_log WHERE action = 'enrollment.changed' AND entity_id = $1", [e[0]!.id]);
    expect(a.rows[0].reason).toMatch(/^enrolled:stage_change:/);
  });

  it('R-PAR-16 a draft-only plan never starts: the skip reason is plan_not_approved', async () => {
    const c = await newContact(agent2);
    const r = await changeStage(agent2, c, 'nurture');
    expect(r.body.automation).toEqual({ skipped: 'plan_not_approved', plan: 'Nurture plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 never a second live enrollment: already in a plan is the skip reason', async () => {
    const c = await newContact(agent2);
    expect((await changeStage(agent2, c, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    expect((await changeStage(agent2, c, 'under_contract')).body.automation).toEqual({ skipped: 'already_in_a_plan', plan: 'Contract plan' });
    expect((await enrollmentsOf(h, c)).filter((e) => e.state === 'active' || e.state === 'paused')).toHaveLength(1);
  });

  it('R-PAR-16 the skip reason is shown to the person who changed the stage (a Team Lead on the agent\'s lead)', async () => {
    const c = await newContact(agent2);
    await call(agent2, 'POST', `/contacts/${c}/enrollments`, { playbookId: pb.contract.id });
    const r = await changeStage(tl, c, 'active');
    expect(r.status).toBe(200);
    expect(r.body.automation).toEqual({ skipped: 'already_in_a_plan', plan: 'Buyer plan' });
    expect((await decisionsOf(h, c)).map((d) => d.reason)).toEqual(['already_in_a_plan']);
  });

  it('R-PAR-16 a stage with no plan says nothing (automation null), and Undo is just another stage change', async () => {
    const c = await newContact(agent2);
    const r = await changeStage(agent2, c, 'connected');
    expect(r.body.automation).toBeNull();
    expect((await changeStage(agent2, c, 'new')).body.automation).toBeNull();
    expect(await decisionsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 the request path and the job agree: one decision per stage event, rerun-safe', async () => {
    const c = await newContact(agent2);
    await changeStage(agent2, c, 'active');
    const [d] = await decisionsOf(h, c);
    const again = await reconcileAsJob(h, w.tenantId, d!.stage_event_id);
    expect(again).toMatchObject({ automation: { started: 'Buyer plan' }, decided: false });
    expect(await decisionsOf(h, c)).toHaveLength(1);
    expect(await enrollmentsOf(h, c)).toHaveLength(1);
  });
});

describe('E172 the agent\'s own playbook wins over the team\'s for the agent\'s own contacts', () => {
  it('E172 R-PAR-16 Active: the agent\'s contact starts the agent\'s plan; another agent\'s contact starts the team plan', async () => {
    const mine = await newContact(agent);
    const theirs = await newContact(agent2);
    expect((await changeStage(agent, mine, 'active')).body.automation).toEqual({ started: "Ana's buyer plan" });
    expect((await changeStage(agent2, theirs, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    expect((await enrollmentsOf(h, mine)).map((e) => e.playbook_id)).toEqual([pb.agentBuyer.id]);
    expect((await enrollmentsOf(h, theirs)).map((e) => e.playbook_id)).toEqual([pb.buyer.id]);
  });

  it('E172 the agent\'s own plan that is not approved is the answer: the team plan does not start in its place', async () => {
    const mine = await newContact(agent);
    const theirs = await newContact(agent2);
    expect((await changeStage(agent, mine, 'under_contract')).body.automation).toEqual({ skipped: 'plan_not_approved', plan: "Ana's contract plan" });
    expect(await enrollmentsOf(h, mine)).toHaveLength(0);
    expect((await changeStage(agent2, theirs, 'under_contract')).body.automation).toEqual({ started: 'Contract plan' });
  });

  it('E172 when the Owner moves the agent\'s contact, the contact owner\'s plan still decides (not the changer\'s)', async () => {
    const mine = await newContact(agent);
    expect((await changeStage(w.owner, mine, 'active')).body.automation).toEqual({ started: "Ana's buyer plan" });
  });
});

describe('R-PAR-16 D1 never for a person who cannot be reached (opt-outs, R-PAR-12)', () => {
  it('R-PAR-16 D1 a person who texted STOP is skipped with cannot_be_reached; nothing starts', async () => {
    const phone = randomPhone();
    const c = await newContact(agent2, { phones: [phone] });
    expect((await inboundSms(h, phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const r = await changeStage(agent2, c, 'active');
    expect(r.body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-12 a STOP on a phone the agent then removed still blocks: skipped with cannot_be_reached', async () => {
    const oldPhone = randomPhone();
    const newPhone = randomPhone();
    const c = await newContact(agent2, { phones: [oldPhone, newPhone] });
    expect((await inboundSms(h, oldPhone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
    const pt = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [c, oldPhone])).rows[0]!.id;
    const rm = await call(agent2, 'POST', `/contacts/${c}/points/${pt}/remove`, { reason: 'old' });
    expect(rm.status).toBe(200);
    const r = await changeStage(agent2, c, 'active');
    expect(r.body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 D1 a person-level do-not-contact is skipped; a person with no number for an SMS plan is skipped', async () => {
    const c = await newContact(agent2);
    expect((await call(agent2, 'POST', `/contacts/${c}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    expect((await changeStage(agent2, c, 'active')).body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
    const emailOnly = await newContact(agent2, { phones: [], emails: [`e-${randomUUID().slice(0, 6)}@example.test`] });
    expect((await changeStage(agent2, emailOnly, 'active')).body.automation).toEqual({ skipped: 'cannot_be_reached', plan: 'Buyer plan' });
  });
});

describe('R-PAR-16 an import or migration stage change never enrolls', () => {
  it('R-PAR-16 a stage written by the import (system) actor: not a person\'s change, never enrolled, never scanned', async () => {
    const c = await newContact(agent2);
    const eventId = await withTenantTx(systemActor(w.tenantId, 'import'), async (tx) => {
      await sql`UPDATE contacts SET stage = 'active' WHERE tenant_id = app.tenant_id() AND id = ${c}`.execute(tx);
      return (await sql<{ id: string; actor_kind: string }>`SELECT id, actor_kind FROM contact_stage_events WHERE tenant_id = app.tenant_id() AND contact_id = ${c}`.execute(tx)).rows[0]!;
    }, { db: h.database });
    expect(eventId.actor_kind).toBe('system');
    expect(await scanPending(h, w.tenantId)).not.toContain(eventId.id);
    const r = await reconcileAsJob(h, w.tenantId, eventId.id);
    expect(r.automation).toEqual({ skipped: 'not_a_person_change', plan: 'Buyer plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });
});

describe('R-PAR-16 exactly one live enrollment under concurrency', () => {
  it('R-PAR-16 two stage entries of one person decided at once (and each twice): one live enrollment, one decision per event', async () => {
    const c = await newContact(agent2);
    const e1 = await rawStageChange(h, agent2, c, 'active');
    const e2 = await rawStageChange(h, agent2, c, 'nurture');
    const e3 = await rawStageChange(h, agent2, c, 'active');
    const rs = await Promise.all([reconcileAsJob(h, w.tenantId, e1), reconcileAsJob(h, w.tenantId, e3), reconcileStageEvent({ db: h.database }, w.tenantId, e1), reconcileStageEvent({ db: h.database }, w.tenantId, e3), reconcileAsJob(h, w.tenantId, e2)]);
    expect(rs.filter((r) => r.automation !== null && 'started' in r.automation).length).toBeGreaterThanOrEqual(1);
    const live = (await enrollmentsOf(h, c)).filter((e) => e.state === 'active' || e.state === 'paused');
    expect(live).toHaveLength(1);
    const ds = await decisionsOf(h, c);
    expect(ds).toHaveLength(3);
    expect(ds.filter((d) => d.outcome === 'started')).toHaveLength(1);
    expect(new Set(ds.map((d) => d.stage_event_id))).toEqual(new Set([e1, e2, e3]));
    // both calls for the same event returned the same outcome
    expect(rs[0]!.automation).toEqual(rs[2]!.automation);
    expect(rs[1]!.automation).toEqual(rs[3]!.automation);
  });

  it('R-PAR-16 two people changing one person\'s stage at once (two playbooks): never two live enrollments', async () => {
    const c = await newContact(agent2);
    const rs = await Promise.all([changeStage(agent2, c, 'active'), changeStage(tl, c, 'under_contract')]);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    const w2 = makeStageAutomationHandlers(() => ({ db: h.database }));
    const worker = createWorker({ db: h.database, registry: new HandlerRegistry().registerAll(w2), providers: h.providers, queues: ['default'], concurrency: 2, worker: `sa-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger });
    for (const id of await scanPending(h, w.tenantId)) await reconcileAsJob(h, w.tenantId, id);
    await worker.drain(5);
    expect((await enrollmentsOf(h, c)).filter((e) => e.state === 'active' || e.state === 'paused')).toHaveLength(1);
  });
});

describe('R-PAR-16 the backup scan (PATCH and bulk stage changes, a request-path crash)', () => {
  it('R-PAR-16 a stage set by PATCH is decided by the worker: scan → reconcile job → enrollment; a rerun adds nothing', async () => {
    const c = await newContact(agent2);
    const rv = (await call<{ details: { rowVersion: number } }>(agent2, 'GET', `/contacts/${c}/details`)).body.details.rowVersion;
    const p = await call(agent2, 'PATCH', `/contacts/${c}`, { rowVersion: rv, stage: 'active' });
    expect(p.status).toBe(200);
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
    const handlers = makeStageAutomationHandlers(() => ({ db: h.database }));
    const registry = new HandlerRegistry().registerAll(handlers);
    const worker = () => createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `sa-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger });
    // the periodic scan job of this tenant (the maintenance pass keeps one live; here enqueued by hand)
    await h.su.query(`INSERT INTO jobs (tenant_id, kind, queue, payload, run_at, dedupe_key) VALUES ($1, 'stage_automation.scan', 'default', '{}', now() - interval '1 second', 'periodic:stage_automation.scan') ON CONFLICT DO NOTHING`, [w.tenantId]);
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'stage_automation.scan' AND status = 'pending'`, [w.tenantId]);
    await worker().drain(10);
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'stage_automation.reconcile' AND status = 'pending'`, [w.tenantId]);
    await worker().drain(10);
    const e = await enrollmentsOf(h, c);
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ playbook_id: pb.buyer.id, enrolled_by: 'stage_change', enrolled_by_user_id: agent2.userId });
    expect(await scanPending(h, w.tenantId)).not.toContain((await decisionsOf(h, c))[0]!.stage_event_id);
  });

  it('R-PAR-16 a plan given a stage AFTER the stage was entered does not reach back to that entry', async () => {
    const c = await newContact(agent2);
    const ev = await rawStageChange(h, agent2, c, 'closed');
    const late = await playbook(w.owner, { scope: 'team', name: 'Closing plan' });
    expect((await setStage(w.owner, late.id, 'closed')).status).toBe(200);
    expect(await scanPending(h, w.tenantId)).not.toContain(ev);
    expect((await reconcileAsJob(h, w.tenantId, ev)).automation).toBeNull();
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
    await setStage(w.owner, late.id, null);
  });

  it('R-PAR-16 an event whose stage moved on before the plan could start is skipped with stage_changed_again', async () => {
    const c = await newContact(agent2);
    const ev = await rawStageChange(h, agent2, c, 'active');
    await rawStageChange(h, agent2, c, 'new');
    expect((await reconcileAsJob(h, w.tenantId, ev)).automation).toEqual({ skipped: 'stage_changed_again', plan: 'Buyer plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });
});
