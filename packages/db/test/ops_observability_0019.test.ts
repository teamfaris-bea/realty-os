// Migration 0019 (lane ops-observability): platform-wide aggregates for the metrics exporter, the
// tenant-scoped System-page views, and the Owner/Admin job commands (retry, cancel). Every property is
// asserted as app_user; the superuser pool only seeds what has no application path (dead / failing job
// rows, ledger rows with chosen instants) and reads state back.
import type { ContactId, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enqueue } from '../src/jobs.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, type Member, PH, selfCreated, suFixture, suRows, uuid, type World } from './world.js';

let h: Harness;
let a: World;
let b: World;
let admin: Member;

beforeAll(async () => {
  h = await createHarness(8);
  a = await createWorld(h.app, { agents: 2 });
  b = await createWorld(h.app, { agents: 1 });
  const m = a.agents[1]!;
  await withTenantTx(a.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${m.id}`.execute(tx), { db: h.app });
  admin = { id: m.id, role: 'admin', actor: { ...m.actor, role: 'admin' } };
});
afterAll(async () => {
  await h?.close();
});

type Actor = Parameters<typeof withTenantTx>[0];
const rows = <T>(actor: Actor, q: ReturnType<typeof sql<T>>) => withTenantTx(actor, async (tx) => (await q.execute(tx)).rows, { db: h.app });
const platform = <T>(q: ReturnType<typeof sql<T>>) => withPreTenant(async (tx) => (await q.execute(tx)).rows, { db: h.app });

async function newJob(w: World, o: { kind?: string; dedupeKey?: string } = {}): Promise<string> {
  const kind = o.kind ?? 'test.ops';
  const ref = uuid();
  await withTenantTx(w.system(), (tx) => enqueue(tx, { queue: 'default', kind, payload: { ref }, ...(o.dedupeKey ? { dedupeKey: o.dedupeKey } : {}) }), { db: h.app });
  const [j] = await suRows<{ id: string }>(h.su, `SELECT id FROM jobs WHERE payload->>'ref' = $1`, [ref]);
  return j!.id;
}
const makeDead = (id: string) => h.su.query(`UPDATE jobs SET status = 'dead', attempts = max_attempts, finished_at = now(), last_error = 'LEASE_EXPIRED' WHERE id = $1`, [id]);
const makeRetrying = (id: string) => h.su.query(`UPDATE jobs SET attempts = 2, run_at = now() + interval '1 hour', last_error = 'Error:40001' WHERE id = $1`, [id]);
const jobRow = async (id: string) => (await suRows<{ status: string; attempts: number; run_at: Date; finished_at: Date | null }>(h.su, 'SELECT status, attempts, run_at, finished_at FROM jobs WHERE id = $1', [id]))[0]!;

describe('0019 tenant job views and commands (System page)', () => {
  it('Owner and Admin see their tenant\'s dead and retrying jobs (codes only); an agent and the other tenant see none', async () => {
    const dead = await newJob(a);
    const retrying = await newJob(a);
    const other = await newJob(b);
    await makeDead(dead);
    await makeRetrying(retrying);
    await makeDead(other);
    for (const m of [a.owner, admin]) {
      const d = await rows<{ id: string; kind: string; last_error: string }>(m.actor, sql`SELECT * FROM app.ops_tenant_jobs('dead', 50)`);
      expect(d.map((r) => r.id)).toContain(dead);
      expect(d.map((r) => r.id)).not.toContain(other);
      const r = await rows<{ id: string }>(m.actor, sql`SELECT * FROM app.ops_tenant_jobs('retrying', 50)`);
      expect(r.map((x) => x.id)).toContain(retrying);
      const [c] = await rows<{ dead_7d: string; retrying: string }>(m.actor, sql`SELECT * FROM app.ops_tenant_job_counts()`);
      expect(Number(c!.dead_7d)).toBeGreaterThanOrEqual(1);
      expect(Number(c!.retrying)).toBeGreaterThanOrEqual(1);
    }
    expect(await rows(a.agents[0]!.actor, sql`SELECT * FROM app.ops_tenant_jobs('dead', 50)`)).toEqual([]);
    expect(await rows(a.system(), sql`SELECT * FROM app.ops_tenant_jobs('dead', 50)`)).toEqual([]);
    expect(await rows(b.owner.actor, sql`SELECT * FROM app.ops_tenant_jobs('dead', 50)`).then((x) => (x as { id: string }[]).map((r) => r.id))).toEqual([other]);
  });

  it('a support actor (read-only grant) sees no jobs and cannot run a command', async () => {
    const supportUserId = uuid() as UserId;
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`s-${uuid()}@platform.test`}, 'Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
    const grantId = uuid();
    await withTenantTx(a.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${a.tenantId}, ${grantId}, ${supportUserId}, ${a.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx), { db: h.app });
    const support: SupportActor = { kind: 'support', userId: supportUserId, tenantId: a.tenantId as TenantId, grantId };
    const dead = await newJob(a);
    await makeDead(dead);
    expect(await rows(support, sql`SELECT * FROM app.ops_tenant_jobs('dead', 50)`)).toEqual([]);
    expect(await rows<{ r: string }>(support, sql`SELECT app.ops_retry_job(${dead}::bigint) AS r`)).toEqual([{ r: 'not_found' }]);
    expect((await jobRow(dead)).status).toBe('dead');
  });

  it('retry: a dead job goes back to pending, due now, with its attempts reset; a retrying job becomes due now', async () => {
    const dead = await newJob(a);
    await makeDead(dead);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_retry_job(${dead}::bigint) AS r`)).toEqual([{ r: 'retried' }]);
    const d = await jobRow(dead);
    expect(d).toMatchObject({ status: 'pending', attempts: 0, finished_at: null });
    expect(d.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const retrying = await newJob(a);
    await makeRetrying(retrying);
    expect(await rows<{ r: string }>(admin.actor, sql`SELECT app.ops_retry_job(${retrying}::bigint) AS r`)).toEqual([{ r: 'retried' }]);
    const r = await jobRow(retrying);
    expect(r).toMatchObject({ status: 'pending', attempts: 2 });
    expect(r.run_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('retry refuses a dead job whose dedupe key a live job already holds, and anything not dead or retrying', async () => {
    const key = `ops:${uuid()}`;
    const first = await newJob(a, { dedupeKey: key });
    await makeDead(first);
    await newJob(a, { dedupeKey: key }); // the live successor
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_retry_job(${first}::bigint) AS r`)).toEqual([{ r: 'duplicate_live' }]);
    expect((await jobRow(first)).status).toBe('dead');
    const fresh = await newJob(a);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_retry_job(${fresh}::bigint) AS r`)).toEqual([{ r: 'not_retryable' }]);
  });

  it('retry and cancel never reach another tenant\'s job or work for an agent (not_found)', async () => {
    const other = await newJob(b);
    await makeDead(other);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_retry_job(${other}::bigint) AS r`)).toEqual([{ r: 'not_found' }]);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_cancel_job(${other}::bigint) AS r`)).toEqual([{ r: 'not_found' }]);
    const mine = await newJob(a);
    expect(await rows<{ r: string }>(a.agents[0]!.actor, sql`SELECT app.ops_cancel_job(${mine}::bigint) AS r`)).toEqual([{ r: 'not_found' }]);
    expect((await jobRow(other)).status).toBe('dead');
    expect((await jobRow(mine)).status).toBe('pending');
  });

  it('cancel: a waiting job is cancelled; a running or finished job is not', async () => {
    const waiting = await newJob(a);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_cancel_job(${waiting}::bigint) AS r`)).toEqual([{ r: 'cancelled' }]);
    expect((await jobRow(waiting)).status).toBe('cancelled');
    const running = await newJob(a);
    await h.su.query(`UPDATE jobs SET status = 'running', locked_by = 'w', locked_until = now() + interval '5 minutes', attempts = 1 WHERE id = $1`, [running]);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_cancel_job(${running}::bigint) AS r`)).toEqual([{ r: 'not_cancellable' }]);
    expect(await rows<{ r: string }>(a.owner.actor, sql`SELECT app.ops_cancel_job(${waiting}::bigint) AS r`)).toEqual([{ r: 'not_cancellable' }]);
  });
});

describe('0019 platform aggregates (metrics)', () => {
  it('queue, message, dispatch, timer and tenant aggregates answer only without tenant or user context', async () => {
    const id = await newJob(a, { kind: 'test.ops_stats' });
    await makeRetrying(id);
    const q = await platform<{ queue: string; kind: string; retrying: string; scheduled: string }>(sql`SELECT * FROM app.ops_queue_stats()`);
    expect(q.find((r) => r.kind === 'test.ops_stats')).toMatchObject({ queue: 'default' });
    expect(Number(q.find((r) => r.kind === 'test.ops_stats')!.retrying)).toBeGreaterThanOrEqual(1);
    expect(Number((await platform<{ n: number }>(sql`SELECT app.ops_tenant_count() AS n`))[0]!.n)).toBeGreaterThanOrEqual(2);
    await expect(platform(sql`SELECT * FROM app.ops_message_stats()`)).resolves.toBeInstanceOf(Array);
    await expect(platform(sql`SELECT * FROM app.ops_dispatch_results(now() - interval '1 hour')`)).resolves.toBeInstanceOf(Array);
    // with a tenant context (any actor) every platform aggregate is empty
    for (const actor of [a.owner.actor, a.system()]) {
      expect(await rows(actor, sql`SELECT * FROM app.ops_queue_stats()`)).toEqual([]);
      expect(await rows(actor, sql`SELECT * FROM app.ops_message_stats()`)).toEqual([]);
      expect(await rows(actor, sql`SELECT * FROM app.ops_dispatch_results(now() - interval '1 hour')`)).toEqual([]);
      expect(await rows(actor, sql`SELECT * FROM app.ops_timer_lateness(now() - interval '1 hour')`)).toEqual([]);
      expect(await rows<{ n: number | null }>(actor, sql`SELECT app.ops_tenant_count() AS n`)).toEqual([{ n: 0 }]);
    }
  });

  it('labels are bounded: free text becomes OTHER, empty becomes none', async () => {
    const r = await platform<{ a: string; b: string; c: string; d: string }>(sql`SELECT app.ops_label('30007') AS a, app.ops_label('pat@example.com said hi') AS b, app.ops_label(NULL) AS c, app.ops_label('OPTED_OUT') AS d`);
    expect(r[0]).toEqual({ a: '30007', b: 'OTHER', c: 'none', d: 'OPTED_OUT' });
  });
});

describe('0019 timer lateness from the ownership ledger', () => {
  let offered: ContactId;
  let owned: ContactId;
  beforeAll(async () => {
    // ledger rows with chosen instants (no application path sets past deadlines): an offer that expired
    // 30 s late, and an SLA period whose first-touch breach fired 180 s late and auto-release 120 s late
    offered = await selfCreated(h.app, a, a.agents[0]!, 'Offer Lead');
    owned = await selfCreated(h.app, a, a.agents[0]!, 'Owned Lead');
    const offerId = uuid();
    const ag = a.agents[0]!.id;
    const ev = `INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, offer_id, offered_to_user_id, pond_id, deadline_at, actor_kind, reason_code, command_id, payload, occurred_at)`;
    await suFixture(
      h.su,
      `${ev} VALUES ($1, $2, 2, $3, 'offered', 'owned', 'offered', NULL, $4, $5, NULL, now() - interval '90 seconds', 'system', 'ROUTED', $6, '{}', now() - interval '10 minutes');
       ${ev} VALUES ($1, $2, 3, $7, 'offer_expired', 'offered', 'unassigned', NULL, $4, NULL, NULL, NULL, 'timer', 'OFFER_EXPIRED', $8, '{}', now() - interval '60 seconds');`,
      [a.tenantId, offered, uuid(), offerId, ag, uuid(), uuid(), uuid()],
    );
    const releaseMs = Date.now() - 2 * 60_000 - 5 * 60_000;
    await suFixture(
      h.su,
      `${ev} VALUES ($1, $2, 2, $3, 'claimed', 'owned', 'owned', $4, NULL, NULL, NULL, now() - interval '8 minutes', 'system', 'CLAIMED', $5, '{"releaseDueAt": ${releaseMs}}', now() - interval '20 minutes');
       ${ev} VALUES ($1, $2, 3, $6, 'first_touch_breached', 'owned', 'owned', $4, NULL, NULL, NULL, NULL, 'timer', 'FIRST_TOUCH_BREACHED', $7, '{}', now() - interval '5 minutes');
       ${ev} VALUES ($1, $2, 4, $8, 'auto_released', 'owned', 'in_pond', NULL, NULL, NULL, $9, NULL, 'timer', 'FIRST_TOUCH_MISSED', $10, '{}', now() - interval '5 minutes');`,
      [a.tenantId, owned, uuid(), ag, uuid(), uuid(), uuid(), uuid(), a.pondId, uuid()],
    );
  });

  it('due instants come from the ledger: offer expiry, first-touch SLA and auto-release lateness (platform aggregate)', async () => {
    const t = await platform<{ kind: string; fired: string; late_60s: string; p95_seconds: number; max_seconds: number }>(sql`SELECT * FROM app.ops_timer_lateness(now() - interval '1 hour')`);
    const by = Object.fromEntries(t.map((r) => [r.kind, r]));
    expect(Number(by.offer_expired!.fired)).toBe(1);
    expect(by.offer_expired!.max_seconds).toBeCloseTo(30, 0);
    expect(Number(by.offer_expired!.late_60s)).toBe(0);
    expect(by.first_touch_breached!.max_seconds).toBeCloseTo(180, 0);
    expect(Number(by.first_touch_breached!.late_60s)).toBe(1);
    expect(by.auto_released!.max_seconds).toBeGreaterThan(110);
    expect(by.auto_released!.max_seconds).toBeLessThan(130);
  });

  it('the tenant view (app_user under RLS) lists the tenant\'s own fired timers only', async () => {
    const mine = await rows<{ contact_id: string; type: string }>(a.owner.actor, sql`SELECT * FROM app.ops_fired_timers(now() - interval '1 hour')`);
    expect(mine.map((r) => `${r.contact_id}:${r.type}`).sort()).toEqual([`${offered}:offer_expired`, `${owned}:auto_released`, `${owned}:first_touch_breached`].sort());
    expect(await rows(b.owner.actor, sql`SELECT * FROM app.ops_fired_timers(now() - interval '1 hour')`)).toEqual([]);
  });
});
