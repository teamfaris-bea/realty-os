// The metrics registry and listener: Prometheus text format, no ids or PII in labels, bounded series,
// and a /metrics endpoint that is never public (own port, bearer token).
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError } from '../config.js';
import { loadObservabilityConfig } from './config.js';
import { startMetricsListener } from './listener.js';
import { PrometheusWorkerMetrics, tenantBucket } from './metrics.js';
import { MAX_SERIES_PER_FAMILY, Registry, safeLabelValue } from './prometheus.js';

describe('registry', () => {
  it('renders counters, gauges and histograms in the Prometheus text format', async () => {
    const r = new Registry();
    r.counter('realty_test_total', 'A test counter.').inc({ kind: 'comms.dispatch', outcome: 'succeeded' }, 2);
    r.gauge('realty_test_gauge', 'A test gauge.').set(3.5, { queue: 'realtime' });
    r.histogram('realty_test_seconds', 'A test histogram.', [0.1, 1]).observe(0.5, { kind: 'x.y' });
    const text = await r.render();
    expect(text).toContain('# TYPE realty_test_total counter');
    expect(text).toContain('realty_test_total{kind="comms.dispatch",outcome="succeeded"} 2');
    expect(text).toContain('realty_test_gauge{queue="realtime"} 3.5');
    expect(text).toContain('realty_test_seconds_bucket{kind="x.y",le="0.1"} 0');
    expect(text).toContain('realty_test_seconds_bucket{kind="x.y",le="1"} 1');
    expect(text).toContain('realty_test_seconds_bucket{kind="x.y",le="+Inf"} 1');
    expect(text).toContain('realty_test_seconds_count{kind="x.y"} 1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('refuses id-shaped label names: a tenant, user, contact or job id can never become a label', () => {
    const r = new Registry();
    for (const name of ['tenant_id', 'tenantId', 'user', 'contact_id', 'job_id', 'email', 'phone']) {
      expect(() => r.counter('realty_bad_total', 'x').inc({ [name]: 'v' })).toThrow(/not allowed/);
    }
  });

  it('exports UUIDs, emails, phone numbers and free text in label values as OTHER', () => {
    expect(safeLabelValue('0190d3c2-7b1a-7c3e-9f00-1234567890ab')).toBe('OTHER');
    expect(safeLabelValue('pat@example.com')).toBe('OTHER');
    expect(safeLabelValue('+15555550123')).toBe('OTHER');
    expect(safeLabelValue('5555550123')).toBe('OTHER');
    expect(safeLabelValue('hello world')).toBe('OTHER');
    expect(safeLabelValue('/api/contacts/:contactId')).toBe('/api/contacts/:contactId');
    expect(safeLabelValue('30007')).toBe('30007');
    expect(safeLabelValue('OPTED_OUT')).toBe('OPTED_OUT');
  });

  it('caps the series of one family so an unbounded value cannot grow the exposition', async () => {
    const r = new Registry();
    const c = r.counter('realty_cap_total', 'x');
    for (let i = 0; i < MAX_SERIES_PER_FAMILY + 50; i++) c.inc({ kind: `k.n${i}` });
    const lines = (await r.render()).split('\n').filter((l) => l.startsWith('realty_cap_total{'));
    expect(lines.length).toBe(MAX_SERIES_PER_FAMILY + 1);
    expect(lines).toContain('realty_cap_total{kind="OTHER"} 50');
  });

  it('a failing collector never breaks the exposition', async () => {
    const r = new Registry();
    r.gauge('realty_ok', 'x').set(1);
    r.onCollect(() => {
      throw new Error('db down');
    });
    expect(await r.render()).toContain('realty_ok 1');
  });

  it('the worker adapter maps the worker metric names (ms become seconds; workKind becomes work_kind)', async () => {
    const r = new Registry();
    const m = new PrometheusWorkerMetrics(r);
    m.inc('job_outcome', { kind: 'comms.dispatch', outcome: 'dead' });
    m.observe('job_run_ms', 1500, { kind: 'comms.dispatch' });
    m.inc('sweeper_failed', { workKind: 'offer_expiry' });
    m.gauge('sweeper_due', 4);
    const text = await r.render();
    expect(text).toContain('realty_jobs_total{kind="comms.dispatch",outcome="dead"} 1');
    expect(text).toContain('realty_job_duration_seconds_sum{kind="comms.dispatch"} 1.5');
    expect(text).toContain('realty_sweeper_failed_total{work_kind="offer_expiry"} 1');
    expect(text).toContain('realty_sweeper_due 4');
  });

  it('tenant counts are exported only as coarse buckets', () => {
    expect([0, 1, 10, 11, 100, 101, 1000, 1001].map(tenantBucket)).toEqual(['0', '1-10', '1-10', '11-100', '11-100', '101-1000', '101-1000', '1000+']);
  });
});

describe('metrics listener (never public)', () => {
  const token = 'a'.repeat(32);
  let base = '';
  let close: () => void = () => undefined;
  beforeAll(async () => {
    const r = new Registry();
    r.gauge('realty_up', 'x').set(1);
    const s = await startMetricsListener({ port: 0, host: '127.0.0.1', token, registry: r });
    base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    close = () => s.close();
  });
  afterAll(() => close());

  it('serves /metrics only with the bearer token', async () => {
    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    expect((await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${'b'.repeat(32)}` } })).status).toBe(401);
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(await ok.text()).toContain('realty_up 1');
  });

  it('serves nothing else', async () => {
    expect((await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(404);
    expect((await fetch(`${base}/metrics`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).status).toBe(405);
  });
});

describe('observability configuration', () => {
  it('no METRICS_PORT means no listener; the error reporter defaults to the fake', () => {
    expect(loadObservabilityConfig({})).toEqual({ metrics: null, errorReporting: { dsn: null, release: 'dev', environment: 'development' } });
  });

  it('a token is required beyond loopback and always in production; the metrics port is never the API port', () => {
    expect(loadObservabilityConfig({ METRICS_PORT: '9464' }).metrics).toEqual({ port: 9464, host: '127.0.0.1', token: null });
    expect(() => loadObservabilityConfig({ METRICS_PORT: '9464', METRICS_HOST: '0.0.0.0' })).toThrow(/METRICS_TOKEN is required/);
    expect(() => loadObservabilityConfig({ NODE_ENV: 'production', METRICS_PORT: '9464' })).toThrow(/METRICS_TOKEN is required in production/);
    expect(() => loadObservabilityConfig({ METRICS_PORT: '9464', METRICS_TOKEN: 'short' })).toThrow(/at least 24/);
    expect(() => loadObservabilityConfig({ METRICS_PORT: '3001', API_PORT: '3001' })).toThrow(/must differ from API_PORT/);
    expect(loadObservabilityConfig({ METRICS_PORT: '9464', METRICS_HOST: '0.0.0.0', METRICS_TOKEN: token32() }).metrics?.host).toBe('0.0.0.0');
  });

  it('validates the DSN and the release tag without echoing values', () => {
    expect(loadObservabilityConfig({ ERROR_REPORTING_DSN: 'https://pubkey@errors.example.com/42', RELEASE: 'abc123' }).errorReporting).toEqual({ dsn: 'https://pubkey@errors.example.com/42', release: 'abc123', environment: 'development' });
    const bad = () => loadObservabilityConfig({ ERROR_REPORTING_DSN: 'not a url secret-value' });
    expect(bad).toThrow(ConfigError);
    expect(bad).not.toThrow(/secret-value/);
    expect(() => loadObservabilityConfig({ RELEASE: 'has spaces' })).toThrow(/RELEASE/);
    expect(() => loadObservabilityConfig({ NODE_ENV: 'production', ERROR_REPORTING_DSN: 'http://k@errors.example.com/1', METRICS_PORT: '' })).toThrow(/https in production/);
  });
});

function token32(): string {
  return 'x'.repeat(32);
}
