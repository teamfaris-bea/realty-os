// Notifications over real Postgres as app_user (BUILD_PLAN module 14; ARCHITECTURE §12): critical kinds
// cannot be muted (DB CHECK + API 422), at-least-once delivery with duplicate suppression through unique
// delivery rows, retries then dead + alert, lock-screen payloads without PII, SMS-to-agent through the
// gate, the in-app list, and the intake → offer push latency (measured with an immediate sweep).
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld } from '../comms/testing.js';
import { contactState, intake, suFixture } from '../leads/testing.js';
import { createWorker } from '../worker/loop.js';
import { memoryAlerts, memoryLogger, silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { createSweeper } from '../worker/sweeper.js';
import { makeNotificationHandlers } from './handlers.js';
import { RETRY_SCHEDULE_MS, deliverNotification, lockScreenPayload, quietRemainingMs, retryDelay } from './notifications.js';
import { NOTIFICATION_KINDS } from './schemas.js';
import { call, deliveryDeps } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
});
afterAll(async () => {
  await h?.close();
});

type Agent = CommsWorld['agents'][number];

/** A notification for `user` with its in-app row and one pending web-push row per live subscription (as api/comms writes them). */
async function notification(user: Agent, kind: string, o: { title?: string; priority?: string } = {}): Promise<{ id: string; pushIds: string[] }> {
  const id = randomUUID();
  await h.su.query(
    `INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, subject_type, subject_id, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,'contact',$7,$8)`,
    [w.tenantId, id, user.userId, kind, o.priority ?? 'normal', o.title ?? 'Jane D. sent a message', randomUUID(), `t:${id}`],
  );
  await h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status) VALUES ($1,$2,$3,'in_app','in_app','delivered')`, [w.tenantId, randomUUID(), id]);
  const subs = await h.su.query<{ id: string }>('SELECT id FROM push_subscriptions WHERE user_id = $1 AND tenant_id = $2 AND revoked_at IS NULL', [user.userId, w.tenantId]);
  const pushIds: string[] = [];
  for (const s of subs.rows) {
    const d = randomUUID();
    await h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'web_push',$4,'pending',now())`, [w.tenantId, d, id, s.id]);
    pushIds.push(d);
  }
  return { id, pushIds };
}

const delivery = async (id: string) => (await h.su.query<{ status: string; attempts: number; last_error: string | null; next_attempt_at: Date | null; gate_decision_id: string | null }>('SELECT status, attempts, last_error, next_attempt_at, gate_decision_id FROM notification_deliveries WHERE id = $1', [id])).rows[0]!;
// lock-screen tags are `<tenant id>:<notification id>` (E56: tagged by tenant)
const pushesTo = (tag: string) => h.providers.push.delivered.filter((p) => p.payload.tag === `${w.tenantId}:${tag}`);

describe('preferences', () => {
  it('critical notification kinds cannot be muted and keep push or SMS (API 422 NOTIFICATION_CRITICAL, DB CHECK)', async () => {
    const a = w.agents[0]!;
    const future = new Date(Date.now() + 86_400_000).toISOString();
    for (const kind of ['lead_offer', 'first_touch_due', 'handback_hot']) {
      const m = await call(a, 'PUT', '/notification-preferences', { kind, channels: ['web_push'], mutedUntil: future });
      expect([m.status, m.code]).toEqual([422, 'NOTIFICATION_CRITICAL']);
      const e = await call(a, 'PUT', '/notification-preferences', { kind, channels: ['email'] });
      expect([e.status, e.code]).toEqual([422, 'NOTIFICATION_CRITICAL']);
    }
    expect((await call(a, 'PUT', '/notification-preferences', { kind: 'lead_offer', channels: ['sms'] })).status).toBe(200);
    // the database refuses it too, whatever the caller
    await expect(
      withTenantTx(a.actor(), (tx) => sql`INSERT INTO notification_preferences (tenant_id, user_id, kind, channels, muted_until) VALUES (app.tenant_id(), app.user_id(), 'handback_hot', ARRAY['in_app','web_push'], now() + interval '1 day')`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/check constraint/);
    await expect(
      withTenantTx(a.actor(), (tx) => sql`UPDATE notification_preferences SET channels = ARRAY['in_app'] WHERE user_id = app.user_id() AND kind = 'lead_offer'`.execute(tx), { db: h.database }),
    ).rejects.toThrow(/check constraint/);
    // ordinary kinds can be muted
    const ok = await call<{ preference: { kind: string; mutedUntil: string; channels: string[]; critical: boolean } }>(a, 'PUT', '/notification-preferences', { kind: 'inbound_message', channels: ['web_push'], mutedUntil: future });
    expect(ok.status).toBe(200);
    expect(ok.body.preference).toMatchObject({ kind: 'inbound_message', critical: false, channels: ['in_app', 'web_push'] });
    const all = await call<{ preferences: { kind: string; critical: boolean; saved: boolean }[] }>(a, 'GET', '/notification-preferences');
    expect(all.body.preferences.map((p) => p.kind)).toEqual([...NOTIFICATION_KINDS]);
    expect(all.body.preferences.filter((p) => p.critical).map((p) => p.kind)).toEqual(['lead_offer', 'first_touch_due', 'handback_hot']);
  });

  it('preferences apply at delivery time: muted, channel off, quiet hours defer; critical kinds are never held', async () => {
    const a = w.agents[1]!;
    const deps = deliveryDeps(h);
    await call(a, 'PUT', '/notification-preferences', { kind: 'missed_call', channels: ['in_app'] });
    const off = await notification(a, 'missed_call');
    expect(await deliverNotification(off.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'suppressed', reason: 'CHANNEL_OFF' });
    await call(a, 'PUT', '/notification-preferences', { kind: 'task_due', channels: ['web_push'], mutedUntil: new Date(Date.now() + 3_600_000).toISOString() });
    const muted = await notification(a, 'task_due');
    expect(await deliverNotification(muted.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'suppressed', reason: 'MUTED' });
    // quiet hours covering the whole day except the last minute: now is inside
    const zone = (await h.su.query<{ z: string }>('SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = $1', [w.tenantId])).rows[0]!.z;
    const local = new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    const [hh, mm] = local.split(':').map(Number) as [number, number];
    const end = `${String((hh + 2) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    const start = `${String((hh + 23) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    for (const kind of ['inbound_message', 'lead_offer']) await call(a, 'PUT', '/notification-preferences', { kind, channels: ['web_push', 'sms'], quietStart: start, quietEnd: end });
    const quiet = await notification(a, 'inbound_message');
    const q = await deliverNotification(quiet.pushIds[0]!, deps, w.tenantId);
    expect(q).toMatchObject({ kind: 'retry', reason: 'QUIET_HOURS' });
    const row = await delivery(quiet.pushIds[0]!);
    expect(row.status).toBe('pending');
    expect(row.next_attempt_at!.getTime() - Date.now()).toBeGreaterThan(100 * 60_000);
    const critical = await notification(a, 'lead_offer', { priority: 'critical', title: 'New lead offered to you' });
    expect(await deliverNotification(critical.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'sent' });
  });

  it('quiet windows across midnight and the retry schedule are computed exactly', () => {
    const t = Date.parse('2026-11-10T23:30:00Z') as never;
    expect(quietRemainingMs(t, 'Etc/UTC', '22:00', '07:00')).toBe(7.5 * 3_600_000);
    expect(quietRemainingMs(t, 'Etc/UTC', '08:00', '22:00')).toBeNull();
    expect(quietRemainingMs(t, 'Etc/UTC', null, null)).toBeNull();
    expect(RETRY_SCHEDULE_MS.map((_, i) => retryDelay(i + 1, () => 0.5))).toEqual([60_000, 120_000, 300_000, 900_000, 3_600_000]);
    expect(retryDelay(1, () => 0)).toBe(48_000);
    expect(retryDelay(1, () => 1)).toBe(72_000);
    expect(retryDelay(6, () => 0.5)).toBeNull();
  });
});

describe('delivery', () => {
  it('at least once, never twice: unique delivery rows, a row lock per attempt, and a sent row is never sent again', async () => {
    const a = w.agents[0]!;
    const deps = deliveryDeps(h);
    const n = await notification(a, 'reassigned_to_you', { title: 'A lead is now yours' });
    // the same notification twice (dedupe key) and the same delivery row twice are refused by unique keys
    await expect(h.su.query(`INSERT INTO notifications (tenant_id, id, user_id, kind, priority, title, dedupe_key) VALUES ($1,$2,$3,'inbound_message','normal','x',$4)`, [w.tenantId, randomUUID(), a.userId, `t:${n.id}`])).rejects.toThrow(/duplicate key/);
    const target = (await h.su.query<{ target_ref: string }>('SELECT target_ref FROM notification_deliveries WHERE id = $1', [n.pushIds[0]])).rows[0]!.target_ref;
    await expect(h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'web_push',$4,'pending',now())`, [w.tenantId, randomUUID(), n.id, target])).rejects.toThrow(/duplicate key/);
    // two runs at once (a sweeper re-issue racing a job): one push
    const both = await Promise.all([deliverNotification(n.pushIds[0]!, deps, w.tenantId), deliverNotification(n.pushIds[0]!, deps, w.tenantId)]);
    expect(both.map((x) => x.kind).sort()).toEqual(['noop', 'sent']);
    expect(pushesTo(n.id)).toHaveLength(1);
    expect(await deliverNotification(n.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'noop' });
    expect(await delivery(n.pushIds[0]!)).toMatchObject({ status: 'sent', attempts: 1 });
    // a run that died after claiming the row (left `sending`) is retried once its lease ran out: at least once
    // (triggers off: updated_at is otherwise stamped by app.touch_updated_at)
    await suFixture(h, [{ text: "UPDATE notification_deliveries SET status = 'sending', updated_at = now() - interval '5 minutes' WHERE id = $1", values: [n.pushIds[0]] }]);
    expect(await deliverNotification(n.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'sent' });
    expect(pushesTo(n.id)).toHaveLength(2);
    // ... but a live `sending` row is left alone
    await h.su.query("UPDATE notification_deliveries SET status = 'sending', updated_at = now() WHERE id = $1", [n.pushIds[0]]);
    expect(await deliverNotification(n.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'noop' });
  });

  it('a failing push retries with backoff 1 m, 2 m, 5 m, 15 m, 1 h, then goes dead with a platform alert', async () => {
    const a = w.agents[1]!;
    const alerts = memoryAlerts();
    const deps = deliveryDeps(h, { alerts, random: () => 0.5 });
    const n = await notification(a, 'pond_new');
    const spy = vi.spyOn(h.providers.push, 'deliverPush').mockResolvedValue({ status: 'failed' } as never);
    try {
      const delays: number[] = [];
      for (let i = 0; i < 5; i++) {
        const before = Date.now();
        const r = await deliverNotification(n.pushIds[0]!, deps, w.tenantId);
        expect(r.kind).toBe('retry');
        delays.push(Math.round(((r as { at: number }).at - before) / 60_000));
        await h.su.query('UPDATE notification_deliveries SET next_attempt_at = now() WHERE id = $1', [n.pushIds[0]]);
      }
      expect(delays).toEqual([1, 2, 5, 15, 60]);
      expect(await deliverNotification(n.pushIds[0]!, deps, w.tenantId)).toEqual({ kind: 'dead', reason: 'PUSH_FAILED' });
      expect(await delivery(n.pushIds[0]!)).toMatchObject({ status: 'dead', attempts: 6, last_error: 'PUSH_FAILED' });
      expect(alerts.alerts).toEqual([expect.objectContaining({ code: 'JOB_DEAD', details: expect.objectContaining({ kind: 'notify.deliver', deliveryId: n.pushIds[0] }) })]);
    } finally {
      spy.mockRestore();
    }
    // in-app stays the durable record
    const list = await call<{ notifications: { id: string }[] }>(a, 'GET', '/notifications');
    expect(list.body.notifications.map((x) => x.id)).toContain(n.id);
  });

  it('an expired subscription (410) is revoked and never tried again', async () => {
    const a = w.agents[0]!;
    const deps = deliveryDeps(h);
    const sub = await call(a, 'POST', '/push-subscriptions', { endpoint: `https://push.example.test/sub/gone-${randomUUID()}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } });
    expect(sub.status).toBe(201);
    const n = await notification(a, 'task_due');
    const spy = vi.spyOn(h.providers.push, 'deliverPush').mockResolvedValue({ status: 'gone' });
    try {
      const outs = [];
      for (const d of n.pushIds) outs.push(await deliverNotification(d, deps, w.tenantId));
      expect(outs.every((o) => o.kind === 'failed')).toBe(true);
    } finally {
      spy.mockRestore();
    }
    const live = await h.su.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 AND revoked_at IS NULL', [a.userId]);
    expect(live.rows).toHaveLength(0);
    // re-register for the remaining tests
    expect((await call(a, 'POST', '/push-subscriptions', { endpoint: `https://push.example.test/sub/${randomUUID()}`, keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' } })).status).toBe(201);
  });

  it('lock-screen payloads hold no phone number, email address or message body (snapshot)', async () => {
    const payloads = NOTIFICATION_KINDS.map((kind) =>
      lockScreenPayload({ id: '0190f5a0-0000-7000-8000-000000000001', kind, title: 'Jane D. (+1 415 555 0123, jane.doe@example.com) replied', subjectType: 'contact', subjectId: '0190f5a0-0000-7000-8000-000000000002', tenant: { id: '0190f5a0-0000-7000-8000-0000000000aa', slug: 'harbor' } }),
    );
    const text = JSON.stringify(payloads);
    expect(text).not.toMatch(/@example\.com|415 555 0123|\+14155550123/);
    // the body is a fixed sentence per kind: a notification's own body (which may quote a client) never reaches the lock screen
    expect(lockScreenPayload.length).toBe(1);
    for (const p of payloads) expect(p.body).toMatch(/^[A-Z][a-z ,.-]+\.$/);
    expect(payloads).toMatchSnapshot();
    // and what actually reached the (fake) push provider in this file
    // (UUIDs in url/tag are removed first: a random UUID can hold 10+ consecutive digits)
    const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
    for (const p of h.providers.push.delivered) expect(JSON.stringify(p.payload).replace(uuid, '<id>')).not.toMatch(/\+?1?\d{10}|@/);
  });

  it('email alerts have no staff outbound path in Phase 1: closed honestly as suppressed', async () => {
    const a = w.agents[0]!;
    const n = await notification(a, 'system');
    const d = randomUUID();
    await h.su.query(`INSERT INTO notification_deliveries (tenant_id, id, notification_id, channel, target_ref, status, next_attempt_at) VALUES ($1,$2,$3,'email','account_email','pending',now())`, [w.tenantId, d, n.id]);
    expect(await deliverNotification(d, deliveryDeps(h), w.tenantId)).toEqual({ kind: 'suppressed', reason: 'EMAIL_ALERTS_UNAVAILABLE' });
    expect(h.providers.email.sent.some((m) => m.idempotencyKey === d)).toBe(false);
  });

  it('a critical lead offer reaches a verified alert phone by SMS through the send-time gate (canContact recipient = user)', async () => {
    const a = w.agents[1]!;
    const phone = '+18435550188';
    const r = await a.post('/api/me/alert-phone', { phone });
    const { challenge } = r.json() as { challenge: string };
    const sent = h.providers.telephony.verificationCodes.at(-1)!;
    expect((await a.post('/api/me/alert-phone/verify', { challenge, code: sent.code })).statusCode).toBe(200);
    // route leads until one is offered to this agent
    let deliveryId: string | undefined;
    for (let i = 0; i < 4 && !deliveryId; i++) {
      const { contactId } = await intake(h, w);
      const c = await contactState(h, contactId);
      if (c.offered_to_user_id !== a.userId) continue;
      deliveryId = (await h.su.query<{ id: string }>("SELECT d.id FROM notification_deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.user_id = $1 AND n.kind = 'lead_offer' AND d.channel = 'sms' AND n.subject_id = $2", [a.userId, contactId])).rows[0]?.id;
    }
    expect(deliveryId).toBeDefined();
    const before = h.providers.telephony.sms.length;
    expect(await deliverNotification(deliveryId!, deliveryDeps(h), w.tenantId)).toEqual({ kind: 'sent' });
    const sms = h.providers.telephony.sms.slice(before);
    expect(sms.map((m) => m.to)).toEqual([phone]);
    expect(sms[0]!.body).not.toMatch(/\+?1?\d{10}|@/);
    const row = await delivery(deliveryId!);
    expect(row.status).toBe('sent');
    expect(row.gate_decision_id).toBeNull(); // allowed: only a blocked delivery writes a gate decision (0013)
  });
});

describe('the in-app list', () => {
  it('lists only the caller’s own notifications (even for an Owner) and marks them read', async () => {
    const a = w.agents[0]!;
    const n1 = await notification(a, 'task_due', { title: 'A task is due' });
    const n2 = await notification(a, 'pond_new', { title: 'New pond lead' });
    const mine = await call<{ notifications: { id: string; readAt: string | null }[]; unread: number }>(a, 'GET', '/notifications?unread=true');
    expect(mine.body.notifications.map((x) => x.id)).toEqual(expect.arrayContaining([n1.id, n2.id]));
    const owner = await call<{ notifications: { id: string }[] }>(w.owner, 'GET', '/notifications');
    expect(owner.body.notifications.map((x) => x.id)).not.toContain(n1.id);
    const r = await call<{ marked: number; unread: number }>(a, 'POST', '/notifications/read', { ids: [n1.id] });
    expect(r.body.marked).toBe(1);
    expect(r.body.unread).toBe(mine.body.unread - 1);
    // marking someone else's is a no-op, never an error that reveals it exists
    expect((await call<{ marked: number }>(w.owner, 'POST', '/notifications/read', { ids: [n2.id] })).body.marked).toBe(0);
    expect((await call<{ marked: number; unread: number }>(a, 'POST', '/notifications/read', { all: true })).body.unread).toBe(0);
    expect((await call(a, 'POST', '/notifications/read', {})).code).toBe('VALIDATION_FAILED');
  });
});

describe('the notify.deliver job', () => {
  it('lead intake → offer push delivered through sweeper + worker: p95 under 2 s (fake provider, immediate sweep)', async () => {
    const registry = new HandlerRegistry().registerAll(makeNotificationHandlers(() => deliveryDeps(h)) as never);
    const sweeper = createSweeper({ db: h.database, registry, log: memoryLogger(), alerts: memoryAlerts() });
    const worker = createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime'], concurrency: 2, worker: `ws-test-${randomUUID().slice(0, 8)}`, idleMs: 5, log: silentLogger });
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const { contactId } = await intake(h, w);
      await sweeper.sweepOnce();
      await worker.drain(10);
      const n = (await h.su.query<{ id: string }>("SELECT id FROM notifications WHERE kind = 'lead_offer' AND subject_id = $1", [contactId])).rows[0]!;
      expect(pushesTo(n.id).length).toBeGreaterThanOrEqual(1);
      times.push(performance.now() - t0);
    }
    times.sort((x, y) => x - y);
    const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
    expect(p95).toBeLessThan(2000);
  });
});
