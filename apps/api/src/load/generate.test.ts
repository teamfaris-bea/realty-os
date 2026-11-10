// The synthetic load generator (lane scale-250k): deterministic, loaded with every trigger ON, opt-outs
// keyed by the tenant's real HMAC key (so canContact and the dispatch guards see them), tenants isolated.
import type { TenantId, UserId } from '@realty/core/foundation';
import { type Database, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeService } from '../crypto/envelope.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
let a: TestDb;
let b: TestDb;
let su: pg.Pool;
let app: Database;
const spec = { ...defaultSpec(1_500, PH) };
spec.tenants = spec.tenants.slice(0, 2).map((t) => ({ ...t, contacts: t.index === 0 ? 1_500 : 300 }));

/** Row fingerprints that must not depend on the run's anchor instant. */
async function fingerprint(url: string): Promise<Record<string, string>> {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const q = async (text: string) => (await c.query<{ h: string }>(text)).rows[0]!.h;
    return {
      contacts: await q(`SELECT md5(string_agg(id::text || display_name || ownership_state || coalesce(owner_user_id::text, '') || stage, ',' ORDER BY id)) AS h FROM contacts`),
      points: await q(`SELECT md5(string_agg(address || encode(address_hmac, 'hex'), ',' ORDER BY id)) AS h FROM contact_points`),
      messages: await q(`SELECT md5(string_agg(id::text || direction || status || body, ',' ORDER BY id)) AS h FROM messages`),
      ledger: await q(`SELECT md5(string_agg(contact_id::text || seq || type || to_state, ',' ORDER BY contact_id, seq)) AS h FROM lead_ownership_events`),
      consent: await q(`SELECT md5(string_agg(encode(address_hmac, 'hex') || channel || purpose || status || ledger_event_count, ',' ORDER BY address_hmac, channel, purpose)) AS h FROM consent_state`),
      ages: await q(`SELECT md5(string_agg(extract(epoch FROM (SELECT max(created_at) FROM contacts) - created_at)::bigint::text, ',' ORDER BY id)) AS h FROM contacts`),
    };
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  a = await createTestDb();
  b = await createTestDb();
  await generateLoad(a.ownerUrl, kekFromEnv(), spec);
  await generateLoad(b.ownerUrl, kekFromEnv(), spec);
  su = new pg.Pool({ connectionString: a.ownerUrl, max: 2 });
  app = createDatabase({ url: a.appUserUrl, max: 2 });
}, 300_000);
afterAll(async () => {
  await app?.close();
  await su?.end();
  await a?.drop();
  await b?.drop();
});

const T0 = loadUuid('load-big', 'tenant') as TenantId;
const T1 = loadUuid('load-small-1', 'tenant') as TenantId;
const ownerOf = (slug: string) => ({ kind: 'user' as const, userId: loadUuid(slug, 'user:owner') as UserId, tenantId: loadUuid(slug, 'tenant') as TenantId, role: 'owner' as const, sessionId: 'load-test' });

describe('load generator', () => {
  it('is deterministic: two loads of the same spec produce the same rows (relative times included)', async () => {
    expect(await fingerprint(a.ownerUrl)).toEqual(await fingerprint(b.ownerUrl));
  });

  it('loads the requested sizes with every table populated', async () => {
    const n = async (t: string, tenant: string) => Number((await su.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t} WHERE tenant_id = $1`, [tenant])).rows[0]!.n);
    expect(await n('contacts', T0)).toBe(1_500);
    expect(await n('contacts', T1)).toBe(300);
    for (const t of ['contact_points', 'messages', 'calls', 'notes', 'tasks', 'appointments', 'deals', 'deal_members', 'listings', 'consent_events', 'consent_state', 'suppressions', 'behavior_events', 'lead_inquiries', 'conversations']) {
      expect(await n(t, T0), t).toBeGreaterThan(0);
    }
    // about 8 messages per contact
    expect((await n('messages', T0)) / 1_500).toBeGreaterThan(5);
  });

  it('keeps every trigger enabled and the ownership projection at the ledger head (the guards ran)', async () => {
    const disabled = await su.query(`SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`);
    expect(disabled.rows).toEqual([]);
    const off = await su.query(
      `SELECT c.id FROM contacts c WHERE c.ownership_seq <> (SELECT max(seq) FROM lead_ownership_events e WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id)`);
    expect(off.rows).toEqual([]);
  });

  it('D1: every STOP is keyed by the tenant HMAC the API computes, and the dispatch guard refuses a send to it', async () => {
    const stop = (await su.query<{ contact_id: string; from_address: string; conversation_id: string }>(
      `SELECT contact_id, from_address, conversation_id FROM messages WHERE tenant_id = $1 AND opt_out_keyword = 'STOP' ORDER BY id LIMIT 1`, [T0])).rows[0]!;
    expect(stop).toBeDefined();
    const env = new EnvelopeService(kekFromEnv());
    await withTenantTx(ownerOf('load-big'), async (tx) => {
      const h = Buffer.from(await env.inTx(tx, T0).hmacAddress(T0, stop.from_address));
      const st = await sql<{ status: string }>`SELECT status FROM consent_state WHERE channel = 'sms' AND purpose = 'informational' AND address_hmac = ${h}`.execute(tx);
      expect(st.rows.map((r) => r.status)).toEqual(['revoked']);
    }, { db: app });
    // the 0013/0014 guard, as the database sees it (superuser insert: no RLS, the trigger still runs)
    const num = (await su.query<{ id: string; e164: string }>(`SELECT id, e164 FROM phone_numbers WHERE tenant_id = $1 AND purpose = 'agent_direct' LIMIT 1`, [T0])).rows[0]!;
    await expect(su.query(
      `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator,
                             initiated_by_user_id, purpose, dispatched_at, occurred_at)
       VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, $5, $6, 'hello', 'sent', 'human', $7, 'informational', now(), now())`,
      [T0, stop.conversation_id, stop.contact_id, num.id, num.e164, stop.from_address, loadUuid('load-big', 'user:owner')])).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
  });

  it('R-TEN-2: the app role sees nothing without context and only its own tenant with it', async () => {
    const c = new pg.Client({ connectionString: a.appUserUrl });
    await c.connect();
    try {
      expect((await c.query(`SELECT count(*)::int AS n FROM contacts`)).rows[0]!.n).toBe(0);
    } finally {
      await c.end();
    }
    const seen = await withTenantTx(ownerOf('load-small-1'), async (tx) => (await sql<{ t: string; n: number }>`SELECT tenant_id AS t, count(*)::int AS n FROM contacts GROUP BY 1`.execute(tx)).rows, { db: app });
    expect(seen).toEqual([{ t: T1, n: 300 }]);
  });
});
