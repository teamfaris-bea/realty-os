// Test helpers for the api/accountability integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server, the real ownership engine or this
// module's public functions as app_user (RLS-bound). The superuser pool only reads state back, moves
// clocks (a deadline that passed, an appointment that ended hours ago), and inserts rows that have no
// application path in this module (assistant promise tasks with their claim evidence, imported rows).
import { randomBytes, randomUUID } from 'node:crypto';
import type { ContactId, Instant, UserId } from '@realty/core/foundation';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { applyOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { call } from '../admin/testing.js';
import { type CommsWorld, commsWorld, sendText } from '../comms/testing.js';
import { command, contactState, intake, ledger, leadsWorker, setPeriodDeadlines, suFixture, zoneWithLocalHour } from '../leads/testing.js';
import { createWorker } from '../worker/loop.js';
import { periodicDedupeKey } from '../worker/maintenance.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry, enqueueTyped } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import { exceptionRecompute } from './handlers.js';
import { type RecomputeResult, type RecomputeScope, recomputeExceptions } from './exceptions.js';

export { call, command, contactState, intake, ledger, leadsWorker, sendText, setPeriodDeadlines, suFixture };

export type AccWorld = CommsWorld & { outsider: TestClient };

/** A tenant with 2 agents + a Team Lead leading them, an agent outside the team, and a working send path. */
export async function accWorld(h: ApiHarness): Promise<AccWorld> {
  const w = await commsWorld(h, { agents: 2, teamLead: true });
  const outsider = await h.invite(w.owner, 'agent');
  return { ...w, outsider };
}

const ids = uuidv7Generator({ now: () => instant(Date.now()) }, (n) => new Uint8Array(randomBytes(n)));

/** Runs recomputeExceptions as the system actor of the tenant (what the job does). */
export async function recompute(h: ApiHarness, tenantId: string, scope: RecomputeScope = 'tenant'): Promise<RecomputeResult> {
  return withTenantTx(systemActor(tenantId, 'worker'), (tx, now) => recomputeExceptions(tx, scope, now, ids), { db: h.database });
}

/** A worker that runs only the exceptionRecompute handler. */
export function accWorker(h: ApiHarness) {
  const registry = new HandlerRegistry().registerAll([exceptionRecompute as never]);
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['default'], concurrency: 2, worker: `acc-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/** Enqueues the periodic tenant scan exactly as the maintenance pass does (dedupe `periodic:exception.recompute`). */
export async function enqueueTenantScan(h: ApiHarness, tenantId: string, runAtMs?: number): Promise<boolean> {
  return withTenantTx(
    systemActor(tenantId, 'worker'),
    (tx) => enqueueTyped(tx, exceptionRecompute, { scope: 'tenant' }, { dedupeKey: periodicDedupeKey(exceptionRecompute.kind), ...(runAtMs === undefined ? {} : { runAt: runAtMs as Instant }) }),
    { db: h.database },
  );
}

/** An intake lead offered to someone and accepted by them: owned, with a first-touch SLA period. */
export async function acceptedLead(h: ApiHarness, w: AccWorld, body: Record<string, unknown> = {}): Promise<{ contactId: string; owner: TestClient; periodSeq: number }> {
  const res = await intake(h, w, body);
  const c = await contactState(h, res.contactId);
  const owner = [...w.agents, ...(w.teamLead ? [w.teamLead] : [])].find((a) => a.userId === c.offered_to_user_id);
  if (!owner || !c.offer_id) throw new Error(`lead not offered: ${c.ownership_state}`);
  const r = await command(owner, res.contactId, 'accept', { offerId: c.offer_id });
  if (r.status !== 200) throw new Error(`accept: ${r.status} ${JSON.stringify(r.body)}`);
  const after = await contactState(h, res.contactId);
  return { contactId: res.contactId, owner, periodSeq: Number(after.ownership_period_seq) };
}

/** The real R-OWN-14 touch write (what dispatch TX1 / dial does after the gate allowed a human send). */
export async function humanTouch(h: ApiHarness, agent: TestClient, contactId: string): Promise<void> {
  const now = instant(Date.now());
  const r = await applyOwnershipCommand(agent.actor(), contactId as ContactId, { kind: 'touch', via: 'sms', refId: randomUUID(), at: now }, { commandId: randomUUID(), db: h.database });
  if (!r.outcome.ok) throw new Error(`touch rejected: ${r.outcome.code}`);
}

/**
 * Pins a contact's zone to one where it is daytime now. Quiet hours are gone (core-compliance/2.0.0), so a
 * send no longer depends on it; kept so these fixtures keep a deterministic, realistic zone.
 */
export async function daytimeContact(h: ApiHarness, contactId: string): Promise<void> {
  const zone = zoneWithLocalHour(11, 15);
  await h.su.query(`UPDATE contacts SET timezone = $2, timezone_source = 'explicit' WHERE id = $1`, [contactId, zone]);
  await h.su.query(`UPDATE contact_points SET timezone = $2 WHERE contact_id = $1`, [contactId, zone]);
}

/** An assistant call-summary action with one commitment claim (+ verbatim evidence) and its promise task. */
export async function promiseTask(h: ApiHarness, tenantId: string, contactId: string | null, assigneeUserId: string, o: { dueInMs: number; createdByKind?: 'assistant' | 'import'; snippet?: string }): Promise<{ taskId: string; claimId: string; messageId: string }> {
  const actionId = randomUUID();
  const claimId = randomUUID();
  const taskId = randomUUID();
  const msgId = randomUUID();
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
       VALUES ($1,$2,$3,'call_summary','internal','internal','proposed',$4,'What was said on the call, with where it was said.','{}')`,
      [tenantId, actionId, contactId, assigneeUserId],
    );
    await c.query(`INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review) VALUES ($1,$2,$3,0,'commitment','You said you would send the comps.',false)`, [tenantId, claimId, actionId]);
    await c.query(
      `INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
       VALUES ($1, gen_random_uuid(), $2, 'message', $3, '{"kind":"message"}', $4, true)`,
      [tenantId, claimId, msgId, o.snippet ?? 'I will send you the comps by Friday'],
    );
    await c.query(
      `INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, created_by_kind, source_action_id, source_claim_id, needs_review)
       VALUES ($1,$2,$3,$4,'promise','Send the comps', clock_timestamp() + ($5::int * interval '1 millisecond'), $6, $7, $8, false)`,
      [tenantId, taskId, assigneeUserId, contactId, o.dueInMs, o.createdByKind ?? 'assistant', actionId, claimId],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  return { taskId, claimId, messageId: msgId };
}

/** An appointment created through the API, then (clock fixture) moved to have ended `endedMsAgo` ago. */
export async function endedAppointment(h: ApiHarness, agent: TestClient, contactId: string | null, endedMsAgo: number): Promise<string> {
  const start = new Date(Date.now() + 3_600_000);
  const r = await call<{ appointment: { id: string } }>(agent, 'POST', '/appointments', {
    kind: 'buyer_consult',
    startsAt: start.toISOString(),
    endsAt: new Date(start.getTime() + 3_600_000).toISOString(),
    ...(contactId ? { contactId } : {}),
  });
  if (r.status !== 201) throw new Error(`appointment: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.appointment.id;
  await h.su.query(
    `UPDATE appointments SET starts_at = clock_timestamp() - (($2::bigint + 3600000) * interval '1 millisecond'), ends_at = clock_timestamp() - ($2::bigint * interval '1 millisecond') WHERE id = $1`,
    [id, endedMsAgo],
  );
  return id;
}

export interface ItemT {
  id: string;
  dedupeKey: string;
  itemType: string;
  contact: { id: string; name: string } | null;
  owner: { userId: string; name: string | null } | null;
  detectedAt: string;
  ageSeconds: number;
  conditionClearedAt: string | null;
  live: boolean;
  evidence: { sourceType: string; sourceId: string; explanation: string; snippet: string | null; needsReview: boolean; locator: Record<string, unknown> | null; link: { kind: string; id: string; contactId: string | null; offsetMs: number | null } | null }[];
  contactOwnershipSeq: number | null;
  latestEvent: { action: string; note: string | null; actor: { userId: string } } | null;
  actions: { resolve: boolean; reassign: boolean; verify: boolean; reopen: boolean };
}

export async function queue(c: TestClient, qs = ''): Promise<{ items: ItemT[]; counts: { live: number; byType: Record<string, number> } }> {
  const r = await call<{ items: ItemT[]; counts: { live: number; byType: Record<string, number> } }>(c, 'GET', `/team/exceptions${qs}`);
  if (r.status !== 200) throw new Error(`queue: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

export const keyPath = (key: string) => `/team/exceptions/${encodeURIComponent(key)}`;

export async function act(c: TestClient, key: string, verb: string, body: Record<string, unknown> = {}) {
  return call<{ item: ItemT; events: { action: string; note: string | null; actor: { userId: string } }[] }>(c, 'POST', `${keyPath(key)}/${verb}`, body);
}

export async function itemRow(h: ApiHarness, key: string): Promise<{ id: string; owner_user_id: string | null; detected_at: Date; condition_cleared_at: Date | null; evidence: unknown[]; computed_at: Date } | null> {
  return (await h.su.query('SELECT id, owner_user_id, detected_at, condition_cleared_at, evidence, computed_at FROM exception_items WHERE dedupe_key = $1', [key])).rows[0] ?? null;
}

export async function eventRows(h: ApiHarness, key: string): Promise<{ action: string; actor_user_id: string; actor_role: string; ownership_command_id: string | null; note: string | null }[]> {
  return (await h.su.query('SELECT action, actor_user_id, actor_role, ownership_command_id, note FROM exception_events WHERE exception_dedupe_key = $1 ORDER BY occurred_at, id', [key])).rows;
}

/** Runs a raw statement as a user through RLS (app_user), returning the Postgres error code/message if it fails. */
export async function asUser(h: ApiHarness, c: TestClient, text: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  try {
    await withTenantTx(c.actor(), async (tx) => {
      await sql.raw(text).execute(tx);
    }, { db: h.database });
    return { ok: true };
  } catch (e) {
    const pe = e as { code?: string; message?: string };
    return { ok: false, code: pe.code ?? '', message: pe.message ?? '' };
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const asUserId = (s: string) => s as UserId;
