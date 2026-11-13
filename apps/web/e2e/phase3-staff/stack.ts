// Boots a real stack for the Phase 3 staff screens' e2e spec (module 55), on the coaching stack's pattern:
//   1. the real API (createApiHarness: a fresh per-run Postgres database, RLS-bound app_user, every provider a
//      deterministic fake) on a free port, as a child process INSIDE apps/api, so apps/web never imports @realty/api
//      or @realty/db code;
//   2. fixture control endpoints on the same child. Each world is its own tenant with synthetic people, built through
//      the module's own test helpers. Packs are DARK by default: only `/packs` (and the worlds that need a cleared pack
//      for their setup, which reset it before answering) record counsel's review, as superuser, exactly as the platform
//      would, and `/reset` withdraws every platform pack again after each test;
//   3. a Vite dev server for apps/web whose /api proxy points at that API (multipart goes through it as the browser
//      sends it: x-csrf-token, Origin, the boundary).
// stop() closes everything and drops the test database. Nothing leaves the machine: no real send, call, Google or MLS
// request.
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
import { SCRIPTS } from '@realty/core/voice/testing';
import { voiceWorld, aiCall, setVoicePack } from './src/voice/testing.ts';
import { adsWorld, connectAds, depsOf, campaignOf, spendHistory, dealsFor, setCapVia, setAdsPack, thisMonday } from './src/ads/testing.ts';
import { runReconcile } from './src/ads/mirror.ts';
import { runWeeklyProposal } from './src/ads/propose.ts';
import { gbpWorld, setPacks, resetPacks, makeDue, jobCtx, syncDeps } from './src/gbp/testing/world.ts';
import { rawReview } from './src/gbp/testing.ts';
import { syncReviews } from './src/gbp/sync.ts';
import { docWorld, makeDeal, runScan } from './src/documents/testing.ts';
import { call } from './src/admin/testing.ts';
import { workspaceWorld, contactOf } from './src/workspace/testing.ts';
import { approvedModel, pass, savedListings, setModelStatus, testRegistry, FIRST_PARTY_MODEL } from './src/predict/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const clients = [];
const keep = (...cs) => { for (const c of cs) if (c) clients.push(c); };
const people = (o) => Object.fromEntries(Object.entries(o).map(([k, c]) => [k, c.email]));
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
let voice = null;
let ads = null;
let gbp = null;
let docs = null;
let likely = null;
const resetAll = async () => {
  await resetPacks(h);
  await h.su.query("UPDATE jurisdiction_packs SET rules = rules - 'vendor_ready_at' WHERE key IN ('platform:voice','platform:ads') AND status = 'published'");
};
const routes = {
  // every platform pack back to uncleared (after each test)
  async '/reset'() {
    await resetAll();
    if (likely) for (const v of likely.versions) await setModelStatus(h, v, 'withdrawn');
    return { ok: true };
  },
  // counsel's review of packs, as the platform records it (test database only)
  async '/packs'(b) {
    if (b.voice !== undefined) await setVoicePack(h, { reviewed: b.voice === true, vendorReady: b.voice === true });
    if (b.ads !== undefined) await setAdsPack(h, { reviewed: b.ads === true, vendor: b.ads === true });
    const keys = (b.keys ?? []);
    if (keys.length > 0) await setPacks(h, keys, b.reviewed === true);
    return { ok: true };
  },
  async '/totp'(b) {
    const who = clients.find((c) => c.email === b.email);
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: who && who.totpSecret ? totpCode(who.totpSecret, totpStep(Date.now())) : null };
  },
  // the person's sessions are no longer freshly authenticated (as 15 minutes after sign-in): the next guarded write
  // answers REAUTH_REQUIRED and the shell asks for the password
  async '/reauth/expire'(b) {
    await h.su.query('UPDATE sessions SET reauthenticated_at = NULL WHERE user_id = (SELECT id FROM users WHERE email = $1)', [b.email]);
    return { ok: true };
  },
  // module 48: a tenant with an approved voice playbook, AI answering OFF unless asked (voiceWorld enable:false)
  async '/voice'(b) {
    if (!voice) {
      voice = await voiceWorld(h, { enable: b.enable === true });
      voice.admin = await h.invite(voice.owner, 'admin');
      voice.tc = await h.invite(voice.owner, 'tc');
      keep(voice.owner, voice.admin, voice.tc, ...voice.agents);
    }
    return { password: TEST_PASSWORD, ...people({ owner: voice.owner, admin: voice.admin, agent: voice.agents[0], tc: voice.tc }) };
  },
  // an AI-answered call to agent 0's contact (the pack is cleared for the call's own path, then withdrawn)
  async '/voice/call'(b) {
    await setVoicePack(h, { reviewed: true, vendorReady: true });
    try {
      // AI answering on for this one call only (the Owner's own path), off again afterwards so the settings page
      // shows the Owner's off state to the next test
      const { enableAnswering, disableAnswering } = await import('./src/voice/answering.ts');
      const { voiceDeps } = await import('./src/voice/runtime.ts');
      await enableAnswering(voice.owner.actor(), voiceDeps(h.app.platform));
      try {
        const c = await aiCall(h, voice, SCRIPTS[b.script ?? 'booking']);
        return { callId: c.callId, contactId: c.contactId };
      } finally {
        await disableAnswering(voice.owner.actor(), voiceDeps(h.app.platform));
      }
    } finally {
      await setVoicePack(h, { reviewed: false, vendorReady: false });
    }
  },
  // module 52: two linked campaigns with spend and outcomes, a cap, and this week's proposal (cleared only to propose)
  async '/ads'() {
    if (!ads) {
      const w = await adsWorld(h);
      const { accountId } = await connectAds(h, w, undefined, { campaigns: [
        { externalCampaignId: 'fake-c-cheap', name: 'Example St cheap', dailyBudgetCents: 3000 },
        { externalCampaignId: 'fake-c-costly', name: 'Example St costly', dailyBudgetCents: 3000 },
      ] });
      await runReconcile(depsOf(h, w), w.tenantId);
      for (const ext of ['fake-c-cheap', 'fake-c-costly']) {
        const c = await campaignOf(h, w.tenantId, ext);
        const r = await call(w.owner, 'PATCH', '/ads/campaigns/' + c.id, { listingId: w.listingId, creativePieceId: w.pieceId });
        if (r.status !== 200) throw new Error('link: ' + r.status);
      }
      spendHistory(w, accountId, 'fake-c-cheap', 2000);
      spendHistory(w, accountId, 'fake-c-costly', 4000);
      await dealsFor(h, w, 'gads:fake-c-cheap', 6);
      await dealsFor(h, w, 'gads:fake-c-costly', 5);
      const cap = await setCapVia(h, w.owner, 3_000_000, 10_000);
      if (cap.status !== 201) throw new Error('cap: ' + cap.status);
      await runReconcile(depsOf(h, w), w.tenantId);
      await setAdsPack(h, { reviewed: true, vendor: true });
      try {
        const p = await runWeeklyProposal(depsOf(h, w, { now: () => thisMonday() }), w.tenantId);
        if (p.outcome !== 'proposed') throw new Error('proposal: ' + p.outcome);
        w.actionId = p.actionId;
      } finally {
        await setAdsPack(h, { reviewed: false, vendor: false });
      }
      ads = w;
      keep(w.owner, w.admin, w.agent, w.teamLead);
    }
    return { password: TEST_PASSWORD, actionId: ads.actionId, ...people({ owner: ads.owner, admin: ads.admin, agent: ads.agent, teamLead: ads.teamLead }) };
  },
  // module 53: a connected location with one rated review (synced while cleared, then withdrawn)
  async '/gbp'() {
    if (!gbp) {
      gbp = await gbpWorld(h);
      await h.su.query('UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1', [gbp.tenantId]);
      await setPacks(h, ['platform:gbp'], true);
      try {
        h.providers.gbp.seed(gbp.location.accountId, [rawReview('rv-e2e-1', { stars: 'FIVE', comment: 'Helpful and patient with every question.', reviewer: 'Reviewer A' })]);
        await makeDue(h, gbp.tenantId);
        await syncReviews(jobCtx(h, gbp.tenantId), syncDeps(h));
      } finally {
        await resetPacks(h);
      }
      keep(gbp.owner, gbp.admin, gbp.agent, gbp.teamLead);
    }
    return { password: TEST_PASSWORD, ...people({ owner: gbp.owner, admin: gbp.admin, agent: gbp.agent, teamLead: gbp.teamLead }) };
  },
  // module 42: a deal of agent 0 with the TC and the ISA as members
  async '/docs'() {
    if (!docs) {
      const w = await docWorld(h);
      const deal = await makeDeal(w, w.agents[0]);
      docs = { ...w, dealId: deal.dealId, contactId: deal.contactId };
      keep(w.owner, w.admin, w.tc, w.isa, w.teamLead, ...w.agents);
    }
    return { password: TEST_PASSWORD, dealId: docs.dealId, contactId: docs.contactId, ...people({ owner: docs.owner, admin: docs.admin, agent: docs.agents[0], tc: docs.tc, isa: docs.isa }) };
  },
  // the fake PDF reader learns the text layer of the bytes the browser is about to upload (base64)
  async '/docs/pages'(b) {
    h.providers.textExtractor.register(new Uint8Array(Buffer.from(b.base64, 'base64')), b.pages);
    return { ok: true };
  },
  // the worker's virus check (fake scanner) for one document, then its date reading
  async '/docs/scan'(b) {
    const r = await runScan(h, docs.tenantId, b.documentId);
    const { extractDocument } = await import('./src/documents/extract.ts');
    const { docDeps } = await import('./src/documents/testing.ts');
    const { systemActor } = await import('./src/worker/systemActor.ts');
    const { withTenantTx } = await import('@realty/db');
    const deps = docDeps(h);
    const sys = systemActor(docs.tenantId, 'worker');
    const x = await extractDocument(deps, sys, (fn) => withTenantTx(sys, fn, { db: deps.db }), b.documentId).catch((e) => ({ error: String(e) }));
    return { scan: r, extract: x };
  },
  // module 50: an approved synthetic model and a flagged contact of agent 0 (withdrawn again by /reset)
  async '/likely'() {
    if (!likely) {
      const w = await workspaceWorld(h, { agents: 1 });
      likely = { ...w, versions: [] };
      keep(w.owner, ...w.agents);
    }
    const def = await approvedModel(h, FIRST_PARTY_MODEL);
    likely.versions.push(def.version);
    const c = await contactOf(likely.agents[0], { firstName: 'Pat' });
    await savedListings(h, likely.tenantId, c.id, 3);
    await pass(h, likely.tenantId, { registry: testRegistry(def) });
    return { password: TEST_PASSWORD, contactId: c.id, ...people({ owner: likely.owner, agent: likely.agents[0] }) };
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
const stop = async () => { ctl.close(); await resetAll().catch(() => undefined); await h.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
})().catch((e) => { console.error(e); process.exit(1); });
`;

export type StaffFixturePath = '/reset' | '/packs' | '/totp' | '/reauth/expire' | '/voice' | '/voice/call' | '/ads' | '/gbp' | '/docs' | '/docs/pages' | '/docs/scan' | '/likely';

export interface People {
  password: string;
  owner: string;
  admin?: string;
  agent: string;
  teamLead?: string;
  tc?: string;
  isa?: string;
}

export interface StaffStack {
  webUrl: string;
  fixture<T>(path: StaffFixturePath, body?: unknown): Promise<T>;
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

export async function startStaffStack(): Promise<StaffStack> {
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
    async fixture<T>(path: StaffFixturePath, body: unknown = {}): Promise<T> {
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
