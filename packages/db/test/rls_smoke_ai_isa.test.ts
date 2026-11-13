// RLS and guard smoke of the AI ISA migration (lane ISA-2; owner decision D12 PROPOSED; docs/AI_ISA.md §8, §13.2).
// Every application step runs as app_user through withTenantTx; the superuser only seeds fixtures without an
// application path here and reads back. No test names the migration's file (the orchestrator renumbers it).
//
// Proves: FORCE RLS, the tenant and support policies and the support statement trigger on every new table; the RLS
// audience per role; every guard code of the ai_isa_mandate branch reachable; the cap race (two transactions, one
// passes); the first daily upsert; the stop-signal trigger per writer; the appointments lock in both orders and the
// assistant-overlap refusal; the loosening guard; the zone reference data equal to core; Postgres AT TIME ZONE
// agreeing with core localWindowContains.
import { AREA_CODE_STATES, areaCodeZones, STATE_ZONES, usFederalHolidays } from '@realty/core/isa';
import { type IanaZone, type Instant, type LocalTime, localWindowContains } from '@realty/core/foundation';
import type { Actor } from '@realty/core/foundation';
import fc from 'fast-check';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordConsentEvent } from '../src/consent.js';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, drainFollowups, type Harness, selfCreated, suFixture, suRows, uuid, type World } from './world.js';
import {
  closedZone, dispatchCode, hmacHex, inbound, type IsaWorld, type Lead, leadUnderCare, markSent, queueAi, setupIsaWorld, sha, startCare,
} from './rls_smoke_ai_isa.fixture.js';

const NEW_TABLES = ['ai_isa_agent_optins', 'ai_isa_assignments', 'ai_isa_controls', 'ai_isa_stop_signals', 'ai_isa_person_blocks', 'ai_isa_turns',
  'ai_isa_slot_offers', 'ai_isa_shared_facts', 'ai_isa_handoffs', 'ai_isa_daily_counts'];

let h: Harness;
let w: World;
let other: World;
let x: IsaWorld;
const support = (): Actor => ({ kind: 'support', userId: w.owner.id, tenantId: w.tenantId, grantId: 'g' }) as Actor;

beforeAll(async () => {
  h = await createHarness(8);
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  other = await createWorld(h.app, { agents: 1 });
  x = await setupIsaWorld(h, w);
});
afterAll(async () => {
  await h?.close();
});

const q = <T extends pg.QueryResultRow>(actor: Actor, text: ReturnType<typeof sql>) =>
  withTenantTx(actor, async (tx) => (await text.execute(tx)).rows as T[], { db: h.app });
const errOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /([A-Z][A-Z_]{3,}):/.exec((e as Error).message);
    return m ? m[1]! : (e as Error).message;
  }
};

describe('AI ISA schema invariants (R-ISA-21, R-ISA-15)', () => {
  it('FORCE RLS, the restrictive tenant and support policies and the support statement trigger on every new table', async () => {
    const rows = await suRows<{ relname: string; f: boolean; tenant: boolean; sup: boolean; trg: boolean }>(h.su, `
      SELECT c.relname, c.relforcerowsecurity AS f,
             EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation' AND NOT p.polpermissive) AS tenant,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname LIKE 'support_read_only_%' AND NOT p.polpermissive) = 3 AS sup,
             EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = 'support_read_only') AS trg
        FROM pg_class c WHERE c.relname = ANY ($1) ORDER BY 1`, [NEW_TABLES]);
    expect(rows).toHaveLength(NEW_TABLES.length);
    for (const r of rows) expect(r, r.relname).toMatchObject({ f: true, tenant: true, sup: true, trg: true });
  });

  it('R-ISA-15: controls and stop signals are insert-only; app_user cannot write daily counts', async () => {
    const [c] = await suRows<{ u: boolean; d: boolean; cu: boolean }>(h.su, `SELECT has_table_privilege('app_user','ai_isa_daily_counts','INSERT') AS u,
      has_table_privilege('app_user','ai_isa_stop_signals','DELETE') AS d, has_table_privilege('app_user','ai_isa_controls','UPDATE') AS cu`);
    expect(c).toEqual({ u: false, d: false, cu: false });
  });

  it('R-ISA-10: the zone reference tables equal the core data (every row VERIFY)', async () => {
    const ac = await suRows<{ area_code: string; zone: string }>(h.su, 'SELECT area_code, zone FROM ai_isa_area_code_zones ORDER BY 1, 2');
    const want = Object.keys(AREA_CODE_STATES).flatMap((c) => areaCodeZones(c).map((z) => `${c} ${z}`)).sort();
    expect(ac.map((r) => `${r.area_code} ${r.zone}`).sort()).toEqual(want);
    const st = await suRows<{ state: string; zone: string }>(h.su, 'SELECT state, zone FROM ai_isa_state_zones');
    expect(st.map((r) => `${r.state} ${r.zone}`).sort()).toEqual(Object.entries(STATE_ZONES).flatMap(([s, zs]) => zs.map((z) => `${s} ${z}`)).sort());
  });

  it('R-ISA-10 E514: Postgres AT TIME ZONE agrees with core localWindowContains over 10,000 random instants and zones', async () => {
    const zones = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage',
      'Pacific/Honolulu', 'Pacific/Guam', 'Pacific/Pago_Pago', 'America/Puerto_Rico', 'America/Boise', 'America/Adak'];
    const from = Date.UTC(2026, 0, 1);
    const to = Date.UTC(2030, 11, 31);
    const samples = fc.sample(fc.tuple(fc.integer({ min: from, max: to }), fc.constantFrom(...zones)), { numRuns: 10_000, seed: 20261112 });
    const r = await h.su.query<{ inside: boolean[] }>(`
      SELECT array_agg(((to_timestamp(t / 1000.0) AT TIME ZONE z)::time >= '08:00' AND (to_timestamp(t / 1000.0) AT TIME ZONE z)::time < '20:00') ORDER BY i) AS inside
        FROM unnest($1::bigint[], $2::text[]) WITH ORDINALITY AS s(t, z, i)`, [samples.map((s) => s[0]), samples.map((s) => s[1])]);
    const db = r.rows[0]!.inside;
    const mismatches = samples.filter((s, i) => localWindowContains(s[0] as Instant, s[1] as IanaZone, (8 * 3600) as LocalTime, (20 * 3600) as LocalTime) !== db[i]);
    expect(mismatches).toEqual([]);
  });

  it('R-ISA-10 (b12 review B12X-6): the guard\'s federal-holiday rule equals core usFederalHolidays on every day of 2020-2045, and the send check refuses an initiated message on one', async () => {
    const r = await h.su.query<{ d: string }>(`SELECT to_char(d, 'YYYY-MM-DD') AS d FROM generate_series('2020-01-01'::date, '2045-12-31'::date, interval '1 day') d
      WHERE app.ai_isa_us_federal_holiday(d::date) ORDER BY 1`);
    const want = Array.from({ length: 26 }, (_, i) => usFederalHolidays(2020 + i)).flat().filter((d) => d >= '2020-01-01' && d <= '2045-12-31');
    expect(r.rows.map((x) => x.d)).toEqual([...new Set(want)].sort());
    const [src] = await suRows<{ src: string }>(h.su, `SELECT prosrc AS src FROM pg_proc WHERE oid = 'app.ai_isa_send_check(public.messages)'::regprocedure`);
    expect(src!.src).toContain("tier = 'initiated' AND app.ai_isa_us_federal_holiday(lt::date)");
  });

  it('R-ISA-5: a turn decision holds codes and handles only (a free-text value is refused by the CHECK)', async () => {
    const l = await leadUnderCare(x);
    const bad = errOf(withTenantTx(w.system('assistant'), (tx) => sql`INSERT INTO ai_isa_turns (tenant_id, id, assignment_id, contact_id, seq, epoch,
      trigger_kind, trigger_key, pinned_inbound_seq, state_before, rules_version, policy_version, prompt_version, decision)
      VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, 1, 1, 'start', 'k1', 0, 'starting', 'r', 'p', 'q',
              '{"note":"client agreed to 2% commission, wire to acct"}'::jsonb)`.execute(tx), { db: h.app }));
    expect(await bad).toMatch(/ai_isa_turns_decision_check/);
    await withTenantTx(w.system('assistant'), (tx) => sql`INSERT INTO ai_isa_turns (tenant_id, id, assignment_id, contact_id, seq, epoch,
      trigger_kind, trigger_key, pinned_inbound_seq, state_before, rules_version, policy_version, prompt_version, decision)
      VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, 1, 1, 'start', 'k2', 0, 'starting', 'r', 'p', 'q',
              '{"allowed":["reply","record_qualification:S1"],"denied":["HANDLE_UNKNOWN:L9"]}'::jsonb)`.execute(tx), { db: h.app });
  });
});

describe('RLS per role (R-ISA-22, R-TEN-1)', () => {
  let l: Lead;
  beforeAll(async () => {
    l = await leadUnderCare(x);
  });
  const countAs = async (a: Actor, table: string) => Number((await q<{ n: string }>(a, sql`SELECT count(*) AS n FROM ${sql.table(table)} WHERE contact_id = ${l.contactId}`))[0]!.n);

  it('R-ISA-22: the owner, Owner/Admin and the system see the assignment; another agent and another tenant do not; support reads only', async () => {
    expect(await countAs(x.agent.actor, 'ai_isa_assignments')).toBe(1);
    expect(await countAs(w.owner.actor, 'ai_isa_assignments')).toBe(1);
    expect(await countAs(w.system('worker'), 'ai_isa_assignments')).toBe(1);
    expect(await countAs(w.agents[1]!.actor, 'ai_isa_assignments')).toBe(0);
    expect(await countAs(other.owner.actor, 'ai_isa_assignments')).toBe(0);
    expect(await errOf(q(support(), sql`UPDATE ai_isa_assignments SET paused_at = now() WHERE id = ${l.assignmentId}`))).toMatch(/support|read-only|row-level/i);
  });

  it('R-ISA-22: turns, offers, facts and handoffs are written only by the system; a user insert is refused by RLS', async () => {
    expect(await errOf(q(x.agent.actor, sql`INSERT INTO ai_isa_turns (tenant_id, id, assignment_id, contact_id, seq, epoch, trigger_kind, trigger_key,
      pinned_inbound_seq, state_before, rules_version, policy_version, prompt_version) VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId},
      ${l.contactId}, 1, 1, 'start', 'u', 0, 'starting', 'r', 'p', 'q')`))).toMatch(/row-level security/);
    expect(await errOf(q(x.agent.actor, sql`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, reason) VALUES (app.tenant_id(), ${uuid()}, ${l.contactId}, 'complaint')`))).toMatch(/row-level security/);
  });

  it('R-ISA-31: any tenant actor may insert a stop signal, never for another tenant; nobody updates or deletes one', async () => {
    await q(w.agents[1]!.actor, sql`INSERT INTO ai_isa_stop_signals (tenant_id, address_hmac, reason, source_table) VALUES (app.tenant_id(), decode(${hmacHex('nobody')}, 'hex'), 'opted_out', 'manual')`);
    expect(await errOf(q(w.agents[1]!.actor, sql`INSERT INTO ai_isa_stop_signals (tenant_id, address_hmac, reason, source_table) VALUES (${other.tenantId}, decode(${hmacHex('nobody')}, 'hex'), 'opted_out', 'manual')`))).toMatch(/row-level security/);
    expect(await errOf(q(w.system('worker'), sql`UPDATE ai_isa_stop_signals SET reason = 'merged'`))).toMatch(/permission denied|APPEND_ONLY/);
  });

  it('R-ISA-11: daily counts are readable by Owner/Admin only', async () => {
    expect(await errOf(q(w.owner.actor, sql`SELECT * FROM ai_isa_daily_counts`))).toBe('ok');
    expect(await q(x.agent.actor, sql`SELECT * FROM ai_isa_daily_counts`)).toEqual([]);
  });
});

describe('loosening, opt-in and assignment guards (R-ISA-32, R-ISA-15, R-ISA-16, R-ISA-28)', () => {
  it('R-ISA-32: only the Owner turns the switch on or raises the cap; an Admin may turn it off or lower it', async () => {
    const w2 = await createWorld(h.app, { agents: 1 });
    const [adminId] = [uuid()];
    void adminId;
    // an agent's UPDATE reaches no row (tenant_settings RLS); the system actor reaches it and the guard refuses
    await errOf(q(w2.agents[0]!.actor, sql`UPDATE tenant_settings SET ai_isa_enabled = true, ai_isa_enabled_by = ${w2.agents[0]!.id}, ai_isa_enabled_at = now()`));
    expect((await suRows<{ e: boolean }>(h.su, 'SELECT ai_isa_enabled AS e FROM tenant_settings WHERE tenant_id = $1', [w2.tenantId]))[0]!.e).toBe(false);
    expect(await errOf(q(w2.system('worker'), sql`UPDATE tenant_settings SET ai_isa_enabled = true, ai_isa_enabled_at = now()`))).toBe('AI_ISA_OWNER_ONLY');
    expect(await errOf(q(w2.owner.actor, sql`UPDATE tenant_settings SET ai_isa_enabled = true`))).toBe('AI_ISA_OWNER_ONLY');
    expect(await errOf(q(w2.owner.actor, sql`UPDATE tenant_settings SET ai_isa_enabled = true, ai_isa_enabled_by = ${w2.owner.id}, ai_isa_enabled_at = now()`))).toBe('ok');
    expect(await errOf(q(w2.system('worker'), sql`UPDATE tenant_settings SET ai_isa_daily_cap = 500`))).toBe('AI_ISA_OWNER_ONLY');
    expect(await errOf(q(w2.system('worker'), sql`UPDATE tenant_settings SET ai_isa_daily_cap = 10`))).toBe('ok');
    expect(await errOf(q(w2.owner.actor, sql`UPDATE tenant_settings SET ai_isa_daily_cap = 1001`))).toMatch(/ai_isa_daily_cap_check/);
  });

  it('R-ISA-32: an opt-in is made as oneself, on an approved ai_isa version, with a recomputed attestation embedding the version hash', async () => {
    const agent2 = w.agents[1]!;
    const att = `I opt in. I'm responsible for leads I put in AI care. (no version hash here at all)`;
    expect(await errOf(q(agent2.actor, sql`INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone)
      VALUES (app.tenant_id(), ${uuid()}, ${agent2.id}, ${x.versionId}, ${att}, ${sha(att)}, ARRAY['converse'], ARRAY['sms'], 'America/New_York')`))).toBe('AI_ISA_ATTESTATION_INVALID');
    const good = `Version ${x.versionSha}. I'm responsible for leads I put in AI care.`;
    expect(await errOf(q(agent2.actor, sql`INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone)
      VALUES (app.tenant_id(), ${uuid()}, ${x.agent.id}, ${x.versionId}, ${good}, ${sha(good)}, ARRAY['converse'], ARRAY['sms'], 'America/New_York')`))).toBe('AI_ISA_OPTIN_SELF_ONLY');
    expect(await errOf(q(agent2.actor, sql`INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone)
      VALUES (app.tenant_id(), ${uuid()}, ${agent2.id}, ${x.versionId}, ${good}, ${sha(good)}, ARRAY['converse'], ARRAY['sms'], 'Mars/Olympus')`))).toBe('AI_ISA_TIMEZONE_INVALID');
    expect(await errOf(q(agent2.actor, sql`INSERT INTO ai_isa_agent_optins (tenant_id, id, user_id, playbook_version_id, attestation, attestation_sha256, capabilities, channels, timezone)
      VALUES (app.tenant_id(), ${uuid()}, ${agent2.id}, ${x.versionId}, ${good}, ${sha(good)}, ARRAY['share_value_estimate'], ARRAY['sms'], 'America/New_York')`))).toMatch(/capabilities_check/);
    expect(await errOf(q(x.agent.actor, sql`UPDATE ai_isa_agent_optins SET capabilities = ARRAY['converse','book_appointments'] WHERE id = ${x.optinId}`))).toMatch(/permission denied|AI_ISA_OPTIN_IMMUTABLE/);
  });

  it('R-ISA-16 E516: a non-owner cannot start care; the first touch must be recorded; a merged record is not a root', async () => {
    const l = await leadUnderCare(x, { start: false });
    const p = { phonePointId: l.phonePointId, phone: l.phone, emailPointId: l.emailPointId, email: l.email };
    expect(await errOf(startCare(x, l.contactId, uuid(), p, w.owner.actor))).toBe('AI_ISA_NOT_OWNER');
    await suFixture(h.su, `UPDATE contacts SET first_touch_at = NULL, release_due_at = now() + interval '1 hour' WHERE id = $1`, [l.contactId]);
    expect(await errOf(startCare(x, l.contactId, uuid(), p))).toBe('AI_ISA_FIRST_TOUCH_PENDING');
    await suFixture(h.su, `UPDATE contacts SET release_due_at = NULL WHERE id = $1`, [l.contactId]);
    await startCare(x, l.contactId, uuid(), p);
    expect(await errOf(startCare(x, l.contactId, uuid(), p))).toMatch(/ai_isa_assignments_live_uq/);
  });

  it('R-ISA-15: the system never clears a pause; a non-owner never resumes; resume increments the epoch; an ended assignment is final; bindings are immutable', async () => {
    const l = await leadUnderCare(x);
    const upd = (a: Actor, set: ReturnType<typeof sql>) => errOf(q(a, sql`UPDATE ai_isa_assignments SET ${set} WHERE id = ${l.assignmentId}`));
    expect(await upd(w.agents[1]!.actor, sql`paused_at = now(), paused_by_kind = 'user', paused_by_user_id = ${w.agents[1]!.id}, pause_reason = 'user'`)).toBe('ok'); // invisible: 0 rows
    expect(await upd(w.owner.actor, sql`paused_at = now(), paused_by_kind = 'user', paused_by_user_id = ${w.owner.id}, pause_reason = 'user'`)).toBe('ok');
    expect(await upd(w.system('worker'), sql`paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL`)).toBe('AI_ISA_SYSTEM_NEVER_RESUMES');
    expect(await upd(w.owner.actor, sql`paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL, epoch = epoch + 1`)).toBe('AI_ISA_RESUME_OWNER_ONLY');
    expect(await upd(x.agent.actor, sql`paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL`)).toBe('AI_ISA_RESUME_OWNER_ONLY');
    expect(await upd(x.agent.actor, sql`paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL, epoch = epoch + 1`)).toBe('ok');
    expect(await upd(x.agent.actor, sql`owner_user_id = ${w.owner.id}`)).toBe('AI_ISA_IMMUTABLE');
    expect(await upd(x.agent.actor, sql`bound_points = '{"sms":{"point_id":"x"}}'::jsonb`)).toBe('AI_ISA_IMMUTABLE');
    expect(await upd(w.system('worker'), sql`ended_at = now(), end_reason = 'ended_by_user', ended_by_kind = 'system'`)).toBe('ok');
    expect(await upd(w.system('worker'), sql`state = 'engaged'`)).toBe('AI_ISA_ENDED');
  });

  it('R-ISA-2: a new live playbook enrollment is refused while the person is under AI care (AI_ISA_ACTIVE)', async () => {
    const l = await leadUnderCare(x);
    const pb = uuid();
    const v = uuid();
    await suFixture(h.su, `INSERT INTO playbooks (tenant_id, id, kind, scope, name, status) VALUES ($1, $2, 'nurture', 'team', 'Nurture', 'active');
      INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, tone, content_sha256, status, created_by_user_id)
        VALUES ($1, $3, $2, 1, '[]'::jsonb, '{}'::jsonb, repeat('cd', 32), 'approved', $4);`, [w.tenantId, pb, v, w.owner.id]);
    expect(await errOf(q(w.system('worker'), sql`INSERT INTO playbook_enrollments (tenant_id, id, playbook_id, playbook_version_id, contact_id, enrolled_by, state)
      VALUES (app.tenant_id(), ${uuid()}, ${pb}, ${v}, ${l.contactId}, 'new_lead', 'active')`))).toBe('AI_ISA_ACTIVE');
  });
});

describe('the dispatch guard ai_isa_mandate branch: every code reachable (R-ISA-8, R-ISA-1, R-ISA-4, R-ISA-28)', () => {
  it('R-ISA-8: a reply to the person\'s own bound text, inside the window, passes; it is counted for the tenant day', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    expect(await dispatchCode(x, m.messageId)).toBe('ok');
    const [c] = await suRows<{ n: number }>(h.su, 'SELECT n FROM ai_isa_daily_counts WHERE tenant_id = $1', [w.tenantId]);
    expect(c!.n).toBeGreaterThanOrEqual(1);
  });

  it('R-ISA-1: the pack uncleared, the tenant switch off, the version revoked or the opt-in revoked each refuse ISA_NOT_AUTHORIZED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    try {
    await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:ai_isa'`);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_NOT_AUTHORIZED');
    await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'`);
    await h.su.query(`UPDATE tenant_settings SET ai_enabled = false WHERE tenant_id = $1`, [w.tenantId]);
    await expect(dispatchCode(x, (await queueAi(x, l)).messageId)).resolves.toBe('ISA_NOT_AUTHORIZED');
    await h.su.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1`, [w.tenantId]);
    await h.su.query(`SET session_replication_role = replica; UPDATE playbook_versions SET status = 'revoked' WHERE id = '${x.versionId}'; SET session_replication_role = origin`);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_NOT_AUTHORIZED');
    await h.su.query(`SET session_replication_role = replica; UPDATE playbook_versions SET status = 'approved' WHERE id = '${x.versionId}'; SET session_replication_role = origin`);
    await h.su.query(`UPDATE ai_isa_agent_optins SET status = 'revoked', revoked_at = now() WHERE id = $1`, [x.optinId]);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_NOT_AUTHORIZED');
    } finally {
      await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:ai_isa'`);
      await h.su.query(`UPDATE tenant_settings SET ai_enabled = true WHERE tenant_id = $1`, [w.tenantId]);
      await h.su.query(`SET session_replication_role = replica; UPDATE playbook_versions SET status = 'approved' WHERE id = '${x.versionId}';
        UPDATE ai_isa_agent_optins SET status = 'active', revoked_at = NULL WHERE id = '${x.optinId}'; SET session_replication_role = origin`);
    }
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ok');
  });

  it('R-ISA-16 E525: a wrong ownership seq or another owner refuses ISA_NOT_AUTHORIZED; a merged root too', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    await h.su.query(`SET session_replication_role = replica; UPDATE contacts SET ownership_seq = ownership_seq + 1, ownership_period_seq = ownership_seq + 1 WHERE id = '${l.contactId}'; SET session_replication_role = origin`);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_NOT_AUTHORIZED');
  });

  it('R-ISA-4 E493 E494: a stale pinned inbound seq refuses ISA_STALE_REPLY; a stale epoch ISA_STALE_EPOCH; a changed body ISA_BODY_CHANGED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m1 = await queueAi(x, l);
    await inbound(x, l);
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_STALE_REPLY');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    const m2 = await queueAi(x, l, { epoch: 7 });
    expect(await dispatchCode(x, m2.messageId)).toBe('ISA_STALE_EPOCH');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m2.actionId]);
    const m3 = await queueAi(x, l, { frozenBody: 'something else' });
    expect(await dispatchCode(x, m3.messageId)).toBe('ISA_BODY_CHANGED');
  });

  it('R-ISA-28 E503: a recipient other than the bound point refuses ISA_UNBOUND_RECIPIENT; purpose informational ISA_PURPOSE_MISMATCH', async () => {
    const l = await leadUnderCare(x);
    const second = '+15550139999';
    await withTenantTx(x.agent.actor, (tx) => sql`INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac)
      VALUES (app.tenant_id(), ${uuid()}, ${l.contactId}, 'phone', ${second}, decode(${hmacHex(second)}, 'hex'))`.execute(tx), { db: h.app });
    await inbound(x, l);
    const m1 = await queueAi(x, l, { to: second });
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_UNBOUND_RECIPIENT');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    const m2 = await queueAi(x, l, { purpose: 'informational' });
    expect(await dispatchCode(x, m2.messageId)).toBe('ISA_PURPOSE_MISMATCH');
  });

  it('R-ISA-15: a paused assignment refuses ISA_PAUSED; a withdrawn action ASSISTANT_ACTION_WITHDRAWN', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    await q(x.agent.actor, sql`UPDATE ai_isa_assignments SET paused_at = now(), paused_by_kind = 'user', paused_by_user_id = ${x.agent.id}, pause_reason = 'user' WHERE id = ${l.assignmentId}`);
    expect(await dispatchCode(x, m.messageId)).toBe('ISA_PAUSED');
    await h.su.query(`UPDATE assistant_actions SET status = 'invalidated' WHERE id = $1`, [m.actionId]);
    expect(await dispatchCode(x, m.messageId)).toBe('ASSISTANT_ACTION_WITHDRAWN');
  });

  it('R-ISA-9 E520: a reply outside the 24 h window of their own text, or with no own inbound, refuses ISA_REPLY_WINDOW_CLOSED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l, { ageMinutes: 25 * 60 });
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_REPLY_WINDOW_CLOSED');
  });

  it('R-ISA-28 R-ISA-9: an email reply needs an aligned DKIM pass on the inbound (a forged From is not reply evidence)', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l, { channel: 'email', dkim: false });
    expect(await dispatchCode(x, (await queueAi(x, l, { channel: 'email' })).messageId)).toBe('ISA_REPLY_WINDOW_CLOSED');
  });

  it('R-ISA-9 E519: an initiated text without an express-written grant from their own disclosure refuses ISA_CONSENT_EVIDENCE_MISSING; with one but no fresh DNC result ISA_DNC_UNVERIFIED', async () => {
    const l = await leadUnderCare(x);
    const m1 = await queueAi(x, l, { kind: 'initiated' });
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_CONSENT_EVIDENCE_MISSING');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    const discId = await grantFromOwnDisclosure(l, { scopeStated: true });
    const m2 = await queueAi(x, l, { kind: 'initiated' });
    expect(await dispatchCode(x, m2.messageId)).toBe('ISA_DNC_UNVERIFIED');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m2.actionId]);
    await suFixture(h.su, `INSERT INTO dnc_checks (tenant_id, id, phone_hmac, registry, listed, checked_at, valid_until, provider)
      VALUES ($1, gen_random_uuid(), decode($2, 'hex'), 'us_national', false, now(), now() + interval '31 days', 'fake')`, [w.tenantId, hmacHex(l.phone)]);
    expect(await dispatchCode(x, (await queueAi(x, l, { kind: 'initiated' })).messageId)).toBe('ok');
    void discId;
  });

  it('R-ISA-9 E519: a defaulted scope, a source fallback disclosure, a body not naming the team, an imported or pre-D12 grant never count', async () => {
    for (const variant of ['scope_null', 'fallback', 'unnamed', 'imported', 'pre_d12'] as const) {
      const l = await leadUnderCare(x);
      await grantFromOwnDisclosure(l, { scopeStated: variant === 'scope_null' ? null : true, fallback: variant === 'fallback', unnamed: variant === 'unnamed', imported: variant === 'imported', preD12: variant === 'pre_d12' });
      await suFixture(h.su, `INSERT INTO dnc_checks (tenant_id, id, phone_hmac, registry, listed, checked_at, valid_until, provider)
        VALUES ($1, gen_random_uuid(), decode($2, 'hex'), 'us_national', false, now(), now() + interval '31 days', 'fake')`, [w.tenantId, hmacHex(l.phone)]);
      expect(await dispatchCode(x, (await queueAi(x, l, { kind: 'initiated' })).messageId), variant).toBe('ISA_CONSENT_EVIDENCE_MISSING');
    }
  });

  it('R-ISA-10 E511 E512: a zone outside the window refuses ISA_QUIET_HOURS; a turn missing a zone of the minimum set ISA_ZONE_UNRESOLVED', async () => {
    const l = await leadUnderCare(x, { zone: closedZone() });
    await inbound(x, l);
    const m1 = await queueAi(x, l);
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_QUIET_HOURS');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    const m2 = await queueAi(x, l, { zones: ['America/New_York'] });
    expect(await dispatchCode(x, m2.messageId)).toBe('ISA_ZONE_UNRESOLVED');
    // E512: without an explicit zone the minimum set is the union (area code, tenant, continental): one zone never covers it
    const l2 = await leadUnderCare(x);
    await h.su.query(`UPDATE contacts SET timezone_source = 'area_code' WHERE id = $1`, [l2.contactId]);
    await inbound(x, l2);
    expect(await dispatchCode(x, (await queueAi(x, l2)).messageId)).toBe('ISA_ZONE_UNRESOLVED');
  });

  it('R-ISA-11 E515: a 4th AI message in 24 h refuses ISA_CAP_REACHED; the 120 s gap ISA_MIN_GAP; bulk and automated sends count toward the total', async () => {
    const l = await leadUnderCare(x);
    for (const ago of [30, 20, 10]) {
      await inbound(x, l);
      const m = await queueAi(x, l);
      expect(await dispatchCode(x, m.messageId)).toBe('ok');
      await markSent(x, m.messageId, ago);
      await h.su.query(`UPDATE assistant_actions SET status = 'executed' WHERE id = $1`, [m.actionId]);
    }
    await inbound(x, l);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_CAP_REACHED');
    const g = await leadUnderCare(x);
    await inbound(x, g);
    const first = await queueAi(x, g);
    expect(await dispatchCode(x, first.messageId)).toBe('ok');
    await h.su.query(`UPDATE assistant_actions SET status = 'executed' WHERE id = $1`, [first.actionId]);
    await inbound(x, g);
    expect(await dispatchCode(x, (await queueAi(x, g)).messageId)).toBe('ISA_MIN_GAP');
    // the AI yields: three bulk or automated messages to the person today leave no room
    const b = await leadUnderCare(x);
    for (let i = 0; i < 3; i += 1) {
      await suFixture(h.su, `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
          initiator, purpose, action_category, dispatched_at, occurred_at) VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, '+15555559200', $5, 'Alert', 'sent',
          'system', 'informational', 'search_alert', now() - interval '1 hour', now())`, [w.tenantId, b.conversationId, b.contactId, x.numberId, b.phone]);
    }
    await inbound(x, b);
    expect(await dispatchCode(x, (await queueAi(x, b)).messageId)).toBe('ISA_CAP_REACHED');
  });

  it('R-ISA-2 E527: an address shared with another person refuses ISA_SHARED_ADDRESS; an open deal ISA_ACTIVE_CLIENT', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const otherContact = await selfCreated(h.app, w, w.agents[1]!, 'Spouse');
    await suFixture(h.su, `INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES ($1, gen_random_uuid(), $2, 'phone', $3, decode($4, 'hex'))`,
      [w.tenantId, otherContact, l.phone, hmacHex(l.phone)]);
    const m1 = await queueAi(x, l);
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_SHARED_ADDRESS');
    await h.su.query(`DELETE FROM contact_points WHERE contact_id = $1`, [otherContact]);
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    await suFixture(h.su, `INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id)
      VALUES ($1, gen_random_uuid(), 'Deal', 'buy', 'active', now(), $2, $3, $3)`, [w.tenantId, l.contactId, x.agent.id]);
    expect(await dispatchCode(x, (await queueAi(x, l)).messageId)).toBe('ISA_ACTIVE_CLIENT');
  });

  it('R-ISA-8: an unread MMS text part refuses ISA_UNREAD_PART; a sold-comp fact without the seller packs ISA_SELLER_DATA_NOT_CLEARED', async () => {
    const l = await leadUnderCare(x);
    const inb = await inbound(x, l);
    await suFixture(h.su, `INSERT INTO message_text_parts (tenant_id, message_id, position, status) VALUES ($1, $2, 0, 'pending')`, [w.tenantId, inb]);
    const m1 = await queueAi(x, l);
    expect(await dispatchCode(x, m1.messageId)).toBe('ISA_UNREAD_PART');
    await h.su.query(`DELETE FROM message_text_parts WHERE message_id = $1`, [inb]);
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [m1.actionId]);
    expect(await dispatchCode(x, (await queueAi(x, l, { channel: 'email', facts: 'sold_comp_set' })).messageId)).toBe('ISA_SELLER_DATA_NOT_CLEARED');
  });

  it('R-ISA-24: an AI ISA category sent by a human is refused ISA_NOT_AUTHORIZED; the mandate CHECK ties autonomy to the AI categories', async () => {
    const l = await leadUnderCare(x);
    expect(await errOf(q(x.agent.actor, sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
      body, status, initiator, initiated_by_user_id, purpose, action_category, dispatched_at, occurred_at) VALUES (app.tenant_id(), ${uuid()}, ${l.conversationId}, ${l.contactId},
      'sms', 'outbound', ${x.numberId}, '+15555559200', ${l.phone}, 'Hi', 'dispatching', 'human', ${x.agent.id}, 'marketing', 'ai_isa_message', now(), now())`))).toBe('ISA_NOT_AUTHORIZED');
    expect(await errOf(q(w.system('assistant'), sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload)
      VALUES (app.tenant_id(), ${uuid()}, ${l.contactId}, 'message_draft', 'ai_isa_message', 'requires_approval', 'proposed', ${x.agent.id}, 'x', '{}'::jsonb)`))).toMatch(/ai_isa/);
  });

  it('R-ISA-24 (b12 review db-guard-selfcheck-1): an AI ISA category sent by the system (no assistant action) is refused ISA_NOT_AUTHORIZED', async () => {
    const l = await leadUnderCare(x);
    for (const category of ['ai_isa_message', 'ai_isa_confirmation', 'ai_isa_holding_line']) {
      expect(await errOf(q(w.system('worker'), sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address,
        body, status, initiator, purpose, action_category, dispatched_at, occurred_at) VALUES (app.tenant_id(), ${uuid()}, ${l.conversationId}, ${l.contactId},
        'sms', 'outbound', ${x.numberId}, '+15555559200', ${l.phone}, 'Hi', 'dispatching', 'system', 'marketing', ${category}, now(), now())`)), category).toBe('ISA_NOT_AUTHORIZED');
    }
  });

  it('R-ISA-24 (isa-2-2): an assistant message carrying an AI ISA category under a within_playbook or requires_approval action is refused ISA_NOT_AUTHORIZED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const pb = uuid();
    const pv = uuid();
    await suFixture(h.su, `
      INSERT INTO playbooks (tenant_id, id, kind, scope, owner_user_id, name) VALUES ($1, $2, 'nurture', 'team', NULL, 'Nurture ' || $2);
      INSERT INTO playbook_versions (tenant_id, id, playbook_id, version_no, steps, content_sha256, status, created_by_user_id)
        VALUES ($1, $3, $2, 1, '[]', repeat('ab', 32), 'approved', $4);`, [w.tenantId, pb, pv, x.agent.id]);
    const send = async (autonomy: 'within_playbook' | 'requires_approval', category: string) => {
      const action = uuid();
      const auto = autonomy === 'within_playbook';
      await suFixture(h.su, `INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, playbook_version_id, status, owner_user_id,
          decided_by_user_id, decided_at, explanation, payload)
        VALUES ($1, $2, $3, $4, 'speed_to_lead_reply', $5, $6, $7, $8, $9, $10, 'Reply', '{}')`,
        [w.tenantId, action, l.contactId, auto ? 'autonomous_message' : 'message_draft', autonomy, auto ? pv : null,
          auto ? 'proposed' : 'approved', x.agent.id, auto ? null : x.agent.id, auto ? null : new Date().toISOString()]);
      return errOf(q(w.system('assistant'), sql`INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address,
          to_address, body, status, initiator, purpose, action_category, assistant_action_id, dispatched_at, occurred_at)
        VALUES (app.tenant_id(), ${uuid()}, ${l.conversationId}, ${l.contactId}, 'sms', 'outbound', ${x.numberId}, '+15555559200', ${l.phone}, 'Hi',
          'dispatching', 'assistant', 'marketing', ${category}, ${action}, now(), now())`));
    };
    for (const autonomy of ['within_playbook', 'requires_approval'] as const) {
      for (const category of ['ai_isa_message', 'ai_isa_confirmation', 'ai_isa_holding_line']) {
        expect(await send(autonomy, category), `${autonomy} ${category}`).toBe('ISA_NOT_AUTHORIZED');
      }
      // the same action with its own category still goes (the refusal is the AI ISA category, not the action)
      expect(await send(autonomy, 'speed_to_lead_reply'), autonomy).toBe('ok');
    }
  });

  it('R-ISA-11 E515: two sends racing for the tenant\'s last daily slot: exactly one passes (the guarded upsert)', async () => {
    const w4 = await createWorld(h.app, { agents: 1 });
    const x4 = await setupIsaWorld(h, w4, { clear: false, d12: false });
    const [la, lb] = [await leadUnderCare(x4), await leadUnderCare(x4)];
    await inbound(x4, la);
    await inbound(x4, lb);
    await h.su.query(`UPDATE tenant_settings SET ai_isa_daily_cap = 1 WHERE tenant_id = $1`, [w4.tenantId]);
    const [a, b] = [await queueAi(x4, la), await queueAi(x4, lb)];
    const [ra, rb] = await Promise.all([dispatchCode(x4, a.messageId), dispatchCode(x4, b.messageId)]);
    expect([ra, rb].sort()).toEqual(['ISA_CAP_REACHED', 'ok']);
  });

  it('R-ISA-4: the guard takes the per-address send lock: a dispatch waits while another transaction holds the person\'s lock', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    const c = new pg.Client({ connectionString: h.db.appUserUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('ai_isa.send:' || $1 || ':' || $2, 0))`, [w.tenantId, hmacHex(l.phone)]);
    let done = false;
    const p = dispatchCode(x, m.messageId).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await c.query('COMMIT');
    await c.end();
    expect(await p).toBe('ok');
  });

  it('R-ISA-11: the tenant daily cap: the first upsert inserts the day row; a cap of 0 refuses ISA_CAP_REACHED', async () => {
    const w3 = await createWorld(h.app, { agents: 1 });
    const x3 = await setupIsaWorld(h, w3, { clear: false, d12: false });
    const l = await leadUnderCare(x3);
    await inbound(x3, l);
    expect(await dispatchCode(x3, (await queueAi(x3, l)).messageId)).toBe('ok');
    const [c] = await suRows<{ n: number }>(h.su, 'SELECT n FROM ai_isa_daily_counts WHERE tenant_id = $1', [w3.tenantId]);
    expect(c!.n).toBe(1);
    await h.su.query(`UPDATE tenant_settings SET ai_isa_daily_cap = 1 WHERE tenant_id = $1`, [w3.tenantId]);
    const l2 = await leadUnderCare(x3);
    await inbound(x3, l2);
    expect(await dispatchCode(x3, (await queueAi(x3, l2)).messageId)).toBe('ISA_CAP_REACHED');
  });
});

async function grantFromOwnDisclosure(l: Lead, o: { scopeStated: boolean | null; fallback?: boolean; unnamed?: boolean; imported?: boolean; preD12?: boolean }): Promise<string> {
  const discId = uuid();
  const [ts] = await suRows<{ team_name: string | null; brokerage_legal_name: string }>(h.su, 'SELECT team_name, brokerage_legal_name FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]);
  const named = o.unnamed ? 'the real estate team' : ts!.brokerage_legal_name;
  await suFixture(h.su, `
    INSERT INTO consent_disclosures (tenant_id, id, channel_scope, purpose_scope, body, body_sha256, names_seller, source_kind, scope_stated)
      VALUES ($1, $2, ARRAY['sms','email'], ARRAY['marketing','informational'], $3, encode(digest($3, 'sha256'), 'hex'), $4, 'own_form', $5);
    INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, received_at, inquiry_type, fingerprint, outcome, consent_disclosure_id)
      VALUES ($1, gen_random_uuid(), $6, $7, now(), 'buy', 'fp-' || gen_random_uuid(), 'new_contact', $2);`,
    [w.tenantId, discId, `By submitting you agree that ${named} may text and email you about homes (${discId}).`, ts!.brokerage_legal_name, o.scopeStated === null ? null : String(o.scopeStated), l.contactId, w.leadSourceId]);
  if (o.fallback) await suFixture(h.su, `UPDATE lead_sources SET consent_disclosure_id = $2 WHERE tenant_id = $1 AND id = $3`, [w.tenantId, discId, w.leadSourceId]);
  await suFixture(h.su, `INSERT INTO consent_events (tenant_id, id, address_kind, address_hmac, address_hint, channel, purpose, event_type, consent_level, source,
      occurred_at, recorded_at, contact_id, actor_kind, disclosure_id, evidence, imported, import_record_id, original_provenance)
    VALUES ($1, gen_random_uuid(), 'phone', decode($2, 'hex'), '•••', 'sms', 'marketing', 'grant', $3, $4, $5::timestamptz, now(), $6, 'system', $7, '{}'::jsonb, $8, $9, $10)`,
    [w.tenantId, hmacHex(l.phone), o.imported ? 'imported_unverified' : 'express_written', o.imported ? 'import_csv' : 'web_form',
      o.preD12 ? new Date(Date.now() - 90 * 86_400_000).toISOString() : new Date().toISOString(), l.contactId, discId, o.imported ? 'true' : 'false',
      o.imported ? uuid() : null, o.imported ? '{}' : null]);
  return discId;
}

describe('stop signals per writer (R-ISA-31; E498, E499)', () => {
  const signals = (hmac: string | null, contactId: string | null) => suRows<{ reason: string; source_table: string }>(h.su,
    `SELECT reason, source_table FROM ai_isa_stop_signals WHERE tenant_id = $1 AND (address_hmac = decode($2, 'hex') OR contact_id = $3::uuid) ORDER BY created_at`,
    [w.tenantId, hmac ?? '00', contactId]);
  const signalJobs = () => suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ai_isa.stop_signal'`, [w.tenantId]);

  it('R-ISA-31 E498: a keyword revoke (consent_events) inserts a stop signal and an un-deduped job in the same transaction; the guard then refuses ISA_STOPPED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    const before = (await signalJobs())[0]!.n;
    await withTenantTx(w.system('provider'), (tx) => recordConsentEvent(tx, {
      id: uuid(), addressKind: 'phone', addressHmac: hmacHex(l.phone), addressHint: '•••', channel: 'sms', purpose: 'informational', eventType: 'revoke',
      level: 'none', source: 'inbound_keyword', occurredAt: Date.now() as Instant, contactId: l.contactId, actor: { kind: 'system' }, disclosureId: null,
      evidenceObjectId: null, evidenceMessageId: uuid(), evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {}, imported: false, importRecordId: null,
      originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false }), { db: h.app });
    expect(await signals(hmacHex(l.phone), null)).toEqual([{ reason: 'opted_out', source_table: 'consent_events' }]);
    expect((await signalJobs())[0]!.n).toBe(before + 1);
    // D1 is first and unchanged (purpose marketing is still granted, so D1 lets it through to the ISA branch)
    expect(await dispatchCode(x, m.messageId)).toBe('ISA_STOPPED');
  });

  it('R-ISA-31 E499: a suppression (any reason) and a person-level do-not-contact (the definer writer) each insert a stop signal', async () => {
    const l = await leadUnderCare(x);
    await withTenantTx(w.system('provider'), (tx) => sql`INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, source_ref)
      VALUES (app.tenant_id(), ${uuid()}, 'email', decode(${hmacHex(l.email)}, 'hex'), '•••', 'email', 'spam_complaint', '{}'::jsonb)`.execute(tx), { db: h.app });
    expect(await signals(hmacHex(l.email), null)).toEqual([{ reason: 'suppressed', source_table: 'suppressions' }]);
    const evId = uuid();
    await withTenantTx(w.system('provider'), async (tx) => {
      await recordConsentEvent(tx, { id: evId, addressKind: 'phone', addressHmac: hmacHex(l.phone), addressHint: '•••', channel: 'sms', purpose: 'all', eventType: 'revoke',
        level: 'none', source: 'agent_revoke', occurredAt: Date.now() as Instant, contactId: l.contactId, actor: { kind: 'system' }, disclosureId: null,
        evidenceObjectId: null, evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {}, imported: false, importRecordId: null,
        originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false });
      await sql`SELECT app.record_person_opt_out(${l.contactId}::uuid, ${evId}::uuid)`.execute(tx);
    }, { db: h.app });
    const byContact = await signals(null, l.contactId);
    expect(byContact.map((s) => s.reason)).toContain('do_not_contact');
  });

  it('R-ISA-31: a writer in another tenant\'s context never writes this tenant\'s signal (the trigger is a no-op outside its tenant)', async () => {
    const [n] = await suRows<{ n: number }>(h.su, `SELECT count(*)::int AS n FROM ai_isa_stop_signals WHERE tenant_id = $1`, [other.tenantId]);
    expect(n!.n).toBe(0);
  });

  it('R-ISA-31 E505: a person block refuses a restart (AI_ISA_PERSON_DECLINED); only the owner lifts it, after a new message from the person, with an attestation; an opt-out block never lifts', async () => {
    const l = await leadUnderCare(x, { start: false });
    const blockId = uuid();
    await q(w.system('worker'), sql`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, reason, created_at) VALUES (app.tenant_id(), ${blockId}, ${l.contactId}, 'ai_declined', now() - interval '1 hour')`);
    const p = { phonePointId: l.phonePointId, phone: l.phone, emailPointId: l.emailPointId, email: l.email };
    expect(await errOf(startCare(x, l.contactId, uuid(), p))).toBe('AI_ISA_PERSON_DECLINED');
    const lift = (msg: string) => errOf(q(x.agent.actor, sql`UPDATE ai_isa_person_blocks SET lifted_at = now(), lifted_by_user_id = ${x.agent.id},
      lift_inbound_message_id = ${msg}, lift_attestation = 'They wrote again and asked to keep chatting.' WHERE id = ${blockId}`));
    expect(await lift(uuid())).toBe('AI_ISA_BLOCK_LIFT_REFUSED');
    const inb = await inbound(x, l);
    expect(await lift(inb)).toBe('ok');
    await startCare(x, l.contactId, uuid(), p);
    const l2 = await leadUnderCare(x, { start: false });
    const b2 = uuid();
    await q(w.system('worker'), sql`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, reason, created_at) VALUES (app.tenant_id(), ${b2}, ${l2.contactId}, 'opted_out', now() - interval '1 hour')`);
    const inb2 = await inbound(x, l2);
    expect(await errOf(q(x.agent.actor, sql`UPDATE ai_isa_person_blocks SET lifted_at = now(), lifted_by_user_id = ${x.agent.id},
      lift_inbound_message_id = ${inb2}, lift_attestation = 'They wrote again and asked to keep chatting.' WHERE id = ${b2}`))).toBe('AI_ISA_BLOCK_LIFT_REFUSED');
  });
});

describe('post-handoff messages and the handoff record (R-ISA-14)', () => {
  it('R-ISA-14 E533: after a handoff only its pending confirmation may go; any other AI message refuses ISA_HANDOFF_CLOSED', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l, { category: 'ai_isa_confirmation' });
    const handoffAction = uuid();
    const pkg = { reason: 'appointment_booked', codes: ['B1'] };
    await withTenantTx(w.system('assistant'), async (tx) => {
      await sql`UPDATE ai_isa_assignments SET ended_at = now(), end_reason = 'appointment_booked', ended_by_kind = 'system', state = 'ended' WHERE id = ${l.assignmentId}`.execute(tx);
      await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key)
        VALUES (app.tenant_id(), ${handoffAction}, ${l.contactId}, 'ai_isa_handoff', 'internal', 'internal', 'proposed', ${x.agent.id}, 'AI care handed off', '{}'::jsonb, ${'ai_isa_handoff:' + l.assignmentId})`.execute(tx);
      await sql`INSERT INTO ai_isa_handoffs (tenant_id, id, assignment_id, contact_id, reason, assistant_action_id, package, package_sha256, pending_message_id,
          confirmation_status, sla_class, sla_due_at, recipient_user_id)
        VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, 'appointment_booked', ${handoffAction}, ${JSON.stringify(pkg)}::jsonb,
          encode(sha256(convert_to(${JSON.stringify(pkg)}::jsonb::text, 'UTF8')), 'hex'), ${m.messageId}, 'queued', 'critical', now() + interval '15 minutes', ${x.agent.id})`.execute(tx);
    }, { db: h.app });
    // a second (non-pending) AI message after the handoff is refused
    const stray = await queueAi(x, l, { category: 'ai_isa_holding_line' });
    expect(await dispatchCode(x, stray.messageId)).toBe('ISA_HANDOFF_CLOSED');
    await h.su.query(`UPDATE assistant_actions SET status = 'superseded' WHERE id = $1`, [stray.actionId]);
    await h.su.query(`UPDATE assistant_actions SET status = 'proposed' WHERE id = $1`, [m.actionId]);
    expect(await dispatchCode(x, m.messageId)).toBe('ok');
  });

  it('R-ISA-14: a handoff package is frozen; a user only acknowledges; "Got it" never clears the deadline', async () => {
    const [hd] = await suRows<{ id: string }>(h.su, `SELECT id FROM ai_isa_handoffs WHERE tenant_id = $1 LIMIT 1`, [w.tenantId]);
    expect(await errOf(q(x.agent.actor, sql`UPDATE ai_isa_handoffs SET sla_met_at = now() WHERE id = ${hd!.id}`))).toBe('AI_ISA_HANDOFF_ACK_ONLY');
    expect(await errOf(q(w.system('worker'), sql`UPDATE ai_isa_handoffs SET package = '{"x":1}'::jsonb WHERE id = ${hd!.id}`))).toMatch(/AI_ISA_HANDOFF_FROZEN|package_sha256/);
    expect(await errOf(q(x.agent.actor, sql`UPDATE ai_isa_handoffs SET acknowledged_at = now(), acknowledged_by_user_id = ${x.agent.id} WHERE id = ${hd!.id}`))).toBe('ok');
  });
});

describe('erasure and the retention purge of a person who was under AI care (isa-2-1; R-DATA-4, R-DATA-5, R-DATA-7, R-ISA-15)', () => {
  const erase = (id: string) => errOf(q(w.owner.actor, sql`SELECT app.erase_contact(${id}::uuid, ${uuid()}::uuid, 'PRIVACY_REQUEST')`));
  const sweep = () => withPreTenant(async (tx) => (await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(now()) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
  const control = (l: Lead, kind: string) => q(w.system('assistant'), sql`INSERT INTO ai_isa_controls (tenant_id, id, assignment_id, contact_id, kind, by_kind, reason)
    VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, ${kind}, 'system', 'erasure_test')`);
  const left = async (contactId: string) => {
    const [r] = await suRows<Record<string, number>>(h.su, `SELECT
      (SELECT count(*) FROM contacts WHERE id = $1)::int AS contacts,
      (SELECT count(*) FROM ai_isa_assignments WHERE contact_id = $1)::int AS assignments,
      (SELECT count(*) FROM ai_isa_controls WHERE contact_id = $1)::int AS controls,
      (SELECT count(*) FROM ai_isa_turns WHERE contact_id = $1)::int AS turns,
      (SELECT count(*) FROM ai_isa_shared_facts WHERE contact_id = $1)::int AS facts,
      (SELECT count(*) FROM ai_isa_handoffs WHERE contact_id = $1)::int AS handoffs,
      (SELECT count(*) FROM messages WHERE contact_id = $1)::int AS messages,
      (SELECT count(*) FROM assistant_actions WHERE contact_id = $1)::int AS actions,
      (SELECT count(*) FROM ai_isa_stop_signals WHERE contact_id = $1)::int AS stop_signals`, [contactId]);
    return r!;
  };
  /** A person whose care ran its whole course: controls, a sent AI reply with a sent fact, a handoff whose confirmation
   *  is queued (its mandate action still proposed), the assignment ended, and a stop signal naming them. */
  async function caredFor(): Promise<Lead> {
    const l = await leadUnderCare(x);
    await control(l, 'system_pause');
    await control(l, 'resume');
    await inbound(x, l);
    const sent = await queueAi(x, l);
    await markSent(x, sent.messageId);
    await q(w.system('assistant'), sql`INSERT INTO ai_isa_shared_facts (tenant_id, id, assignment_id, contact_id, turn_id, message_id, status, fact_kind, line_sha256)
      VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, ${sent.turnId}, ${sent.messageId}, 'sent', 'listing_active', ${sha('line')})`);
    await h.su.query(`UPDATE ai_isa_turns SET status = 'sent' WHERE id = $1`, [sent.turnId]);
    const confirmation = await queueAi(x, l, { category: 'ai_isa_confirmation' });
    const handoffAction = uuid();
    const pkg = { reason: 'appointment_booked', codes: ['B1'] };
    await withTenantTx(w.system('assistant'), async (tx) => {
      await sql`UPDATE ai_isa_assignments SET ended_at = now(), end_reason = 'appointment_booked', ended_by_kind = 'system', state = 'ended' WHERE id = ${l.assignmentId}`.execute(tx);
      await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key)
        VALUES (app.tenant_id(), ${handoffAction}, ${l.contactId}, 'ai_isa_handoff', 'internal', 'internal', 'proposed', ${x.agent.id}, 'AI care handed off', '{}'::jsonb, ${'ai_isa_handoff:' + l.assignmentId})`.execute(tx);
      await sql`INSERT INTO ai_isa_handoffs (tenant_id, id, assignment_id, contact_id, reason, assistant_action_id, package, package_sha256, pending_message_id,
          confirmation_status, sla_class, sla_due_at, recipient_user_id)
        VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, 'appointment_booked', ${handoffAction}, ${JSON.stringify(pkg)}::jsonb,
          encode(sha256(convert_to(${JSON.stringify(pkg)}::jsonb::text, 'UTF8')), 'hex'), ${confirmation.messageId}, 'queued', 'critical', now() + interval '15 minutes', ${x.agent.id})`.execute(tx);
      await sql`INSERT INTO ai_isa_stop_signals (tenant_id, contact_id, reason, source_table) VALUES (app.tenant_id(), ${l.contactId}, 'owner_change', 'contacts')`.execute(tx);
    }, { db: h.app });
    await control(l, 'system_end');
    const before = await left(l.contactId);
    expect(before).toMatchObject({ contacts: 1, assignments: 1, controls: 3, turns: 2, facts: 1, handoffs: 1, stop_signals: 1 });
    return l;
  }

  it('app.erase_contact erases a person with an ended assignment, its controls, a sent turn and fact, a handoff and a proposed confirmation; the stop signal stays as opt-out evidence', async () => {
    const l = await caredFor();
    expect(await erase(l.contactId)).toBe('ok');
    expect(await left(l.contactId)).toEqual({ contacts: 0, assignments: 0, controls: 0, turns: 0, facts: 0, handoffs: 0, messages: 0, actions: 0, stop_signals: 1 });
  });

  it('app.erase_contact erases a person whose care is still live, with a control row and a queued AI message bound to its turn', async () => {
    const l = await leadUnderCare(x);
    await control(l, 'system_pause');
    await inbound(x, l);
    await queueAi(x, l);
    expect(await erase(l.contactId)).toBe('ok');
    expect(await left(l.contactId)).toMatchObject({ contacts: 0, assignments: 0, controls: 0, turns: 0, messages: 0 });
  });

  it('the retention sweep purges a soft-deleted person who was under AI care, and the other due person in the same run', async () => {
    const l = await caredFor();
    const plain = await selfCreated(h.app, w, x.agent, 'No Care Person');
    for (const id of [l.contactId, plain]) {
      expect((await cmd(h.app, w.owner.actor, id as never, { kind: 'soft_delete' })).outcome.ok).toBe(true);
      await suFixture(h.su, "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", [id]);
    }
    const r = await sweep();
    expect(r.contacts_purged).toBeGreaterThanOrEqual(2);
    expect(await left(l.contactId)).toMatchObject({ contacts: 0, assignments: 0, controls: 0, turns: 0, facts: 0, handoffs: 0, messages: 0, stop_signals: 1 });
    expect((await left(plain)).contacts).toBe(0);
  });

  it('outside erasure the ledgers stay frozen: a control row is never deleted, a bound turn or a sent fact never loses its message', async () => {
    const l = await leadUnderCare(x);
    await control(l, 'system_pause');
    await inbound(x, l);
    const m = await queueAi(x, l, { channel: 'email', facts: 'listing_active' });
    await h.su.query(`UPDATE ai_isa_shared_facts SET status = 'sent' WHERE message_id = $1`, [m.messageId]);
    expect(await errOf(h.su.query(`DELETE FROM ai_isa_controls WHERE contact_id = $1`, [l.contactId]))).toBe('AI_ISA_LEDGER_APPEND_ONLY');
    expect(await errOf(q(w.system('assistant'), sql`UPDATE ai_isa_turns SET message_id = NULL WHERE id = ${m.turnId}`))).toBe('AI_ISA_TURN_PLAN_FROZEN');
    expect(await errOf(q(w.system('assistant'), sql`UPDATE ai_isa_shared_facts SET message_id = NULL WHERE message_id = ${m.messageId}`))).toBe('AI_ISA_FACT_FROZEN');
  });
});

describe('appointments: the booking lock before the row, and no assistant overlap (R-ISA-13; E532)', () => {
  const appt = (as: Actor, o: { kind?: 'user' | 'assistant'; startsMin: number; contactId: string }) => q(as, sql`INSERT INTO appointments (tenant_id, id, contact_id, user_id,
      set_by_user_id, kind, starts_at, ends_at, status, created_by_kind)
    VALUES (app.tenant_id(), ${uuid()}, ${o.contactId}, ${x.agent.id}, ${o.kind === 'assistant' ? null : x.agent.id}, 'buyer_consult',
      date_trunc('hour', now()) + interval '3 days' + make_interval(mins => ${o.startsMin}),
      date_trunc('hour', now()) + interval '3 days' + make_interval(mins => ${o.startsMin + 30}), 'scheduled', ${o.kind ?? 'user'})`);
  const holdBookLock = async () => {
    const c = new pg.Client({ connectionString: h.db.appUserUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT pg_advisory_xact_lock(hashtextextended('calendar.book:' || $1 || ':' || $2, 0))`, [w.tenantId, x.agent.id]);
    return c;
  };

  it('R-ISA-13 E532: a human appointment insert waits while the booking job holds the organizer\'s lock (order 1)', async () => {
    const l = await leadUnderCare(x);
    const c = await holdBookLock();
    let done = false;
    const p = appt(x.agent.actor, { startsMin: 0, contactId: l.contactId }).then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await c.query('COMMIT');
    await c.end();
    await p;
    expect(done).toBe(true);
  });

  it('R-ISA-13 E532: the booking job waits while a human insert is in flight (order 2), then the assistant overlap is refused', async () => {
    const l = await leadUnderCare(x);
    const c = new pg.Client({ connectionString: h.db.appUserUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.actor_kind', 'user', true), set_config('app.user_id', $2, true),
      set_config('app.principal_type', 'staff', true)`, [w.tenantId, x.agent.id]);
    await c.query(`INSERT INTO appointments (tenant_id, id, contact_id, user_id, set_by_user_id, kind, starts_at, ends_at, status, created_by_kind)
      VALUES ($1, gen_random_uuid(), $2, $3, $3, 'consult', date_trunc('hour', now()) + interval '4 days', date_trunc('hour', now()) + interval '4 days 30 minutes', 'scheduled', 'user')`,
      [w.tenantId, l.contactId, x.agent.id]);
    let done = false;
    const p = errOf(appt(w.system('assistant'), { kind: 'assistant', startsMin: 24 * 60 + 10, contactId: l.contactId })).then((r) => { done = true; return r; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await c.query('COMMIT');
    await c.end();
    expect(await p).toBe('APPOINTMENT_OVERLAP');
  });

  it('R-ISA-13 E532: a human may still overlap their own calendar', async () => {
    const l = await leadUnderCare(x);
    await appt(x.agent.actor, { startsMin: 600, contactId: l.contactId });
    expect(await errOf(appt(x.agent.actor, { startsMin: 610, contactId: l.contactId }))).toBe('ok');
  });
});

describe('merge (R-ISA-16; E526)', () => {
  it('R-ISA-16 E526: a merge with care live on the loser and an AI message queued: the message is withdrawn, both records get a merged stop signal, the guard refuses it', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    const survivor = await selfCreated(h.app, w, x.agent, 'Survivor Lead');
    const r = await cmd(h.app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: l.contactId as never, ownerChoice: null });
    expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
    await drainFollowups(h, w);
    const sig = await suRows<{ reason: string; contact_id: string }>(h.su, `SELECT reason, contact_id FROM ai_isa_stop_signals WHERE tenant_id = $1 AND reason = 'merged'`, [w.tenantId]);
    expect(sig.map((s) => s.contact_id)).toContain(l.contactId);
    const [a] = await suRows<{ status: string }>(h.su, `SELECT status FROM assistant_actions WHERE id = $1`, [m.actionId]);
    expect(a!.status).toBe('invalidated');
    expect(await dispatchCode(x, m.messageId)).toMatch(/ASSISTANT_ACTION_WITHDRAWN|ISA_STOPPED|RECIPIENT/);
  });
});

describe('a merged-away record under the survivor (b12 review db-isa-merge-1, db-isa-merge-2; R-ISA-16, R-ISA-22, R-ISA-31; E505, E526)', () => {
  const pointsOf = async (contactId: string) => (await suRows<{ phone: string; email: string; pp: string; ep: string }>(h.su, `SELECT
      (SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND removed_at IS NULL ORDER BY created_at LIMIT 1) AS phone,
      (SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'email' AND removed_at IS NULL ORDER BY created_at LIMIT 1) AS email,
      (SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'phone' AND removed_at IS NULL ORDER BY created_at LIMIT 1) AS pp,
      (SELECT id FROM contact_points WHERE contact_id = $1 AND kind = 'email' AND removed_at IS NULL ORDER BY created_at LIMIT 1) AS ep`, [contactId]))[0]!;
  const mergeInto = async (survivor: string, loser: string) => {
    const r = await cmd(h.app, w.owner.actor, survivor as never, { kind: 'merge', survivorId: survivor as never, loserId: loser as never, ownerChoice: null });
    expect(r.outcome.ok, JSON.stringify(r.outcome)).toBe(true);
    await drainFollowups(h, w);
  };

  it('R-ISA-31 R-ISA-16 E505 E526: a person block on a merged-away record refuses a restart on the agent-owned survivor (AI_ISA_PERSON_DECLINED) and an AI message of an assignment that missed it (ISA_STOPPED); the survivor\'s owner lifts it', async () => {
    const l = await leadUnderCare(x);
    // the person declines AI care on record L: the system writes the block and ends care
    await q(w.system('assistant'), sql`INSERT INTO ai_isa_person_blocks (tenant_id, id, contact_id, assignment_id, reason)
      VALUES (app.tenant_id(), ${uuid()}, ${l.contactId}, ${l.assignmentId}, 'ai_declined')`);
    await q(w.system('assistant'), sql`UPDATE ai_isa_assignments SET ended_at = now(), end_reason = 'escalated', ended_by_kind = 'system', state = 'ended' WHERE id = ${l.assignmentId}`);
    // a second record of the same person, owned by the same agent, survives a merge (the loser is closed, unowned)
    const s = await selfCreated(h.app, w, x.agent, 'Survivor Block Lead');
    await mergeInto(s, l.contactId);
    expect((await q(x.agent.actor, sql`SELECT id FROM contacts WHERE id = ${l.contactId}::uuid`)).length).toBe(0);
    const pts = await pointsOf(s);
    const p = { phonePointId: pts.pp, phone: pts.phone, emailPointId: pts.ep, email: pts.email };
    // the start check sees the whole person, past the agent's RLS
    expect(await errOf(startCare(x, s, uuid(), p))).toBe('AI_ISA_PERSON_DECLINED');
    // the agent reads the block through the survivor (the root branch)
    const seen = await q<{ id: string }>(x.agent.actor, sql`SELECT id FROM ai_isa_person_blocks WHERE contact_id = ${l.contactId}::uuid AND lifted_at IS NULL`);
    expect(seen.length).toBe(1);
    // an assignment the start check missed (written past the guard): its AI message is refused at dispatch
    const asg = uuid();
    const [seq] = await suRows<{ seq: string }>(h.su, 'SELECT ownership_period_seq AS seq FROM contacts WHERE id = $1', [s]);
    const bound = { sms: { point_id: pts.pp, hmac: hmacHex(pts.phone) }, email: { point_id: pts.ep, hmac: hmacHex(pts.email) } };
    const c = await h.su.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query(`INSERT INTO ai_isa_assignments (tenant_id, id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq, bound_points, side, started_by_user_id)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'buyer', $4)`, [w.tenantId, asg, s, x.agent.id, x.optinId, x.versionId, seq!.seq, JSON.stringify(bound)]);
    } finally {
      await c.query('SET session_replication_role = origin');
      c.release();
    }
    const [cv] = await suRows<{ id: string }>(h.su, 'SELECT id FROM conversations WHERE contact_id = $1 LIMIT 1', [s]);
    await h.su.query(`UPDATE contacts SET timezone = $2, timezone_source = 'explicit' WHERE id = $1`, [s, l.zone]);
    const sl: Lead = { contactId: s, conversationId: cv!.id, phone: pts.phone, email: pts.email, phonePointId: pts.pp, emailPointId: pts.ep, assignmentId: asg, zone: l.zone };
    const inb = await inbound(x, sl);
    const m = await queueAi(x, sl);
    expect(await dispatchCode(x, m.messageId)).toBe('ISA_STOPPED');
    await h.su.query(`UPDATE ai_isa_assignments SET ended_at = now(), end_reason = 'opted_out', ended_by_kind = 'system', state = 'ended' WHERE id = $1`, [asg]);
    // the survivor's owner lifts the block, after a new message from the person (on the survivor), with an attestation
    const lifted = await errOf(q(x.agent.actor, sql`UPDATE ai_isa_person_blocks SET lifted_at = now(), lifted_by_user_id = ${x.agent.id},
      lift_inbound_message_id = ${inb}, lift_attestation = 'They wrote again and asked to keep chatting.' WHERE contact_id = ${l.contactId}::uuid AND lifted_at IS NULL`));
    expect(lifted).toBe('ok');
    expect(await errOf(startCare(x, s, uuid(), p))).toBe('ok');
  });

  it('R-ISA-22 R-ISA-16 E526: the AI ISA rows of a merged-away record are read by the survivor\'s agent and Team Lead, and its handoff is acknowledged by its recipient; another agent sees none', async () => {
    const l = await leadUnderCare(x);
    await inbound(x, l);
    const m = await queueAi(x, l);
    await q(w.system('assistant'), sql`INSERT INTO ai_isa_controls (tenant_id, id, assignment_id, contact_id, kind, by_kind, reason)
      VALUES (app.tenant_id(), ${uuid()}, ${l.assignmentId}, ${l.contactId}, 'continue', 'system', 'start')`);
    const s = await selfCreated(h.app, w, x.agent, 'Survivor Lead Visible');
    await mergeInto(s, l.contactId);
    // what the stop-signal job writes when it ends the loser's care (as the system), before b12 review F1 moved it
    const actionId = uuid();
    const handoffId = uuid();
    const pkg = JSON.stringify({ v: 1, reason: 'merged' });
    await q(w.system('assistant'), sql`UPDATE ai_isa_assignments SET ended_at = now(), end_reason = 'merged', ended_by_kind = 'system', state = 'ended' WHERE id = ${l.assignmentId}`);
    await q(w.system('assistant'), sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key)
      VALUES (app.tenant_id(), ${actionId}, ${l.contactId}, 'ai_isa_handoff', 'internal', 'internal', 'proposed', ${x.agent.id}, 'AI care handed back: merged', '{}'::jsonb, ${'ai_isa_handoff:' + l.assignmentId})`);
    await q(w.system('assistant'), sql`INSERT INTO ai_isa_handoffs (tenant_id, id, assignment_id, contact_id, reason, assistant_action_id, package, package_sha256, sla_class, sla_due_at, recipient_user_id)
      VALUES (app.tenant_id(), ${handoffId}, ${l.assignmentId}, ${l.contactId}, 'merged', ${actionId}, ${pkg}::jsonb, encode(sha256(convert_to(${pkg}::jsonb::text, 'UTF8')), 'hex'), 'normal', now() + interval '1 hour', ${x.agent.id})`);
    const see = async (a: Actor, t: string, col = 'assignment_id') => (await q(a, sql`SELECT 1 FROM ${sql.table(t)} WHERE ${sql.ref(col)} = ${t === 'ai_isa_handoffs' ? handoffId : l.assignmentId}::uuid`)).length;
    for (const a of [x.agent.actor, w.tl!.actor]) {
      expect(await see(a, 'ai_isa_assignments', 'id')).toBe(1);
      expect(await see(a, 'ai_isa_controls')).toBeGreaterThan(0);
      expect(await see(a, 'ai_isa_turns')).toBeGreaterThan(0);
      expect(await see(a, 'ai_isa_handoffs', 'id')).toBe(1);
    }
    expect((await q(x.agent.actor, sql`SELECT 1 FROM ai_isa_stop_signals WHERE contact_id = ${l.contactId}::uuid`)).length).toBeGreaterThan(0);
    // another agent of the tenant sees none of it
    const other = w.agents.find((a) => a.id !== x.agent.id)!;
    expect(await see(other.actor, 'ai_isa_assignments', 'id')).toBe(0);
    expect(await see(other.actor, 'ai_isa_handoffs', 'id')).toBe(0);
    const ack = await q(x.agent.actor, sql`UPDATE ai_isa_handoffs SET acknowledged_at = now(), acknowledged_by_user_id = app.user_id() WHERE id = ${handoffId}::uuid RETURNING id`);
    expect(ack.length).toBe(1);
    void m;
  });
});
