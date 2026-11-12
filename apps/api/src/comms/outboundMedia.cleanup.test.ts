// D5a cleanup (R-MMS-3, R-MMS-7, E298, E299): unused uploads are purged and shredded, then their blobs deleted; the
// provider's stored copies of a sent photo text are deleted 24 h after dispatch (also after an erasure), and those of a
// submit whose outcome stayed unknown are found by the sending number and the time, with a P2 alert when none is found.
import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { type TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { blobDeleteHandler } from '../worker/handlers/blobDelete.js';
import { memoryAlerts, silentLogger } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { MMS_PROVIDER_CLEANUP, cleanupProviderCopies, mmsProviderCleanupHandler, outboundMediaPurgeHandler } from './outboundMedia.js';
import { png, sendPhotoText, uploadId } from './outboundMedia.testing.js';
import { type CommsWorld, commsWorld, messageRow, ownedContact, runJobs } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const tel = () => h.providers.telephony;
const cleanupJobs = async (messageId: string) => (await h.su.query("SELECT payload, run_at, status FROM jobs WHERE kind = $1 AND payload->>'messageId' = $2", [MMS_PROVIDER_CLEANUP.kind, messageId])).rows;
const jobCtx = (alerts = memoryAlerts()) => ({ actor: systemActor(w.tenantId, 'provider'), now: Date.now() as never, providers: h.providers, job: { id: 1n, kind: MMS_PROVIDER_CLEANUP.kind, queue: 'default' as const, attempts: 1 }, log: silentLogger, alerts, withTx: (() => { throw new Error('unused'); }) as never });

describe('R-MMS-7: the provider\'s stored copies are deleted 24 h after dispatch', () => {
  it('R-MMS-7: a sent photo text enqueues comms.mms_provider_cleanup at dispatched_at + 24 h with ids only; it deletes each item at the provider', async () => {
    const c = await ownedContact(agent);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id), await uploadId(agent, c.id, png(), 'image/png')], 'Two');
    const m = await messageRow(h, r.body.message!.id);
    const jobs = await cleanupJobs(m.provider_message_ref ? r.body.message!.id : '');
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['messageId', 'providerRef']);
    expect((jobs[0].run_at as Date).getTime() - m.dispatched_at!.getTime()).toBe(24 * 3600_000);
    await runJobs(h, w.tenantId, [MMS_PROVIDER_CLEANUP.kind]);
    const kept = tel().providerMedia.get(m.provider_message_ref!)!;
    expect(kept).toHaveLength(2);
    for (const me of kept) expect(tel().deletedMedia).toContain(me);
  });

  it('R-MMS-7 (E299): the cleanup also runs after the person was erased', async () => {
    const c = await ownedContact(agent);
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Erased later');
    const m = await messageRow(h, r.body.message!.id);
    await withTenantTx(w.owner.actor(), (tx) => sql`SELECT app.erase_contact(${c.id}::uuid, ${randomUUID()}::uuid, 'PRIVACY_REQUEST')`.execute(tx), { db: h.database });
    expect((await h.su.query('SELECT count(*)::int AS n FROM messages WHERE id = $1', [r.body.message!.id])).rows[0].n).toBe(0);
    await runJobs(h, w.tenantId, [MMS_PROVIDER_CLEANUP.kind]);
    for (const me of tel().providerMedia.get(m.provider_message_ref!)!) expect(tel().deletedMedia).toContain(me);
  });
});

describe('E298: a submit whose outcome stayed unknown', () => {
  it('E298: the URLs are served while dispatch_unknown; unresolved after 10 min the message fails and its URLs answer 404; 24 h later its copy is found by number and time and deleted', async () => {
    const c = await ownedContact(agent);
    tel().failNext('timeout_after_submit');
    const r = await sendPhotoText(agent, c.id, [await uploadId(agent, c.id)], 'Timed out');
    expect(r.body.result).toBe('dispatch_unknown');
    const sent = tel().sms.find((x) => x.idempotencyKey === r.body.message!.id)!;
    const u = new URL(sent.mediaUrls[0]!);
    expect((await h.app.inject({ method: 'GET', url: u.pathname + u.search })).statusCode).toBe(200);
    tel().lookupMiss = true;
    try {
      await h.su.query("UPDATE messages SET dispatched_at = dispatched_at - interval '11 minutes' WHERE id = $1", [r.body.message!.id]);
      await runJobs(h, w.tenantId, ['comms.reconcile']);
    } finally {
      tel().lookupMiss = false;
    }
    const m = await messageRow(h, r.body.message!.id);
    expect(m.status).toBe('failed');
    expect(m.status_reason).toBe('DISPATCH_UNKNOWN_UNRESOLVED');
    expect((await h.app.inject({ method: 'GET', url: u.pathname + u.search })).statusCode).toBe(404);
    const jobs = await cleanupJobs(r.body.message!.id);
    expect(jobs).toHaveLength(1);
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['dispatchedAt', 'messageId', 'phoneNumberId']);
    expect(JSON.stringify(jobs[0].payload)).not.toContain(c.phone);
    await runJobs(h, w.tenantId, [MMS_PROVIDER_CLEANUP.kind]);
    const call = tel().listOutboundCalls.at(-1)!;
    expect(call.from).toBe(w.mainNumber);
    expect(call.createdTo - call.createdFrom).toBe(21 * 60_000);
    for (const me of tel().providerMedia.get(sent.providerRef)!) expect(tel().deletedMedia).toContain(me);
  });

  it('E298: when no copy is found for the sending number and time, a P2 WORKER_ERROR alert carries only ids and the instant', async () => {
    const alerts = memoryAlerts();
    const handler = mmsProviderCleanupHandler(() => w.deps);
    const payload = { messageId: randomUUID(), phoneNumberId: w.mainNumberId, dispatchedAt: Date.now() - 400 * 24 * 3600_000 };
    await handler.run(jobCtx(alerts) as never, payload);
    expect(alerts.alerts).toHaveLength(1);
    expect(alerts.alerts[0]).toMatchObject({ severity: 'P2', code: 'WORKER_ERROR', tenantId: w.tenantId, details: { kind: MMS_PROVIDER_CLEANUP.kind, ...payload } });
    expect(await cleanupProviderCopies(w.deps, w.tenantId, payload)).toMatchObject({ messages: 0 });
  });
});

describe('R-MMS-3 (E299): the purge job', () => {
  it('R-MMS-3: comms.outbound_media_purge deletes expired uploads (DB clock), the trigger shreds their objects, then storage.blob_delete removes the blobs', async () => {
    const c = await ownedContact(agent);
    const old = await uploadId(agent, c.id);
    const fresh = await uploadId(agent, c.id);
    await h.su.query("UPDATE outbound_media_uploads SET expires_at = now() - interval '1 second' WHERE id = $1", [old]);
    const obj = (id: string) => h.su.query('SELECT o.id, o.storage_key, o.deleted_at, o.dek_wrapped, o.blob_deleted_at FROM stored_objects o JOIN outbound_media_uploads u ON u.object_id = o.id WHERE u.id = $1', [id]);
    const oldObj = (await obj(old)).rows[0];
    expect(await h.providers.storage.get(oldObj.storage_key)).not.toBeNull();
    const purge = outboundMediaPurgeHandler();
    await withTenantTx(systemActor(w.tenantId, 'worker'), (tx, now) => purge.run({ ...jobCtx(), actor: systemActor(w.tenantId, 'worker'), tx, now } as never, {} as never), { db: h.database });
    expect((await h.su.query('SELECT id FROM outbound_media_uploads WHERE id = ANY ($1)', [[old, fresh]])).rows.map((x) => x.id)).toEqual([fresh]);
    const after = (await h.su.query('SELECT deleted_at, dek_wrapped FROM stored_objects WHERE id = $1', [oldObj.id])).rows[0];
    expect(after.deleted_at).not.toBeNull();
    expect(after.dek_wrapped).toBeNull();
    expect((await obj(fresh)).rows[0].deleted_at).toBeNull();
    const blobs = blobDeleteHandler();
    await withTenantTx(systemActor(w.tenantId as TenantId, 'worker'), (tx, now) => blobs.run({ ...jobCtx(), actor: systemActor(w.tenantId, 'worker'), tx, now } as never, {} as never), { db: h.database });
    expect((await h.su.query('SELECT blob_deleted_at FROM stored_objects WHERE id = $1', [oldObj.id])).rows[0].blob_deleted_at).not.toBeNull();
    expect(await h.providers.storage.get(oldObj.storage_key)).toBeNull();
  });
});
