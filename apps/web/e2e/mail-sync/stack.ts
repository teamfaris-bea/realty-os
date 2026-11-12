// Boots a real stack for the module 69 (web/mail-sync) e2e spec, like e2e/inbox/stack.ts and e2e/lead-admin/stack.ts:
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, the RLS-bound app_user,
//      deterministic fake providers, the FakeGmail at h.providers.gmail) on a free port, as a child process inside
//      apps/api, with the web origin FIRST in webOrigins so the OAuth callback redirects back to this Vite server;
//   2. a fixture control endpoint that seeds THROUGH THE API (team, agent, the agent's clients with email
//      addresses) and drives the Google side through module 68's test helpers: clearGmailPack (the operator
//      recording counsel review and Google's verification: no application path does that), issueCode (the
//      person approving in Google's dialog), deliver (mail arriving in the mailbox) and runMailSync (one
//      mail.sync pass). The superuser is used only for display names, the TOTP replay guard and reading copies;
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
import { randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { leadsWorld, call } from './src/leads/testing.ts';
import { clearGmailPack, runMailSync, copiesOf } from './src/mailSync/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let n = 0;
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await leadsWorld(h, { agents: 1, push: false });
    agent = w.agents[0];
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [w.owner.userId, 'Olivia Owens']);
    await h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [agent.userId, 'Ava Chen']);
    return {
      owner: { email: w.owner.email, password: TEST_PASSWORD, totpSecret: w.owner.totpSecret },
      agent: { email: agent.email, password: TEST_PASSWORD },
      mailbox: 'ava.chen.' + Date.now().toString(36) + '@gmail.example',
      tenantId: w.tenantId,
    };
  },
  /** a client of the agent with one email address (created by the agent through the API, so the agent owns it) */
  async '/contact'(b) {
    n += 1;
    const email = (b.firstName ?? 'client').toLowerCase() + '.' + Date.now().toString(36) + n + '@example.test';
    const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Jane', lastName: b.lastName ?? 'Doe', emails: [email], intent: 'buyer' }), 'contact');
    return { id: c.contact.id, name: c.contact.displayName, email };
  },
  async '/clear-gmail'() {
    await clearGmailPack(h);
    return {};
  },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(b.secret, totpStep(Date.now())) };
  },
  /** the person approves in (fake) Google's consent dialog */
  async '/gmail-code'(b) {
    return { code: h.providers.gmail.issueCode({ codeChallenge: b.codeChallenge, mailbox: b.mailbox }) };
  },
  /** mail arrives in the mailbox, then one mail.sync pass runs */
  async '/deliver'(b) {
    const id = h.providers.gmail.deliver(b.mailbox, { from: b.from, to: b.to ?? [b.mailbox], cc: b.cc ?? [], subject: b.subject, text: b.text, threadId: b.threadId, messageId: '<' + randomUUID() + '@example.test>', internalDate: Date.now() });
    return { id };
  },
  async '/sync'() {
    await runMailSync(h, w.tenantId);
    return {};
  },
  async '/copies'(b) {
    return { copies: (await copiesOf(h, { contactId: b.contactId })).map((c) => ({ thread: c.gmail_thread_id, subject: c.subject })) };
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

export type FixturePath = '/world' | '/contact' | '/clear-gmail' | '/totp' | '/gmail-code' | '/deliver' | '/sync' | '/copies';

export interface MailWorld {
  owner: { email: string; password: string; totpSecret: string };
  agent: { email: string; password: string };
  mailbox: string;
  tenantId: string;
}

export interface MailStack {
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

export async function startMailStack(): Promise<MailStack> {
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
