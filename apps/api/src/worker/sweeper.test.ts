// The deadline sweeper against real Postgres: stored deadlines only (R-OWN-15), lost and duplicate
// timer jobs (E6), the lost ownership.followup backstop (E5), one transaction per tenant (R-TEN-6).
import type { ContactId, Instant, TenantId } from '@realty/core/foundation';
import { DAY_MS, instant, instantFromDate } from '@realty/core/foundation';
import { breachTimerKey, offerTimerKey, releaseTimerKey } from '@realty/core/ownership';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_DISPATCH, COMMS_DISPATCH_STALE, COMMS_RECONCILE, NOTIFY_DELIVER, PLAYBOOK_STEP } from './contracts.js';
import { ownershipFollowupHandler } from './handlers/followup.js';
import { createWorker, workerName } from './loop.js';
import { memoryLogger } from './observability.js';
import { dbClock } from './repos/jobs.js';
import { planDue, createSweeper } from './sweeper.js';
import {
  type Harness,
  type World,
  cmd,
  contactRow,
  createHarness,
  createWorld,
  intakeLead,
  jobsFor,
  ledgerTypes,
  registryWith,
  selfCreated,
  suFixture,
  suRows,
  testTimerHandlers,
} from './testing/world.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const reg = () => registryWith(...testTimerHandlers(), ownershipFollowupHandler());

const quiet = () => memoryLogger();
const at = async (plusMs: number): Promise<Instant> => instant((await dbClock(h.app)) + plusMs);

/** Moves an open offer's expiry (projection and its `offered` ledger event alike) into the past. */
async function expireOffer(contactId: string): Promise<void> {
  await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() - interval '1 second' WHERE id = $1`, [contactId]);
  await suFixture(
    h.su,
    `UPDATE lead_ownership_events SET deadline_at = (SELECT offer_expires_at FROM contacts WHERE id = $1)
      WHERE contact_id = $1 AND seq = (SELECT max(seq) FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offered')`,
    [contactId],
  );
}

async function deleteJobs(tenantId: string, kind: string): Promise<number> {
  const r = await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = $2 AND status = 'pending'`, [tenantId, kind]);
  return r.rowCount ?? 0;
}

describe('sweeper: stored deadlines → the exact timer job the transition enqueued', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(h.app, { agents: 2 });
  });

  it('R-OWN-15 E6: a lost offer_expiry job is re-created from stored data; the timer then expires the offer and re-offers', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const c0 = await contactRow(h.su, contactId);
    expect(c0.ownership_state).toBe('offered');
    expect(await deleteJobs(w.tenantId, 'ownership.offer_expiry')).toBe(1); // the job row is lost
    await expireOffer(contactId);

    const sweeper = createSweeper({ db: h.app, registry: reg(), log: quiet() });
    const r = await sweeper.sweepOnce();
    expect(r.byKind['ownership.offer_expiry']).toBeGreaterThanOrEqual(1);
    const [job] = await jobsFor(h.su, w.tenantId, 'ownership.offer_expiry');
    expect(job!.dedupe_key).toBe(offerTimerKey(contactId as ContactId, c0.offer_id as string));
    expect(job!.payload).toEqual({ contactId, deadline: 'offer_expiry', offerId: c0.offer_id });

    // E6 duplicates: a second sweep while the job is live is a no-op (same dedupe key)
    const r2 = await sweeper.sweepOnce();
    expect(r2.deduped).toBeGreaterThanOrEqual(1);
    expect((await jobsFor(h.su, w.tenantId, 'ownership.offer_expiry')).filter((j) => j.status === 'pending')).toHaveLength(1);

    const worker = createWorker({ queues: ['realtime'], concurrency: 4, worker: workerName('t'), db: h.app, registry: reg(), log: quiet() });
    await worker.drain();
    const types = await ledgerTypes(h.su, contactId);
    expect(types.slice(-3)).toEqual(['offered', 'offer_expired', 'offered']);
    const c1 = await contactRow(h.su, contactId);
    expect(c1.ownership_state).toBe('offered');
    expect(c1.offered_to_user_id).not.toBe(c0.offered_to_user_id);

    // E6: the same timer delivered again (stale fence: the offer it names is gone) changes nothing
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'realtime', 'ownership.offer_expiry', $2::jsonb, now())`, [
      w.tenantId,
      JSON.stringify(job!.payload),
    ]);
    await worker.drain();
    expect(await ledgerTypes(h.su, contactId)).toEqual(types);
  });

  it('R-OWN-15: breach and auto-release jobs carry the STORED period seq and deadlines as fences and core dedupe keys', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const c0 = await contactRow(h.su, contactId);
    const agent = w.agents.find((a) => a.id === c0.offered_to_user_id)!;
    const acc = await cmd(h.app, agent.actor, contactId, { kind: 'accept', offerId: c0.offer_id as string });
    expect(acc.outcome.ok).toBe(true);
    const c = await contactRow(h.su, contactId);
    const period = Number(c.ownership_period_seq);
    const due = instantFromDate(c.first_touch_due_at as Date);
    const rel = instantFromDate(c.release_due_at as Date);
    await deleteJobs(w.tenantId, 'ownership.first_touch_breach');
    await deleteJobs(w.tenantId, 'ownership.auto_release');

    const r = await createSweeper({ db: h.app, registry: reg(), log: quiet() }).sweepOnce(instant(Math.max(due, rel) + 1000));
    expect(r.failedTenants).toBe(0);
    const breach = (await jobsFor(h.su, w.tenantId, 'ownership.first_touch_breach')).filter((j) => j.payload.contactId === contactId);
    const release = (await jobsFor(h.su, w.tenantId, 'ownership.auto_release')).filter((j) => j.payload.contactId === contactId);
    expect(breach.map((j) => [j.dedupe_key, j.payload])).toEqual([[breachTimerKey(contactId as ContactId, period), { contactId, deadline: 'first_touch_breach', periodSeq: period, dueAt: due }]]);
    expect(release.map((j) => [j.dedupe_key, j.payload])).toEqual([[releaseTimerKey(contactId as ContactId, period), { contactId, deadline: 'auto_release', periodSeq: period, dueAt: rel }]]);
    // nothing is moved: the projection still holds exactly the deadlines the fences carry
    const after = await contactRow(h.su, contactId);
    expect((after.first_touch_due_at as Date).getTime()).toBe(due);
    expect((after.release_due_at as Date).getTime()).toBe(rel);
  });

  it('R-OWN-15 E67: lowering inactivity_release_days does not make an existing lead overdue; its stored instants still fire', async () => {
    const contactId = await selfCreated(h.app, w.agents[0]!);
    const c = await contactRow(h.su, contactId);
    const warnAt = instantFromDate(c.inactivity_warn_at as Date);
    const releaseAt = instantFromDate(c.inactivity_release_at as Date);
    expect(releaseAt - Date.now()).toBeGreaterThan(29 * DAY_MS); // 30-day default, computed at ownership start
    await withTenantTx(w.owner.actor, async (tx) => {
      await sql`UPDATE tenant_settings SET inactivity_release_days = 7 WHERE tenant_id = app.tenant_id()`.execute(tx);
    }, { db: h.app });
    await deleteJobs(w.tenantId, 'ownership.inactivity');

    const sweeper = createSweeper({ db: h.app, registry: reg(), log: quiet() });
    await sweeper.sweepOnce(await at(8 * DAY_MS)); // overdue under the NEW setting, not under the stored instants
    const mine = async () => (await jobsFor(h.su, w.tenantId, 'ownership.inactivity')).filter((j) => j.payload.contactId === contactId);
    expect(await mine()).toEqual([]);

    await sweeper.sweepOnce(instant(warnAt + 1000));
    expect((await mine()).map((j) => j.payload)).toEqual([{ contactId, deadline: 'inactivity_warn', periodSeq: Number(c.ownership_period_seq), dueAt: warnAt }]);
    await sweeper.sweepOnce(instant(releaseAt + 1000));
    expect((await mine()).map((j) => j.payload.deadline).sort()).toEqual(['inactivity_release', 'inactivity_warn']);
  });

  it('E5: a lost ownership.followup after a decline is recovered by the route branch, with the decline’s own command id', async () => {
    const { contactId } = await intakeLead(h.app, w);
    const c0 = await contactRow(h.su, contactId);
    const decliner = w.agents.find((a) => a.id === c0.offered_to_user_id)!;
    const declineId = '0190f5a0-1111-7000-8000-' + contactId.slice(-12);
    const d = await cmd(h.app, decliner.actor, contactId, { kind: 'decline', offerId: c0.offer_id as string }, declineId);
    expect(d.outcome.ok).toBe(true);
    expect((await contactRow(h.su, contactId)).ownership_state).toBe('unassigned');

    const sweeper = createSweeper({ db: h.app, registry: reg(), log: quiet() });
    // still live: the sweeper's re-issue collides with the original follow-up (same dedupe key)
    const live = await sweeper.sweepOnce(await at(20_000));
    expect(live.deduped).toBeGreaterThanOrEqual(1);
    expect((await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.dedupe_key === `followup:${declineId}`)).toHaveLength(1);

    // lost
    await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND dedupe_key = $2`, [w.tenantId, `followup:${declineId}`]);
    // within 15 s of route_due_at nothing is due yet (the follow-up job normally routes first)
    await sweeper.sweepOnce(await at(5_000));
    expect((await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.dedupe_key === `followup:${declineId}`)).toHaveLength(0);
    await sweeper.sweepOnce(await at(20_000));
    const [fj] = (await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.dedupe_key === `followup:${declineId}`);
    expect(fj!.payload).toEqual({ commandId: declineId, contactId, effects: [{ kind: 'route' }], fanoutNotificationIds: [] });

    await createWorker({ queues: ['realtime'], concurrency: 4, worker: workerName('t'), db: h.app, registry: reg(), log: quiet() }).drain();
    const c1 = await contactRow(h.su, contactId);
    expect(c1.ownership_state).toBe('offered');
    expect(c1.offered_to_user_id).not.toBe(decliner.id);
    expect((await ledgerTypes(h.su, contactId)).slice(-2)).toEqual(['offer_declined', 'offered']);
  });
});

describe('sweeper: tenancy and partial builds', () => {
  it('R-TEN-6: due work of two tenants is enqueued in one transaction per tenant, never one spanning both', async () => {
    const a = await createWorld(h.app, { agents: 1 });
    const b = await createWorld(h.app, { agents: 1 });
    const leads = [await intakeLead(h.app, a), await intakeLead(h.app, a), await intakeLead(h.app, b)];
    for (const l of leads) await expireOffer(l.contactId);
    for (const t of [a, b]) await deleteJobs(t.tenantId, 'ownership.offer_expiry');
    await createSweeper({ db: h.app, registry: reg(), log: quiet() }).sweepOnce();
    // jobs.created_at defaults to now(), the transaction start: equal within one transaction (savepoints
    // included), distinct across transactions
    const rows = await suRows<{ tenant_id: string; x: string }>(
      h.su,
      `SELECT tenant_id::text, created_at::text AS x FROM jobs WHERE kind = 'ownership.offer_expiry' AND tenant_id = ANY ($1::uuid[]) AND status = 'pending'`,
      [[a.tenantId, b.tenantId]],
    );
    const xa = new Set(rows.filter((r) => r.tenant_id === a.tenantId).map((r) => r.x));
    const xb = new Set(rows.filter((r) => r.tenant_id === b.tenantId).map((r) => r.x));
    expect(rows.filter((r) => r.tenant_id === a.tenantId)).toHaveLength(2);
    expect(xa.size).toBe(1); // both of tenant A's jobs: one transaction
    expect(xb.size).toBe(1);
    expect([...xa][0]).not.toBe([...xb][0]); // ... and not tenant B's
  });

  it('kinds with no handler in this build are skipped (counted), not turned into dead jobs', async () => {
    const t = await createWorld(h.app, { agents: 1 });
    await intakeLead(h.app, t); // the offer's web-push delivery row is due now (notify.deliver is api/workspace)
    const r = await createSweeper({ db: h.app, registry: reg(), log: quiet() }).sweepOnce(await at(1_000));
    expect(r.unhandled).toBeGreaterThanOrEqual(1);
    expect(await jobsFor(h.su, t.tenantId, NOTIFY_DELIVER.kind)).toEqual([]);
  });
});

describe('sweeper: branch → job contract', () => {
  const T = '0190f5a0-0000-7000-8000-0000000000aa' as TenantId;
  const id = '0190f5a0-0000-7000-8000-0000000000bb';
  const now = instant(1_800_000_000_000);
  it('message, reconcile, stale-dispatch, playbook-step and delivery rows map to their contract kinds, queues and dedupe keys', () => {
    const plan = (workKind: string, dueAt: Instant | null = now) => planDue({ tenantId: T, workKind, refId: id, dueAt }, undefined, now);
    expect(plan('message_dispatch')).toEqual([{ spec: { queue: 'realtime', kind: COMMS_DISPATCH.kind, priority: 50, payload: { messageId: id }, dedupeKey: `comms.dispatch:${id}` } }]);
    expect(plan('dispatch_stale')).toEqual([{ spec: { queue: 'realtime', kind: COMMS_DISPATCH_STALE.kind, priority: 60, payload: { messageId: id }, dedupeKey: `comms.dispatch_stale:${id}` } }]);
    expect(plan('dispatch_reconcile')).toEqual([{ spec: { queue: 'realtime', kind: COMMS_RECONCILE.kind, priority: 60, payload: { messageId: id }, dedupeKey: `comms.reconcile:${id}` } }]);
    expect(plan('playbook_step')).toEqual([{ spec: { queue: 'default', kind: PLAYBOOK_STEP.kind, priority: 80, payload: { enrollmentId: id, dueAt: now }, dedupeKey: `playbook.step:${id}:${now}` } }]);
    expect(plan('notification_delivery')).toEqual([{ spec: { queue: 'realtime', kind: NOTIFY_DELIVER.kind, priority: 40, payload: { deliveryId: id }, dedupeKey: `notify.deliver:${id}` } }]);
    expect(plan('playbook_step', null)).toEqual([{ stale: true }]);
    expect(plan('something_new')).toEqual([{ unhandled: 'something_new' }]);
    // contact branches whose state moved on before the re-read wake nothing
    expect(plan('offer_expiry')).toEqual([{ stale: true }]);
    expect(plan('route')).toEqual([{ stale: true }]);
  });
});
