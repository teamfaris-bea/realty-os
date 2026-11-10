// Registry, payload schemas (R-TEN-7), backoff, cadence helpers and worker CLI parsing.
import { instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { describe, expect, it } from 'vitest';
import { type z } from 'zod';
import { BACKOFF_CAP_MS, retryDelayMs } from './backoff.js';
import { COMMS_DISPATCH, COMMS_RECONCILE, MessagePayload, NOTIFY_DELIVER, PLAYBOOK_STEP, TimerPayload, timerDedupeKey } from './contracts.js';
import { handlers } from './handlers/index.js';
import { FollowupPayloadSchema } from './handlers/followup.js';
import { parseArgs } from './main.js';
import { abortableSleep } from './sleep.js';
import { nextBoundary } from './maintenance.js';
import { jobPayload, zId } from './payload.js';
import { HandlerRegistrationError, HandlerRegistry, PayloadRejectedError, enqueueTyped } from './registry.js';
import type { TxJobHandler } from './types.js';

const C = '0190f5a0-0000-7000-8000-000000000001';
const O = '0190f5a0-0000-7000-8000-000000000002';

const noop = (over: Partial<TxJobHandler<{ id: string }>> = {}): TxJobHandler<{ id: string }> => ({
  kind: 'test.noop',
  queue: 'default',
  schema: jobPayload({ id: zId }),
  run: async () => {},
  ...over,
});

describe('handler registry', () => {
  it('registers the build handler list once per kind, each on a known queue', () => {
    const r = new HandlerRegistry().registerAll(handlers);
    expect(r.kinds()).toEqual(['comms.dispatch_stale', 'consent.drift_check', 'ownership.drift_check', 'ownership.followup', 'storage.blob_delete']);
    expect(r.periodic().map((h) => h.kind).sort()).toEqual(['consent.drift_check', 'ownership.drift_check', 'storage.blob_delete']);
  });

  it('rejects a malformed kind, an unknown queue, a duplicate kind and a contract queue mismatch', () => {
    const r = new HandlerRegistry();
    expect(() => r.register(noop({ kind: 'Bad Kind' as never }))).toThrow(HandlerRegistrationError);
    expect(() => r.register(noop({ queue: 'urgent' as never }))).toThrow(/unknown queue/);
    r.register(noop());
    expect(() => r.register(noop())).toThrow(/already registered/);
    expect(() => r.register(noop({ kind: 'comms.dispatch', queue: 'bulk' }))).toThrow(/sweeper contract/);
  });

  it('rejects a periodic handler whose interval is under 60 s or whose periodic payload fails its schema', () => {
    const r = new HandlerRegistry();
    expect(() => r.register(noop({ kind: 'test.fast', every: { ms: 1000 } }))).toThrow(/≥ 60 s/);
    expect(() => r.register(noop({ kind: 'test.badp', every: { ms: 60_000 } }))).toThrow(/periodicPayload/);
  });
});

describe('R-TEN-7: job payloads hold ids, codes, fences and instants only', () => {
  it('R-TEN-7: every payload schema rejects an unknown (PII-carrying) key', () => {
    expect(TimerPayload.safeParse({ contactId: C, deadline: 'offer_expiry', offerId: O }).success).toBe(true);
    expect(TimerPayload.safeParse({ contactId: C, deadline: 'offer_expiry', offerId: O, name: 'Jane Doe' }).success).toBe(false);
    expect(MessagePayload.safeParse({ messageId: C }).success).toBe(true);
    expect(MessagePayload.safeParse({ messageId: C, body: 'Hi Jane, call me' }).success).toBe(false);
    for (const c of [COMMS_DISPATCH, COMMS_RECONCILE, NOTIFY_DELIVER]) expect(c.schema.safeParse({ messageId: C, deliveryId: C, phone: '+15555550100' }).success).toBe(false);
    expect(PLAYBOOK_STEP.schema.safeParse({ enrollmentId: C, dueAt: 1_700_000_000_000, email: 'jane@example.com' }).success).toBe(false);
    for (const h of handlers) {
      expect(h.schema.safeParse({ ...(h.periodicPayload ?? {}), phone: '+15555550100' }).success, h.kind).toBe(false);
    }
  });

  it('R-TEN-7: a phone number or email inside an allowed field is rejected (ownership.followup effects)', () => {
    const ok = { commandId: C, contactId: C, effects: [{ kind: 'route' }], fanoutNotificationIds: [] };
    expect(FollowupPayloadSchema.safeParse(ok).success).toBe(true);
    expect(FollowupPayloadSchema.safeParse({ ...ok, effects: [{ kind: 'audit', action: 'ownership.release', reason: 'called (555) 555-0100' }] }).success).toBe(false);
    expect(FollowupPayloadSchema.safeParse({ ...ok, effects: [{ kind: 'notify', userId: C, notification: { reasonCode: 'jane@example.com' } }] }).success).toBe(false);
    expect(FollowupPayloadSchema.safeParse({ ...ok, effects: [{ kind: 'sendText', to: C }] }).success).toBe(false);
    expect(FollowupPayloadSchema.safeParse({ ...ok, contactId: 'Jane Doe' }).success).toBe(false);
  });

  it('R-TEN-7: enqueueTyped validates before touching the transaction and never echoes the payload', async () => {
    const tx = new Proxy({}, { get: () => { throw new Error('transaction must not be used'); } }) as unknown as Tx;
    const h = { kind: 'test.noop' as const, queue: 'default' as const, schema: jobPayload({ id: zId }) };
    const err = await enqueueTyped(tx, h, { id: 'jane@example.com' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayloadRejectedError);
    expect(String((err as Error).message)).not.toContain('jane');
  });

  it('timer dedupe keys are exactly core’s, so a sweeper re-issue collides with the original job', () => {
    expect(timerDedupeKey({ contactId: C, deadline: 'offer_expiry', offerId: O })).toBe(`ownership.offer_expiry:${C}:${O}`);
    expect(timerDedupeKey({ contactId: C, deadline: 'auto_release', periodSeq: 3, dueAt: 5 })).toBe(`ownership.auto_release:${C}:3`);
    expect(timerDedupeKey({ contactId: C, deadline: 'inactivity_warn', periodSeq: 3, dueAt: 5 })).toBe(`ownership.inactivity:${C}:warn:3:5`);
  });

  it('the strict-object helper keeps the payload type', () => {
    const s = jobPayload({ id: zId });
    const v: z.infer<typeof s> = s.parse({ id: C });
    expect(v.id).toBe(C);
  });
});

describe('backoff and cadence', () => {
  it('retry delay is jittered exponential within [d/2, d] and capped at 15 min', () => {
    expect(retryDelayMs(1, () => 0)).toBe(2500);
    expect(retryDelayMs(1, () => 1)).toBe(5000);
    expect(retryDelayMs(3, () => 1)).toBe(20_000);
    expect(retryDelayMs(40, () => 1)).toBe(BACKOFF_CAP_MS);
    for (let n = 1; n < 20; n++) {
      const d = retryDelayMs(n, Math.random);
      expect(d).toBeGreaterThanOrEqual(retryDelayMs(n, () => 0));
      expect(d).toBeLessThanOrEqual(retryDelayMs(n, () => 1));
    }
  });

  it('nextBoundary is the first boundary strictly after now', () => {
    const day = 86_400_000;
    const off = 8 * 3_600_000;
    expect(nextBoundary(instant(0), day, off)).toBe(off);
    expect(nextBoundary(instant(off), day, off)).toBe(off + day);
    expect(nextBoundary(instant(off + 1), day, off)).toBe(off + day);
  });

  it('shutdown: a sleep started after the signal aborted returns at once; an abort mid-sleep ends it', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = performance.now();
    await abortableSleep(60_000, ac.signal);
    const ac2 = new AbortController();
    setTimeout(() => ac2.abort(), 20);
    await abortableSleep(60_000, ac2.signal);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('worker CLI arguments are validated', () => {
    expect(parseArgs([])).toEqual({ queues: ['realtime', 'default', 'bulk', 'maintenance'], concurrency: 8, sweeper: true, maintenance: true });
    expect(parseArgs(['--queues', 'realtime', '--concurrency', '3', '--no-sweeper'])).toEqual({ queues: ['realtime'], concurrency: 3, sweeper: false, maintenance: true });
    expect(() => parseArgs(['--queues', 'urgent'])).toThrow();
    expect(() => parseArgs(['--concurrency', '0'])).toThrow();
  });
});
