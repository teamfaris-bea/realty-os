// The System page API: Owner/Admin only, plain-language job reasons, audited retry/cancel that stays
// inside the tenant, stuck messages with their reconcile state (never bodies or addresses), late
// ownership timers from the ledger, provider health.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestClient } from '../auth/testHarness.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import { type CommsWorld, commsWorld, ownedContact, runJobs, sendText } from '../comms/testing.js';
import { explainJobError, reconcileState } from './explain.js';

let h: ApiHarness;
let w: CommsWorld;
let other: CommsWorld;
let admin: TestClient;

interface Job {
  id: string;
  kind: string;
  kindLabel: string;
  state: string;
  reason: { code: string; sentence: string; retryHelps: boolean };
  detail: string | null;
  canRetry: boolean;
  canCancel: boolean;
}
interface Overview {
  jobs: { counts: { dead: number; retrying: number }; dead: Job[]; retrying: Job[] };
  messages: { id: string; contactId: string; channel: string; status: string; reconcile: { state: string; sentence: string } }[];
  timers: { fired: number; lateCount: number; late: { contactId: string; kind: string; lateSeconds: number }[] };
  connections: unknown[];
  registrations: { kind: string; status: string }[];
  channels: { channel: string; sent: number; failed: number }[];
}

async function seedJob(tenantId: string, o: { status: 'dead' | 'retrying'; kind?: string; error?: string; dedupe?: string }): Promise<string> {
  const r = await h.su.query<{ id: string }>(
    `INSERT INTO jobs (tenant_id, queue, kind, payload, run_at, status, attempts, max_attempts, last_error, finished_at, dedupe_key)
     VALUES ($1, 'realtime', $2, '{}', now() + interval '10 minutes', $3, $4, 10, $5, $6, $7) RETURNING id`,
    [tenantId, o.kind ?? 'comms.dispatch', o.status === 'dead' ? 'dead' : 'pending', o.status === 'dead' ? 10 : 3, o.error ?? 'LEASE_EXPIRED', o.status === 'dead' ? new Date() : null, o.dedupe ?? null],
  );
  return r.rows[0]!.id;
}
const jobStatus = async (id: string) => (await h.su.query<{ status: string; attempts: number }>('SELECT status, attempts FROM jobs WHERE id = $1', [id])).rows[0]!;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h);
  other = await commsWorld(h);
  admin = await h.invite(w.owner, 'admin');
});
afterAll(async () => {
  await h?.close();
});

describe('System page access', () => {
  it('Owner and Admin read the overview; Team Leads, agents and signed-out callers get 404 / 401', async () => {
    expect((await call(w.owner, 'GET', '/system/overview')).status).toBe(200);
    expect((await call(admin, 'GET', '/system/overview')).status).toBe(200);
    const agent = await call<{ error: { code: string } }>(w.agents[0]!, 'GET', '/system/overview');
    expect(agent.status).toBe(404);
    expect(agent.body.error.code).toBe('NOT_FOUND');
    expect((await call(w.agents[0]!, 'POST', '/system/jobs/1/retry')).status).toBe(404);
    expect((await h.client().get('/api/system/overview')).statusCode).toBe(401);
  });
});

describe('failed and dead jobs', () => {
  it('lists the tenant\'s dead and retrying jobs with plain-language reasons, never another tenant\'s', async () => {
    const dead = await seedJob(w.tenantId, { status: 'dead', kind: 'ownership.offer_expiry', error: 'LEASE_EXPIRED' });
    const retrying = await seedJob(w.tenantId, { status: 'retrying', error: 'error:40001' });
    const foreign = await seedJob(other.tenantId, { status: 'dead' });
    const r = await call<Overview>(w.owner, 'GET', '/system/overview');
    const d = r.body.jobs.dead.find((j) => j.id === dead)!;
    expect(d).toMatchObject({ kind: 'ownership.offer_expiry', kindLabel: 'Lead offer timer', state: 'dead', canRetry: true, canCancel: false, reason: { code: 'LEASE_EXPIRED', retryHelps: true } });
    expect(d.reason.sentence).toMatch(/worker stopped/);
    const t = r.body.jobs.retrying.find((j) => j.id === retrying)!;
    expect(t).toMatchObject({ state: 'retrying', canCancel: true, reason: { code: 'DB_40001' } });
    expect(r.body.jobs.counts.dead).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(r.body)).not.toContain(`"id":"${foreign}"`);
  });

  it('retry puts a dead job back in the queue and writes an audit row (ids and codes only)', async () => {
    const dead = await seedJob(w.tenantId, { status: 'dead', kind: 'notify.deliver', error: 'NO_HANDLER' });
    const r = await call<{ result: string; job: Job | null }>(admin, 'POST', `/system/jobs/${dead}/retry`);
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('retried');
    expect(await jobStatus(dead)).toEqual({ status: 'pending', attempts: 0 });
    const a = await h.su.query<{ action: string; actor_user_id: string; changes: Record<string, unknown> }>(`SELECT action, actor_user_id, changes FROM audit_log WHERE tenant_id = $1 AND action = 'job.retried' ORDER BY seq DESC LIMIT 1`, [w.tenantId]);
    expect(a.rows[0]).toMatchObject({ action: 'job.retried', actor_user_id: admin.userId });
    expect(a.rows[0]!.changes).toMatchObject({ job_id: { to: dead }, job_kind: { to: 'notify.deliver' }, previous_status: { to: 'dead' } });
  });

  it('cancel stops a waiting job (audited); a dead job cannot be cancelled and a second retry is refused honestly', async () => {
    const retrying = await seedJob(w.tenantId, { status: 'retrying' });
    const c = await call<{ result: string }>(w.owner, 'POST', `/system/jobs/${retrying}/cancel`);
    expect(c.status).toBe(200);
    expect((await jobStatus(retrying)).status).toBe('cancelled');
    expect((await h.su.query(`SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'job.cancelled'`, [w.tenantId])).rowCount).toBeGreaterThanOrEqual(1);
    expect((await call<{ error: { code: string } }>(w.owner, 'POST', `/system/jobs/${retrying}/retry`)).body.error.code).toBe('NOT_FOUND');
    const dead = await seedJob(w.tenantId, { status: 'dead' });
    expect((await call<{ error: { code: string } }>(w.owner, 'POST', `/system/jobs/${dead}/cancel`)).body.error.code).toBe('JOB_NOT_CANCELLABLE');
  });

  it('retrying a dead job whose work is already queued again is refused (JOB_ALREADY_QUEUED)', async () => {
    const key = `system-test:${Date.now()}`;
    const dead = await seedJob(w.tenantId, { status: 'dead', dedupe: key });
    await seedJob(w.tenantId, { status: 'retrying', dedupe: key });
    const r = await call<{ error: { code: string } }>(w.owner, 'POST', `/system/jobs/${dead}/retry`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('JOB_ALREADY_QUEUED');
  });

  it('another tenant\'s job id is 404 for retry and cancel, and stays untouched', async () => {
    const foreign = await seedJob(other.tenantId, { status: 'dead' });
    expect((await call(w.owner, 'POST', `/system/jobs/${foreign}/retry`)).status).toBe(404);
    expect((await call(w.owner, 'POST', `/system/jobs/${foreign}/cancel`)).status).toBe(404);
    expect((await jobStatus(foreign)).status).toBe('dead');
    expect((await call(w.owner, 'POST', '/system/jobs/not-a-number/retry')).status).toBe(422);
  });
});

describe('stuck messages, late timers and provider health', () => {
  it('a message stuck in dispatch_unknown shows its reconcile state, never its body or recipient', async () => {
    const c = await ownedContact(w.agents[0]!);
    const s = await sendText(w.agents[0]!, c.id, 'Private details about 12 Elm Street');
    const id = s.body.message!.id;
    await h.su.query(`UPDATE messages SET status = 'dispatch_unknown', dispatched_at = now() - interval '3 minutes' WHERE id = $1`, [id]);
    const r = await call<Overview>(w.owner, 'GET', '/system/overview');
    const m = r.body.messages.find((x) => x.id === id)!;
    expect(m).toMatchObject({ contactId: c.id, channel: 'sms', status: 'dispatch_unknown', reconcile: { state: 'checking_provider' } });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain('Elm Street');
    expect(text).not.toContain(c.phone);
    expect(text).not.toContain(c.phone.slice(-10));
    expect(text).not.toContain(c.email);
  });

  it('provider health counts the last hour\'s outbound results per channel; the 10DLC registration status shows', async () => {
    const c = await ownedContact(w.agents[0]!);
    await sendText(w.agents[0]!, c.id, 'Hello there');
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const r = await call<Overview>(w.owner, 'GET', '/system/overview');
    expect(r.body.channels.find((x) => x.channel === 'sms')!.sent).toBeGreaterThanOrEqual(1);
    expect(r.body.registrations.map((g) => g.kind)).toContain('a2p_campaign');
  });

  it('late ownership timers come from the ledger (offer expired 3 min after its deadline)', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const offerId = '0190d3c2-7b1a-7c3e-9f00-00000000aa01';
    const ev = `INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, offer_id, offered_to_user_id, deadline_at, actor_kind, reason_code, command_id, payload, occurred_at)`;
    const cl = await h.su.connect();
    try {
      await cl.query('BEGIN');
      await cl.query('SET LOCAL session_replication_role = replica');
      const seq = Number((await cl.query<{ s: string }>('SELECT max(seq) AS s FROM lead_ownership_events WHERE contact_id = $1', [c.id])).rows[0]!.s);
      await cl.query(`${ev} VALUES ($1, $2, $3, gen_random_uuid(), 'offered', 'owned', 'offered', NULL, $4, $5, now() - interval '4 minutes', 'system', 'ROUTED', gen_random_uuid(), '{}', now() - interval '10 minutes')`, [w.tenantId, c.id, seq + 1, offerId, w.agents[0]!.userId]);
      await cl.query(`${ev} VALUES ($1, $2, $3, gen_random_uuid(), 'offer_expired', 'offered', 'unassigned', NULL, $4, NULL, NULL, 'timer', 'OFFER_EXPIRED', gen_random_uuid(), '{}', now() - interval '1 minute')`, [w.tenantId, c.id, seq + 2, offerId]);
      await cl.query('COMMIT');
    } finally {
      cl.release();
    }
    const r = await call<Overview>(w.owner, 'GET', '/system/overview');
    const t = r.body.timers.late.find((x) => x.contactId === c.id)!;
    expect(t.kind).toBe('offer_expired');
    expect(t.lateSeconds).toBeGreaterThanOrEqual(175);
    expect(t.lateSeconds).toBeLessThanOrEqual(185);
    expect(r.body.timers.lateCount).toBeGreaterThanOrEqual(1);
    expect((await call<Overview>(other.owner, 'GET', '/system/overview')).body.timers.late).toEqual([]);
  });
});

describe('plain-language explanations', () => {
  it('maps the stored error codes to sentences, and says when a retry will not help', () => {
    expect(explainJobError('NO_HANDLER').retryHelps).toBe(false);
    expect(explainJobError('PAYLOAD_INVALID: payload rejected by the handler schema (R-TEN-7)')).toMatchObject({ code: 'PAYLOAD_INVALID', retryHelps: false });
    expect(explainJobError('error:57014')).toMatchObject({ code: 'DB_TIMEOUT' });
    expect(explainJobError('error:23505 constraint=x')).toMatchObject({ code: 'DB_23505', retryHelps: false });
    expect(explainJobError('TypeError: fetch failed')).toMatchObject({ code: 'CONNECTION' });
    expect(explainJobError('Error: something odd')).toMatchObject({ code: 'UNEXPECTED' });
  });

  it('reconcile states follow the dispatch timeline (20 min stale, 10 min provider lookup)', () => {
    const now = new Date('2026-11-11T12:00:00Z');
    const ago = (m: number) => new Date(now.getTime() - m * 60_000);
    expect(reconcileState('dispatching', ago(1), now).state).toBe('sending');
    expect(reconcileState('dispatching', ago(25), now).state).toBe('awaiting_recovery');
    expect(reconcileState('dispatch_unknown', ago(3), now).state).toBe('checking_provider');
    expect(reconcileState('dispatch_unknown', ago(12), now).state).toBe('unresolved');
  });
});
