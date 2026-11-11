// Adversarial tests of api/stage-automation (parity module 67, critical: autonomy). The assistant acts on
// its own only inside approved playbooks: no enrollment from a draft, revoked or retired version (with core
// bypassed, the DB refuses it), never for a person the stage-changer cannot see, never across tenants,
// never set by a TC or a support actor, never re-decided after a merge copies the history.
import { randomUUID } from 'node:crypto';
import { type Actor, type TenantId, can } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as P from '../assistant/repos/playbooks.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld } from '../comms/testing.js';
import { command } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { reconcileStageEvent } from './reconcile.js';
import { changeStage, decisionsOf, enrollmentsOf, newContact, playbook, rawStageChange, reconcileAsJob, scanPending, setStage } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let other: CommsWorld;
let agent: TestClient;
let agent2: TestClient;
let tc: TestClient;
let buyer: { id: string; versionId: string };
let agentPlan: { id: string; versionId: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, others: ['tc'] });
  other = await commsWorld(h, { agents: 1 });
  [agent, agent2] = w.agents as [TestClient, TestClient];
  tc = w.others[0]!;
  buyer = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
  agentPlan = await playbook(agent, { scope: 'agent', name: "Ana's plan" });
  expect((await setStage(w.owner, buyer.id, 'active')).status).toBe(200);
  expect((await setStage(agent, agentPlan.id, 'active')).status).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('R-PAR-16 adversarial: only approved versions run (autonomy)', () => {
  it('R-PAR-16 a revoked version never starts: skipped plan_not_approved', async () => {
    const p = await playbook(w.owner, { scope: 'team', name: 'Revoked plan' });
    expect((await setStage(w.owner, p.id, 'connected')).status).toBe(200);
    const v = (await h.su.query<{ content_sha256: string }>('SELECT content_sha256 FROM playbook_versions WHERE id = $1', [p.versionId])).rows[0]!;
    const rv = await call(w.owner, 'POST', `/playbook-versions/${p.versionId}/revoke`, { attestation: 'Revoking this plan.', contentSha256: v.content_sha256 });
    expect(rv.status).toBe(200);
    const c = await newContact(agent2);
    expect((await changeStage(agent2, c, 'connected')).body.automation).toEqual({ skipped: 'plan_not_approved', plan: 'Revoked plan' });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 a retired playbook is no candidate (its stage entry starts nothing)', async () => {
    const p = await playbook(w.owner, { scope: 'team', name: 'Retired plan' });
    expect((await setStage(w.owner, p.id, 'lost')).status).toBe(200);
    await h.su.query("UPDATE playbooks SET status = 'retired' WHERE id = $1", [p.id]); // no retire route in this module
    const c = await newContact(agent2);
    expect((await changeStage(agent2, c, 'lost')).body.automation).toBeNull();
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
    expect((await setStage(w.owner, p.id, 'lost')).code).toBe('PLAYBOOK_RETIRED');
  });

  it('R-PAR-16 with core bypassed, the DB refuses a stage_change enrollment from a draft version (PLAYBOOK_NOT_APPROVED)', async () => {
    const draft = await playbook(w.owner, { scope: 'team', name: 'Draft plan', approve: false });
    const c = await newContact(agent2);
    await expect(withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => P.insertEnrollment(tx, { id: randomUUID(), playbookId: draft.id, versionId: draft.versionId, contactId: c, enrolledBy: 'stage_change', userId: agent2.userId!, dueAt: now, anchor: null }), { db: h.database })).rejects.toThrow(/PLAYBOOK_NOT_APPROVED/);
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 with core bypassed, the DB refuses a second live enrollment (enrollment_one_live)', async () => {
    const c = await newContact(agent2);
    expect((await changeStage(agent2, c, 'active')).body.automation).toEqual({ started: 'Buyer plan' });
    await expect(withTenantTx(systemActor(w.tenantId, 'assistant'), (tx, now) => P.insertEnrollment(tx, { id: randomUUID(), playbookId: buyer.id, versionId: buyer.versionId, contactId: c, enrolledBy: 'stage_change', userId: agent2.userId!, dueAt: now, anchor: null }), { db: h.database })).rejects.toThrow(/enrollment_one_live/);
  });
});

describe('R-PAR-16 adversarial: never a person the stage-changer cannot see', () => {
  it('R-PAR-16 R-PERM-5 the stage-changer lost the person before the decision (reassigned away): skipped not_visible', async () => {
    const c = await newContact(agent2);
    const ev = await rawStageChange(h, agent2, c, 'active');
    const st = (await h.su.query<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [c])).rows[0]!;
    const r = await command(w.owner, c, 'reassign', { toUserId: agent.userId, expectedSeq: Number(st.ownership_seq) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // the person now belongs to the first agent: their own plan is the candidate, but the changer can't see them
    expect((await reconcileAsJob(h, w.tenantId, ev)).automation).toEqual({ skipped: 'not_visible', plan: "Ana's plan" });
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 a person invisible to the caller cannot have their stage changed at all (404), so nothing is decided', async () => {
    const c = await newContact(agent);
    const r = await changeStage(agent2, c, 'active');
    expect(r.status).toBe(404);
    expect(await decisionsOf(h, c)).toHaveLength(0);
  });

  it('R-PAR-16 a decision is readable only with the person\'s detail; app_user can never write or change one', async () => {
    const c = await newContact(agent);
    await changeStage(agent, c, 'active');
    const [d] = await decisionsOf(h, c);
    expect(d).toBeDefined();
    const read = (who: TestClient) => withTenantTx(who.actor(), (tx) => sql<{ n: number }>`SELECT count(*)::int AS n FROM stage_automation_decisions WHERE contact_id = ${c}`.execute(tx), { db: h.database });
    expect((await read(agent)).rows[0]!.n).toBe(1);
    expect((await read(agent2)).rows[0]!.n).toBe(0);
    expect((await read(w.owner)).rows[0]!.n).toBe(1);
    // a user cannot forge a decision (system-only insert), nor change or delete one (no grant)
    await expect(withTenantTx(w.owner.actor(), (tx) => sql`INSERT INTO stage_automation_decisions (tenant_id, stage_event_id, contact_id, to_stage, outcome, reason, playbook_id) VALUES (app.tenant_id(), ${randomUUID()}, ${c}, 'active', 'skipped', 'not_visible', ${buyer.id})`.execute(tx), { db: h.database })).rejects.toThrow();
    await expect(withTenantTx(w.owner.actor(), (tx) => sql`UPDATE stage_automation_decisions SET reason = 'not_visible' WHERE contact_id = ${c}`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    await expect(withTenantTx(w.owner.actor(), (tx) => sql`DELETE FROM stage_automation_decisions WHERE contact_id = ${c}`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    // and a forged skip cannot pre-empt a real event: the closed set is a CHECK
    await expect(h.su.query("INSERT INTO stage_automation_decisions (tenant_id, stage_event_id, contact_id, to_stage, outcome, reason, playbook_id) VALUES ($1, $2, $3, 'active', 'skipped', 'because', $4)", [w.tenantId, d!.stage_event_id, c, buyer.id])).rejects.toThrow();
  });
});

describe('R-PAR-16 R-TEN adversarial: tenant isolation of the handler and the route', () => {
  it('R-PAR-16 R-TEN-1 another tenant\'s reconcile, scan and job never see or decide this tenant\'s stage events', async () => {
    const c = await newContact(agent2);
    const ev = await rawStageChange(h, agent2, c, 'active');
    expect(await scanPending(h, other.tenantId)).not.toContain(ev);
    const r = await reconcileStageEvent({ db: h.database }, other.tenantId, ev);
    expect(r).toEqual({ automation: null, decided: false, enrollmentId: null });
    expect(await reconcileAsJob(h, other.tenantId, ev)).toEqual({ automation: null, decided: false, enrollmentId: null });
    expect(await decisionsOf(h, c)).toHaveLength(0);
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
    // the owning tenant still decides it normally afterwards
    expect((await reconcileAsJob(h, w.tenantId, ev)).automation).toEqual({ started: 'Buyer plan' });
  });

  it('R-PAR-16 R-PERM-5 another tenant\'s Owner cannot set this tenant\'s playbook stage (404), and nothing changes', async () => {
    const r = await setStage(other.owner, buyer.id, 'closed');
    expect(r.status).toBe(404);
    expect((await h.su.query('SELECT auto_enroll_stage FROM playbooks WHERE id = $1', [buyer.id])).rows[0].auto_enroll_stage).toBe('active');
  });

  it('R-PAR-16 a playbook of another tenant naming the stage never enrolls this tenant\'s people', async () => {
    const theirs = await playbook(other.owner, { scope: 'team', name: 'Their plan' });
    expect((await setStage(other.owner, theirs.id, 'nurture')).status).toBe(200);
    const c = await newContact(agent2);
    expect((await changeStage(agent2, c, 'nurture')).body.automation).toBeNull();
    expect(await enrollmentsOf(h, c)).toHaveLength(0);
  });
});

describe('R-PAR-16 R-PERM-11 adversarial: who may set auto_enroll_stage', () => {
  it('R-PAR-16 a TC cannot set auto_enroll_stage on any playbook (404)', async () => {
    expect((await setStage(tc, buyer.id, 'closed')).status).toBe(404);
    expect((await setStage(tc, agentPlan.id, 'closed')).status).toBe(404);
  });

  it('R-PAR-16 R-PERM-11 a support actor cannot set it: core denies, and the DB refuses the write', async () => {
    const support: Actor = { kind: 'support', userId: w.owner.userId!, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
    expect(can(support, 'playbook.auto_enroll_stage', { teamPlaybook: true }).ok).toBe(false);
    await expect(withTenantTx(support, (tx) => sql`UPDATE playbooks SET auto_enroll_stage = 'closed' WHERE tenant_id = app.tenant_id() AND id = ${buyer.id}`.execute(tx), { db: h.database })).rejects.toBeTruthy();
    expect((await h.su.query('SELECT auto_enroll_stage FROM playbooks WHERE id = $1', [buyer.id])).rows[0].auto_enroll_stage).toBe('active');
  });

  it('R-PAR-16 an agent cannot point another agent\'s playbook at a stage, nor a team playbook', async () => {
    expect((await setStage(agent2, agentPlan.id, 'closed')).status).toBe(404);
    expect((await setStage(agent2, buyer.id, 'closed')).status).toBe(404);
  });
});

describe('R-PAR-16 R-PAR-45 adversarial: a merge copies history; the copy is not a stage entry', () => {
  it('R-PAR-16 merging a person whose stage entry was decided never enrolls the survivor from the copied event', async () => {
    const loser = await newContact(agent2, { firstName: 'Lou' });
    const survivor = await newContact(agent2, { firstName: 'Sam' });
    await rawStageChange(h, agent2, survivor, 'active'); // survivor already Active (its own event)
    await h.su.query('DELETE FROM jobs WHERE tenant_id = $1 AND kind = $2', [w.tenantId, 'stage_automation.reconcile']);
    const ev = await rawStageChange(h, agent2, loser, 'active');
    const st = (await h.su.query<{ ownership_seq: string }>('SELECT ownership_seq FROM contacts WHERE id = $1', [survivor])).rows[0]!;
    const m = await command(w.owner, survivor, 'merge', { loserId: loser, expectedSeq: Number(st.ownership_seq) });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const copies = (await h.su.query<{ id: string }>("SELECT id FROM contact_stage_events WHERE contact_id = $1 AND to_stage = 'active' ORDER BY occurred_at", [survivor])).rows.map((x) => x.id);
    expect(copies.length).toBe(2); // its own event + the loser's copy
    const pending = await scanPending(h, w.tenantId);
    // the copy (the loser's instant, later than the survivor's own event) is never scanned, and a direct
    // reconcile of it decides nothing
    expect(copies[1]).not.toBe(ev);
    expect(pending).not.toContain(copies[1]);
    expect((await reconcileAsJob(h, w.tenantId, copies[1]!)).automation).toBeNull();
  });
});
