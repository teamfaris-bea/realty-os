// Boots a real stack for the seller-update e2e spec and screenshots (modules 28 and 38):
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, RLS-bound app_user,
//      fake providers only: nothing real is sent) on a free port, run as a child process INSIDE apps/api, so
//      apps/web never imports @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child. `/seed` builds, through the API, an agent with a listing,
//      a seller with an email address, a co-seller who texted STOP (through the fake telephony webhook), two
//      showings with feedback (one naming a buyer); then runs module 28's reconcile pass as the worker's system
//      actor, which writes the week's draft and its feed card. `/showing` logs one more showing (the data
//      moves after assembly: the update is stale);
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
import { randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { commsWorld, call, randomEmail, inboundSms } from './src/comms/testing.ts';
import { reconcile } from './src/sellerUpdates/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let seq = 0;
let last = null;
const phone = () => { seq += 1; return '+1415' + String(3000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 6999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/seed'() {
    const w = await commsWorld(h, { agents: 1 });
    const agent = w.agents[0];
    const listing = must(await call(agent, 'POST', '/listings', { status: 'active', addressLine1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' }), 'listing').listing;
    const sam = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Sam', lastName: 'Ortiz', phones: [], emails: [randomEmail()] }), 'seller').contact;
    const alexPhone = phone();
    const alex = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Alex', lastName: 'Ortiz', phones: [alexPhone], emails: [] }), 'co-seller').contact;
    const buyer = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Morgan', lastName: 'Quill', phones: [], emails: [randomEmail()] }), 'buyer').contact;
    must(await call(agent, 'POST', '/listings/' + listing.id + '/contacts', { contactId: sam.id, role: 'seller' }), 'link seller');
    must(await call(agent, 'POST', '/listings/' + listing.id + '/contacts', { contactId: alex.id, role: 'co_seller' }), 'link co-seller');
    const r = await inboundSms(h, alexPhone, w.mainNumber, 'STOP');
    if (r.statusCode >= 300) throw new Error('stop: ' + r.statusCode);
    const show = async (hoursAgo, comments, buyerContactId) => {
      const at = new Date(Date.now() - hoursAgo * 3600000).toISOString();
      const s = must(await call(agent, 'POST', '/listings/' + listing.id + '/showings', { startsAt: at, status: 'completed', buyerAgentName: 'Pat Lee', ...(buyerContactId ? { buyerContactId } : {}) }), 'showing').showing;
      if (comments) must(await call(agent, 'POST', '/showings/' + s.id + '/feedback', { comments, receivedAt: at }), 'feedback');
    };
    await show(50, 'Morgan Quill thought the yard was too small.', buyer.id);
    await show(26, 'Bright, quiet street. Kitchen is the highlight.');
    await reconcile(h, w.tenantId);
    last = { agent, listingId: listing.id };
    return { email: agent.email, password: TEST_PASSWORD, listingId: listing.id, samId: sam.id, alexId: alex.id };
  },
  async '/showing'() {
    const at = new Date(Date.now() - 2 * 3600000).toISOString();
    must(await call(last.agent, 'POST', '/listings/' + last.listingId + '/showings', { startsAt: at, status: 'completed' }), 'showing');
    return { ok: true };
  },
  async '/messages'(b) {
    const r = await h.su.query("SELECT contact_id, channel, status, body FROM messages WHERE contact_id = ANY ($1::uuid[]) AND direction = 'outbound' ORDER BY created_at", [b.contactIds]);
    return { messages: r.rows };
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

export type SellerFixturePath = '/seed' | '/showing' | '/messages';

export interface SellerSeed {
  email: string;
  password: string;
  listingId: string;
  samId: string;
  alexId: string;
}

export interface SellerStack {
  webUrl: string;
  fixture<T>(path: SellerFixturePath, body?: unknown): Promise<T>;
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

export async function startSellerStack(): Promise<SellerStack> {
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
    async fixture<T>(path: SellerFixturePath, body: unknown = {}): Promise<T> {
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
