// pnpm load:bench [--db realty_load] [--iterations 40] [--explain] [--out file.json] [--pool 20] [--offers 200] [--profile]
// Measures p50/p95 of the phone-critical reads and the concurrent writes on a database seeded by
// load:seed, through the REAL server (buildServer + app.inject): session cookie resolution, the route's
// authorization, withTenantTx (SET LOCAL tenant/user/actor exactly as production), the repositories,
// RLS as app_user, response serialization. Providers are the deterministic fakes (no network).
//
// --explain turns on auto_explain for the load database (ANALYZE, BUFFERS, nested statements, every
// statement >= --explain-ms) and collects the plans of the app's own queries from the server log. The
// plans are of the exact SQL the API sends, under the exact RLS context. Timings of an --explain run are
// inflated by the instrumentation and are not reported as results.
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import type { Role, TenantId, UserId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { type Database, createDatabase } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { csrfTokenFor } from '../auth/tokens.js';
import { issueSessionTx } from '../auth/sessions.js';
import { testConfig } from '../auth/testHarness.js';
import { FakeFub } from '../imports/fub.js';
import { makeImportHandlers } from '../imports/handlers.js';
import { createFakeProviders } from '../providers/index.js';
import { routeModules } from '../routes.js';
import { buildServer } from '../server.js';
import { createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { loadUrls } from './db.js';
import { loadUuid } from './generate.js';
import { type Phases, type Sample, describePhases, instrumentPool, runProfiled, sampled } from './profile.js';
import { argValue } from './seed.js';

export interface Measurement {
  name: string;
  /** the budget this operation is held to, and where it comes from */
  budgetMs: number | null;
  budgetSource: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  pass: boolean | null;
  note?: string;
}

export interface BenchResult {
  db: string;
  at: string;
  machine: { cpu: string; cores: number; ramGb: number; postgres: string };
  sizes: Record<string, number>;
  results: Measurement[];
  checks: { name: string; ok: boolean; detail: string }[];
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * p) - 1))] ?? NaN;
};

interface Session {
  label: string;
  userId: string;
  role: Role;
  cookie: string;
  csrf: string;
}

const ORIGIN = 'http://localhost:5173';

export class LoadBench {
  readonly results: Measurement[] = [];
  readonly checks: { name: string; ok: boolean; detail: string }[] = [];
  /** only operations whose name matches run (--only) */
  only: RegExp | null = null;
  /** --profile: per-request pool wait / connection hold, backend wait sampling (profile.ts) */
  profile = false;
  private constructor(
    readonly app: FastifyInstance,
    readonly database: Database,
    readonly su: pg.Pool,
    readonly tenantId: string,
    readonly iterations: number,
    readonly log: (s: string) => void,
    readonly sessionSecret: Uint8Array,
  ) {}

  static async open(o: { db: string; iterations: number; log: (s: string) => void; poolMax?: number }): Promise<LoadBench> {
    const urls = loadUrls(o.db);
    const database = createDatabase({ url: urls.appUserUrl, max: o.poolMax ?? 20, applicationName: 'load-bench' });
    instrumentPool(database.pool);
    const su = new pg.Pool({ connectionString: urls.ownerUrl, max: 2 });
    const config = testConfig({ logLevel: 'error' }, { KEK_BASE64: process.env.KEK_BASE64, ...(process.env.KEK_REF ? { KEK_REF: process.env.KEK_REF } : {}) });
    const clock = { now: () => instant(Date.now()) };
    const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
    const providers = createFakeProviders({ clock });
    const app = buildServer(config, { providers, clock, ids, db: database, routeModules, logStream: { write: (line: string) => { if (/"level":(50|60)/.test(line)) process.stderr.write(line); } } });
    await app.ready();
    return new LoadBench(app, database, su, loadUuid('load-big', 'tenant'), o.iterations, o.log, config.sessionSecret);
  }

  async close(): Promise<void> {
    await this.app.close();
    await this.database.close();
    await this.su.end();
  }

  /** An MFA-verified, freshly re-authenticated session for `userId`, issued by the real session code. */
  async session(label: string, userId: string, role: Role): Promise<Session> {
    const p = this.app.platform;
    const s = await issueSessionTx(p.db, p.ids, { userId: userId as UserId, tenant: { id: this.tenantId as TenantId, role }, mfaVerified: true, reauthenticated: true, ip: '203.0.113.50', userAgent: 'load-bench' });
    return { label, userId, role, cookie: s.token, csrf: csrfTokenFor(this.sessionSecret, s.sessionId) };
  }

  async req<T = Record<string, unknown>>(s: Session, method: string, url: string, body?: unknown): Promise<{ status: number; body: T; ms: number; phases?: Phases }> {
    if (!this.profile) return this.req0<T>(s, method, url, body);
    const { result, phases } = await runProfiled(() => this.req0<T>(s, method, url, body));
    return { ...result, phases };
  }

  /** Runs one concurrent batch; with --profile also samples the backends and logs the phase breakdown. */
  async batch<R extends { ms: number; phases?: Phases }>(name: string, fn: () => Promise<R[]>): Promise<R[]> {
    if (!this.profile) return fn();
    const { result, sample } = await sampled(this.su, 'load-bench', fn);
    this.samples.push({ name, rows: result.map((r) => ({ ms: r.ms, phases: r.phases! })), sample });
    return result;
  }

  readonly samples: { name: string; rows: { ms: number; phases: Phases }[]; sample: Sample }[] = [];

  /** Logs the merged breakdown of every batch whose name starts with `prefix`. */
  logProfile(prefix: string): void {
    const xs = this.samples.filter((x) => x.name.startsWith(prefix));
    if (xs.length === 0) return;
    const waits = new Map<string, number>();
    for (const x of xs) for (const [k, n] of x.sample.waits) waits.set(k, (waits.get(k) ?? 0) + n);
    const sum = (f: (s: Sample) => number) => xs.reduce((a, x) => a + f(x.sample), 0);
    const wallMs = sum((s) => s.wallMs);
    const merged: Sample = { dbCpuMs: sum((s) => s.dbCpuMs), waits, samples: sum((s) => s.samples), machineCpuBusy: sum((s) => s.machineCpuBusy * s.wallMs) / wallMs, nodeCpuMs: sum((s) => s.nodeCpuMs), wallMs };
    this.log(describePhases(prefix, xs.flatMap((x) => x.rows), merged));
  }

  private async req0<T>(s: Session, method: string, url: string, body?: unknown): Promise<{ status: number; body: T; ms: number }> {
    const headers: Record<string, string> = { 'user-agent': 'load-bench', cookie: `__Host-sid=${s.cookie}` };
    if (method !== 'GET') {
      headers.origin = ORIGIN;
      headers['x-csrf-token'] = s.csrf;
    }
    if (body !== undefined) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    const r = await this.app.inject({ method: method as 'GET', url: `/api${url}`, headers, remoteAddress: '203.0.113.50', ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
    const ms = performance.now() - t0;
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.body);
    } catch {
      parsed = r.body;
    }
    return { status: r.statusCode, body: parsed as T, ms };
  }

  /** Sequential timings of `fn` (after `warmup` untimed calls); every call must succeed. */
  async measure(name: string, budget: [number | null, string], fn: (i: number) => Promise<number>, o: { n?: number; warmup?: number; note?: string } = {}): Promise<Measurement> {
    const n = o.n ?? this.iterations;
    if (this.only && !this.only.test(name)) return { name, budgetMs: null, budgetSource: 'skipped', n: 0, p50: NaN, p95: NaN, max: NaN, pass: null };
    for (let i = 0; i < (o.warmup ?? Number(process.env.LOAD_WARMUP ?? 2)); i++) await fn(-1 - i).catch(() => 0);
    const times: number[] = [];
    const errors: string[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      try {
        times.push(await fn(i));
      } catch (e) {
        // a failed call (statement timeout, 5xx) is a result: it counts at the time it took to fail
        times.push(performance.now() - t0);
        errors.push(String(e instanceof Error ? e.message : e).slice(0, 120));
      }
    }
    const m = this.record(name, budget, times, errors.length > 0 ? `${errors.length}/${n} calls FAILED (${errors[0]})${o.note ? `; ${o.note}` : ''}` : o.note);
    if (errors.length > 0) m.pass = false;
    return m;
  }

  record(name: string, [budgetMs, budgetSource]: [number | null, string], times: number[], note?: string): Measurement {
    if ((this.only && !this.only.test(name)) || times.length === 0) return { name, budgetMs, budgetSource, n: 0, p50: NaN, p95: NaN, max: NaN, pass: null };
    const m: Measurement = { name, budgetMs, budgetSource, n: times.length, p50: pct(times, 0.5), p95: pct(times, 0.95), max: Math.max(...times), pass: budgetMs === null ? null : pct(times, 0.95) < budgetMs, ...(note ? { note } : {}) };
    this.results.push(m);
    this.log(`${m.pass === false ? 'MISS' : m.pass ? 'ok  ' : '    '} ${name}: p50 ${m.p50.toFixed(1)} ms, p95 ${m.p95.toFixed(1)} ms, max ${m.max.toFixed(1)} ms (n=${m.n}${budgetMs !== null ? `, budget ${budgetMs} ms` : ''})${note ? ` — ${note}` : ''}`);
    return m;
  }

  check(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, detail });
    this.log(`${ok ? 'ok  ' : 'FAIL'} check ${name}: ${detail}`);
  }

  async q<R extends pg.QueryResultRow>(text: string, values: unknown[] = []): Promise<R[]> {
    return (await this.su.query<R>(text, values)).rows;
  }
}

/** Budgets: BUILD_PLAN exit criterion 4 / module 14 where they exist, else the lane's 300 ms phone-read rule. */
export const BUDGET = {
  feed: [150, 'BUILD_PLAN exit criterion 4 (feed p95 < 150 ms)'] as [number, string],
  search: [300, 'BUILD_PLAN exit criterion 4 (search p95 < 300 ms)'] as [number, string],
  phoneRead: [300, 'lane rule: phone reads p95 < 300 ms'] as [number, string],
  write: [300, 'lane rule applied to the tap (p95 < 300 ms); no doc budget'] as [number, string],
  none: [null, 'no budget in the docs; reported only'] as [null, string],
};

async function expectOk(r: { status: number; ms: number; body: unknown }, what: string): Promise<number> {
  if (r.status >= 300) throw new Error(`${what} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.ms;
}

interface Actors {
  busy: Session;
  median: Session;
  lead: Session;
  admin: Session;
  owner: Session;
  tc: Session;
  agents: { userId: string; s: Session }[];
}

async function actors(b: LoadBench): Promise<Actors> {
  const T = b.tenantId;
  const books = await b.q<{ user_id: string; n: string }>(
    `SELECT m.user_id, count(c.id)::text AS n FROM memberships m LEFT JOIN contacts c ON c.tenant_id = m.tenant_id AND c.owner_user_id = m.user_id
      WHERE m.tenant_id = $1 AND m.role = 'agent' GROUP BY 1 ORDER BY count(c.id) DESC, 1`, [T]);
  const busyId = books[0]!.user_id;
  const medianId = books[Math.floor(books.length / 2)]!.user_id;
  b.log(`agents: ${books.length}; busiest book ${books[0]!.n} contacts, median ${books[Math.floor(books.length / 2)]!.n}`);
  const agents = [];
  for (const [i, a] of books.entries()) agents.push({ userId: a.user_id, s: await b.session(`agent${i}`, a.user_id, 'agent') });
  return {
    busy: agents.find((a) => a.userId === busyId)!.s,
    median: agents.find((a) => a.userId === medianId)!.s,
    lead: await b.session('lead', loadUuid('load-big', 'user:lead:1'), 'team_lead'),
    admin: await b.session('admin', loadUuid('load-big', 'user:admin:1'), 'admin'),
    owner: await b.session('owner', loadUuid('load-big', 'user:owner'), 'owner'),
    tc: await b.session('tc', loadUuid('load-big', 'user:tc:1'), 'tc'),
    agents,
  };
}

// ---- the operations ---------------------------------------------------------------------------------------

export async function benchReads(b: LoadBench, a: Actors): Promise<void> {
  const T = b.tenantId;
  // 1. priority feed (the first call per agent persists its cards; later calls are the steady state)
  for (const [label, s] of [['busiest agent', a.busy], ['median agent', a.median]] as const) {
    // a failed feed (e.g. the 30 s statement timeout) is a result, not a harness error: it counts at its time
    let failures = 0;
    const m = await b.measure(`feed: GET /feed (${label})`, BUDGET.feed, async () => {
      const r = await b.req(s, 'GET', '/feed');
      if (r.status >= 300) failures += 1;
      return r.ms;
    }, { n: Number(process.env.LOAD_FEED_N ?? b.iterations) });
    if (failures > 0) {
      m.note = `${failures}/${m.n} timed calls failed (HTTP 500, statement timeout); times are until the failure`;
      m.pass = false;
    }
  }

  // 1b. priority feed under activity (lane perf-misses): before each timed call three client messages arrive in
  //     the agent's book (copies of existing inbound texts, written as the owner role: every trigger runs), so the
  //     GET itself re-scores the dirty groups, as if the background feed.materialize job had not run yet
  {
    const cols = (await b.q<{ c: string }>(`SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS c FROM pg_attribute
       WHERE attrelid = 'messages'::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''`, []))[0]!.c;
    const sources = (await b.q<{ id: string }>(`SELECT m.id FROM messages m JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
       WHERE m.tenant_id = $1 AND c.owner_user_id = $2 AND c.ownership_state = 'owned' AND m.direction = 'inbound' AND NOT m.imported
       ORDER BY hashtext(m.id::text) LIMIT 300`, [T, a.busy.userId])).map((r) => r.id);
    let k = 0;
    await b.measure('feed: GET /feed after 3 new client messages (busiest agent)', BUDGET.feed, async () => {
      for (let j = 0; j < 3; j++) {
        const src = sources[k++ % Math.max(1, sources.length)];
        if (src) await b.q(`INSERT INTO messages (${cols}) SELECT ${cols.split(', ').map((c) => `(r).${c}`).join(', ')}
            FROM (SELECT jsonb_populate_record(m, jsonb_build_object('id', gen_random_uuid(), 'occurred_at', now(), 'created_at', now(),
                  'provider_message_ref', NULL, 'idempotency_key', NULL)) AS r FROM messages m WHERE m.id = $1) x`, [src]);
      }
      return (await b.req(a.busy, 'GET', '/feed')).ms;
    });
  }

  // 2. search: names, phone digits, email prefixes, no match — as the busiest agent (RLS-narrowed) and the admin
  const own = await b.q<{ first_name: string; last_name: string; phone: string | null; email: string | null }>(
    `SELECT c.first_name, c.last_name,
            (SELECT p.address FROM contact_points p WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.kind = 'phone' LIMIT 1) AS phone,
            (SELECT p.address FROM contact_points p WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.kind = 'email' LIMIT 1) AS email
       FROM contacts c WHERE c.tenant_id = $1 AND c.owner_user_id = $2 ORDER BY hashtext(c.id::text) LIMIT 20`, [T, a.busy.userId]);
  const queries: string[] = [];
  for (const c of own) {
    queries.push(c.first_name.slice(0, 3).toLowerCase(), `${c.first_name} ${c.last_name.slice(0, 2)}`, c.last_name);
    if (c.phone) queries.push(c.phone.slice(-7), `(${c.phone.slice(2, 5)}) ${c.phone.slice(5, 8)}-${c.phone.slice(8)}`);
    if (c.email) queries.push(c.email.slice(0, 8));
  }
  queries.push('zzqxv', 'Smith', 'mar', 'jo');
  const byKind: Record<string, string[]> = { name: [], phone: [], email: [] };
  for (const q of queries) (/^[\d() -]+$/.test(q) ? byKind.phone! : q.includes('.') ? byKind.email! : byKind.name!).push(q);
  for (const [label, s] of [['agent', a.busy], ['admin', a.admin]] as const) {
    for (const [kind, qs] of Object.entries(byKind)) {
      await b.measure(`search ${kind}: GET /search (${label})`, BUDGET.search, async (i) => {
        const q = qs[(i + qs.length * 10) % qs.length]!;
        const r = await b.req<{ incomplete?: string[] }>(s, 'GET', `/search?q=${encodeURIComponent(q)}`);
        if ((r.body.incomplete ?? []).length > 0) b.log(`  search "${q}" incomplete: ${r.body.incomplete!.join(',')}`);
        return expectOk(r, 'search');
      });
    }
  }

  // 3./4. contact page and thread: the calls the web pages make on open, in parallel like the browser
  const pageContacts = await b.q<{ id: string; n: string }>(
    `SELECT c.id, count(m.id)::text AS n FROM contacts c LEFT JOIN messages m ON m.tenant_id = c.tenant_id AND m.contact_id = c.id
      WHERE c.tenant_id = $1 AND c.owner_user_id = $2 GROUP BY c.id ORDER BY hashtext(c.id::text) LIMIT 40`, [T, a.busy.userId]);
  const chatty = await b.q<{ id: string; n: string }>(
    `SELECT m.contact_id AS id, count(*)::text AS n FROM messages m JOIN contacts c ON c.tenant_id = m.tenant_id AND c.id = m.contact_id
      WHERE m.tenant_id = $1 AND c.owner_user_id = $2 GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 20`, [T, a.busy.userId]);
  const contactPage = async (s: Session, id: string, timings?: Record<string, number[]>) => {
    const calls: [string, string, string, unknown?][] = [
      ['contact', 'GET', `/contacts/${id}`],
      ['timeline', 'GET', `/contacts/${id}/timeline?limit=100`],
      ['tasks', 'GET', `/tasks?contactId=${id}&scope=visible&status=open`],
      ['deals', 'GET', `/deals?contactId=${id}`],
      ['inbox', 'GET', '/assistant/inbox'],
      ['send check', 'POST', `/contacts/${id}/messages/preview`, { channel: 'sms', body: 'Checking in' }],
    ];
    const t0 = performance.now();
    const rs = await Promise.all(calls.map(([, m, u, body]) => b.req(s, m, u, body)));
    const wall = performance.now() - t0;
    rs.forEach((r, i) => {
      // the send check legitimately answers 422 for a contact without a phone (CONTACT_POINT_MISSING)
      if (r.status >= 300 && !(calls[i]![0] === 'send check' && r.status === 422)) throw new Error(`${calls[i]![2]} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      timings?.[calls[i]![0]]?.push(r.ms);
    });
    return wall;
  };
  {
    const parts: Record<string, number[]> = { contact: [], timeline: [], tasks: [], deals: [], inbox: [], 'send check': [] };
    await b.measure('contact page: 6 calls in parallel (busiest agent)', BUDGET.phoneRead, (i) => contactPage(a.busy, pageContacts[(i + 40) % pageContacts.length]!.id, i >= 0 ? parts : undefined));
    for (const [k, xs] of Object.entries(parts)) b.record(`  contact page part: ${k}`, BUDGET.phoneRead, xs, 'measured inside the parallel page load');
  }
  await b.measure('contact timeline alone: GET /contacts/:id/timeline?limit=100', BUDGET.phoneRead, async (i) =>
    expectOk(await b.req(a.busy, 'GET', `/contacts/${pageContacts[(i + 40) % pageContacts.length]!.id}/timeline?limit=100`), 'timeline'));
  await b.measure(`thread: contact + timeline (chattiest contacts, ${chatty[0]?.n ?? 0}–${chatty.at(-1)?.n ?? 0} messages)`, BUDGET.phoneRead, async (i) => {
    const id = chatty[(i + 20) % chatty.length]!.id;
    const t0 = performance.now();
    const rs = await Promise.all([b.req(a.busy, 'GET', `/contacts/${id}`), b.req(a.busy, 'GET', `/contacts/${id}/timeline?limit=100`)]);
    for (const r of rs) await expectOk(r, 'thread');
    return performance.now() - t0;
  });
  // the TC sees contacts only through deals (the "TC on 1,000 deals" visibility path, ARCHITECTURE §risks)
  const tcContacts = await b.q<{ id: string }>(
    `SELECT d.primary_contact_id AS id FROM deals d JOIN deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
      WHERE d.tenant_id = $1 AND dm.user_id = $2 ORDER BY hashtext(d.id::text) LIMIT 20`, [T, a.tc.userId]);
  if (tcContacts.length > 0) {
    await b.measure('thread as the TC (deal visibility): contact + timeline', BUDGET.phoneRead, async (i) => {
      const id = tcContacts[(i + 20) % tcContacts.length]!.id;
      const t0 = performance.now();
      const rs = await Promise.all([b.req(a.tc, 'GET', `/contacts/${id}`), b.req(a.tc, 'GET', `/contacts/${id}/timeline?limit=100`)]);
      for (const r of rs) await expectOk(r, 'tc thread');
      return performance.now() - t0;
    });
  }

  // 5. exception queue
  for (const [label, s] of [['team lead', a.lead], ['admin', a.admin], ['busiest agent', a.busy]] as const) {
    await b.measure(`exception queue: GET /team/exceptions?state=live&limit=200 (${label})`, BUDGET.phoneRead, async () =>
      expectOk(await b.req(s, 'GET', '/team/exceptions?state=live&limit=200'), 'exceptions'));
  }

  // 6. scoreboard
  await b.measure('scoreboard: GET /scoreboard?range=7d (busiest agent)', BUDGET.phoneRead, async () => expectOk(await b.req(a.busy, 'GET', '/scoreboard?range=7d'), 'scoreboard'));
  await b.measure('scoreboard: GET /scoreboard?range=90d (busiest agent)', BUDGET.phoneRead, async () => expectOk(await b.req(a.busy, 'GET', '/scoreboard?range=90d'), 'scoreboard'));
  for (const [label, s] of [['team lead', a.lead], ['admin', a.admin]] as const) {
    await b.measure(`team scoreboard: GET /team/scoreboard?range=30d (${label})`, BUDGET.phoneRead, async () => expectOk(await b.req(s, 'GET', '/team/scoreboard?range=30d'), 'team scoreboard'));
    await b.measure(`team momentum: GET /team/momentum (${label})`, BUDGET.phoneRead, async () => expectOk(await b.req(s, 'GET', '/team/momentum'), 'momentum'));
  }

  // 7. ponds
  const pond = loadUuid('load-big', 'pond:default');
  await b.measure('pond cards: GET /ponds/:id/cards?limit=50 (median agent)', BUDGET.phoneRead, async () => expectOk(await b.req(a.median, 'GET', `/ponds/${pond}/cards?limit=50`), 'pond cards'));
  await b.measure('pond cards: GET /ponds/:id/cards?limit=50 (team lead)', BUDGET.phoneRead, async () => expectOk(await b.req(a.lead, 'GET', `/ponds/${pond}/cards?limit=50`), 'pond cards'));
  await b.measure('pond list: GET /ponds (admin)', BUDGET.phoneRead, async () => expectOk(await b.req(a.admin, 'GET', '/ponds'), 'ponds'));
}

/** 8. accept and claim under concurrency: correctness (exactly one winner) and latency. */
export async function benchOwnership(b: LoadBench, a: Actors, o: { contested: number; racers: number; offers?: number }): Promise<void> {
  const T = b.tenantId;
  // accept: every live offer accepted by its offeree, all at once
  const offers = await b.q<{ id: string; offer_id: string; offered_to_user_id: string; ownership_seq: string }>(
    `SELECT id, offer_id, offered_to_user_id, ownership_seq::text FROM contacts WHERE tenant_id = $1 AND ownership_state = 'offered' ORDER BY id LIMIT $2`, [T, o.offers ?? 200]);
  const sessionOf = new Map(a.agents.map((x) => [x.userId, x.s]));
  // every agent works through their own offers one tap at a time; all agents at once
  const byAgent = new Map<string, typeof offers>();
  for (const c of offers) byAgent.set(c.offered_to_user_id, [...(byAgent.get(c.offered_to_user_id) ?? []), c]);
  const acc: { status: number; ms: number; body: { error?: { code: string } }; phases?: Phases }[] = [];
  await b.batch('accept', async () => {
    await Promise.all([...byAgent].map(async ([agent, mine]) => {
      for (const c of mine) acc.push(await b.req<{ error?: { code: string } }>(sessionOf.get(agent)!, 'POST', `/leads/${c.id}/accept`, { commandId: randomUUID(), offerId: c.offer_id, expectedSeq: Number(c.ownership_seq) }));
    }));
    return acc;
  });
  const accOk = acc.filter((r) => r.status === 200).length;
  if (offers.length === 0) b.log('accept: no live offers left (the bench consumes them; re-seed for a fresh run)');
  else b.record(`accept: ${offers.length} live offers, ${byAgent.size} agents accepting at once`, BUDGET.write, acc.map((r) => r.ms));
  b.logProfile('accept');
  b.check('accept: every live offer accepted by its offeree', accOk === offers.length, `${accOk}/${offers.length} accepted; others: ${[...new Set(acc.filter((r) => r.status !== 200).map((r) => `${r.status} ${r.body.error?.code}`))].join(', ') || 'none'}`);

  // contested claims: `racers` agents tap Claim on the same pond lead at the same moment (E1)
  const pond = loadUuid('load-big', 'pond:default');
  const leads = await b.q<{ id: string; ownership_seq: string }>(
    `SELECT id, ownership_seq::text FROM contacts WHERE tenant_id = $1 AND ownership_state = 'in_pond' AND pond_id = $2 ORDER BY hashtext(id::text) LIMIT $3`, [T, pond, o.contested + a.agents.length]);
  // the load tenant's capacity cap is at its maximum (50 uncontacted leads); racers are the agents with the
  // smallest uncontacted backlog so the race, not CAPACITY_REACHED, decides every claim
  await b.su.query(`UPDATE tenant_settings SET uncontacted_capacity_cap = 50 WHERE tenant_id = $1`, [T]);
  const backlog = new Map((await b.q<{ owner_user_id: string; n: string }>(
    `SELECT owner_user_id, count(*)::text AS n FROM contacts WHERE tenant_id = $1 AND ownership_state = 'owned' AND first_touch_at IS NULL GROUP BY 1`, [T])).map((r) => [r.owner_user_id, Number(r.n)]));
  const racers = [...a.agents].sort((x, y) => (backlog.get(x.userId) ?? 0) - (backlog.get(y.userId) ?? 0)).slice(0, Math.min(o.racers, a.agents.length));
  const times: number[] = [];
  let exactlyOne = 0;
  const loserCodes = new Map<string, number>();
  for (const lead of leads.slice(0, o.contested)) {
    const rs = await b.batch('claim race', () => Promise.all(racers.map((r) => b.req<{ error?: { code: string } }>(r.s, 'POST', `/leads/${lead.id}/claim`, { commandId: randomUUID(), pondId: pond }))));
    times.push(...rs.map((r) => r.ms));
    if (rs.filter((r) => r.status === 200).length === 1) exactlyOne += 1;
    for (const r of rs.filter((x) => x.status !== 200)) loserCodes.set(`${r.status} ${r.body.error?.code}`, (loserCodes.get(`${r.status} ${r.body.error?.code}`) ?? 0) + 1);
  }
  b.record(`claim: ${o.contested} pond leads, ${racers.length} agents racing on each (all requests)`, BUDGET.write, times);
  b.logProfile('claim race');
  b.check('claim race (E1): exactly one winner per lead', exactlyOne === o.contested, `${exactlyOne}/${o.contested}; losers: ${[...loserCodes].map(([k, v]) => `${k} ×${v}`).join(', ')}`);
  // a loser is told why with a 409: the race (LEAD_ALREADY_CLAIMED / LEAD_STATE_CHANGED) or, for an agent
  // who already holds the tenant's cap of uncontacted leads, CAPACITY_REACHED; never a 2xx or a 5xx
  const lostOk = [...loserCodes.keys()].every((k) => ['409 LEAD_ALREADY_CLAIMED', '409 LEAD_STATE_CHANGED', '409 CAPACITY_REACHED'].includes(k));
  b.check('claim race (E1): every loser gets a 409 naming the reason', lostOk, [...loserCodes.keys()].join(', ') || 'no losers');

  // uncontested claims: every agent claims a different lead at the same time
  const claimers = a.agents.filter((x) => (backlog.get(x.userId) ?? 0) + o.contested < 50);
  const rest = leads.slice(o.contested, o.contested + claimers.length);
  const t0 = performance.now();
  const un = await b.batch('claim uncontested', () => Promise.all(rest.map((lead, i) => b.req(claimers[i]!.s, 'POST', `/leads/${lead.id}/claim`, { commandId: randomUUID(), pondId: pond }))));
  const wall = performance.now() - t0;
  b.record(`claim: ${rest.length} agents each claim a different lead at once`, BUDGET.write, un.map((r) => r.ms), `wall ${wall.toFixed(0)} ms`);
  b.logProfile('claim uncontested');
  b.check('uncontested claims all succeed', un.every((r) => r.status === 200), `${un.filter((r) => r.status === 200).length}/${un.length}`);
}

/** 9. dispatch throughput: immediate SMS sends (gate + insert + inline dispatchOutbound) at a fixed concurrency. */
export async function benchDispatch(b: LoadBench, a: Actors, o: { sends: number; concurrency: number }): Promise<void> {
  const T = b.tenantId;
  // sender registration through the real API (the owner registers and attaches every agent's number)
  const existing = await b.q<{ id: string }>(`SELECT id FROM sender_registrations WHERE tenant_id = $1 AND status = 'approved' LIMIT 1`, [T]);
  if (existing.length === 0) {
    // the telephony subaccount is created by the first number bought through the API (as signup-then-setup does)
    await expectOk(await b.req(a.owner, 'POST', '/numbers', { purpose: 'team_main', areaCode: '415' }), 'number');
    const reg = await b.req<{ registration: { id: string } }>(a.owner, 'POST', '/sender-registrations', { kind: 'a2p_campaign', useCase: 'customer care', sampleMessages: ['Hi, this is your agent following up.'], optInDescription: 'Leads opt in on our website form.' });
    await expectOk(reg, 'registration');
    await expectOk(await b.req(a.owner, 'POST', `/sender-registrations/${reg.body.registration.id}/refresh`), 'refresh');
    const nums = await b.q<{ id: string }>(`SELECT id FROM phone_numbers WHERE tenant_id = $1 AND released_at IS NULL`, [T]);
    for (const n of nums) await expectOk(await b.req(a.owner, 'PATCH', `/numbers/${n.id}/registration`, { registrationId: reg.body.registration.id }), 'attach');
  }
  const sessionOf = new Map(a.agents.map((x) => [x.userId, x.s]));
  // reachable owned contacts (a phone, no opt-out, no suppression), one send each
  const targets = await b.q<{ id: string; owner_user_id: string }>(
    `SELECT c.id, c.owner_user_id FROM contacts c
      WHERE c.tenant_id = $1 AND c.ownership_state = 'owned'
        AND EXISTS (SELECT 1 FROM contact_points p WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.kind = 'phone' AND p.is_primary)
        AND NOT EXISTS (SELECT 1 FROM consent_events e WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.event_type = 'revoke')
        AND NOT EXISTS (SELECT 1 FROM contact_points p JOIN suppressions s ON s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac
                         WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id)
      ORDER BY hashtext(c.id::text) LIMIT $2`, [T, o.sends]);
  const results: { status: number; ms: number; result: string }[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: o.concurrency }, async () => {
    while (next < targets.length) {
      const c = targets[next++]!;
      const r = await b.req<{ result: string }>(sessionOf.get(c.owner_user_id)!, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: 'Hi! Following up on the homes you saved this week.', idempotencyKey: `load-${randomUUID()}` });
      results.push({ status: r.status, ms: r.ms, result: r.body.result });
    }
  }));
  const wall = (performance.now() - t0) / 1000;
  const sent = results.filter((r) => r.status < 300 && r.result === 'sent').length;
  b.record(`dispatch: ${targets.length} immediate SMS sends, concurrency ${o.concurrency}`, BUDGET.write, results.map((r) => r.ms), `${(targets.length / wall).toFixed(1)} sends/s end to end`);
  b.check('dispatch: every reachable send went out', sent === targets.length, `${sent}/${targets.length} sent; other results: ${[...new Set(results.filter((r) => r.result !== 'sent').map((r) => `${r.status} ${r.result}`))].join(', ') || 'none'}`);

  // D1 at scale: opted-out numbers stay blocked (no override) — STOP, and agent-recorded do-not-contact
  const stopped = await b.q<{ id: string; owner_user_id: string }>(
    `SELECT DISTINCT c.id, c.owner_user_id FROM contacts c JOIN consent_events e ON e.tenant_id = c.tenant_id AND e.contact_id = c.id
      WHERE c.tenant_id = $1 AND c.ownership_state = 'owned' AND e.event_type = 'revoke' AND e.channel = 'sms' ORDER BY c.id LIMIT 30`, [T]);
  const since = (await b.q<{ t: Date }>(`SELECT now() AS t`))[0]!.t;
  const blocked = await Promise.all(stopped.map((c) => b.req<{ result: string; decision?: { outcome: string; reasons: string[] } }>(sessionOf.get(c.owner_user_id)!, 'POST', `/contacts/${c.id}/messages`, { channel: 'sms', body: 'Checking in!', idempotencyKey: `load-${randomUUID()}` })));
  // nothing left for any of these contacts' opted-out numbers since the attempt started (any status that means it went out)
  const leaked = Number((await b.q<{ n: string }>(
    `SELECT count(*)::text AS n FROM messages WHERE tenant_id = $1 AND contact_id = ANY ($2::uuid[]) AND direction = 'outbound' AND created_at >= $3
        AND status IN ('dispatching','sent','delivered','dispatch_unknown')`, [T, stopped.map((c) => c.id), since]))[0]!.n);
  const nonSent = blocked.filter((r) => r.body.result !== 'sent').length;
  b.check('D1: opted-out numbers are never sent to', nonSent === stopped.length && leaked === 0,
    `${nonSent}/${stopped.length} not sent (${[...new Set(blocked.map((r) => `${r.status} ${r.body.result}:${(r.body.decision?.reasons ?? []).join('+')}`))].join(', ')}); ${leaked} outbound rows went out to them`);
}

/** 10. import dry run of a 50k-row CSV (create → snapshot → dry run job), as the admin. */
export async function benchImportDryRun(b: LoadBench, a: Actors, rows: number): Promise<void> {
  const p = b.app.platform;
  const deps = { db: p.db, envelope: p.envelope, ids: p.ids, storage: p.providers.storage, fub: new FakeFub().connector };
  const drain = () =>
    createWorker({ db: p.db, registry: new HandlerRegistry().registerAll(makeImportHandlers(() => deps)), providers: p.providers, queues: ['bulk'], concurrency: 1, worker: `load-imports-${randomUUID().slice(0, 8)}`, idleMs: 5, log: silentLogger }).drain(400);
  const lines = ['First Name,Last Name,Mobile Phone,Email,Tags'];
  // half the rows match existing contacts' numbers (the dedupe index path), half are new
  const existing = await b.q<{ address: string }>(`SELECT address FROM contact_points WHERE tenant_id = $1 AND kind = 'phone' AND is_primary ORDER BY hashtext(id::text) LIMIT $2`, [b.tenantId, Math.floor(rows / 2)]);
  for (let i = 0; i < rows; i++) {
    const phone = i < existing.length ? existing[i]!.address : `+1628${String(1000000 + i).padStart(7, '0')}`;
    lines.push(`Pat${i},Import${i},${phone},pat.import${i}@example.com,imported`);
  }
  const t0 = performance.now();
  const r = await b.req<{ batch: { id: string } }>(a.admin, 'POST', '/imports', { source: 'csv', fileName: 'load.csv', fileBase64: Buffer.from(`${lines.join('\n')}\n`).toString('base64') });
  await expectOk(r, 'import create');
  await expectOk(await b.req(a.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`), 'snapshot');
  await drain();
  const t1 = performance.now();
  await expectOk(await b.req(a.admin, 'POST', `/imports/${r.body.batch.id}/stages/contacts/dry-run`), 'dry run request');
  await drain();
  const t2 = performance.now();
  const v = await b.req<{ batch: { stages: { category: string; status: string; counts: Record<string, number> | null }[] } }>(a.admin, 'GET', `/imports/${r.body.batch.id}`);
  const st = v.body.batch?.stages?.find((s) => s.category === 'contacts');
  b.record(`import: ${rows}-row CSV dry run (job, one transaction)`, BUDGET.none, [t2 - t1], `create + snapshot ${(t1 - t0).toFixed(0)} ms before it`);
  b.check('import dry run: counts reconcile', st?.status === 'dry_run_ready' && st.counts?.source === rows, `${st?.status} ${JSON.stringify(st?.counts)}`);
}

// ---- auto_explain capture ---------------------------------------------------------------------------------

export async function withAutoExplain<T>(adminUrl: string, db: string, minMs: number, fn: () => Promise<T>): Promise<{ result: T; plans: string }> {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  const logFile = '/var/log/postgresql/postgresql-16-main.log';
  const start = statSync(logFile).size;
  try {
    await admin.query(`ALTER DATABASE ${db} SET session_preload_libraries = 'auto_explain'`);
    for (const [k, v] of Object.entries({ log_min_duration: `${minMs}ms`, log_analyze: 'on', log_buffers: 'on', log_nested_statements: 'off', log_timing: 'off', log_format: 'text' })) {
      await admin.query(`ALTER DATABASE ${db} SET auto_explain.${k} = '${v}'`);
    }
    const result = await fn();
    const end = statSync(logFile).size;
    const buf = Buffer.alloc(end - start);
    const fd = openSync(logFile, 'r');
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return { result, plans: buf.toString('utf8') };
  } finally {
    await admin.query(`ALTER DATABASE ${db} RESET ALL`);
    await admin.end();
  }
}

export async function machineInfo(su: pg.Pool) {
  const os = await import('node:os');
  return {
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    ramGb: Math.round(os.totalmem() / 2 ** 30),
    postgres: (await su.query<{ v: string }>('SELECT version() AS v')).rows[0]!.v.split(' on ')[0]!,
  };
}

export async function runBench(o: { db: string; iterations: number; log: (s: string) => void; sends: number; importRows: number; contested: number; racers: number; skip?: Set<string>; only?: string; poolMax?: number; profile?: boolean; offers?: number }): Promise<BenchResult> {
  const b = await LoadBench.open(o);
  if (o.only) b.only = new RegExp(o.only);
  b.profile = o.profile === true;
  try {
    const sizes: Record<string, number> = {};
    for (const t of ['contacts', 'contact_points', 'messages', 'calls', 'notes', 'lead_ownership_events', 'exception_items', 'consent_state', 'deals']) {
      sizes[t] = Number((await b.q<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE tenant_id = $1`, [b.tenantId]))[0]!.n);
    }
    o.log(`large tenant: ${JSON.stringify(sizes)}`);
    const a = await actors(b);
    if (!o.skip?.has('reads')) await benchReads(b, a);
    if (!o.skip?.has('ownership')) await benchOwnership(b, a, { contested: o.contested, racers: o.racers, ...(o.offers !== undefined ? { offers: o.offers } : {}) });
    if (!o.skip?.has('dispatch')) await benchDispatch(b, a, { sends: o.sends, concurrency: 8 });
    if (!o.skip?.has('import')) await benchImportDryRun(b, a, o.importRows);
    return { db: o.db, at: new Date().toISOString(), machine: await machineInfo(b.su), sizes, results: b.results, checks: b.checks };
  } finally {
    await b.close();
  }
}

export function markdownTable(r: BenchResult): string {
  const rows = r.results.map((m) => `| ${m.name} | ${m.n} | ${m.p50.toFixed(1)} | ${m.p95.toFixed(1)} | ${m.max.toFixed(1)} | ${m.budgetMs ?? '—'} | ${m.pass === null ? '—' : m.pass ? 'pass' : '**MISS**'} | ${m.note ?? ''} |`);
  return ['| operation | n | p50 ms | p95 ms | max ms | budget ms | result | note |', '|---|---:|---:|---:|---:|---:|---|---|', ...rows].join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop()!);
if (isMain) {
  const args = process.argv.slice(2);
  const db = argValue(args, 'db') ?? 'realty_load';
  const out = argValue(args, 'out');
  const opts = {
    db,
    iterations: Number(argValue(args, 'iterations') ?? 40),
    sends: Number(argValue(args, 'sends') ?? 500),
    importRows: Number(argValue(args, 'import-rows') ?? 50_000),
    contested: Number(argValue(args, 'contested') ?? 20),
    racers: Number(argValue(args, 'racers') ?? 10),
    skip: new Set((argValue(args, 'skip') ?? '').split(',').filter(Boolean)),
    ...(argValue(args, 'only') ? { only: argValue(args, 'only')! } : {}),
    // --pool N: the bench's API pool size (default 20); --offers N: live offers accepted (default 200);
    // --profile: pool wait / connection hold per request and backend wait sampling (profile.ts)
    ...(argValue(args, 'pool') ? { poolMax: Number(argValue(args, 'pool')) } : {}),
    ...(argValue(args, 'offers') ? { offers: Number(argValue(args, 'offers')) } : {}),
    profile: args.includes('--profile'),
    log: (s: string) => console.log(s),
  };
  const explain = args.includes('--explain');
  const go = async () => {
    if (explain) {
      const { result, plans } = await withAutoExplain(loadUrls(db).adminUrl, db, Number(argValue(args, 'explain-ms') ?? 20), () => runBench({ ...opts, iterations: 3 }));
      const file = out ?? `explain-${db}.log`;
      writeFileSync(file, plans);
      console.log(`auto_explain plans (${result.results.length} operations) written to ${file}; timings of this run are instrumented and not results`);
      return;
    }
    const r = await runBench(opts);
    console.log(`\n${markdownTable(r)}\n`);
    console.log(JSON.stringify(r.machine));
    if (out) writeFileSync(out, JSON.stringify(r, null, 2));
    const failed = r.checks.filter((c) => !c.ok);
    if (failed.length > 0) {
      console.error(`${failed.length} correctness check(s) failed`);
      process.exitCode = 1;
    }
  };
  go().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
}

