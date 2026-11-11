// Boots a real stack for the module 41 admin pages e2e (Integrations, MLS, Website chat), on the pattern of
// e2e/lead-admin/stack.ts:
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, connecting as the
//      RLS-bound app_user, deterministic fake providers; MLS_PROVIDER and MLS_LIVE_CALLS at their defaults, so the
//      MLS provider is the built-in fake and live calls are off; no external call) on a free port, as a child
//      process inside apps/api, so apps/web never imports @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child: a team (Owner with MFA, an Admin) made through the API; an MLS
//      connection whose licence pack nobody has marked reviewed (system actor, as the sync would leave it: the
//      fake provider has no connect flow), and a "Website chat" lead source with a consent disclosure;
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
import { totpCode, totpStep } from './src/auth/totp.ts';
import { accWorld } from './src/accountability/testing.ts';
import { REVIEWED_PACK, mlsConnection } from './src/mls/testing.ts';
import { chatSource } from './src/channels/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let admin = null;
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await accWorld(h);
    admin = await h.invite(w.owner, 'admin', { mfa: true });
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [w.owner.userId, 'Olivia Owens']);
    return {
      owner: { email: w.owner.email, password: TEST_PASSWORD, totpSecret: w.owner.totpSecret, userId: w.owner.userId },
      admin: { email: admin.email, password: TEST_PASSWORD, totpSecret: admin.totpSecret, userId: admin.userId },
      tenantId: w.tenantId,
    };
  },
  async '/mls'() {
    const id = await mlsConnection(h, w.tenantId, w.owner.userId, { pack: { ...REVIEWED_PACK, reviewed_by_counsel_at: null }, lastSyncedAt: new Date() });
    return { id };
  },
  async '/chat-source'() {
    return chatSource(h, w.owner, w.tenantId, 'Website chat');
  },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(b.secret, totpStep(Date.now())) };
  },
};
const ctl = http.createServer(async (req, res) => {
  try {
    const fn = routes[req.url];
    if (!fn) { res.writeHead(404).end('{}'); return; }
    const out = await fn(await body(req));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out ?? {}));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(e && e.stack || e) }));
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

export type FixturePath = '/world' | '/mls' | '/chat-source' | '/totp';

export interface World {
  owner: { email: string; password: string; totpSecret: string; userId: string };
  admin: { email: string; password: string; totpSecret: string; userId: string };
  tenantId: string;
}

export interface AdminPagesStack {
  webUrl: string;
  fixture<T>(path: FixturePath, body?: unknown): Promise<T>;
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

export async function startAdminPagesStack(): Promise<AdminPagesStack> {
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
    async fixture<T>(path: FixturePath, body: unknown = {}): Promise<T> {
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
