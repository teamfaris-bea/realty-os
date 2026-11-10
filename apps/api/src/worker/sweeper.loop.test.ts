// R-OWN-15 with the real loops: a deadline whose job row is lost is processed within one sweep
// interval (15 s) plus queue latency, by the running sweeper + worker.
import { createDatabase } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownershipFollowupHandler } from './handlers/followup.js';
import { createWorker, workerName } from './loop.js';
import { MemoryMetrics, memoryAlerts, memoryLogger } from './observability.js';
import { createSweeper } from './sweeper.js';
import { type Harness, type World, contactRow, createHarness, createWorld, intakeLead, ledgerTypes, registryWith, suFixture, testTimerHandlers } from './testing/world.js';

let h: Harness;
let w: World;
beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

describe('sweeper loop', () => {
  it('R-OWN-15 E6: a lost job is recovered by the running sweeper within 15 s (plus queue latency)', async () => {
    const db = createDatabase({ url: h.db.appUserUrl, max: 4 });
    const reg = registryWith(...testTimerHandlers(), ownershipFollowupHandler());
    const metrics = new MemoryMetrics();
    const ac = new AbortController();
    const sweeper = createSweeper({ db, registry: reg, log: memoryLogger(), alerts: memoryAlerts(), metrics }).run({ everyMs: 15_000, signal: ac.signal }).catch(() => undefined);
    const worker = createWorker({ queues: ['realtime'], concurrency: 2, worker: workerName('t'), db, registry: reg, log: memoryLogger(), signal: ac.signal }).run().catch(() => undefined);
    try {
      // wait for the sweeper's first pass, then lose a deadline right after it (the worst case)
      while ((metrics.samples.get('sweeper_pass_ms')?.length ?? 0) < 1) await new Promise((r) => setTimeout(r, 20));
      const { contactId } = await intakeLead(h.app, w);
      await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry'`, [w.tenantId]);
      await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() WHERE id = $1`, [contactId]);
      await suFixture(
        h.su,
        `UPDATE lead_ownership_events SET deadline_at = (SELECT offer_expires_at FROM contacts WHERE id = $1)
          WHERE contact_id = $1 AND type = 'offered'`,
        [contactId],
      );
      const t0 = Date.now();
      let elapsed = -1;
      while (Date.now() - t0 < 25_000) {
        if ((await ledgerTypes(h.su, contactId)).includes('offer_expired')) {
          elapsed = Date.now() - t0;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(15_000 + 2_000);
      expect((await contactRow(h.su, contactId)).ownership_state).toBe('offered'); // re-offered to the next agent
    } finally {
      ac.abort(new Error('stop'));
      await Promise.all([sweeper, worker]);
      await db.close();
    }
  }, 45_000);
});
