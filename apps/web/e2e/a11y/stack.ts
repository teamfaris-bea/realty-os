// Boots a real stack for the accessibility sweep (a11y.spec.ts) and its screenshots (shots.ts):
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via
//      createTestDb, connecting as the RLS-bound app_user, deterministic fake providers) on a free port,
//      run as a child process INSIDE apps/api (`tsx -e`, cwd apps/api), so apps/web never imports
//      @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child that seeds ONE tenant with a member of every role
//      (Owner and Admin with MFA, Team Lead, Agent, ISA, TC) and a day of data THROUGH THE API: owned
//      contacts (one texted STOP through the real inbound webhook), an inbound text and an assistant
//      draft, a task, a consult awaiting its outcome, an overdue promise (api/accountability's fixture)
//      and the exception recompute, a deal, a listing, a lead offer through the signed
//      intake webhook, a nurture playbook, a website-chat widget, and a CSV import. The superuser is used only for the
//      appointment and password-proof clock fixtures (no application path moves time), readable display names, and
//      clearing the TOTP replay guard so one secret can sign in twice in a 30 s window;
//   3. a Vite dev server for apps/web on a free port whose /api proxy points at that API.
// stop() closes everything and drops the test database.
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import type { Role } from './pages.js';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const apiRoot = resolve(webRoot, '../api');

const CHILD = String.raw`
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
import { commsWorld, call, inboundSms, randomEmail, freshReauth, runJobs } from './src/comms/testing.ts';
import { intake } from './src/leads/testing.ts';
import { upload as uploadDocument, runScan } from './src/documents/testing.ts';
import { promiseTask, recompute } from './src/accountability/testing.ts';
import { makeImportHandlers } from './src/imports/handlers.ts';
import { HandlerRegistry } from './src/worker/registry.ts';
import { createWorker } from './src/worker/loop.ts';
import { silentLogger } from './src/worker/observability.ts';
import { address as cmaAddress, cmaPack, localSales, oneTap as cmaOneTap } from './src/cma/testing.ts';
import { mlsConnection } from './src/mls/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let seq = 0;
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const name = (id, n) => h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, n]);
let secrets = new Map();
const routes = {
  async '/world'() {
    const w = await commsWorld(h, { agents: 1, teamLead: true, others: ['admin', 'isa', 'tc'] });
    const [admin, isa, tc] = w.others;
    const agent = w.agents[0];
    const people = { owner: w.owner, admin, team_lead: w.teamLead, agent, isa, tc };
    const names = { owner: 'Olivia Owens', admin: 'Adam Alvarez', team_lead: 'Sam Rivera', agent: 'Ava Chen', isa: 'Isla Grant', tc: 'Theo Clark' };
    for (const [role, c] of Object.entries(people)) await name(c.userId, names[role]);
    // an agent's day
    const contact = async (firstName, lastName, o = {}) => {
      const p = phone();
      const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName, phones: [p], emails: [randomEmail()], intent: o.intent ?? 'buyer' }), 'contact');
      for (const text of [o.inbound, o.optOut ? 'STOP' : null]) {
        if (!text) continue;
        const r = await inboundSms(h, p, w.mainNumber, text);
        if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body);
      }
      return c.contact.id;
    };
    const jane = await contact('Jane', 'Doe', { inbound: 'Does Saturday work for a showing? We are pre-approved.' });
    const marco = await contact('Marco', 'Silva', { intent: 'seller' });
    const owen = await contact('Owen', 'Price', { inbound: 'Thanks for the info', optOut: true });
    // a long conversation (taller than a phone, and than a desktop window) with a held text in the
    // middle, so its Send anyway / Cancel are reached by focus from above and below the sticky
    // compose bar (WCAG 2.4.11)
    const rosaPhone = phone();
    const rosa = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Rosa', lastName: 'Lin', phones: [rosaPhone], emails: [randomEmail()], intent: 'buyer' }), 'contact').contact.id;
    const exchange = async (n) => {
      for (let i = 0; i < n; i += 1) {
        const r = await inboundSms(h, rosaPhone, w.mainNumber, 'Question ' + (i + 1) + ' about the condo on Pine St: is parking included, and what are the HOA dues?');
        if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body);
        must(await call(agent, 'POST', '/contacts/' + rosa + '/messages', { channel: 'sms', body: 'Answer ' + (i + 1) + ': one parking space is included, and the HOA dues are listed in the disclosure packet.', idempotencyKey: 'k-' + randomUUID() }), 'reply');
      }
    };
    await exchange(6);
    const held = must(await call(agent, 'POST', '/contacts/' + rosa + '/messages', { channel: 'sms', body: 'Reminder: open house Saturday at 10', idempotencyKey: 'k-' + randomUUID(), scheduleAt: new Date(Date.now() + 3600000).toISOString() }), 'schedule');
    const reply = await inboundSms(h, rosaPhone, w.mainNumber, 'Can we make it 11 instead?');
    if (reply.statusCode >= 300) throw new Error('inbound: ' + reply.statusCode + ' ' + reply.body);
    // clock fixture: the scheduled time has come, so dispatch holds it (E27; no application path moves time)
    await h.su.query("UPDATE messages SET scheduled_for = clock_timestamp() - interval '1 second' WHERE id = $1", [held.message.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    await exchange(6);
    must(await call(agent, 'POST', '/contacts/' + jane + '/drafts', { commandId: randomUUID() }), 'draft');
    must(await call(agent, 'POST', '/tasks', { title: 'Send Marco the pricing comps', contactId: marco, dueAt: new Date(Date.now() + 7200000).toISOString() }), 'task');
    const start = new Date(Date.now() + 86400000);
    const appt = must(await call(agent, 'POST', '/appointments', { kind: 'buyer_consult', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString(), contactId: marco }), 'appointment');
    // clock fixture: the consult ended 3 h ago (no application path moves time)
    await h.su.query("UPDATE appointments SET starts_at = clock_timestamp() - interval '4 hours', ends_at = clock_timestamp() - interval '3 hours' WHERE id = $1", [appt.appointment.id]);
    const deal = must(await call(agent, 'POST', '/deals', { primaryContactId: jane, side: 'buy', priceCents: 85000000, expectedCloseDate: '2026-12-18' }), 'deal');
    // module 55: one clean purchase contract on the deal (the fake scanner), for the document page
    const doc = await uploadDocument(agent, '/deals/' + deal.deal.id + '/documents', { filename: 'Purchase contract.pdf' });
    if (doc.status !== 201) throw new Error('document: ' + doc.status + ' ' + JSON.stringify(doc.body));
    await runScan(h, w.tenantId, doc.body.document.id);
    const listing = must(await call(agent, 'POST', '/listings', { status: 'active', addressLine1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' }), 'listing');
    await intake(h, w, { inquiryType: 'buy', fullName: 'Priya Shah', phones: [phone()], message: 'Is 12 Oak St still available?', propertyText: '12 Oak St', postalCode: '94610' });
    // the Team Lead's exception queue: an overdue assistant-recorded promise and the consult with no outcome
    await promiseTask(h, w.tenantId, marco, agent.userId, { dueInMs: -2 * 3600000, snippet: 'I will send you the comps by Friday' });
    await recompute(h, w.tenantId);
    // admin data
    await freshReauth(h, w.owner);
    const DAY = 86400;
    const pb = must(await call(w.owner, 'POST', '/playbooks', {
      kind: 'nurture', scope: 'team', name: 'Sphere check-ins',
      steps: [{ stepKey: 'market_note', channel: 'email', delay: { anchor: 'enrollment', offsetSeconds: 3 * DAY }, purpose: 'marketing', category: 'nurture_step', intent: 'market_update', subject: 'A quick market note', template: 'Hi {{first_name}},\n\nHomes near you are still moving. Reply and I will send a short list.', personalization: 'none', slots: ['first_name'], maxLength: 2000, stopIf: ['appointment_booked', 'deal_opened'] }],
    }), 'playbook');
    // module 22: the team's website chat (a lead source with its notice, and a widget allowed on any website), so the
    // widget's stand-in page is swept with a real key against the real public chat routes
    const chatSource = must(await call(w.owner, 'POST', '/lead-sources', { name: 'Website chat', kind: 'website', consentDisclosure: { text: 'By starting a chat, you agree that the team may reply here and keep a record of this conversation.', namesSeller: 'Harbor & Pine Team' } }), 'chat lead source');
    await freshReauth(h, w.owner);
    const chatWidget = must(await call(w.owner, 'POST', '/admin/web-chat/widgets', { displayName: 'Website chat', leadSourceId: chatSource.source.id, allowedOrigins: [] }), 'chat widget');
    const csv = 'First Name,Last Name,Email,Phone\nNora,Bell,nora.bell@example.test,4155550111\nLiam,Ford,liam.ford@example.test,4155550122\n';
    // module 66: two records of one person (same email; the second kept apart with confirmDistinct)
    const dupEmail = randomEmail();
    const dupA = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Dana', lastName: 'Fox', phones: [phone()], emails: [dupEmail] }), 'dup a').contact.id;
    const dupB = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Dana', lastName: 'Fox', phones: [phone()], emails: [dupEmail], confirmDistinct: true }), 'dup b').contact.id;
    const dup = (await h.su.query('SELECT id FROM contact_duplicate_candidates WHERE contact_a_id = LEAST($1::uuid, $2::uuid) AND contact_b_id = GREATEST($1::uuid, $2::uuid)', [dupA, dupB])).rows[0].id;
    const imp = must(await call(w.owner, 'POST', '/imports', { source: 'csv', fileName: 'open-house.csv', fileBase64: Buffer.from(csv).toString('base64') }), 'import');
    // module 72 (web/cma): a fixture MLS feed with synthetic sold homes nearby, a property address for Marco and the
    // agent's one-tap CMA of it (api/cma's own test helpers; nothing real is configured)
    const mls = await mlsConnection(h, w.tenantId, w.owner.userId, { pack: cmaPack(), lastSyncedAt: new Date() });
    await localSales({ h, tenantId: w.tenantId, mls }, 12);
    await cmaAddress(h, w.tenantId, marco, { kind: 'property', line1: '100 Sample Ave' });
    const cma = must(await cmaOneTap(agent, marco, { facts: { propertyType: 'single_family', sqft: 1500 } }), 'cma').cma; // E373: not in the MLS history, so the agent enters type and size
    for (const [role, c] of Object.entries(people)) if (c.totpSecret) secrets.set(c.email, c.totpSecret);
    const users = Object.fromEntries(Object.entries(people).map(([role, c]) => [role, { email: c.email, password: TEST_PASSWORD, mfa: Boolean(c.totpSecret) }]));
    return { users, ids: { contactId: jane, optedOutContactId: owen, longThreadContactId: rosa, dealId: deal.deal.id, listingId: listing.listing.id, playbookId: pb.playbook.id, importId: imp.batch.id, duplicateId: dup, documentId: doc.body.document.id, widgetKey: chatWidget.widgetKey, cmaId: cma.id } };
  },
  /** module 65: runs the queued import jobs (snapshot, dry run) once, as the worker would; fake FUB only */
  async '/drain-imports'() {
    const p = h.app.platform;
    const deps = { db: p.db, envelope: p.envelope, ids: p.ids, storage: p.providers.storage, fub: () => { throw new Error('no FUB in the e2e stack'); } };
    const registry = new HandlerRegistry().registerAll(makeImportHandlers(() => deps));
    await createWorker({ db: h.database, registry, providers: h.providers, queues: ['bulk'], concurrency: 1, worker: 'e2e-imports', idleMs: 5, log: silentLogger }).drain(50);
    return {};
  },
  /** clock fixture: the user's password proof is an hour old, so the next sensitive action asks again */
  async '/stale-reauth'(b) {
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '1 hour' WHERE user_id = (SELECT id FROM users WHERE email = $1) AND revoked_at IS NULL", [b.email]);
    return {};
  },
  /** a fresh TOTP code; clears the replay guard so a second sign-in in the same 30 s works */
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(secrets.get(b.email), totpStep(Date.now())) };
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

export interface SeededUser {
  email: string;
  password: string;
  mfa: boolean;
}

export interface SeedIds {
  contactId: string;
  optedOutContactId: string;
  /** a conversation longer than the screen, with a held text (and its buttons) in the middle */
  longThreadContactId: string;
  dealId: string;
  listingId: string;
  playbookId: string;
  importId: string;
  duplicateId: string;
  /** module 55: a clean purchase contract on the deal */
  documentId: string;
  /** the team's website-chat widget key (module 22), for the widget's stand-in page */
  widgetKey: string;
  /** module 72: the agent's one-tap CMA draft of Marco's home */
  cmaId: string;
}

export interface World {
  users: Record<Role, SeededUser>;
  ids: SeedIds;
}

export interface A11yStack {
  webUrl: string;
  world(): Promise<World>;
  totp(email: string): Promise<string>;
  staleReauth(email: string): Promise<void>;
  /** module 65: run queued import jobs once */
  drainImports(): Promise<void>;
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

export async function startA11yStack(): Promise<A11yStack> {
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
    const timer = setTimeout(() => fail(new Error(`API did not start in 120 s\n${stderr}`)), 120_000);
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

  async function fixture<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`http://127.0.0.1:${ports.ctlPort}${path}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
    const j = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`fixture ${path} failed: ${j.error ?? res.status}`);
    return j;
  }

  return {
    webUrl: webOrigin,
    world: () => fixture<World>('/world', {}),
    totp: async (email) => (await fixture<{ code: string }>('/totp', { email })).code,
    staleReauth: async (email) => void (await fixture('/stale-reauth', { email })),
    drainImports: async () => void (await fixture('/drain-imports', {})),
    async stop() {
      await vite.close();
      await new Promise<void>((ok) => {
        child.once('exit', () => ok());
        child.stdin?.end();
        setTimeout(() => {
          child.kill('SIGTERM');
        }, 15_000).unref();
      });
    },
  };
}
