// WP3a: a per-tenant read-only token, keyset pages, and an updatedSince cursor.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_PASSWORD, type ApiHarness, type TestClient, createApiHarness, safeJson } from '../auth/testHarness.js';
import { Activity, CRM_RESPONSE_SCHEMAS, Deal, Person } from './schemas.js';

let h: ApiHarness;
let owner: TestClient;
let other: TestClient;
let admin: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  owner = await h.signup();
  other = await h.signup();
  admin = await h.invite(owner, 'admin');
  await reauth(owner);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function reauth(c: TestClient) {
  const body: { password: string; code?: string } = { password: TEST_PASSWORD };
  if (c.totpSecret) body.code = await c.totp();
  const res = await c.post('/api/auth/reauth', body);
  expect(res.statusCode, res.body).toBe(200);
}

async function issue(c: TestClient, name = 'Prducer sync'): Promise<{ token: string; id: string; prefix: string }> {
  const res = await c.post('/api/crm-read/tokens', { name });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { token: string; id: string; prefix: string };
  expect(body.token.startsWith('ros_')).toBe(true);
  expect(body.prefix).toBe(body.token.slice(0, 10));
  return body;
}

function crm(token: string, path: string) {
  return h.app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}`, 'user-agent': 'vitest' } });
}

const code = (body: string) => (safeJson(body) as { error?: { code?: string } } | null)?.error?.code;

async function replica(statements: { text: string; values?: unknown[] }[]) {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    for (const s of statements) await c.query(s.text, s.values ?? []);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

describe('CRM read API', () => {
  it('the /crm/v1 surface is read-only, and a token in the query string is not a credential', () => {
    const reads = h.app.platform.routeTable.filter((r) => r.url.startsWith('/api/crm/v1'));
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) {
      expect(['GET', 'HEAD'], `${r.method} ${r.url}`).toContain(r.method);
      expect(r.auth).toBe('crm_read');
    }
    const manage = h.app.platform.routeTable.filter((r) => r.url.startsWith('/api/crm-read/tokens'));
    expect(manage.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /api/crm-read/tokens',
      'HEAD /api/crm-read/tokens',
      'POST /api/crm-read/tokens',
      'POST /api/crm-read/tokens/:id/revoke',
    ]);
    for (const r of manage) expect(r.auth).toBe('crm_read.manage');
  });

  it('response schemas name every field and reject a wildcard or an extra key', () => {
    const keys: Record<string, string[]> = {};
    for (const [name, schema] of Object.entries(CRM_RESPONSE_SCHEMAS)) {
      const def = (schema as { _zod?: { def?: { type?: string; catchall?: { _zod?: { def?: { type?: string } } } } } })._zod?.def;
      expect(def?.type, name).toBe('object');
      expect(def?.catchall?._zod?.def?.type, name).toBe('never');
      keys[name] = Object.keys((schema as { shape: Record<string, unknown> }).shape).sort();
    }
    expect(keys.Person).toEqual(['addresses', 'assignedUserId', 'contacted', 'created', 'emails', 'firstName', 'id', 'lastName', 'name', 'phones', 'source', 'sourceId', 'stage', 'tags', 'updated']);
    expect(keys.Activity).toEqual(['activityKind', 'appointmentKind', 'body', 'created', 'dealId', 'direction', 'durationSeconds', 'endsAt', 'from', 'id', 'location', 'occurredAt', 'outcome', 'personId', 'phone', 'startsAt', 'status', 'subject', 'to', 'type', 'updated', 'userId']);
    expect(keys.Deal).toEqual(['closedAt', 'created', 'id', 'name', 'people', 'price', 'priceCents', 'projectedCloseDate', 'side', 'stageId', 'status', 'updated', 'users']);
    expect(() => Person.parse({ id: '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b', tenantId: 'nope' })).toThrow();
    expect(() => Deal.parse({ id: '018f1a2b-3c4d-7e5f-8a9b-0c1d2e3f4a5b', grossCommissionCents: 1 })).toThrow();
    expect(() => Activity.parse({ id: 'call_x', recordingUrl: 'https://example.test/rec' })).toThrow();
  });

  it('only a re-authenticated Owner can mint a token, the secret is shown once, and only its hash is stored', async () => {
    await h.su.query("UPDATE sessions SET reauthenticated_at = now() - interval '16 minutes' WHERE user_id = $1 AND revoked_at IS NULL", [owner.userId]);
    expect((await owner.post('/api/crm-read/tokens', { name: 'too old' })).statusCode).toBe(401);
    await reauth(owner);
    expect((await admin.post('/api/crm-read/tokens', { name: 'nope' })).statusCode).toBe(404);
    const created = await issue(owner, 'Coaching sync');
    expect(h.logs.join('\n')).not.toContain(created.token);
    const listed = (await owner.get('/api/crm-read/tokens')).json() as { tokens: { id: string; token?: string; prefix: string }[] };
    const row = listed.tokens.find((t) => t.id === created.id);
    expect(row?.prefix).toBe(created.prefix);
    expect(row).not.toHaveProperty('token');
    const stored = await h.su.query<{ match: boolean; len: number; prefix: string }>(
      `SELECT token_hash = digest($2, 'sha256') AS match, octet_length(token_hash) AS len, token_prefix AS prefix
         FROM crm_read_tokens WHERE id = $1`,
      [created.id, created.token],
    );
    expect(stored.rows[0]).toEqual({ match: true, len: 32, prefix: created.prefix });
    const text = await h.su.query<{ blob: string }>(
      `SELECT (name || ' ' || token_prefix || ' ' || encode(token_hash, 'hex')) AS blob FROM crm_read_tokens WHERE id = $1`,
      [created.id],
    );
    expect(text.rows[0]!.blob).not.toContain(created.token);
  });

  it('a token reads only its tenant, a revoked token is 401 on the next request, and every read is audited', async () => {
    const token = await issue(owner, 'Tenant scope');
    const foreign = await other.post('/api/contacts', { commandId: randomUUID(), firstName: 'Foreign', lastName: 'Person', phones: ['+12015550198'] });
    expect(foreign.statusCode, foreign.body).toBe(201);
    const foreignId = (foreign.json() as { contact: { id: string } }).contact.id;
    const mine = await owner.post('/api/contacts', {
      commandId: randomUUID(),
      firstName: 'Ada',
      lastName: 'Lovelace',
      phones: ['+12015550100'],
      emails: ['ada.crmread@example.test'],
      address: { kind: 'home', line1: '1 Synthetic Lane', city: 'Testville', region: 'NY', postalCode: '10001', country: 'US' },
      stage: 'active',
    });
    expect(mine.statusCode, mine.body).toBe(201);
    const id = (mine.json() as { contact: { id: string } }).contact.id;
    await withTenantTx(owner.actor(), async (tx) => {
      const { sql } = await import('kysely');
      await sql`UPDATE contacts SET imported_fields = ${JSON.stringify({ secretMarker: 'not-in-the-api' })}::jsonb WHERE id = ${id}::uuid`.execute(tx);
      await sql`INSERT INTO contact_attributes (tenant_id, id, contact_id, key, value, sensitivity, self_reported)
                VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${id}::uuid, 'va_loan_interest', '"yes-va-proxy"'::jsonb, 'protected_proxy', true)`.execute(tx);
      await sql`UPDATE tenant_settings SET stage_labels = '{"active":"Hot"}'::jsonb WHERE tenant_id = app.tenant_id()`.execute(tx);
    }, { db: h.database });

    expect((await crm(token.token, `/api/crm/v1/people/${foreignId}`)).statusCode).toBe(404);
    expect((await crm('ros_' + 'a'.repeat(43), '/api/crm/v1/people')).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/crm/v1/people' })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: '/api/crm/v1/people', headers: { authorization: `Bearer ${token.token}`, origin: 'http://localhost:5173', 'content-type': 'application/json' }, payload: '{}' })).statusCode).toBe(404);
    expect((await crm(token.token, '/api/crm/v1/people?token=nope')).statusCode).toBe(422);

    const page = await crm(token.token, '/api/crm/v1/people?limit=50');
    expect(page.statusCode, page.body).toBe(200);
    const body = page.json() as { people: { id: string; name: string; stage: string; phones: { value: string }[]; emails: { value: string }[]; addresses: { street: string | null }[]; tags: string[] }[]; _metadata: { next: string | null; collection: string } };
    expect(body.people.map((p) => p.id)).toContain(id);
    expect(body.people.map((p) => p.id)).not.toContain(foreignId);
    const person = body.people.find((p) => p.id === id)!;
    expect(person).toMatchObject({ name: 'Ada Lovelace', stage: 'active', phones: [{ value: '+12015550100', isPrimary: true }], emails: [{ value: 'ada.crmread@example.test' }] });
    expect(person.addresses[0]).toMatchObject({ street: '1 Synthetic Lane', city: 'Testville', state: 'NY', code: '10001' });
    const raw = page.body;
    for (const hidden of ['not-in-the-api', 'yes-va-proxy', 'tenant_id', 'address_hmac', 'password', 'argon2', 'confidence', token.token]) {
      expect(raw).not.toContain(hidden);
    }
    expect(Object.keys(person).sort()).toEqual(Object.keys(Person.shape).sort());

    const one = await crm(token.token, `/api/crm/v1/people/${id}`);
    expect(one.statusCode).toBe(200);
    expect((one.json() as { id: string }).id).toBe(id);

    const stages = await crm(token.token, '/api/crm/v1/stages');
    expect(stages.statusCode).toBe(200);
    const stageBody = stages.json() as { stages: { id: string; name: string; pipeline: string }[]; _metadata: { next: null } };
    expect(stageBody.stages.find((s) => s.id === 'active' && s.pipeline === 'people')?.name).toBe('Hot');
    expect(stageBody.stages.filter((s) => s.pipeline === 'deals').map((s) => s.id)).toEqual(['prospect', 'agreement_signed', 'active', 'under_contract', 'closed', 'lost']);
    expect(stageBody._metadata.next).toBeNull();
    const future = await crm(token.token, '/api/crm/v1/stages?updatedSince=2999-01-01T00:00:00Z');
    expect((future.json() as { stages: unknown[] }).stages).toEqual([]);

    const users = await crm(token.token, '/api/crm/v1/users');
    expect(users.statusCode).toBe(200);
    const agents = (users.json() as { users: { id: string; email: string; role: string }[] }).users;
    expect(agents.map((u) => u.id)).toContain(owner.userId);
    expect(agents.map((u) => u.id)).not.toContain(other.userId);
    expect(users.body).not.toContain('argon2');

    const note = await owner.post(`/api/contacts/${id}/notes`, { body: 'Met at the open house on Synthetic Lane.' });
    expect(note.statusCode, note.body).toBe(201);
    const starts = new Date(Date.now() + 86_400_000).toISOString();
    const ends = new Date(Date.now() + 90_000_000).toISOString();
    const appt = await owner.post('/api/appointments', { kind: 'buyer_consult', startsAt: starts, endsAt: ends, contactId: id, location: '1 Synthetic Lane' });
    expect(appt.statusCode, appt.body).toBe(201);
    const deal = await owner.post('/api/deals', { primaryContactId: id, side: 'buy', priceCents: 45_000_000, name: 'Ada purchase' });
    expect(deal.statusCode, deal.body).toBe(201);
    const dealId = (deal.json() as { deal: { id: string } }).deal.id;

    const conv = randomUUID();
    const callId = randomUUID();
    const textId = randomUUID();
    const emailId = randomUUID();
    await replica([
      { text: `INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1, $2, $3) ON CONFLICT (tenant_id, contact_id) DO NOTHING`, values: [owner.tenantId, conv, id] },
    ]);
    const convId = (await h.su.query<{ id: string }>(`SELECT id::text AS id FROM conversations WHERE tenant_id = $1 AND contact_id = $2`, [owner.tenantId, id])).rows[0]!.id;
    await replica([
      {
        text: `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, client_address, initiator, status, started_at, recording_mode, recording_decision, agent_user_id, outcome, outcome_logged_at, outcome_logged_by_user_id, duration_s)
               VALUES ($1, $2, $3, $4, 'inbound', '+12015550100', 'client', 'completed', now(), 'off', '{}', $5, 'connected', now(), $5, 42)`,
        values: [owner.tenantId, callId, convId, id, owner.userId],
      },
      {
        text: `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, body, status, initiator, occurred_at)
               VALUES ($1, $2, $3, $4, 'sms', 'inbound', '+12015550199', '+12015550100', 'Can we see the house Thursday?', 'received', 'client', now())`,
        values: [owner.tenantId, textId, convId, id],
      },
      {
        text: `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, from_address, to_address, subject, body, status, initiator, occurred_at)
               VALUES ($1, $2, $3, $4, 'email', 'inbound', 'ada.crmread@example.test', 'ada.agent@example.test', 'Thursday', 'Thursday works.', 'received', 'client', now())`,
        values: [owner.tenantId, emailId, convId, id],
      },
    ]);

    const events: { id: string; type: string }[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const url = cursor ? `/api/crm/v1/events?limit=2&cursor=${encodeURIComponent(cursor)}` : '/api/crm/v1/events?limit=2';
      const res = await crm(token.token, url);
      expect(res.statusCode, res.body).toBe(200);
      const page = res.json() as { events: { id: string; type: string; phone?: string | null }[]; _metadata: { next: string | null } };
      events.push(...page.events);
      cursor = page._metadata.next;
      if (!cursor) break;
    }
    expect(new Set(events.map((e) => e.type))).toEqual(new Set(['note', 'appointment', 'call', 'text', 'email']));
    expect(events.map((e) => e.id).sort()).toEqual([...new Set(events.map((e) => e.id))].sort());
    const call = events.find((e) => e.id === `call_${callId}`);
    expect(call).toBeTruthy();
    expect(JSON.stringify(events)).not.toContain('recording');
    const callGet = await crm(token.token, `/api/crm/v1/events/call_${callId}`);
    expect(callGet.statusCode).toBe(200);
    expect((callGet.json() as { phone: string; durationSeconds: number }).durationSeconds).toBe(42);
    expect((await crm(token.token, `/api/crm/v1/events/call_${foreignId}`)).statusCode).toBe(404);

    const deals = await crm(token.token, '/api/crm/v1/deals');
    expect(deals.statusCode).toBe(200);
    const foundDeal = (deals.json() as { deals: { id: string; price: number; priceCents: number; people: { id: string }[] }[] }).deals.find((d) => d.id === dealId);
    expect(foundDeal).toMatchObject({ price: 450_000, priceCents: 45_000_000 });
    expect(foundDeal?.people.map((p) => p.id)).toContain(id);
    expect(deals.body).not.toContain('grossCommission');
    expect(Object.keys(foundDeal!).sort()).toEqual(Object.keys(Deal.shape).sort());

    const audited = await h.su.query<{ n: string; blob: string }>(
      `SELECT count(*)::text AS n, coalesce(string_agg(changes::text, ' '), '') AS blob
         FROM audit_log WHERE tenant_id = $1 AND action = 'crm_read.read' AND entity_id = $2`,
      [owner.tenantId, token.id],
    );
    expect(Number(audited.rows[0]!.n)).toBeGreaterThan(0);
    expect(audited.rows[0]!.blob).not.toContain('+12015550100');
    expect(audited.rows[0]!.blob).not.toContain(token.token);
    expect(audited.rows[0]!.blob).toContain('people');

    const revoked = await owner.post(`/api/crm-read/tokens/${token.id}/revoke`, {});
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await crm(token.token, '/api/crm/v1/people')).statusCode).toBe(401);
    expect(code(revoked.body)).toBeUndefined();
    const again = await owner.post(`/api/crm-read/tokens/${token.id}/revoke`, {});
    expect(again.statusCode).toBe(200);
  });

  it('pages are stable across a tie, and updatedSince returns only rows at or after that instant', async () => {
    const local = await h.signup();
    await reauth(local);
    const token = await issue(local, 'Cursor');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    await replica([
      {
        text: `INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, ownership_state, ownership_seq, ownership_command_id, created_at, updated_at)
               SELECT $1, id, 'Tie', 'Row', 'Tie Row', 'unassigned', 1, gen_random_uuid(), timestamptz '2024-03-01 00:00:00+00', timestamptz '2024-03-01 00:00:00+00'
                 FROM unnest($2::uuid[]) AS id`,
        values: [local.tenantId, ids],
      },
    ]);
    const seen = await collect(token.token, '/api/crm/v1/people?limit=1');
    const ordered = (await h.su.query<{ id: string }>(
      `SELECT id::text AS id FROM contacts WHERE tenant_id = $1 ORDER BY updated_at, id`,
      [local.tenantId],
    )).rows.map((r) => r.id);
    expect(seen).toEqual(ordered);
    expect(new Set(seen).size).toBe(3);

    const since = await crm(token.token, '/api/crm/v1/people?updatedSince=2024-04-01T00:00:00Z');
    expect((since.json() as { people: unknown[] }).people).toEqual([]);
    const bad = await crm(token.token, '/api/crm/v1/people?cursor=aaaa');
    expect(bad.statusCode).toBe(422);
  });

  it('pages 10000 people with a stable cursor, and updatedSince keeps only the later half', async () => {
    const local = await h.signup();
    await reauth(local);
    const token = await issue(local, 'Ten thousand');
    await replica([
      {
        text: `INSERT INTO contacts (tenant_id, id, first_name, last_name, display_name, ownership_state, ownership_seq, ownership_command_id, created_at, updated_at)
               SELECT $1, gen_random_uuid(), 'Pat' || g, 'Lee' || g, 'Pat' || g || ' Lee' || g, 'unassigned', 1, gen_random_uuid(),
                      timestamptz '2024-01-01 00:00:00+00' + (g || ' seconds')::interval,
                      timestamptz '2024-01-01 00:00:00+00' + (g || ' seconds')::interval
                 FROM generate_series(1, 10000) g`,
        values: [local.tenantId],
      },
    ]);
    const seen = await collect(token.token, '/api/crm/v1/people?limit=100');
    expect(seen).toHaveLength(10_000);
    expect(new Set(seen).size).toBe(10_000);
    const ordered = (await h.su.query<{ id: string }>(`SELECT id::text AS id FROM contacts WHERE tenant_id = $1 ORDER BY updated_at, id`, [local.tenantId])).rows.map((r) => r.id);
    expect(seen).toEqual(ordered);

    const later = await collect(token.token, '/api/crm/v1/people?limit=100&updatedSince=2024-01-01T01:23:20.000Z');
    const cutoff = Date.parse('2024-01-01T01:23:20.000Z');
    const expected = (await h.su.query<{ id: string }>(
      `SELECT id::text AS id FROM contacts WHERE tenant_id = $1 AND updated_at >= $2::timestamptz ORDER BY updated_at, id`,
      [local.tenantId, '2024-01-01T01:23:20.000Z'],
    )).rows.map((r) => r.id);
    expect(later).toEqual(expected);
    expect(later.length).toBe(5001);
    expect(cutoff).toBe(Date.parse('2024-01-01T01:23:20.000Z'));
  }, 120_000);
});

async function collect(token: string, base: string): Promise<string[]> {
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let pages = 0; pages < 200; pages++) {
    const url = cursor ? `${base}&cursor=${encodeURIComponent(cursor)}` : base;
    const res = await crm(token, url);
    expect(res.statusCode, res.body).toBe(200);
    const page = res.json() as { people: { id: string }[]; _metadata: { next: string | null } };
    seen.push(...page.people.map((p) => p.id));
    if (!page._metadata.next) return seen;
    expect(page.people.length).toBeGreaterThan(0);
    cursor = page._metadata.next;
  }
  throw new Error('cursor did not finish');
}
