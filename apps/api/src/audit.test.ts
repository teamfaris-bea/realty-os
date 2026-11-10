// audit() and redaction (R-AUDIT-3, R-AUDIT-4, R-AUDIT-5, R-TEN-7).
import { AUDIT_ACTIONS } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuditSpecError, audit, classifyField, maskPii, redactDiff, redactForLog, redactSnapshot, requestContext } from './audit.js';
import { type ApiHarness, TEST_PASSWORD, type TestClient, createApiHarness } from './auth/testHarness.js';

let h: ApiHarness;
let owner: TestClient;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'info' });
  owner = await h.signup();
  agent = await h.invite(owner, 'agent');
});
afterAll(async () => {
  await h?.close();
});

describe('R-AUDIT-3 same transaction', () => {
  it('R-AUDIT-3: the audit row commits with the action; when the audit insert fails, the action rolls back with it', async () => {
    const before = (await h.su.query<{ team_name: string }>('SELECT team_name FROM tenant_settings WHERE tenant_id = $1', [owner.tenantId])).rows[0]!.team_name;
    // success: action + audit commit together
    await withTenantTx(
      owner.actor(),
      async (tx) => {
        await sql`UPDATE tenant_settings SET team_name = 'Harbor Team' WHERE tenant_id = app.tenant_id()`.execute(tx);
        await audit(tx, owner.actor(), { action: 'settings.changed', entity: { type: 'tenant_settings', id: owner.tenantId }, changes: redactDiff({ team_name: before }, { team_name: 'Harbor Team' }) });
      },
      { db: h.database },
    );
    const ok = await h.su.query<{ changes: unknown }>("SELECT changes FROM audit_log WHERE action = 'settings.changed' AND tenant_id = $1", [owner.tenantId]);
    expect(ok.rows[0]!.changes).toEqual({ team_name: { from: before, to: 'Harbor Team' } });
    // failure: a forged audit row (an agent writing as the Owner) is rejected by RLS ⇒ the action is gone too
    const forged = { ...agent.actor(), userId: owner.userId! };
    await expect(
      withTenantTx(
        agent.actor(),
        async (tx) => {
          await sql`UPDATE memberships SET home_jurisdiction = 'US-SC' WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()`.execute(tx);
          await audit(tx, forged, { action: 'settings.changed', entity: { type: 'membership', id: agent.userId } });
        },
        { db: h.database },
      ),
    ).rejects.toThrow(/row-level security/);
    const m = await h.su.query<{ home_jurisdiction: string | null }>('SELECT home_jurisdiction FROM memberships WHERE user_id = $1', [agent.userId]);
    expect(m.rows[0]!.home_jurisdiction).toBeNull();
  });

  it('R-AUDIT-3: an invalid audit spec throws before anything is written, aborting the transaction', async () => {
    await expect(
      withTenantTx(
        owner.actor(),
        async (tx) => {
          await sql`UPDATE tenant_settings SET team_name = 'Never Saved' WHERE tenant_id = app.tenant_id()`.execute(tx);
          await audit(tx, owner.actor(), { action: 'not.an_action' as never, entity: { type: 'x', id: null } });
        },
        { db: h.database },
      ),
    ).rejects.toThrow(AuditSpecError);
    const t = await h.su.query<{ team_name: string }>('SELECT team_name FROM tenant_settings WHERE tenant_id = $1', [owner.tenantId]);
    expect(t.rows[0]!.team_name).not.toBe('Never Saved');
  });

  it('request id, ip and user agent come from the request context; reasons are PII-masked', async () => {
    await requestContext.run({ requestId: 'req-123', ip: '198.51.100.7', userAgent: 'agent/1.0' }, () =>
      withTenantTx(owner.actor(), async (tx) => audit(tx, owner.actor(), { action: 'routing.changed', entity: { type: 'routing_rule', id: null }, reason: 'asked by jane@example.test at +18435550100' }), { db: h.database }),
    );
    const r = await h.su.query<{ request_id: string; ip: string; user_agent: string; reason: string; actor_kind: string; actor_role: string }>(
      "SELECT request_id, host(ip) AS ip, user_agent, reason, actor_kind, actor_role FROM audit_log WHERE action = 'routing.changed' AND tenant_id = $1",
      [owner.tenantId],
    );
    expect(r.rows[0]).toEqual({ request_id: 'req-123', ip: '198.51.100.7', user_agent: 'agent/1.0', reason: 'asked by [email] at [phone]', actor_kind: 'user', actor_role: 'owner' });
  });
});

describe('R-AUDIT-4 redacted diffs', () => {
  it('R-AUDIT-4: PII fields become {"changed": true}, non-PII fields {from, to}; unchanged fields are omitted (snapshot)', () => {
    const before = {
      first_name: 'Jane',
      last_name: 'Doe',
      display_name: 'Jane Doe',
      email: 'jane@example.test',
      alert_phone_e164: '+18435550100',
      body: 'Call me at 5',
      notes: 'likes boats',
      line1: '12 Harbor View Dr',
      role: 'agent',
      status: 'active',
      accepting_leads: true,
      owner_user_id: '01a1c4ba-0000-7000-8000-000000000001',
      offer_window_seconds: 300,
      updated_at: new Date('2026-11-01T10:00:00Z'),
      password_hash: '$argon2id$x',
      stage: 'new',
    };
    const after = {
      ...before,
      first_name: 'Janet',
      last_name: 'Doe-Smith',
      display_name: 'Janet Doe-Smith',
      email: 'janet@example.test',
      alert_phone_e164: '+18435550199',
      body: 'Call me at 6',
      notes: 'likes sailboats',
      line1: '14 Harbor View Dr',
      role: 'team_lead',
      accepting_leads: false,
      owner_user_id: '01a1c4ba-0000-7000-8000-000000000002',
      offer_window_seconds: 600,
      updated_at: new Date('2026-11-02T10:00:00Z'),
      password_hash: '$argon2id$y',
    };
    const d = redactDiff(before, after);
    expect(d).toMatchInlineSnapshot(`
      {
        "accepting_leads": {
          "from": true,
          "to": false,
        },
        "alert_phone_e164": {
          "changed": true,
        },
        "body": {
          "changed": true,
        },
        "display_name": {
          "changed": true,
        },
        "email": {
          "changed": true,
        },
        "first_name": {
          "changed": true,
        },
        "last_name": {
          "changed": true,
        },
        "line1": {
          "changed": true,
        },
        "notes": {
          "changed": true,
        },
        "offer_window_seconds": {
          "from": 300,
          "to": 600,
        },
        "owner_user_id": {
          "from": "01a1c4ba-0000-7000-8000-000000000001",
          "to": "01a1c4ba-0000-7000-8000-000000000002",
        },
        "password_hash": {
          "changed": true,
        },
        "role": {
          "from": "agent",
          "to": "team_lead",
        },
        "updated_at": {
          "from": "2026-11-01T10:00:00.000Z",
          "to": "2026-11-02T10:00:00.000Z",
        },
      }
    `);
    const text = JSON.stringify(d);
    for (const pii of ['Jane', 'Doe', 'example.test', '8435550', 'Call me', 'boats', 'Harbor', 'argon2id']) expect(text).not.toContain(pii);
  });

  it('R-AUDIT-4: `name` is a label only on configuration entities; a deal or saved-search name (usually the client\'s name) is PII, and unknown entities fail closed', () => {
    expect(redactDiff({ name: 'Smith – 12 Oak St' }, { name: 'Smith – 14 Oak St' }, { entity: 'deal' })).toEqual({ name: { changed: true } });
    expect(redactDiff({ name: 'Jane buyer search' }, { name: 'Jane & Tom search' }, { entity: 'saved_search' })).toEqual({ name: { changed: true } });
    expect(redactDiff({ name: 'Jane Doe' }, { name: 'Janet Doe' })).toEqual({ name: { changed: true } });
    for (const entity of ['team', 'pond', 'routing_rule', 'lead_source', 'playbook', 'tenant']) {
      expect(redactDiff({ name: 'North' }, { name: 'South' }, { entity })).toEqual({ name: { from: 'North', to: 'South' } });
    }
    // nested objects never treat a bare `name` as a label
    expect(redactSnapshot({ status: { name: 'Jane Doe', code: 'X' } })).toEqual({ status: { from: null, to: { name: '[redacted]', code: 'X' } } });
  });

  it('R-AUDIT-4: a created entity (snapshot) and nested plain objects still never leak PII', () => {
    const d = redactSnapshot({ id: 'x', status: 'active', match: { postal_codes: ['29401'], note: 'VIP Jane' }, value: 'secret-ish' });
    expect(d).toEqual({ id: { from: null, to: 'x' }, match: { from: null, to: { postal_codes: ['29401'], note: '[redacted]' } }, status: { from: null, to: 'active' }, value: { changed: true } });
  });

  it('R-AUDIT-4: generated field classification — every column in the schema gets a definite class, unknown names fail closed to PII (snapshot)', async () => {
    const cols = await h.su.query<{ table_name: string; column_name: string; udt_name: string }>(
      "SELECT table_name, column_name, udt_name FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position",
    );
    expect(cols.rows.length).toBeGreaterThan(800);
    const byClass: Record<string, Set<string>> = { pii: new Set(), secret: new Set(), plain: new Set() };
    for (const c of cols.rows) byClass[classifyField(c.column_name)]!.add(c.column_name);
    // every column the rule names as PII (names, phones, emails, bodies, notes) is classified PII/secret
    const mustBePii = cols.rows
      .filter((c) => ['text', 'citext', 'varchar', 'jsonb', '_text'].includes(c.udt_name))
      .map((c) => c.column_name)
      .filter((n) => /(^|_)(first_name|last_name|display_name|email|e164|phone|body|notes?|line1|line2|address|transcript|snippet|summary|message|subject)(_|$)/.test(n) && !/_(at|id|ids|kind|hmac|hash|sha256|status|type|count|ms|s|seq|step|version|tokens|until|on)$/.test(n));
    // brokerage identity (legal name, license, postal address) is printed on all marketing (A7f): its
    // changes are audited as from/to on purpose
    for (const n of mustBePii.filter((x) => !x.startsWith('brokerage_'))) expect([n, classifyField(n)]).not.toEqual([n, 'plain']);
    for (const n of byClass.secret!) expect(n).toMatch(/password|secret|token|totp|recovery|wrapped_key|dek|_enc$/);
    expect(classifyField('a_brand_new_free_text_column')).toBe('pii');
    // the full classification of PII/secret columns, reviewed when the schema changes
    expect({ pii: [...byClass.pii!].sort(), secret: [...byClass.secret!].sort() }).toMatchSnapshot();
  });
});

describe('R-AUDIT-5 always-audited actions', () => {
  it('R-AUDIT-5: the AuditAction union names every always-audited kind', () => {
    const required = [
      'session.login', 'session.logout', 'session.tenant_switched',
      'member.invited', 'member.role_changed', 'member.suspended', 'member.removed',
      'ownership.claim', 'ownership.reassign', 'ownership.release',
      'consent.recorded', 'suppression.lifted', 'consent.opt_out_received',
      'recording.play', 'transcript.view',
      'import.approved', 'import.committed', 'import.verified', 'import.reverted',
      'contact.deleted', 'contact.restored', 'contact.merged', 'contact.erase',
      'settings.changed', 'policy.version_created', 'routing.changed', 'pond.changed',
      'number.acquired', 'number.released', 'playbook.approved', 'playbook.revoked', 'draft.approved_with_edits',
      'exception.resolved', 'exception.verified', 'support.granted', 'support.revoked', 'definer.maintenance',
    ];
    for (const a of required) expect(AUDIT_ACTIONS).toContain(a);
  });

  it('R-AUDIT-5 (session): login, tenant switch and logout each write their audit row in the session tenant', async () => {
    const u = await h.invite(owner, 'agent');
    const second = await h.signup();
    const rows = async (tenant: string, action: string) =>
      (await h.su.query('SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = $2 AND actor_user_id = $3', [tenant, action, u.userId])).rowCount;
    expect(await rows(owner.tenantId!, 'session.login')).toBe(1); // invite acceptance
    const c = await h.login(u.email, TEST_PASSWORD, '10.6.0.1');
    expect(await rows(owner.tenantId!, 'session.login')).toBe(2);
    // joining a second tenant while signed in, then switching back
    const token = await h.inviteToken(second, 'agent', u.email);
    c.userId = u.userId;
    expect((await c.post(`/api/auth/invites/${token}/accept`, {})).statusCode).toBe(200);
    expect(await rows(second.tenantId!, 'session.login')).toBe(1);
    const slug = (await c.get('/api/auth/session')).json().tenants.find((t: { id: string }) => t.id === owner.tenantId).slug;
    expect((await c.post('/api/auth/tenant-switch', { slug })).statusCode).toBe(200);
    expect(await rows(owner.tenantId!, 'session.tenant_switched')).toBe(1);
    expect((await c.post('/api/auth/logout')).statusCode).toBe(200);
    expect(await rows(owner.tenantId!, 'session.logout')).toBe(1);
    expect(await rows(second.tenantId!, 'session.logout')).toBe(0);
    // rows written by real routes carry the request id, ip and user agent from the request context
    const ctx = await h.su.query<{ request_id: string | null; ip: string | null; user_agent: string | null }>(
      "SELECT request_id, host(ip) AS ip, user_agent FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'session.%'",
      [u.userId],
    );
    expect(ctx.rows.length).toBeGreaterThanOrEqual(4);
    for (const r of ctx.rows) {
      expect(r.request_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(r.ip).not.toBeNull();
      expect(r.user_agent).toBe('vitest');
    }
  });
});

describe('R-TEN-7 logs and error reports carry ids and codes only', () => {
  it('R-TEN-7: log redaction drops PII keys and masks E.164 numbers, US phone formats and emails in strings', () => {
    const out = redactForLog({
      msg: 'texted +18435550100 and (843) 555-0199, cc jane.doe@example.test',
      reqId: 'r1',
      email: 'jane@example.test',
      first_name: 'Jane',
      body: 'hello there',
      contactId: '01a1c4ba-0000-7000-8000-000000000001',
      statusCode: 200,
      nested: { phone: '+18435550100', count: 3, note: 'x', durationMs: 12 },
      res: { statusCode: 201, phone: '+18435550100' },
      err: new Error('duplicate key for bob@example.test'),
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    for (const pii of ['8435550100', '555-0199', 'jane', 'Jane', 'hello there', 'bob@']) expect(s).not.toContain(pii);
    expect(out.contactId).toBe('01a1c4ba-0000-7000-8000-000000000001');
    expect(out.statusCode).toBe(200);
    expect(out.res).toEqual({ statusCode: 201, phone: '[redacted]' });
    expect(out.nested).toBe('[redacted]'); // unknown container keys fail closed
    expect(maskPii('version pg@8.23.1 ok')).toBe('version pg@8.23.1 ok');
  });

  it('R-TEN-7: the server log of a login never contains the email, the password, the cookie or the raw URL query', async () => {
    h.logs.length = 0;
    await h.client('10.6.0.2').post('/api/auth/login', { email: agent.email, password: TEST_PASSWORD });
    await h.client('10.6.0.3').post('/api/auth/login', { email: 'who@example.test', password: 'nope nope nope' });
    await h.client('10.6.0.4').get('/api/auth/session?email=leak@example.test&phone=%2B18435550100');
    const text = h.logs.join('\n');
    expect(h.logs.length).toBeGreaterThan(0);
    for (const s of [agent.email, 'who@example.test', TEST_PASSWORD, 'leak@example.test', '8435550100', '__Host-sid']) expect(text).not.toContain(s);
    expect(text).toContain('/api/auth/login'); // the route pattern, not the URL
  });

  it('R-TEN-7: error bodies carry a code and request id only — no values, SQL or stack', async () => {
    const bad = await agent.post('/api/me/alert-phone', { phone: 'call jane@example.test', extra: 'x' });
    expect(bad.statusCode).toBe(422);
    const body = bad.json();
    expect(Object.keys(body.error).sort()).toEqual(['code', 'details', 'requestId']);
    expect(JSON.stringify(body)).not.toContain('jane');
    for (const i of body.error.details.issues) expect(Object.keys(i).sort()).toEqual(['code', 'path']);
    const notFound = await agent.get('/api/nope');
    expect(notFound.json()).toEqual({ error: { code: 'NOT_FOUND', requestId: expect.any(String) } });
    const badJson = await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { origin: 'http://localhost:5173', 'content-type': 'application/json' }, payload: '{"email": "x@example.test", ' });
    expect(badJson.statusCode).toBe(422);
    expect(badJson.body).not.toContain('x@example.test');
  });
});
