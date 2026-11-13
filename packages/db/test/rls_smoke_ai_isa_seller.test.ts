// RLS and guard smoke of the AI ISA seller migration (lane ISA-3; owner decision D12 PROPOSED; docs/AI_ISA.md §8.2-§8.4).
// Runs rls_smoke_ai_isa_seller.sql (schema shape and the pack) through runPsqlScript, then proves the per-role
// behaviour through withTenantTx as app_user: the owner confirms as themselves, the system never confirms, any other
// user only clears, an address edit or delete clears the confirmation as the editor, support writes nothing, another
// tenant sees nothing, and a sold fact never sits on an SMS. No test names the migration's file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Actor } from '@realty/core/foundation';
import { sql } from 'kysely';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPsqlScript } from '../src/testing/index.js';
import { withTenantTx } from '../src/tenantTx.js';
import { hmacHex, type IsaWorld, type Lead, leadUnderCare, queueAi, setupIsaWorld } from './rls_smoke_ai_isa.fixture.js';
import { createHarness, createWorld, type Harness, suRows, uuid, type World } from './world.js';

const SMOKE_SQL = readFileSync(fileURLToPath(new URL('./rls_smoke_ai_isa_seller.sql', import.meta.url)), 'utf8');

let h: Harness;
let w: World;
let other: World;
let x: IsaWorld;
let notices: string[] = [];
const support = (): Actor => ({ kind: 'support', userId: w.owner.id, tenantId: w.tenantId, grantId: 'g' }) as Actor;

beforeAll(async () => {
  h = await createHarness(6);
  notices = (await runPsqlScript(h.db.ownerUrl, SMOKE_SQL)).notices;
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  other = await createWorld(h.app, { agents: 1 });
  x = await setupIsaWorld(h, w);
});
afterAll(async () => {
  await h?.close();
});

const run = <T extends pg.QueryResultRow>(actor: Actor, text: ReturnType<typeof sql>) =>
  withTenantTx(actor, async (tx) => (await text.execute(tx)).rows as T[], { db: h.app });
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    const m = /([A-Z][A-Z_]{3,}):/.exec((e as Error).message);
    return m ? m[1]! : (e as Error).message;
  }
};

interface SellerLead extends Lead {
  addressId: string;
}

/** A seller-side lead under care with a property address and an empty watch row (inserted by the system). */
async function sellerLead(): Promise<SellerLead> {
  const l = await leadUnderCare(x, { start: false });
  const [c] = await suRows<{ seq: string }>(h.su, 'SELECT ownership_period_seq AS seq FROM contacts WHERE id = $1', [l.contactId]);
  const bound = { sms: { point_id: l.phonePointId, hmac: hmacHex(l.phone) }, email: { point_id: l.emailPointId, hmac: hmacHex(l.email) } };
  const addressId = uuid();
  await withTenantTx(x.agent.actor, async (tx) => {
    await sql`INSERT INTO ai_isa_assignments (tenant_id, id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq, bound_points,
                side, started_by_user_id)
              VALUES (app.tenant_id(), ${l.assignmentId}, ${l.contactId}, ${x.agent.id}, ${x.optinId}, ${x.versionId}, ${c!.seq}, ${JSON.stringify(bound)}::jsonb,
                'seller', ${x.agent.id})`.execute(tx);
    await sql`INSERT INTO contact_addresses (tenant_id, id, contact_id, kind, line1, city, region, postal_code)
              VALUES (app.tenant_id(), ${addressId}, ${l.contactId}, 'property', '12 Test Lane', 'Testville', 'SC', '29900')`.execute(tx);
  }, { db: h.app });
  await run(w.system('assistant'), sql`INSERT INTO ai_isa_seller_watch (tenant_id, assignment_id, contact_id, contact_address_id)
    VALUES (app.tenant_id(), ${l.assignmentId}, ${l.contactId}, ${addressId})`);
  return { ...l, addressId };
}

const confirmSql = (l: SellerLead, by: string) => sql`UPDATE ai_isa_seller_watch
  SET subject_address_key = 'key-1', subject_connection_id = ${uuid()}, subject_record_listing_id = ${uuid()}, subject_record_date = now(),
      subject_facts = '{"type":"single_family","beds":3,"baths_x10":20,"sqft":1800}'::jsonb, subject_confirmed_by_user_id = ${by}, subject_confirmed_at = now()
  WHERE tenant_id = app.tenant_id() AND assignment_id = ${l.assignmentId}`;

const watchOf = async (l: SellerLead) =>
  (await suRows<{ subject_confirmed_at: Date | null; subject_confirmed_by_user_id: string | null; subject_cleared_reason: string | null; contact_address_id: string | null; near_match_dismissed: string[] }>(
    h.su, 'SELECT subject_confirmed_at, subject_confirmed_by_user_id, subject_cleared_reason, contact_address_id, near_match_dismissed FROM ai_isa_seller_watch WHERE assignment_id = $1', [l.assignmentId]))[0]!;

describe('rls_smoke_ai_isa_seller.sql (R-ISA-18, R-ISA-21, R-TEN-1, E534)', () => {
  it('passes every schema and pack check', () => {
    expect(notices.filter((n) => n.startsWith('FAIL'))).toEqual([]);
    expect(notices.filter((n) => n.startsWith('PASS')).length).toBeGreaterThanOrEqual(6);
    expect(notices.at(-1)).toBe('PASS  ALL AI ISA SELLER SMOKE CHECKS PASSED');
  });
  it('can only fail through pg_temp.fail', () => {
    expect(SMOKE_SQL.match(/RAISE EXCEPTION 'FAIL/g)).toHaveLength(1);
  });
});

describe('ai_isa_seller_watch per role (R-ISA-18, R-ISA-26, E536, E538)', () => {
  it('R-ISA-18 E536: the owner confirms the subject as themselves, at the database clock; the system never confirms', async () => {
    const l = await sellerLead();
    expect(await codeOf(run(w.system('assistant'), confirmSql(l, x.agent.id)))).toBe('ISA_SUBJECT_SYSTEM_NEVER_CONFIRMS');
    expect(await codeOf(run(x.agent.actor, confirmSql(l, w.owner.id)))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(x.agent.actor, confirmSql(l, x.agent.id)))).toBe('ok');
    const row = await watchOf(l);
    expect(row.subject_confirmed_by_user_id).toBe(x.agent.id);
    expect(row.subject_confirmed_at).not.toBeNull();
  });

  it('R-ISA-18 E538: a Team Lead (not the owner) cannot confirm, dismiss a near match or resume comps, but may clear the subject', async () => {
    const l = await sellerLead();
    const tl = w.tl!.actor;
    expect(await codeOf(run(tl, confirmSql(l, w.tl!.id)))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(tl, sql`UPDATE ai_isa_seller_watch SET near_match_dismissed = ARRAY[${uuid()}]::uuid[] WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(tl, sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_reason = 'owner_resume', comps_resumed_by_user_id = ${w.tl!.id} WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(tl, sql`UPDATE ai_isa_seller_watch SET last_snapshot = '{"a":1}'::jsonb WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    await run(x.agent.actor, confirmSql(l, x.agent.id));
    // a collaborator's non-clear: changing the confirmed facts without clearing is refused
    expect(await codeOf(run(tl, sql`UPDATE ai_isa_seller_watch SET subject_facts = '{"beds":9}'::jsonb WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(tl, sql`UPDATE ai_isa_seller_watch SET subject_address_key = NULL, subject_connection_id = NULL, subject_record_listing_id = NULL,
      subject_record_date = NULL, subject_facts = NULL, subject_confirmed_by_user_id = NULL, subject_confirmed_at = NULL WHERE assignment_id = ${l.assignmentId}`))).toBe('ok');
    expect((await watchOf(l)).subject_cleared_reason).toBe('address_changed');
  });

  it('R-ISA-15 E538: the owner dismisses a near match and resumes comps; the system resumes only after a CMA and never with the owner reason', async () => {
    const l = await sellerLead();
    const id = uuid();
    expect(await codeOf(run(x.agent.actor, sql`UPDATE ai_isa_seller_watch SET near_match_dismissed = ARRAY[${id}]::uuid[] WHERE assignment_id = ${l.assignmentId}`))).toBe('ok');
    expect((await watchOf(l)).near_match_dismissed).toEqual([id]);
    expect(await codeOf(run(w.system('assistant'), sql`UPDATE ai_isa_seller_watch SET comps_suspended_at = now() WHERE assignment_id = ${l.assignmentId}`))).toBe('ok');
    expect(await codeOf(run(w.system('assistant'), sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_reason = 'owner_resume' WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    expect(await codeOf(run(w.system('assistant'), sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_reason = 'cma_prepared', comps_resumed_by_user_id = ${x.agent.id} WHERE assignment_id = ${l.assignmentId}`))).toBe('ok');
    expect(await codeOf(run(x.agent.actor, sql`UPDATE ai_isa_seller_watch SET comps_resumed_at = now(), comps_resumed_reason = 'owner_resume', comps_resumed_by_user_id = ${x.agent.id} WHERE assignment_id = ${l.assignmentId}`))).toBe('ok');
    expect(await codeOf(run(x.agent.actor, sql`UPDATE ai_isa_seller_watch SET comps_suspended_at = NULL WHERE assignment_id = ${l.assignmentId}`))).toBe('ISA_SUBJECT_OWNER_ONLY');
  });

  it('E538: an address edit by someone else clears the confirmation as the editor (the trigger), and a delete clears it (the foreign key path)', async () => {
    const l = await sellerLead();
    await run(x.agent.actor, confirmSql(l, x.agent.id));
    await run(w.tl!.actor, sql`UPDATE contact_addresses SET line1 = '14 Test Lane' WHERE tenant_id = app.tenant_id() AND id = ${l.addressId}`);
    let row = await watchOf(l);
    expect([row.subject_confirmed_at, row.subject_cleared_reason]).toEqual([null, 'address_changed']);
    // an unrelated column change (updated_at only) does not clear a new confirmation
    await run(x.agent.actor, confirmSql(l, x.agent.id));
    await run(x.agent.actor, sql`UPDATE contact_addresses SET updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${l.addressId}`);
    expect((await watchOf(l)).subject_confirmed_at).not.toBeNull();
    await run(x.agent.actor, sql`DELETE FROM contact_addresses WHERE tenant_id = app.tenant_id() AND id = ${l.addressId}`);
    row = await watchOf(l);
    expect([row.subject_confirmed_at, row.subject_cleared_reason, row.contact_address_id]).toEqual([null, 'address_deleted', null]);
  });

  it('R-PERM-11: support writes nothing; R-TEN-1: another tenant reads and writes nothing', async () => {
    const l = await sellerLead();
    expect(await codeOf(run(support(), sql`UPDATE ai_isa_seller_watch SET last_run_at = now() WHERE assignment_id = ${l.assignmentId}`))).not.toBe('ok');
    expect(await codeOf(run(support(), sql`INSERT INTO ai_isa_seller_watch (tenant_id, assignment_id, contact_id) VALUES (app.tenant_id(), ${uuid()}, ${l.contactId})`))).not.toBe('ok');
    const foreign = other.agents[0]!.actor;
    expect(await run(foreign, sql`SELECT assignment_id FROM ai_isa_seller_watch WHERE assignment_id = ${l.assignmentId}`)).toEqual([]);
    expect(await run(other.system('assistant'), sql`UPDATE ai_isa_seller_watch SET last_run_at = now() WHERE assignment_id = ${l.assignmentId} RETURNING assignment_id`)).toEqual([]);
    expect(await codeOf(run(x.agent.actor, sql`DELETE FROM ai_isa_seller_watch WHERE assignment_id = ${l.assignmentId}`))).toMatch(/permission denied/);
  });

  it('R-ISA-18 E536: a watch starts empty, belongs to a seller-side assignment, and only its owner or the system inserts it', async () => {
    const l = await leadUnderCare(x); // a buyer-side assignment
    expect(await codeOf(run(w.system('assistant'), sql`INSERT INTO ai_isa_seller_watch (tenant_id, assignment_id, contact_id) VALUES (app.tenant_id(), ${l.assignmentId}, ${l.contactId})`))).toBe('ISA_SUBJECT_OWNER_ONLY');
    const s = await sellerLead();
    expect(await codeOf(run(w.tl!.actor, sql`INSERT INTO ai_isa_seller_watch (tenant_id, assignment_id, contact_id) VALUES (app.tenant_id(), ${s.assignmentId}, ${s.contactId}) ON CONFLICT DO NOTHING`))).toMatch(/row-level security/);
  });

  it('R-ISA-18 E536: a sold_comp_set fact is never on an SMS (ISA_SELLER_FACT_EMAIL_ONLY); by email it is accepted', async () => {
    const l = await sellerLead();
    expect(await codeOf(queueAi(x, l, { channel: 'sms', facts: 'sold_comp_set' }))).toBe('ISA_SELLER_FACT_EMAIL_ONLY');
    expect(await codeOf(queueAi(x, l, { channel: 'email', facts: 'sold_comp_set' }))).toBe('ok');
    const l2 = await sellerLead();
    expect(await codeOf(queueAi(x, l2, { channel: 'sms', facts: 'listing_active' }))).toBe('ok');
  });
});
