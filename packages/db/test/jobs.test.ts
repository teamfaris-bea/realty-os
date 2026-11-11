// The Postgres job queue through app_user: enqueue in the domain tx, definer claim/finish/reap/cancel.
import type { Instant } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertNoPiiInPayload, cancel, claim, enqueue, enqueueAll, finish, JobPayloadError, reap, scrubError } from '../src/jobs.js';
import { withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, suRows, uuid, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
beforeAll(async () => {
  h = await createHarness(12);
  a = await createWorld(h.app, { agents: 1 });
  b = await createWorld(h.app, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const queueOf = async (kind: string) => suRows<{ id: string; tenant_id: string; status: string; attempts: number; run_at: Date; last_error: string | null }>(h.su, `SELECT id, tenant_id, status, attempts, run_at, last_error FROM jobs WHERE kind = $1 ORDER BY id`, [kind]);

describe('jobs', () => {
  it('enqueue is part of the domain transaction (outbox): a rollback leaves no job; the tenant comes from the context', async () => {
    await expect(
      withTenantTx(a.system(), async (tx) => {
        await enqueue(tx, { queue: 'default', kind: 'test.rollback', payload: { ref: uuid() } });
        throw new Error('boom');
      }, { db: h.app }),
    ).rejects.toThrow('boom');
    expect(await queueOf('test.rollback')).toEqual([]);
    await withTenantTx(a.owner.actor, (tx) => enqueue(tx, { queue: 'default', kind: 'test.context', payload: {} }), { db: h.app });
    expect((await queueOf('test.context')).map((j) => j.tenant_id)).toEqual([a.tenantId]);
  });

  it('a live dedupe key makes enqueue a no-op (per tenant); app_user cannot read the queue', async () => {
    const key = `dedupe:${uuid()}`;
    const r1 = await withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'default', kind: 'test.dedupe', payload: {}, dedupeKey: key }), { db: h.app });
    const r2 = await withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'default', kind: 'test.dedupe', payload: {}, dedupeKey: key }), { db: h.app });
    const rb = await withTenantTx(b.system(), (tx) => enqueue(tx, { queue: 'default', kind: 'test.dedupe', payload: {}, dedupeKey: key }), { db: h.app });
    expect([r1, r2, rb]).toEqual([true, false, true]);
    await expect(withTenantTx(a.owner.actor, (tx) => sql`SELECT * FROM jobs`.execute(tx), { db: h.app })).rejects.toThrow(/permission denied/);
  });

  it('R-TEN-6: two workers claim concurrently with SKIP LOCKED: disjoint jobs, each tagged with its single tenant', async () => {
    for (const w of [a, b]) {
      await withTenantTx(w.system(), async (tx) => {
        for (let i = 0; i < 10; i++) await enqueue(tx, { queue: 'bulk', kind: 'test.claim', payload: { i } });
      }, { db: h.app });
    }
    const [x, y] = await Promise.all([claim(['bulk'], 'w1', 15, { db: h.app }), claim(['bulk'], 'w2', 15, { db: h.app })]);
    const ids = [...x, ...y].map((j) => j.id);
    expect(new Set(ids).size).toBe(20);
    expect(ids.length).toBe(20);
    for (const j of [...x, ...y]) expect([a.tenantId, b.tenantId]).toContain(j.tenantId);
    for (const j of x) await finish(j.id, 'w1', { ok: true }, { db: h.app });
    // the wrong worker cannot finish someone else's lease
    await finish(y[0]!.id, 'w1', { ok: true }, { db: h.app });
    expect((await queueOf('test.claim')).filter((j) => j.status === 'running')).toHaveLength(y.length);
    for (const j of y) await finish(j.id, 'w2', { ok: true }, { db: h.app });
    expect((await queueOf('test.claim')).every((j) => j.status === 'succeeded')).toBe(true);
  });

  it('finish: retry goes back to pending at retryAt with a scrubbed error; no retryAt ⇒ dead; attempts are counted', async () => {
    await withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'maintenance', kind: 'test.retry', payload: {}, maxAttempts: 2 }), { db: h.app });
    const [j1] = await claim(['maintenance'], 'w', 1, { db: h.app });
    const later = (Date.now() + 60_000) as Instant;
    await finish(j1!.id, 'w', { ok: false, error: 'provider said jane@example.com +15555550199 failed', retryAt: later }, { db: h.app });
    const [s1] = await queueOf('test.retry');
    expect(s1!.status).toBe('pending');
    expect(s1!.attempts).toBe(1);
    expect(s1!.last_error).not.toMatch(/jane@|5555550199/);
    expect(Math.abs(s1!.run_at.getTime() - later)).toBeLessThan(1000);
    expect(await claim(['maintenance'], 'w', 1, { db: h.app })).toEqual([]); // not due yet
    await h.su.query(`UPDATE jobs SET run_at = now() WHERE id = $1`, [s1!.id]);
    const [j2] = await claim(['maintenance'], 'w', 1, { db: h.app });
    await finish(j2!.id, 'w', { ok: false, error: 'again', retryAt: later }, { db: h.app });
    expect((await queueOf('test.retry'))[0]!.status).toBe('dead'); // attempts exhausted
  });

  it('cancel works only in the current tenant; reap returns expired leases to pending', async () => {
    const key = `cancel:${uuid()}`;
    await withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'default', kind: 'test.cancel', payload: {}, dedupeKey: key }), { db: h.app });
    expect(await withTenantTx(b.system(), (tx) => cancel(tx, [key]), { db: h.app })).toBe(0);
    expect(await withTenantTx(a.owner.actor, (tx) => cancel(tx, [key]), { db: h.app })).toBe(1);
    expect((await queueOf('test.cancel'))[0]!.status).toBe('cancelled');

    await withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'realtime', kind: 'test.reap', payload: {} }), { db: h.app });
    const [j] = await claim(['realtime'], 'crashed', 1, { leaseSeconds: 1, db: h.app });
    await h.su.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [j!.id.toString()]);
    expect(await reap({ db: h.app })).toBeGreaterThanOrEqual(1);
    const [r] = await queueOf('test.reap');
    expect([r!.status, r!.last_error]).toEqual(['pending', 'LEASE_EXPIRED']);
  });

  it('payload guard: contact PII (emails, phone numbers) is refused; ids, keys and instants pass', async () => {
    expect(() => assertNoPiiInPayload({ contactId: uuid(), dedupe: `ownership.inactivity:${uuid()}:warn:3:1794315899999`, at: 1794315899999 })).not.toThrow();
    expect(() => assertNoPiiInPayload({ to: 'jane@example.com' })).toThrow(JobPayloadError);
    expect(() => assertNoPiiInPayload({ nested: [{ phone: '+15555550100' }] })).toThrow(JobPayloadError);
    expect(() => assertNoPiiInPayload({ phone: '(555) 555-0100' })).toThrow(JobPayloadError);
    await expect(withTenantTx(a.system(), (tx) => enqueue(tx, { queue: 'default', kind: 'test.pii', payload: { email: 'x@y.co' } }), { db: h.app })).rejects.toThrow(JobPayloadError);
    expect(scrubError('x'.repeat(900)).length).toBe(500);
  });

  it('enqueueAll (lane perf-misses) has the outcome of enqueue called per spec in order: one batch when no key is live; with a live key (or two specs sharing one), every spec whose key is free is still inserted, in order, and the transaction stays usable', async () => {
    const ref = uuid();
    const keys = [`all:${ref}:1`, `all:${ref}:2`, `all:${ref}:3`];
    const spec = (k: string, n: number) => ({ queue: 'realtime' as const, kind: 'test.enqueue_all', payload: { ref, n }, dedupeKey: k, runAt: Date.UTC(2030, 0, 1, 0, 0, n) as Instant });
    const rows = async () =>
      suRows<{ dedupe_key: string; n: number; run_at: Date }>(h.su, `SELECT dedupe_key, (payload->>'n')::int AS n, run_at FROM jobs WHERE kind = 'test.enqueue_all' AND payload->>'ref' = $1 ORDER BY id`, [ref]);
    await withTenantTx(a.system(), (tx) => enqueueAll(tx, [spec(keys[0]!, 1), spec(keys[1]!, 2)]), { db: h.app });
    expect((await rows()).map((r) => [r.dedupe_key, r.n])).toEqual([[keys[0], 1], [keys[1], 2]]);
    // keys[1] is live: the batch falls back to one-by-one; keys[2] twice in one batch: only the first lands
    const after = await withTenantTx(a.system(), async (tx) => {
      await enqueueAll(tx, [spec(keys[1]!, 20), spec(keys[2]!, 3), spec(keys[2]!, 30)]);
      return (await sql<{ ok: number }>`SELECT 1 AS ok`.execute(tx)).rows[0]!.ok;
    }, { db: h.app });
    expect(after).toBe(1);
    expect((await rows()).map((r) => [r.dedupe_key, r.n])).toEqual([[keys[0], 1], [keys[1], 2], [keys[2], 3]]);
    expect((await rows())[2]!.run_at.toISOString()).toBe('2030-01-01T00:00:03.000Z');
    // the PII guard applies to every spec before anything is written
    await expect(withTenantTx(a.system(), (tx) => enqueueAll(tx, [spec(`all:${ref}:4`, 4), { ...spec(`all:${ref}:5`, 5), payload: { to: 'jane@example.com' } }]), { db: h.app })).rejects.toThrow(JobPayloadError);
    expect(await rows()).toHaveLength(3);
  });
});
