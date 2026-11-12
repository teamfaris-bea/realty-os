// Boots a real stack for the web/agent e2e specs and screenshots:
//   1. the real API (api/platform's createApiHarness: a fresh per-test Postgres database via
//      createTestDb, connecting as the RLS-bound app_user, deterministic fake providers) on a free port,
//      run as a child process INSIDE apps/api (`tsx -e`, cwd apps/api), so apps/web never imports
//      @realty/api or @realty/db code;
//   2. a fixture control endpoint on the same child that seeds an agent's day THROUGH THE API (team,
//      number, sender registration, an agent with a verified alert phone, owned contacts (no consent
//      entry: since the owner decision, leads are treated as consented through their source and only
//      opt-outs block), an inbound text through the signed telephony webhook (optionally a STOP, the
//      real opt-out path), a lead offer through the signed intake webhook, an assistant draft through POST /contacts/:id/drafts with the fake AI,
//      tasks, deals, listings). The superuser is used only to move an appointment into the past (a
//      clock fixture with no application path);
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
import { commsWorld, call, inboundSms, randomEmail, runJobs, telephonyWebhook } from './src/comms/testing.ts';
import { intake, contactState } from './src/leads/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN] } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let seq = 0;
// any US number works at any hour: the send-time check has no contact window any more (owner decision)
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const routes = {
  async '/world'() {
    w = await commsWorld(h, { agents: 1 });
    agent = w.agents[0];
    const p = phone();
    const ch = await agent.post('/api/me/alert-phone', { phone: p });
    const code = h.providers.telephony.verificationCodes.at(-1).code;
    const v = await agent.post('/api/me/alert-phone/verify', { challenge: ch.json().challenge, code });
    if (v.statusCode !== 200) throw new Error('alert phone: ' + v.statusCode + ' ' + v.body);
    return { email: agent.email, password: TEST_PASSWORD, ownerEmail: w.owner.email };
  },
  async '/contact'(b) {
    const p = phone();
    const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Jane', lastName: b.lastName ?? 'Doe', phones: [p], emails: [randomEmail()], intent: b.intent ?? 'buyer' }), 'contact');
    for (const text of [b.inbound, b.optOut ? 'STOP' : null]) {
      if (!text) continue;
      const r = await inboundSms(h, p, w.mainNumber, text);
      if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body);
    }
    return { id: c.contact.id, name: c.contact.displayName, phone: p };
  },
  // a text the agent scheduled, then the client replied: it is held for the agent's tap (E27)
  async '/held'(b) {
    const r = must(await call(agent, 'POST', '/contacts/' + b.contactId + '/messages', { channel: 'sms', body: b.body, idempotencyKey: 'k-' + randomUUID(), scheduleAt: new Date(Date.now() + 3600000).toISOString() }), 'schedule');
    const i = await inboundSms(h, b.phone, w.mainNumber, b.reply);
    if (i.statusCode >= 300) throw new Error('inbound: ' + i.statusCode + ' ' + i.body);
    // clock fixture: the scheduled time has come (no application path moves time)
    await h.su.query("UPDATE messages SET scheduled_for = clock_timestamp() - interval '1 second' WHERE id = $1", [r.message.id]);
    await runJobs(h, w.tenantId, ['comms.dispatch']);
    const m = (await h.su.query('SELECT status, status_reason FROM messages WHERE id = $1', [r.message.id])).rows[0];
    return { id: r.message.id, status: m.status, statusReason: m.status_reason };
  },
  // lane telephony-safeguards (R-TWL-11): an inbound MMS with text/plain parts through the signed webhook; the fake serves
  // each part by SID; read: how many leading parts comms.mms_text reads before the page opens (the rest stay pending)
  async '/mms-text'(b) {
    const hex = () => randomUUID().replace(/-/g, '');
    const mm = 'MM' + hex();
    const form = { MessageSid: mm, From: b.phone, To: w.mainNumber, Body: b.body ?? '', NumMedia: String(b.parts.length) };
    b.parts.forEach((t, i) => {
      const me = 'ME' + hex();
      form['MediaUrl' + i] = 'https://api.twilio.com/2010-04-01/Accounts/AC' + '1'.repeat(32) + '/Messages/' + mm + '/Media/' + me;
      form['MediaContentType' + i] = 'text/plain';
      h.providers.telephony.media.set(me, { bytes: new Uint8Array(Buffer.from(t, 'utf8')), contentType: 'text/plain' });
    });
    const r = await telephonyWebhook(h, '/webhooks/telephony/sms', form);
    if (r.statusCode >= 300) throw new Error('mms: ' + r.statusCode + ' ' + r.body);
    if (b.read) {
      const id = (await h.su.query('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0].id;
      // read the first part only: the second stays pending (the job reads every pending part, so hide the rest from it)
      await h.su.query("UPDATE jobs SET run_at = now() + interval '1 day' WHERE kind = 'comms.mms_text' AND payload->>'messageId' <> $1", [id]);
      const { readTextParts } = await import('./src/comms/mmsTextJob.ts');
      const { systemActor } = await import('./src/worker/systemActor.ts');
      const j = (await h.su.query("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [id])).rows[0].payload;
      await h.su.query("INSERT INTO message_media_skipped (tenant_id, message_id, position, reason, declared_type) SELECT tenant_id, message_id, position, 'FETCH_FAILED', 'text/plain' FROM message_text_parts WHERE message_id = $1 AND position >= $2", [id, b.read]);
      await readTextParts(systemActor(w.tenantId, 'provider'), { messageId: id, messageRef: j.messageRef, parts: j.parts }, w.deps);
      await h.su.query('DELETE FROM message_media_skipped WHERE message_id = $1 AND position >= $2', [id, b.read]);
    }
    return { ok: true };
  },
  // a text the agent tries through the API (the send-time check decides)
  async '/attempt'(b) {
    const r = must(await call(agent, 'POST', '/contacts/' + b.contactId + '/messages', { channel: 'sms', body: b.body, idempotencyKey: 'k-' + randomUUID() }), 'attempt');
    return { result: r.result, id: r.message && r.message.id };
  },
  // the agent records "do not call me" for the contact's phone (staff consent entry, agent_revoke)
  async '/dnc'(b) {
    const p = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' ORDER BY created_at LIMIT 1", [b.contactId])).rows[0];
    must(await call(agent, 'POST', '/contacts/' + b.contactId + '/consent', { kind: 'revoke', pointId: p.id, channel: 'voice', purpose: 'all', evidence: {} }), 'dnc');
    return { ok: true, agentName: agent.displayName ?? null };
  },
  async '/offer'(b) {
    const r = await intake(h, w, { inquiryType: 'buy', fullName: b.name ?? 'Pat Lead', phones: [phone()], message: b.message ?? 'Is 12 Oak St still available?', propertyText: '12 Oak St', postalCode: '94610' });
    const s = await contactState(h, r.contactId);
    return { id: r.contactId, state: s.ownership_state, offeredTo: s.offered_to_user_id, agent: agent.userId };
  },
  async '/draft'(b) {
    const r = must(await call(agent, 'POST', '/contacts/' + b.contactId + '/drafts', { commandId: randomUUID() }), 'draft');
    return { id: r.action.id, body: r.action.draft && r.action.draft.body };
  },
  async '/task'(b) {
    const r = must(await call(agent, 'POST', '/tasks', { title: b.title, contactId: b.contactId ?? null, dueAt: new Date(Date.now() + (b.inMs ?? 3600000)).toISOString() }), 'task');
    return { id: r.task.id };
  },
  async '/appointment'(b) {
    const start = new Date(Date.now() + 86400000);
    const r = must(await call(agent, 'POST', '/appointments', { kind: 'buyer_consult', startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 3600000).toISOString(), contactId: b.contactId }), 'appointment');
    // clock fixture: the consult ended 3 h ago (no application path moves time)
    await h.su.query("UPDATE appointments SET starts_at = clock_timestamp() - interval '4 hours', ends_at = clock_timestamp() - interval '3 hours' WHERE id = $1", [r.appointment.id]);
    return { id: r.appointment.id };
  },
  async '/deal'(b) {
    const r = must(await call(agent, 'POST', '/deals', { primaryContactId: b.contactId, side: 'buy', priceCents: 85000000, expectedCloseDate: '2026-12-18' }), 'deal');
    return { id: r.deal.id };
  },
  // an address on the person (module 57's add-address route; the web offers delete, not add)
  async '/address'(b) {
    const r = must(await call(agent, 'POST', '/contacts/' + b.contactId + '/addresses', { kind: b.kind ?? 'home', line1: b.line1 ?? '12 Oak St', city: b.city ?? 'Oakland', region: b.region ?? 'CA', postalCode: b.postalCode ?? '94610' }), 'address');
    return { id: r.address.id };
  },
  // an address as a CSV or FUB import stores it: a line longer than the add route allows, with a jurisdiction (a
  // superuser fixture; apps/api people/addressUndo.test.ts runs the real import), the input the Undo must restore
  async '/long-address'(b) {
    const id = randomUUID();
    await h.su.query("INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code, country, jurisdiction) VALUES ($1, $2, $3, 'home', $4, 'Oakland', 'CA', '94610', 'US', 'US-CA')", [w.tenantId, id, b.contactId, b.line1]);
    return { id };
  },
  async '/listing'() {
    const r = must(await call(agent, 'POST', '/listings', { status: 'active', addressLine1: '12 Oak St', city: 'Oakland', region: 'CA', postalCode: '94610', listPriceCents: 85000000, beds: 3, bathsX10: 20, sqft: 1450, propertyType: 'single_family' }), 'listing');
    return { id: r.listing.id };
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

export type FixturePath = '/world' | '/contact' | '/mms-text' | '/offer' | '/draft' | '/task' | '/appointment' | '/deal' | '/listing' | '/held' | '/attempt' | '/dnc' | '/address' | '/long-address';

export interface AgentStack {
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

export async function startAgentStack(): Promise<AgentStack> {
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
