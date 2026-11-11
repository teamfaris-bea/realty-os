// The feed's "waiting for your reply" inputs were rewritten for scale (lane scale-250k): per-contact index
// range scans from the agent's own book instead of a tenant-wide window scan. Same rows as before: checked
// against the original SQL for every agent on generated data, plus hand-placed boundary cases.
import type { TenantId, UserId } from '@realty/core/foundation';
import { instant } from '@realty/core/foundation';
import { type Database, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvelopeService } from '../crypto/envelope.js';
import { loadFeedInputs } from '../workspace/repos/feedInputs.js';
import { defaultSpec, generateLoad, loadUuid } from './generate.js';
import { kekFromEnv } from './seed.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const S = 'load-big';
const T = loadUuid(S, 'tenant') as TenantId;
let db: TestDb;
let su: pg.Client;
let app: Database;
let agents: string[] = [];
const placed: Record<string, string> = {};

/** the pre-rewrite queries, verbatim apart from the parameters */
const OLD_INBOUND = (u: string, nowIso: string) => sql<{ id: string }>`
  SELECT m.id FROM contacts c JOIN messages m ON m.tenant_id = c.tenant_id AND m.contact_id = c.id
   WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${u} AND c.deleted_at IS NULL
     AND m.direction = 'inbound' AND NOT m.imported
     AND m.occurred_at > ${nowIso}::timestamptz - make_interval(days => 14)
     AND m.occurred_at > COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)
   ORDER BY m.occurred_at DESC LIMIT 300`;
const OLD_MISSED = (u: string, nowIso: string) => sql<{ id: string }>`
  SELECT k.id FROM contacts c JOIN calls k ON k.tenant_id = c.tenant_id AND k.contact_id = c.id
   WHERE c.tenant_id = app.tenant_id() AND c.ownership_state = 'owned' AND c.owner_user_id = ${u} AND c.deleted_at IS NULL
     AND k.direction = 'inbound' AND NOT k.imported AND k.answered_at IS NULL
     AND k.status IN ('no_answer','busy','voicemail','canceled','failed','completed')
     AND k.started_at > ${nowIso}::timestamptz - make_interval(days => 14)
     AND k.started_at > COALESCE(c.last_human_touch_at, '-infinity'::timestamptz)
   ORDER BY k.started_at DESC LIMIT 300`;

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(1_500, PH);
  spec.tenants = spec.tenants.slice(0, 1);
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  agents = (await su.query<{ user_id: string }>(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND role = 'agent' ORDER BY user_id`, [T])).rows.map((r) => r.user_id);
  // boundary cases on two of agent 0's contacts and one of agent 1's
  const pick = async (owner: string, n: number) =>
    (await su.query<{ id: string; conv: string; phone: string; team: string; pn: string }>(
      `SELECT c.id, v.id AS conv, p.address AS phone, n.e164 AS team, n.id AS pn FROM contacts c
         JOIN conversations v ON v.tenant_id = c.tenant_id AND v.contact_id = c.id
         JOIN contact_points p ON p.tenant_id = c.tenant_id AND p.contact_id = c.id AND p.kind = 'phone' AND p.is_primary
         JOIN phone_numbers n ON n.tenant_id = c.tenant_id AND n.assigned_user_id = c.owner_user_id
        WHERE c.tenant_id = $1 AND c.owner_user_id = $2 AND c.ownership_state = 'owned' ORDER BY c.id OFFSET $3 LIMIT 1`, [T, owner, n])).rows[0]!;
  const x = await pick(agents[0]!, 0);
  const y = await pick(agents[0]!, 1);
  const z = await pick(agents[1]!, 0);
  await su.query(`UPDATE contacts SET last_human_touch_at = now() - interval '2 days' WHERE tenant_id = $1 AND id = $2`, [T, x.id]);
  await su.query(`UPDATE contacts SET last_human_touch_at = NULL WHERE tenant_id = $1 AND id = $2`, [T, y.id]);
  const msg = async (key: string, c: typeof x, ago: string) => {
    const r = await su.query<{ id: string }>(
      `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status, initiator, occurred_at)
       VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'inbound', $4, $5, $6, 'Still interested?', 'received', 'client', now() - $7::interval) RETURNING id`,
      [T, c.conv, c.id, c.pn, c.phone, c.team, ago]);
    placed[key] = r.rows[0]!.id;
  };
  const call = async (key: string, c: typeof x, ago: string) => {
    const r = await su.query<{ id: string }>(
      `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, client_address, initiator, status, started_at, ended_at,
                          recording_mode, recording_decision)
       VALUES ($1, gen_random_uuid(), $2, $3, 'inbound', $4, $5, 'client', 'no_answer', now() - $6::interval, now() - $6::interval + interval '20 seconds',
               'off', '{}'::jsonb) RETURNING id`, [T, c.conv, c.id, c.pn, c.phone, ago]);
    placed[key] = r.rows[0]!.id;
  };
  await msg('afterTouch', x, '1 day');
  await msg('beforeTouch', x, '3 days');
  await msg('untouchedInWindow', y, '13 days');
  await msg('untouchedOutsideWindow', y, '15 days');
  await msg('otherAgent', z, '1 hour');
  await call('missedAfterTouch', x, '1 day');
  await call('missedBeforeTouch', x, '3 days');
  await su.query('ANALYZE messages; ANALYZE calls; ANALYZE contacts');
  app = createDatabase({ url: db.appUserUrl, max: 2 });
}, 300_000);
afterAll(async () => {
  await app?.close();
  await su?.end();
  await db?.drop();
});

const actorOf = (u: string) => ({ kind: 'user' as const, userId: u as UserId, tenantId: T, role: 'agent' as const, sessionId: 'feed-inputs-test' });

describe('feed inputs: unanswered client messages and missed calls', () => {
  it('include only the agent’s own waiting items after the last touch and inside the 14-day window', async () => {
    const env = new EnvelopeService(kekFromEnv());
    const got = await withTenantTx(actorOf(agents[0]!), async (tx, now) => (await loadFeedInputs(tx, actorOf(agents[0]!), env, now)).unansweredInbound.map((i) => i.id as string), { db: app });
    expect(got).toContain(placed.afterTouch);
    expect(got).toContain(placed.untouchedInWindow);
    expect(got).toContain(placed.missedAfterTouch);
    expect(got).not.toContain(placed.beforeTouch);
    expect(got).not.toContain(placed.untouchedOutsideWindow);
    expect(got).not.toContain(placed.missedBeforeTouch);
    expect(got).not.toContain(placed.otherAgent);
  });

  it('return exactly the rows of the original queries, for every agent', async () => {
    const env = new EnvelopeService(kekFromEnv());
    let total = 0;
    for (const u of agents) {
      await withTenantTx(actorOf(u), async (tx, now) => {
        const nowIso = new Date(instant(now)).toISOString();
        const fresh = (await loadFeedInputs(tx, actorOf(u), env, now)).unansweredInbound;
        const oldIds = [...(await OLD_INBOUND(u, nowIso).execute(tx)).rows, ...(await OLD_MISSED(u, nowIso).execute(tx)).rows].map((r) => r.id);
        expect(oldIds.length).toBeLessThan(300); // below the cap, so the sets must match exactly
        expect(new Set(fresh.map((i) => i.id as string))).toEqual(new Set(oldIds));
        total += oldIds.length;
      }, { db: app });
    }
    expect(total).toBeGreaterThan(50);
  }, 120_000);
});
