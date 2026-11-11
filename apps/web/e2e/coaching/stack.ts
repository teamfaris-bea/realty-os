// Boots a real stack for the coaching e2e spec (modules 36, 40, 41):
//   1. the real API (createApiHarness: a fresh per-test Postgres database, RLS-bound app_user, fake
//      providers incl. the deterministic fake model) on a free port, as a child process INSIDE apps/api, so
//      apps/web never imports @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child. `/seed` clears the platform:coaching pack (platform
//      data: counsel's review is recorded by the platform), has the Owner turn call reviews on through the
//      API, and gives agent 0 three really recorded calls (dialed, announced and recorded through the
//      provider webhooks, copied into tenant storage by the comms job) that miss the financing question;
//      the review job and the daily-fix reconcile then run exactly as the worker runs them. `/pack` sets the
//      pack's review state; `/totp` gives the current MFA code of an Owner;
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
import { coachingWorld, ownedContact, playableCall, reconcile, review, scoringOn, setPackCleared } from './src/coaching/testing.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/seed'() {
    await setPackCleared(h, true);
    w = await coachingWorld(h);
    await scoringOn(h, w.owner);
    const agent = w.agents[0];
    const lena = await ownedContact(agent, { firstName: 'Lena' });
    for (let i = 0; i < 3; i++) {
      const callId = await playableCall(h, w, agent, lena.id, { skip: ['asked_financing'] });
      const r = await review(h, w.tenantId, callId);
      if (r.kind !== 'reviewed') throw new Error('review: ' + JSON.stringify(r));
    }
    await reconcile(h, w.tenantId);
    return { password: TEST_PASSWORD, agent: agent.email, owner: w.owner.email, teamLead: w.teamLead.email };
  },
  async '/pack'(b) {
    await setPackCleared(h, b.cleared === true);
    return { ok: true };
  },
  async '/totp'(b) {
    const who = [w.owner, w.teamLead, ...w.agents].find((c) => c.email === b.email);
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: who && who.totpSecret ? totpCode(who.totpSecret, totpStep(Date.now())) : null };
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

export type CoachingFixturePath = '/seed' | '/pack' | '/totp';

export interface CoachingSeed {
  password: string;
  agent: string;
  owner: string;
  teamLead: string;
}

export interface CoachingStack {
  webUrl: string;
  fixture<T>(path: CoachingFixturePath, body?: unknown): Promise<T>;
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

export async function startCoachingStack(): Promise<CoachingStack> {
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
    async fixture<T>(path: CoachingFixturePath, body: unknown = {}): Promise<T> {
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
