// Test helpers for the api/leads integration tests (imported by *.test.ts only).
//
// Everything the application does goes through the real server (or the module's public functions)
// as app_user. The superuser pool only: reads state back, moves STORED deadlines into the past (a
// clock fixture: Postgres' clock cannot be faked, and the deadline columns, their ledger instants
// and the timer job's fence are shifted together so fold(ledger) still equals the projection), and
// inserts rows that have no application path yet (assistant drafts/handbacks, enrollments, deals).
import { randomUUID } from 'node:crypto';
import type { ContactId, Role } from '@realty/core/foundation';
import { applyOwnershipCommandInTx, derivedCommandId, setOwnershipCommand, withTenantTx } from '@realty/db';
import type { LightMyRequestResponse } from 'fastify';
import { type ApiHarness, TEST_ORIGIN, type TestClient } from '../auth/testHarness.js';
import { call, freshReauth, registerPush, res } from '../admin/testing.js';
import { signedHeader } from '../providers/webhooks.js';
import { ownershipFollowupHandler } from '../worker/handlers/followup.js';
import { type Worker, createWorker } from '../worker/loop.js';
import { silentLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { systemActor } from '../worker/systemActor.js';
import type { JobHandler } from '../worker/types.js';
import { leadsHandlers } from './handlers.js';
import { identifiersOf } from './intake.js';
import { addPoint } from './repos/contacts.js';

export { call, freshReauth, registerPush, res };

/** An `Etc/GMT±N` zone whose local hour right now is in [from, to) (no DST: stable for a test run). */
export function zoneWithLocalHour(from: number, to: number, nowMs = Date.now()): string {
  const utcHour = new Date(nowMs).getUTCHours() + new Date(nowMs).getUTCMinutes() / 60;
  for (const offset of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7, -7, 8, -8, 9, -9, 10, -10, 11, -11, 12, 13, 14]) {
    const local = (((utcHour + offset) % 24) + 24) % 24;
    if (local >= from && local < to) return offset === 0 ? 'Etc/UTC' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`;
  }
  throw new Error('no zone found');
}

export interface LeadsWorld {
  owner: TestClient;
  tenantId: string;
  agents: TestClient[];
  teamLead: TestClient | null;
  teamId: string | null;
  ruleId: string | null;
  defaultPondId: string;
  sourceId: string;
  token: string;
}

export interface WorldOptions {
  agents?: number;
  /** a round-robin rule over the agents (default true) */
  rule?: boolean;
  /** register a push device for every agent (default true) */
  push?: boolean;
  /** a Team Lead leading a team that holds the agents */
  teamLead?: boolean;
  timezone?: string;
  /** extra roles to invite (returned in `others`) */
  others?: Role[];
}

/** A tenant set up through the API: agents with devices, an optional team + TL, a round-robin rule, a lead source. */
export async function leadsWorld(h: ApiHarness, o: WorldOptions = {}): Promise<LeadsWorld & { others: TestClient[] }> {
  const owner = await h.signup({ timezone: o.timezone ?? zoneWithLocalHour(10, 16) });
  const tenantId = owner.tenantId!;
  const agents: TestClient[] = [];
  for (let i = 0; i < (o.agents ?? 2); i++) {
    const a = await h.invite(owner, 'agent');
    if (o.push !== false) await registerPush(a);
    agents.push(a);
  }
  const others: TestClient[] = [];
  for (const role of o.others ?? []) others.push(await h.invite(owner, role));
  await freshReauth(h, owner);
  let teamLead: TestClient | null = null;
  let teamId: string | null = null;
  if (o.teamLead) {
    teamLead = await h.invite(owner, 'team_lead');
    if (o.push !== false) await registerPush(teamLead);
    const team = await call<{ team: { id: string } }>(owner, 'POST', '/teams', { name: 'Team A' });
    teamId = team.body.team.id;
    const members = [...agents.map((a) => ({ userId: a.userId, isLead: false })), { userId: teamLead.userId, isLead: true }];
    const put = await call(owner, 'PUT', `/teams/${teamId}/members`, { members });
    if (put.status !== 200) throw new Error(`team members: ${put.status} ${JSON.stringify(put.body)}`);
  }
  let ruleId: string | null = null;
  if (o.rule !== false && agents.length > 0) {
    const rule = await call<{ rule: { id: string } }>(owner, 'POST', '/routing-rules', {
      name: 'Everyone',
      strategy: 'round_robin',
      match: {},
      members: agents.map((a) => ({ userId: a.userId, weight: 1 })),
    });
    if (rule.status !== 201) throw new Error(`rule: ${rule.status} ${JSON.stringify(rule.body)}`);
    ruleId = rule.body.rule.id;
  }
  const src = await call<{ source: { id: string }; ingestToken: string }>(owner, 'POST', '/lead-sources', { name: 'Portal', kind: 'portal' });
  if (src.status !== 201) throw new Error(`lead source: ${src.status} ${JSON.stringify(src.body)}`);
  const pond = (await h.su.query<{ id: string }>('SELECT id FROM ponds WHERE tenant_id = $1 AND is_default', [tenantId])).rows[0]!;
  return { owner, tenantId, agents, teamLead, teamId, ruleId, defaultPondId: pond.id, sourceId: src.body.source.id, token: src.body.ingestToken, others };
}

/** POST /api/intake/:token signed like a lead source would (X-Realty-Signature over the raw body). */
export async function postIntake(h: ApiHarness, token: string, body: Record<string, unknown>, o: { sign?: boolean } = {}): Promise<LightMyRequestResponse> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'portal-test' };
  if (o.sign !== false) headers['x-realty-signature'] = signedHeader(h.config.webhookSecrets.lead, Math.floor(Date.now() / 1000), raw);
  return h.app.inject({ method: 'POST', url: `/api/intake/${token}`, headers, payload: raw });
}

export async function intake(h: ApiHarness, w: LeadsWorld, body: Record<string, unknown> = {}): Promise<{ contactId: string; inquiryId: string | null; outcome: string; status: number }> {
  const r = await postIntake(h, w.token, { inquiryType: 'buy', fullName: 'Pat Lead', phones: [randomPhone()], ...body });
  if (r.statusCode !== 201 && r.statusCode !== 200) throw new Error(`intake: ${r.statusCode} ${r.body}`);
  return { ...(JSON.parse(r.body) as { contactId: string; inquiryId: string | null; outcome: string }), status: r.statusCode };
}

let phoneSeq = 0;
/** A valid, unique US mobile number (NANP 555 exchange numbers are invalid, so a real-looking range). */
export function randomPhone(): string {
  phoneSeq += 1;
  const n = (Date.now() % 1_000_0000) + phoneSeq * 7919;
  return `+1415${String(2000000 + (n % 7_999_999)).padStart(7, '0')}`;
}

export interface ContactState {
  ownership_state: string;
  owner_user_id: string | null;
  offered_to_user_id: string | null;
  offer_id: string | null;
  pond_id: string | null;
  ownership_seq: string;
  ownership_period_seq: string | null;
  offer_expires_at: Date | null;
  first_touch_due_at: Date | null;
  release_due_at: Date | null;
  route_due_at: Date | null;
  owned_at: Date | null;
  closed_reason: string | null;
  deleted_at: Date | null;
  inactivity_warn_at: Date | null;
  inactivity_release_at: Date | null;
}

export async function contactState(h: ApiHarness, id: string): Promise<ContactState> {
  const r = await h.su.query<ContactState>('SELECT * FROM contacts WHERE id = $1', [id]);
  if (!r.rows[0]) throw new Error(`no contact ${id}`);
  return r.rows[0];
}

export async function ledger(h: ApiHarness, id: string): Promise<{ seq: string; type: string; reason_code: string; actor_kind: string; actor_user_id: string | null; owner_user_id: string | null; payload: Record<string, unknown> }[]> {
  return (await h.su.query('SELECT seq, type, reason_code, actor_kind, actor_user_id, owner_user_id, payload FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq', [id])).rows;
}

export async function rejections(h: ApiHarness, id: string): Promise<{ code: string; command_kind: string; actor_user_id: string | null; observed_seq: string | null }[]> {
  return (await h.su.query('SELECT code, command_kind, actor_user_id, observed_seq FROM ownership_command_rejections WHERE contact_id = $1 ORDER BY occurred_at', [id])).rows;
}

/** Runs the superuser statements with triggers disabled (fixture writes the append-only ledger allows no app path for). */
export async function suFixture(h: ApiHarness, statements: { text: string; values?: unknown[] }[]): Promise<void> {
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

/**
 * Clock fixture: the current offer expires `msFromNow` from the DB clock (negative = already expired).
 * The contact column, the `offered` ledger event's deadline and the timer job move together.
 */
export async function setOfferExpiry(h: ApiHarness, contactId: string, msFromNow: number): Promise<Date> {
  const at = (await h.su.query<{ t: Date }>(`SELECT clock_timestamp() + ($1::int * interval '1 millisecond') AS t`, [msFromNow])).rows[0]!.t;
  await suFixture(h, [
    { text: 'UPDATE contacts SET offer_expires_at = $2 WHERE id = $1', values: [contactId, at] },
    { text: "UPDATE lead_ownership_events e SET deadline_at = $2 FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.type = 'offered' AND e.offer_id = c.offer_id", values: [contactId, at] },
    { text: "UPDATE jobs SET run_at = LEAST(run_at, $2) WHERE kind = 'ownership.offer_expiry' AND payload->>'contactId' = $1::text AND status = 'pending'", values: [contactId, at] },
  ]);
  return at;
}

/**
 * Clock fixture: the current ownership period's first-touch due (and auto-release) instants move to
 * `dueMsFromNow` / `releaseMsFromNow` from the DB clock, with the period event and the timer fences.
 */
export async function setPeriodDeadlines(h: ApiHarness, contactId: string, dueMsFromNow: number, releaseMsFromNow: number | null): Promise<{ due: Date; release: Date | null }> {
  const t = (await h.su.query<{ due: Date; rel: Date | null }>(
    `SELECT clock_timestamp() + ($1::int * interval '1 millisecond') AS due,
            CASE WHEN $2::int IS NULL THEN NULL ELSE clock_timestamp() + ($2::int * interval '1 millisecond') END AS rel`,
    [dueMsFromNow, releaseMsFromNow],
  )).rows[0]!;
  const dueMs = t.due.getTime();
  const relMs = t.rel ? t.rel.getTime() : null;
  await suFixture(h, [
    { text: 'UPDATE contacts SET first_touch_due_at = $2, release_due_at = $3 WHERE id = $1', values: [contactId, t.due, t.rel] },
    {
      text: `UPDATE lead_ownership_events e SET deadline_at = $2, payload = jsonb_set(e.payload, '{releaseDueAt}', to_jsonb($3::bigint))
               FROM contacts c WHERE c.id = $1 AND e.contact_id = c.id AND e.seq = c.ownership_period_seq`,
      values: [contactId, t.due, relMs],
    },
    {
      text: `UPDATE jobs SET run_at = to_timestamp($2::bigint / 1000.0), payload = jsonb_set(payload, '{dueAt}', to_jsonb($2::bigint))
              WHERE kind = 'ownership.first_touch_breach' AND payload->>'contactId' = $1::text AND status = 'pending'`,
      values: [contactId, dueMs],
    },
    ...(relMs === null
      ? []
      : [{
          text: `UPDATE jobs SET run_at = to_timestamp($2::bigint / 1000.0), payload = jsonb_set(payload, '{dueAt}', to_jsonb($2::bigint))
                  WHERE kind = 'ownership.auto_release' AND payload->>'contactId' = $1::text AND status = 'pending'`,
          values: [contactId, relMs],
        }]),
  ]);
  return { due: t.due, release: t.rel };
}

/** A worker over api/leads' handlers + the ownership follow-up, on the harness database. */
export function leadsWorker(h: ApiHarness, extra: JobHandler<unknown>[] = []): Worker {
  const registry = new HandlerRegistry().registerAll([...leadsHandlers, ownershipFollowupHandler() as unknown as JobHandler<unknown>, ...extra]);
  return createWorker({ db: h.database, registry, providers: h.providers, queues: ['realtime', 'default'], concurrency: 4, worker: `leads-test-${randomUUID().slice(0, 8)}`, idleMs: 10, log: silentLogger });
}

/** Due jobs of a tenant (kind filter optional). */
export async function jobs(h: ApiHarness, tenantId: string, kind?: string): Promise<{ id: string; kind: string; status: string; run_at: Date; payload: Record<string, unknown>; dedupe_key: string | null }[]> {
  return (
    await h.su.query(
      `SELECT id::text, kind, status, run_at, payload, dedupe_key FROM jobs WHERE tenant_id = $1 AND ($2::text IS NULL OR kind = $2) ORDER BY id`,
      [tenantId, kind ?? null],
    )
  ).rows;
}

/** Ownership command through the API. */
export async function command<T = Record<string, unknown>>(c: TestClient, contactId: string, verb: string, body: Record<string, unknown> = {}) {
  return call<T>(c, 'POST', `/leads/${contactId}/${verb}`, { commandId: randomUUID(), ...body });
}

/**
 * A person exactly as an import's contacts stage leaves them (R-IMPORT-8): created by the engine's own `import_assign`
 * → 'unassigned' as the import actor (one `imported` ledger event: unassigned, never routed, route_due_at NULL), with
 * their phones and emails keyed the way intake keys them. It is the command and the actor the import commit runs
 * (imports/commit.ts applyContact), without the file or FUB parsing around it. A FUB person with no owner, a CSV row,
 * and a person whose mapped member could not hold leads (owner decision B4) stay so until someone assigns them.
 */
export async function importedUnassigned(h: ApiHarness, tenantId: string, o: { firstName: string; lastName: string; phones?: string[]; emails?: string[] }): Promise<string> {
  const actor = systemActor(tenantId, 'import');
  const { ids, envelope } = h.app.platform;
  const contactId = ids.next<'ContactId'>() as ContactId;
  await withTenantTx(
    actor,
    async (tx) => {
      const r = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'import_assign', target: 'unassigned' }, {
        commandId: derivedCommandId('test.import_contact', contactId),
        ids,
        newContact: { displayName: `${o.firstName} ${o.lastName}`, firstName: o.firstName, lastName: o.lastName, originalSourceDetail: { import_system: 'csv' } },
      });
      if (!r.outcome.ok) throw new Error(`import_assign: ${r.outcome.code}`);
      await setOwnershipCommand(tx, null);
      const keyed = await identifiersOf(tx, envelope, actor.tenantId, o.phones ?? [], o.emails ?? []);
      for (const p of keyed.phones) await addPoint(tx, { id: ids.next(), contactId, kind: 'phone', address: p.e164, hmacHex: p.hmac });
      for (const e of keyed.emails) await addPoint(tx, { id: ids.next(), contactId, kind: 'email', address: e.email, hmacHex: e.hmac });
    },
    { db: h.database },
  );
  return contactId;
}

export { TEST_ORIGIN };
