// Boots a real stack for the parity module 64 e2e specs and screenshots (same shape as e2e/agent/stack.ts):
//   1. the real API (createApiHarness: a fresh per-test Postgres database, RLS-bound app_user, fake
//      providers) on a free port, as a child process INSIDE apps/api (apps/web never imports api/db code);
//   2. a fixture endpoint on the same child that seeds through the API: a team with a number and an email
//      identity on a verified domain plus the postal address (bulk email needs them), an agent, contacts
//      (one opted out of email through the staff revoke route, one without an email), and templates. The
//      bulk run itself is the real runner (runBulkAction) called by the fixture instead of the worker loop;
//   3. a Vite dev server whose /api proxy points at that API.
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
import { commsWorld, call, randomEmail } from './src/comms/testing.ts';
import { marketingReady } from './src/bulk/testing.ts';
import { runBulkAction } from './src/bulk/run.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let seq = 0;
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await commsWorld(h, { agents: 1 });
    agent = w.agents[0];
    await marketingReady(h, w);
    return { email: agent.email, password: TEST_PASSWORD, ownerEmail: w.owner.email };
  },
  async '/contact'(b) {
    const emails = b.noEmail ? [] : [b.email ?? randomEmail()];
    const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Jane', lastName: b.lastName ?? 'Doe', phones: [phone()], emails, ...(b.confirmDistinct ? { confirmDistinct: true } : {}) }), 'contact');
    if (b.unsubscribed) {
      const p = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email' LIMIT 1", [c.contact.id])).rows[0];
      must(await call(agent, 'POST', '/contacts/' + c.contact.id + '/consent', { kind: 'revoke', pointId: p.id, channel: 'email', purpose: 'all', evidence: { note: 'asked to stop' } }), 'revoke');
    }
    return { id: c.contact.id, name: c.contact.displayName, email: emails[0] ?? null };
  },
  async '/template'(b) {
    const by = b.team ? w.owner : agent;
    const t = must(await call(by, 'POST', '/templates', { scope: b.team ? 'team' : 'personal', channel: b.channel, name: b.name, ...(b.channel === 'email' ? { subject: b.subject ?? 'Hello {{contact.first_name}}' } : {}), body: b.body }), 'template');
    return { id: t.template.id };
  },
  async '/run'(b) {
    const r = await runBulkAction(b.actionId, w.deps, w.tenantId);
    return { result: r, emails: h.providers.email.sent.map((m) => m.to) };
  },
  async '/sent'() {
    return { sms: h.providers.telephony.sms.map((m) => ({ to: m.to, body: m.body })), emails: h.providers.email.sent.map((m) => ({ to: m.to, subject: m.subject })) };
  },
  async '/stale-reauth'(b) {
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1)", [b.email]);
    return { ok: true };
  },
  async '/totp'(b) {
    const who = b.email === w.owner.email ? w.owner : agent;
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: who.totpSecret ? totpCode(who.totpSecret, totpStep(Date.now())) : null };
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

export type FixturePath = '/world' | '/contact' | '/template' | '/run' | '/sent' | '/stale-reauth' | '/totp';

export interface BulkStack {
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

export async function startBulkStack(): Promise<BulkStack> {
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
    async fixture<T>(path: FixturePath, b: unknown = {}): Promise<T> {
      const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: JSON.stringify(b) });
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
