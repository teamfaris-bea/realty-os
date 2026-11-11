// Tenant transactions (ARCHITECTURE §3 step 7; R-TEN-2, R-TEN-3, R-TEN-6, R-TEN-10, R-OWN-6, E57, E63).
//
//   withTenantTx(actor, async (tx, now) => { ... })
//
// - BEGIN (READ COMMITTED); the request GUCs are set with set_config(..., true), i.e. SET LOCAL
//   semantics: they die with the transaction, so a pooled connection reused afterwards reads '' and
//   every policy sees NULL (zero rows, fail closed).
// - Tenant, user and actor kind come ONLY from the Actor value (built from the resolved session, a
//   webhook resolver or a job row). Role is never put in a GUC: app.my_role() looks it up.
// - `now` is the DB clock_timestamp() read in this transaction: the single clock passed into core.
//   Ownership commands read it again after their locks (R-OWN-6).
// - The Kysely handle is only reachable inside `fn`. One call = one transaction = one tenant (R-TEN-6).
import type { Actor, Instant, UserId } from '@realty/core/foundation';
import { instantFromDate, parseId } from '@realty/core/foundation';
import { type Kysely, sql } from 'kysely';
import { type Database, getDatabase } from './client.js';
import type { DB } from './schema.js';

export type Tx = Kysely<DB>;

export interface TenantTxOptions {
  /** sets app.ownership_command for the whole transaction (ownership command path) */
  ownershipCommand?: string;
  /** retry the whole transaction on serialization_failure (40001) / deadlock_detected (40P01); default 0 */
  retries?: number;
  /** database handle (defaults to the configured process-wide database) */
  db?: Database;
}

interface Gucs {
  tenantId: string;
  userId: string;
  actorKind: string;
  ownershipCommand: string;
}

export class ActorContextError extends TypeError {
  override readonly name = 'ActorContextError';
}

function requireUuid(v: unknown, what: string): string {
  const id = typeof v === 'string' ? parseId(v) : null;
  if (id === null) throw new ActorContextError(`${what} must be a uuid`);
  return id;
}

/** The GUC values for an actor. Throws on anything malformed (never guesses a tenant). */
export function actorGucs(actor: Actor, ownershipCommand?: string): Gucs {
  const tenantId = requireUuid(actor.tenantId, 'actor.tenantId');
  const cmd = ownershipCommand === undefined ? '' : requireUuid(ownershipCommand, 'ownershipCommand');
  switch (actor.kind) {
    case 'user':
      return { tenantId, userId: requireUuid(actor.userId, 'actor.userId'), actorKind: 'user', ownershipCommand: cmd };
    case 'support':
      return { tenantId, userId: requireUuid(actor.userId, 'actor.userId'), actorKind: 'support', ownershipCommand: cmd };
    case 'system':
      return { tenantId, userId: '', actorKind: 'system', ownershipCommand: cmd };
    default:
      throw new ActorContextError('unknown actor kind');
  }
}

/** Sets the request GUCs for the current transaction and returns the DB clock. */
export async function applyGucs(tx: Tx, g: Gucs): Promise<Instant> {
  const r = await sql<{ now: Date }>`
    SELECT set_config('app.tenant_id', ${g.tenantId}, true) AS t,
           set_config('app.user_id', ${g.userId}, true) AS u,
           set_config('app.actor_kind', ${g.actorKind}, true) AS k,
           set_config('app.principal_type', 'staff', true) AS p,
           set_config('app.ownership_command', ${g.ownershipCommand}, true) AS c,
           clock_timestamp() AS now`.execute(tx);
  return instantFromDate(r.rows[0]!.now);
}

/** Sets (or clears, with null) app.ownership_command for the rest of the current transaction. */
export async function setOwnershipCommand(tx: Tx, commandId: string | null): Promise<void> {
  const v = commandId === null ? '' : requireUuid(commandId, 'commandId');
  await sql`SELECT set_config('app.ownership_command', ${v}, true)`.execute(tx);
}

/** The DB clock (clock_timestamp(), not the transaction start). */
export async function dbNow(tx: Tx): Promise<Instant> {
  const r = await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx);
  return instantFromDate(r.rows[0]!.now);
}

const RETRYABLE = new Set(['40001', '40P01']);

export function isRetryable(err: unknown): boolean {
  return RETRYABLE.has((err as { code?: string } | null)?.code ?? '');
}

async function runTx<T>(db: Database, g: Gucs, fn: (tx: Tx, now: Instant) => Promise<T>, retries: number): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.kysely
        .transaction()
        .setIsolationLevel('read committed')
        .execute(async (tx) => {
          const now = await applyGucs(tx, g);
          return fn(tx, now);
        });
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      // small jittered pause so racing transactions do not collide again in lock-step
      await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 20) * (attempt + 1)));
    }
  }
}

/** One transaction in the actor's tenant with RLS context set (ARCHITECTURE §3 step 7). */
export function withTenantTx<T>(actor: Actor, fn: (tx: Tx, now: Instant) => Promise<T>, opts: TenantTxOptions = {}): Promise<T> {
  const g = actorGucs(actor, opts.ownershipCommand);
  return runTx(opts.db ?? getDatabase(), g, fn, opts.retries ?? 0);
}

/**
 * A transaction WITHOUT tenant context, for the pre-tenant definer entry points only (auth.* login,
 * session resolution, invite acceptance, inbound resolvers). Every tenant table reads as empty here.
 * `userId` sets app.user_id (signup / provisioning: app.provision_tenant checks it).
 */
export function withPreTenant<T>(fn: (tx: Tx, now: Instant) => Promise<T>, opts: { userId?: UserId; db?: Database } = {}): Promise<T> {
  const userId = opts.userId === undefined ? '' : requireUuid(opts.userId, 'userId');
  const g: Gucs = { tenantId: '', userId, actorKind: userId ? 'user' : '', ownershipCommand: '' };
  return runTx(opts.db ?? getDatabase(), g, fn, 0);
}

/**
 * Session resolution in ONE transaction (one pooled connection instead of two; lane perf-misses):
 * `pre` runs exactly as in withPreTenant (no tenant context: every tenant table reads as empty). When
 * `actorOf` names an actor for its result, ALL request GUCs are then replaced with that actor's
 * (the same applyGucs call withTenantTx makes: tenant, user, actor kind, principal, and an empty
 * ownership command), and `fn` runs in the same transaction with a fresh DB clock. Nothing of the
 * pre-tenant context survives into `fn`. `pre` must only read (it shares fn's transaction).
 */
export function withPreTenantThenTenant<P, T>(
  pre: (tx: Tx, now: Instant) => Promise<P>,
  actorOf: (p: P) => Actor | null,
  fn: (tx: Tx, now: Instant, p: P) => Promise<T>,
  opts: { db?: Database } = {},
): Promise<{ pre: P; result: T | null }> {
  const preGucs: Gucs = { tenantId: '', userId: '', actorKind: '', ownershipCommand: '' };
  return runTx(
    opts.db ?? getDatabase(),
    preGucs,
    async (tx, now) => {
      const p = await pre(tx, now);
      const actor = actorOf(p);
      if (!actor) return { pre: p, result: null };
      const tenantNow = await applyGucs(tx, actorGucs(actor));
      return { pre: p, result: await fn(tx, tenantNow, p) };
    },
    0,
  );
}

/** Cross-tenant definer calls of the worker (claim/finish/reap/due_work): no tenant, no user. */
export function withNoContext<T>(db: Database, fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  return runTx(db, { tenantId: '', userId: '', actorKind: '', ownershipCommand: '' }, fn, 0);
}
