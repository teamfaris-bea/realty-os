// Boots a real stack for the lead-journey specs (apps/web/e2e/journeys), the same way the other e2e
// stacks do (agent/stack.ts, parity-integration/stack.ts):
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via createTestDb,
//      the RLS-bound app_user, deterministic FAKE providers only) on a free port, as a child process
//      INSIDE apps/api (`tsx -e`, cwd apps/api), so apps/web never imports @realty/api or @realty/db code.
//      api/imports runs on the deterministic fake Follow Up Boss connector. Nothing real is configured
//      and nothing is ever sent: every outbound text, email and call lands in the fakes' records;
//   2. a fixture control endpoint on the same child. Generic primitives every journey shares:
//        /world      a tenant set up THROUGH THE API (commsWorld: agents, optional Team Lead + team, a
//                    round-robin rule, a signed lead source, an approved 10DLC number, an email identity);
//                    its clients are kept by name ("<world>.owner", "<world>.agent0", "<world>.lead")
//        /api        an API call as a named client (cookie + CSRF through app.inject): setup and probes
//        /intake     a signed lead-source webhook (X-Realty-Signature), /sms-in a signed inbound text
//        /jobs       one drain of the REAL worker (every registered handler, the fakes as providers),
//                    optionally making pending jobs of some kinds due first (a clock fixture)
//        /sends      what reached the fake providers (texts, emails, calls)
//        /fail-next  provider failure injection on the fakes (e.g. timeout_after_submit)
//        /sql        superuser READ-BACK only (SELECT/WITH): the database half of every assertion
//        /clock/*    the stored-deadline clock fixtures of leads/testing.ts (Postgres' clock cannot be faked)
//        /totp       a fresh TOTP code for an Owner/Admin sign-in
//      A spec adds its own routes (and imports) as JS source through startJourneyStack({ routes, imports });
//   3. a Vite dev server for apps/web on a free port whose /api proxy points at that API.
// stop() closes everything and drops the test database.
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const apiRoot = resolve(webRoot, '../api');

const child = (imports: string, routes: string) => String.raw`
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { QUEUES } from '@realty/db';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { routeModules } from './src/routes.ts';
import { FakeFub } from './src/imports/fub.ts';
import { makeImportHandlers } from './src/imports/handlers.ts';
import { makeImportsRoutes } from './src/imports/routes.ts';
import { handlers } from './src/worker/handlers/index.ts';
import { HandlerRegistry } from './src/worker/registry.ts';
import { createWorker } from './src/worker/loop.ts';
import { silentLogger } from './src/worker/observability.ts';
import { commsWorld, call, inboundSms, randomEmail } from './src/comms/testing.ts';
import { postIntake, randomPhone, setOfferExpiry, setPeriodDeadlines, suFixture } from './src/leads/testing.ts';
import { freshReauth } from './src/admin/testing.ts';
${imports}
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
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const importKinds = new Set(makeImportHandlers(() => holder.deps).map((x) => x.kind));
const registry = () => new HandlerRegistry().registerAll([...handlers.filter((x) => !importKinds.has(x.kind)), ...makeImportHandlers(() => holder.deps)]);
const worker = (name) => createWorker({ db: h.database, registry: registry(), providers: h.providers, queues: [...QUEUES], concurrency: 2, worker: name ?? ('e2e-journey-' + randomUUID().slice(0, 8)), idleMs: 5, log: silentLogger });
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const worlds = new Map();
const clients = new Map();
const client = (name) => { const c = clients.get(name); if (!c) throw new Error('no client ' + name); return c; };
const world = (name) => { const w = worlds.get(name ?? 'a'); if (!w) throw new Error('no world ' + name); return w; };
const who = (c) => ({ email: c.email, password: TEST_PASSWORD, userId: c.userId, role: c.role });
const routes = {
  /** { name='a', agents=2, teamLead=false, alertPhones=false } */
  async '/world'(b) {
    const name = b.name ?? 'a';
    const w = await commsWorld(h, { agents: b.agents ?? 2, teamLead: !!b.teamLead });
    worlds.set(name, w);
    clients.set(name + '.owner', w.owner);
    w.agents.forEach((a, i) => clients.set(name + '.agent' + i, a));
    if (w.teamLead) clients.set(name + '.lead', w.teamLead);
    if (b.alertPhones) {
      for (const a of w.agents) {
        const ch = await a.post('/api/me/alert-phone', { phone: randomPhone() });
        const code = h.providers.telephony.verificationCodes.at(-1).code;
        const v = await a.post('/api/me/alert-phone/verify', { challenge: ch.json().challenge, code });
        if (v.statusCode !== 200) throw new Error('alert phone: ' + v.statusCode + ' ' + v.body);
      }
    }
    return {
      tenantId: w.tenantId, teamId: w.teamId, ruleId: w.ruleId, defaultPondId: w.defaultPondId, sourceId: w.sourceId, mainNumber: w.mainNumber,
      owner: who(w.owner), agents: w.agents.map(who), lead: w.teamLead ? who(w.teamLead) : null,
    };
  },
  /** { as: 'a.agent0', method, path (without /api), body } → { status, body } */
  async '/api'(b) {
    const r = await call(client(b.as), b.method ?? 'GET', b.path, b.body);
    return { status: r.status, body: r.body };
  },
  /** { world, body } → the signed lead-source webhook's answer */
  async '/intake'(b) {
    const r = await postIntake(h, world(b.world).token, { inquiryType: 'buy', fullName: 'Pat Lead', phones: [randomPhone()], ...b.body });
    return { status: r.statusCode, body: JSON.parse(r.body) };
  },
  /** { world, from, body } → the signed telephony webhook's status */
  async '/sms-in'(b) {
    const r = await inboundSms(h, b.from, world(b.world).mainNumber, b.body);
    return { status: r.statusCode };
  },
  /** { as } the /auth/reauth effect for an Owner/Admin step-up (R-PERM-13), without its rate limit */
  async '/reauth'(b) { await freshReauth(h, client(b.as)); return { ok: true }; },
  async '/phone'() { return { phone: randomPhone(), email: randomEmail() }; },
  /** { kinds?: string[] (made due first), tenantId?, rounds=200, worker? } → { ran } */
  async '/jobs'(b) {
    if (b.kinds) await h.su.query("UPDATE jobs SET run_at = now() - interval '1 second' WHERE status = 'pending' AND kind = ANY ($1) AND ($2::uuid IS NULL OR tenant_id = $2)", [b.kinds, b.tenantId ?? null]);
    return { ran: await worker(b.worker).drain(b.rounds ?? 200) };
  },
  async '/sends'() {
    const t = h.providers.telephony;
    return {
      sms: t.sms.map((m) => ({ to: m.to, from: m.from, body: m.body, key: m.idempotencyKey, ref: m.providerRef })),
      calls: t.calls.map((c) => ({ to: c.to, agentPhone: c.agentPhone, key: c.idempotencyKey })),
      emails: h.providers.email.sent.map((m) => ({ to: m.to, subject: m.subject, key: m.idempotencyKey })),
    };
  },
  /** { channel: 'sms' | 'email', kind: FakeFailure } */
  async '/fail-next'(b) {
    (b.channel === 'email' ? h.providers.email : h.providers.telephony).failNext(b.kind);
    return { ok: true };
  },
  /** superuser READ-BACK only */
  async '/sql'(b) {
    if (!/^\s*(select|with)\b/i.test(b.text) || /\b(insert|update|delete|truncate|alter|drop|create|grant)\b/i.test(b.text.replace(/'[^']*'/g, ''))) throw new Error('read-back only');
    return { rows: (await h.su.query(b.text, b.values ?? [])).rows };
  },
  /** { contactId, ms } the current offer expires ms from now (negative: already expired) */
  async '/clock/offer'(b) { return { at: await setOfferExpiry(h, b.contactId, b.ms) }; },
  /** { contactId, dueMs, releaseMs } the current period's first-touch due / auto-release instants */
  async '/clock/period'(b) { return await setPeriodDeadlines(h, b.contactId, b.dueMs, b.releaseMs ?? null); },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    const c = [...clients.values()].find((x) => x.email === b.email);
    return { code: c && c.totpSecret ? totpCode(c.totpSecret, totpStep(Date.now())) : null };
  },
  ${routes}
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

export interface Who {
  email: string;
  password: string;
  userId: string;
  role: string;
}

export interface WorldInfo {
  tenantId: string;
  teamId: string | null;
  ruleId: string | null;
  defaultPondId: string;
  sourceId: string;
  mainNumber: string;
  owner: Who;
  agents: Who[];
  lead: Who | null;
}

export interface Sends {
  sms: { to: string; from: string; body: string; key: string; ref: string }[];
  calls: { to: string; agentPhone: string; key: string }[];
  emails: { to: string; subject: string; key: string }[];
}

export interface JourneyStack {
  webUrl: string;
  apiUrl: string;
  fixture<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T>;
  world(o?: { name?: string; agents?: number; teamLead?: boolean; alertPhones?: boolean }): Promise<WorldInfo>;
  /** an API call as a named fixture client ("a.agent0", "a.lead", "b.owner") */
  api<T = Record<string, unknown>>(as: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  sql<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<T[]>;
  sends(): Promise<Sends>;
  jobs(o?: { kinds?: string[]; tenantId?: string; rounds?: number; worker?: string }): Promise<number>;
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

export async function startJourneyStack(o: { imports?: string; routes?: string } = {}): Promise<JourneyStack> {
  const webPort = await freePort();
  const webOrigin = `http://localhost:${webPort}`;
  const proc: ChildProcess = spawn('pnpm', ['exec', 'tsx', '--conditions=@realty/source', '-e', child(o.imports ?? '', o.routes ?? '')], {
    cwd: apiRoot,
    env: { ...process.env, E2E_WEB_ORIGIN: webOrigin },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += String(d)));
  const ports = await new Promise<{ apiPort: number; ctlPort: number }>((ok, fail) => {
    let out = '';
    const timer = setTimeout(() => fail(new Error(`API did not start in 180 s\n${stderr}`)), 180_000);
    proc.stdout?.on('data', (d) => {
      out += String(d);
      const m = /E2E_READY (\{.*\})/.exec(out);
      if (m?.[1]) {
        clearTimeout(timer);
        ok(JSON.parse(m[1]) as { apiPort: number; ctlPort: number });
      }
    });
    proc.on('exit', (code) => fail(new Error(`API exited (${code})\n${stderr}`)));
  });

  const vite: ViteDevServer = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: { port: webPort, strictPort: true, host: 'localhost', proxy: { '/api': { target: `http://127.0.0.1:${ports.apiPort}`, changeOrigin: false } } },
  });
  await vite.listen();

  const fixture = async <T>(path: string, body: unknown = {}): Promise<T> => {
    const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: JSON.stringify(body) });
    const j = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`fixture ${path} failed: ${j.error ?? res.status}`);
    return j;
  };
  return {
    webUrl: webOrigin,
    apiUrl: `http://127.0.0.1:${ports.apiPort}`,
    fixture,
    world: (w = {}) => fixture<WorldInfo>('/world', w),
    api: <T>(as: string, method: string, path: string, body?: unknown) => fixture<{ status: number; body: T }>('/api', { as, method, path, body }),
    sql: async <T>(text: string, values: unknown[] = []) => (await fixture<{ rows: T[] }>('/sql', { text, values })).rows,
    sends: () => fixture<Sends>('/sends'),
    jobs: async (j = {}) => (await fixture<{ ran: number }>('/jobs', j)).ran,
    async stop() {
      await vite.close();
      await new Promise<void>((ok) => {
        proc.once('exit', () => ok());
        proc.stdin?.end();
        setTimeout(() => proc.kill('SIGTERM'), 15_000).unref();
      });
    },
  };
}
