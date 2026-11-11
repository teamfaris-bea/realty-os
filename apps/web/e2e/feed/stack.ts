// Boots a real stack for the Phase 2/3 feed-card e2e spec and screenshots (module 18a):
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via createTestDb,
//      RLS-bound app_user, fake providers) on a free port, run as a child process INSIDE apps/api, so
//      apps/web never imports @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child. `/seed` builds an agent (through the API: team,
//      agent, two contacts, a listing) and then writes ONE priority_feed_items row per Phase 2/3 card type
//      under its key family, exactly as the owning module would (modules 28, 29, 33, 36, 50 are not built
//      yet), plus the rows only the platform/system writes (a marketing piece draft, an approved
//      prediction model and its band for the contact). `/withdraw` withdraws that model (the platform's
//      counsel switch, R-PRED-5). Everything the browser sees is read through GET /feed as the agent;
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
import { randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { commsWorld, call, randomEmail } from './src/comms/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let seq = 0;
let model = null;
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/seed'() {
    const w = await commsWorld(h, { agents: 1 });
    const agent = w.agents[0];
    const contact = async (firstName, lastName, intent) => must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName, phones: [phone()], emails: [randomEmail()], intent }), 'contact').contact;
    const seller = await contact('Sam', 'Ortiz', 'seller');
    const lena = await contact('Lena', 'Park', 'seller');
    const listing = must(await call(agent, 'POST', '/listings', { status: 'active', addressLine1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' }), 'listing').listing;
    const pieceId = randomUUID();
    await h.su.query("INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, template_key, content_sha256, guard_result) VALUES ($1, $2, $3, 'social_post', 1, 'draft', '{\"headline\":\"Open Saturday\"}', 'social.v1', repeat('0', 64), '{}')", [w.tenantId, pieceId, listing.id]);
    model = 'predict/1.0';
    await h.su.query("INSERT INTO prediction_models (version, status, features, counsel_reviewed_at, backtest_flagged, backtest_transacted, backtest_window_days, backtest_dataset) VALUES ($1, 'approved', ARRAY['years_in_home'], now(), 120, 31, 90, 'platform back-test')", [model]);
    await h.su.query("INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on) VALUES ($1, $2, $3, 'likely_90d', $4::jsonb, repeat('a', 64), current_date)", [w.tenantId, lena.id, model, JSON.stringify([{ feature: 'years_in_home', points: 20 }])]);
    const card = (itemType, key, contactId, subjectType, subjectId, reasons) => h.su.query(
      "INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, score, score_version, reasons, dedupe_key) VALUES ($1, $2, $3, $4, 'scored', $5, $6, $7, 40, 1, $8::jsonb, $9)",
      [w.tenantId, randomUUID(), agent.userId, itemType, contactId, subjectType, subjectId, JSON.stringify(reasons), key]);
    await card('seller_update', 'seller_update:' + listing.id + ':2026-11-09', seller.id, 'listing', listing.id, [{ code: 'SELLER_UPDATE_READY', label: 'This week’s update for 12 Oak St is ready to review' }]);
    await card('marketing_review', 'marketing:' + pieceId, null, 'marketing_piece', pieceId, [{ code: 'MARKETING_DRAFT', label: 'A social post for 12 Oak St is ready for your review' }]);
    await card('weekly_plan', 'weekly_plan:' + agent.userId + ':2026-W46', null, 'user', agent.userId, [{ code: 'PLAN_ITEM', label: 'Call back the leads from the weekend' }, { code: 'PLAN_ITEM', label: 'Log the outcome of each consult' }]);
    await card('coaching_fix', 'coaching_fix:' + agent.userId + ':2026-11-11', null, 'user', agent.userId, [{ code: 'COACHING_FIX', label: 'Ask about their timeline before you talk price' }]);
    await card('likely_to_move', 'likely:' + lena.id + ':' + model, lena.id, 'contact', lena.id, [{ code: 'LIKELY_YEARS_IN_HOME', label: 'In the home for many years' }]);
    return { email: agent.email, password: TEST_PASSWORD, listingId: listing.id, sellerId: seller.id, lenaId: lena.id };
  },
  async '/withdraw'() {
    await h.su.query("UPDATE prediction_models SET status = 'withdrawn' WHERE version = $1", [model]);
    return { ok: true };
  },
  async '/approve'() {
    await h.su.query("UPDATE prediction_models SET status = 'approved' WHERE version = $1", [model]);
    return { ok: true };
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

export type FeedFixturePath = '/seed' | '/withdraw' | '/approve';

export interface FeedSeed {
  email: string;
  password: string;
  listingId: string;
  sellerId: string;
  lenaId: string;
}

export interface FeedStack {
  webUrl: string;
  fixture<T>(path: FeedFixturePath): Promise<T>;
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

export async function startFeedStack(): Promise<FeedStack> {
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
    async fixture<T>(path: FeedFixturePath): Promise<T> {
      const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: '{}' });
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
