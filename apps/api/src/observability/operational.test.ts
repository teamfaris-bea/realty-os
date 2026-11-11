// End to end on a real database: HTTP metrics by route template, the database-derived operational view
// (queues, dispatch results incl. an opt-out block, timers, tenant bucket) and the rule that no id,
// phone number, email address or tenant name ever reaches the exposition.
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, ownedContact, runJobs, sendText } from '../comms/testing.js';
import { createFakeProviders } from '../providers/index.js';
import { buildServer } from '../server.js';
import { collectOperational, instrumentPool } from './metrics.js';
import { Registry } from './prometheus.js';

let h: ApiHarness;
let w: CommsWorld;
let sentTo: { id: string; phone: string; email: string };
let optedOut: { id: string; phone: string; email: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h);
  const agent = w.agents[0]!;
  sentTo = await ownedContact(agent);
  const r1 = await sendText(agent, sentTo.id, 'Hi, following up on the house on Elm.');
  expect(r1.status).toBeLessThan(300);
  await runJobs(h, w.tenantId, ['comms.dispatch']);
  optedOut = await ownedContact(agent);
  expect((await inboundSms(h, optedOut.phone, w.mainNumber, 'STOP')).statusCode).toBeLessThan(300);
  const r2 = await sendText(agent, optedOut.id, 'Hi again');
  expect(r2.body.result).toBe('blocked');
});
afterAll(async () => {
  await h?.close();
});

const valueOf = (text: string, line: RegExp) => {
  const m = text.split('\n').find((l) => line.test(l));
  return m ? Number(m.slice(m.lastIndexOf(' ') + 1)) : null;
};

describe('operational metrics from the database', () => {
  it('dispatch results by channel: a sent text and an opt-out block (by reason code)', async () => {
    const r = new Registry();
    collectOperational(r, h.database, { minIntervalMs: 0 });
    const text = await r.render();
    expect(valueOf(text, /^realty_ops_collect_ok /)).toBe(1);
    expect(valueOf(text, /^realty_dispatch_results_window\{channel="sms",reason="none",result="sent"\}/)).toBeGreaterThanOrEqual(1);
    const blocked = text.split('\n').filter((l) => l.startsWith('realty_dispatch_results_window{') && l.includes('result="blocked"'));
    expect(blocked.length).toBeGreaterThanOrEqual(1);
    expect(blocked.every((l) => /reason="[A-Z][A-Z0-9_]*"/.test(l))).toBe(true);
    expect(text).toContain('realty_tenants{bucket="1-10"} 1');
    for (const q of ['realtime', 'default', 'bulk', 'maintenance']) expect(text).toMatch(new RegExp(`realty_queue_lag_seconds\\{queue="${q}"\\} `));
    for (const k of ['offer_expired', 'first_touch_breached', 'auto_released']) expect(text).toContain(`realty_timer_fired_window{kind="${k}"}`);
  });

  it('no tenant id, contact id, phone number, email address or tenant name is ever exported', async () => {
    const r = new Registry();
    collectOperational(r, h.database, { minIntervalMs: 0 });
    instrumentPool(r, h.database, 'api');
    const text = await r.render();
    const name = (await h.su.query<{ name: string; slug: string }>('SELECT name, slug FROM tenants WHERE id = $1', [w.tenantId])).rows[0]!;
    for (const secret of [w.tenantId, sentTo.id, optedOut.id, sentTo.phone, optedOut.phone, sentTo.phone.slice(-10), sentTo.email, name.name, name.slug]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    expect(text).toMatch(/realty_db_pool_connections\{process="api",state="total"\} \d+/);
  });

  it('scrapes within the minimum interval reuse the snapshot (one database read per interval)', async () => {
    let t = 0;
    const r = new Registry();
    const c = collectOperational(r, h.database, { minIntervalMs: 15_000, now: () => t });
    await r.render();
    const first = await c.refresh();
    expect(first).not.toBeNull();
    t = 5_000;
    expect(await r.render()).toContain('realty_ops_collect_age_seconds 5');
    t = 20_000;
    expect(await r.render()).toContain('realty_ops_collect_age_seconds 0');
  });

  it('a failed database read keeps answering and says so (realty_ops_collect_ok 0)', async () => {
    const r = new Registry();
    const broken = { ...h.database, kysely: undefined } as unknown as typeof h.database;
    collectOperational(r, broken, { minIntervalMs: 0 });
    const text = await r.render();
    expect(text).toContain('realty_ops_collect_ok 0');
    expect(text).toContain('realty_ops_collect_failures_total 1');
  });
});

describe('new-lead first response (SLO 60 s)', () => {
  it('counts inquiries answered within 60 s, over 60 s, blocked by an opt-out, or not at all', async () => {
    const su = await h.su.connect();
    try {
      await su.query('BEGIN');
      await su.query('SET LOCAL session_replication_role = replica');
      const ins = `INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome) VALUES ($1, gen_random_uuid(), $2, $3, $4, 'buy', md5(random()::text), 'new_contact')`;
      // answered 10 s after the inquiry (the text sent in beforeAll)
      // (both instants moved 5 minutes back so the inquiry had its full minute)
      const received = new Date(Date.now() - 5 * 60_000);
      await su.query(`UPDATE messages SET dispatched_at = $2 WHERE contact_id = $1 AND status IN ('sent','delivered')`, [sentTo.id, new Date(received.getTime() + 10_000)]);
      await su.query(ins, [w.tenantId, sentTo.id, w.sourceId, received]);
      // the opted-out contact: the reply was blocked (never a miss)
      await su.query(ins, [w.tenantId, optedOut.id, w.sourceId, new Date(Date.now() - 5 * 60_000)]);
      // a third contact never answered
      const silent = await ownedContact(w.agents[0]!, { consent: false });
      await su.query(ins, [w.tenantId, silent.id, w.sourceId, new Date(Date.now() - 3 * 60_000)]);
      // and one too fresh to count yet
      await su.query(ins, [w.tenantId, silent.id, w.sourceId, new Date()]);
      await su.query('COMMIT');
    } finally {
      su.release();
    }
    const r = new Registry();
    collectOperational(r, h.database, { minIntervalMs: 0 });
    const text = await r.render();
    expect(valueOf(text, /^realty_first_response_inquiries_window\{result="within_60s"\}/)).toBe(1);
    expect(valueOf(text, /^realty_first_response_inquiries_window\{result="blocked"\}/)).toBe(1);
    expect(valueOf(text, /^realty_first_response_inquiries_window\{result="none"\}/)).toBe(1);
    expect(valueOf(text, /^realty_first_response_inquiries_window\{result="over_60s"\}/)).toBe(0);
    expect(valueOf(text, /^realty_first_response_seconds\{quantile="0.95"\}/)).toBeCloseTo(10, 0);
  });
});

describe('HTTP metrics', () => {
  it('requests, latency and errors by route template; raw URLs and ids never appear', async () => {
    const metrics = new Registry();
    const clock = { now: () => instant(Date.now()) };
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db: h.database, metrics, logStream: { write: () => undefined } });
    try {
      await app.ready();
      await app.inject({ method: 'GET', url: '/api/health' });
      await app.inject({ method: 'GET', url: `/api/contacts/${sentTo.id}` }); // no session: 401
      await app.inject({ method: 'GET', url: `/api/no/such/${sentTo.id}?email=${encodeURIComponent(sentTo.email)}` }); // 404
      const text = await metrics.render();
      expect(text).toContain('realty_http_requests_total{method="GET",route="/api/health",status_class="2xx"} 1');
      expect(text).toMatch(/realty_http_requests_total\{method="GET",route="\/api\/contacts\/:[a-zA-Z]+",status_class="4xx"\} 1/);
      expect(text).toMatch(/realty_http_errors_total\{code="UNAUTHENTICATED",route="\/api\/contacts\/:[a-zA-Z]+",status_class="4xx"\} 1/);
      expect(text).toContain('realty_http_errors_total{code="NOT_FOUND",route="unmatched",status_class="4xx"} 1');
      expect(text).toContain('realty_http_request_duration_seconds_count{method="GET",route="/api/health"} 1');
      expect(text).not.toContain(sentTo.id);
      expect(text).not.toContain(sentTo.email);
    } finally {
      await app.close();
    }
  });
});
