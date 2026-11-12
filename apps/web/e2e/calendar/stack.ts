// Boots a real stack for the calendar settings e2e spec (calendar.spec.ts), the same way as the other stacks:
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via createTestDb,
//      connecting as the RLS-bound app_user, deterministic FAKE providers, including the fake Google OAuth
//      provider and the fake Google calendar) on a free port, run as a child process INSIDE apps/api;
//   2. a fixture control endpoint that seeds an Owner and an agent THROUGH THE API and plays the provider's
//      side: '/approve' is the person approving in the (fake) Google dialog: it issues a code for the flow's
//      PKCE challenge with exactly the requested scopes; '/push' creates an in-app appointment as the agent
//      and runs the calendar jobs with the real worker, then reads the fake calendar; the superuser only reads
//      the link row back;
//   3. a Vite dev server for apps/web whose /api proxy points at that API.
// Nothing real is configured, called or stored.
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
import { inviteViaApi } from './src/admin/testing.ts';
import { newAppointment, runCalendarJobs, inHours } from './src/calendar/testing.ts';
import { CALENDAR_SERVICES } from './src/calendar/catalog.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
const name = (id, n) => h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, n]);
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    const owner = await h.signup();
    const agent = await inviteViaApi(h, owner, 'agent', { mfa: false });
    await name(owner.userId, 'Olivia Owens');
    await name(agent.userId, 'Ava Chen');
    w = { owner, agent };
    return { agent: { email: agent.email, password: TEST_PASSWORD, userId: agent.userId } };
  },
  /** the person approves in the fake provider dialog: a code for this flow's challenge, the requested scopes */
  async '/approve'(b) {
    const u = new URL(b.url);
    const provider = u.pathname.split('/')[1];
    const key = provider === 'microsoft' ? 'microsoft_calendar' : 'google_calendar';
    const code = h.providers.integrations.oauth[provider].issueCode({ codeChallenge: u.searchParams.get('code_challenge'), accounts: [], token: { scopes: [...CALENDAR_SERVICES[key].scopes], refresh: true } });
    return { code, state: u.searchParams.get('state'), provider: key };
  },
  async '/push'() {
    const id = await newAppointment(w.agent, { startsAt: inHours(26) });
    await runCalendarJobs(h, w.agent.tenantId);
    const ev = h.providers.integrations.calendar.google.events.get(id);
    return { appointmentId: id, inGoogle: !!ev, title: ev ? ev.title : null };
  },
  async '/link'() {
    const r = await h.su.query('SELECT status, access_enc IS NOT NULL AS has_token, refresh_enc IS NOT NULL AS has_refresh FROM user_calendar_links WHERE user_id = $1', [w.agent.userId]);
    return { link: r.rows[0] ?? null };
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

export type FixturePath = '/world' | '/approve' | '/push' | '/link';

export interface World {
  agent: { email: string; password: string; userId: string };
}

export interface CalendarStack {
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

export async function startCalendarStack(): Promise<CalendarStack> {
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
