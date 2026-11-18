// R-LSRC-8, R-LSRC-9 (migration 0103): only a COMMITTED import outcome is import evidence, for a marked source too.
//
// 0099 and 0101 let a label the Owner mapped to a MARKED source cover a person a file only matched (a dry run, a record
// waiting for review, a skipped duplicate, an abandoned import), a record of theirs that was rejected or reverted, and
// a person whose record carried an `import_source` key a caller sent at intake. A preview then blocked a native person,
// their plan stopped at its next step for good, and the only release opened the real source's people. 0103: a label, or
// an import's no-label group, counts for a person only through a contacts record that TARGETS a record of the person
// with outcome imported or merged. The marked reason and the per-source question give one answer
// (app.person_source_refusal and app.person_from_lead_source), and both definers declare what they cost.
// Labels here are made up; no partner is named.
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenantTx } from '../src/tenantTx.js';
import { cmd, createHarness, createWorld, selfCreated, uuid, type Harness, type World } from './world.js';

let h: Harness;
let w: World;

beforeAll(async () => {
  h = await createHarness();
  w = await createWorld(h.app, { agents: 1 });
});
afterAll(async () => {
  await h?.close();
});

const refusal = (id: string) =>
  withTenantTx(w.system(), async (tx) => (await sql<{ r: string | null }>`SELECT app.person_source_refusal(app.tenant_id(), ${id}::uuid) AS r`.execute(tx)).rows[0]!.r, { db: h.app });
const fromSource = (id: string, sourceId: string) =>
  withTenantTx(w.system(), async (tx) => (await sql<{ y: boolean }>`SELECT app.person_from_lead_source(app.tenant_id(), ${id}::uuid, ${sourceId}::uuid) AS y`.execute(tx)).rows[0]!.y, { db: h.app });
/** The same question asked the other way: is there a marked source that sent the person (the per-source definer)? */
const anyMarked = (id: string) =>
  withTenantTx(w.system(), async (tx) => (await sql<{ y: boolean }>`
    SELECT EXISTS (SELECT 1 FROM lead_sources s WHERE s.tenant_id = app.tenant_id() AND s.no_ai_care AND app.person_from_lead_source(app.tenant_id(), ${id}::uuid, s.id)) AS y`.execute(tx)).rows[0]!.y, { db: h.app });

async function importBatch(status = 'dry_run'): Promise<{ batchId: string; stageId: string }> {
  const batchId = uuid();
  const stageId = uuid();
  await h.su.query(
    `INSERT INTO import_batches (tenant_id, id, source, status, source_snapshot_sha256, source_snapshot_at, created_by_user_id)
     VALUES ($1, $2, 'csv', $4, repeat('a', 64), now(), $3)`,
    [w.tenantId, batchId, w.owner.id, status],
  );
  await h.su.query(`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1, $2, $3, 'contacts', 1, 'pending')`, [w.tenantId, stageId, batchId]);
  return { batchId, stageId };
}

interface RecordInput {
  label?: string | null;
  outcome?: string;
  category?: string;
  target?: string | null;
  match?: string | null;
}
async function record(stageId: string, contactId: string, o: RecordInput = {}): Promise<string> {
  const id = uuid();
  const target = o.target === undefined ? contactId : o.target;
  await h.su.query(
    `INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_purged_at, normalized, outcome, target_table, target_id, match_contact_id)
     VALUES ($1, $2, $3, $4, now(), $5::jsonb, $6, $7, $8, $9)`,
    [w.tenantId, id, stageId, `file.csv#row=${id}`, JSON.stringify({ category: o.category ?? 'contacts', leadSourceLabel: o.label ?? null }), o.outcome ?? 'imported', target === null ? null : 'contacts', target, o.match ?? null],
  );
  return id;
}
const person = () => selfCreated(h.app, w, w.agents[0]!);
async function source(name: string, o: { marked?: boolean; labels?: string[]; batches?: string[] } = {}): Promise<string> {
  const id = uuid();
  await withTenantTx(w.owner.actor, (tx) => sql`INSERT INTO lead_sources (tenant_id, id, name, kind, no_ai_care, import_labels, import_unlabeled_batches)
    VALUES (${w.tenantId}, ${id}, ${name}, 'referral', ${o.marked === true}, ${o.labels ?? []}::text[], ${o.batches ?? []}::uuid[])`.execute(tx), { db: h.app });
  return id;
}

describe('R-LSRC-8 (0103): a marked source covers an imported person only through a committed record that targets them', () => {
  it('a record that only matched a person (a dry run, a record waiting for review, a skipped duplicate, a rejected row), in a running or an abandoned import, covers nobody: not under a label and not in a no-label group', async () => {
    const live = await importBatch();
    const abandoned = await importBatch('abandoned');
    const label = 'Partner label (0103 test)';
    const marked = await source('Partner referrals (0103 test)', { marked: true, labels: [label], batches: [live.batchId, abandoned.batchId] });
    for (const b of [live, abandoned]) {
      for (const outcome of ['will_import', 'needs_review', 'duplicate', 'skipped', 'rejected']) {
        const p = await person();
        await record(b.stageId, p, { label, outcome, target: null, match: p });
        const q = await person();
        await record(b.stageId, q, { label: null, outcome, target: null, match: q });
        for (const id of [p, q]) {
          expect([outcome, await fromSource(id, marked)]).toEqual([outcome, false]);
          expect([outcome, await refusal(id)]).toEqual([outcome, null]);
        }
      }
    }
  });

  it('a record that targets the person but was not committed (a duplicate kept out, a rejected or a reverted row), and a record of another import category, cover nobody', async () => {
    const { batchId, stageId } = await importBatch();
    const label = 'Uncommitted label (0103 test)';
    const marked = await source('Partner uncommitted (0103 test)', { marked: true, labels: [label], batches: [batchId] });
    for (const outcome of ['duplicate', 'rejected', 'reverted']) {
      const p = await person();
      await record(stageId, p, { label, outcome });
      const q = await person();
      await record(stageId, q, { label: null, outcome });
      for (const id of [p, q]) {
        expect([outcome, await fromSource(id, marked)]).toEqual([outcome, false]);
        expect([outcome, await refusal(id)]).toEqual([outcome, null]);
      }
    }
    const other = await person();
    for (const category of ['ownership', 'notes', 'messages', 'consent']) {
      await record(stageId, other, { category, label });
      await record(stageId, other, { category, label: null });
    }
    expect(await fromSource(other, marked)).toBe(false);
    expect(await refusal(other)).toBeNull();
  });

  it('an `import_source` key on the person\'s record is not import evidence: a caller sends its own sourceDetail keys at intake', async () => {
    const label = 'Caller label (0103 test)';
    const marked = await source('Partner caller (0103 test)', { marked: true, labels: [label] });
    const native = await person();
    await h.su.query(`UPDATE contacts SET original_source_detail = jsonb_build_object('import_system', 'csv', 'import_source', $2::text, 'import_batch_id', 'x') WHERE id = $1`, [native, label]);
    expect(await fromSource(native, marked)).toBe(false);
    expect(await refusal(native)).toBeNull();
  });

  it('the committed record covers them: imported or merged, under the label or in the no-label group, through the merge tree; and the commit of a record that had only matched covers the person from then on', async () => {
    const { batchId, stageId } = await importBatch();
    const label = 'Committed label (0103 test)';
    const marked = await source('Partner committed (0103 test)', { marked: true, labels: [label], batches: [batchId] });
    for (const outcome of ['imported', 'merged']) {
      const p = await person();
      await record(stageId, p, { label, outcome });
      const q = await person();
      await record(stageId, q, { label: null, outcome });
      for (const id of [p, q]) {
        expect([outcome, await fromSource(id, marked)]).toEqual([outcome, true]);
        expect([outcome, await refusal(id)]).toEqual([outcome, 'SOURCE_NO_AUTOMATED_CONTACT']);
      }
    }
    // the dry run matched her; the commit attaches the record to her
    const fay = await person();
    const rec = await record(stageId, fay, { label, outcome: 'needs_review', target: null, match: fay });
    expect(await refusal(fay)).toBeNull();
    await h.su.query(`UPDATE import_records SET outcome = 'imported', target_table = 'contacts', target_id = $2 WHERE id = $1`, [rec, fay]);
    expect(await refusal(fay)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(await fromSource(fay, marked)).toBe(true);
    // a record merged away carries its committed label to the survivor
    const survivor = await person();
    const loser = await person();
    await record(stageId, loser, { label });
    expect(await refusal(survivor)).toBeNull();
    const r = await cmd(h.app, w.owner.actor, survivor, { kind: 'merge', survivorId: survivor, loserId: loser as ContactId, ownerChoice: null });
    expect(r.outcome.ok).toBe(true);
    for (const id of [survivor, loser]) {
      expect(await refusal(id)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
      expect(await fromSource(id, marked)).toBe(true);
    }
  });

  it('a native lead of a marked source is covered as before: by the person\'s own lead source and by any inquiry the source sent', async () => {
    const marked = await source('Partner native (0103 test)', { marked: true });
    const byRecord = await person();
    await h.su.query('UPDATE contacts SET original_lead_source_id = $2 WHERE id = $1', [byRecord, marked]);
    expect(await refusal(byRecord)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(await fromSource(byRecord, marked)).toBe(true);
    const byInquiry = await person();
    await h.su.query(
      `INSERT INTO lead_inquiries (tenant_id, id, contact_id, lead_source_id, inquiry_type, fingerprint, received_at, outcome)
       VALUES ($1, $2, $3, $4, 'buy', decode(repeat('ab', 32), 'hex'), now(), 'attached')`,
      [w.tenantId, uuid(), byInquiry, marked],
    );
    expect(await refusal(byInquiry)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    expect(await fromSource(byInquiry, marked)).toBe(true);
  });

  it('one answer: for every person of this file the marked reason is given exactly when a marked source sent them, and a marked source wins over an unreviewed label', async () => {
    const { stageId } = await importBatch();
    const both = await person();
    await record(stageId, both, { label: 'Committed label (0103 test)' });
    await record(stageId, both, { label: 'Nobody mapped this (0103 test)' });
    expect(await refusal(both)).toBe('SOURCE_NO_AUTOMATED_CONTACT');
    const unreviewed = await person();
    await record(stageId, unreviewed, { label: 'Nobody mapped this (0103 test)' });
    expect(await refusal(unreviewed)).toBe('SOURCE_UNCLASSIFIED');
    const all = (await h.su.query<{ id: string }>('SELECT id FROM contacts WHERE tenant_id = $1', [w.tenantId])).rows.map((x) => x.id);
    expect(all.length).toBeGreaterThan(30);
    let marked = 0;
    for (const id of all) {
      const [why, any] = [await refusal(id), await anyMarked(id)];
      expect([id, why === 'SOURCE_NO_AUTOMATED_CONTACT']).toEqual([id, any]);
      if (any) marked += 1;
    }
    expect(marked).toBeGreaterThan(8);
  });

  it('the definers every automated path asks declare a cost the planner can use, and are still app_definer\'s, pinned, and executable by app_user only', async () => {
    const rows = (await h.su.query<{ name: string; cost: number; owner: string; definer: boolean; config: string[]; pub: boolean; app: boolean }>(
      `SELECT p.proname AS name, p.procost::float8 AS cost, r.rolname AS owner, p.prosecdef AS definer, p.proconfig AS config,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS pub,
              has_function_privilege('app_user', p.oid, 'EXECUTE') AS app
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.pronamespace = 'app'::regnamespace AND p.proname IN ('person_source_refusal', 'person_from_lead_source', 'person_no_ai_care_source') ORDER BY 1`)).rows;
    expect(rows.map((x) => x.name)).toEqual(['person_from_lead_source', 'person_no_ai_care_source', 'person_source_refusal']);
    for (const x of rows) {
      expect([x.name, x.owner, x.definer, x.config, x.pub, x.app]).toEqual([x.name, 'app_definer', true, ['search_path=pg_catalog, public'], false, true]);
      // the default (100) prices a definer that walks the merge tree and probes four tables like one comparison
      expect([x.name, x.cost >= 5000]).toEqual([x.name, true]);
    }
  });
});
