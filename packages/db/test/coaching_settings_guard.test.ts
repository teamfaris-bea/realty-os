// Who may change the call-scoring settings, at the database (tenant_settings_p23_guard as amended by the coaching
// migration 0059; owner decision 2026-11-11, the Gmail sync rule): only the Owner turns call reviews on (and only
// once platform:coaching is cleared, R-INT-6), sets Team Lead visibility and the checklist; an Admin may only turn
// call reviews off, alone in its UPDATE (E283). Team Leads, agents and support change nothing, as before. Every
// write is app_user under RLS; the superuser pool only sets the platform pack's review (platform data) and reads back.
import type { Actor, SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { type RawBuilder, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { createHarness, createWorld, type Harness, type Member, PH, suRows, uuid, type World } from './world.js';

let h: Harness;
let w: World;
let admin: Member;
let support: SupportActor;

beforeAll(async () => {
  h = await createHarness(4);
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  // the Owner makes one member an Admin (the real path: an Owner role change)
  const a = w.agents[1]!;
  await withTenantTx(w.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${a.id}`.execute(tx), { db: h.app });
  admin = { id: a.id, role: 'admin', actor: { ...a.actor, role: 'admin' } };
  // a platform support person with a live read-only grant from the Owner
  const supportUserId = uuid() as UserId;
  await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
  const grantId = uuid();
  await withTenantTx(
    w.owner.actor,
    (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
                VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'ticket', now() + interval '1 hour')`.execute(tx),
    { db: h.app },
  );
  support = { kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId };
}, 120_000);
afterAll(async () => {
  await h?.close();
});

interface Row {
  scoring: boolean;
  tl: boolean;
  off: string[];
}

const row = async (): Promise<Row> =>
  (await suRows<Row>(h.su, 'SELECT call_scoring_enabled AS scoring, tl_sees_call_scores AS tl, coaching_rubric_disabled AS "off" FROM tenant_settings WHERE tenant_id = $1', [w.tenantId]))[0]!;

/** counsel's review of the platform:coaching pack (platform data, recorded by the platform) */
const packCleared = (cleared: boolean) => h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${cleared ? 'now()' : 'NULL'} WHERE key = 'platform:coaching'`);

/** One UPDATE as `actor` under RLS; resolves to the number of rows it changed. */
const update = (actor: Actor, set: RawBuilder<unknown>) =>
  withTenantTx(actor, async (tx) => Number((await sql`UPDATE tenant_settings SET ${set} WHERE tenant_id = app.tenant_id()`.execute(tx)).numAffectedRows ?? 0), { db: h.app });

/** The Owner sets the starting state through the guard (the pack cleared while doing so). */
async function ownerSets(v: Row): Promise<void> {
  await packCleared(true);
  expect(await update(w.owner.actor, sql`call_scoring_enabled = ${v.scoring}, tl_sees_call_scores = ${v.tl}, coaching_rubric_disabled = ${v.off}::text[]`)).toBe(1);
  expect(await row()).toEqual(v);
}

describe('an Admin turns call reviews off, and nothing else (E283, owner decision 2026-11-11)', () => {
  it('E283 R-COACH-1: an Admin switches call_scoring_enabled from true to false; Team Lead visibility and the checklist stay as the Owner set them', async () => {
    await ownerSets({ scoring: true, tl: true, off: ['recapped_call'] });
    expect(await update(admin.actor, sql`call_scoring_enabled = false`)).toBe(1);
    expect(await row()).toEqual({ scoring: false, tl: true, off: ['recapped_call'] });
    // already off: writing off again changes nothing and is not refused
    expect(await update(admin.actor, sql`call_scoring_enabled = false`)).toBe(1);
    expect((await row()).scoring).toBe(false);
  });

  it('E283 R-INT-6: turning call reviews off never waits for counsel: an Admin turns a paused switch off while platform:coaching is not cleared', async () => {
    await ownerSets({ scoring: true, tl: false, off: [] });
    await packCleared(false);
    expect(await update(admin.actor, sql`call_scoring_enabled = false`)).toBe(1);
    expect(await row()).toEqual({ scoring: false, tl: false, off: [] });
  });

  it('E283 R-COACH-1 R-INT-6: an Admin cannot turn call reviews on, even with platform:coaching cleared (OWNER_ONLY_SETTING)', async () => {
    await ownerSets({ scoring: false, tl: false, off: [] });
    await expect(update(admin.actor, sql`call_scoring_enabled = true`)).rejects.toThrow(/OWNER_ONLY_SETTING/);
    expect(await row()).toEqual({ scoring: false, tl: false, off: [] });
  });

  it('E283 R-COACH-3: an Admin cannot change Team Lead visibility or the checklist, in either direction, whether call reviews are on or off (OWNER_ONLY_SETTING)', async () => {
    for (const scoring of [true, false]) {
      await ownerSets({ scoring, tl: true, off: ['recapped_call'] });
      for (const set of [
        sql`tl_sees_call_scores = false`,
        sql`coaching_rubric_disabled = '{}'::text[]`,
        sql`coaching_rubric_disabled = '{recapped_call,asked_timeline}'::text[]`,
      ]) {
        await expect(update(admin.actor, set)).rejects.toThrow(/OWNER_ONLY_SETTING/);
      }
      await ownerSets({ scoring, tl: false, off: [] });
      for (const set of [sql`tl_sees_call_scores = true`, sql`coaching_rubric_disabled = '{recapped_call}'::text[]`]) {
        await expect(update(admin.actor, set)).rejects.toThrow(/OWNER_ONLY_SETTING/);
      }
      expect(await row()).toEqual({ scoring, tl: false, off: [] });
    }
  });

  it('E283: an Admin cannot combine turning call reviews off with any other call-scoring change in the same UPDATE: the whole statement is refused', async () => {
    await ownerSets({ scoring: true, tl: true, off: ['recapped_call'] });
    for (const set of [
      sql`call_scoring_enabled = false, tl_sees_call_scores = false`,
      sql`call_scoring_enabled = false, coaching_rubric_disabled = '{}'::text[]`,
      sql`call_scoring_enabled = false, coaching_rubric_disabled = '{recapped_call,asked_timeline}'::text[]`,
      // the same items in another order is another value: only the Owner rewrites the checklist
      sql`call_scoring_enabled = false, coaching_rubric_disabled = '{asked_timeline,recapped_call}'::text[]`,
      sql`call_scoring_enabled = false, tl_sees_call_scores = false, coaching_rubric_disabled = '{}'::text[]`,
    ]) {
      await expect(update(admin.actor, set)).rejects.toThrow(/OWNER_ONLY_SETTING/);
      expect(await row()).toEqual({ scoring: true, tl: true, off: ['recapped_call'] });
    }
    // restating a value it does not change is not a change: off alone still goes through
    expect(await update(admin.actor, sql`call_scoring_enabled = false, tl_sees_call_scores = true, coaching_rubric_disabled = '{recapped_call}'::text[]`)).toBe(1);
    expect(await row()).toEqual({ scoring: false, tl: true, off: ['recapped_call'] });
  });
});

describe('everyone else, as before', () => {
  it('R-COACH-1 R-INT-6 R-COACH-3: the Owner still changes every call-scoring setting, in one UPDATE too; turning call reviews on still needs platform:coaching cleared (COACHING_NOT_CLEARED)', async () => {
    await ownerSets({ scoring: false, tl: false, off: [] });
    await packCleared(false);
    await expect(update(w.owner.actor, sql`call_scoring_enabled = true`)).rejects.toThrow(/COACHING_NOT_CLEARED/);
    expect(await update(w.owner.actor, sql`tl_sees_call_scores = true, coaching_rubric_disabled = '{recapped_call}'::text[]`)).toBe(1);
    expect(await row()).toEqual({ scoring: false, tl: true, off: ['recapped_call'] });
    await packCleared(true);
    expect(await update(w.owner.actor, sql`call_scoring_enabled = true, tl_sees_call_scores = false, coaching_rubric_disabled = '{}'::text[]`)).toBe(1);
    expect(await row()).toEqual({ scoring: true, tl: false, off: [] });
    expect(await update(w.owner.actor, sql`call_scoring_enabled = false, tl_sees_call_scores = true`)).toBe(1);
    expect(await row()).toEqual({ scoring: false, tl: true, off: [] });
  });

  it('R-COACH-3 R-PERM-11: a Team Lead and an agent change nothing (no row is theirs to update), a support actor with a live grant is refused (SUPPORT_READ_ONLY) and the system actor too (OWNER_ONLY_SETTING)', async () => {
    await ownerSets({ scoring: true, tl: false, off: [] });
    const sets = [sql`call_scoring_enabled = false`, sql`tl_sees_call_scores = true`, sql`coaching_rubric_disabled = '{recapped_call}'::text[]`];
    for (const actor of [w.tl!.actor, w.agents[0]!.actor]) {
      for (const set of sets) expect(await update(actor, set)).toBe(0);
    }
    // the grant is live: support reads tenant-wide, yet writes nothing
    expect(await withTenantTx(support, async (tx) => (await sql<{ ok: boolean }>`SELECT app.is_tenant_wide() AS ok`.execute(tx)).rows[0]!.ok, { db: h.app })).toBe(true);
    for (const set of sets) await expect(update(support, set)).rejects.toThrow(/SUPPORT_READ_ONLY/);
    for (const set of sets) await expect(update(w.system('worker'), set)).rejects.toThrow(/OWNER_ONLY_SETTING/);
    expect(await row()).toEqual({ scoring: true, tl: false, off: [] });
  });
});
