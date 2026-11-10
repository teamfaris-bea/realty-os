// Kill-the-worker tests (BUILD_PLAN module 9): a real child process is SIGKILLed mid-job.
//  - a lease expires, the reaper returns the job, and the re-run is idempotent (ownership.followup)
//  - E7: killed between dispatch TX1 and provider.send, and between provider.send and TX2: the re-run
//    never re-sends; 20 min later the sweeper's dispatch_stale branch yields dispatch_unknown and a
//    reconciliation job (R-GATE-8's reconcile handler itself is api/comms, module 12).
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { type ContactId, instant } from '@realty/core/foundation';
import { enqueueJob, withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_RECONCILE, type MessagePayload } from './contracts.js';
import { dispatchStaleHandler } from './handlers/dispatchStale.js';
import { ownershipFollowupHandler } from './handlers/followup.js';
import { createWorker, workerName } from './loop.js';
import { createMaintenance } from './maintenance.js';
import { memoryLogger } from './observability.js';
import { createSweeper } from './sweeper.js';
import { type CrashAt, testDispatchHandler } from './testing/crashWorker.js';
import { type Harness, type World, cmd, contactRow, createHarness, createWorld, intakeLead, jobsFor, ledgerTypes, registryWith, suFixture, uuid } from './testing/world.js';
import type { TxJobHandler } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD = join(HERE, 'testing', 'crashWorker.ts');

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

function runChild(env: Record<string, string>): { child: ChildProcess; crashed: Promise<string> } {
  const child = spawn(process.execPath, ['--import', 'tsx', '--conditions=@realty/source', CHILD], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  const crashed = new Promise<string>((resolve, reject) => {
    child.stdout!.on('data', (b: Buffer) => {
      out += b.toString();
      if (/CRASH_POINT|NO_CRASH|CHILD_ERROR/.test(out)) resolve(out);
    });
    child.stderr!.on('data', (b: Buffer) => (out += b.toString()));
    child.on('exit', () => resolve(out));
    setTimeout(() => reject(new Error(`child never reached its crash point: ${out}`)), 25_000);
  });
  return { child, crashed };
}

async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGKILL');
  });
}

/** Waits for the 2 s lease to lapse, then the maintenance reaper puts the job back to pending. */
async function reapAfterLease(): Promise<void> {
  const m = createMaintenance({ db: h.app, registry: registryWith(), log: memoryLogger() });
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const r = await m.runOnce();
    if ((r.reaped ?? 0) > 0) return;
  }
  throw new Error('lease never expired');
}

/** Stand-in for api/comms' reconcile handler: the provider lookup is "still unknown", look again in 1 h. */
const reconcileStub: TxJobHandler<MessagePayload> = {
  kind: 'comms.reconcile',
  queue: 'realtime',
  schema: COMMS_RECONCILE.schema,
  run: async (ctx) => ({ retryAt: instant(ctx.now + 3_600_000) }),
};

describe('kill the worker', () => {
  it('a lease expires after the worker dies mid-transaction; the job re-runs and its effect happens exactly once', async () => {
    const { contactId, result } = await intakeLead(h.app, w);
    expect(result.outcome.ok).toBe(true);
    const c0 = await contactRow(h.su, contactId);
    const decliner = w.agents.find((a) => a.id === c0.offered_to_user_id)!;
    expect((await cmd(h.app, decliner.actor, contactId as ContactId, { kind: 'decline', offerId: c0.offer_id as string })).outcome.ok).toBe(true);

    const { child, crashed } = runChild({ CRASH_DB_URL: h.db.appUserUrl, CRASH_MODE: 'followup', CRASH_AT: 'mid_tx' });
    expect(await crashed).toContain('CRASH_POINT'); // the routing is applied inside the open transaction
    await kill(child);
    // nothing of the dead worker's transaction survived
    expect((await contactRow(h.su, contactId)).ownership_state).toBe('unassigned');
    const [running] = (await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.payload.contactId === contactId);
    expect(running!.status).toBe('running');
    expect(running!.locked_by).toBe('crash-worker');

    await reapAfterLease();
    const [reaped] = (await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.payload.contactId === contactId);
    expect([reaped!.status, reaped!.last_error, reaped!.attempts]).toEqual(['pending', 'LEASE_EXPIRED', 1]);

    const worker = createWorker({ queues: ['realtime'], concurrency: 2, worker: workerName('t'), db: h.app, registry: registryWith(ownershipFollowupHandler()), log: memoryLogger() });
    await worker.drain();
    const [done] = (await jobsFor(h.su, w.tenantId, 'ownership.followup')).filter((j) => j.payload.contactId === contactId);
    expect([done!.status, done!.attempts]).toEqual(['succeeded', 2]);
    expect((await ledgerTypes(h.su, contactId)).filter((t) => t === 'offered')).toHaveLength(2); // the first offer + exactly one re-offer
    expect((await contactRow(h.su, contactId)).offered_to_user_id).not.toBe(decliner.id);

    // replaying the same follow-up again (a duplicate delivery) changes nothing
    const before = await ledgerTypes(h.su, contactId);
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'realtime', 'ownership.followup', $2::jsonb, now())`, [w.tenantId, JSON.stringify(done!.payload)]);
    await worker.drain();
    expect(await ledgerTypes(h.su, contactId)).toEqual(before);
  }, 60_000);

  for (const point of ['after_tx1', 'after_send'] as const satisfies readonly CrashAt[]) {
    it(`E7: killed ${point === 'after_tx1' ? 'between TX1 and provider.send' : 'between provider.send and TX2'}: the re-run never re-sends; after 20 min the sweeper moves it to dispatch_unknown and queues reconciliation`, async () => {
      const { contactId } = await intakeLead(h.app, w);
      const messageId = uuid();
      // fixtures for rows api/comms would create: the recipient's contact point (the dispatch guard checks
      // its opt-out status) and a queued outbound SMS (0013: no gate decision is needed to dispatch)
      await suFixture(
        h.su,
        `INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
         VALUES ($1, $2, $3, 'phone', '+15550000002', decode(repeat('ab', 32), 'hex'))`,
        [w.tenantId, uuid(), contactId],
      );
      await suFixture(
        h.su,
        `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
                               body, status, initiator, purpose, idempotency_key, occurred_at)
         VALUES ($1, $2::uuid, $3, $4, 'sms', 'outbound', $5, '+15550000001', '+15550000002', 'Hi there', 'queued', 'system', 'informational', $2::text, now())`,
        [w.tenantId, messageId, uuid(), contactId, uuid()],
      );
      const log = join(mkdtempSync(join(tmpdir(), 'realty-crash-')), `provider-${randomBytes(3).toString('hex')}.log`);
      await withTenantTx(w.system(), (tx) => enqueueJob(tx, { queue: 'realtime', kind: 'test.dispatch', payload: { messageId } }), { db: h.app });

      const { child, crashed } = runChild({ CRASH_DB_URL: h.db.appUserUrl, CRASH_MODE: 'dispatch', CRASH_AT: point, CRASH_LOG: log });
      expect(await crashed).toContain('CRASH_POINT');
      await kill(child);
      const sends = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
      const sentBefore = point === 'after_tx1' ? 0 : 1;
      expect(sends()).toBe(sentBefore);
      const msg = async () => (await h.su.query<{ status: string; dispatched_at: Date | null }>('SELECT status, dispatched_at FROM messages WHERE id = $1', [messageId])).rows[0]!;
      expect((await msg()).status).toBe('dispatching'); // TX1 committed, TX2 never happened

      await reapAfterLease();
      const reg = registryWith(testDispatchHandler({ providerLog: log }), dispatchStaleHandler(), reconcileStub);
      const worker = createWorker({ queues: ['realtime'], concurrency: 2, worker: workerName('t'), db: h.app, registry: reg, log: memoryLogger() });
      await worker.drain();
      const [job] = await jobsFor(h.su, w.tenantId, 'test.dispatch').then((js) => js.filter((j) => j.payload.messageId === messageId));
      expect([job!.status, job!.attempts]).toEqual(['succeeded', 2]);
      expect(sends()).toBe(sentBefore); // never re-sent
      expect((await msg()).status).toBe('dispatching');

      // before the 20 min threshold the sweeper leaves it alone
      const sweeper = createSweeper({ db: h.app, registry: reg, log: memoryLogger() });
      await sweeper.sweepOnce();
      expect(await jobsFor(h.su, w.tenantId, 'comms.dispatch_stale').then((js) => js.filter((j) => j.payload.messageId === messageId))).toEqual([]);

      // 21 minutes later (time travel on the stored stamp only)
      await suFixture(h.su, `UPDATE messages SET dispatched_at = now() - interval '21 minutes' WHERE id = $1`, [messageId]);
      await sweeper.sweepOnce();
      await worker.drain();
      expect((await msg()).status).toBe('dispatch_unknown');
      expect(sends()).toBe(sentBefore);
      const reconcile = (await jobsFor(h.su, w.tenantId, 'comms.reconcile')).filter((j) => j.payload.messageId === messageId);
      // the stub reschedules (an early wake): the job is pending again with its attempt refunded (0005)
      expect(reconcile.map((j) => [j.status, j.dedupe_key, j.attempts, j.last_error])).toEqual([['pending', `comms.reconcile:${messageId}`, 0, 'RESCHEDULED']]);
      // the reconcile branch (dispatch_unknown > 2 min) re-issues the SAME job: a no-op while it is live
      const r = await sweeper.sweepOnce();
      expect(r.deduped).toBeGreaterThanOrEqual(1);
      expect((await jobsFor(h.su, w.tenantId, 'comms.reconcile')).filter((j) => j.payload.messageId === messageId)).toHaveLength(1);
    }, 60_000);
  }
});
