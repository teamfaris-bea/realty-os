// Test world for db/client integration tests: a provisioned tenant built ONLY through application
// paths as app_user (signup + app.provision_tenant, invites + auth.accept_invite, the owner's own
// writes for teams/routing, each agent's own push subscription), plus helpers for leads created
// through applyOwnershipCommand. The superuser pool is used only to read back state.
import { createHash, randomBytes } from 'node:crypto';
import type { Actor, ContactId, PondId, Role, SystemActor, TenantId, UserActor, UserId } from '@realty/core/foundation';
import type { InquiryFacts, OwnershipCommand } from '@realty/core/ownership';
import { sql } from 'kysely';
import pg from 'pg';
import { type Database, createDatabase } from '../src/client.js';
import { applyOwnershipCommand, defaultIds, type OwnershipCommandResult } from '../src/ownership/apply.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createTestDb, type TestDb } from '../src/testing/index.js';

export const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
export const ids = defaultIds();
export const uuid = () => ids.next<'X'>() as string;

export interface Member {
  id: UserId;
  role: Role;
  actor: UserActor;
}

export interface World {
  tenantId: TenantId;
  slug: string;
  owner: Member;
  agents: Member[];
  tl: Member | null;
  teamId: string;
  pondId: PondId;
  ruleId: string | null;
  leadSourceId: string;
  system: (via?: SystemActor['via']) => SystemActor;
}

export interface Harness {
  db: TestDb;
  app: Database;
  su: pg.Pool;
  close(): Promise<void>;
}

export async function createHarness(max = 6): Promise<Harness> {
  const db = await createTestDb();
  const app = createDatabase({ url: db.appUserUrl, max });
  const su = new pg.Pool({ connectionString: db.ownerUrl, max: 2 });
  // An idle client can be terminated by the server (a test database dropped WITH (FORCE), a restart):
  // without a listener pg re-throws it as an unhandled error. Queries in flight still reject normally.
  su.on('error', () => {});
  return {
    db,
    app,
    su,
    async close() {
      await app.close();
      await su.end();
      await db.drop();
    },
  };
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function userActor(tenantId: TenantId, id: UserId, role: Role): UserActor {
  return { kind: 'user', userId: id, tenantId, role, sessionId: 'test-session' };
}

export interface WorldOptions {
  agents?: number;
  teamLead?: boolean;
  /** a routing rule matching inquiry type 'buy' with every agent (+ TL) as members */
  rule?: 'round_robin' | 'weighted' | null;
  /** agents with a live push subscription (a working critical channel, R-OWN-11 #4) */
  pushFor?: 'all' | 'none';
  timezone?: string;
}

export async function createWorld(app: Database, o: WorldOptions = {}): Promise<World> {
  const tenantId = uuid() as TenantId;
  const ownerId = uuid() as UserId;
  const slug = `t-${randomBytes(4).toString('hex')}`;
  const pondId = uuid() as PondId;
  const teamId = uuid();
  await withPreTenant(
    async (tx) => {
      await sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${ownerId}, ${`owner@${slug}.test`}, 'Olivia Owner', ${PH})`.execute(tx);
      await sql`SELECT app.provision_tenant(${tenantId}, ${slug}, ${'Team ' + slug}, ${o.timezone ?? 'America/New_York'}, 'Test Realty LLC',
                ${ownerId}, ${uuid()}, ${teamId}, ${pondId}, '\\x01'::bytea, '\\x02'::bytea, '\\x03'::bytea, 'kek-test')`.execute(tx);
    },
    { userId: ownerId, db: app },
  );
  const owner: Member = { id: ownerId, role: 'owner', actor: userActor(tenantId, ownerId, 'owner') };
  const roles: Role[] = [...Array.from({ length: o.agents ?? 2 }, () => 'agent' as Role), ...(o.teamLead ? (['team_lead'] as Role[]) : [])];
  const members: Member[] = [];
  for (const [i, role] of roles.entries()) {
    const token = `invite-${slug}-${i}`;
    await withTenantTx(owner.actor, async (tx) => {
      await sql`INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
                VALUES (${tenantId}, ${uuid()}, ${`m${i}@${slug}.test`}, ${role}, ${sha(token)}, ${ownerId}, now() + interval '1 day')`.execute(tx);
    }, { db: app });
    const uid = uuid() as UserId;
    await withPreTenant(async (tx) => {
      await sql`SELECT * FROM auth.accept_invite(${sha(token)}, ${uid}, ${`Member ${i}`}, ${PH}, now())`.execute(tx);
    }, { db: app });
    members.push({ id: uid, role, actor: userActor(tenantId, uid, role) });
  }
  const tl = members.find((m) => m.role === 'team_lead') ?? null;
  const agents = members.filter((m) => m.role === 'agent');
  // teams: the TL leads the default team, everyone else is a member (Owner/Admin write)
  await withTenantTx(owner.actor, async (tx) => {
    for (const m of members) {
      await sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (${tenantId}, ${teamId}, ${m.id}, ${m.role === 'team_lead'})`.execute(tx);
    }
  }, { db: app });
  if ((o.pushFor ?? 'all') === 'all') {
    for (const m of members) {
      await withTenantTx(m.actor, async (tx) => {
        await sql`INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_enc, keys_enc, key_version, endpoint_hash)
                  VALUES (${tenantId}, ${uuid()}, ${m.id}, '\\x00'::bytea, '\\x00'::bytea, 1, ${randomBytes(32)})`.execute(tx);
      }, { db: app });
    }
  }
  const leadSourceId = uuid();
  await withTenantTx(owner.actor, async (tx) => {
    await sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (${tenantId}, ${leadSourceId}, 'Website', 'website')`.execute(tx);
  }, { db: app });
  let ruleId: string | null = null;
  if (o.rule) {
    ruleId = uuid();
    await withTenantTx(owner.actor, async (tx) => {
      await sql`INSERT INTO routing_rules (tenant_id, id, position, name, match, strategy)
                VALUES (${tenantId}, ${ruleId}, 1, 'Buyers', '{"lead_types":["buy"]}'::jsonb, ${o.rule})`.execute(tx);
      for (const m of [...agents, ...(tl ? [tl] : [])]) {
        await sql`INSERT INTO routing_rule_members (tenant_id, rule_id, user_id, weight) VALUES (${tenantId}, ${ruleId}, ${m.id}, 1)`.execute(tx);
      }
    }, { db: app });
  }
  // the system actor is constructed only in tests and apps/api/src/worker (lint realty/no-system-actor)
  const system = (via: SystemActor['via'] = 'worker'): SystemActor => ({ kind: 'system', tenantId, via });
  return { tenantId, slug, owner, agents, tl, teamId, pondId, ruleId, leadSourceId, system };
}

export const BUY: InquiryFacts = { leadSourceId: null, inquiryType: 'buy', postalCode: null, priceMinCents: null, priceMaxCents: null };
export const SELL: InquiryFacts = { leadSourceId: null, inquiryType: 'sell', postalCode: null, priceMinCents: null, priceMaxCents: null };

/** A new intake lead (system/provider): routed by the rule (`BUY`) or to the default pond (`SELL`). */
export async function intakeLead(app: Database, w: World, inquiry: InquiryFacts = SELL, name = 'Pat Lead'): Promise<{ contactId: ContactId; result: OwnershipCommandResult }> {
  const contactId = uuid() as ContactId;
  const result = await applyOwnershipCommand(w.system('provider'), contactId, { kind: 'create', via: 'intake' }, {
    commandId: uuid(),
    newContact: { displayName: name, originalLeadSourceId: w.leadSourceId },
    inquiry: { ...inquiry, leadSourceId: w.leadSourceId as InquiryFacts['leadSourceId'] },
    db: app,
  });
  // the inquiry row intake writes after the contact (later re-routes match on it)
  await withTenantTx(w.system('provider'), async (tx) => {
    await sql`INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome)
              VALUES (${w.tenantId}, ${uuid()}, ${contactId}, ${w.leadSourceId}, now(), ${inquiry.inquiryType ?? 'general'},
                      ${'fp-' + contactId}, 'new_contact')`.execute(tx);
  }, { db: app });
  return { contactId, result };
}

export async function selfCreated(app: Database, w: World, m: Member, name = 'Sam Sphere'): Promise<ContactId> {
  const contactId = uuid() as ContactId;
  const r = await applyOwnershipCommand(m.actor, contactId, { kind: 'create', via: 'self' }, { commandId: uuid(), newContact: { displayName: name }, db: app });
  if (!r.outcome.ok) throw new Error(`self create rejected: ${JSON.stringify(r.outcome)}`);
  return contactId;
}

export function cmd(app: Database, actor: Actor, contactId: ContactId, c: OwnershipCommand, extra: { commandId?: string; expectedSeq?: number } = {}): Promise<OwnershipCommandResult> {
  return applyOwnershipCommand(actor, contactId, c, { commandId: extra.commandId ?? uuid(), ...(extra.expectedSeq !== undefined ? { expectedSeq: extra.expectedSeq } : {}), db: app });
}

/** Superuser read-back (bypasses RLS: assertions only). */
export async function suRows<T extends pg.QueryResultRow>(su: pg.Pool, text: string, values: unknown[] = []): Promise<T[]> {
  return (await su.query<T>(text, values)).rows;
}

export async function contactRow(su: pg.Pool, id: ContactId) {
  const [r] = await suRows<Record<string, unknown>>(su, 'SELECT * FROM contacts WHERE id = $1', [id]);
  return r!;
}

export async function ledger(su: pg.Pool, id: ContactId) {
  return suRows<{ seq: string; type: string; to_state: string; owner_user_id: string | null; command_id: string; actor_kind: string; payload: Record<string, unknown> }>(
    su,
    'SELECT * FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq',
    [id],
  );
}

export async function jobsFor(su: pg.Pool, tenantId: string) {
  return suRows<{ id: string; kind: string; dedupe_key: string | null; status: string; payload: Record<string, unknown>; run_at: Date }>(
    su,
    'SELECT * FROM jobs WHERE tenant_id = $1 ORDER BY id',
    [tenantId],
  );
}

/** Makes every pending job of the tenant due now (instead of waiting for run_at). */
export async function makeJobsDue(su: pg.Pool, tenantId: string): Promise<void> {
  await su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending'`, [tenantId]);
}

/**
 * Holds app.lock_contact on `contactIds` in a separate app_user session (system context of the
 * tenant) until `release()` is called: commands launched meanwhile all queue on the advisory lock,
 * so a test can force genuinely concurrent transactions instead of hoping for an overlap.
 */
export async function holdContactLocks(h: Harness, tenantId: string, contactIds: readonly string[]): Promise<{ release(): Promise<void>; pid: number }> {
  const c = new pg.Client({ connectionString: h.db.appUserUrl });
  await c.connect();
  await c.query('BEGIN');
  await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'system', true),
                        set_config('app.principal_type', 'staff', true)`, [tenantId]);
  for (const id of [...contactIds].sort()) await c.query('SELECT app.lock_contact($1)', [id]);
  const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  return {
    pid,
    async release() {
      await c.query('COMMIT');
      await c.end();
    },
  };
}

/** Waits until `n` sessions are blocked on an advisory lock held by backend `pid`. */
export async function waitForWaiters(su: pg.Pool, pid: number, n: number, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await su.query<{ n: string }>(
      `SELECT count(*) AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY (pg_blocking_pids(pid))`,
      [pid],
    );
    if (Number(r.rows[0]!.n) >= n) return;
    if (Date.now() > until) throw new Error(`timed out waiting for ${n} lock waiters (have ${r.rows[0]!.n})`);
    await new Promise((res) => setTimeout(res, 10));
  }
}

/** Fixture-only: runs SQL as the superuser with triggers (guards, append-only) disabled. */
export async function suFixture(su: pg.Pool, text: string, values: unknown[] = []): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = replica`);
    if (values.length > 0 && text.trim().replace(/;\s*$/, '').includes(';')) {
      // several statements: inline the (uuid / plain) values as literals and send one simple query
      const lit = (v: unknown) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
      await c.query(text.replace(/\$(\d+)/g, (_, i: string) => lit(values[Number(i) - 1])));
    } else {
      await c.query(text, values);
    }
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/** Every pending ownership.followup job of the tenant, oldest first. */
export async function pendingFollowups(su: pg.Pool, tenantId: string) {
  return suRows<{ id: string; payload: Record<string, unknown> }>(
    su,
    `SELECT id, payload FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.followup' AND status = 'pending' ORDER BY id`,
    [tenantId],
  );
}

/** Runs every pending ownership.followup job as the system actor (what the worker does) and marks it done. */
export async function drainFollowups(h: Harness, w: World): Promise<number> {
  const { runOwnershipFollowup } = await import('../src/ownership/followup.js');
  let n = 0;
  for (let round = 0; round < 5; round++) {
    const pending = await pendingFollowups(h.su, w.tenantId);
    if (pending.length === 0) break;
    for (const j of pending) {
      await runOwnershipFollowup(w.system('worker'), j.payload, { db: h.app });
      await h.su.query(`UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE id = $1`, [j.id]);
      n++;
    }
  }
  return n;
}
