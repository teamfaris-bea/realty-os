// Error reporting: PII scrubbing, release tagging, the request id error bodies carry, and the
// Sentry-compatible envelope (sent to a local capture server, never the internet).
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { createFakeProviders } from '../providers/index.js';
import type { RouteModule } from '../routes.js';
import { buildServer } from '../server.js';
import { MemoryErrorReporter, SentryErrorReporter, buildEvent, createErrorReporter, parseStack, scrubMessage } from './errors.js';

describe('scrubbing', () => {
  it('masks emails, phone numbers, quoted values and ids in messages', () => {
    const m = scrubMessage(new Error('lookup failed for "Pat Lead" pat@example.com +1 (555) 555-0123 contact 0190d3c2-7b1a-7c3e-9f00-1234567890ab'));
    expect(m).not.toMatch(/Pat Lead|pat@example\.com|555-0123|0190d3c2/);
    expect(m).toContain('[quoted]');
    expect(m).toContain('[id]');
  });

  it('a Postgres error keeps its SQLSTATE and identifiers only (its message quotes the value)', () => {
    const pg = Object.assign(new Error('invalid input syntax for type uuid: "Pat Lead"'), { code: '22P02', severity: 'ERROR', table: 'contacts', column: 'id' });
    expect(scrubMessage(pg)).toBe('SQLSTATE 22P02 table=contacts column=id');
  });

  it('stack frames keep function, app-relative file and position only', () => {
    const frames = parseStack('Error: x\n    at handler (/home/app/apps/api/src/leads/routes.ts:10:5)\n    at /srv/node_modules/fastify/lib/route.js:200:3');
    expect(frames).toEqual([
      { function: '<anonymous>', filename: 'node_modules/fastify/lib/route.js', lineno: 200, colno: 3 },
      { function: 'handler', filename: 'apps/api/src/leads/routes.ts', lineno: 10, colno: 5 },
    ]);
  });

  it('events carry the release, environment and only the allowed tags', () => {
    const ev = buildEvent(new TypeError('boom'), { requestId: '0190d3c2-7b1a-7c3e-9f00-1234567890ab', route: '/api/contacts/:contactId', method: 'GET', status: 500, code: 'INTERNAL_ERROR' }, { release: 'r1', environment: 'staging' });
    expect(ev).toMatchObject({ release: 'r1', environment: 'staging', level: 'error', platform: 'node' });
    expect(ev.tags).toEqual({ request_id: '0190d3c2-7b1a-7c3e-9f00-1234567890ab', route: '/api/contacts/:contactId', method: 'GET', status: '500', code: 'INTERNAL_ERROR' });
    expect(ev.exception.values[0]!.type).toBe('TypeError');
    expect(Object.keys(ev).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'platform', 'release', 'tags', 'timestamp']);
  });

  it('no DSN gives the in-memory fake', () => {
    expect(createErrorReporter({ dsn: null, release: 'dev', environment: 'test' })).toBeInstanceOf(MemoryErrorReporter);
  });
});

describe('Sentry-compatible sender', () => {
  const received: { url: string; auth: string; body: string }[] = [];
  let port = 0;
  let close: () => void = () => undefined;
  beforeAll(async () => {
    const s = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        received.push({ url: req.url ?? '', auth: String(req.headers['x-sentry-auth'] ?? ''), body });
        res.writeHead(200).end('{}');
      });
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    port = (s.address() as AddressInfo).port;
    close = () => s.close();
  });
  afterAll(() => close());

  it('posts one envelope per error to /api/<project>/envelope/ with the public key, scrubbed', async () => {
    const r = new SentryErrorReporter({ dsn: `http://pubkey123@127.0.0.1:${port}/7`, release: 'abc', environment: 'staging' });
    r.capture(new Error('send failed for jo@example.com'), { requestId: 'req-1', route: '/api/x', code: 'INTERNAL_ERROR', process: 'api' });
    await r.flush();
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.url).toBe('/api/7/envelope/');
    expect(got.auth).toContain('sentry_key=pubkey123');
    const [header, item, payload] = got.body.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(item).toEqual({ type: 'event' });
    expect(header!.event_id).toBe((payload as { event_id: string }).event_id);
    expect(payload).toMatchObject({ release: 'abc', environment: 'staging', tags: { request_id: 'req-1', route: '/api/x', code: 'INTERNAL_ERROR', process: 'api' } });
    expect(got.body).not.toContain('jo@example.com');
  });

  it('rate-limits a storm and never throws when the collector is down', async () => {
    let t = 0;
    const r = new SentryErrorReporter({ dsn: 'http://k@127.0.0.1:1/1', release: 'abc', environment: 'test', perMinute: 3, now: () => t });
    for (let i = 0; i < 10; i++) r.capture(new Error('x'));
    await r.flush();
    expect(r.dropped).toBe(7);
    expect(r.failed).toBe(3);
    t = 61_000;
    r.capture(new Error('y'));
    await r.flush();
    expect(r.dropped).toBe(7);
  });
});

describe('API errors are reported with the request id of the error body', () => {
  let h: ApiHarness;
  beforeAll(async () => {
    h = await createApiHarness();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('an unexpected 500 is captured once, scrubbed, tagged with the same request id the client got', async () => {
    const reporter = new MemoryErrorReporter({ release: 'r9', environment: 'test' });
    const boom: RouteModule = {
      name: 'boom',
      async register(app) {
        app.get('/boom/:id', { config: { auth: 'public' } }, async () => {
          throw new Error('crashed on pat@example.com');
        });
        app.get('/fine', { config: { auth: 'public' } }, async () => ({ ok: true }));
      },
    };
    const clock = { now: () => instant(Date.now()) };
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db: h.database, routeModules: [boom], errorReporter: reporter, logStream: { write: () => undefined } });
    try {
      await app.ready();
      const res = await app.inject({ method: 'GET', url: '/api/boom/0190d3c2-7b1a-7c3e-9f00-1234567890ab' });
      expect(res.statusCode).toBe(500);
      const body = res.json() as { error: { code: string; requestId: string } };
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(reporter.events).toHaveLength(1);
      const ev = reporter.events[0]!;
      expect(ev.tags).toMatchObject({ request_id: body.error.requestId, route: '/api/boom/:id', method: 'GET', status: '500', code: 'INTERNAL_ERROR', process: 'api' });
      expect(ev.release).toBe('r9');
      expect(JSON.stringify(ev)).not.toMatch(/pat@example\.com|0190d3c2-7b1a/);
      // expected outcomes (4xx) are not errors to report
      expect((await app.inject({ method: 'GET', url: '/api/nope' })).statusCode).toBe(404);
      expect((await app.inject({ method: 'GET', url: '/api/fine' })).statusCode).toBe(200);
      expect(reporter.events).toHaveLength(1);
    } finally {
      await app.close();
    }
  });
});
