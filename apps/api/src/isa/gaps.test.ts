// ISA-2b items 3, 5 and 6: the inactivity-warning handoff (R-ISA-16), the handoff recipient after a take over
// (R-ISA-15, R-ISA-30) and a send_result for every terminal status (R-ISA-3, -4, -11, -14, -21). Real Postgres via the
// API harness; fakes only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { inboundSms } from '../comms/testing.js';
import { aiMessages, assignmentOf, call, closedZone, handoffOf, isaLead, isaWorker, isaWorld, type IsaWorld, runIsa, startCare, sweepNow } from './testing.js';

let h: ApiHarness;
let w: IsaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await isaWorld(h);
});
afterAll(async () => {
  await h?.close();
});

async function liveLead() {
  const l = await isaLead(h, w.agents[0]!);
  expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
  await runIsa(h, w.tenantId);
  return l;
}

async function card(contactId: string) {
  return (await h.su.query<{ item_type: string; band: string; reasons: { code: string; text: string }[]; user_id: string; score: number; due_at: Date | null }>(
    `SELECT item_type, band, reasons, user_id, score, due_at FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'ai_isa_handoff'`, [contactId])).rows;
}

describe('R-ISA-16: the inactivity warning hands back', () => {
  for (const paused of [false, true]) {
    it(`R-ISA-16 E516: a warning with care ${paused ? 'paused' : 'live'} writes a pinned handoff with the release date; no AI message follows`, async () => {
      const l = await liveLead();
      if (paused) expect((await call(w.agents[0]!, 'POST', `/contacts/${l.id}/ai-isa/pause`, {})).status).toBe(200);
      await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET inactivity_warn_at = now() - interval '1 minute', inactivity_release_at = now() + interval '3 days' WHERE id = '${l.id}'; SET session_replication_role = origin`);
      const before = (await aiMessages(h, l.id)).length;
      await sweepNow(h, w.tenantId);
      const a = (await assignmentOf(h, l.id))!;
      expect(a.end_reason).toBe('inactivity_warning');
      const ho = await handoffOf(h, l.id);
      expect(ho).toHaveLength(1);
      expect(ho[0]!.package['inactivityReleaseAt']).not.toBeNull();
      const c = await card(l.id);
      expect(c[0]!.band).toBe('pinned');
      expect(c[0]!.reasons[0]!.text).toMatch(/returns to the pond on .+ unless you touch them\. AI care has handed back\./);
      expect((await aiMessages(h, l.id)).filter((m) => m.status !== 'canceled').length).toBeLessThanOrEqual(before);
      await sweepNow(h, w.tenantId, 1);
      expect(await handoffOf(h, l.id)).toHaveLength(1);
    });
  }
});

describe('R-ISA-15 R-ISA-30: the handoff recipient after a take over (Q1)', () => {
  it('R-ISA-15 R-ISA-30: a team lead\'s take over makes them the recipient of the card and deadline, the owner notified; after an End, the owner', async () => {
    const l = await liveLead();
    const tl = w.teamLead!;
    const t = await call(tl, 'POST', `/contacts/${l.id}/ai-isa/take-over`, {});
    expect(t.status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1`, [l.id]);
    await runIsa(h, w.tenantId);
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('taken_over');
    const ho = (await h.su.query<{ recipient_user_id: string; package: Record<string, unknown> }>(`SELECT recipient_user_id, package FROM ai_isa_handoffs WHERE contact_id = $1`, [l.id])).rows;
    expect(ho[0]!.recipient_user_id).toBe(tl.userId);
    expect(ho[0]!.package['recipientUserId']).toBe(tl.userId);
    const c = await card(l.id);
    expect(c.map((x) => x.user_id)).toEqual([tl.userId]);
    expect(c[0]!.due_at).not.toBeNull();
    const n = await h.su.query<{ user_id: string; kind: string }>(`SELECT user_id, kind FROM notifications WHERE subject_id = $1 AND kind LIKE 'ai_isa_%'`, [l.id]);
    expect(n.rows).toEqual(expect.arrayContaining([{ user_id: w.agents[0]!.userId, kind: 'ai_isa_ended' }]));
    expect(n.rows.filter((r) => r.kind.startsWith('ai_isa_handoff')).map((r) => r.user_id)).toEqual([tl.userId]);

    const l2 = await liveLead();
    expect((await call(w.agents[0]!, 'POST', `/contacts/${l2.id}/ai-isa/end`, {})).status).toBe(200);
    await h.su.query(`UPDATE ai_isa_assignments SET finalize_at = now() - interval '1 second' WHERE contact_id = $1`, [l2.id]);
    await runIsa(h, w.tenantId);
    const h2 = (await h.su.query<{ recipient_user_id: string; package: Record<string, unknown> }>(`SELECT recipient_user_id, package FROM ai_isa_handoffs WHERE contact_id = $1`, [l2.id])).rows;
    expect(h2[0]!.recipient_user_id).toBe(w.agents[0]!.userId);
    expect(h2[0]!.package['endedByUserId']).toBe(w.agents[0]!.userId);
  });
});

async function factFor(contactId: string, messageId: string): Promise<string> {
  const a = (await assignmentOf(h, contactId))!;
  const id = (await h.su.query<{ id: string }>(`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, message_id, fact_kind, line_sha256)
    VALUES ($1, gen_random_uuid(), $2, $3, $4, 'listing_active', repeat('a', 64)) RETURNING id`, [w.tenantId, a.id, contactId, messageId])).rows[0]!.id;
  return id;
}
const factStatus = async (id: string) => (await h.su.query<{ status: string }>(`SELECT status FROM ai_isa_shared_facts WHERE id = $1`, [id])).rows[0]!.status;
const resultJobs = async (messageId: string) => (await h.su.query<{ status: string }>(`SELECT payload->>'status' AS status FROM jobs WHERE kind = 'ai_isa.send_result' AND payload->>'messageId' = $1`, [messageId])).rows.map((r) => r.status);

describe('R-ISA-4: a send_result for every terminal status', () => {
  it('R-ISA-3 E494: an inbound cancel of a queued AI message emits send_result canceled; its pending facts are canceled', async () => {
    const l = await isaLead(h, w.agents[0]!, { zone: closedZone() });
    expect((await startCare(w.agents[0]!, l.id)).status).toBe(200);
    await runIsa(h, w.tenantId);
    await inboundSms(h, l.phone, w.mainNumber, 'Are you there?');
    await runIsa(h, w.tenantId);
    const sched = (await aiMessages(h, l.id)).find((m) => m.status === 'scheduled');
    expect(sched).toBeDefined();
    const f = await factFor(l.id, sched!.id);
    await inboundSms(h, l.phone, w.mainNumber, 'Actually never mind, call me tomorrow');
    expect((await aiMessages(h, l.id)).find((m) => m.id === sched!.id)!.status).toBe('canceled');
    expect(await resultJobs(sched!.id)).toContain('canceled');
    await runIsa(h, w.tenantId, 2);
    expect(await factStatus(f)).toBe('canceled');
  });

  it('R-ISA-11 E518: two "undelivered" status callbacks in a row end care delivery_problem with one handoff', async () => {
    const { applyMessageStatus } = await import('../comms/status.js');
    const { depsFromPlatform } = await import('../comms/runtime.js');
    const { systemActor } = await import('../worker/systemActor.js');
    const l = await liveLead();
    for (const text of ['We want 3 bedrooms', 'And a yard please']) {
      // only the replies are under test: the follow-up timers (initiated, refused without a grant) are dropped, and the
      // start instant is moved back so runIsa's aging of inbound instants keeps them after the start
      await h.su.query(`SET session_replication_role = replica; UPDATE ai_isa_assignments SET started_at = started_at - interval '1 hour' WHERE contact_id = '${l.id}'; SET session_replication_role = origin`);
      await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND status = 'pending' AND payload->>'timer' = 'follow_up'`, [w.tenantId]);
      await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '10 minutes' WHERE contact_id = $1 AND direction = 'outbound'`, [l.id]);
      await inboundSms(h, l.phone, w.mainNumber, text);
      await runIsa(h, w.tenantId);
    }
    const sent = (await aiMessages(h, l.id)).filter((m) => m.status === 'sent');
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const m of sent.slice(-2)) {
      await applyMessageStatus(systemActor(w.tenantId as never, 'provider'), { providerEventRef: `t:${m.id}`, message: { id: m.id }, providerStatus: 'undelivered', mapped: 'undelivered', errorCode: '30003', occurredAt: Date.now() as never } as never, depsFromPlatform(h.app.platform));
      expect(await resultJobs(m.id)).toContain('undelivered');
      await runIsa(h, w.tenantId, 2);
    }
    expect((await assignmentOf(h, l.id))!.end_reason).toBe('delivery_problem');
    expect(await handoffOf(h, l.id)).toHaveLength(1);
  });

  it('R-ISA-21: a reaper dispatch_unknown keeps the facts pending; the reconcile that finds it sent marks them sent', async () => {
    const l = await liveLead();
    await h.su.query(`UPDATE messages SET dispatched_at = dispatched_at - interval '10 minutes' WHERE contact_id = $1 AND direction = 'outbound'`, [l.id]);
    await inboundSms(h, l.phone, w.mainNumber, 'Looking for a condo downtown');
    await runIsa(h, w.tenantId);
    const m = (await aiMessages(h, l.id)).filter((x) => x.status === 'sent').at(-1)!;
    const f = await factFor(l.id, m.id);
    await h.su.query(`UPDATE messages SET status = 'dispatching', dispatched_at = now() - interval '25 minutes' WHERE id = $1`, [m.id]);
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'default', 'comms.dispatch_stale', $2::jsonb, now() - interval '1 second')`, [w.tenantId, JSON.stringify({ messageId: m.id })]);
    // the reaper's body, run directly (its reconcile job is left pending for the step below)
    const { dispatchStaleHandler } = await import('../worker/handlers/dispatchStale.js');
    const { withTenantTx } = await import('@realty/db');
    const { systemActor } = await import('../worker/systemActor.js');
    await withTenantTx(systemActor(w.tenantId as never, 'worker'), (tx, now) => dispatchStaleHandler().run({ tx, now, log: { info: () => undefined }, job: { id: 0n } } as never, { messageId: m.id } as never) as Promise<unknown>, { db: h.database });
    expect((await aiMessages(h, l.id)).find((x) => x.id === m.id)!.status).toBe('dispatch_unknown');
    expect(await resultJobs(m.id)).toContain('dispatch_unknown');
    await h.su.query(`UPDATE jobs SET run_at = now() + interval '1 hour' WHERE tenant_id = $1 AND kind = 'comms.reconcile' AND status = 'pending'`, [w.tenantId]);
    await runIsa(h, w.tenantId, 2);
    expect(await factStatus(f)).toBe('pending');
    await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'comms.reconcile' AND status = 'pending'`, [w.tenantId]);
    await isaWorkerDrainOnly(['comms.reconcile']);
    expect(['sent', 'delivered']).toContain((await aiMessages(h, l.id)).find((x) => x.id === m.id)!.status);
    await runIsa(h, w.tenantId, 2);
    expect(await factStatus(f)).toBe('sent');
  });
});

/** Drains only jobs of `kinds` (everything else of the tenant is held back for the call). */
async function isaWorkerDrainOnly(kinds: string[]): Promise<void> {
  const held = (await h.su.query<{ id: string }>(`UPDATE jobs SET run_at = run_at + interval '100 years' WHERE tenant_id = $1 AND status = 'pending' AND NOT (kind = ANY ($2)) RETURNING id`, [w.tenantId, kinds])).rows.map((r) => r.id);
  try {
    await isaWorker(h).drain(10);
  } finally {
    await h.su.query(`UPDATE jobs SET run_at = run_at - interval '100 years' WHERE id = ANY ($1::bigint[])`, [held]);
  }
}

void inboundSms;
