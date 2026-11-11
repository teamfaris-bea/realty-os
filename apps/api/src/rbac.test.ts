// Route authorization: the generated route × role × facts matrix, re-auth enforcement, 404-not-403,
// and the route-table guarantees (R-PERM-1, R-PERM-5, R-PERM-13, R-TEN-3).
import { ACTIONS, type Action, ROLES, type ResourceFacts, type Role, can, requiresReauth } from '@realty/core/foundation';
import { withPreTenant } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { hashPassword } from './auth/password.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness, safeJson, testConfig } from './auth/testHarness.js';
import { ERROR_STATUS, isErrorCode } from './errors.js';
import { createFakeProviders } from './providers/index.js';
import { RouteAuthorizationError, authorize } from './rbac.js';
import type { RouteModule } from './routes.js';
import { routeModules } from './routes.js';
import { buildServer } from './server.js';

/** One probe route per Action; the facts come from the x-facts header ("null" = invisible). */
const probe: RouteModule = {
  name: 'authz-probe',
  async register(app: FastifyInstance) {
    for (const action of ACTIONS) {
      app.post(
        `/__probe/${action}`,
        {
          config: { auth: action },
          preHandler: authorize(action, (req) => {
            const raw = req.headers['x-facts'];
            return typeof raw === 'string' ? (JSON.parse(raw) as ResourceFacts | null) : {};
          }),
        },
        async () => ({ ok: true }),
      );
    }
  },
};

let h: ApiHarness;
const users = {} as Record<Role, TestClient>;

beforeAll(async () => {
  h = await createApiHarness({ routeModules: [...routeModules, probe] });
  users.owner = await h.signup();
  for (const role of ROLES) if (role !== 'owner') users[role] = await h.invite(users.owner, role);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const FULL: ResourceFacts = {
  own: true,
  collaborator: true,
  team: true,
  pond: true,
  offer: true,
  deal: true,
  onCall: true,
  teamPlaybook: true,
  purpose: 'informational',
  target: { role: 'agent', inMyTeam: true },
  loosening: false,
  attested: true,
  suppressionReason: 'bounce',
  datesOnly: true,
  settings: { teamLeadRecordingAccess: true, tcRecordingAccess: true, agentConsentEntryAllowed: true },
};

const FACT_SETS: { name: string; facts: ResourceFacts }[] = [
  { name: 'none', facts: {} },
  { name: 'own', facts: { own: true, target: { role: 'agent' }, suppressionReason: 'bounce' } },
  { name: 'offer', facts: { offer: true } },
  { name: 'pond', facts: { pond: true } },
  { name: 'deal', facts: { deal: true, purpose: 'informational', datesOnly: true, settings: { tcRecordingAccess: true } } },
  { name: 'deal-marketing', facts: { deal: true, purpose: 'marketing' } },
  { name: 'team', facts: { team: true, target: { role: 'agent', inMyTeam: true }, settings: { teamLeadRecordingAccess: true } } },
  { name: 'loosening', facts: { loosening: true } },
  { name: 'owner-target', facts: { target: { role: 'owner' } } },
  { name: 'spam-complaint', facts: { suppressionReason: 'spam_complaint' } },
  { name: 'tc-target', facts: { target: { role: 'tc', inMyTeam: true }, own: true, team: true } },
  { name: 'full', facts: FULL },
];

function expected(c: TestClient, role: Role, action: Action, facts: ResourceFacts, reauthFresh: boolean): { status: number; code: string | null } {
  const actor = { kind: 'user' as const, userId: c.userId!, tenantId: c.tenantId!, role, sessionId: 'x' };
  const now = 2_000_000_000_000 as never;
  const r = can(actor, action, { ...facts, reauth: { reauthenticatedAt: (reauthFresh ? now : (now as number) - 16 * 60_000) as never, now } });
  if (r.ok) return { status: 200, code: null };
  return { status: isErrorCode(r.code) ? ERROR_STATUS[r.code] : 500, code: r.code };
}

async function call(c: TestClient, action: Action, facts: ResourceFacts | null) {
  const res = await h.app.inject({
    method: 'POST',
    url: `/api/__probe/${action}`,
    headers: { cookie: `__Host-sid=${c.cookie}`, origin: 'http://localhost:5173', 'x-csrf-token': c.csrf!, 'x-facts': JSON.stringify(facts) },
  });
  return { status: res.statusCode, code: (safeJson(res.body) as { error?: { code?: string } } | null)?.error?.code ?? null };
}

describe('R-PERM-1 generated route × role matrix', () => {
  for (const role of ROLES) {
    it(`R-PERM-1: every probe route for role ${role} answers exactly what core.can() decides for each fact set`, async () => {
      const c = users[role];
      let checked = 0;
      for (const action of ACTIONS) {
        for (const fs of FACT_SETS) {
          const want = expected(c, role, action, fs.facts, true);
          const got = await call(c, action, fs.facts);
          expect({ action, set: fs.name, ...got }).toEqual({ action, set: fs.name, ...want });
          checked += 1;
        }
      }
      expect(checked).toBe(ACTIONS.length * FACT_SETS.length);
    });
  }

  it('R-PERM-1: a fact claiming another tenant is denied (404) even with every relationship', async () => {
    for (const action of ACTIONS) {
      const got = await call(users.owner, action, { ...FULL, tenantId: '01a1c4ba-0000-7000-8000-00000000dead' as never });
      expect(got).toEqual({ status: 404, code: 'NOT_FOUND' });
    }
  });
});

describe('R-PERM-5 404, never 403, for invisible or forbidden resources', () => {
  it('R-PERM-5 E52: an invisible or nonexistent resource (facts null) is 404 NOT_FOUND for every action and role', async () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) expect(await call(users[role], action, null)).toEqual({ status: 404, code: 'NOT_FOUND' });
    }
  });

  it('R-PERM-5: every role/relationship denial is 404; a 403 only ever carries an explanation code after the relationship checks pass', async () => {
    for (const role of ROLES) {
      for (const action of ACTIONS) {
        const got = await call(users[role], action, {});
        expect(got.status === 200 || got.status === 404 || got.code === 'REAUTH_REQUIRED' || got.status === 403).toBe(true);
        if (got.status === 403) expect(['OWNER_REQUIRED', 'ATTESTATION_REQUIRED', 'SUPPRESSION_NOT_LIFTABLE', 'PURPOSE_NOT_PERMITTED', 'FIELDS_NOT_PERMITTED', 'TARGET_NOT_ELIGIBLE']).toContain(got.code);
      }
    }
  });
});

describe('R-PERM-13 re-authentication on sensitive actions', () => {
  it('R-PERM-13: every 🔒 action, for every role it applies to, answers 401 REAUTH_REQUIRED when the last re-auth is older than 15 minutes, and passes after /auth/reauth', async () => {
    const sensitive: [Role, Action][] = [];
    for (const role of ROLES) for (const action of ACTIONS) if (requiresReauth(role, action)) sensitive.push([role, action]);
    // the Phase 1 list: imports, role/member changes, erasure, export, number release, support grant,
    // brokerage identity, compliance loosening
    expect(new Set(sensitive.map(([, a]) => a))).toEqual(
      new Set(['import.run', 'number.release', 'settings.compliance', 'settings.identity', 'member.invite', 'member.role', 'member.suspend', 'member.remove', 'contact.erase', 'data.export', 'support.grant', 'integration.manage', 'settings.batch_text', 'coaching.settings']),
    );
    for (const role of new Set(sensitive.map(([r]) => r))) {
      await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [users[role].userId]);
    }
    for (const [role, action] of sensitive) {
      const facts = action === 'settings.compliance' || action === 'settings.batch_text' || action === 'coaching.settings' ? { ...FULL, loosening: true } : FULL; // parity L3: batch text on is "loosening"; module 36: coaching on
      const got = await call(users[role], action, facts);
      expect({ role, action, ...got }).toEqual({ role, action, status: 401, code: 'REAUTH_REQUIRED' });
    }
    // a non-loosening compliance change needs no re-auth for the Owner
    expect((await call(users.owner, 'settings.compliance', { loosening: false })).status).toBe(200);
    for (const role of new Set(sensitive.map(([r]) => r))) {
      const c = users[role];
      const body: Record<string, string> = { password: 'correct horse battery staple' };
      if (c.totpSecret) body.code = await c.totp();
      expect((await c.post('/api/auth/reauth', body)).statusCode).toBe(200);
    }
    for (const [role, action] of sensitive) {
      const facts = action === 'settings.compliance' || action === 'settings.batch_text' || action === 'coaching.settings' ? { ...FULL, loosening: true } : FULL;
      expect({ role, action, ...(await call(users[role], action, facts)) }).toEqual({ role, action, status: 200, code: null });
    }
  });

  it('R-PERM-13: exactly at 15 minutes is still fresh; just past it is not (boundary)', async () => {
    const c = users.admin;
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '14 minutes 58 seconds' WHERE user_id = $1 AND revoked_at IS NULL", [c.userId]);
    expect((await call(c, 'import.run', FULL)).status).toBe(200);
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '15 minutes 1 second' WHERE user_id = $1 AND revoked_at IS NULL", [c.userId]);
    expect((await call(c, 'import.run', FULL)).code).toBe('REAUTH_REQUIRED');
  });
});

describe('route table', () => {
  it('no route lacks authorize: every /api route declares its authorization and every Action route carries authorize(<that action>)', () => {
    const table = h.app.platform.routeTable;
    expect(table.length).toBeGreaterThanOrEqual(ACTIONS.length + 14);
    for (const r of table) {
      expect(r.url.startsWith('/api/')).toBe(true);
      expect(r.auth).toBeDefined();
      if ((ACTIONS as readonly string[]).includes(r.auth)) expect(r.authorizes).toBe(r.auth);
      else expect(['public', 'webhook', 'session', 'self']).toContain(r.auth);
    }
  });

  it('the platform routes and their declarations (snapshot)', () => {
    // the platform's own routes only (other modules snapshot theirs in their own matrix tests)
    const rows = h.app.platform.routeTable.filter((r) => !r.url.includes('__probe') && /^\/api\/(auth|push-subscriptions|me)(\/|$)/.test(r.url)).map((r) => `${r.method} ${r.url} → ${r.auth}`);
    expect(rows).toMatchInlineSnapshot(`
      [
        "POST /api/auth/login → public",
        "POST /api/auth/logout → session",
        "POST /api/auth/logout-all → session",
        "GET /api/auth/session → session",
        "HEAD /api/auth/session → session",
        "POST /api/auth/tenant-switch → session",
        "POST /api/auth/reauth → session",
        "POST /api/auth/mfa/enroll → session",
        "POST /api/auth/mfa/enroll/confirm → session",
        "POST /api/auth/mfa/verify → session",
        "POST /api/auth/mfa/recovery-codes → session",
        "POST /api/auth/signup → public",
        "POST /api/auth/password/reset → public",
        "POST /api/auth/password/reset/confirm → public",
        "POST /api/auth/invites/:token/accept → public",
        "POST /api/push-subscriptions → self",
        "DELETE /api/push-subscriptions/:id → self",
        "POST /api/me/alert-phone → self",
        "POST /api/me/alert-phone/verify → self",
        "GET /api/me/ponds → self",
        "HEAD /api/me/ponds → self",
      ]
    `);
  });

  it('R-TEN-3 E51: no route input schema accepts a tenant id (tenant context only comes from the session)', () => {
    for (const r of h.app.platform.routeTable) {
      for (const k of r.inputKeys) expect(k.toLowerCase().replace(/[^a-z]/g, '')).not.toMatch(/tenantid|^tenant$/);
    }
    // the platform's body schemas are strict: an extra tenant_id field is a validation error
    return users.agent.post('/api/push-subscriptions', { endpoint: 'https://push.example.test/t', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQ', auth: 'tBHItJI5svbpez7KI4CCXg' }, tenant_id: users.owner.tenantId }).then((res) => {
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    });
  });

  const boot = async (m: RouteModule) => {
    const app = buildServer(testConfig(), { providers: createFakeProviders(), clock: { now: () => Date.now() as never }, ids: { next: () => '01a1c4ba-0000-7000-8000-000000000000' as never }, db: h.database, routeModules: [m] });
    try {
      await app.ready();
      return null;
    } catch (e) {
      return e;
    } finally {
      await app.close().catch(() => {});
    }
  };

  it('the server refuses to start with a route that declares no authorization', async () => {
    const e = await boot({ name: 'bad', register: async (app) => void app.get('/oops', async () => ({})) });
    expect(e).toBeInstanceOf(RouteAuthorizationError);
    expect(String((e as Error).message)).toContain('GET /api/oops');
  });

  it('the server refuses to start with an Action route without its authorize(), or with authorize() for another action', async () => {
    expect(await boot({ name: 'bad', register: async (app) => void app.post('/a', { config: { auth: 'lead.claim' } }, async () => ({})) })).toBeInstanceOf(RouteAuthorizationError);
    expect(
      await boot({ name: 'bad', register: async (app) => void app.post('/b', { config: { auth: 'lead.claim' }, preHandler: authorize('lead.release', () => ({})) }, async () => ({})) }),
    ).toBeInstanceOf(RouteAuthorizationError);
    expect(await boot({ name: 'ok', register: async (app) => void app.post('/c', { config: { auth: 'lead.claim' }, preHandler: authorize('lead.claim', () => ({})) }, async () => ({})) })).toBeNull();
  });

  it('an Action route without a session is 401, and with a tenant-less session is 403 TENANT_REQUIRED', async () => {
    const anon = await h.app.inject({ method: 'POST', url: '/api/__probe/contact.view', headers: { origin: 'http://localhost:5173' } });
    expect(anon.statusCode).toBe(401);
    // a user with no membership (users RLS: insert self) logs in to a tenant-less session
    const uid = '01a1c4ba-0000-7000-8000-00000000f00d';
    const pw = await hashPassword('correct horse battery staple');
    await withPreTenant(async (tx) => void (await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${uid}::uuid, 'loner@example.test', 'Lone', ${pw})`.execute(tx)), {
      db: h.database,
      userId: uid as never,
    });
    const loner = await h.login('loner@example.test', 'correct horse battery staple', '10.7.0.1');
    expect((await loner.get('/api/auth/session')).json().tenant).toBeNull();
    const r = await call(loner, 'contact.view', FULL);
    expect(r).toEqual({ status: 403, code: 'TENANT_REQUIRED' });
  });
});
