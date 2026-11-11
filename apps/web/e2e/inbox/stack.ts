// Boots a real stack for the module 37 (web/inbox) e2e specs, like e2e/agent/stack.ts:
//   1. the real API (createApiHarness: a fresh per-test Postgres database via createTestDb, the RLS-bound
//      app_user, deterministic fake providers) on a free port, as a child process inside apps/api;
//   2. a fixture control endpoint that seeds THROUGH THE API: the team, number and agent; a lead source with its
//      consent notice and a website-chat widget (Owner routes); chat leads started on module 22's public chat routes
//      exactly as a website visitor's widget calls them (no cookie, the site's Origin, a visitor IP), accepted by
//      the agent through the ownership engine; texts through the signed telephony webhook (including a real STOP);
//      phones added and removed through the contact routes. The superuser only reads state back (which contact a
//      chat session created, for the agent's accept) and runs two fixtures with no application path, each named
//      where it is used: the clock (a visitor gone 30 minutes) and a lead source's notice being replaced;
//   3. a Vite dev server for apps/web whose /api proxy points at that API. It is reached on two origins: the staff
//      app at http://localhost:<port> and a stand-in brokerage website at http://127.0.0.1:<port> (the widget's
//      allowed website), so every call the widget makes is a real cross-origin request answered by the API's own
//      CORS (Vite adds none: server.cors is off). For /api/public/chat/ the proxy states the visitor's IP as the
//      only X-Forwarded-For entry, replacing anything the browser sent, exactly as nginx does in production
//      (deploy/nginx.conf: proxy_set_header X-Forwarded-For $remote_addr after real-ip.conf); the API believes it only
//      because the proxy is a peer TRUST_PROXY lists (loopback here, the web container in production), so each test
//      can have its own visitor IP and rate-limit bucket (visitor()).
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, '../..');
const apiRoot = resolve(webRoot, '../api');

/** The notice the team's chat lead source shows website visitors before they write (its consent disclosure). */
export const CHAT_NOTICE = 'By starting a chat, you agree that Harbor & Pine Team may reply here and keep a record of this conversation.';

const CHILD = String.raw`
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createApiHarness, TEST_ORIGIN, TEST_PASSWORD } from './src/auth/testHarness.ts';
import { commsWorld, call, freshReauth, inboundSms, randomEmail } from './src/comms/testing.ts';
import { acceptLead } from './src/channels/testing.ts';
(async () => {
const origin = process.env.E2E_WEB_ORIGIN;
const site = process.env.E2E_SITE_ORIGIN;
const NOTICE = process.env.E2E_CHAT_NOTICE;
// trustProxy: the stack's proxy (Vite, on loopback) states the website visitor's IP, as nginx does in production,
// where TRUST_PROXY names the web container (never true: a client could then choose its own IP)
const h = await createApiHarness({ config: { webOrigins: [origin, TEST_ORIGIN], trustProxy: 'loopback' } });
await h.app.listen({ port: 0, host: '127.0.0.1' });
const apiPort = h.app.server.address().port;
let w = null;
let agent = null;
let widget = null;
let seq = 0;
let ipSeq = 0;
const phone = () => { seq += 1; return '+1415' + String(2000000 + ((Date.now() % 1000000) * 7 + seq * 7919) % 7999999).padStart(7, '0'); };
const visitorIp = () => { ipSeq += 1; return '198.51.100.' + ((ipSeq % 250) + 1); };
const must = (r, what) => { if (r.status >= 300) throw new Error(what + ': ' + r.status + ' ' + JSON.stringify(r.body)); return r.body; };
const body = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => ok(s ? JSON.parse(s) : {})); });
const sms = async (from, text) => { const r = await inboundSms(h, from, w.mainNumber, text); if (r.statusCode >= 300) throw new Error('inbound: ' + r.statusCode + ' ' + r.body); };
// module 22's public chat routes, called as a website visitor's widget calls them: no cookie, the site's Origin
const pub = (method, url, payload, ip) => h.app.inject({ method, url: '/api/public/chat' + url, headers: { origin: site, ...(payload ? { 'content-type': 'application/json' } : {}) }, payload: payload ? JSON.stringify(payload) : undefined, remoteAddress: ip ?? visitorIp() });
const ok = (r, what) => { if (r.statusCode !== 200) throw new Error(what + ': ' + r.statusCode + ' ' + r.body); return JSON.parse(r.body); };
// read back only: which session (and contact) a visitor's token belongs to
const sessionOf = async (token) => {
  const hash = createHash('sha256').update('webchat-session\n' + token, 'utf8').digest();
  const s = (await h.su.query('SELECT id, contact_id FROM webchat_sessions WHERE token_hash = $1', [hash])).rows[0];
  if (!s) throw new Error('no chat session for that token');
  return s;
};
const routes = {
  async '/world'() {
    w = await commsWorld(h, { agents: 1 });
    agent = w.agents[0];
    // the team's website chat: a lead source with the notice visitors see first, and a widget allowed on the site
    await freshReauth(h, w.owner);
    const src = must(await call(w.owner, 'POST', '/lead-sources', { name: 'Website chat', kind: 'website', consentDisclosure: { text: NOTICE, namesSeller: 'Harbor & Pine Team' } }), 'lead source');
    await freshReauth(h, w.owner);
    const wg = must(await call(w.owner, 'POST', '/admin/web-chat/widgets', { displayName: 'Website chat', leadSourceId: src.source.id, allowedOrigins: [site] }), 'widget');
    const cfg = ok(await pub('GET', '/' + wg.widgetKey), 'widget config');
    widget = { id: wg.widget.id, key: wg.widgetKey, sourceId: src.source.id, disclosureId: cfg.disclosure.id };
    return { email: agent.email, password: TEST_PASSWORD, widgetKey: wg.widgetKey, teamName: cfg.teamName, assistantNotice: cfg.assistantNotice };
  },
  // a website visitor starts a chat (module 22's public start route, as the widget calls it); the lead is offered to
  // the agent, who accepts it; optionally the agent adds the phone the visitor then texts from, and the visitor writes
  // again in the chat
  async '/chat-lead'(b) {
    const start = ok(await pub('POST', '/' + widget.key + '/start', { name: b.name, email: randomEmail(), message: b.opening, disclosureId: widget.disclosureId }), 'chat start');
    const token = start.sessionToken;
    const s = await sessionOf(token);
    await acceptLead(h, [agent], s.contact_id);
    let texted = null;
    if (b.text) {
      texted = phone();
      must(await call(agent, 'POST', '/contacts/' + s.contact_id + '/points', { kind: 'phone', address: texted, label: 'mobile' }), 'add phone');
      await sms(texted, b.text);
    }
    for (const message of b.chat ?? []) ok(await pub('POST', '/session/' + token + '/messages', { message, clientMessageId: randomUUID() }), 'chat message');
    return { id: s.contact_id, name: b.name, token, phone: texted };
  },
  // the agent accepts the lead a visitor's widget started (the token is the widget's own, from its tab)
  async '/accept-chat'(b) {
    const s = await sessionOf(b.token);
    await acceptLead(h, [agent], s.contact_id);
    return { id: s.contact_id };
  },
  // what the visitor's widget would get on its next poll (module 22's public poll route)
  async '/poll'(b) {
    return ok(await pub('GET', '/session/' + b.token + '/poll' + (b.after ? '?after=' + encodeURIComponent(b.after) : '')), 'poll');
  },
  // clock fixture: the visitor was last seen 31 minutes ago, so the chat has ended (E77; no application path moves time).
  // A poll already in flight when the clock moves would still touch the session, so this waits until it stays aged.
  async '/age-chat'(b) {
    const s = await sessionOf(b.token);
    for (let i = 0; i < 10; i += 1) {
      await h.su.query("UPDATE webchat_sessions SET last_seen_at = now() - interval '31 minutes', started_at = LEAST(started_at, now() - interval '40 minutes') WHERE id = $1", [s.id]);
      await new Promise((ok) => setTimeout(ok, 750));
      const idle = (await h.su.query("SELECT last_seen_at < now() - interval '30 minutes' AS idle FROM webchat_sessions WHERE id = $1", [s.id])).rows[0];
      if (idle.idle) return {};
    }
    throw new Error('the chat session kept being touched');
  },
  // fixture: the team replaces its chat notice. No route edits a lead source's consent disclosure yet, so the superuser
  // writes what that edit would: a new stored notice, now the lead source's current one
  async '/replace-notice'(b) {
    const id = randomUUID();
    await h.su.query(
      "INSERT INTO consent_disclosures (tenant_id, id, channel_scope, purpose_scope, body, body_sha256, names_seller, source_kind) VALUES ($1,$2,ARRAY['sms'],ARRAY['informational'],$3,$4,'Harbor & Pine Team','own_form')",
      [w.tenantId, id, b.text, createHash('sha256').update(b.text).digest('hex')],
    );
    await h.su.query('UPDATE lead_sources SET consent_disclosure_id = $2 WHERE id = $1', [widget.sourceId, id]);
    widget.disclosureId = id;
    return {};
  },
  // real starts from one visitor IP until the API's per-IP start limit answers 429 (E137)
  async '/exhaust-starts'(b) {
    for (let n = 1; n <= 30; n += 1) {
      const r = await pub('POST', '/' + widget.key + '/start', { name: 'Flood Visitor', phone: '+14155550100', message: 'hello', disclosureId: widget.disclosureId }, b.ip);
      if (r.statusCode === 429) return { starts: n - 1 };
      if (r.statusCode !== 200) throw new Error('start: ' + r.statusCode + ' ' + r.body);
    }
    throw new Error('the start limit never answered 429');
  },
  // a person the agent added who texted (and maybe opted out)
  async '/contact'(b) {
    const phones = [phone()];
    const c = must(await call(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: b.firstName ?? 'Jane', lastName: b.lastName ?? 'Doe', phones, emails: [randomEmail()], intent: 'buyer' }), 'contact');
    const id = c.contact.id;
    if (b.text) await sms(phones[0], b.text);
    if (b.stopFromFirst) await sms(phones[0], 'STOP');
    // a second phone added AFTER the STOP (so the STOP's own fan-out never wrote a revoke on it)
    if (b.secondPhone) {
      const p2 = phone();
      must(await call(agent, 'POST', '/contacts/' + id + '/points', { kind: 'phone', address: p2 }), 'add phone');
      phones.push(p2);
    }
    // the agent removes the phone that texted STOP (R-PAR-12: its opt-out still blocks the person)
    if (b.removeFirst) {
      const p = (await h.su.query("SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND address = $2", [id, phones[0]])).rows[0];
      must(await call(agent, 'POST', '/contacts/' + id + '/points/' + p.id + '/remove', { reason: 'old' }), 'remove phone');
    }
    return { id, name: c.contact.displayName, phones };
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

export type FixturePath = '/world' | '/chat-lead' | '/accept-chat' | '/poll' | '/age-chat' | '/replace-notice' | '/exhaust-starts' | '/contact';

export interface World {
  email: string;
  password: string;
  widgetKey: string;
  teamName: string;
  assistantNotice: string;
}

export interface ChatLead {
  id: string;
  name: string;
  /** the visitor's session token (what their widget holds) */
  token: string;
  phone: string | null;
}

export interface Poll {
  messages: { id: string; body: string; sentAt: string; from: 'team' | 'assistant' }[];
  cursor: string | null;
  open: boolean;
}

export interface InboxStack {
  /** the staff app: http://localhost:<port> */
  webUrl: string;
  /** the stand-in brokerage website, another origin on the same server: http://127.0.0.1:<port> */
  siteUrl: string;
  /** the widget's stand-in page on the brokerage website, talking to the API across origins */
  widgetPage(widgetKey: string, o?: { site?: string }): string;
  /** the IP the API sees for the website visitor's chat calls from now on (each test can have its own) */
  visitor(ip: string): void;
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

export async function startInboxStack(): Promise<InboxStack> {
  const webPort = await freePort();
  const webOrigin = `http://localhost:${webPort}`;
  const siteOrigin = `http://127.0.0.1:${webPort}`;
  const child: ChildProcess = spawn('pnpm', ['exec', 'tsx', '--conditions=@realty/source', '-e', CHILD], {
    cwd: apiRoot,
    env: { ...process.env, E2E_WEB_ORIGIN: webOrigin, E2E_SITE_ORIGIN: siteOrigin, E2E_CHAT_NOTICE: CHAT_NOTICE },
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

  let visitorIp = '203.0.113.1';
  const vite: ViteDevServer = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, 'vite.config.ts'),
    logLevel: 'error',
    server: {
      port: webPort,
      strictPort: true,
      host: '127.0.0.1',
      // the API answers CORS for its public chat routes itself; Vite must not answer preflights in its place
      cors: false,
      proxy: {
        '/api': {
          target: `http://127.0.0.1:${ports.apiPort}`,
          changeOrigin: false,
          configure: (proxy) => {
            // replace, never append (what nginx does): the visitor's own X-Forwarded-For never reaches the API
            proxy.on('proxyReq', (proxyReq, req) => {
              if ((req.url ?? '').startsWith('/api/public/chat/')) proxyReq.setHeader('x-forwarded-for', visitorIp);
              else proxyReq.removeHeader('x-forwarded-for');
            });
          },
        },
      },
    },
  });
  await vite.listen();

  return {
    webUrl: webOrigin,
    siteUrl: siteOrigin,
    widgetPage: (widgetKey, o = {}) => `${o.site ?? siteOrigin}/src/widget/preview.html?key=${encodeURIComponent(widgetKey)}&api=${encodeURIComponent(`${webOrigin}/api`)}`,
    visitor(ip) {
      visitorIp = ip;
    },
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
