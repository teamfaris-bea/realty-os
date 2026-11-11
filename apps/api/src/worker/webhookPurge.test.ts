// Webhook-id purge (migration 0018 app.purge_webhook_events, maintenance step webhook_purge): rows past
// their replay window are deleted, rows inside it stay, and the app role cannot shorten a window.
import { randomUUID } from 'node:crypto';
import { withPreTenant } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMaintenance } from './maintenance.js';
import { MemoryMetrics, memoryAlerts, memoryLogger } from './observability.js';
import { type Harness, createHarness, suFixture, suRows } from './testing/world.js';
import { HandlerRegistry } from './registry.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h?.close();
});

const tag = randomUUID().slice(0, 8);

async function event(provider: string, ageDays: number, status: 'processed' | 'rejected' = 'processed'): Promise<string> {
  const id = randomUUID();
  await suFixture(
    h.su,
    `INSERT INTO webhook_events (id, provider, provider_event_id, tenant_id, received_at, signature_valid, status)
     VALUES ($1, $2, $3, NULL, now() - make_interval(days => $4::int) - interval '1 minute', $5, $6)`,
    [id, provider, `${tag}:${provider}:${ageDays}:${status}:${id}`, ageDays, status !== 'rejected', status],
  );
  return id;
}

const exists = async (id: string) => (await suRows(h.su, 'SELECT 1 FROM webhook_events WHERE id = $1', [id])).length === 1;

describe('webhook id purge', () => {
  it('deletes ids after their replay window (rejected 30 d, lead 2 d, email 35 d, telephony 400 d) and keeps every id inside it', async () => {
    const gone = [await event('lead', 3), await event('email', 36), await event('telephony', 401), await event('telephony', 31, 'rejected'), await event('email', 31, 'rejected')];
    const kept = [await event('lead', 1), await event('email', 34), await event('telephony', 399), await event('telephony', 36), await event('lead', 29, 'rejected'), await event('telephony', 2, 'rejected')];
    const metrics = new MemoryMetrics();
    const m = createMaintenance({ db: h.app, registry: new HandlerRegistry(), log: memoryLogger(), alerts: memoryAlerts(), metrics, periodicEveryMs: 1e12, auditCheckEveryMs: 1e12 });
    const report = await m.runOnce();
    expect(report.failedSteps).toEqual([]);
    expect(report.webhookIdsPurged).not.toBeNull();
    for (const id of gone) expect(await exists(id)).toBe(false);
    for (const id of kept) expect(await exists(id)).toBe(true);
  });

  it('the app role cannot delete webhook ids directly, and the purge function takes no window or clock to abuse', async () => {
    const recent = await event('telephony', 0);
    await expect(withPreTenant((tx) => sql`DELETE FROM webhook_events WHERE id = ${recent}::uuid`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
    await expect(withPreTenant((tx) => sql`SELECT app.purge_webhook_events(now() + interval '10 years')`.execute(tx), { db: h.app })).rejects.toThrow(/does not exist/);
    await withPreTenant((tx) => sql`SELECT app.purge_webhook_events()`.execute(tx), { db: h.app });
    expect(await exists(recent)).toBe(true);
  });
});
