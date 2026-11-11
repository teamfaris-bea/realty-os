// The tenant-scope exception recompute (lane perf-misses, "exception.recompute for the large tenant")
// must leave exactly the state the previous implementation left: same exception_items rows (every column,
// ids included), same exception_events, same RecomputeResult. The previous implementation is kept INLINE
// below (oldRecompute: one INSERT ... ON CONFLICT per derived item).
//
// Method: one generated tenant (the load generator: every exception type), then a sequence of steps with
// time passing, facts changing (conditions entering, clearing, fixed late, holding again), stored rows
// drifting (stale evidence, missing rows, a stored clear) and human actions (resolve / reopen / verify
// through actOnException as the acting user). At every step both implementations run from the SAME
// state inside one transaction: the old one under a savepoint, its result snapshotted and rolled back,
// then the new one; both get the same `now` and identical id generators. Equal snapshots at every step
// (from equal starting states) prove equal end states over the whole sequence.
import type { Brand, IdGenerator, Instant, Role, TenantId, UserId } from '@realty/core/foundation';
import { DAY_MS, HOUR_MS, MINUTE_MS } from '@realty/core/foundation';
import { DEFAULT_EXCEPTION_SETTINGS, type ExceptionItemSpec, apptKey, deriveExceptions, milestoneKey, promiseKey, sendKey, untouchedKey } from '@realty/core/priority';
import { type Database, type Tx, createDatabase, withTenantTx } from '@realty/db';
import { type TestDb, createTestDb } from '@realty/db/testing';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateLoad, defaultSpec, loadUuid } from '../load/generate.js';
import { kekFromEnv } from '../load/seed.js';
import { systemActor } from '../worker/systemActor.js';
import { RECOMPUTE_WINDOW_MS, type RecomputeResult, actOnException, recomputeExceptions } from './exceptions.js';
import * as repo from './repos/exceptions.js';
import { iso } from './common.js';

const PH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA';
const T = loadUuid('load-big', 'tenant') as TenantId;

// ---- the previous implementation, verbatim apart from names ------------------------------------------

const KEY_RE = /^(?:untouched:([0-9a-f-]{36}):(\d+)|promise:([0-9a-f-]{36})|send:([0-9a-f-]{36})|appt:([0-9a-f-]{36})|milestone:([0-9a-f-]{36}):\d+)$/;

function oldExtraOf(rows: readonly repo.StoredItemRow[]): repo.InputScope['extra'] {
  const extra: repo.InputScope['extra'] = { periods: [], taskIds: [], messageIds: [], appointmentIds: [], dealDateIds: [] };
  for (const r of rows) {
    const m = KEY_RE.exec(r.dedupe_key);
    if (!m) continue;
    if (m[1] && m[2]) extra.periods.push({ contactId: m[1], seq: Number(m[2]) });
    else if (m[3]) extra.taskIds.push(m[3]);
    else if (m[4]) extra.messageIds.push(m[4]);
    else if (m[5]) extra.appointmentIds.push(m[5]);
    else if (m[6]) extra.dealDateIds.push(m[6]);
  }
  return extra;
}

async function oldUpsertItems(tx: Tx, specs: readonly ExceptionItemSpec[], ids: IdGenerator, now: Instant): Promise<void> {
  const nowIso = iso(now);
  for (const x of specs) {
    await sql`
      INSERT INTO exception_items (tenant_id, id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, due_at,
                                   evidence, condition_cleared_at, rule_version, dedupe_key, computed_at)
      VALUES (app.tenant_id(), ${ids.next()}::uuid, ${x.itemType}, ${x.subjectType}, ${x.subjectId}::uuid, ${x.contactId}::uuid, ${x.ownerUserId}::uuid,
              ${iso(x.detectedAt)}::timestamptz, ${x.dueAt === null ? null : iso(x.dueAt)}::timestamptz, ${JSON.stringify(x.evidence)}::jsonb,
              ${x.conditionClearedAt === null ? null : iso(x.conditionClearedAt)}::timestamptz, ${x.ruleVersion}, ${x.dedupeKey}, ${nowIso}::timestamptz)
      ON CONFLICT (tenant_id, dedupe_key) DO UPDATE SET
        item_type = EXCLUDED.item_type, subject_type = EXCLUDED.subject_type, subject_id = EXCLUDED.subject_id,
        contact_id = EXCLUDED.contact_id, owner_user_id = EXCLUDED.owner_user_id, detected_at = EXCLUDED.detected_at,
        due_at = EXCLUDED.due_at, evidence = EXCLUDED.evidence,
        condition_cleared_at = CASE WHEN EXCLUDED.condition_cleared_at IS NULL THEN NULL
                                    ELSE COALESCE(exception_items.condition_cleared_at, EXCLUDED.condition_cleared_at) END,
        rule_version = EXCLUDED.rule_version, computed_at = EXCLUDED.computed_at`.execute(tx);
  }
}

async function oldClearItems(tx: Tx, keys: readonly string[], now: Instant): Promise<number> {
  if (keys.length === 0) return 0;
  const r = await sql`
    UPDATE exception_items SET condition_cleared_at = ${iso(now)}::timestamptz, computed_at = ${iso(now)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND dedupe_key = ANY (${[...keys]}::text[]) AND condition_cleared_at IS NULL`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

async function oldStoredRows(tx: Tx): Promise<repo.StoredItemRow[]> {
  return (await sql<repo.StoredItemRow>`SELECT e.id, e.item_type, e.subject_type, e.subject_id, e.contact_id, e.owner_user_id, e.detected_at, e.due_at,
      e.evidence, e.condition_cleared_at, e.rule_version, e.dedupe_key, e.computed_at FROM exception_items e
     WHERE e.tenant_id = app.tenant_id() AND e.condition_cleared_at IS NULL`.execute(tx)).rows;
}

async function oldStoredRowsByKeys(tx: Tx, keys: readonly string[]): Promise<repo.StoredItemRow[]> {
  if (keys.length === 0) return [];
  return (await sql<repo.StoredItemRow>`SELECT e.id, e.item_type, e.subject_type, e.subject_id, e.contact_id, e.owner_user_id, e.detected_at, e.due_at,
      e.evidence, e.condition_cleared_at, e.rule_version, e.dedupe_key, e.computed_at FROM exception_items e
     WHERE e.tenant_id = app.tenant_id() AND e.dedupe_key = ANY (${[...keys]}::text[])`.execute(tx)).rows;
}

/** The tenant-scope recompute as it was before this lane (reads through the unchanged repo fact queries). */
async function oldRecompute(tx: Tx, now: Instant, ids: IdGenerator): Promise<RecomputeResult> {
  await repo.lockRecompute(tx);
  const stored = await oldStoredRows(tx);
  const input: repo.InputScope = { contactId: null, now, windowStart: (now - RECOMPUTE_WINDOW_MS) as Instant, extra: oldExtraOf(stored.filter((r) => r.condition_cleared_at === null)) };
  const settings = DEFAULT_EXCEPTION_SETTINGS;
  const periods = await repo.slaFacts(tx, input);
  const promises = await repo.promiseFacts(tx, input);
  const outbound = await repo.outboundFacts(tx, input);
  const appointments = await repo.appointmentFacts(tx, input, settings.missingOutcomeHours);
  const milestoneDates = await repo.milestoneFacts(tx, input);
  const keys = [
    ...periods.map((p) => untouchedKey(p.contactId, p.periodSeq)),
    ...promises.map((t) => promiseKey(t.taskId)),
    ...outbound.map((m) => sendKey(m.messageId)),
    ...appointments.map((a) => apptKey(a.appointmentId)),
    ...milestoneDates.map((d) => milestoneKey(d.dealDateId, d.dueVersion)),
  ];
  const byKey = new Map<string, repo.StoredItemRow>();
  for (const r of stored) byKey.set(r.dedupe_key, r);
  const missing = keys.filter((k) => !byKey.has(k));
  for (const r of await oldStoredRowsByKeys(tx, missing)) byKey.set(r.dedupe_key, r);
  const d = deriveExceptions({ now, ownedWithSla: periods, promiseTasks: promises, outbound, appointments, milestoneDates, settings, existing: [...byKey.values()].map(repo.specOf) });
  await oldUpsertItems(tx, d.upserts, ids, now);
  const cleared = await oldClearItems(tx, d.cleared, now);
  return { upserted: d.upserts.length, cleared, inputs: { periods: periods.length, promises: promises.length, outbound: outbound.length, appointments: appointments.length, milestones: milestoneDates.length } };
}

// ---- harness -------------------------------------------------------------------------------------------

/** A deterministic id generator (uuid-shaped counter), so both implementations mint the same ids. */
function counterIds(seed: number): IdGenerator {
  let n = 0;
  return {
    next: <B extends string>() => {
      n += 1;
      const h = (seed * 1_000_000 + n).toString(16).padStart(12, '0');
      return `00000000-0000-7000-8000-${h}` as Brand<string, B>;
    },
  } as IdGenerator;
}

/** human-action event ids (never reused) */
const actIds = counterIds(999);
let db: TestDb;
let app: Database;
let su: pg.Client;
let base: number;
let step = 0;
const users: { userId: string; role: Role }[] = [];

async function snapshot(tx: Tx): Promise<{ items: unknown[]; events: unknown[] }> {
  const items = (await sql`SELECT id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, due_at, evidence::text AS evidence,
                                  condition_cleared_at, rule_version, dedupe_key, computed_at
                             FROM exception_items WHERE tenant_id = app.tenant_id() ORDER BY dedupe_key`.execute(tx)).rows;
  const events = (await sql`SELECT * FROM exception_events WHERE tenant_id = app.tenant_id() ORDER BY id`.execute(tx)).rows;
  return { items, events };
}

/** Runs old and new from the same state at `now`; asserts equal results; commits the new one. */
async function compareAt(now: number, label: string): Promise<{ old: RecomputeResult; items: number }> {
  step += 1;
  let oldR: RecomputeResult | undefined;
  let oldSnap: { items: unknown[]; events: unknown[] } | undefined;
  let items = 0;
  await withTenantTx(systemActor(T, 'worker'), async (tx) => {
    await sql`SAVEPOINT eq_old`.execute(tx);
    oldR = await oldRecompute(tx, now as Instant, counterIds(step));
    oldSnap = await snapshot(tx);
    await sql`ROLLBACK TO SAVEPOINT eq_old`.execute(tx);
    const newR = await recomputeExceptions(tx, 'tenant', now as Instant, counterIds(step));
    const newSnap = await snapshot(tx);
    expect(newR, `${label}: result`).toEqual(oldR);
    expect(newSnap.events, `${label}: events`).toEqual(oldSnap!.events);
    expect(newSnap.items.length, `${label}: item count`).toBe(oldSnap!.items.length);
    expect(newSnap.items, `${label}: items`).toEqual(oldSnap!.items);
    items = newSnap.items.length;
  }, { db: app });
  return { old: oldR!, items };
}

async function act(key: string, verb: 'resolve' | 'reopen' | 'verify', role: Role, note?: string, who?: string): Promise<void> {
  const u = users.find((x) => x.role === role)!;
  const actor = { kind: 'user' as const, userId: (role === 'agent' && who ? who : u.userId) as UserId, tenantId: T, role, sessionId: 'equivalence-test' };
  await withTenantTx(actor, (tx) => actOnException(tx, actor, actIds, key, verb, note === undefined ? {} : { note }), { db: app });
}

/** Deal dates are entered and moved by a person (DATE_HUMAN_CONFIRMATION): fixture writes carry a user context. */
async function asPerson(text: string, values: unknown[]): Promise<pg.QueryResult> {
  const owner = users.find((u) => u.role === 'owner')!;
  await su.query('BEGIN');
  try {
    await su.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'user', true), set_config('app.user_id', $2, true)`, [T, owner.userId]);
    const r = await su.query(text, values);
    await su.query('COMMIT');
    return r;
  } catch (e) {
    await su.query('ROLLBACK');
    throw e;
  }
}

async function keys(where: string): Promise<string[]> {
  return (await su.query<{ k: string }>(`SELECT dedupe_key AS k FROM exception_items WHERE tenant_id = $1 AND ${where} ORDER BY dedupe_key`, [T])).rows.map((r) => r.k);
}

beforeAll(async () => {
  db = await createTestDb();
  const spec = defaultSpec(4_000, PH);
  spec.tenants = spec.tenants.slice(0, 1);
  await generateLoad(db.ownerUrl, kekFromEnv(), spec);
  app = createDatabase({ url: db.appUserUrl, max: 2 });
  su = new pg.Client({ connectionString: db.ownerUrl });
  await su.connect();
  users.push(...(await su.query<{ user_id: string; role: Role }>(`SELECT DISTINCT ON (role) user_id, role FROM memberships WHERE tenant_id = $1 AND role IN ('owner','admin','team_lead','agent') ORDER BY role, user_id`, [T])).rows
    .map((r) => ({ userId: r.user_id, role: r.role })));
  // milestone_at_risk material (the generator has no confirmed deal dates): dates of open deals that are
  // overdue, due within 48 h with nobody responsible, due later (enter with time), done late
  const n = (await asPerson(`
    INSERT INTO deal_dates (tenant_id, id, deal_id, kind, due_on, due_at, status, responsible, completed_at, source)
    SELECT d.tenant_id, gen_random_uuid(), d.id, (ARRAY['inspection','appraisal','financing','closing'])[1 + (d.g % 4)::int],
           (now() + o.off)::date, now() + o.off, 'confirmed', CASE WHEN d.g % 3 = 0 THEN 'lender' END,
           CASE WHEN d.g % 7 = 0 THEN now() END, 'manual'
      FROM (SELECT tenant_id, id, row_number() OVER (ORDER BY id) AS g FROM deals WHERE tenant_id = $1 AND stage NOT IN ('closed','lost') ORDER BY id LIMIT 60) d
      CROSS JOIN LATERAL (SELECT (ARRAY[interval '-3 days', interval '-2 hours', interval '20 hours', interval '4 days', interval '-40 days'])[1 + (d.g % 5)::int] AS off) o`, [T])).rowCount;
  expect(n).toBeGreaterThan(20);
  // more failed sends, so a first fill spans several upsert statements (UPSERT_CHUNK)
  await su.query(`UPDATE messages SET status = 'failed', status_reason = 'PROVIDER_REJECTED' WHERE tenant_id = $1 AND id IN (
                    SELECT id FROM messages WHERE tenant_id = $1 AND direction = 'outbound' AND NOT imported AND initiator <> 'import'
                       AND marketing_piece_id IS NULL AND status = 'delivered' AND occurred_at > now() - interval '20 days' ORDER BY id LIMIT 2500)`, [T]);
  base = Date.now();
}, 600_000);
afterAll(async () => {
  await su?.end();
  await app?.close();
  await db?.drop();
});

describe('tenant recompute equivalence (old per-row upsert vs new)', () => {
  it('leaves identical exception_items / exception_events at every step: first fill, steady state, drift, clears, human actions, time passing', async () => {
    // 1. first fill (every item inserted) and an immediate steady-state rerun
    const first = await compareAt(base, 'first fill');
    expect(first.old.upserted).toBeGreaterThan(2 * repo.UPSERT_CHUNK);
    const byType = (await su.query<{ item_type: string; n: number }>(`SELECT item_type, count(*)::int AS n FROM exception_items WHERE tenant_id = $1 GROUP BY 1`, [T])).rows;
    expect(byType.map((r) => r.item_type).sort()).toEqual(['failed_send', 'milestone_at_risk', 'missing_outcome', 'overdue_promise', 'untouched_lead']);
    expect((await compareAt(base + MINUTE_MS, 'steady')).old.upserted).toBe(0);

    // 2. stored rows drift: stale evidence and owner (UPDATE path), deleted rows (INSERT path), a stored
    //    clear whose condition still holds (re-opened), a stale rule version
    await su.query(`UPDATE exception_items SET evidence = '[{"sourceType":"x","sourceId":"y","explanation":"stale"}]' WHERE tenant_id = $1 AND dedupe_key IN (SELECT dedupe_key FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send' ORDER BY dedupe_key LIMIT 40)`, [T]);
    await su.query(`UPDATE exception_items SET owner_user_id = NULL, rule_version = 0 WHERE tenant_id = $1 AND dedupe_key IN (SELECT dedupe_key FROM exception_items WHERE tenant_id = $1 AND item_type = 'overdue_promise' ORDER BY dedupe_key LIMIT 25)`, [T]);
    await su.query(`DELETE FROM exception_items WHERE tenant_id = $1 AND dedupe_key IN (SELECT dedupe_key FROM exception_items WHERE tenant_id = $1 AND item_type IN ('untouched_lead','missing_outcome') ORDER BY dedupe_key DESC LIMIT 30)`, [T]);
    await su.query(`UPDATE exception_items SET condition_cleared_at = now() - interval '1 hour' WHERE tenant_id = $1 AND dedupe_key IN (SELECT dedupe_key FROM exception_items WHERE tenant_id = $1 AND condition_cleared_at IS NULL ORDER BY md5(dedupe_key) LIMIT 30)`, [T]);
    const drift = await compareAt(base + 2 * MINUTE_MS, 'drift');
    expect(drift.old.upserted).toBeGreaterThanOrEqual(60);

    // 3. human actions on live items (as the acting users, through the app path)
    const live = await keys(`condition_cleared_at IS NULL`);
    const pick = (i: number) => live[(i * 7919) % live.length]!;
    await act(pick(1), 'resolve', 'owner', 'Called them back');
    // an agent resolves their own item; an admin verifies it
    const agent = users.find((u) => u.role === 'agent')!;
    const own = (await keys(`condition_cleared_at IS NULL AND owner_user_id = '${agent.userId}'`)).find((k) => ![pick(1), pick(3), pick(4)].includes(k))!;
    await act(own, 'resolve', 'agent', 'Handled it');
    await act(own, 'verify', 'admin');
    await act(pick(3), 'resolve', 'admin', 'Done');
    await act(pick(3), 'reopen', 'admin');
    await act(pick(4), 'verify', 'owner');
    await compareAt(base + 3 * MINUTE_MS, 'after human actions');

    // 4. facts change: sends delivered / retried / stuck, promises done late / canceled / done in time,
    //    appointments get outcomes (late and in time) or are canceled; milestone dates done, waived, moved
    const sends = (await su.query<{ id: string }>(`SELECT subject_id AS id FROM exception_items WHERE tenant_id = $1 AND item_type = 'failed_send' ORDER BY dedupe_key LIMIT 60`, [T])).rows.map((r) => r.id);
    await su.query(`UPDATE messages SET status = 'delivered', updated_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, sends.slice(0, 15)]);
    await su.query(`UPDATE messages SET status = 'dispatch_unknown', updated_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, sends.slice(15, 30)]);
    await su.query(`UPDATE messages SET status = 'dispatching', dispatched_at = now(), updated_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, sends.slice(30, 45)]);
    await su.query(`UPDATE messages SET status_reason = 'mailbox full', updated_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, sends.slice(45, 60)]);
    const tasks = (await su.query<{ id: string }>(`SELECT subject_id AS id FROM exception_items WHERE tenant_id = $1 AND item_type = 'overdue_promise' AND condition_cleared_at IS NULL ORDER BY dedupe_key LIMIT 30`, [T])).rows.map((r) => r.id);
    await su.query(`UPDATE tasks SET status = 'done', completed_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, tasks.slice(0, 10)]);
    await su.query(`UPDATE tasks SET status = 'canceled' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, tasks.slice(10, 20)]);
    await su.query(`UPDATE tasks SET status = 'done', completed_at = due_at - interval '1 minute' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, tasks.slice(20, 30)]);
    // new promises falling due soon (enter with time) and one far in the future
    await su.query(`UPDATE tasks SET due_at = now() + interval '30 minutes', status = 'open', completed_at = NULL WHERE tenant_id = $1 AND id IN (
                      SELECT id FROM tasks WHERE tenant_id = $1 AND kind = 'promise' AND created_by_kind <> 'import' AND status = 'open' AND due_at > now() + interval '2 days' ORDER BY id LIMIT 20)`, [T]);
    const appts = (await su.query<{ id: string }>(`SELECT subject_id AS id FROM exception_items WHERE tenant_id = $1 AND item_type = 'missing_outcome' AND condition_cleared_at IS NULL ORDER BY dedupe_key LIMIT 30`, [T])).rows.map((r) => r.id);
    await su.query(`UPDATE appointments SET outcome = 'follow_up', outcome_logged_at = now(), outcome_logged_by_user_id = user_id WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, appts.slice(0, 10)]);
    await su.query(`UPDATE appointments SET status = 'canceled' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, appts.slice(10, 20)]);
    await su.query(`UPDATE appointments SET outcome = 'no_decision', outcome_logged_at = ends_at + interval '1 hour', outcome_logged_by_user_id = user_id WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, appts.slice(20, 30)]);
    // appointments ending now: enter the queue two hours later
    await su.query(`UPDATE appointments SET starts_at = now() - interval '1 hour', ends_at = now(), status = 'scheduled', outcome = NULL, outcome_logged_at = NULL, outcome_logged_by_user_id = NULL WHERE tenant_id = $1 AND id IN (
                      SELECT id FROM appointments WHERE tenant_id = $1 AND created_by_kind <> 'import' AND starts_at > now() ORDER BY id LIMIT 20)`, [T]);
    // milestones: completed, waived, moved (new due version), given a responsible party
    const dds = (await su.query<{ id: string }>(`SELECT subject_id AS id FROM exception_items WHERE tenant_id = $1 AND item_type = 'milestone_at_risk' AND condition_cleared_at IS NULL ORDER BY dedupe_key`, [T])).rows.map((r) => r.id);
    await asPerson(`UPDATE deal_dates SET completed_at = now() WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, dds.slice(0, 3)]);
    await asPerson(`UPDATE deal_dates SET status = 'waived' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, dds.slice(3, 6)]);
    await asPerson(`UPDATE deal_dates SET due_at = now() + interval '5 days', due_on = (now() + interval '5 days')::date, due_version = due_version + 1 WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, dds.slice(6, 9)]);
    await asPerson(`UPDATE deal_dates SET responsible = 'title' WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, dds.slice(9, 12)]);
    const facts = await compareAt(base + 4 * MINUTE_MS, 'facts changed');
    expect(facts.old.cleared).toBeGreaterThan(0);

    // 5. time passes: dispatch_unknown > 10 min, dispatching > 20 min, promises due, appointments + 2 h,
    //    and finally past the 30-day window (old open items are still re-read; fixed items leave the scan)
    for (const [dt, label] of [[11 * MINUTE_MS, '+11 min'], [21 * MINUTE_MS, '+21 min'], [HOUR_MS, '+1 h'], [3 * HOUR_MS, '+3 h'], [2 * DAY_MS, '+2 d'], [10 * DAY_MS, '+10 d'], [31 * DAY_MS, '+31 d'], [45 * DAY_MS, '+45 d']] as const) {
      await compareAt(base + 4 * MINUTE_MS + dt, label);
      if (label === '+3 h') {
        // a cleared item whose condition holds again (task reopened) and more human actions after clears
        await su.query(`UPDATE tasks SET status = 'open', completed_at = NULL WHERE tenant_id = $1 AND id = ANY ($2::uuid[])`, [T, tasks.slice(0, 5)]);
        const cleared = await keys(`condition_cleared_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM exception_events ev WHERE ev.tenant_id = exception_items.tenant_id AND ev.exception_dedupe_key = exception_items.dedupe_key)`);
        await act(cleared[0]!, 'resolve', 'owner', 'Fixed late, noted');
        await act(cleared[1]!, 'verify', 'admin');
      }
    }
    expect(await keys('true')).not.toHaveLength(0);
  }, 600_000);
});
