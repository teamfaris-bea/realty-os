// api/imports commit: ≤ 1,000 records per transaction, resumable after a crash, record errors never
// abort the batch, and concurrent commits never apply a record twice (R-IMPORT-4; BUILD_PLAN module 16
// "A resume after a crash mid-commit").
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCommit } from './commit.js';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  csvBase64,
  csvOf,
  dryRunStage,
  fubFixture,
  fullStage,
  importWorld,
  importsHarness,
  mapAgents,
  records,
  stageOf,
  startFub,
} from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
});
afterAll(async () => {
  await ih?.close();
});

async function csvBatch(w: ImportWorld, n: number, offset = 0): Promise<BatchView> {
  const r = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'leads.csv', fileBase64: csvBase64(csvOf(n, offset)) });
  if (r.status !== 201) throw new Error(`csv: ${r.status} ${JSON.stringify(r.body)}`);
  expect((await call(w.admin, 'POST', `/imports/${r.body.batch.id}/snapshot`)).status).toBe(202);
  await ih.drain();
  return batchOf(w.admin, r.body.batch.id);
}

const txCount = async (stageId: string) =>
  (await q<{ n: number }>("SELECT count(DISTINCT xmin::text)::int AS n FROM import_records WHERE stage_id = $1 AND outcome = 'imported'", [stageId]))[0]!.n;

describe('R-IMPORT-4: resumable commit in chunks', () => {
  it('R-IMPORT-4: a crash mid-commit resumes exactly where the last committed chunk stopped, without duplicates', async () => {
    const w = await importWorld(ih);
    const b = await csvBatch(w, 30);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect(d.counts).toMatchObject({ source: 30, willImport: 30 });
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    ih.workerDeps.commitChunkSize = 7;
    ih.workerDeps.afterCommitChunk = (n) => {
      if (n === 2) throw new Error('worker died between transactions');
    };
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/commit`)).status).toBe(202);
    await ih.drain();
    expect(stageOf(await batchOf(w.admin, b.id), 'contacts').status).toBe('committing');
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM import_records WHERE stage_id = $1 AND outcome = 'imported'", [d.id]))[0]!.n).toBe(14);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(14);
    // the worker comes back: the retried job resumes after the 14 applied records
    delete ih.workerDeps.afterCommitChunk;
    await q("UPDATE jobs SET run_at = now() - interval '1 second' WHERE tenant_id = $1 AND kind = 'imports.commit' AND status = 'pending'", [w.tenantId]);
    await ih.drain();
    delete ih.workerDeps.commitChunkSize;
    const s = stageOf(await batchOf(w.admin, b.id), 'contacts');
    expect(s.status).toBe('committed');
    expect(s.counts).toMatchObject({ source: 30, imported: 30 });
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(30);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM external_refs WHERE tenant_id = $1 AND entity_type = 'contact'", [w.tenantId]))[0]!.n).toBe(30);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM lead_ownership_events WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(30);
    // 5 chunk transactions of ≤ 7 records
    expect(await txCount(d.id)).toBe(5);
  });

  it('R-IMPORT-4: at most 1,000 records per transaction', async () => {
    const w = await importWorld(ih);
    const b = await csvBatch(w, 1201);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    ih.workerDeps.commitChunkSize = 5000; // asking for more is clamped to 1,000
    const s = await commitStage(ih, w.admin, b.id, 'contacts');
    delete ih.workerDeps.commitChunkSize;
    expect(s.counts).toMatchObject({ source: 1201, imported: 1201 });
    expect(await txCount(d.id)).toBe(2);
  }, 120_000);

  it('R-IMPORT-4: a record error never aborts its batch: the record is rejected (COMMIT_FAILED), the rest commit, the recount says so', async () => {
    const w = await importWorld(ih);
    ih.fub.add('key-recerr-01', fubFixture({ prefix: 3000 }));
    const b = await startFub(ih, w.admin, 'key-recerr-01');
    await mapAgents(w.admin, b.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
    const recs = await (async () => {
      const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
      const rs = await records(w.admin, b.id, 'contacts');
      for (const r of rs.filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
      await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
      return rs;
    })();
    expect(recs.length).toBe(7);
    await commitStage(ih, w.admin, b.id, 'contacts');
    const { verify } = await import('./testing.js');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
    await fullStage(ih, w.admin, b.id, 'ownership');
    const d = await dryRunStage(ih, w.admin, b.id, 'notes');
    expect((await approve(w.admin, b.id, 'notes', d.dryRunSha256 as string)).status).toBe(200);
    // Bob's owner deletes him after the notes dry run was approved
    const bob = (await q<{ id: string; ownership_seq: string }>("SELECT id, ownership_seq FROM contacts WHERE tenant_id = $1 AND display_name = 'Bob Unsub'", [w.tenantId]))[0]!;
    const del = await call(w.agents[1]!, 'POST', `/leads/${bob.id}/delete`, { commandId: randomUUID() });
    expect(del.status).toBe(200);
    const s = await commitStage(ih, w.admin, b.id, 'notes');
    expect(s.status).toBe('committed');
    const after = await records(w.admin, b.id, 'notes');
    const bobNote = after.find((r) => r.sourceRef.endsWith('/30002'))!;
    expect(bobNote.outcome).toBe('rejected');
    expect(bobNote.issues.map((i) => i.code)).toContain('COMMIT_FAILED');
    expect(after.find((r) => r.sourceRef.endsWith('/30001'))!.outcome).toBe('imported');
    const v = await call<{ matches: boolean; diffs: { key: string }[] }>(w.admin, 'GET', `/imports/${b.id}/stages/notes/verification`);
    expect(v.body.matches).toBe(false);
    expect(v.body.diffs.map((x) => x.key).sort()).toEqual(['imported', 'rejected']);
  });
});

describe('concurrency', () => {
  it('R-IMPORT-4: two Admins tap Commit at the same moment: exactly one commit starts', async () => {
    const w = await importWorld(ih);
    const b = await csvBatch(w, 5, 100);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    const { freshReauth } = await import('./testing.js');
    await freshReauth(ih.h, w.owner);
    const [x, y] = await Promise.all([call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/commit`), call(w.owner, 'POST', `/imports/${b.id}/stages/contacts/commit`)]);
    expect([x.status, y.status].sort()).toEqual([202, 409]);
    expect([x.code, y.code]).toContain('IMPORT_STATE_CONFLICT');
    expect(await q("SELECT 1 FROM jobs WHERE tenant_id = $1 AND kind = 'imports.commit'", [w.tenantId])).toHaveLength(1);
    expect(await q("SELECT 1 FROM audit_log WHERE tenant_id = $1 AND action = 'import.committed'", [w.tenantId])).toHaveLength(1);
    await ih.drain();
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(5);
  });

  it('R-IMPORT-4 R-IMPORT-9: two workers running the same commit never apply a record twice', async () => {
    const w = await importWorld(ih);
    const b = await csvBatch(w, 40, 200);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/commit`)).status).toBe(202);
    const deps = { ...ih.deps, commitChunkSize: 5 };
    const results = await Promise.all([runCommit(deps, w.tenantId, d.id, { maxChunks: 100 }), runCommit(deps, w.tenantId, d.id, { maxChunks: 100 }), runCommit(deps, w.tenantId, d.id, { maxChunks: 100 })]);
    expect(results).toContain('done');
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(40);
    expect((await q<{ n: number }>("SELECT count(*)::int AS n FROM import_records WHERE stage_id = $1 AND outcome = 'imported'", [d.id]))[0]!.n).toBe(40);
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contact_points WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(80);
    expect(stageOf(await batchOf(w.admin, b.id), 'contacts').status).toBe('committed');
    // the queued job finds nothing left to do
    await ih.drain();
    expect((await q<{ n: number }>('SELECT count(*)::int AS n FROM contacts WHERE tenant_id = $1', [w.tenantId]))[0]!.n).toBe(40);
  });

  it('R-IMPORT-4: a review racing an approval never leaves an approval that ignores the review', async () => {
    const w = await importWorld(ih);
    const b = await csvBatch(w, 6, 300);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    const r0 = (await records(w.admin, b.id, 'contacts'))[0]!;
    const [rev, app] = await Promise.all([
      call(w.admin, 'POST', `/imports/${b.id}/records/${r0.id}/review`, { decision: 'reject' }),
      approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string),
    ]);
    expect(rev.status).toBe(200);
    expect(app.status).toBe(200);
    const st = (await q<{ status: string; expected_counts: { rejected: number } | null }>('SELECT status, expected_counts FROM import_stages WHERE id = $1', [d.id]))[0]!;
    // either the review came second (the approval was cleared) or first (the approval counted it)
    if (st.status === 'approved') expect(st.expected_counts!.rejected).toBe(1);
    else expect([st.status, st.expected_counts]).toEqual(['dry_run_ready', null]);
  });
});
