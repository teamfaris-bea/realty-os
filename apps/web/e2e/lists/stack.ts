// Boots a real stack for the People (smart lists) e2e specs (PARITY_PLAN module 61), as e2e/agent/stack.ts:
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database, RLS-bound
//      app_user, fake providers) on a free port, run as a child process inside apps/api;
//   2. a fixture control endpoint on the same child that seeds the team THROUGH THE API (api/lists'
//      listsWorld: Owner, Admin, a Team Lead with agents A and B, contacts, tags and lists);
//   3. a Vite dev server for apps/web whose /api proxy points at that API.
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
import { listsWorld, makeTag, tagContact, call } from './src/lists/testing.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
const secrets = new Map();
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'(b) {
    const w = await listsWorld(h, { perAgent: b.perAgent ?? 32 });
    const buyer = await makeTag(w.agentA, 'Buyer');
    await makeTag(w.agentA, 'Investor');
    const va = await makeTag(w.agentA, 'VA buyer');
    for (const id of w.aContacts.slice(0, 30)) must(await tagContact(w.agentA, id, [buyer.id]), 'tag');
    must(await tagContact(w.agentA, w.aContacts[31], [va.id]), 'tag va');
    const list = must(await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Hot buyers', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } }), 'list');
    const team = must(await call(w.lead, 'POST', '/smart-lists', { scope: 'team', name: 'New leads', definition: { v: 1, all: [{ kind: 'stage', in: ['new'] }] } }), 'team list');
    must(await call(w.admin, 'POST', '/custom-fields', { label: 'Budget', fieldType: 'number' }), 'field');
    must(await call(w.admin, 'POST', '/custom-fields', { label: 'Birthday', fieldType: 'date', annual: true }), 'field');
    must(await call(w.admin, 'POST', '/custom-fields', { label: 'Timeline', fieldType: 'single_select', options: [{ label: 'Now' }, { label: '3-6 months' }, { label: 'Later' }] }), 'field');
    secrets.set(w.admin.email, w.admin.totpSecret);
    return { agent: { email: w.agentA.email, password: TEST_PASSWORD }, lead: { email: w.lead.email, password: TEST_PASSWORD }, admin: { email: w.admin.email, password: TEST_PASSWORD }, buyerTagId: buyer.id, listId: list.list.id, teamListId: team.list.id, firstContactId: w.aContacts[0] };
  },
  async '/totp'(b) {
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

export type FixturePath = '/world' | '/totp';

export interface ListsStack {
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

export async function startListsStack(): Promise<ListsStack> {
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
