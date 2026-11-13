// Batch 12 interaction review fixes for module 75 (D12 PROPOSED; fakes only). Each describe names the finding it covers.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { command } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { slaSweepInTx } from './handoff.js';
import { assignmentOf, call, isaLead, isaWorld, type IsaWorld, runIsa, startCare } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
  // agent 1 holds the survivor in the merge cases and takes reassigned leads; it opts in too
  const { optInAgent } = await import('./testing.js');
  await optInAgent(h, w.agents[1]!, w.versionId);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const handoffs = async (ids: string[]) => (await h.su.query<{ id: string; contact_id: string; reason: string; recipient_user_id: string | null; sla_class: string; sla_met_at: Date | null; sla_escalation_level: number; package: { nextSteps: string[] } }>(
  `SELECT id, contact_id, reason, recipient_user_id, sla_class, sla_met_at, sla_escalation_level, package FROM ai_isa_handoffs WHERE contact_id = ANY($1::uuid[])`, [ids])).rows;
const cards = async (ids: string[]) => (await h.su.query<{ contact_id: string; user_id: string; state: string; text: string }>(
  `SELECT contact_id, user_id, state, reasons->0->>'text' AS text FROM priority_feed_items WHERE contact_id = ANY($1::uuid[]) AND item_type = 'ai_isa_handoff'`, [ids])).rows;
const actions = async (ids: string[]) => (await h.su.query<{ contact_id: string; owner_user_id: string; status: string }>(
  `SELECT contact_id, owner_user_id, status FROM assistant_actions WHERE contact_id = ANY($1::uuid[]) AND kind = 'ai_isa_handoff'`, [ids])).rows;
const overdue = async (contactIds: string[]) => (await h.su.query(`SELECT user_id FROM notifications WHERE kind = 'ai_isa_handoff_overdue' AND subject_id = ANY($1::uuid[])`, [contactIds])).rows.length;
/** Ages the handoff's deadline (the guard lets only the system move it; the superuser seeds the instant) and sweeps. */
async function ageAndSweep(handoffId: string) {
  await h.su.query(`SET session_replication_role = replica`);
  try {
    await h.su.query(`UPDATE ai_isa_handoffs SET sla_due_at = now() - interval '1 minute', created_at = now() - interval '2 minutes' WHERE id = $1 AND sla_class <> 'none'`, [handoffId]);
  } finally {
    await h.su.query(`SET session_replication_role = origin`);
  }
  const deps = depsFromPlatform(h.app.platform);
  const actor = systemActor(w.tenantId, 'assistant');
  return withTenantTx(actor, (tx, now) => slaSweepInTx(tx, deps.ids, now, actor), { db: h.database });
}
const touch = (contactId: string) => h.su.query(`UPDATE contacts SET last_human_touch_at = now() WHERE id = $1`, [contactId]);

describe('b12 review db-isa-merge-1: a person block on a merged-away record (R-ISA-31, R-ISA-16; E505, E526)', () => {
  it('R-ISA-31 E505: the survivor\'s panel shows the merged-away record\'s block and a start on the survivor is refused AI_ISA_PERSON_DECLINED', async () => {
    const agent = w.agents[0]!;
    const loser = await isaLead(h, agent);
    const survivor = await isaLead(h, agent);
    await h.su.query(`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, reason, created_at) VALUES ($1, $2, $3, 'ai_declined', now() - interval '1 hour')`, [w.tenantId, randomUUID(), loser.id]);
    const m = await command(w.owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: agent.userId });
    expect(m.status).toBe(200);
    await runIsa(h, w.tenantId, 1);
    const p = await call<{ block: { reason: string } | null; canStart: boolean; startRefusal: { code: string } | null }>(agent, 'GET', `/contacts/${survivor.id}/ai-isa`);
    expect(p.status).toBe(200);
    expect(p.body.block?.reason).toBe('ai_declined');
    expect(p.body.canStart).toBe(false);
    expect(p.body.startRefusal?.code).toBe('AI_ISA_PERSON_DECLINED');
    const s = await startCare(agent, survivor.id);
    expect(s.status).toBe(409);
    expect(s.body).toMatchObject({ error: { code: 'AI_ISA_PERSON_DECLINED' } });
  });
});

describe('b12 review F1, F6, B12X-3: a merge that ends live AI care on the merged-away record (R-ISA-16, R-ISA-30; E526, E521)', () => {
  it('R-ISA-16 E526: the handoff, its action and its card land on the survivor for the survivor\'s owner ("this lead moved"); a touch on the survivor clears the deadline; the survivor\'s panel shows it', async () => {
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const loser = await isaLead(h, a0);
    const survivor = await isaLead(h, a1);
    expect((await startCare(a0, loser.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const m = await command(w.owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: a1.userId });
    expect(m.status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, loser.id))!.end_reason).toBe('merged');
    const [ho] = await handoffs([loser.id, survivor.id]);
    expect(ho).toMatchObject({ contact_id: survivor.id, reason: 'merged', recipient_user_id: a1.userId });
    expect(await cards([loser.id, survivor.id])).toEqual([{ contact_id: survivor.id, user_id: a1.userId, state: 'open', text: 'AI care ended because this lead moved. Here is what it did.' }]);
    expect(await actions([loser.id, survivor.id])).toEqual([{ contact_id: survivor.id, owner_user_id: a1.userId, status: 'proposed' }]);
    // the survivor's owner reads the person's AI history on the survivor and acknowledges the handoff
    const panel = await call<{ assignment: { id: string; endReason: string } | null; handoff: { id: string } | null }>(a1, 'GET', `/contacts/${survivor.id}/ai-isa`);
    expect(panel.status, JSON.stringify(panel.body)).toBe(200);
    expect(panel.body.assignment?.endReason).toBe('merged');
    expect(panel.body.handoff?.id).toBe(ho!.id);
    const ack = await call(a1, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {});
    expect(ack.status).toBe(200);
    await touch(survivor.id);
    expect(await ageAndSweep(ho!.id)).toMatchObject({ met: 1, escalated: 0 });
    expect(await overdue([loser.id, survivor.id])).toBe(0);
  });
});

describe('b12 review F2, B12X-3: a merge after a pending AI handoff on the merged-away record (R-ISA-16, R-ISA-30; E526)', () => {
  it('R-ISA-16 E526: the pending handoff card stays open and follows the survivor and its owner; a touch on the survivor clears the deadline', async () => {
    const agent = w.agents[0]!;
    const loser = await isaLead(h, agent);
    const survivor = await isaLead(h, agent);
    expect((await startCare(agent, loser.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await call(agent, 'POST', `/contacts/${loser.id}/ai-isa/end`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1 AND finalize_at IS NOT NULL`, [loser.id]);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([loser.id]);
    expect(ho).toBeTruthy();
    expect((await cards([loser.id]))[0]?.state).toBe('open');
    const m = await command(w.owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: agent.userId });
    expect(m.status).toBe(200);
    await runIsa(h, w.tenantId);
    expect(await cards([loser.id, survivor.id])).toEqual([expect.objectContaining({ contact_id: survivor.id, user_id: agent.userId, state: 'open' })]);
    expect(await actions([loser.id, survivor.id])).toEqual([{ contact_id: survivor.id, owner_user_id: agent.userId, status: 'proposed' }]);
    await touch(survivor.id);
    expect(await ageAndSweep(ho!.id)).toMatchObject({ met: 1, escalated: 0 });
    expect(await overdue([loser.id, survivor.id])).toBe(0);
  });
});

describe('b12 review F3: an owner change or a close ends AI care (R-ISA-16, R-ISA-30; E525, E521)', () => {
  it('R-ISA-16 E525: after a reassignment the new owner gets the handoff ("this lead moved"); the old owner gets nothing; a pending handoff card follows a later owner change', async () => {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const r = await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids });
    expect(r.ok).toBe(true);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId });
    expect(await cards([l.id])).toEqual([{ contact_id: l.id, user_id: a1.userId, state: 'open', text: 'AI care ended because this lead moved. Here is what it did.' }]);
    // the lead moves on again: the pending card and its action follow the current owner (ARCHITECTURE §10)
    const back = await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a0.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids });
    expect(back.ok).toBe(true);
    await runIsa(h, w.tenantId, 1);
    expect(await cards([l.id])).toEqual([expect.objectContaining({ user_id: a0.userId, state: 'open' })]);
    expect((await actions([l.id]))[0]?.owner_user_id).toBe(a0.userId);
    // the current owner acknowledges it
    expect((await call(a0, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {})).status).toBe(200);
  });

  it('R-ISA-30 E521: a close (not a lead) ends care with a handoff to the Team Lead and Owner/Admin ("this lead was closed") and no deadline: nobody can touch a closed lead', async () => {
    const a0 = w.agents[0]!;
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const c = await command(a0, l.id, 'close', { reason: 'not_a_lead' });
    expect(c.status).toBe(200);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: null, sla_class: 'none' });
    const cs = await cards([l.id]);
    expect(cs.map((x) => x.user_id)).not.toContain(a0.userId);
    expect(cs.map((x) => x.user_id)).toContain(w.teamLead!.userId);
    expect(new Set(cs.map((x) => x.text))).toEqual(new Set(['AI care ended because this lead was closed. Here is what it did.']));
    expect(await ageAndSweep(ho!.id)).toMatchObject({ met: 0, escalated: 0 });
    expect(await overdue([l.id])).toBe(0);
  });
});

describe('b12 review B12X-2: an end D1 makes unreachable (R-ISA-30, R-ISA-31; E521)', () => {
  it('R-ISA-30 E521: a person-level do-not-contact ends care with a handoff that has no deadline and no call_now step; the sweep sends no overdue alert and the panel is not overdue', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await call(agent, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect(['do_not_contact', 'opted_out']).toContain((await assignmentOf(h, l.id))!.end_reason);
    const [ho] = await handoffs([l.id]);
    expect(ho!.sla_class).toBe('none');
    expect(ho!.package.nextSteps).not.toContain('call_now');
    expect(await ageAndSweep(ho!.id)).toMatchObject({ met: 0, escalated: 0 });
    expect(await overdue([l.id])).toBe(0);
    const panel = await call<{ handoff: { overdue: boolean } | null }>(agent, 'GET', `/contacts/${l.id}/ai-isa`);
    expect(panel.body.handoff?.overdue).toBe(false);
  });
});

describe('b12 review B12X-4: nothing automated runs beside live AI care (R-ISA-2)', () => {
  /** A scheduled module 26 trigger firing of the person (the row detect.ts writes; the superuser seeds it). */
  async function scheduledFiring(contactId: string): Promise<string> {
    const id = randomUUID();
    await h.su.query(`INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
      VALUES ($1, $2, NULL, $3, 'price_drop', 'scheduled', now() - interval '1 minute', $4, $5, '{"v":1,"trigger":"price_drop"}'::jsonb)`, [w.tenantId, id, w.versionId, contactId, `zz:${id}`]);
    return id;
  }
  const runOf = async (id: string) => (await h.su.query<{ status: string; reason: string | null }>(`SELECT status, trigger_ref->'skip'->>'reason' AS reason FROM playbook_step_runs WHERE id = $1`, [id])).rows[0]!;

  it('R-ISA-2: a stage change under live AI care records the skip ai_isa_active and says so; no enrollment starts and the scan has nothing left to retry', async () => {
    const { changeStage, playbook, scanPending, setStage } = await import('../stageAutomation/testing.js');
    const pb = await playbook(w.owner, { scope: 'team', name: 'Active plan' });
    expect((await setStage(w.owner, pb.id, 'active')).status).toBe(200);
    try {
      const agent = w.agents[0]!;
      const l = await isaLead(h, agent);
      expect((await startCare(agent, l.id)).status).toBe(200);
      await runIsa(h, w.tenantId);
      const r = await changeStage(agent, l.id, 'active');
      expect(r.status).toBe(200);
      expect(r.body.automation).toEqual({ skipped: 'ai_isa_active', plan: 'Active plan' });
      const d = await h.su.query(`SELECT outcome, reason FROM stage_automation_decisions WHERE contact_id = $1`, [l.id]);
      expect(d.rows).toEqual([{ outcome: 'skipped', reason: 'ai_isa_active' }]);
      expect((await h.su.query(`SELECT 1 FROM playbook_enrollments WHERE contact_id = $1 AND state = 'active'`, [l.id])).rows.length).toBe(0);
      const events = (await h.su.query<{ id: string }>(`SELECT id FROM contact_stage_events WHERE contact_id = $1`, [l.id])).rows.map((x) => x.id);
      expect(events.length).toBeGreaterThan(0);
      const pending = await scanPending(h, w.tenantId);
      expect(events.filter((e) => pending.includes(e))).toEqual([]);
    } finally {
      await setStage(w.owner, pb.id, null);
    }
  });

  it('R-ISA-2: starting AI care skips the person\'s scheduled trigger firings, and a firing due while care is live is skipped AI_ISA_ACTIVE, never sent', async () => {
    const { executeTriggerRunInTx } = await import('../nurture/execute.js');
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    const before = await scheduledFiring(l.id);
    expect((await startCare(agent, l.id)).status).toBe(200);
    expect(await runOf(before)).toEqual({ status: 'skipped_ineligible', reason: 'AI_ISA_ACTIVE' });
    const during = await scheduledFiring(l.id);
    const deps = depsFromPlatform(h.app.platform);
    const out = await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => executeTriggerRunInTx(tx, deps as never, w.tenantId, during, now), { db: h.database });
    expect(out).toEqual({ kind: 'skipped', runIds: [during], reasons: ['AI_ISA_ACTIVE'] });
    expect(await runOf(during)).toEqual({ status: 'skipped_ineligible', reason: 'AI_ISA_ACTIVE' });
  });
});

describe('b12 review B12X-5: a later carrier status of an AI ISA message reaches the machine (R-ISA-14; E518)', () => {
  it('R-ISA-14 E518: an undelivered status callback for a sent AI text emits send_result once, and the machine counts it toward delivery_problem (2 in a row)', async () => {
    const { inboundSms } = await import('../comms/testing.js');
    const { applyMessageStatus } = await import('../comms/status.js');
    const { aiMessages } = await import('./testing.js');
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const undeliver = async (id: string, n: number) => {
      const r = await applyMessageStatus(systemActor(w.tenantId, 'provider'), { providerEventRef: `evt-undelivered-${id}-${n}`, message: { id }, providerStatus: 'undelivered', mapped: 'undelivered', errorCode: '30003', occurredAt: Date.now() as never }, depsFromPlatform(h.app.platform));
      expect(r.kind).toBe('applied');
    };
    await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
    await runIsa(h, w.tenantId);
    const first = (await aiMessages(h, l.id)).filter((m) => m.status === 'sent').at(-1)!;
    expect(first).toBeTruthy();
    await undeliver(first.id, 1);
    const jobs = await h.su.query<{ s: string }>(`SELECT payload->>'status' AS s FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1 ORDER BY id`, [first.id]);
    expect(jobs.rows.map((x) => x.s)).toEqual(['sent', 'undelivered']);
    await runIsa(h, w.tenantId, 1);
    expect((await h.su.query<{ n: number }>(`SELECT undelivered_streak AS n FROM ai_isa_assignments WHERE contact_id = $1`, [l.id])).rows[0]!.n).toBe(1);
    // a re-delivered callback is a duplicate: no second job
    const again = await applyMessageStatus(systemActor(w.tenantId, 'provider'), { providerEventRef: `evt-undelivered-${first.id}-1`, message: { id: first.id }, providerStatus: 'undelivered', mapped: 'undelivered', errorCode: '30003', occurredAt: Date.now() as never }, depsFromPlatform(h.app.platform));
    expect(again.kind).toBe('duplicate');
  });
});

describe('b12 recheck R1: one carrier failure counts once (R-ISA-14; E518)', () => {
  it('R-ISA-14 E518: the undelivered callback commits before TX2\'s sent job runs: the stale sent job does nothing and the streak is 1, care goes on', async () => {
    const { inboundSms } = await import('../comms/testing.js');
    const { applyMessageStatus } = await import('../comms/status.js');
    const { aiMessages } = await import('./testing.js');
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
    // the worker is behind: TX2 commits the sent message and its send_result job, which does not run yet
    await runIsa(h, w.tenantId, 4, { hold: ['ai_isa.send_result'] });
    const sent = (await aiMessages(h, l.id)).filter((m) => m.status === 'sent').at(-1)!;
    expect(sent).toBeTruthy();
    const job = async () => (await h.su.query<{ s: string; st: string }>(`SELECT payload->>'status' AS s, status AS st FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1 ORDER BY id`, [sent.id])).rows;
    expect(await job()).toEqual([{ s: 'sent', st: 'pending' }]);
    const r = await applyMessageStatus(systemActor(w.tenantId, 'provider'), { providerEventRef: `evt-undelivered-r1-${sent.id}`, message: { id: sent.id }, providerStatus: 'undelivered', mapped: 'undelivered', errorCode: '30003', occurredAt: Date.now() as never }, depsFromPlatform(h.app.platform));
    expect(r.kind).toBe('applied');
    expect((await job()).map((x) => x.s)).toEqual(['sent', 'undelivered']);
    await runIsa(h, w.tenantId, 2);
    const a = (await h.su.query<{ n: number; end_reason: string | null }>(`SELECT undelivered_streak AS n, end_reason FROM ai_isa_assignments WHERE contact_id = $1`, [l.id])).rows[0]!;
    expect(a).toEqual({ n: 1, end_reason: null });
  });
});

describe('b12 recheck R7: a provider "sent" is no proof of reach, so 2 undelivered in a row end care in the normal order (R-ISA-11, R-ISA-14; E518)', () => {
  /** Live care on a fresh lead. Its start is moved an hour back: runIsa ages each inbound by 3 minutes (there is no fake
   *  clock) and a turn reads only inbounds since the start once one was consumed. */
  async function caredLead() {
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    await h.su.query(`SET session_replication_role = replica`);
    try {
      await h.su.query(`UPDATE ai_isa_assignments SET started_at = started_at - interval '1 hour' WHERE contact_id = $1`, [l.id]);
    } finally {
      await h.su.query(`SET session_replication_role = origin`);
    }
    return l;
  }
  /** One AI reply to a fresh inbound, sent and its sent job run first (the worker is not behind); its dispatch is aged
   *  past the 2-minute gap so the next reply is not deferred. */
  async function aiReply(l: { id: string; phone: string }, text: string): Promise<string> {
    const { inboundSms } = await import('../comms/testing.js');
    const { aiMessages } = await import('./testing.js');
    await inboundSms(h, l.phone, w.mainNumber, text);
    await runIsa(h, w.tenantId);
    const sent = (await aiMessages(h, l.id)).filter((m) => m.status === 'sent').at(-1);
    expect(sent, 'an AI reply reached sent').toBeTruthy();
    const jobs = await h.su.query<{ s: string; st: string }>(`SELECT payload->>'status' AS s, status AS st FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1`, [sent!.id]);
    expect(jobs.rows).toEqual([{ s: 'sent', st: 'succeeded' }]);
    await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '3 minutes' WHERE id = $1`, [sent!.id]);
    return sent!.id;
  }
  /** The carrier's later status of that text (status callback), and the worker runs its send_result job. */
  async function carrier(id: string, status: 'undelivered' | 'delivered') {
    const { applyMessageStatus } = await import('../comms/status.js');
    const r = await applyMessageStatus(systemActor(w.tenantId, 'provider'), { providerEventRef: `evt-r7-${status}-${id}`, message: { id }, providerStatus: status, mapped: status, errorCode: status === 'undelivered' ? '30003' : null, occurredAt: Date.now() as never }, depsFromPlatform(h.app.platform));
    expect(r.kind).toBe('applied');
    await runIsa(h, w.tenantId, 2);
  }
  const care = async (contactId: string) => (await h.su.query<{ n: number; sent: number; end_reason: string | null }>(`SELECT undelivered_streak AS n, messages_sent AS sent, end_reason FROM ai_isa_assignments WHERE contact_id = $1`, [contactId])).rows[0]!;

  it('R-ISA-11 E518: two AI texts are sent and their sent jobs run first; both come back undelivered: care ends delivery_problem with a handoff', async () => {
    const l = await caredLead();
    await carrier(await aiReply(l, 'Hi, we are looking for a place soon'), 'undelivered');
    expect(await care(l.id)).toEqual({ n: 1, sent: 1, end_reason: null });
    const b = await aiReply(l, 'Sorry, did you get my text?');
    expect(await care(l.id)).toEqual({ n: 1, sent: 2, end_reason: null });
    await carrier(b, 'undelivered');
    expect((await care(l.id)).end_reason).toBe('delivery_problem');
    expect((await handoffs([l.id])).map((x) => x.reason)).toEqual(['delivery_problem']);
  });

  it('R-ISA-11 E518: undelivered, then a text sent and delivered, then undelivered: the delivery reset the streak and care goes on', async () => {
    const l = await caredLead();
    await carrier(await aiReply(l, 'Hi, we are looking for a place soon'), 'undelivered');
    expect(await care(l.id)).toMatchObject({ n: 1, end_reason: null });
    await carrier(await aiReply(l, 'Sorry, did you get my text?'), 'delivered');
    expect(await care(l.id)).toMatchObject({ n: 0, end_reason: null });
    await carrier(await aiReply(l, 'Still looking, any news?'), 'undelivered');
    expect(await care(l.id)).toEqual({ n: 1, sent: 3, end_reason: null });
  });
});

describe('b12 recheck R2, R8: the overdue escalation follows whoever holds the card now (R-ISA-30; E525, E521)', () => {
  /** a1 leads with a Team Lead of their own (Team B); a0 stays on Team A under w.teamLead. Restored after `fn`. */
  async function twoTeams(fn: (tl2: TestClient) => Promise<void>) {
    const [u0, u1] = [w.agents[0]!.userId!, w.agents[1]!.userId!];
    const tl2 = await h.invite(w.owner, 'team_lead');
    const teamB = await call<{ team: { id: string } }>(w.owner, 'POST', '/teams', { name: `Team B ${randomUUID().slice(0, 8)}` });
    expect(teamB.status).toBe(201);
    const teamA = (members: string[]) => call(w.owner, 'PUT', `/teams/${w.teamId}/members`, { members: [...members.map((userId) => ({ userId, isLead: false })), { userId: w.teamLead!.userId!, isLead: true }] });
    expect((await teamA([u0])).status).toBe(200);
    expect((await call(w.owner, 'PUT', `/teams/${teamB.body.team.id}/members`, { members: [{ userId: u1, isLead: false }, { userId: tl2.userId!, isLead: true }] })).status).toBe(200);
    try {
      await fn(tl2);
    } finally {
      await call(w.owner, 'PUT', `/teams/${teamB.body.team.id}/members`, { members: [] });
      await teamA([u0, u1]);
    }
  }
  /** Care on a0's lead ends owner_change when it moves to a1 (the handoff's frozen recipient), then it moves back to a0. */
  async function handedToA1ThenBack() {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    const ids = depsFromPlatform(h.app.platform).ids;
    const move = (to: string) => runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: to as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids });
    expect((await move(a1.userId!)).ok).toBe(true);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId });
    expect(ho!.sla_class).not.toBe('none');
    expect((await move(a0.userId!)).ok).toBe(true);
    await runIsa(h, w.tenantId, 1);
    expect(await cards([l.id])).toEqual([expect.objectContaining({ user_id: a0.userId, state: 'open' })]);
    return { l, ho: ho! };
  }
  const overdueTo = async (contactId: string) => (await h.su.query<{ user_id: string }>(`SELECT user_id FROM notifications WHERE kind = 'ai_isa_handoff_overdue' AND subject_id = $1`, [contactId])).rows.map((r) => r.user_id);

  it('R-ISA-30 E525: a handoff to a1 whose lead moves on to a0 escalates, when overdue, to a0\'s Team Lead, not a1\'s', async () => {
    await twoTeams(async () => {
      const { l, ho } = await handedToA1ThenBack();
      expect(await ageAndSweep(ho.id)).toMatchObject({ met: 0, escalated: 1 });
      expect(await overdueTo(l.id)).toEqual([w.teamLead!.userId]);
    });
  });

  it('R-ISA-30 E521 (b12 recheck R8): a handoff to a1 whose lead moves to a0 and then to the pond escalates to the card\'s holder, a0\'s Team Lead, not a1\'s', async () => {
    await twoTeams(async (tl2) => {
      const { l, ho } = await handedToA1ThenBack();
      // a0 releases the lead: the pending card and its action go to the previous owner's Team Lead (rehomeHandbacks)
      expect((await command(w.agents[0]!, l.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
      await runIsa(h, w.tenantId, 1);
      expect((await h.su.query<{ s: string }>(`SELECT ownership_state AS s FROM contacts WHERE id = $1`, [l.id])).rows[0]!.s).not.toBe('owned');
      expect(await cards([l.id])).toEqual([expect.objectContaining({ user_id: w.teamLead!.userId, state: 'open' })]);
      expect(await actions([l.id])).toEqual([expect.objectContaining({ owner_user_id: w.teamLead!.userId, status: 'proposed' })]);
      // (the sweep is tenant-wide: an earlier case's handoff may reach its second level in the same sweep)
      expect((await ageAndSweep(ho.id)).escalated).toBeGreaterThanOrEqual(1);
      expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 1 });
      const to = await overdueTo(l.id);
      expect(to, 'not the frozen recipient\'s Team Lead').not.toContain(tl2.userId);
      expect(to).toEqual([w.teamLead!.userId]);
    });
  });

  it.each([['rejected'], ['invalidated']] as const)('R-ISA-30 E521 (b12 recheck R10): a handoff to a1 whose card was decided (%s) and whose lead a1 then releases to the pond escalates to a1\'s Team Lead, never to a1 alone', async (decided) => {
    await twoTeams(async (tl2) => {
      const { runOwnershipCommand } = await import('../leads/ownership.js');
      const [a0, a1] = [w.agents[0]!, w.agents[1]!];
      const l = await isaLead(h, a0);
      expect((await startCare(a0, l.id)).status).toBe(200);
      await runIsa(h, w.tenantId);
      const ids = depsFromPlatform(h.app.platform).ids;
      expect((await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids })).ok).toBe(true);
      await runIsa(h, w.tenantId);
      const [ho] = await handoffs([l.id]);
      expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId });
      expect(ho!.sla_class).not.toBe('none');
      // a1's card is decided: before b12 recheck R11 the generic Dismiss rejected it and the generic "Got it" invalidated
      // it, each closing the card (both refuse it now, R11), so such a row is seeded as those taps left it
      const actionId = (await h.su.query<{ id: string }>(`SELECT assistant_action_id AS id FROM ai_isa_handoffs WHERE id = $1`, [ho!.id])).rows[0]!.id;
      expect((await call(a1, 'POST', `/assistant/actions/${actionId}/reject`)).status).toBe(409);
      await h.su.query(`UPDATE assistant_actions SET status = $2, decided_by_user_id = CASE WHEN $2 = 'rejected' THEN $3::uuid END, decided_at = CASE WHEN $2 = 'rejected' THEN now() END WHERE id = $1`, [actionId, decided, a1.userId]);
      await h.su.query(`UPDATE priority_feed_items SET state = 'done', resolved_at = now() WHERE assistant_action_id = $1`, [actionId]);
      // a1 releases the lead: rehomeHandbacks moves proposed cards only, so the decided action stays a1's
      expect((await command(a1, l.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
      await runIsa(h, w.tenantId, 1);
      expect((await h.su.query<{ s: string }>(`SELECT ownership_state AS s FROM contacts WHERE id = $1`, [l.id])).rows[0]!.s).not.toBe('owned');
      expect(await actions([l.id])).toEqual([expect.objectContaining({ owner_user_id: a1.userId, status: decided })]);
      // (the sweep is tenant-wide: an earlier case's handoff may reach its second level in the same sweep)
      expect((await ageAndSweep(ho!.id)).escalated).toBeGreaterThanOrEqual(1);
      expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 1 });
      const to = await overdueTo(l.id);
      expect(to, 'never the agent who released it').not.toContain(a1.userId);
      expect(to).toEqual([tl2.userId]);
      // level 2: that Team Lead and Owner/Admin, still never the releasing agent
      expect((await ageAndSweep(ho!.id)).escalated).toBeGreaterThanOrEqual(1);
      expect((await handoffs([l.id]))[0]).toMatchObject({ sla_escalation_level: 2 });
      const to2 = await overdueTo(l.id);
      expect(to2).not.toContain(a1.userId);
      expect(to2).toEqual(expect.arrayContaining([tl2.userId, w.owner.userId]));
    });
  });

  it('R-ISA-30 E521 (b12 recheck R14, R18): a handoff card decided while a1 owned the lead, which a2 created and which then moves to a0 and a0 releases to the pond, escalates to a0\'s Team Lead (the ledger\'s last owner), never to tl2, a1 or the first owner\'s escalation', async () => {
    await twoTeams(async (tl2) => {
      const { runOwnershipCommand } = await import('../leads/ownership.js');
      const { optInAgent } = await import('./testing.js');
      const [a0, a1] = [w.agents[0]!, w.agents[1]!];
      // b12 recheck R18: the ledger's first owner is a third agent, a2 (on no team, so its unowned-card holder is an
      // Owner/Admin): the first owner (a2), the frozen recipient (a1) and the last owner (a0) all differ, so reading the
      // ledger's first owner instead of its last would alert the Owner/Admin, and the frozen recipient would alert tl2
      const a2 = await h.invite(w.owner, 'agent');
      await optInAgent(h, a2, w.versionId);
      const l = await isaLead(h, a2);
      expect((await startCare(a2, l.id)).status).toBe(200);
      await runIsa(h, w.tenantId);
      const ids = depsFromPlatform(h.app.platform).ids;
      const move = (to: string) => runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: to as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids });
      expect((await move(a1.userId!)).ok).toBe(true);
      await runIsa(h, w.tenantId);
      const [ho] = await handoffs([l.id]);
      expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId });
      expect(ho!.sla_class).not.toBe('none');
      // a1's card is decided as the pre-R11 generic Dismiss left it (seeded: the taps refuse it now)
      const actionId = (await h.su.query<{ id: string }>(`SELECT assistant_action_id AS id FROM ai_isa_handoffs WHERE id = $1`, [ho!.id])).rows[0]!.id;
      await h.su.query(`UPDATE assistant_actions SET status = 'rejected', decided_by_user_id = $2, decided_at = now() WHERE id = $1`, [actionId, a1.userId]);
      await h.su.query(`UPDATE priority_feed_items SET state = 'done', resolved_at = now() WHERE assistant_action_id = $1`, [actionId]);
      // the lead moves on to a0 (rehomeHandbacks moves proposed cards only: the decided action stays a1's), then a0 releases it
      expect((await move(a0.userId!)).ok).toBe(true);
      await runIsa(h, w.tenantId, 1);
      expect((await command(a0, l.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
      await runIsa(h, w.tenantId, 1);
      expect((await h.su.query<{ s: string }>(`SELECT ownership_state AS s FROM contacts WHERE id = $1`, [l.id])).rows[0]!.s).not.toBe('owned');
      expect(await actions([l.id])).toEqual([expect.objectContaining({ owner_user_id: a1.userId, status: 'rejected' })]);
      const ledger = (await h.su.query<{ owner: string }>(`SELECT owner_user_id AS owner FROM lead_ownership_events WHERE contact_id = $1 AND owner_user_id IS NOT NULL ORDER BY seq`, [l.id])).rows.map((r) => r.owner);
      expect([ledger[0], ledger.at(-1)]).toEqual([a2.userId, a0.userId]);
      // (the sweep is tenant-wide: an earlier case's handoff may reach its second level in the same sweep)
      expect((await ageAndSweep(ho!.id)).escalated).toBeGreaterThanOrEqual(1);
      expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 1 });
      // the frozen recipient is a1, whose Team Lead is tl2: only the ownership ledger names a0 as the last owner
      const to = await overdueTo(l.id);
      expect(to, 'not the frozen recipient\'s Team Lead').not.toContain(tl2.userId);
      expect(to, 'never the agent who decided the card').not.toContain(a1.userId);
      expect(to, 'not the first owner\'s escalation (an Owner/Admin)').not.toContain(w.owner.userId);
      expect(to).toEqual([w.teamLead!.userId]);
    });
  });
});

describe('b12 recheck R11: an AI handoff card is decided on its own path, never by the generic Approvals taps (R-ISA-30; E521)', () => {
  it('R-ISA-30: the inbox does not list it; the generic approve ("Got it") and reject ("Dismiss") refuse it AI_ISA_HANDOFF_USE_ACK and change nothing; the ack route records the acknowledgement and leaves the card and the deadline open', async () => {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids })).ok).toBe(true);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId, sla_met_at: null });
    expect(ho!.sla_class).not.toBe('none');
    const actionId = (await h.su.query<{ id: string }>(`SELECT assistant_action_id AS id FROM ai_isa_handoffs WHERE id = $1`, [ho!.id])).rows[0]!.id;
    const unchanged = async () => {
      expect(await actions([l.id])).toEqual([expect.objectContaining({ owner_user_id: a1.userId, status: 'proposed' })]);
      expect(await cards([l.id])).toEqual([expect.objectContaining({ user_id: a1.userId, state: 'open' })]);
      expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null });
    };
    // the Approvals inbox offers no "Got it" or "Dismiss" for it: it is not a card there
    const inbox = await call<{ items: { id: string }[] }>(a1, 'GET', '/assistant/inbox');
    expect(inbox.status).toBe(200);
    expect(inbox.body.items.map((i) => i.id)).not.toContain(actionId);
    // the generic taps refuse it before any write
    const ap = await call<{ error?: { code: string; details?: unknown } }>(a1, 'POST', `/assistant/actions/${actionId}/approve`, { commandId: randomUUID() });
    expect([ap.status, ap.body.error?.code, ap.body.error?.details]).toEqual([409, 'AI_ISA_HANDOFF_USE_ACK', { handoffId: ho!.id }]);
    await unchanged();
    const rj = await call<{ error?: { code: string; details?: unknown } }>(a1, 'POST', `/assistant/actions/${actionId}/reject`);
    expect([rj.status, rj.body.error?.code, rj.body.error?.details]).toEqual([409, 'AI_ISA_HANDOFF_USE_ACK', { handoffId: ho!.id }]);
    await unchanged();
    // the acknowledge route works: it records who saw it, and only a human touch meets the deadline
    const ack = await call<{ handoffId: string; acknowledgedAt: string; slaMet: boolean }>(a1, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {});
    expect(ack.status).toBe(200);
    expect(ack.body).toMatchObject({ handoffId: ho!.id, slaMet: false });
    expect((await h.su.query<{ by: string | null }>(`SELECT acknowledged_by_user_id AS by FROM ai_isa_handoffs WHERE id = $1`, [ho!.id])).rows[0]!.by).toBe(a1.userId);
    await unchanged();
    await touch(l.id);
    expect((await ageAndSweep(ho!.id)).met).toBeGreaterThanOrEqual(1);
    expect((await handoffs([l.id]))[0]!.sla_met_at).not.toBeNull();
  });
});

describe('b12 recheck R13: a handoff that is done closes its pinned card and its action is decided, as the system (R-ISA-30; E521, E525)', () => {
  const cardRows = async (contactId: string) => (await h.su.query<{ user_id: string; state: string; resolved_by: string | null }>(
    `SELECT user_id, state, resolved_by FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff' ORDER BY created_at, id`, [contactId])).rows;
  const actionOf = async (handoffId: string) => (await h.su.query<{ id: string; status: string; decided_by_user_id: string | null }>(
    `SELECT x.id, x.status, x.decided_by_user_id FROM ai_isa_handoffs h JOIN assistant_actions x ON x.tenant_id = h.tenant_id AND x.id = h.assistant_action_id WHERE h.id = $1`, [handoffId])).rows[0]!;
  const closedAudit = async (handoffId: string) => (await h.su.query<{ reason: string; actor_kind: string }>(
    `SELECT reason, actor_kind FROM audit_log WHERE action = 'ai_isa.handoff_closed' AND entity_id = $1 ORDER BY seq`, [handoffId])).rows;
  const overdueOf = async (contactId: string) => (await h.su.query(`SELECT 1 FROM notifications WHERE kind = 'ai_isa_handoff_overdue' AND subject_id = $1`, [contactId])).rows.length;
  /** Care on a0's lead ends owner_change when the lead moves to a1: a handoff to a1 with a deadline, its card open. */
  async function handedToA1() {
    const { runOwnershipCommand } = await import('../leads/ownership.js');
    const [a0, a1] = [w.agents[0]!, w.agents[1]!];
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await runOwnershipCommand(w.owner.actor(), l.id as never, { kind: 'reassign', toUserId: a1.userId as never, reason: 'MANUAL_REASSIGN' } as never, randomUUID(), undefined, { db: h.database, ids: depsFromPlatform(h.app.platform).ids })).ok).toBe(true);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ reason: 'owner_change', recipient_user_id: a1.userId, sla_met_at: null });
    expect(ho!.sla_class).not.toBe('none');
    expect(await cardRows(l.id)).toEqual([{ user_id: a1.userId, state: 'open', resolved_by: null }]);
    expect(await actionOf(ho!.id)).toMatchObject({ status: 'proposed' });
    return { l, ho: ho!, a1 };
  }

  it('R-ISA-30: "Got it" on a handoff with a deadline leaves its card open, even past the deadline; a human touch and the sweep meet it, close the card and execute the action in the same transaction', async () => {
    const { l, ho, a1 } = await handedToA1();
    const actionId = (await actionOf(ho.id)).id;
    const ack = await call<{ slaMet: boolean }>(a1, 'POST', `/ai-isa/handoffs/${ho.id}/ack`, {});
    expect([ack.status, ack.body.slaMet]).toEqual([200, false]);
    expect(await cardRows(l.id)).toEqual([{ user_id: a1.userId, state: 'open', resolved_by: null }]);
    // overdue and not touched: the sweep escalates and leaves the card and the action as they are
    await ageAndSweep(ho.id);
    expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 1 });
    expect(await cardRows(l.id)).toEqual([{ user_id: a1.userId, state: 'open', resolved_by: null }]);
    expect(await actionOf(ho.id)).toMatchObject({ status: 'proposed' });
    expect(await closedAudit(ho.id)).toEqual([]);
    // the human touch meets it: the card closes (resolved_by NULL: its module handled it, final), the system executes the action, the deadline is met
    await touch(l.id);
    await ageAndSweep(ho.id);
    expect((await handoffs([l.id]))[0]!.sla_met_at).not.toBeNull();
    expect(await cardRows(l.id)).toEqual([{ user_id: a1.userId, state: 'done', resolved_by: null }]);
    expect(await actionOf(ho.id)).toEqual({ id: actionId, status: 'executed', decided_by_user_id: null });
    expect(await closedAudit(ho.id)).toEqual([{ reason: 'deadline_met', actor_kind: 'system' }]);
    const feed = await call<{ pinned: { assistantActionId: string | null }[] }>(a1, 'GET', '/feed');
    expect(feed.status).toBe(200);
    expect(feed.body.pinned.map((c) => c.assistantActionId)).not.toContain(actionId);
  });

  it('R-ISA-30 E521: "Got it" on a handoff with no deadline (D1 leaves no channel) closes its card and executes its action', async () => {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await call(agent, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ sla_class: 'none', recipient_user_id: agent.userId });
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'open', resolved_by: null }]);
    const ack = await call<{ slaMet: boolean }>(agent, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {});
    expect([ack.status, ack.body.slaMet]).toEqual([200, false]);
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'done', resolved_by: null }]);
    expect(await actionOf(ho!.id)).toMatchObject({ status: 'executed', decided_by_user_id: null });
    expect(await closedAudit(ho!.id)).toEqual([{ reason: 'acknowledged', actor_kind: 'system' }]);
    // a repeat ack changes nothing more
    expect((await call(agent, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {})).status).toBe(200);
    expect(await closedAudit(ho!.id)).toHaveLength(1);
  });

  it('R-ISA-30 E521: on a closed lead, the Owner\'s "Got it" on the no-deadline handoff closes every card of it (the Team Lead\'s and each Owner/Admin\'s)', async () => {
    const a0 = w.agents[0]!;
    const l = await isaLead(h, a0);
    expect((await startCare(a0, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await command(a0, l.id, 'close', { reason: 'not_a_lead' })).status).toBe(200);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho).toMatchObject({ sla_class: 'none', recipient_user_id: null });
    const before = await cardRows(l.id);
    expect(before.map((c) => c.user_id)).toEqual(expect.arrayContaining([w.teamLead!.userId, w.owner.userId]));
    expect(before.every((c) => c.state === 'open')).toBe(true);
    expect((await call(w.owner, 'POST', `/ai-isa/handoffs/${ho!.id}/ack`, {})).status).toBe(200);
    const after = await cardRows(l.id);
    expect(after).toHaveLength(before.length);
    expect(after.every((c) => c.state === 'done' && c.resolved_by === null)).toBe(true);
    expect(await actionOf(ho!.id)).toMatchObject({ status: 'executed' });
  });

  it('R-ISA-30 E521: a lead closed while its handoff has a deadline: the sweep closes the card and executes the action, never sends an overdue alert, and the deadline is not recorded as met', async () => {
    const { l, ho, a1 } = await handedToA1();
    expect((await command(a1, l.id, 'close', { reason: 'not_a_lead' })).status).toBe(200);
    await runIsa(h, w.tenantId, 1);
    expect((await h.su.query<{ s: string }>(`SELECT ownership_state AS s FROM contacts WHERE id = $1`, [l.id])).rows[0]!.s).toBe('closed');
    // the pending card followed the lead to the previous owner's Team Lead (rehomeHandbacks) and is still open
    expect(await cardRows(l.id)).toEqual([{ user_id: w.teamLead!.userId, state: 'open', resolved_by: null }]);
    await ageAndSweep(ho.id);
    expect(await cardRows(l.id)).toEqual([{ user_id: w.teamLead!.userId, state: 'done', resolved_by: null }]);
    expect(await actionOf(ho.id)).toMatchObject({ status: 'executed', decided_by_user_id: null });
    expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 0 });
    expect(await closedAudit(ho.id)).toEqual([{ reason: 'lead_closed', actor_kind: 'system' }]);
    // done: later sweeps never alert, and the panel does not call it overdue
    await ageAndSweep(ho.id);
    expect(await overdueOf(l.id)).toBe(0);
    const panel = await call<{ handoff: { id: string; overdue: boolean } | null }>(w.owner, 'GET', `/contacts/${l.id}/ai-isa`);
    expect(panel.status).toBe(200);
    expect(panel.body.handoff).toMatchObject({ id: ho.id, overdue: false });
  });

  /** Care on the agent's lead ends (the agent ends it): a handoff to the agent with a deadline, its card open. */
  async function endedByAgent() {
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await call(agent, 'POST', `/contacts/${l.id}/ai-isa/end`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1 AND finalize_at IS NOT NULL`, [l.id]);
    await runIsa(h, w.tenantId);
    const [ho] = await handoffs([l.id]);
    expect(ho!.sla_class).not.toBe('none');
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'open', resolved_by: null }]);
    return { agent, l, ho: ho! };
  }

  it('R-ISA-30 E521 (b12 recheck R16): a restart of AI care with no human touch since the handoff leaves it open: its card stays, its action stays proposed, and its deadline still alerts', async () => {
    const { agent, l, ho } = await endedByAgent();
    expect((await startCare(agent, l.id)).status).toBe(200);
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'open', resolved_by: null }]);
    expect(await actionOf(ho.id)).toMatchObject({ status: 'proposed' });
    expect(await closedAudit(ho.id)).toEqual([]);
    // (the sweep is tenant-wide: an earlier case's handoff may escalate in the same sweep)
    expect((await ageAndSweep(ho.id)).escalated).toBeGreaterThanOrEqual(1);
    expect((await handoffs([l.id]))[0]).toMatchObject({ sla_met_at: null, sla_escalation_level: 1 });
    expect(await overdueOf(l.id)).toBeGreaterThanOrEqual(1);
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'open', resolved_by: null }]);
  });

  it('R-ISA-30 (b12 recheck R16): a restart after a human touch since the handoff closes it (care_restarted) and records the deadline as met; it then never alerts', async () => {
    const { agent, l, ho } = await endedByAgent();
    await touch(l.id);
    expect((await startCare(agent, l.id)).status).toBe(200);
    expect(await cardRows(l.id)).toEqual([{ user_id: agent.userId, state: 'done', resolved_by: null }]);
    expect(await actionOf(ho.id)).toMatchObject({ status: 'executed', decided_by_user_id: null });
    expect(await closedAudit(ho.id)).toEqual([{ reason: 'care_restarted', actor_kind: 'system' }]);
    expect((await handoffs([l.id]))[0]!.sla_met_at).not.toBeNull();
    await ageAndSweep(ho.id);
    expect(await overdueOf(l.id)).toBe(0);
    expect((await handoffs([l.id]))[0]).toMatchObject({ sla_escalation_level: 0 });
  });

  it('R-ISA-30 (b12 recheck R19): the panel\'s handoff and the "Got it" result say why a handoff is closed: null while open, then deadline_met, lead_closed, acknowledged or care_restarted', async () => {
    type PanelHandoff = { id: string; reason: string; slaDueAt: string; slaMetAt: string | null; overdue: boolean; confirmationStatus: string; closedReason: string | null };
    const panelOf = async (as: TestClient, contactId: string) => {
      const p = await call<{ handoff: PanelHandoff | null }>(as, 'GET', `/contacts/${contactId}/ai-isa`);
      expect(p.status).toBe(200);
      return p.body.handoff;
    };
    const closedReasonOf = async (handoffId: string) => (await h.su.query<{ r: string | null }>(`SELECT closed_reason AS r FROM ai_isa_handoffs WHERE id = $1`, [handoffId])).rows[0]!.r;
    // open, acknowledged with a deadline: nothing closed it; then a touch and the sweep: deadline_met
    const met = await handedToA1();
    expect(await panelOf(met.a1, met.l.id)).toEqual({ id: met.ho.id, reason: 'owner_change', slaDueAt: expect.any(String), slaMetAt: null, overdue: false, confirmationStatus: expect.any(String), closedReason: null });
    const ack = await call<Record<string, unknown>>(met.a1, 'POST', `/ai-isa/handoffs/${met.ho.id}/ack`, {});
    expect([ack.status, ack.body]).toEqual([200, { handoffId: met.ho.id, acknowledgedAt: expect.any(String), slaMet: false, confirmationStatus: expect.any(String), closedReason: null }]);
    await touch(met.l.id);
    await ageAndSweep(met.ho.id);
    expect(await panelOf(met.a1, met.l.id)).toEqual({ id: met.ho.id, reason: 'owner_change', slaDueAt: expect.any(String), slaMetAt: expect.any(String), overdue: false, confirmationStatus: expect.any(String), closedReason: 'deadline_met' });
    // a lead closed while its deadline runs: lead_closed, which the panel tells apart from a handoff the sweep never reached
    const shut = await handedToA1();
    expect((await command(shut.a1, shut.l.id, 'close', { reason: 'not_a_lead' })).status).toBe(200);
    await runIsa(h, w.tenantId, 1);
    expect(await panelOf(w.owner, shut.l.id)).toMatchObject({ id: shut.ho.id, overdue: false, closedReason: null });
    await ageAndSweep(shut.ho.id);
    expect(await panelOf(w.owner, shut.l.id)).toMatchObject({ id: shut.ho.id, slaMetAt: null, overdue: false, closedReason: 'lead_closed' });
    // no deadline (D1): "Got it" closes it and says so, and a repeat says so again
    const agent = w.agents[0]!;
    const l = await isaLead(h, agent);
    expect((await startCare(agent, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    expect((await call(agent, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
    await runIsa(h, w.tenantId);
    const [none] = await handoffs([l.id]);
    expect(none!.sla_class).toBe('none');
    for (let i = 0; i < 2; i += 1) {
      const a = await call<Record<string, unknown>>(agent, 'POST', `/ai-isa/handoffs/${none!.id}/ack`, {});
      expect([a.status, a.body]).toEqual([200, { handoffId: none!.id, acknowledgedAt: expect.any(String), slaMet: false, confirmationStatus: expect.any(String), closedReason: 'acknowledged' }]);
    }
    expect(await panelOf(agent, l.id)).toMatchObject({ id: none!.id, overdue: false, closedReason: 'acknowledged' });
    // a restart after a touch: care_restarted (the panel then shows the new assignment, so the stored marker is read)
    const again = await endedByAgent();
    expect(await closedReasonOf(again.ho.id)).toBeNull();
    await touch(again.l.id);
    expect((await startCare(again.agent, again.l.id)).status).toBe(200);
    expect(await closedReasonOf(again.ho.id)).toBe('care_restarted');
  });

  it('R-ISA-30: erasing the person leaves no handoff card behind (the card, the action and the handoff cascade from the contact)', async () => {
    const { freshReauth } = await import('./testing.js');
    const { l } = await handedToA1();
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/contacts/${l.id}/erase`, { reason: 'PRIVACY_REQUEST' })).status).toBe(200);
    expect(await cardRows(l.id)).toEqual([]);
    expect(await actions([l.id])).toEqual([]);
    expect(await handoffs([l.id])).toEqual([]);
  });
});

describe('b12 recheck R12: every AI text counts once toward the 40-message limit, whatever status the worker sees first (R-ISA-11; E518)', () => {
  const care = async (contactId: string) => (await h.su.query<{ sent: number; n: number; end_reason: string | null; machine_sent: number }>(
    `SELECT messages_sent AS sent, undelivered_streak AS n, end_reason, (machine->'counters'->>'messagesSent')::int AS machine_sent FROM ai_isa_assignments WHERE contact_id = $1`, [contactId])).rows[0]!;
  /** An AI reply whose TX2 commits 'sent' while the worker is behind, then the carrier's `status` commits before the sent job runs. */
  async function carrierFirst(l: { id: string; phone: string }, status: 'delivered' | 'undelivered') {
    const { inboundSms } = await import('../comms/testing.js');
    const { applyMessageStatus } = await import('../comms/status.js');
    const { aiMessages } = await import('./testing.js');
    await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
    await runIsa(h, w.tenantId, 4, { hold: ['ai_isa.send_result'] });
    const sent = (await aiMessages(h, l.id)).filter((m) => m.status === 'sent').at(-1)!;
    expect(sent, 'an AI reply reached sent').toBeTruthy();
    const job = async () => (await h.su.query<{ s: string; st: string }>(`SELECT payload->>'status' AS s, status AS st FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1 ORDER BY id`, [sent.id])).rows;
    expect(await job()).toEqual([{ s: 'sent', st: 'pending' }]);
    const r = await applyMessageStatus(systemActor(w.tenantId, 'provider'), { providerEventRef: `evt-r12-${status}-${sent.id}`, message: { id: sent.id }, providerStatus: status, mapped: status, errorCode: status === 'undelivered' ? '30003' : null, occurredAt: Date.now() as never }, depsFromPlatform(h.app.platform));
    expect(r.kind).toBe('applied');
    await runIsa(h, w.tenantId, 2);
    expect((await job()).map((x) => [x.s, x.st])).toEqual([['sent', 'succeeded'], [status, 'succeeded']]);
  }
  async function caredLead(messagesSent = 0) {
    const l = await isaLead(h, w.agents[0]!);
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    if (messagesSent > 0) {
      await h.su.query(`SET session_replication_role = replica`);
      try {
        await h.su.query(`UPDATE ai_isa_assignments SET messages_sent = $2, machine = jsonb_set(machine, '{counters,messagesSent}', to_jsonb($2::int)) WHERE contact_id = $1`, [l.id, messagesSent]);
      } finally {
        await h.su.query(`SET session_replication_role = origin`);
      }
    }
    expect((await care(l.id)).sent).toBe(messagesSent);
    return l;
  }

  it('R-ISA-11: the carrier\'s delivered commits before the sent job runs: the stale sent job does nothing and the text still counts once', async () => {
    const l = await caredLead();
    await carrierFirst(l, 'delivered');
    expect(await care(l.id)).toEqual({ sent: 1, n: 0, end_reason: null, machine_sent: 1 });
  });

  it('R-ISA-11 E518: an undelivered that commits first counts the text once and the failure once (R1)', async () => {
    const l = await caredLead();
    await carrierFirst(l, 'undelivered');
    expect(await care(l.id)).toEqual({ sent: 1, n: 1, end_reason: null, machine_sent: 1 });
  });

  it('R-ISA-11: the 40th text, delivered before its sent job runs, ends care limit_reached with a handoff', async () => {
    const l = await caredLead(39);
    await carrierFirst(l, 'delivered');
    expect(await care(l.id)).toMatchObject({ sent: 40, machine_sent: 40, end_reason: 'limit_reached' });
    expect((await handoffs([l.id])).map((x) => x.reason)).toEqual(['limit_reached']);
  });

  describe('b12 recheck R15: a text whose dispatch outcome is never resolved counts toward the 40-message safety cap (R-ISA-11; E7)', () => {
    const telephony = () => (h.providers as unknown as { telephony: { failNext(f: 'timeout' | 'rejected'): void } }).telephony;
    const statusesOf = async (messageId: string) => (await h.su.query<{ s: string; st: string }>(`SELECT payload->>'status' AS s, status AS st FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1 ORDER BY id`, [messageId])).rows.map((x) => [x.s, x.st]);
    /** An AI reply whose provider submit times out (dispatch_unknown, nothing recorded at the fake), then the reconcile
     *  window passes with the provider never finding it: 'failed' DISPATCH_UNKNOWN_UNRESOLVED, no provider ref. */
    async function unresolved(l: { id: string; phone: string }): Promise<string> {
      const { inboundSms } = await import('../comms/testing.js');
      const { aiMessages } = await import('./testing.js');
      telephony().failNext('timeout');
      await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
      await runIsa(h, w.tenantId);
      const m = (await aiMessages(h, l.id)).at(-1)!;
      expect(m, 'an AI reply was dispatched').toBeTruthy();
      expect(m.status).toBe('dispatch_unknown');
      await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '11 minutes' WHERE id = $1`, [m.id]);
      await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE kind = 'comms.reconcile' AND status = 'pending' AND payload->>'messageId' = $1`, [m.id]);
      await runIsa(h, w.tenantId, 2);
      const after = (await h.su.query<{ status: string; reason: string | null; ref: string | null }>(`SELECT status, status_reason AS reason, provider_message_ref AS ref FROM messages WHERE id = $1`, [m.id])).rows[0]!;
      expect(after).toEqual({ status: 'failed', reason: 'DISPATCH_UNKNOWN_UNRESOLVED', ref: null });
      expect(await statusesOf(m.id)).toEqual([['dispatch_unknown', 'succeeded'], ['failed', 'succeeded']]);
      return m.id;
    }

    it('R-ISA-11: the provider may have accepted it, so the unresolved text counts once (and its failure once); the unknown result alone counted nothing', async () => {
      const l = await caredLead();
      await unresolved(l);
      expect(await care(l.id)).toEqual({ sent: 1, n: 1, end_reason: null, machine_sent: 1 });
    });

    it('R-ISA-11: the 40th text, its dispatch never resolved, ends care limit_reached with a handoff', async () => {
      const l = await caredLead(39);
      await unresolved(l);
      expect(await care(l.id)).toMatchObject({ sent: 40, machine_sent: 40, end_reason: 'limit_reached' });
      expect((await handoffs([l.id])).map((x) => x.reason)).toEqual(['limit_reached']);
    });

    it('R-ISA-11: a text the provider refused at dispatch never left: it is not counted', async () => {
      const { inboundSms } = await import('../comms/testing.js');
      const { aiMessages } = await import('./testing.js');
      const l = await caredLead(39);
      telephony().failNext('rejected');
      await inboundSms(h, l.phone, w.mainNumber, 'Hi, we are looking for a place soon');
      await runIsa(h, w.tenantId);
      const m = (await aiMessages(h, l.id)).at(-1)!;
      expect(m).toMatchObject({ status: 'failed', status_reason: 'PROVIDER_REJECTED' });
      expect(await statusesOf(m.id)).toEqual([['failed', 'succeeded']]);
      expect(await care(l.id)).toMatchObject({ sent: 39, machine_sent: 39, end_reason: null });
    });
  });
});
