// Boots a real stack for the D5a (outbound photo and video texts) e2e spec, like e2e/inbox/stack.ts:
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, the RLS-bound app_user,
//      deterministic fake providers: nothing is ever sent) on a free port, as a child process inside apps/api;
//   2. a fixture control endpoint that seeds THROUGH THE API: the team, its number and an agent; people the agent added,
//      who texted in through the signed telephony webhook (a real STOP included); a phone added and one removed
//      through the contact routes. The superuser only reads back which contact point to remove;
//   3. a Vite dev server for apps/web whose /api proxy points at that API, on another free port.
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
import { commsWorld, call, inboundSms, randomEmail } from './src/comms/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN], trustProxy: 'loopback' } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let seq = 0;
const phone = () => { seq += 1; return '+1415' + String(3000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 6999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const sms = async (from, text) => { const r = await inboundSms(h, from, w.mainNumber, text); if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body); };
const routes = {
  async '/world'() {
    w = await commsWorld(h, { agents: 1 });
    agent = w.agents[0];
    return { email: agent.email, password: TEST_PASSWORD };
  },
  // a person the agent added who texted (and maybe opted out, from a phone the agent then removed)
  async '/contact'(b) {
    const phones = [phone()];
    const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Jane', lastName: b.lastName ?? 'Doe', phones, emails: b.noEmail ? [] : [randomEmail()], intent: 'buyer' }), 'contact');
    const id = c.contact.id;
    if (b.text) await sms(phones[0], b.text);
    if (b.stopFromFirst) await sms(phones[0], 'STOP');
    if (b.secondPhone) {
      const p2 = phone();
      must(await call(agent, 'POST', '/contacts/' + id + '/points', { kind: 'phone', address: p2 }), 'add phone');
      phones.push(p2);
    }
    if (b.removeFirst) {
      const p = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2", [id, phones[0]])).rows[0];
      must(await call(agent, 'POST', '/contacts/' + id + '/points/' + p.id + '/remove', { reason: 'old' }), 'remove phone');
    }
    return { id, name: c.contact.displayName, phones };
  },
  // read back only: how many staged uploads are still waiting (a sent or removed one is no longer a row)
  async '/live-uploads'() {
    const r = await h.su.query('SELECT count(*)::int AS n FROM outbound_media_uploads');
    return { n: r.rows[0].n };
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

export type FixturePath = '/world' | '/contact' | '/live-uploads';

export interface World {
  email: string;
  password: string;
}

export interface Person {
  id: string;
  name: string;
  phones: string[];
}

export interface MmsStack {
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

export async function startMmsStack(): Promise<MmsStack> {
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
  // each sign-in stands for its own device (the API limits sign-ins per client IP and email): a fresh test address each
  let deviceSeq = 0;
  const deviceIp = () => {
    deviceSeq += 1;
    return `198.18.${Math.floor(deviceSeq / 250) % 250}.${(deviceSeq % 250) + 1}`;
  };
  const vite: ViteDevServer = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: {
      port: webPort,
      strictPort: true,
      host: '127.0.0.1',
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${ports.apiPort}`,
          changeOrigin: false,
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq, req) => {
              if ((req.url ?? '').startsWith('/api/auth/login')) proxyReq.setHeader('x-forwarded-for', deviceIp());
              else proxyReq.removeHeader('x-forwarded-for');
            });
          },
        },
      },
    },
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
