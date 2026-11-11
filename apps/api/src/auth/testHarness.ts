// Integration-test harness for apps/api (api/platform owns it; other API modules may import it from
// their tests). Real Postgres per test file (createTestDb, connecting as the RLS-bound app_user),
// the real server, deterministic fake providers, and a small cookie+CSRF client over app.inject.
//
//   const h = await createApiHarness();
//   const owner = await h.signup();                 // Owner session, MFA enrolled and verified
//   const agent = await h.invite(owner, 'agent');   // invited + accepted through the API
//   const res = await agent.post('/api/push-subscriptions', {...});
//   await h.close();
import { createHash, randomBytes } from 'node:crypto';
import type { Role, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { type Database, configureDatabase, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import pg from 'pg';
import { type Config, loadConfig } from '../config.js';
import { type FakeProviders, createFakeProviders } from '../providers/index.js';
import type { RouteModule } from '../routes.js';
import { routeModules as defaultModules } from '../routes.js';
import { buildServer } from '../server.js';
import { totpCode, totpStep } from './totp.js';

export const TEST_ORIGIN = 'http://localhost:5173';
export const TEST_PASSWORD = 'correct horse battery staple';

export function testConfig(overrides: Partial<Config> = {}, env: NodeJS.ProcessEnv = {}): Config {
  const base = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://unused',
    KEK_BASE64: randomBytes(32).toString('base64'),
    SESSION_SECRET_BASE64: randomBytes(32).toString('base64'),
    WEB_ORIGIN: TEST_ORIGIN,
    PUBLIC_BASE_URL: 'https://api.test.invalid',
    SESSION_COOKIE_SECURE: 'true',
    STORAGE_PROVIDER: 'fake',
    LOG_LEVEL: 'silent',
    GLOBAL_RATE_LIMIT_PER_MINUTE: '100000',
    ...env,
  });
  return { ...base, ...overrides };
}

export interface ClientOptions {
  origin?: string | null;
  ip?: string;
  csrf?: 'auto' | 'none' | string;
}

/** A browser-like client: keeps the session cookie and sends x-csrf-token + Origin on unsafe calls. */
export class TestClient {
  cookie: string | null = null;
  csrf: string | null = null;
  userId: UserId | null = null;
  tenantId: TenantId | null = null;
  role: Role | null = null;
  email = '';
  totpSecret: string | null = null;

  constructor(
    readonly h: ApiHarness,
    readonly ip = '203.0.113.10',
  ) {}

  async request(method: string, url: string, body?: unknown, o: ClientOptions = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = { 'user-agent': 'vitest' };
    const origin = o.origin === undefined ? TEST_ORIGIN : o.origin;
    if (origin !== null && method !== 'GET') headers.origin = origin;
    const csrf = o.csrf ?? 'auto';
    if (csrf === 'auto' && this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    else if (csrf !== 'auto' && csrf !== 'none') headers['x-csrf-token'] = csrf;
    if (this.cookie) headers.cookie = `__Host-sid=${this.cookie}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await this.h.app.inject({
      method: method as 'GET',
      url,
      headers,
      remoteAddress: o.ip ?? this.ip,
      ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
    });
    const set = res.cookies.find((c) => c.name === '__Host-sid');
    if (set) this.cookie = set.value === '' || (set.maxAge !== undefined && set.maxAge <= 0) ? null : set.value;
    const json = safeJson(res.body) as { session?: { csrfToken?: string; tenant?: { id: string; role: Role } | null; user?: { id: string } }; csrfToken?: string } | null;
    const sess = json?.session ?? (json && 'csrfToken' in json ? (json as never) : null);
    const s = sess as { csrfToken?: string; tenant?: { id: string; role: Role } | null; user?: { id: string } } | null;
    if (s?.csrfToken) {
      this.csrf = s.csrfToken;
      if (s.user) this.userId = s.user.id as UserId;
      if (s.tenant !== undefined) {
        this.tenantId = (s.tenant?.id ?? null) as TenantId | null;
        this.role = s.tenant?.role ?? null;
      }
    }
    return res;
  }

  get(url: string, o?: ClientOptions) {
    return this.request('GET', url, undefined, o);
  }
  post(url: string, body: unknown = {}, o?: ClientOptions) {
    return this.request('POST', url, body, o);
  }
  delete(url: string, o?: ClientOptions) {
    return this.request('DELETE', url, undefined, o);
  }

  /** A user actor for this client (fixtures through RLS, e.g. the Owner inserting an invite). */
  actor(): UserActor {
    if (!this.userId || !this.tenantId || !this.role) throw new Error('client has no tenant session');
    return { kind: 'user', userId: this.userId, tenantId: this.tenantId, role: this.role, sessionId: 'fixture' };
  }

  /** A fresh TOTP code (resets the replay guard through the superuser fixture pool first). */
  async totp(): Promise<string> {
    if (!this.totpSecret || !this.userId) throw new Error('no MFA secret');
    await this.h.su.query('UPDATE users SET mfa_last_used_step = NULL WHERE id = $1', [this.userId]);
    return totpCode(this.totpSecret, totpStep(Date.now()));
  }
}

export function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export interface ApiHarness {
  testDb: TestDb;
  database: Database;
  /** superuser pool: fixtures without an application path and read-back only (never RLS proofs) */
  su: pg.Pool;
  app: FastifyInstance;
  providers: FakeProviders;
  config: Config;
  logs: string[];
  client(ip?: string): TestClient;
  /** signs up a new tenant; the Owner enrolls + verifies MFA unless `mfa: false` */
  signup(o?: { mfa?: boolean; email?: string; slug?: string; timezone?: string }): Promise<TestClient>;
  /** invites `role` as the Owner (RLS insert) and accepts through the API; Owner/Admin enroll MFA */
  invite(owner: TestClient, role: Role, o?: { mfa?: boolean; email?: string }): Promise<TestClient>;
  /** inserts an invite as the Owner (RLS) and returns the raw token */
  inviteToken(owner: TestClient, role: Role, email: string): Promise<string>;
  enrollMfa(c: TestClient): Promise<string[]>;
  login(email: string, password?: string, ip?: string): Promise<TestClient>;
  close(): Promise<void>;
}

const sha = (s: string) => createHash('sha256').update(Buffer.from(s, 'base64url')).digest();

export async function createApiHarness(o: { routeModules?: readonly RouteModule[]; config?: Partial<Config>; logLevel?: Config['logLevel'] } = {}): Promise<ApiHarness> {
  const testDb = await createTestDb();
  const database = createDatabase({ url: testDb.appUserUrl, max: 5, applicationName: 'api-test' });
  configureDatabase(database);
  const su = new pg.Pool({ connectionString: testDb.ownerUrl, max: 2 });
  // An idle client can be terminated by the server (a test database dropped WITH (FORCE), a restart):
  // without a listener pg re-throws it as an unhandled error. Queries in flight still reject normally.
  su.on('error', () => {});
  const clock = { now: () => instant(Date.now()) };
  const ids = uuidv7Generator(clock, (n) => new Uint8Array(randomBytes(n)));
  const config = testConfig({ ...(o.logLevel ? { logLevel: o.logLevel } : {}), ...o.config });
  const providers = createFakeProviders({ clock });
  const logs: string[] = [];
  const app = buildServer(config, {
    providers,
    clock,
    ids,
    db: database,
    routeModules: o.routeModules ?? defaultModules,
    logStream: { write: (line) => void logs.push(line) },
  });
  await app.ready();
  let n = 0;
  const h: ApiHarness = {
    testDb,
    database,
    su,
    app,
    providers,
    config,
    logs,
    client: (ip) => new TestClient(h, ip),
    async enrollMfa(c) {
      const e = await c.post('/api/auth/mfa/enroll');
      if (e.statusCode !== 200) throw new Error(`mfa enroll failed: ${e.statusCode} ${e.body}`);
      c.totpSecret = (e.json() as { secret: string }).secret;
      const conf = await c.post('/api/auth/mfa/enroll/confirm', { code: await c.totp() });
      if (conf.statusCode !== 200) throw new Error(`mfa confirm failed: ${conf.statusCode} ${conf.body}`);
      return (conf.json() as { recoveryCodes: string[] }).recoveryCodes;
    },
    async signup(s = {}) {
      n += 1;
      const tag = randomBytes(4).toString('hex');
      const c = new TestClient(h, `198.51.100.${(n % 250) + 1}`);
      c.email = s.email ?? `owner-${tag}@example.test`;
      const res = await c.post('/api/auth/signup', {
        email: c.email,
        password: TEST_PASSWORD,
        displayName: 'Olivia Owner',
        // letters only: an all-digit tag (about 1 in 40) reads as an account number to the assistant's
        // content guard (the team name is in every sign-off), which would block the file's autonomous sends
        teamName: `Team ${tag.replace(/[0-9]/g, (d) => 'ghijklmnop'[Number(d)]!)}`,
        slug: s.slug ?? `t-${tag}`,
        timezone: s.timezone ?? 'America/New_York',
        brokerageLegalName: 'Harbor Realty LLC',
      });
      if (res.statusCode !== 201) throw new Error(`signup failed: ${res.statusCode} ${res.body}`);
      if (s.mfa !== false) await h.enrollMfa(c);
      return c;
    },
    async inviteToken(owner, role, email) {
      const token = randomBytes(32).toString('base64url');
      await withTenantTx(
        owner.actor(),
        async (tx) => {
          await sql`INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
                    VALUES (app.tenant_id(), ${ids.next()}::uuid, ${email}, ${role}, ${sha(token)}, app.user_id(), now() + interval '1 day')`.execute(tx);
        },
        { db: database },
      );
      return token;
    },
    async invite(owner, role, s = {}) {
      n += 1;
      const token = randomBytes(32).toString('base64url');
      const email = s.email ?? `${role}-${randomBytes(4).toString('hex')}@example.test`;
      await withTenantTx(
        owner.actor(),
        async (tx) => {
          await sql`INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
                    VALUES (app.tenant_id(), ${ids.next()}::uuid, ${email}, ${role}, ${sha(token)}, app.user_id(), now() + interval '1 day')`.execute(tx);
        },
        { db: database },
      );
      const c = new TestClient(h, `192.0.2.${(n % 250) + 1}`);
      c.email = email;
      const res = await c.post(`/api/auth/invites/${token}/accept`, { displayName: `Member ${role}`, password: TEST_PASSWORD });
      if (res.statusCode !== 200) throw new Error(`invite accept failed: ${res.statusCode} ${res.body}`);
      if ((role === 'owner' || role === 'admin') && s.mfa !== false) await h.enrollMfa(c);
      return c;
    },
    async login(email, password = TEST_PASSWORD, ip) {
      const c = new TestClient(h, ip);
      c.email = email;
      const res = await c.post('/api/auth/login', { email, password });
      if (res.statusCode !== 200) throw new Error(`login failed: ${res.statusCode} ${res.body}`);
      return c;
    },
    async close() {
      await app.close();
      await database.close();
      await su.end();
      await testDb.drop();
    },
  };
  return h;
}

/** A fixed 32-byte invite/reset token hash helper for tests that insert tokens directly. */
export function tokenHashOf(token: string): Buffer {
  return sha(token);
}
