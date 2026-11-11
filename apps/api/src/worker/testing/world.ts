// Test world for api/jobs-worker integration tests (per-test database via createTestDb()).
// Tenants, members and leads are built ONLY through application paths as app_user (signup +
// app.provision_tenant, invites + auth.accept_invite, the owner's own writes, applyOwnershipCommand).
// The superuser pool reads back state and writes fixtures that have no application path yet.
import { createHash, randomBytes } from 'node:crypto';
import type { Actor, ContactId, PondId, Role, SystemActor, TenantId, UserActor, UserId } from '@realty/core/foundation';
import type { InquiryFacts, OwnershipCommand } from '@realty/core/ownership';
import {
  type Database,
  type OwnershipCommandResult,
  applyOwnershipCommand,
  applyOwnershipCommandInTx,
  createDatabase,
  defaultIds,
  derivedCommandId,
  withPreTenant,
  withTenantTx,
} from '@realty/db';
import { createTestDb, type TestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { TIMER_KIND_OF, TimerPayload } from '../contracts.js';
import { HandlerRegistry } from '../registry.js';
import { systemActor } from '../systemActor.js';
import type { JobHandler, TxJobHandler } from '../types.js';

export const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
export const ids = defaultIds();
export const uuid = () => ids.next<'X'>() as string;

export interface Harness {
  db: TestDb;
  app: Database;
  su: pg.Pool;
  close(): Promise<void>;
}

export async function createHarness(max = 5): Promise<Harness> {
  const db = await createTestDb();
  const app = createDatabase({ url: db.appUserUrl, max, applicationName: 'worker-test' });
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
  pondId: PondId;
  leadSourceId: string;
  system(via?: SystemActor['via']): SystemActor;
}

const sha = (s: string) => createHash('sha256').update(s).digest();

export function userActor(tenantId: TenantId, id: UserId, role: Role): UserActor {
  return { kind: 'user', userId: id, tenantId, role, sessionId: 'test-session' };
}

export async function createWorld(app: Database, o: { agents?: number; rule?: boolean; timezone?: string } = {}): Promise<World> {
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
  const agents: Member[] = [];
  for (let i = 0; i < (o.agents ?? 2); i++) {
    const token = `invite-${slug}-${i}`;
    await withTenantTx(owner.actor, async (tx) => {
      await sql`INSERT INTO invites (tenant_id, id, email, role, token_hash, invited_by_user_id, expires_at)
                VALUES (${tenantId}, ${uuid()}, ${`m${i}@${slug}.test`}, 'agent', ${sha(token)}, ${ownerId}, now() + interval '1 day')`.execute(tx);
    }, { db: app });
    const uid = uuid() as UserId;
    await withPreTenant(async (tx) => {
      await sql`SELECT * FROM auth.accept_invite(${sha(token)}, ${uid}, ${`Member ${i}`}, ${PH}, now())`.execute(tx);
    }, { db: app });
    agents.push({ id: uid, role: 'agent', actor: userActor(tenantId, uid, 'agent') });
  }
  await withTenantTx(owner.actor, async (tx) => {
    for (const m of agents) await sql`INSERT INTO team_members (tenant_id, team_id, user_id, is_lead) VALUES (${tenantId}, ${teamId}, ${m.id}, false)`.execute(tx);
  }, { db: app });
  // each agent's own push subscription: a working critical channel (routing eligibility, R-OWN-11 #4)
  for (const m of agents) {
    await withTenantTx(m.actor, async (tx) => {
      await sql`INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_enc, keys_enc, key_version, endpoint_hash)
                VALUES (${tenantId}, ${uuid()}, ${m.id}, '\\x00'::bytea, '\\x00'::bytea, 1, ${randomBytes(32)})`.execute(tx);
    }, { db: app });
  }
  const leadSourceId = uuid();
  await withTenantTx(owner.actor, async (tx) => {
    await sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (${tenantId}, ${leadSourceId}, 'Website', 'website')`.execute(tx);
    // routing hours cover the whole day so offer windows are wall-clock windows whenever the test runs
    await sql`UPDATE tenant_settings SET routing_hours_start = '00:00', routing_hours_end = '23:59:59' WHERE tenant_id = ${tenantId}`.execute(tx);
    if (o.rule ?? true) {
      const ruleId = uuid();
      await sql`INSERT INTO routing_rules (tenant_id, id, position, name, match, strategy)
                VALUES (${tenantId}, ${ruleId}, 1, 'Buyers', '{"lead_types":["buy"]}'::jsonb, 'round_robin')`.execute(tx);
      for (const m of agents) await sql`INSERT INTO routing_rule_members (tenant_id, rule_id, user_id, weight) VALUES (${tenantId}, ${ruleId}, ${m.id}, 1)`.execute(tx);
    }
  }, { db: app });
  return { tenantId, slug, owner, agents, pondId, leadSourceId, system: (via = 'worker') => systemActor(tenantId, via) };
}

export const BUY: InquiryFacts = { leadSourceId: null, inquiryType: 'buy', postalCode: null, priceMinCents: null, priceMaxCents: null };

/** A new intake lead routed by the buyer rule: offered to one agent. */
export async function intakeLead(app: Database, w: World): Promise<{ contactId: ContactId; result: OwnershipCommandResult }> {
  const contactId = uuid() as ContactId;
  const result = await applyOwnershipCommand(w.system('provider'), contactId, { kind: 'create', via: 'intake' }, {
    commandId: uuid(),
    newContact: { displayName: 'Pat Lead', originalLeadSourceId: w.leadSourceId },
    inquiry: { ...BUY, leadSourceId: w.leadSourceId as InquiryFacts['leadSourceId'] },
    db: app,
  });
  await withTenantTx(w.system('provider'), async (tx) => {
    await sql`INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome)
              VALUES (${w.tenantId}, ${uuid()}, ${contactId}, ${w.leadSourceId}, now(), 'buy', ${'fp-' + contactId}, 'new_contact')`.execute(tx);
  }, { db: app });
  return { contactId, result };
}

export async function selfCreated(app: Database, m: Member): Promise<ContactId> {
  const contactId = uuid() as ContactId;
  const r = await applyOwnershipCommand(m.actor, contactId, { kind: 'create', via: 'self' }, { commandId: uuid(), newContact: { displayName: 'Sam Sphere' }, db: app });
  if (!r.outcome.ok) throw new Error(`self create rejected: ${r.outcome.code}`);
  return contactId;
}

export function cmd(app: Database, actor: Actor, contactId: ContactId, c: OwnershipCommand, commandId = uuid()): Promise<OwnershipCommandResult> {
  return applyOwnershipCommand(actor, contactId, c, { commandId, db: app });
}

export async function suRows<T extends pg.QueryResultRow>(su: pg.Pool, text: string, values: unknown[] = []): Promise<T[]> {
  return (await su.query<T>(text, values)).rows;
}

export async function contactRow(su: pg.Pool, id: string): Promise<Record<string, unknown>> {
  const [r] = await suRows<Record<string, unknown>>(su, 'SELECT * FROM contacts WHERE id = $1', [id]);
  return r!;
}

export async function ledgerTypes(su: pg.Pool, id: string): Promise<string[]> {
  return (await suRows<{ type: string }>(su, 'SELECT type FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq', [id])).map((r) => r.type);
}

export interface JobRow {
  id: string;
  tenant_id: string | null;
  queue: string;
  kind: string;
  dedupe_key: string | null;
  status: string;
  attempts: number;
  max_attempts: number;
  payload: Record<string, unknown>;
  run_at: Date;
  last_error: string | null;
  locked_by: string | null;
}

export async function jobsFor(su: pg.Pool, tenantId: string, kind?: string): Promise<JobRow[]> {
  return suRows<JobRow>(su, `SELECT * FROM jobs WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY id`, [tenantId, kind ?? null]);
}

/** Makes every pending job of the tenant due now. */
export async function makeJobsDue(su: pg.Pool, tenantId: string): Promise<void> {
  await su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND status = 'pending'`, [tenantId]);
}

/** Fixture-only: SQL as the superuser with triggers (guards, append-only, FK triggers) disabled. */
export async function suFixture(su: pg.Pool, text: string, values: unknown[] = []): Promise<void> {
  const c = await su.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL session_replication_role = replica');
    await c.query(text, values);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

/**
 * Stand-in for api/leads' `timerHandlers` (module 11, not built yet): applies the timer command with
 * the job's fence through db/client, exactly as the timer catalog specifies. The command id is derived
 * from the fence, so a duplicate delivery replays the stored outcome.
 */
export function testTimerHandlers(): TxJobHandler<TimerPayload>[] {
  const kinds = [...new Set(Object.values(TIMER_KIND_OF))];
  return kinds.map((kind) => ({
    kind,
    queue: 'realtime',
    via: 'timer',
    schema: TimerPayload,
    async run(ctx, p) {
      const fence = 'offerId' in p ? { offerId: p.offerId } : { periodSeq: p.periodSeq, dueAt: p.dueAt as never };
      const commandId = derivedCommandId('test.timer', p.contactId, p.deadline, 'offerId' in p ? p.offerId : `${p.periodSeq}:${p.dueAt}`);
      await applyOwnershipCommandInTx(ctx.tx, ctx.actor, p.contactId as ContactId, { kind: 'timer', deadline: p.deadline, fence } as OwnershipCommand, { commandId });
    },
  }));
}

export function registryWith(...hs: JobHandler<unknown>[]): HandlerRegistry {
  return new HandlerRegistry().registerAll(hs);
}
