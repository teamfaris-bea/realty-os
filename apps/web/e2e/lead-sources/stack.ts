// Boots a real stack for the Lead sources journey (journey.spec.ts), the same way as the other e2e stacks:
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via createTestDb, connecting
//      as the RLS-bound app_user, deterministic FAKE providers; the harness's public base URL is https, so the Google
//      Ads lead form is available; the inbound lead-email domain is the dev default leads.realty-os.invalid) on a free
//      port, run as a child process INSIDE apps/api (`tsx -e`, cwd apps/api), so apps/web never imports @realty/api
//      or @realty/db code;
//   2. a fixture control endpoint on the same child that seeds a team THROUGH THE API (an Owner with MFA, one agent
//      in a round-robin rule, a team number: comms/testing.ts commsWorld), posts Google lead form deliveries exactly
//      as Google does (leadForms/testing.ts googlePayload + postGoogleLead: JSON with the key in the body, no auth
//      header), and texts a tracking number through the signed telephony webhook (comms/testing.ts inboundSms). The
//      superuser is used only to read state back, give the seeded people readable (fictional) names and clear the
//      TOTP replay guard;
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
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { commsWorld, inboundSms } from './src/comms/testing.ts';
import { randomPhone } from './src/assistant/testing.ts';
import { googlePayload, postGoogleLead, col } from './src/leadForms/testing.ts';
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
    w = await commsWorld(h, { agents: 1 });
    await name(w.owner.userId, 'Avery Owner');
    await name(w.agents[0].userId, 'Casey Agent');
    return { owner: { email: w.owner.email, password: TEST_PASSWORD } };
  },
  async '/totp'(b) {
    const c = b.email === w.owner.email ? w.owner : null;
    if (!c || !c.totpSecret) return { code: null };
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(c.totpSecret, totpStep(Date.now())) };
  },
  /** one Google lead form delivery with the key the page showed (a test, or a real lead) */
  async '/google'(b) {
    const columns = [col('FULL_NAME', b.name ?? 'Riley Example'), col('EMAIL', b.email ?? 'riley.' + Date.now().toString(36) + '@example.com'), col('PHONE_NUMBER', b.phone ?? randomPhone())];
    const r = await postGoogleLead(h, googlePayload({ key: b.key, isTest: b.isTest === true, columns }));
    return { status: r.statusCode };
  },
  /** what the database holds for a source: its inquiries (by how they came) and its live tracking numbers */
  async '/source-facts'(b) {
    const s = (await h.su.query('SELECT id FROM lead_sources WHERE tenant_id = $1 AND name = $2', [w.tenantId, b.name])).rows[0];
    if (!s) return { id: null, inquiries: [], numbers: [] };
    const inquiries = (await h.su.query("SELECT outcome, source_detail->>'channel' AS channel FROM lead_inquiries WHERE tenant_id = $1 AND lead_source_id = $2 ORDER BY received_at", [w.tenantId, s.id])).rows;
    const numbers = (await h.su.query('SELECT e164 FROM phone_numbers WHERE tenant_id = $1 AND lead_source_id = $2 AND released_at IS NULL', [w.tenantId, s.id])).rows.map((r) => r.e164);
    return { id: s.id, inquiries, numbers };
  },
  /** a stranger texts a number (the signed telephony webhook, as the fake provider does) */
  async '/text'(b) {
    const r = await inboundSms(h, randomPhone(), b.to, b.body ?? 'Hi, I saw your sign on Elm St. Is it still for sale?');
    return { status: r.statusCode };
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

export type FixturePath = '/world' | '/totp' | '/google' | '/source-facts' | '/text';

export interface World {
  owner: { email: string; password: string };
}

export interface SourceFacts {
  id: string | null;
  inquiries: { outcome: string; channel: string | null }[];
  numbers: string[];
}

export interface LeadSourcesStack {
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

export async function startLeadSourcesStack(): Promise<LeadSourcesStack> {
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
