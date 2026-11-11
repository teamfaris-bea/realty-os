// Liveness / readiness: ready only as an RLS-bound role and not while draining; no details leak.
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { createDatabase } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from './auth/testHarness.js';
import { READINESS_PROBE_PREFIX, markDraining, registerReadinessCheck } from './health.js';
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
    expect(ready.json()).toEqual({ status: 'ready', checks: { database: 'ok', storage: 'ok' } });
    // the probe object is removed again
    expect([...h.providers.storage.objects.keys()].some((k) => k.startsWith(READINESS_PROBE_PREFIX))).toBe(false);
  });

  it('readiness refuses a superuser / BYPASSRLS database login (the app must connect as app_user)', async () => {
    const clock = { now: () => instant(Date.now()) };
    const db = createDatabase({ url: h.testDb.ownerUrl, max: 1, applicationName: 'health-test' });
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db, logStream: { write: () => undefined } });
    try {
      await app.ready();
      const r = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(r.statusCode).toBe(503);
      expect(r.json()).toMatchObject({ status: 'unavailable', checks: { database: 'failed' } });
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

  it('storage that cannot be written is degraded, not down: 200 with the failed check named', async () => {
    const clock = { now: () => instant(Date.now()) };
    const providers = createFakeProviders({ clock });
    providers.storage.put = async () => {
      throw new Error('bucket unreachable');
    };
    const app = buildServer(testConfig(), { providers, clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db: h.database, logStream: { write: () => undefined } });
    try {
      await app.ready();
      const r = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'degraded', checks: { database: 'ok', storage: 'failed' } });
      expect(r.body).not.toContain('bucket unreachable');
    } finally {
      await app.close();
    }
  });

  it('a provider configuration that no longer loads is degraded; a hanging check times out as failed', async () => {
    const clock = { now: () => instant(Date.now()) };
    const app = buildServer(testConfig(), { providers: createFakeProviders({ clock }), clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db: h.database, logStream: { write: () => undefined } });
    try {
      await app.ready();
      registerReadinessCheck(app, { name: 'providers', run: async () => true });
      expect((await app.inject({ method: 'GET', url: '/api/ready' })).json()).toEqual({ status: 'ready', checks: { database: 'ok', storage: 'ok', providers: 'ok' } });
      registerReadinessCheck(app, { name: 'providers', run: () => new Promise<boolean>(() => undefined) });
      const r = await app.inject({ method: 'GET', url: '/api/ready' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'degraded', checks: { database: 'ok', storage: 'ok', providers: 'failed' } });
    } finally {
      await app.close();
    }
  });

  it('liveness stays cheap: no database or storage work', async () => {
    const clock = { now: () => instant(Date.now()) };
    const providers = createFakeProviders({ clock });
    let touched = 0;
    providers.storage.put = async () => {
      touched++;
    };
    const db = createDatabase({ url: 'postgres://nobody:none@127.0.0.1:1/none', max: 1 });
    const app = buildServer(testConfig(), { providers, clock, ids: uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n))), db, logStream: { write: () => undefined } });
    try {
      await app.ready();
      expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
      expect(touched).toBe(0);
    } finally {
      await app.close();
      await db.close();
    }
  });
});
