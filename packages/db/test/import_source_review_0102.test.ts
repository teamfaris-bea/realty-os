// R-LSRC-10 (owner decision 2026-11-14, the review half; migration 0102): import_source_labels, the source review list's
// own record. One row per imported source label per team, kept EXACTLY as imported, and one row per import's no-label
// group, each with where it was first committed and the Owner's last mapping of it (who, when).
//
// What the database itself holds, whatever the API does:
//   - the label is compared whole and kept byte for byte: another spelling is another row, the same one is one row;
//   - only the system (an import's commit) records where a label was first seen, once;
//   - only the Owner, as themselves and in their own name, records a mapping; nobody deletes a row;
//   - Owner, Admin and the system of the team read it; an agent, a team lead, support without a grant and every actor
//     of another team read nothing and change nothing (R-TEN-1, R-PERM-11).
// Labels here are made up; no partner is named.
import type { SupportActor, TenantId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withPreTenant, withTenantTx } from '../src/tenantTx.js';
import { PH, createHarness, createWorld, uuid, type Harness, type Member, type World } from './world.js';

let h: Harness;
let w: World;
let other: World;
let admin: Member;
let batchId: string;
let leadSource: string;

type Actor = Parameters<typeof withTenantTx>[0];
const as = <T>(actor: Actor, fn: Parameters<typeof withTenantTx<T>>[1]) => withTenantTx(actor, fn, { db: h.app });

async function importBatch(world: World, source = 'csv'): Promise<string> {
  const id = uuid();
  await h.su.query(
    `INSERT INTO import_batches (tenant_id, id, source, status, source_snapshot_sha256, source_snapshot_at, created_by_user_id)
     VALUES ($1, $2, $3, 'dry_run', repeat('a', 64), now(), $4)`,
    [world.tenantId, id, source, world.owner.id],
  );
  return id;
}

/** A label's row, written as the import's commit writes it (the system actor of the team). */
const seen = (label: string, world: World = w, batch = batchId, actor: Actor = world.system('import')) =>
  as(actor, async (tx) => (await sql<{ id: string }>`
    INSERT INTO import_source_labels (tenant_id, import_label, first_seen_batch_id, first_seen_kind, first_seen_at)
    VALUES (${world.tenantId}, ${label}, ${batch}, 'csv', now()) RETURNING id`.execute(tx)).rows[0]!.id);
const rowsOf = (actor: Actor, tenantId: string = w.tenantId) =>
  as(actor, async (tx) => Number((await sql<{ n: string }>`SELECT count(*) AS n FROM import_source_labels WHERE tenant_id = ${tenantId}`.execute(tx)).rows[0]!.n));
const mapAs = (actor: Actor, id: string, by: string, sourceId: string | null = leadSource) =>
  as(actor, async (tx) => Number((await sql`UPDATE import_source_labels SET lead_source_id = ${sourceId}, mapped_by_user_id = ${by}, mapped_at = now()
    WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx)).numAffectedRows ?? 0));

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 2, teamLead: true });
  other = await createWorld(h.app, { agents: 1 });
  const a = w.agents[1]!;
  await as(w.owner.actor, (tx) => sql`UPDATE memberships SET role = 'admin', accepting_leads = false WHERE user_id = ${a.id}`.execute(tx));
  admin = { id: a.id, role: 'admin', actor: { ...a.actor, role: 'admin' } };
  batchId = await importBatch(w);
  leadSource = uuid();
  await as(w.owner.actor, (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (${w.tenantId}, ${leadSource}, 'Northgate Referrals (0102 test)', 'referral')`.execute(tx));
});
afterAll(async () => {
  await h?.close();
});

describe('R-LSRC-10 M1: the label is kept exactly as imported, one row per label per team', () => {
  it('E738: every spelling is its own row and comes back character for character (surrounding spaces, capitals, an emoji, 40,000 characters); the same label a second time is refused, in this team only', async () => {
    const HOUSE = '\u{1F3E0}';
    const labels = ['Northgate Referrals', ' Northgate Referrals', 'Northgate Referrals ', 'northgate referrals', 'NORTHGATE  REFERRALS', `Northgate ${HOUSE}`, `${'n'.repeat(119)}${HOUSE}${'x'.repeat(39_880)}`, `${'n'.repeat(119)}${HOUSE}${'y'.repeat(39_880)}`];
    for (const l of labels) await seen(l);
    const got = (await h.su.query<{ l: string }>('SELECT import_label AS l FROM import_source_labels WHERE tenant_id = $1 AND import_label IS NOT NULL', [w.tenantId])).rows.map((r) => r.l);
    expect([...got].sort()).toEqual([...labels].sort());
    await expect(seen('Northgate Referrals')).rejects.toThrow(/import_source_labels_label/);
    // another team's same label is that team's own row
    await seen('Northgate Referrals', other, await importBatch(other));
    expect(await rowsOf(other.owner.actor, other.tenantId)).toBe(1);
  });

  it('E738: a row is a label or one import\'s no-label group, never both and never neither; an empty label is refused; one no-label row per import', async () => {
    const group = (batch: string | null, label: string | null) => as(w.system('import'), (tx) => sql`
      INSERT INTO import_source_labels (tenant_id, import_label, unlabeled_batch_id, first_seen_batch_id, first_seen_kind, first_seen_at)
      VALUES (${w.tenantId}, ${label}, ${batch}, ${batchId}, 'csv', now())`.execute(tx));
    await group(batchId, null);
    await expect(group(batchId, null)).rejects.toThrow(/import_source_labels_unlabeled/);
    await expect(group(batchId, 'Both (0102 test)')).rejects.toThrow(/check constraint/);
    await expect(group(null, null)).rejects.toThrow(/check constraint/);
    await expect(group(null, '')).rejects.toThrow(/check constraint/);
  });

  it('E738: the label and the no-label import of a row never change, and nobody deletes a row (not the Owner, not the system)', async () => {
    const id = await seen('Fixed label (0102 test)');
    for (const actor of [w.owner.actor, w.system('import')]) {
      await expect(as(actor, (tx) => sql`UPDATE import_source_labels SET import_label = 'Fixed label (0102 test) ' WHERE id = ${id}`.execute(tx))).rejects.toThrow(/IMPORT_SOURCE_LABEL_IMMUTABLE/);
      await expect(as(actor, (tx) => sql`UPDATE import_source_labels SET import_label = NULL, unlabeled_batch_id = ${batchId} WHERE id = ${id}`.execute(tx))).rejects.toThrow(/IMPORT_SOURCE_LABEL_IMMUTABLE|import_source_labels_unlabeled/);
      await expect(as(actor, (tx) => sql`DELETE FROM import_source_labels WHERE id = ${id}`.execute(tx))).rejects.toThrow(/permission denied/);
    }
  });
});

describe('R-LSRC-10 M1: where a label was first seen is written once, by an import\'s commit only', () => {
  it('E739: the Owner and the Admin cannot say where a label was first seen; the system writes it once (a label the Owner mapped ahead of any commit gets it at its first commit) and it never changes afterwards', async () => {
    for (const actor of [w.owner.actor, admin.actor]) {
      await expect(seen('Claimed label (0102 test)', w, batchId, actor)).rejects.toThrow(/IMPORT_SOURCE_LABEL_SEEN_SYSTEM_ONLY/);
    }
    // the Owner maps a label an import's preview showed, before anything is committed: a row with no first-seen yet
    const ahead = await as(w.owner.actor, async (tx) => (await sql<{ id: string }>`
      INSERT INTO import_source_labels (tenant_id, import_label, lead_source_id, mapped_by_user_id, mapped_at)
      VALUES (${w.tenantId}, 'Mapped ahead (0102 test)', ${leadSource}, ${w.owner.id}, now()) RETURNING id`.execute(tx)).rows[0]!.id);
    const read = async () => (await h.su.query<{ b: string | null; k: string | null; by: string | null; s: string | null }>(
      'SELECT first_seen_batch_id AS b, first_seen_kind AS k, mapped_by_user_id AS by, lead_source_id AS s FROM import_source_labels WHERE id = $1', [ahead])).rows[0]!;
    expect(await read()).toEqual({ b: null, k: null, by: w.owner.id, s: leadSource });
    await expect(as(w.owner.actor, (tx) => sql`UPDATE import_source_labels SET first_seen_batch_id = ${batchId}, first_seen_kind = 'csv', first_seen_at = now() WHERE id = ${ahead}`.execute(tx))).rejects.toThrow(/IMPORT_SOURCE_LABEL_SEEN_SYSTEM_ONLY/);
    // the commit's own statement: insert, or fill first-seen where it is still empty
    const commit = (batch: string) => as(w.system('import'), (tx) => sql`
      INSERT INTO import_source_labels (tenant_id, import_label, first_seen_batch_id, first_seen_kind, first_seen_at)
      VALUES (${w.tenantId}, 'Mapped ahead (0102 test)', ${batch}, 'csv', now())
      ON CONFLICT (tenant_id, digest(import_label, 'sha256')) WHERE import_label IS NOT NULL
      DO UPDATE SET first_seen_batch_id = COALESCE(import_source_labels.first_seen_batch_id, EXCLUDED.first_seen_batch_id),
                    first_seen_kind = COALESCE(import_source_labels.first_seen_kind, EXCLUDED.first_seen_kind),
                    first_seen_at = COALESCE(import_source_labels.first_seen_at, EXCLUDED.first_seen_at)`.execute(tx));
    await commit(batchId);
    expect(await read()).toEqual({ b: batchId, k: 'csv', by: w.owner.id, s: leadSource });
    const later = await importBatch(w);
    await commit(later); // a later import leaves it alone
    expect((await read()).b).toBe(batchId);
    await expect(as(w.system('import'), (tx) => sql`UPDATE import_source_labels SET first_seen_batch_id = ${later} WHERE id = ${ahead}`.execute(tx))).rejects.toThrow(/IMPORT_SOURCE_LABEL_IMMUTABLE/);
    await expect(as(w.system('import'), (tx) => sql`UPDATE import_source_labels SET first_seen_batch_id = NULL, first_seen_kind = NULL, first_seen_at = NULL WHERE id = ${ahead}`.execute(tx))).rejects.toThrow(/IMPORT_SOURCE_LABEL_IMMUTABLE/);
  });
});

describe('R-LSRC-10 M2 M3: only the Owner records a mapping, as themselves and in their own name', () => {
  it('E740: the Owner maps, re-maps and un-maps (who and when are kept); an Admin, the system, an agent and a team lead cannot; the Owner cannot record it in someone else\'s name or without a time', async () => {
    const id = await seen('Owner maps this (0102 test)');
    expect(await mapAs(w.owner.actor, id, w.owner.id)).toBe(1);
    const second = uuid();
    await as(w.owner.actor, (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (${w.tenantId}, ${second}, 'Open houses (0102 test)', 'open_house')`.execute(tx));
    expect(await mapAs(w.owner.actor, id, w.owner.id, second)).toBe(1); // re-map
    expect(await mapAs(w.owner.actor, id, w.owner.id, null)).toBe(1); // un-map: who and when stay recorded
    const r = (await h.su.query<{ s: string | null; by: string; at: Date }>('SELECT lead_source_id AS s, mapped_by_user_id AS by, mapped_at AS at FROM import_source_labels WHERE id = $1', [id])).rows[0]!;
    expect([r.s, r.by, r.at instanceof Date]).toEqual([null, w.owner.id, true]);

    await expect(mapAs(admin.actor, id, admin.id)).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    await expect(mapAs(w.system('import'), id, w.owner.id)).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    await expect(mapAs(w.owner.actor, id, admin.id)).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    await expect(as(w.owner.actor, (tx) => sql`UPDATE import_source_labels SET lead_source_id = ${leadSource}, mapped_by_user_id = NULL, mapped_at = NULL WHERE id = ${id}`.execute(tx))).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY|check constraint/);
    // an agent and a team lead do not see the row at all: nothing is updated and nothing can be inserted
    for (const m of [w.agents[0]!, w.tl!]) {
      expect(await mapAs(m.actor, id, m.id)).toBe(0);
      await expect(as(m.actor, (tx) => sql`INSERT INTO import_source_labels (tenant_id, import_label) VALUES (${w.tenantId}, 'Agent label (0102 test)')`.execute(tx))).rejects.toThrow(/row-level security/);
    }
    // another team's lead source cannot be named (the composite foreign key holds the team)
    await expect(mapAs(w.owner.actor, id, w.owner.id, other.leadSourceId)).rejects.toThrow(/foreign key/);
  });
});

describe('R-LSRC-10 M5: who reads the review list (R-TEN-1, R-PERM-11)', () => {
  it('E746 R-TEN-1: Owner, Admin and the system of the team read it; an agent and a team lead read nothing; no actor of another team reads, updates or inserts a row of this team', async () => {
    const total = Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM import_source_labels WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n);
    expect(total).toBeGreaterThan(5);
    for (const actor of [w.owner.actor, admin.actor, w.system('import'), w.system('assistant')]) expect(await rowsOf(actor)).toBe(total);
    for (const actor of [w.agents[0]!.actor, w.tl!.actor]) expect(await rowsOf(actor)).toBe(0);
    for (const actor of [other.owner.actor, other.agents[0]!.actor, other.system('import')]) {
      expect(await rowsOf(actor)).toBe(0);
      expect(await as(actor, async (tx) => Number((await sql`UPDATE import_source_labels SET updated_at = now() WHERE tenant_id = ${w.tenantId}`.execute(tx)).numAffectedRows ?? 0))).toBe(0);
      await expect(as(actor, (tx) => sql`INSERT INTO import_source_labels (tenant_id, import_label) VALUES (${w.tenantId}, 'Foreign label (0102 test)')`.execute(tx))).rejects.toThrow(/row-level security/);
    }
    // with no tenant context at all, the table reads empty
    const c = await h.app.pool.connect();
    try {
      expect(Number((await c.query('SELECT count(*) AS n FROM public.import_source_labels')).rows[0].n)).toBe(0);
    } finally {
      c.release();
    }
  });

  it('E746 R-PERM-11: support reads it only with a live grant and never writes it', async () => {
    const supportUserId = uuid() as UserId;
    await withPreTenant((tx) => sql`INSERT INTO users (id, email, display_name, password_hash) VALUES (${supportUserId}, ${`support-${uuid()}@platform.test`}, 'Platform Support', ${PH})`.execute(tx), { userId: supportUserId, db: h.app });
    const grantId = uuid();
    const support = (g: string): SupportActor => ({ kind: 'support', userId: supportUserId, tenantId: w.tenantId as TenantId, grantId: g });
    // no grant yet: nothing
    expect(await rowsOf(support(grantId))).toBe(0);
    await as(w.owner.actor, (tx) => sql`INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at)
      VALUES (${w.tenantId}, ${grantId}, ${supportUserId}, ${w.owner.id}, 'review list check', now() + interval '1 hour')`.execute(tx));
    expect(await rowsOf(support(grantId))).toBeGreaterThan(0);
    await expect(as(support(grantId), (tx) => sql`UPDATE import_source_labels SET updated_at = now() WHERE tenant_id = app.tenant_id()`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    await expect(as(support(grantId), (tx) => sql`INSERT INTO import_source_labels (tenant_id, import_label) VALUES (${w.tenantId}, 'Support label (0102 test)')`.execute(tx))).rejects.toThrow(/SUPPORT_READ_ONLY/);
    // revoked: nothing again
    await as(w.owner.actor, (tx) => sql`UPDATE support_access_grants SET revoked_at = now() WHERE id = ${grantId}`.execute(tx));
    expect(await rowsOf(support(grantId))).toBe(0);
  });
});
