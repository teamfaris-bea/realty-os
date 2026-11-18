// R-LSRC-9 (owner decision 2026-11-14, migration 0101): an imported person whose source the Owner has not reviewed is
// "unclassified" and gets no automated contact, on the same definer every automated path already asks.
//
// A1: what counts. Only a COMMITTED contacts import record (outcome imported or merged, targeting a record of the person)
// is import evidence. Its label must be held by exactly one lead source (lead_sources.import_labels, Owner only); a record
// with no label needs its import's no-label group classified (lead_sources.import_unlabeled_batches, Owner only). A dry
// run, a rejected, skipped, duplicate or reverted record, a record of another category and a key a caller sent at intake
// never make anyone unclassified. A marked source wins. Labels here are made up; no partner is named.
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, selfCreated, uuid, type Harness, type World } from './world.js';

let h: Harness;
let w: World;
let other: World;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
  other = await createWorld(h.app, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const refusal = (id: string, world: World = w) =>
  withTenantTx(world.owner.actor, async (tx) => (await sql<{ r: string | null }>`SELECT app.person_source_refusal(${w.tenantId}::uuid, ${id}::uuid) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
const refused = (id: string) =>
  withTenantTx(w.system(), async (tx) => (await sql<{ no: boolean }>`SELECT app.person_no_ai_care_source(app.tenant_id(), ${id}::uuid) AS no`.execute(tx)).rows[0]!.no, { db: h.app });
const fromSource = (id: string, sourceId: string) =>
  withTenantTx(w.system(), async (tx) => (await sql<{ y: boolean }>`SELECT app.person_from_lead_source(app.tenant_id(), ${id}::uuid, ${sourceId}::uuid) AS y`.execute(tx)).rows[0]!.y, { db: h.app });

/** One import (a batch and its contacts stage), written as the migration owner: fixtures only. */
async function importBatch(world: World = w): Promise<{ batchId: string; stageId: string }> {
  const batchId = uuid();
  const stageId = uuid();
  await h.su.query(
    `INSERT INTO import_batches (tenant_id, id, source, status, source_snapshot_sha256, source_snapshot_at, created_by_user_id)
     VALUES ($1, $2, 'csv', 'dry_run', repeat('a', 64), now(), $3)`,
    [world.tenantId, batchId, world.owner.id],
  );
  await h.su.query(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'contacts', 1, 'pending')`, [world.tenantId, stageId, batchId]);
  return { batchId, stageId };
}

interface RecordInput {
  label?: string | null;
  outcome?: string;
  category?: string;
  target?: string | null;
  match?: string | null;
}

/** One import record. Default: a committed contacts record (imported) that targets `contactId`, with `label`. */
async function record(stageId: string, contactId: string, o: RecordInput = {}, world: World = w): Promise<string> {
  const id = uuid();
  const target = o.target === undefined ? contactId : o.target;
  await h.su.query(
    `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id, match_contact_id)
     VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7, $8, $9)`,
    [world.tenantId, id, stageId, `file.csv#row=${id}`, JSON.stringify({ category: o.category ?? 'contacts', leadSourceLabel: o.label ?? null }), o.outcome ?? 'imported', target === null ? null : 'contacts', target, o.match ?? null],
  );
  return id;
}

const person = () => selfCreated(h.app, w, w.agents[0]!);

async function source(name: string, o: { marked?: boolean } = {}): Promise<string> {
  const id = uuid();
  await withTenantTx(w.owner.actor, (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind, no_ai_care) VALUES (${w.tenantId}, ${id}, ${name}, 'referral', ${o.marked === true})`.execute(tx), { db: h.app });
  return id;
}
const setLabels = (sourceId: string, labels: string[]) =>
  withTenantTx(w.owner.actor, (tx) => sql`UPDATE lead_sources SET import_labels = ${labels}::text[] WHERE tenant_id = app.tenant_id() AND id = ${sourceId}::uuid`.execute(tx), { db: h.app });
const setUnlabeled = (sourceId: string, batches: string[]) =>
  withTenantTx(w.owner.actor, (tx) => sql`UPDATE lead_sources SET import_unlabeled_batches = ${batches}::uuid[] WHERE tenant_id = app.tenant_id() AND id = ${sourceId}::uuid`.execute(tx), { db: h.app });

describe('R-LSRC-9 A1: who is unclassified (app.person_source_refusal, 0101)', () => {
  it('a native person is never unclassified, whatever import-looking key a caller sent with them', async () => {
    const native = await person();
    expect(await refusal(native)).toBeNull();
    expect(await refused(native)).toBe(false);
    // an intake caller chooses its own sourceDetail keys: they are not import evidence
    await h.su.query(`UPDATE contacts SET original_source_detail = '{"import_system":"csv","import_source":"Northgate Referrals","import_batch_id":"x"}'::jsonb WHERE id = $1`, [native]);
    expect(await refusal(native)).toBeNull();
    expect(await refused(native)).toBe(false);
  });

  it('a committed import record with an unmapped label makes the person unclassified; the Owner mapping exactly that label lifts it; removing the mapping brings it back', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: 'Northgate Referrals' });
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    expect(await refused(p)).toBe(true);
    const s = await source('Northgate (0101 test)');
    // never inferred: another spelling of the label classifies nobody
    await setLabels(s, ['northgate referrals', 'Northgate Referrals ', 'Northgate']);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    await setLabels(s, ['Northgate Referrals']);
    expect(await refusal(p)).toBeNull();
    expect(await refused(p)).toBe(false);
    expect(await fromSource(p, s)).toBe(true);
    await setLabels(s, []);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    expect(await fromSource(p, s)).toBe(false);
  });

  it('the whole label is compared: two long labels that share their first 120 characters are two labels', async () => {
    const { stageId } = await importBatch();
    const a = await person();
    const b = await person();
    const stem = `${'😀'.repeat(119)} long label `;
    await record(stageId, a, { label: `${stem}A` });
    await record(stageId, b, { label: `${stem}B` });
    const s = await source('Long labels (0101 test)');
    await setLabels(s, [`${stem}A`]);
    expect(await refusal(a)).toBeNull();
    expect(await refusal(b)).toBe('SOURCE_UNCLASSIFIED');
    expect(await fromSource(b, s)).toBe(false);
  });

  it('a label two lead sources hold is ambiguous: its people stay unclassified until one source holds it', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: 'LeadRouter' });
    const one = await source('Router one (0101 test)');
    const two = await source('Router two (0101 test)');
    await setLabels(one, ['LeadRouter']);
    expect(await refusal(p)).toBeNull();
    await setLabels(two, ['LeadRouter']);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    await setLabels(one, []);
    expect(await refusal(p)).toBeNull();
  });

  it('a committed record with no label is unclassified until the Owner classifies that import\'s no-label group; another import\'s no-label group is its own', async () => {
    const first = await importBatch();
    const second = await importBatch();
    const p = await person();
    const q = await person();
    await record(first.stageId, p, { label: null });
    await record(second.stageId, q, { label: null });
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    expect(await refusal(q)).toBe('SOURCE_UNCLASSIFIED');
    const s = await source('Sphere (0101 test)');
    await setUnlabeled(s, [first.batchId]);
    expect(await refusal(p)).toBeNull();
    expect(await fromSource(p, s)).toBe(true);
    // never inferred across imports
    expect(await refusal(q)).toBe('SOURCE_UNCLASSIFIED');
    expect(await fromSource(q, s)).toBe(false);
    // two sources claiming one import's no-label group is ambiguous
    const t = await source('Sphere two (0101 test)');
    await setUnlabeled(t, [first.batchId]);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    await setUnlabeled(t, []);
    await setUnlabeled(s, []);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
  });

  it('every committed record counts: one mapped label and one unmapped label leave the person unclassified', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: 'Mapped (0101 test)' });
    await record(stageId, p, { label: 'Not mapped (0101 test)' });
    const s = await source('Mapped source (0101 test)');
    await setLabels(s, ['Mapped (0101 test)']);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    await setLabels(s, ['Mapped (0101 test)', 'Not mapped (0101 test)']);
    expect(await refusal(p)).toBeNull();
  });

  it('a dry run, a rejected, skipped, duplicate or reverted record, a record that only matched, and a record of another category never make anyone unclassified', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    for (const outcome of ['will_import', 'needs_review', 'rejected', 'duplicate', 'skipped', 'reverted']) {
      await record(stageId, p, { label: 'Preview only (0101 test)', outcome, target: outcome === 'rejected' || outcome === 'reverted' ? p : null, match: p });
      await record(stageId, p, { label: null, outcome, target: null, match: p });
    }
    // the ownership, notes and messages stages target the person too, and carry no source label at all
    for (const category of ['ownership', 'notes', 'messages', 'consent']) await record(stageId, p, { category, label: null });
    expect(await refusal(p)).toBeNull();
    expect(await refused(p)).toBe(false);
  });

  it('a merged record counts through the survivor', async () => {
    const { stageId } = await importBatch();
    const survivor = await person();
    const loser = await person();
    await record(stageId, loser, { label: 'Merged label (0101 test)', outcome: 'merged' });
    expect(await refusal(survivor)).toBeNull();
    const r = await cmd(h.app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser as ContactId, ownerChoice: null });
    expect(r.outcome.ok).toBe(true);
    expect(await refusal(survivor)).toBe('SOURCE_UNCLASSIFIED');
    expect(await refusal(loser)).toBe('SOURCE_UNCLASSIFIED');
  });

  it('a marked source wins over unclassified, and a label mapped to a marked source keeps the person refused for that reason', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: 'Partner label (0101 test)' });
    await record(stageId, p, { label: 'Other label (0101 test)' });
    const marked = await source('Partner referrals (0101 test)', { marked: true });
    await setLabels(marked, ['Partner label (0101 test)']);
    // both apply (the other label is still unmapped): the marked source is the reason
    expect(await refusal(p)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(await refused(p)).toBe(true);
    const plain = await source('Other source (0101 test)');
    await setLabels(plain, ['Other label (0101 test)']);
    expect(await refusal(p)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    // moved off the marked source: the person follows the mapping, in both directions
    await setLabels(marked, []);
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    await setLabels(plain, ['Other label (0101 test)', 'Partner label (0101 test)']);
    expect(await refusal(p)).toBeNull();
    await setLabels(plain, ['Other label (0101 test)']);
    await setLabels(marked, ['Partner label (0101 test)']);
    expect(await refusal(p)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
  });

  it('a no-label group classified to a marked source covers its people as that source\'s', async () => {
    const { batchId, stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: null });
    const marked = await source('Partner file (0101 test)', { marked: true });
    await setUnlabeled(marked, [batchId]);
    expect(await refusal(p)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(await fromSource(p, marked)).toBe(true);
  });

  it('R-TEN-2: another tenant learns nothing (NULL and false), and its own mapping never classifies this tenant\'s people', async () => {
    const { stageId } = await importBatch();
    const p = await person();
    await record(stageId, p, { label: 'Tenant label (0101 test)' });
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
    // asked for this tenant from inside the other tenant's transaction
    expect(await refusal(p, other)).toBeNull();
    await withTenantTx(other.owner.actor, async (tx) => {
      const r = await sql<{ no: boolean; y: boolean }>`SELECT app.person_no_ai_care_source(${w.tenantId}::uuid, ${p}::uuid) AS no, app.person_from_lead_source(${w.tenantId}::uuid, ${p}::uuid, ${w.leadSourceId}::uuid) AS y`.execute(tx);
      expect(r.rows[0]).toEqual({ no: false, y: false });
      await sql`UPDATE lead_sources SET import_labels = ARRAY['Tenant label (0101 test)'] WHERE tenant_id = app.tenant_id() AND id = ${other.leadSourceId}::uuid`.execute(tx);
    }, { db: h.app });
    expect(await refusal(p)).toBe('SOURCE_UNCLASSIFIED');
  });

  it('only the Owner, as themselves, classifies a no-label group (the same guard as a label)', async () => {
    const { batchId } = await importBatch();
    const s = await source('Owner only (0101 test)');
    // an agent's row-level security shows them no lead source to update; the system actor reaches the guard
    const byAgent = await withTenantTx(w.agents[0]!.actor, (tx) => sql`UPDATE lead_sources SET import_unlabeled_batches = ARRAY[${batchId}]::uuid[] WHERE id = ${s}::uuid`.execute(tx), { db: h.app });
    expect(Number(byAgent.numAffectedRows ?? 0)).toBe(0);
    await expect(withTenantTx(w.system(), (tx) => sql`UPDATE lead_sources SET import_unlabeled_batches = ARRAY[${batchId}]::uuid[] WHERE id = ${s}::uuid`.execute(tx), { db: h.app })).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    expect((await h.su.query<{ b: string[] }>('SELECT import_unlabeled_batches AS b FROM lead_sources WHERE id = $1', [s])).rows[0]!.b).toEqual([]);
    await expect(withTenantTx(w.system(), (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind, import_unlabeled_batches) VALUES (${w.tenantId}, ${uuid()}, 'Forged (0101 test)', 'referral', ARRAY[${batchId}]::uuid[])`.execute(tx), { db: h.app })).rejects.toThrow(/LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY/);
    await setUnlabeled(s, [batchId]);
    expect((await h.su.query<{ b: string[] }>('SELECT import_unlabeled_batches AS b FROM lead_sources WHERE id = $1', [s])).rows[0]!.b).toEqual([batchId]);
  });
});

// A6: the source guards return when the tenant context is missing or another tenant's (unchanged since 0098). That is
// safe only if no application path writes these rows that way. The evidence, read from the catalog of a fully migrated
// database: app_user cannot bypass row-level security, and FORCE row-level security refuses every row when it has no
// tenant context; the two roles that do bypass it (app_definer, app_retention) cannot log in and act only through the
// SECURITY DEFINER functions they own, and no such function inserts into or updates messages, playbook_enrollments,
// calls or ai_isa_assignments; app_definer holds no INSERT or UPDATE on them at all, app_retention no INSERT. What is
// left is the migration owner (migrations, fixtures, the demo seed), which is not an application path.
describe('R-LSRC-9 A6: no role that bypasses row-level security can make the activating write without a tenant context', () => {
  const GUARDED = ['messages', 'playbook_enrollments', 'calls', 'ai_isa_assignments'] as const;

  it('app_user never bypasses row-level security, the guarded tables force it, and with no tenant context app_user reads and writes none of their rows', async () => {
    // (app_user logs in here only because the test harness connects as it; the two bypassing roles never can)
    const roles = (await h.su.query<{ rolname: string; rolbypassrls: boolean; rolsuper: boolean; login: boolean | null }>("SELECT rolname, rolbypassrls, rolsuper, CASE WHEN rolname = 'app_user' THEN NULL ELSE rolcanlogin END AS login FROM pg_roles WHERE rolname IN ('app_user','app_definer','app_retention') ORDER BY rolname")).rows;
    expect(roles).toEqual([
      { rolname: 'app_definer', rolbypassrls: true, rolsuper: false, login: false },
      { rolname: 'app_retention', rolbypassrls: true, rolsuper: false, login: false },
      { rolname: 'app_user', rolbypassrls: false, rolsuper: false, login: null },
    ]);
    const forced = (await h.su.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>('SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relnamespace = $1::regnamespace AND relname = ANY ($2) ORDER BY relname', ['public', [...GUARDED]])).rows;
    expect(forced).toEqual([...GUARDED].sort().map((relname) => ({ relname, relrowsecurity: true, relforcerowsecurity: true })));
    // app_user with no tenant context: every row is invisible, so no UPDATE reaches one (and an INSERT fails its policy)
    const c = await h.su.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      for (const t of GUARDED) expect((await c.query(`SELECT count(*)::int AS n FROM public.${t}`)).rows[0].n, t).toBe(0);
      expect((await c.query("UPDATE public.playbook_enrollments SET state = 'active'")).rowCount).toBe(0);
      expect((await c.query("UPDATE public.messages SET status = 'dispatching', dispatched_at = now() WHERE status = 'queued'")).rowCount).toBe(0);
      expect((await c.query("UPDATE public.calls SET handled_by = 'assistant'")).rowCount).toBe(0);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('the bypassing roles hold no way to make an activating write: app_definer has no INSERT or UPDATE on the guarded tables, app_retention no INSERT, and no SECURITY DEFINER function owned by a bypassing role inserts into or updates them', async () => {
    const privs = (await h.su.query<{ role: string; t: string; ins: boolean; upd: boolean; col: boolean }>(
      `SELECT r.role, t.t,
              has_table_privilege(r.role, 'public.' || t.t, 'INSERT') AS ins,
              has_table_privilege(r.role, 'public.' || t.t, 'UPDATE') AS upd,
              has_any_column_privilege(r.role, 'public.' || t.t, 'INSERT, UPDATE') AS col
         FROM unnest(ARRAY['app_definer','app_retention']) AS r(role) CROSS JOIN unnest($1::text[]) AS t(t) ORDER BY 1, 2`,
      [[...GUARDED]],
    )).rows;
    for (const p of privs.filter((x) => x.role === 'app_definer')) expect(p, `${p.role} ${p.t}`).toMatchObject({ ins: false, upd: false, col: false });
    for (const p of privs.filter((x) => x.role === 'app_retention')) expect(p.ins, `${p.role} ${p.t}`).toBe(false);
    // app_retention may UPDATE (purges): only through the functions it owns. None of the definers a bypassing role
    // owns writes these tables at all (checked on the installed function bodies, not on migration text).
    const writers = (await h.su.query<{ fn: string; owner: string }>(
      `SELECT p.oid::regprocedure::text AS fn, r.rolname AS owner
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.prosecdef AND (r.rolbypassrls OR r.rolsuper) AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~* '(insert\\s+into|update)\\s+(only\\s+)?(public\\.)?(messages|playbook_enrollments|calls|ai_isa_assignments)\\M'
        ORDER BY 1`,
    )).rows;
    expect(writers).toEqual([]);
    const definers = (await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.prosecdef AND r.rolname IN ('app_definer','app_retention')")).rows[0]!.n;
    expect(definers).toBeGreaterThan(100); // the scan read the real catalog of definers
  });
});
