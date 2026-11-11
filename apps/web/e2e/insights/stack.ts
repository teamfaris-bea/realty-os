// Boots a real stack for the module 40 journey (journey.spec.ts), the same way as the other e2e stacks:
//   1. the real API (createApiHarness: a fresh per-test Postgres database, the RLS-bound app_user, FAKE providers)
//      on a free port, run as a child process inside apps/api, so apps/web never imports API code;
//   2. a fixture endpoint on that child seeds a team through the API (insights/testing.ts insightsWorld: Owner with
//      MFA, Admin, a Team Lead leading two agents, an ISA, a TC), plus superuser fixtures where time must be
//      backdated: closed deals with and without a commission for two lead sources, a Zillow cost for the month,
//      open deals with history for the forecast, and the first agent's tasks; then it runs the insights.weekly_plan
//      reconcile for this week's Monday as the system actor (the same function the hourly job runs);
//   3. a Vite dev server for apps/web whose /api proxy points at that API.
// Nothing real is configured or sent.
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
import { localDateOf, zone } from '@realty/core/foundation';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { call, freshReauth } from './src/admin/testing.ts';
import { insightsWorld, leadSource, deal, history, ago, ym, thisMonday, runWeeklyPlan } from './src/insights/testing.ts';
import { isoWeekOf } from './src/insights/common.ts';
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
    w = await insightsWorld(h);
    const [a0, a1] = w.agents;
    await name(w.owner.userId, 'Olivia Owens');
    await name(w.teamLead.userId, 'Sam Rivera');
    await name(a0.userId, 'Ava Chen');
    await name(a1.userId, 'Ben Ortiz');
    const zillow = await leadSource(h, w.tenantId, 'Zillow');
    const referral = await leadSource(h, w.tenantId, 'Referral');
    const closed = new Date(Date.now() - 2 * 3600_000);
    await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: closed, sourceId: zillow, commissionCents: 1_000_000, name: 'Park purchase' });
    await deal(h, w.tenantId, { owner: a1, stage: 'closed', closedAt: closed, sourceId: zillow, commissionCents: 500_050, name: 'Lee sale' });
    await deal(h, w.tenantId, { owner: a1, stage: 'closed', closedAt: closed, sourceId: zillow, name: 'Diaz purchase' });
    await deal(h, w.tenantId, { owner: a0, stage: 'closed', closedAt: closed, sourceId: referral, commissionCents: 420_000, name: 'Kim sale' });
    for (let i = 0; i < 10; i++) {
      const d = await deal(h, w.tenantId, { owner: i % 2 ? a1 : a0, stage: 'under_contract', enteredAt: ago(100 + i * 10), commissionCents: 600_000 });
      if (i < 7) await history(h, w.tenantId, d, 'closed', ago(100 + i * 10 - 30));
    }
    await freshReauth(h, w.owner);
    await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: zillow, month: ym(new Date(), w.zone), amountCents: 90_000 });
    const monday = thisMonday(w.zone);
    const at = (days) => new Date(monday + days * 86_400_000);
    const task = (kind, title, due) => h.su.query("INSERT INTO tasks (tenant_id, id, assignee_user_id, kind, title, due_at, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, $5, $6, 'user', $3)", [w.tenantId, randomUUID(), a0.userId, kind, title, due]);
    await task('promise', 'Send Sam the comps', at(1));
    await task('todo', 'Order the yard sign', at(2));
    await task('callback', 'Call Lena back about the inspection', null);
    await runWeeklyPlan(h, w.tenantId, monday);
    return {
      owner: { email: w.owner.email, password: TEST_PASSWORD },
      agent: { email: a0.email, password: TEST_PASSWORD, userId: a0.userId },
      week: isoWeekOf(localDateOf(monday, zone(w.zone))),
    };
  },
  async '/totp'(b) {
    const c = b.email === w.owner.email ? w.owner : null;
    if (!c || !c.totpSecret) return { code: null };
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(c.totpSecret, totpStep(Date.now())) };
  },
  async '/tasks'(b) {
    return { titles: (await h.su.query('SELECT title FROM tasks WHERE tenant_id = $1 AND assignee_user_id = $2 ORDER BY title', [w.tenantId, b.userId])).rows.map((r) => r.title) };
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

export type FixturePath = '/world' | '/totp' | '/tasks';

export interface World {
  owner: { email: string; password: string };
  agent: { email: string; password: string; userId: string };
  week: string;
}

export interface InsightsStack {
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

export async function startInsightsStack(): Promise<InsightsStack> {
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
