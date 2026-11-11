// Liveness / readiness: ready only as an RLS-bound role and not while draining; no details leak.
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { createDatabase } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from './auth/testHarness.js';
import { markDraining } from './health.js';
import { createFakeProviders } from './providers/index.js';
import { buildServer } from './server.js';

let h: ApiHarness;
beforeAll(async () => {
  h = await createApiHarness();
});
afterAll(async () => {
  await h?.close();
});

describe('health and readiness', () => {
  it('/api/health is 200 with no details; /api/ready is 200 as app_user', async () => {
    const live = await h.app.inject({ method: 'GET', url: '/api/health' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(live.headers['cache-control']).toBe('no-store');
    const ready = await h.app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ready' });
  });

  it('readiness refuses a superuser / BYPASSRLS database login (the app must connect as app_user)', async () => {
    const clock = { now: () => instant(Date.now()) };
    const db = createDatabase({ url: h.testDb.ownerUrl, max: 1, applicationName: 'health-test' });
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db, logStream: { write: () => undefined } });
    try {
      await app.ready();
      const r = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toEqual({ status: 'unavailable' });
    } finally {
      await app.close();
      await db.close();
    }
  });

  it('a draining server reports 503 on /ready (the balancer stops sending) while /health and requests still answer', async () => {
    const clock = { now: () => instant(Date.now()) };
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db: h.database, logStream: { write: () => undefined } });
    try {
      await app.ready();
      markDraining(app);
      expect((await app.inject({ method: 'GET', url: '/api/ready' })).json()).toEqual({ status: 'draining' });
      expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(503);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      // another server on the same database is unaffected
      expect((await h.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
