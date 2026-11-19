// Boots a real stack for the team work queue e2e spec (b19 team-queue lane), the way e2e/lead-admin/stack.ts does:
//   1. the real API (createApiHarness: a fresh per-run Postgres database, the RLS-bound app_user, deterministic fake
//      providers) on a free port, as a child process INSIDE apps/api, so apps/web never imports @realty/api code;
//   2. a fixture control endpoint on the same child that seeds a team and four leads THROUGH THE API and the real
//      engines (intake, the ownership engine, the first-response job, the dial path). The superuser only reads
//      state back and gives the seeded members readable names. Invented people only;
//   3. a Vite dev server for apps/web on a free port whose /api proxy points at that API.
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
import { acceptedLead, call, command, contactState, intake } from './src/accountability/testing.ts';
import { approvedPlaybook, assistantWorld, randomPhone, runJobs } from './src/assistant/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
const name = (id, n) => h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, n]);
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  /** a Team Lead leading two agents, a working send path, and the approved automatic first reply */
  async '/world'() {
    const base = await assistantWorld(h, { agents: 2, teamLead: true });
    w = { ...base, outsider: await h.invite(base.owner, 'agent') };
    await name(w.owner.userId, 'Olivia Owens');
    await name(w.teamLead.userId, 'Sam Rivera');
    await name(w.agents[0].userId, 'Ava Chen');
    await name(w.agents[1].userId, 'Ben Okafor');
    await name(w.outsider.userId, 'Kim Park');
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    const pond = (await h.su.query('SELECT name FROM ponds WHERE id = $1', [w.defaultPondId])).rows[0].name;
    return {
      teamLead: { email: w.teamLead.email, password: TEST_PASSWORD, userId: w.teamLead.userId },
      agents: w.agents.map((a) => ({ email: a.email, userId: a.userId })),
      pondName: pond,
      tenantId: w.tenantId,
    };
  },
  /**
   * Four leads through the real intake and ownership engine: one released to the pond, one still on offer, one
   * owned whose only contact is the automatic first reply (the real first-response job), one owned that its agent
   * has called (the real dial path). Nothing is written by hand.
   */
  async '/waiting'() {
    const nameOf = (id) => (id === w.agents[0].userId ? 'Ava Chen' : 'Ben Okafor');
    const pondLead = await acceptedLead(h, w, { fullName: 'Pilar Pondsworth' });
    must(await command(pondLead.owner, pondLead.contactId, 'release', { reason: 'not_a_fit' }), 'release');
    const offered = await intake(h, w, { fullName: 'Otis Offerman' });
    const offeredTo = (await contactState(h, offered.contactId)).offered_to_user_id;
    const auto = await acceptedLead(h, w, { fullName: 'Aurelio Autoreply' });
    const called = await acceptedLead(h, w, { fullName: 'Hana Called' });
    // the automatic first reply goes out for every new lead here; it is never a human attempt
    await runJobs(h, w.tenantId, ['assistant.first_response', 'comms.dispatch']);
    const automated = (await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND initiator = 'assistant' AND status = 'sent'", [auto.contactId])).rows[0].n;
    // a person calls Hana: the agent's verified alert phone is the bridge
    const ch = await called.owner.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = h.providers.telephony.verificationCodes.at(-1).code;
    await called.owner.post('/api/me/alert-phone/verify', { challenge: ch.json().challenge, code });
    const dial = must(await call(called.owner, 'POST', '/contacts/' + called.contactId + '/calls', {}), 'call');
    if (dial.result !== 'dialing') throw new Error('call not placed: ' + JSON.stringify(dial));
    return {
      pond: { contactId: pondLead.contactId },
      offered: { contactId: offered.contactId, offeredToName: nameOf(offeredTo) },
      automated: { contactId: auto.contactId, ownerName: nameOf(auto.owner.userId), automatedReplies: automated },
      called: { contactId: called.contactId, ownerName: nameOf(called.owner.userId) },
    };
  },
  /** what reading the page wrote: nothing (the queue is read-only) */
  async '/writes'() {
    const r = await h.su.query(
      'SELECT (SELECT count(*)::int FROM jobs WHERE tenant_id = $1) AS jobs, (SELECT count(*)::int FROM notifications WHERE tenant_id = $1) AS notifications, (SELECT count(*)::int FROM messages WHERE tenant_id = $1) AS messages, (SELECT count(*)::int FROM lead_ownership_events WHERE tenant_id = $1) AS ledger',
      [w.tenantId],
    );
    return r.rows[0];
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

export type FixturePath = '/world' | '/waiting' | '/writes';

export interface World {
  teamLead: { email: string; password: string; userId: string };
  agents: { email: string; userId: string }[];
  pondName: string;
  tenantId: string;
}

export interface Waiting {
  pond: { contactId: string };
  offered: { contactId: string; offeredToName: string };
  automated: { contactId: string; ownerName: string; automatedReplies: number };
  called: { contactId: string; ownerName: string };
}

export interface TeamQueueStack {
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

export async function startTeamQueueStack(): Promise<TeamQueueStack> {
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
