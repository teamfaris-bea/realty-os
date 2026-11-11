// Boots a real stack for the bulk Assign / Start plan pickers and the stage-to-plan setting (same shape as
// e2e/parity-templates-bulk/stack.ts):
//   1. the real API (createApiHarness: a fresh per-test Postgres database, RLS-bound app_user, fake
//      providers) on a free port, as a child process INSIDE apps/api (apps/web never imports api/db code);
//   2. a fixture endpoint on the same child that seeds through the API: an Owner, an Admin, a Team Lead
//      leading agents Ana and Bo, a TC; Ana's people (6 tagged "Open house" in the Team Lead's team list, 7
//      tagged "Buyer" in Ana's own list: one already in a plan, one who texted STOP and has no email, one
//      "Vic" the Owner can reassign away mid-test); team plans (approved "Buyer plan", "Second plan" and
//      "Contract plan" (starts on Under contract), a draft-only "Draft plan"), Ana's and Bo's approved personal
//      plans, and the tenant's label "Active buyer" for Active. The bulk run is the real runner
//      (runBulkAction) called by the fixture instead of the worker loop. The superuser only names the members
//      (no application path sets a display name) and reads state back;
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
import { commsWorld, call, inboundSms, randomEmail } from './src/comms/testing.ts';
import { makeTag, tagContact } from './src/lists/testing.ts';
import { playbook, setStage } from './src/stageAutomation/testing.ts';
import { runBulkAction } from './src/bulk/run.ts';
import { totpCode, totpStep } from './src/auth/totp.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let ids = null;
let seq = 0;
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const name = (id, n) => h.su.query('UPDATE users SET display_name = $2 WHERE id = $1', [id, n]);
const secrets = new Map();
const routes = {
  async '/world'() {
    w = await commsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'tc'] });
    const [ana, bo] = w.agents;
    const [admin, tc] = w.others;
    const tl = w.teamLead;
    const people = { owner: w.owner, admin, team_lead: tl, ana, bo, tc };
    const names = { owner: 'Olivia Owens', admin: 'Adam Alvarez', team_lead: 'Sam Rivera', ana: 'Ana Diaz', bo: 'Bo Park', tc: 'Theo Clark' };
    for (const [k, c] of Object.entries(people)) await name(c.userId, names[k]);
    for (const c of [w.owner, admin]) secrets.set(c.email, c.totpSecret);
    const contact = async (firstName, lastName, o = {}) => {
      const p = phone();
      const c = must(await call(ana, 'POST', '/contacts', { commandId: randomUUID(), firstName, lastName, phones: [p], emails: o.noEmail ? [] : [randomEmail()] }), 'contact');
      if (o.stop) {
        const r = await inboundSms(h, p, w.mainNumber, 'STOP');
        if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body);
      }
      return c.contact.id;
    };
    // Ana's open-house leads, in the Team Lead's team list (a bulk assign as the Team Lead)
    const openHouse = await makeTag(ana, 'Open house');
    const assign = [];
    for (const n of ['Ada', 'Ben', 'Cal', 'Dot', 'Eve', 'Fay']) assign.push(await contact(n, 'Open'));
    for (const id of assign) must(await tagContact(ana, id, [openHouse.id]), 'tag');
    const def = (tagId) => ({ v: 1, all: [{ kind: 'tag', op: 'any', tagIds: [tagId] }] });
    must(await call(tl, 'POST', '/smart-lists', { scope: 'team', name: 'Open house', definition: def(openHouse.id) }), 'team list');
    // plans
    const buyerPlan = await playbook(w.owner, { scope: 'team', name: 'Buyer plan' });
    const secondPlan = await playbook(w.owner, { scope: 'team', name: 'Second plan' });
    const contractPlan = await playbook(w.owner, { scope: 'team', name: 'Contract plan' });
    must(await setStage(w.owner, contractPlan.id, 'under_contract'), 'contract stage');
    const draftPlan = await playbook(w.owner, { scope: 'team', name: 'Draft plan', approve: false });
    const anaPlan = await playbook(ana, { scope: 'agent', name: "Ana's check-ins" });
    const boPlan = await playbook(bo, { scope: 'agent', name: "Bo's plan" });
    must(await call(w.owner, 'PUT', '/stage-labels', { labels: { active: 'Active buyer' } }), 'stage labels');
    // Ana's buyers, in her own list (a bulk Start plan as Ana)
    const buyerTag = await makeTag(ana, 'Buyer');
    const buyers = [];
    for (const n of ['Gil', 'Hal', 'Ivy', 'Jo']) buyers.push(await contact(n, 'Buyer'));
    const vic = await contact('Vic', 'Moved');
    const pat = await contact('Pat', 'Planned');
    const uma = await contact('Uma', 'Stopped', { noEmail: true, stop: true });
    for (const id of [...buyers, vic, pat, uma]) must(await tagContact(ana, id, [buyerTag.id]), 'tag');
    must(await call(ana, 'POST', '/contacts/' + pat + '/enrollments', { playbookId: anaPlan.id }), 'enroll pat');
    must(await call(ana, 'POST', '/smart-lists', { scope: 'personal', name: 'Buyers', definition: def(buyerTag.id) }), 'buyers list');
    ids = { assign, buyers, vic, pat, uma, buyerPlan: buyerPlan.id, secondPlan: secondPlan.id, contractPlan: contractPlan.id, draftPlan: draftPlan.id, anaPlan: anaPlan.id, boPlan: boPlan.id };
    const users = Object.fromEntries(Object.entries(people).map(([k, c]) => [k, { email: c.email, password: TEST_PASSWORD, userId: c.userId, mfa: Boolean(c.totpSecret) }]));
    return { users, ids };
  },
  async '/totp'(b) {
    await h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE email = $1', [b.email]);
    return { code: totpCode(secrets.get(b.email), totpStep(Date.now())) };
  },
  async '/run'(b) {
    return { result: await runBulkAction(b.actionId, w.deps, w.tenantId) };
  },
  // the Owner reassigns one of Ana's people to Bo (Ana no longer sees them)
  async '/reassign'(b) {
    must(await call(w.owner, 'POST', '/leads/' + b.contactId + '/reassign', { commandId: randomUUID(), toUserId: w.agents[1].userId, reason: 'MANUAL' }), 'reassign');
    return { ok: true };
  },
  async '/owners'(b) {
    return { rows: (await h.su.query('SELECT id, owner_user_id FROM contacts WHERE id = ANY ($1::uuid[]) ORDER BY id', [b.ids])).rows };
  },
  async '/enrollments'(b) {
    return { rows: (await h.su.query('SELECT contact_id, playbook_id, enrolled_by, enrolled_by_user_id FROM playbook_enrollments WHERE contact_id = ANY ($1::uuid[]) ORDER BY contact_id', [b.ids])).rows };
  },
  async '/stage'(b) {
    return { stage: (await h.su.query('SELECT auto_enroll_stage FROM playbooks WHERE id = $1', [b.playbookId])).rows[0].auto_enroll_stage };
  },
  // the notices a bulk action left (its results, and an assign's one summary per affected user)
  async '/notices'(b) {
    return { rows: (await h.su.query('SELECT user_id, kind, title FROM notifications WHERE subject_id = $1 ORDER BY kind, user_id', [b.subjectId])).rows };
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

export type FixturePath = '/world' | '/totp' | '/run' | '/reassign' | '/owners' | '/enrollments' | '/stage' | '/notices';

export type Who = 'owner' | 'admin' | 'team_lead' | 'ana' | 'bo' | 'tc';

export interface PickersWorld {
  users: Record<Who, { email: string; password: string; userId: string; mfa: boolean }>;
  ids: { assign: string[]; buyers: string[]; vic: string; pat: string; uma: string; buyerPlan: string; secondPlan: string; contractPlan: string; draftPlan: string; anaPlan: string; boPlan: string };
}

export interface PickersStack {
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

export async function startPickersStack(): Promise<PickersStack> {
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
