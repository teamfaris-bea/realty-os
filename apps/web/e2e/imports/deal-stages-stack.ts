// A real API and Vite for the deal-stage screen (phone and desktop). The Follow Up Boss account is
// the deterministic fake: two synthetic deals, no live account, no real names.
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const apiRoot = resolve(webRoot, '../api');

const CHILD = String.raw`
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { routeModules } from './src/routes.ts';
import { FakeFub } from './src/imports/fub.ts';
import { makeImportHandlers } from './src/imports/handlers.ts';
import { makeImportsRoutes } from './src/imports/routes.ts';
import { HandlerRegistry } from './src/worker/registry.ts';
import { createWorker } from './src/worker/loop.ts';
import { silentLogger } from './src/worker/observability.ts';
import { call, fullStage, importWorld, startFub } from './src/imports/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const fub = new FakeFub();
const holder = { deps: null };
const h = await createApiHarness({
  config: { webOrigins: [origin, TEST_ORIGIN] },
  routeModules: [...routeModules.filter((m) => m.name !== 'imports'), makeImportsRoutes(() => holder.deps)],
});
const p = h.app.platform;
holder.deps = { db: p.db, envelope: p.envelope, ids: p.ids, storage: p.providers.storage, fub: fub.connector };
const drain = async () => {
  const registry = new HandlerRegistry().registerAll(makeImportHandlers(() => holder.deps));
  const worker = createWorker({ db: h.database, registry, providers: h.providers, queues: ['bulk'], concurrency: 1, worker: 'e2e-deal-stages-' + randomUUID().slice(0, 8), idleMs: 5, log: silentLogger });
  return worker.drain(400);
};
const ih = { h, fub, deps: holder.deps, workerDeps: {}, drain, close: () => h.close() };
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const secrets = new Map();
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    const key = 'fub-deal-stages-' + randomUUID().slice(0, 8);
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [{ id: 1, firstName: 'Ada', lastName: 'Lovelace', stage: 'Active', assignedUserId: 11, emails: [{ value: 'ada.deal.stages@example.com', type: 'home' }] }],
      deals: [
        { id: 1, name: 'Known stage', status: 'Active', price: 10, stageName: 'Active', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] },
        { id: 2, name: 'Waiting deal', status: 'Active', price: 20, stageName: 'Waiting On Lender', pipelineName: 'Buyers', peopleIds: [1], userIds: [11] },
      ],
    });
    const w = await importWorld(ih);
    const b = await startFub(ih, w.owner, key);
    const map = await call(w.owner, 'PUT', '/imports/' + b.id + '/user-mappings', {
      mappings: [{ sourceRef: '11', kind: 'user', target: { kind: 'user', userId: w.agents[0].userId } }],
    });
    if (map.status !== 200) throw new Error('mapping ' + map.status);
    for (const cat of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent', 'deals']) await fullStage(ih, w.owner, b.id, cat);
    secrets.set(w.owner.email, w.owner.totpSecret);
    return { email: w.owner.email, password: TEST_PASSWORD, importId: b.id };
  },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(secrets.get(b.email), totpStep(Date.now())) };
  },
};
const ctl = http.createServer(async (req, res) => {
  try {
    const b = await body(req);
    const fn = routes[req.url];
    if (!fn) { res.writeHead(404); res.end(); return; }
    const out = await fn(b);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e && e.stack || e) }));
  }
});
await new Promise((ok) => ctl.listen(0, '127.0.0.1', ok));
console.log('E2E_READY ' + JSON.stringify({ apiPort, ctlPort: ctl.address().port }));
const stop = async () => { ctl.close(); await h.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
})().catch((e) => { console.error(e); process.exit(1); });
`;

export interface DealStageWorld {
  email: string;
  password: string;
  importId: string;
}

export interface DealStageStack {
  webUrl: string;
  world(): Promise<DealStageWorld>;
  totp(email: string): Promise<string>;
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  const net = await import('node:net');
  return new Promise((ok, fail) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a && typeof a === 'object' ? ok(a.port) : fail(new Error('no port'))));
    });
  });
}

export async function startDealStageStack(): Promise<DealStageStack> {
  const webPort = await freePort();
  const webOrigin = `http://localhost:${webPort}`;
  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', '--conditions=@realty/source', '-e', CHILD], {
    cwd: apiRoot,
    env: { ...process.env, E2E_WEB_ORIGIN: webOrigin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d) => (stderr += String(d)));
  const ports = await new Promise<{ apiPort: number; ctlPort: number }>((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`API did not start in 180 s\n${stderr}\n${out}`)), 180_000);
    child.stdout?.on('data', (d) => {
      out += String(d);
      const m = /E2E_READY (\{.*\})/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        ok(JSON.parse(m[1]) as { apiPort: number; ctlPort: number });
      }
    });
    child.on('exit', (code) => fail(new Error(`API exited (${code})\n${stderr}`)));
  });

  const vite: ViteDevServer = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: webPort, strictPort: true, host: 'localhost', proxy: { '/api': { target: `http://127.0.0.1:${ports.apiPort}`, changeOrigin: false } } },
  });
  await vite.listen();

  async function fixture<T>(path: string, body: unknown = {}): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const j = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`fixture ${path} failed: ${j.error ?? res.status}`);
    return j;
  }

  return {
    webUrl: webOrigin,
    world: () => fixture<DealStageWorld>('/world', {}),
    totp: async (email) => (await fixture<{ code: string }>('/totp', { email })).code,
    async stop() {
      await vite.close();
      await new Promise<void>((ok) => {
        child.once('exit', () => ok());
        child.stdin?.end();
        setTimeout(() => child.kill('SIGTERM'), 15_000).unref();
      });
    },
  };
}
