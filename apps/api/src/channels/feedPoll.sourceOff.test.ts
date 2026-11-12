// R-LSRC-2 / E387 (module 22, orchestrator 2026-11-12): a partner-feed lead that arrives while its lead source is off is
// skipped, not retried: no contact, no inquiry, one receipt per lead with its reason (no lead content), the cursor
// advances, the Lead sources overview counts them, and turning the source back on does not replay them.
import { randomUUID } from 'node:crypto';
import { enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { makeCommsHandlers } from '../comms/handlers.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { type LeadsWorld, call, leadsWorld, randomPhone } from '../leads/testing.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { makeChannelHandlers } from './handlers.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 1 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function feedConnection(sourceId: string): Promise<string> {
  const id = randomUUID();
  const credId = randomUUID();
  await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
    const enc = await h.app.platform.envelope.inTx(tx, w.tenantId as never).encrypt(w.tenantId as never, { table: 'provider_credentials', column: 'secret_enc', rowId: credId }, Buffer.from(JSON.stringify({ accessToken: 'fake-partner-token' })));
    await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (app.tenant_id(), ${credId}::uuid, 'zillow', ${Buffer.from(enc)}, 1)`.execute(tx);
    await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id) VALUES (app.tenant_id(), ${id}::uuid, 'zillow_feed', 'Feed', ${sourceId}::uuid)`.execute(tx);
    await sql`UPDATE integration_connections SET status = 'connected', connected_at = now(), external_account_id = ${`acct-${id.slice(0, 8)}`}, credential_id = ${credId}::uuid WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  }, { db: h.database });
  return id;
}

async function runFeedPoll(connId: string): Promise<void> {
  await h.su.query("UPDATE integration_connections SET next_sync_at = now() - interval '1 second' WHERE id = $1", [connId]);
  await withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => enqueueJob(tx, { queue: 'default', kind: 'leads.feed_poll', payload: {}, dedupeKey: `feed-test:${randomUUID()}` }), { db: h.database });
  const deps = depsFromPlatform(h.app.platform);
  const registry = new HandlerRegistry().registerAll([...makeChannelHandlers(() => ({ envelope: deps.envelope, ids: deps.ids })), ...makeCommsHandlers(() => deps)]);
  await createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 1, worker: `feed-${randomUUID().slice(0, 6)}`, idleMs: 10, log: silentLogger }).drain(10);
}

describe('R-LSRC-2 E387 partner-feed leads while the source is off', () => {
  it('R-LSRC-2 E387: skipped with one receipt each (no lead content), the cursor advances, the overview counts them, and turning the source on does not replay them', async () => {
    const connId = await feedConnection(w.sourceId);
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/lead-sources/${w.sourceId}/off`)).status).toBe(200);
    const phones = [randomPhone(), randomPhone()];
    const feed = h.providers.integrations.leadFeeds.zillow;
    for (const [i, phone] of phones.entries()) feed.leads.push({ externalLeadId: `off-${i}-${randomUUID()}`, receivedAt: new Date().toISOString(), name: `Off Feed ${i}`, phone, email: null, message: 'Saw it online', listingRef: null });
    const before = (await h.su.query('SELECT sync_cursor FROM integration_connections WHERE id = $1', [connId])).rows[0]!.sync_cursor;

    await runFeedPoll(connId);
    const inPoints = async () => (await h.su.query('SELECT count(*)::int AS n FROM contact_points WHERE tenant_id = $1 AND address = ANY ($2::text[])', [w.tenantId, phones])).rows[0]!.n;
    expect(await inPoints()).toBe(0);
    const skips = (await h.su.query('SELECT lead_source_id, channel, reason, octet_length(external_ref_sha256) AS len FROM lead_source_skips WHERE tenant_id = $1', [w.tenantId])).rows;
    expect(skips).toEqual([
      { lead_source_id: w.sourceId, channel: 'partner_feed', reason: 'SOURCE_OFF', len: 32 },
      { lead_source_id: w.sourceId, channel: 'partner_feed', reason: 'SOURCE_OFF', len: 32 },
    ]);
    const conn = (await h.su.query('SELECT sync_cursor, last_error_code FROM integration_connections WHERE id = $1', [connId])).rows[0]!;
    expect(conn.last_error_code).toBeNull();
    expect(conn.sync_cursor).not.toBe(before);

    const o = (await call<{ sources: { id: string; skippedWhileOffLast30Days: number }[] }>(w.owner, 'GET', '/lead-sources/overview')).body;
    expect(o.sources.find((s) => s.id === w.sourceId)!.skippedWhileOffLast30Days).toBe(2);

    // back on: the skipped leads are not replayed; a new one comes in
    expect((await call(w.owner, 'POST', `/lead-sources/${w.sourceId}/on`)).status).toBe(200);
    const fresh = randomPhone();
    feed.leads.push({ externalLeadId: `on-${randomUUID()}`, receivedAt: new Date().toISOString(), name: 'On Feed', phone: fresh, email: null, message: null, listingRef: null });
    await runFeedPoll(connId);
    expect(await inPoints()).toBe(0);
    expect((await h.su.query('SELECT count(*)::int AS n FROM contact_points WHERE tenant_id = $1 AND address = $2', [w.tenantId, fresh])).rows[0]!.n).toBe(1);
    expect((await h.su.query('SELECT count(*)::int AS n FROM lead_source_skips WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n).toBe(2);
  });

  it('R-LSRC-2: a skip receipt is append-only and only the system writes one', async () => {
    await expect(h.su.query('UPDATE lead_source_skips SET reason = reason')).rejects.toThrow();
    await expect(withTenantTx({ kind: 'user', userId: w.owner.userId!, tenantId: w.tenantId, role: 'owner', sessionId: 'test' } as never, (tx) => sql`INSERT INTO lead_source_skips (tenant_id, id, lead_source_id, channel, external_ref_sha256, reason) VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${w.sourceId}::uuid, 'partner_feed', ${Buffer.alloc(32)}, 'SOURCE_OFF')`.execute(tx), { db: h.database })).rejects.toThrow(/row-level security/);
  });
});
