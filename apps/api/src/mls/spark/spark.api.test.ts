// Spark MLS (read-only) through the real server and Postgres, against a MOCK Spark server only (R-INT-1..5,
// R-TEN-7, R-AUDIT-4). A network tripwire fails any real outbound call; the canary token is searched for in
// every output channel at the end.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTenantTx } from '@realty/db';
import { can } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, call, freshReauth, inviteViaApi, staleReauth } from '../../admin/testing.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../../auth/testHarness.js';
import type { MemoryErrorReporter } from '../../observability/errors.js';
import { Registry } from '../../observability/prometheus.js';
import { CANARY_TOKEN, type MockSpark, type Tripwire, installNetworkTripwire, mockSpark } from '../../providers/integrations/spark.testing.js';
import { LIVE_CALLS_OFF } from './service.js';

let h: ApiHarness;
let wire: Tripwire;
let spark: MockSpark;
const metrics = new Registry();
/** every API response body the suite saw (searched for the canary at the end) */
const bodies: string[] = [];

interface ConnView {
  id: string;
  status: string;
  statusSentence: string;
  keyLabel: string | null;
  credentialSaved: boolean;
  lastResult: string | null;
}
interface View {
  provider: string;
  liveCalls: boolean;
  sentence: string;
  connection: ConnView | null;
}

async function api<T = Record<string, unknown>>(c: TestClient, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown) {
  const r = await call<T>(c, method, url, body);
  bodies.push(JSON.stringify(r.body));
  return r;
}
const setMls = (o: Partial<ApiHarness['config']['mls']>) => {
  h.app.platform.config.mls = { ...h.app.platform.config.mls, ...o };
};
async function save(c: TestClient, body: Record<string, unknown> = { accessToken: CANARY_TOKEN, keyLabel: 'crm-key' }) {
  await freshReauth(h, c);
  return api<{ connection: ConnView }>(c, 'PUT', '/admin/integrations/mls/spark/credential', body);
}
async function validate(c: TestClient) {
  await freshReauth(h, c);
  return api<{ result: string; connection: ConnView }>(c, 'POST', '/admin/integrations/mls/spark/validate');
}
const creds = async (tenantId: string) =>
  (await h.su.query<{ id: string; status: string; secret_enc: Buffer | null; external_account_ref: string | null; provider: string }>('SELECT id, provider, status, secret_enc, external_account_ref FROM provider_credentials WHERE tenant_id = $1 ORDER BY created_at', [tenantId])).rows;
const conn = async (tenantId: string) =>
  (await h.su.query<{ id: string; status: string; last_error_code: string | null; credential_id: string | null; external_account_id: string | null; capabilities: Record<string, boolean> }>(
    "SELECT id, status, last_error_code, credential_id, external_account_id, capabilities FROM integration_connections WHERE tenant_id = $1 AND kind = 'mls_feed' ORDER BY created_at DESC LIMIT 1",
    [tenantId],
  )).rows[0];

beforeAll(async () => {
  wire = installNetworkTripwire();
  spark = mockSpark();
  h = await createApiHarness({ metrics, logLevel: 'info' });
  h.providers.integrations.mlsTransport = spark.fetch;
  setMls({ provider: 'spark', liveCalls: false });
}, 180_000);
afterEach(() => {
  expect(wire.attempts).toEqual([]);
});
afterAll(async () => {
  await h?.close();
  wire?.restore();
});

describe('Spark key: who may write it (Owner/Admin only, re-auth, CSRF, rate limit)', () => {
  let owner: TestClient;
  let admin: TestClient;
  let agent: TestClient;
  let lead: TestClient;
  beforeAll(async () => {
    owner = await h.signup();
    admin = await inviteViaApi(h, owner, 'admin');
    agent = await inviteViaApi(h, owner, 'agent');
    lead = await inviteViaApi(h, owner, 'team_lead');
  }, 120_000);

  it('R-INT-3: an Owner saves the key; it is encrypted in provider_credentials (mls) and linked by the system actor, never returned', async () => {
    const r = await save(owner);
    expect(r.status).toBe(200);
    expect(r.body.connection).toMatchObject({ status: 'not_configured', keyLabel: 'crm-key', credentialSaved: true, lastResult: null });
    expect(JSON.stringify(r.body)).not.toContain(CANARY_TOKEN);
    const [c] = await creds(owner.tenantId!);
    expect(c).toMatchObject({ provider: 'mls', status: 'active', external_account_ref: 'crm-key' });
    expect(c!.secret_enc!.includes(Buffer.from(CANARY_TOKEN))).toBe(false); // ciphertext only
    const row = await conn(owner.tenantId!);
    expect(row).toMatchObject({ credential_id: c!.id, status: 'not_configured', external_account_id: `spark:${row!.id}` });
    const a = (await auditRows(h, owner.tenantId!, 'integration.credential_saved'))[0]!;
    expect([a.actor_user_id, a.actor_role, a.reason]).toEqual([null, null, 'KEY_SAVED']); // the system actor wrote it
    expect(JSON.stringify(a.changes)).toContain(owner.userId!); // by_user_id: who submitted it
  });

  it('an Admin may save it; agents and team leads are refused (404, never 403) and cannot even read the view', async () => {
    expect((await save(admin, { accessToken: CANARY_TOKEN, keyLabel: 'admin-key', authScheme: 'OAuth' })).status).toBe(200);
    for (const c of [agent, lead]) {
      await freshReauth(h, c);
      expect((await save(c)).status).toBe(404);
      expect((await api(c, 'GET', '/admin/integrations/mls/spark')).status).toBe(404);
      expect((await validate(c)).status).toBe(404);
    }
  });

  it('support sessions are refused by core can() for every Spark action', () => {
    const support = { kind: 'support' as const, userId: owner.userId as never, tenantId: owner.tenantId as never, grantId: 'g' };
    expect(can(support, 'integration.manage', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(can(support, 'integration.view', {})).toEqual({ ok: false, code: 'NOT_FOUND' });
  });

  it('R-PERM-13: a stale re-authentication is refused; a missing CSRF token is refused; nothing is stored', async () => {
    const before = (await creds(owner.tenantId!)).length;
    await staleReauth(h, owner);
    const r = await api(owner, 'PUT', '/admin/integrations/mls/spark/credential', { accessToken: CANARY_TOKEN, keyLabel: 'x' });
    expect([r.status, r.code]).toEqual([401, 'REAUTH_REQUIRED']);
    await freshReauth(h, owner);
    const raw = await owner.request('PUT', '/api/admin/integrations/mls/spark/credential', { accessToken: CANARY_TOKEN, keyLabel: 'x' }, { csrf: 'none' });
    bodies.push(raw.body);
    expect(raw.statusCode).toBe(403);
    expect((await creds(owner.tenantId!)).length).toBe(before);
  });

  it('the body is strict: no tenant id, no status, a token with whitespace is refused without echoing it', async () => {
    for (const body of [
      { accessToken: CANARY_TOKEN, keyLabel: 'x', tenantId: agent.tenantId },
      { accessToken: CANARY_TOKEN, keyLabel: 'x', status: 'connected' },
      { accessToken: `${CANARY_TOKEN} with space`, keyLabel: 'x' },
      { accessToken: 'short', keyLabel: 'x' },
      { accessToken: CANARY_TOKEN, keyLabel: 'x', authScheme: 'Basic' },
    ]) {
      const r = await save(owner, body);
      expect([r.status, r.code]).toEqual([422, 'VALIDATION_FAILED']);
      expect(JSON.stringify(r.body)).not.toContain(CANARY_TOKEN);
    }
  });

  it('a replaced key is purged in the same transaction; the connection must be validated again', async () => {
    const old = (await conn(owner.tenantId!))!.credential_id!;
    const r = await save(owner, { accessToken: `${CANARY_TOKEN}-2`, keyLabel: 'second' });
    expect(r.body.connection).toMatchObject({ status: 'not_configured', keyLabel: 'second' });
    const all = await creds(owner.tenantId!);
    expect(all.find((c) => c.id === old)).toMatchObject({ status: 'purged', secret_enc: null });
    expect(all.filter((c) => c.status === 'active')).toHaveLength(1);
  });

  it('DB rate limit: at most 10 key writes per person per hour', async () => {
    const o = await h.signup();
    for (let i = 0; i < 10; i++) expect((await save(o)).status).toBe(200);
    const r = await save(o);
    expect([r.status, r.code]).toEqual([429, 'RATE_LIMITED']);
  });

  it('MLS_PROVIDER=fake: a key cannot be saved or validated (409), and the view says so', async () => {
    setMls({ provider: 'fake' });
    try {
      expect((await save(owner)).code).toBe('MLS_PROVIDER_NOT_SPARK');
      expect((await validate(owner)).code).toBe('MLS_PROVIDER_NOT_SPARK');
      expect((await api<View>(owner, 'GET', '/admin/integrations/mls/spark')).body).toMatchObject({ provider: 'fake' });
    } finally {
      setMls({ provider: 'spark' });
    }
  });
});

describe('tenant isolation (R-TEN-11)', () => {
  it('another tenant sees no connection and cannot validate; RLS hides the credential from agents and other tenants', async () => {
    const a = await h.signup();
    const agentA = await inviteViaApi(h, a, 'agent');
    const b = await h.signup();
    expect((await save(a)).status).toBe(200);
    expect((await api<View>(b, 'GET', '/admin/integrations/mls/spark')).body.connection).toBeNull();
    expect((await validate(b)).code).toBe('MLS_CREDENTIAL_MISSING');
    const seen = async (c: TestClient) => withTenantTx(c.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM provider_credentials WHERE provider = 'mls'`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(await seen(a)).toBe(1);
    expect(await seen(b)).toBe(0);
    expect(await seen(agentA)).toBe(0);
    // a person cannot link a credential to the connection directly (the 0018 guard: system only)
    const id = (await conn(a.tenantId!))!.id;
    await expect(withTenantTx(a.actor(), async (tx) => void (await sql`UPDATE integration_connections SET credential_id = NULL WHERE id = ${id}`.execute(tx)), { db: h.database })).rejects.toThrow(/CONNECTION_PROOF_REQUIRED/);
  });
});

describe('validation probe and the MLS_LIVE_CALLS kill switch', () => {
  let owner: TestClient;
  beforeAll(async () => {
    owner = await h.signup();
  }, 60_000);

  it('MLS_LIVE_CALLS=false: live_calls_disabled, no request leaves the process, the UI sentence says so', async () => {
    setMls({ liveCalls: false });
    expect((await validate(owner)).code).toBe('MLS_CREDENTIAL_MISSING');
    expect((await save(owner)).status).toBe(200);
    spark.calls.length = 0;
    const r = await validate(owner);
    expect([r.status, r.body.result]).toEqual([200, 'live_calls_disabled']);
    expect(spark.calls).toHaveLength(0);
    expect(wire.attempts).toEqual([]);
    expect(await conn(owner.tenantId!)).toMatchObject({ status: 'not_configured', last_error_code: 'LIVE_CALLS_DISABLED' });
    const v = (await api<View>(owner, 'GET', '/admin/integrations/mls/spark')).body;
    expect(v.liveCalls).toBe(false);
    expect(v.sentence.startsWith(LIVE_CALLS_OFF)).toBe(true);
    expect(LIVE_CALLS_OFF).toBe('Live MLS calls are turned off on this deployment.');
    const list = (await api<{ services: { kind: string; connect: string; sentence: string }[] }>(owner, 'GET', '/admin/integrations')).body;
    expect(list.services.find((s) => s.kind === 'mls_feed')).toMatchObject({ connect: 'api_key', sentence: expect.stringMatching(/^Live MLS calls are turned off on this deployment\./) });
  });

  const cases: [string, MockSpark['handler'], string, string, string | null][] = [
    ['200', () => ({ status: 200, body: { value: [{ ListingKey: 'LK1', ModificationTimestamp: '2026-11-01T00:00:00Z' }] } }), 'connected', 'connected', null],
    ['429', () => ({ status: 429, headers: { 'retry-after': '1' } }), 'rate_limited', 'degraded', 'RATE_LIMITED'],
    ['403', () => ({ status: 403, body: { D: { Message: 'BODY-MARKER' } } }), 'not_licensed_or_role_insufficient', 'degraded', 'NOT_LICENSED_OR_ROLE_INSUFFICIENT'],
    ['500', () => ({ status: 500 }), 'unreachable', 'degraded', 'UNREACHABLE'],
    ['network', () => Promise.reject(new Error(`ECONNRESET ${CANARY_TOKEN}`)), 'unreachable', 'degraded', 'UNREACHABLE'],
    ['302', () => ({ status: 302, headers: { location: 'https://evil.example/' } }), 'unreachable', 'degraded', 'REDIRECT_REFUSED'],
    ['200 again', () => ({ status: 200, body: { value: [] } }), 'connected', 'connected', null],
    ['401', () => ({ status: 401, body: { error: CANARY_TOKEN } }), 'invalid_credentials', 'revoked', 'INVALID_CREDENTIALS'],
  ];
  for (const [label, handler, result, status, code] of cases) {
    it(`MLS_LIVE_CALLS=true, Spark answers ${label}: ${result}, exactly one read-only request, codes only recorded`, async () => {
      setMls({ liveCalls: true });
      spark.handler = handler;
      spark.calls.length = 0;
      const r = await validate(owner);
      expect([r.status, r.body.result]).toEqual([200, result]);
      expect(spark.calls).toHaveLength(1);
      const c = spark.calls[0]!;
      expect([c.method, c.redirect, `${c.url.origin}${c.url.pathname}`]).toEqual(['GET', 'manual', 'https://sparkapi.com/Reso/OData/Property']);
      expect(Object.fromEntries(c.url.searchParams)).toEqual({ $top: '1', $select: 'ListingKey,ModificationTimestamp' });
      expect(c.headers.authorization).toBe(`Bearer ${CANARY_TOKEN}`);
      const row = (await conn(owner.tenantId!))!;
      expect([row.status, row.last_error_code]).toEqual([status, code]);
      if (status === 'connected') expect(row.capabilities).toEqual({ read_listings: true, read_media: true });
      if (status === 'revoked') expect(row.capabilities).toEqual({});
      const a = (await auditRows(h, owner.tenantId!, 'integration.validated')).at(-1)!;
      expect(a.reason).toBe(code ?? 'CONNECTED');
      expect(JSON.stringify(a)).not.toMatch(/BODY-MARKER|evil\.example|ECONNRESET|ListingKey/);
    });
  }

  it('R-INT-5: disconnect revokes and purges the key in the same transaction', async () => {
    const id = (await conn(owner.tenantId!))!.id;
    const credId = (await conn(owner.tenantId!))!.credential_id!;
    await freshReauth(h, owner);
    const r = await api(owner, 'POST', `/admin/integrations/connections/${id}/disconnect`);
    expect(r.status).toBe(200);
    const c = (await creds(owner.tenantId!)).find((x) => x.id === credId)!;
    expect([c.status, c.secret_enc]).toEqual(['purged', null]);
    expect(await h.su.query("SELECT 1 FROM jobs WHERE kind = 'integrations.revoke_grant' AND payload->>'credentialId' = $1", [credId]).then((x) => x.rowCount)).toBe(0);
    expect((await validate(owner)).code).toBe('MLS_CREDENTIAL_MISSING');
    expect((await api<View>(owner, 'GET', '/admin/integrations/mls/spark')).body.connection).toBeNull();
  });
});

describe('canary token redaction everywhere (R-TEN-7, R-AUDIT-4)', () => {
  it('an internal failure is reported without the token', async () => {
    const o = await h.signup();
    setMls({ liveCalls: true });
    expect((await save(o)).status).toBe(200);
    spark.handler = () => {
      throw Object.assign(new Error(`boom ${CANARY_TOKEN}`), { token: CANARY_TOKEN });
    };
    expect((await validate(o)).body.result).toBe('unreachable');
  });

  it('the canary appears in no log line, error report, audit row, metric, API response, DB row (plaintext) or snapshot', async () => {
    expect(spark.calls.length).toBeGreaterThan(0); // the mock did receive it, in the Authorization header only
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line).not.toContain(CANARY_TOKEN);
    const reporter = h.app.platform.errorReporter as MemoryErrorReporter;
    expect(JSON.stringify(reporter.events)).not.toContain(CANARY_TOKEN);
    expect(await metrics.render()).not.toContain(CANARY_TOKEN);
    expect(bodies.length).toBeGreaterThan(20);
    for (const b of bodies) expect(b).not.toContain(CANARY_TOKEN);
    // every text-ish column of every table (audit_log, integration_connections, jobs, ...) and every bytea
    const tables = (await h.su.query<{ s: string; t: string }>("SELECT table_schema AS s, table_name AS t FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') AND table_type = 'BASE TABLE'")).rows;
    expect(tables.length).toBeGreaterThan(20);
    expect(tables.map((x) => x.t)).toEqual(expect.arrayContaining(['audit_log', 'provider_credentials', 'integration_connections', 'jobs']));
    const hits: string[] = [];
    let scanned = 0;
    for (const { s: schema, t } of tables) {
      const n = await h.su.query(`SELECT 1 FROM (SELECT r::text AS x FROM ${JSON.stringify(schema)}.${JSON.stringify(t)} r) q WHERE x LIKE $1 OR x LIKE $2 LIMIT 1`, [`%${CANARY_TOKEN}%`, `%${Buffer.from(CANARY_TOKEN).toString('hex')}%`]);
      scanned += 1;
      if (n.rowCount) hits.push(`${schema}.${t}`);
    }
    expect(scanned).toBe(tables.length);
    expect(hits).toEqual([]);
    // snapshots on disk
    const root = fileURLToPath(new URL('../../../../..', import.meta.url));
    const snaps: string[] = [];
    const walk = (d: string): void => {
      for (const n of readdirSync(d)) {
        if (n === 'node_modules' || n === '.git' || n === 'dist') continue;
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.includes('__snapshots__')) snaps.push(p);
      }
    };
    walk(join(root, 'apps'));
    walk(join(root, 'packages'));
    for (const s of snaps) expect(readFileSync(s, 'utf8'), s).not.toContain(CANARY_TOKEN);
  });
});
