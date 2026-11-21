// A real API and Vite for the contact task sheet, the pipeline board and the promises screen.
// Synthetic people only. The superuser is used to rename the second agent so the assignee list is unambiguous.
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
import { leadsWorld, call, randomPhone } from './src/leads/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let other = null;
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await leadsWorld(h, { agents: 2, teamLead: true, rule: false, push: false });
    agent = w.agents[0];
    other = w.agents[1];
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [agent.userId, 'Avery Brooks']);
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [other.userId, 'Blake Chen']);
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [w.teamLead.userId, 'Taylor Morgan']);
    return {
      email: agent.email,
      password: TEST_PASSWORD,
      userId: agent.userId,
      other: { userId: other.userId, name: 'Blake Chen' },
      lead: { email: w.teamLead.email, password: TEST_PASSWORD },
    };
  },
  async '/contact'(b) {
    const who = b.as === 'other' ? other : agent;
    const c = must(await call(who, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Sam', lastName: b.lastName ?? 'Lee', phones: [randomPhone()], intent: 'buyer' }), 'contact');
    return { id: c.contact.id, name: c.contact.displayName };
  },
  async '/promise'(b) {
    const due = new Date(Date.now() + (b.dueInMs ?? -3_600_000)).toISOString();
    const r = must(await call(b.as === 'other' ? other : agent, 'POST', '/tasks', { title: b.title, kind: 'promise', contactId: b.contactId, dueAt: due }), 'promise');
    return { id: r.task.id, dueAt: due };
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

export interface DayWorld {
  email: string;
  password: string;
  userId: string;
  other: { userId: string; name: string };
  lead: { email: string; password: string };
}

export interface DayStack {
  webUrl: string;
  fixture<T>(path: '/world' | '/contact' | '/promise', body?: unknown): Promise<T>;
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

export async function startDayStack(): Promise<DayStack> {
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
  return {
    webUrl: webOrigin,
    async fixture<T>(path: '/world' | '/contact' | '/promise', body: unknown = {}): Promise<T> {
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
