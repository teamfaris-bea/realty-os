// Boots a real stack for the lead-email journey (journey.spec.ts), the same way as the other e2e stacks:
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via
//      createTestDb, connecting as the RLS-bound app_user, deterministic FAKE providers; the inbound
//      lead-email domain is the dev default leads.realty-os.invalid, which never resolves) on a free
//      port, run as a child process INSIDE apps/api (`tsx -e`, cwd apps/api), so apps/web never imports
//      @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child that seeds a team THROUGH THE API: an Owner (MFA), a
//      Team Lead, one agent who is the only member of a round-robin routing rule, a team number with an
//      approved sender registration and an email identity (commsWorld), the "Portal" lead source, and
//      an APPROVED new_lead_response playbook. It posts lead emails through the signed generic inbound
//      webhook exactly as the fake email provider does (X-Realty-Signature with the harness's email
//      webhook secret, leadEmail/testing.ts postLeadEmail), runs the first-response jobs with the real
//      worker (assistant/testing.ts runJobs), and reads the fake providers' outbox. The superuser is used
//      only to read state back, give the seeded people readable names, mark a session's re-auth stale
//      and clear the TOTP replay guard;
//   3. a Vite dev server for apps/web on a free port whose /api proxy points at that API.
// stop() closes everything and drops the test database. Nothing real is configured or sent.
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
import { assistantWorld, approvedPlaybook, runJobs, randomPhone } from './src/assistant/testing.ts';
import { freshReauth } from './src/admin/testing.ts';
import { contactState } from './src/leads/testing.ts';
import { postLeadEmail, labelledBody, contactsWith } from './src/leadEmail/testing.ts';
import { HOLD_SENTENCES } from './src/leadEmail/trust.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let seq = 0;
const name = (id, n) => h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, n]);
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await assistantWorld(h, { agents: 1, teamLead: true });
    await name(w.owner.userId, 'Olivia Owens');
    await name(w.teamLead.userId, 'Sam Rivera');
    await name(w.agents[0].userId, 'Ava Chen');
    await freshReauth(h, w.owner);
    await approvedPlaybook(w.owner, { templateKey: 'new_lead_response' });
    return {
      owner: { email: w.owner.email, password: TEST_PASSWORD },
      teamLead: { email: w.teamLead.email, password: TEST_PASSWORD },
      agent: { email: w.agents[0].email, password: TEST_PASSWORD, userId: w.agents[0].userId },
      sourceId: w.sourceId,
      holdSentences: HOLD_SENTENCES,
    };
  },
  async '/totp'(b) {
    const c = b.email === w.owner.email ? w.owner : null;
    if (!c || !c.totpSecret) return { code: null };
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(c.totpSecret, totpStep(Date.now())) };
  },
  async '/stale-reauth'(b) {
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL", [b.email]);
    return { ok: true };
  },
  /** a synthetic lead (fresh phone + email), posted to 'to' through the signed inbound webhook */
  async '/email'(b) {
    seq += 1;
    const phone = randomPhone();
    const email = 'lead.' + Date.now().toString(36) + '.' + seq + '@example.test';
    const r = await postLeadEmail(h, {
      messageId: '<' + randomUUID() + '@mail.test>',
      to: b.to,
      from: b.from ?? 'Zillow Leads <leads@zillow.com>',
      subject: b.subject ?? 'New lead',
      dkim: b.dkim ?? [{ domain: 'zillow.com', result: 'pass' }],
      text: labelledBody({ name: b.name, email, phone, property: b.property ?? '12 Elm St, Springfield, IL 62701', message: b.message ?? 'Can I tour Saturday?' }),
    });
    const out = r.statusCode === 200 ? JSON.parse(r.body).outcome : 'HTTP ' + r.statusCode + ' ' + r.body;
    return { outcome: out, phone, email };
  },
  async '/contacts-with'(b) {
    const ids = await contactsWith(h, w.tenantId, b.address);
    const states = [];
    for (const id of ids) states.push(await contactState(h, id));
    return { ids, states };
  },
  async '/first-response'() {
    await runJobs(h, w.tenantId, ['assistant.first_response', 'comms.dispatch']);
    return { ok: true };
  },
  async '/outbox'() {
    return { sms: h.providers.telephony.sms.map((m) => ({ to: m.to, body: m.body })), emails: h.providers.email.sent.map((m) => ({ to: m.to, subject: m.subject })) };
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

export type FixturePath = '/world' | '/totp' | '/stale-reauth' | '/email' | '/contacts-with' | '/first-response' | '/outbox';

export interface World {
  owner: { email: string; password: string };
  teamLead: { email: string; password: string };
  agent: { email: string; password: string; userId: string };
  sourceId: string;
  holdSentences: Record<string, string>;
}

export interface Outbox {
  sms: { to: string; body: string }[];
  emails: { to: string; subject: string }[];
}

export interface LeadEmailStack {
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

export async function startLeadEmailStack(): Promise<LeadEmailStack> {
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
