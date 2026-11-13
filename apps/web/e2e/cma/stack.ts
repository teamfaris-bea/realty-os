// Boots a real stack for the CMA e2e spec and screenshots (module 72, web/cma; D9 V2-A), on the seller-updates pattern:
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, RLS-bound app_user, fake
//      providers only: nothing real is sent) on a free port, run as a child process INSIDE apps/api, so apps/web never
//      imports @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child, seeding through api/cma's own test helpers (apps/api/src/cma/
//      testing.ts; synthetic data only): `/seed` builds a share world (an agent with a verified fixture sending domain
//      on the fake email provider), twelve synthetic MLS sales nearby through V1-A's real sync, and a seller with an
//      email address, a property address and an earlier MLS sale of the home. `/clear-platform` records platform:cma's
//      counsel review in THIS test database only and `/restore-platform` clears it again (withPlatformCmaCleared's two
//      halves, so the spec restores it in a finally). `/sent` counts what the fake email provider recorded to an address;
//   3. a Vite dev server for apps/web whose /api proxy points at that API.
// stop() closes everything and drops the test database.
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const apiRoot = resolve(webRoot, '../api');

const CHILD = String.raw`
import http from 'node:http';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { emailSeller, localSales, shareWorld } from './src/cma/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/seed'(b) {
    const w = await shareWorld(h);
    await localSales(w, 12);
    const agent = w.agents[0];
    const s = await emailSeller(w, agent, { name: b.name ?? 'Sam Seller' });
    return { email: agent.email, password: TEST_PASSWORD, contactId: s.c, sellerEmail: s.email, line1: s.line1 };
  },
  async '/clear-platform'() {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'");
    return { ok: true };
  },
  async '/restore-platform'() {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
    return { ok: true };
  },
  async '/sent'(b) {
    return { count: h.providers.email.sent.filter((m) => m.to === b.to).length };
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

export type CmaFixturePath = '/seed' | '/clear-platform' | '/restore-platform' | '/sent';

export interface CmaSeed {
  email: string;
  password: string;
  contactId: string;
  sellerEmail: string;
  line1: string;
}

export interface CmaStack {
  webUrl: string;
  fixture<T>(path: CmaFixturePath, body?: unknown): Promise<T>;
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

export async function startCmaStack(): Promise<CmaStack> {
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
    const timer = setTimeout(() => fail(new Error(`API did not start in 180 s\n${stderr}`)), 180_000);
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

  return {
    webUrl: webOrigin,
    async fixture<T>(path: CmaFixturePath, body: unknown = {}): Promise<T> {
      const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: JSON.stringify(body) });
      const j = (await res.json()) as T & { error?: string };
      if (!res.ok) throw new Error(`fixture ${path} failed: ${j.error ?? res.status}`);
      return j;
    },
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
