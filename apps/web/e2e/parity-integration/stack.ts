// Boots a real stack for the FUB-parity integration spec (the five lanes wired together), as the other
// e2e stacks do:
//   1. the real API (createApiHarness: a fresh per-test Postgres database, RLS-bound app_user, fake
//      providers) on a free port, as a child process INSIDE apps/api (apps/web never imports api/db code),
//      with api/imports on the deterministic fake Follow Up Boss connector (no real provider, nothing sent);
//   2. a fixture endpoint on the same child that seeds THROUGH THE API: a lists world (Owner and Admin
//      with MFA, a Team Lead, agents, contacts, the tag "Buyer" on 30 of agent A's people and the smart
//      list "Hot buyers"), and, for the import job, a second team whose Admin imports people with tags and
//      typed custom fields from the fake FUB API (snapshot, stage and field mapping, dry run, approval,
//      commit). Jobs run through the real runners: the bulk action (runBulkAction, as the worker would) and
//      the import and revert jobs (the worker loop on the `bulk` queue). The superuser is used only to read
//      state back and to clear the TOTP replay guard;
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
import { totpCode, totpStep } from './src/auth/totp.ts';
import { routeModules } from './src/routes.ts';
import { FakeFub } from './src/imports/fub.ts';
import { makeImportHandlers } from './src/imports/handlers.ts';
import { makeImportsRoutes } from './src/imports/routes.ts';
import { approve, batchOf, commitStage, importWorld, stageOf } from './src/imports/testing.ts';
import { HandlerRegistry } from './src/worker/registry.ts';
import { createWorker } from './src/worker/loop.ts';
import { silentLogger } from './src/worker/observability.ts';
import { listsWorld, makeTag, tagContact, call } from './src/lists/testing.ts';
import { runBulkAction } from './src/bulk/run.ts';
import { depsFromPlatform } from './src/comms/runtime.ts';
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
const drain = async () => {
  const registry = new HandlerRegistry().registerAll(makeImportHandlers(() => holder.deps));
  const worker = createWorker({ db: h.database, registry, providers: h.providers, queues: ['bulk'], concurrency: 1, worker: 'e2e-imports-' + randomUUID().slice(0, 8), idleMs: 5, log: silentLogger });
  return worker.drain(400);
};
const ih = { h, fub, deps: holder.deps, workerDeps: {}, drain, close: () => h.close() };
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const secrets = new Map();
let w = null;
let imp = null;
const routes = {
  async '/world'() {
    w = await listsWorld(h, { perAgent: 32 });
    const buyer = await makeTag(w.agentA, 'Buyer');
    await makeTag(w.agentA, 'Investor');
    for (const id of w.aContacts.slice(0, 30)) must(await tagContact(w.agentA, id, [buyer.id]), 'tag');
    const list = must(await call(w.agentA, 'POST', '/smart-lists', { scope: 'personal', name: 'Hot buyers', definition: { v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [buyer.id] }] } }), 'list');
    // Jane: one of agent A's own people, outside the list (her page is where the tag jobs run)
    const jane = w.aContacts[31];
    const d = must(await call(w.agentA, 'GET', '/contacts/' + jane + '/details'), 'details');
    must(await call(w.agentA, 'PATCH', '/contacts/' + jane, { rowVersion: d.details.rowVersion, firstName: 'Jane', lastName: 'Doe', displayName: 'Jane Doe' }), 'rename');
    secrets.set(w.admin.email, w.admin.totpSecret);
    return { agent: { email: w.agentA.email, password: TEST_PASSWORD }, admin: { email: w.admin.email, password: TEST_PASSWORD }, listId: list.list.id, janeId: jane, firstListPerson: w.aContacts[0] };
  },
  /** runs every confirmed bulk action of the lists world as the worker would (the real runner) */
  async '/run-bulk'() {
    const ids = (await h.su.query("SELECT id FROM bulk_actions WHERE tenant_id = $1 AND status = 'confirmed' ORDER BY created_at", [w.tenantId])).rows.map((r) => r.id);
    const results = [];
    for (const id of ids) results.push(await runBulkAction(id, depsFromPlatform(h.app.platform), w.tenantId));
    return { results };
  },
  async '/person-state'(b) {
    const c = (await h.su.query('SELECT do_not_contact_at IS NOT NULL AS dnc FROM contacts WHERE id = $1', [b.contactId])).rows[0];
    const revokes = (await h.su.query("SELECT count(*)::int AS n FROM consent_events e JOIN contact_points p ON p.tenant_id = e.tenant_id AND p.address_hmac = e.address_hmac WHERE p.contact_id = $1 AND e.event_type = 'revoke' AND e.source = 'agent_revoke'", [b.contactId])).rows[0].n;
    const tags = (await h.su.query('SELECT t.name, ct.added_by_kind FROM contact_tags ct JOIN tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id WHERE ct.contact_id = $1 ORDER BY t.name', [b.contactId])).rows;
    return { doNotContact: c.dnc, revokes, tags };
  },
  /** a second team: its Admin imports four FUB people with tags and typed custom fields (committed, not verified) */
  async '/import'() {
    imp = await importWorld(ih);
    const key = 'fub-e2e-' + randomUUID().slice(0, 8);
    const ph = (n) => '(415) 57' + (n % 10) + '-' + String(1000 + n).slice(-4);
    fub.add(key, {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [
        { id: 9001, created: '2023-01-01T00:00:00Z', firstName: 'Ana', lastName: 'Imported', stage: 'Hot Prospect', tags: ['Buyer', 'Relocating'], phones: [{ value: ph(1), type: 'mobile', status: 'Valid' }],
          customLeadScore: '87', customClosingDate: '12/15/2026', customTimeline: '0-3 months', customInterests: 'Pool, Garage', customNotesField: 'Prefers mornings' },
        { id: 9002, created: '2023-01-02T00:00:00Z', firstName: 'Ben', lastName: 'Imported', stage: 'Waiting On Lender', tags: ['buyer'], phones: [{ value: ph(2), type: 'mobile', status: 'Valid' }],
          customLeadScore: 'high', customClosingDate: '2026-12-31', customTimeline: '0-3 months', customInterests: 'Garage' },
        { id: 9003, created: '2023-01-03T00:00:00Z', firstName: 'Cal', lastName: 'Imported', stage: 'Waiting On Lender', tags: ['Investor'], phones: [{ value: ph(3), type: 'mobile', status: 'Valid' }], customTimeline: '3-6 months', customLeadScore: '40' },
        { id: 9004, created: '2023-01-04T00:00:00Z', firstName: 'Dee', lastName: 'Imported', phones: [{ value: ph(4), type: 'mobile', status: 'Valid' }], customTimeline: '3-6 months' },
      ],
    });
    const created = must(await call(imp.admin, 'POST', '/imports', { source: 'fub_api', apiKey: key }), 'create');
    const id = created.batch.id;
    must(await call(imp.admin, 'POST', '/imports/' + id + '/snapshot'), 'snapshot');
    await drain();
    must(await call(imp.admin, 'PUT', '/imports/' + id + '/parity', { stageMap: { 'Waiting On Lender': 'nurture' }, keepStageAsTag: true, fields: {
      customLeadScore: { action: 'create', type: 'number', label: 'Lead score' },
      customClosingDate: { action: 'create', type: 'date', label: 'Closing date' },
      customTimeline: { action: 'create', type: 'single_select', label: 'Timeline' },
      customInterests: { action: 'create', type: 'multi_select', label: 'Interests' },
      customNotesField: { action: 'create', type: 'text', label: 'Notes field' },
    } }), 'parity');
    must(await call(imp.admin, 'POST', '/imports/' + id + '/stages/contacts/dry-run'), 'dry run');
    await drain();
    const st = stageOf(await batchOf(imp.admin, id), 'contacts');
    must(await approve(imp.admin, id, 'contacts', st.dryRunSha256), 'approve');
    const done = await commitStage(ih, imp.admin, id, 'contacts');
    if (done.status !== 'committed') throw new Error('commit ended ' + done.status);
    secrets.set(imp.admin.email, imp.admin.totpSecret);
    const ana = (await h.su.query("SELECT id FROM contacts WHERE tenant_id = $1 AND first_name = 'Ana' AND deleted_at IS NULL", [imp.tenantId])).rows[0].id;
    return { admin: { email: imp.admin.email, password: TEST_PASSWORD }, batchId: id, anaId: ana };
  },
  async '/drain'() {
    return { ran: await drain() };
  },
  async '/import-state'(b) {
    const q = async (text, values) => (await h.su.query(text, values)).rows;
    const links = (await q("SELECT count(*)::int AS n FROM contact_tags WHERE import_batch_id = $1", [b.batchId]))[0].n;
    const linksByKind = await q("SELECT added_by_kind AS kind, count(*)::int AS n FROM contact_tags WHERE import_batch_id = $1 GROUP BY 1", [b.batchId]);
    const values = (await q("SELECT count(*)::int AS n FROM contact_field_values WHERE import_batch_id = $1 AND updated_by_kind = 'import'", [b.batchId]))[0].n;
    const fields = await q("SELECT key, field_type, origin, archived_at IS NOT NULL AS archived FROM custom_field_defs WHERE tenant_id = $1 ORDER BY key", [imp.tenantId]);
    const tags = await q("SELECT name, created_by_kind, protected_proxy FROM tags WHERE tenant_id = $1 ORDER BY name", [imp.tenantId]);
    const batch = (await q('SELECT status FROM import_batches WHERE id = $1', [b.batchId]))[0];
    return { links, linksByKind, values, fields, tags, status: batch.status };
  },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    const s = secrets.get(b.email);
    return { code: s ? totpCode(s, totpStep(Date.now())) : null };
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

export type FixturePath = '/world' | '/run-bulk' | '/person-state' | '/import' | '/drain' | '/import-state' | '/totp';

export interface ParityStack {
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

export async function startParityStack(): Promise<ParityStack> {
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
