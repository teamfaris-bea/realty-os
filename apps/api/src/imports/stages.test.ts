// api/imports stage rules: dry-run-first, approval, order, reviewed-only commit, verification,
// idempotent re-runs, re-authentication (BUILD_PLAN module 16: "The stage-order DB guard", "Commit
// only of reviewed records"; R-IMPORT-2…5, R-IMPORT-9, R-PERM-13, R-AUDIT-5; E42, E44).
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditRows, staleReauth } from '../admin/testing.js';
import { systemActor } from '../worker/systemActor.js';
import {
  type BatchView,
  type ImportWorld,
  type ImportsHarness,
  approve,
  batchOf,
  call,
  commitStage,
  dryRunStage,
  freshReauth,
  fubFixture,
  fullStage,
  importWorld,
  importsHarness,
  mapAgents,
  records,
  stageOf,
  startFub,
  verify,
} from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
});
afterAll(async () => {
  await ih?.close();
});

async function world(key: string, prefix: number): Promise<{ w: ImportWorld; b: BatchView }> {
  const w = await importWorld(ih);
  ih.fub.add(key, fubFixture({ prefix }));
  const b = await startFub(ih, w.admin, key);
  await mapAgents(w.admin, b.id, w, [
    { sourceRef: '99', target: { kind: 'unassigned' } },
    { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } },
  ]);
  return { w, b };
}

describe('R-IMPORT-2: no commit without a completed dry run and an Owner/Admin approval', () => {
  it('R-IMPORT-2: the API refuses a commit before approval; the DB CHECK refuses it without dry run + approval', async () => {
    const { w, b } = await world('key-r2-000001', 2000);
    const r = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/commit`);
    expect([r.status, r.code]).toEqual([409, 'IMPORT_STATE_CONFLICT']);
    const stageId = stageOf(b, 'contacts').id;
    await expect(
      withTenantTx(w.admin.actor(), (tx) => sql`UPDATE import_stages SET status = 'committing' WHERE id = ${stageId}`.execute(tx), { db: ih.h.database }),
    ).rejects.toThrow(/check constraint/);
    // a dry run alone is not enough either
    await dryRunStage(ih, w.admin, b.id, 'contacts');
    await expect(
      withTenantTx(w.admin.actor(), (tx) => sql`UPDATE import_stages SET status = 'approved' WHERE id = ${stageId}`.execute(tx), { db: ih.h.database }),
    ).rejects.toThrow(/check constraint/);
  });

  it('R-IMPORT-2: only the acting Owner/Admin can be the approver (system or another user is refused by the DB)', async () => {
    const { w, b } = await world('key-r2-000002', 3000);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    await expect(
      withTenantTx(systemActor(w.tenantId, 'import'), (tx) => sql`UPDATE import_stages SET status = 'approved', approved_at = now(), approved_by_user_id = ${w.owner.userId}, expected_counts = '{}' WHERE id = ${d.id}`.execute(tx), { db: ih.h.database }),
    ).rejects.toThrow(/IMPORT_APPROVER_INVALID/);
    await expect(
      withTenantTx(w.admin.actor(), (tx) => sql`UPDATE import_stages SET status = 'approved', approved_at = now(), approved_by_user_id = ${w.owner.userId}, expected_counts = '{}' WHERE id = ${d.id}`.execute(tx), { db: ih.h.database }),
    ).rejects.toThrow(/IMPORT_APPROVER_INVALID/);
    const a = await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    expect(a.status).toBe(200);
    const row = (await q<{ approved_by_user_id: string }>('SELECT approved_by_user_id FROM import_stages WHERE id = $1', [d.id]))[0]!;
    expect(row.approved_by_user_id).toBe(w.admin.userId);
  });
});

describe('R-IMPORT-3: stages commit in dependency order', () => {
  it('R-IMPORT-3: a later stage may dry-run early, but commits only after earlier stages are verified or skipped (DB trigger)', async () => {
    const { w, b } = await world('key-r3-000001', 4000);
    // later stage dry-run before contacts commit: records point at the pending contacts plan
    const notes = await dryRunStage(ih, w.admin, b.id, 'notes');
    expect(notes.status).toBe('dry_run_ready');
    const ownership = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect((await approve(w.admin, b.id, 'ownership', ownership.dryRunSha256 as string)).status).toBe(200);
    const early = await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/commit`);
    expect([early.status, early.code]).toEqual([409, 'IMPORT_STAGE_ORDER']);
    // the trigger itself, below the API
    const st = stageOf(await batchOf(w.admin, b.id), 'ownership');
    await expect(withTenantTx(w.admin.actor(), (tx) => sql`UPDATE import_stages SET status = 'committing' WHERE id = ${st.id}`.execute(tx), { db: ih.h.database })).rejects.toThrow(/IMPORT_STAGE_ORDER/);
    // committed but not verified is still not enough
    const c = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', c.dryRunSha256 as string)).status).toBe(200);
    await commitStage(ih, w.admin, b.id, 'contacts');
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/commit`)).code).toBe('IMPORT_STAGE_ORDER');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
    // the ownership approval came from a dry run older than the contacts commit: run it again first
    const stale = await call(w.admin, 'POST', `/imports/${b.id}/stages/ownership/commit`);
    expect([stale.status, stale.code]).toEqual([409, 'IMPORT_DRY_RUN_STALE']);
    const n = await approve(w.admin, b.id, 'notes', notes.dryRunSha256 as string);
    expect([n.status, n.code]).toEqual([409, 'IMPORT_DRY_RUN_STALE']);
    await fullStage(ih, w.admin, b.id, 'ownership');
    // skipping a stage lets the next one commit
    expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/notes/skip`)).status).toBe(200);
    await fullStage(ih, w.admin, b.id, 'messages');
    expect(stageOf(await batchOf(w.admin, b.id), 'messages').status).toBe('verified');
  });
});

describe('R-IMPORT-4: a commit applies exactly the reviewed snapshot records', () => {
  it('R-IMPORT-4: undecided needs-review records are not written; a reviewer rejection is not written; a merge attaches to the candidate', async () => {
    const { w, b } = await world('key-r4-000001', 5000);
    // existing: an agent's "Jane Doe" (name-only match → candidate, never merged on its own: R-IMPORT-7)
    // and another agent's contact holding Bob's phone (an exact match on an owned contact → review, E41)
    const janeX = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Jane', lastName: 'Doe', phones: ['+14155524876'] });
    const robX = await call<{ contact: { id: string } }>(w.agents[1]!, 'POST', '/contacts', { commandId: crypto.randomUUID(), firstName: 'Robert', lastName: 'Smith', phones: ['+14155511002'] });
    expect([janeX.status, robX.status].every((x) => x === 200 || x === 201)).toBe(true);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    const recs = await records(w.admin, b.id, 'contacts');
    const jane = recs.find((r) => r.sourceRef === 'fub:people/5001')!;
    expect(jane.dryRunOutcome).toBe('needs_review');
    expect(jane.issues.map((i) => i.code)).toContain('NAME_ONLY_MATCH');
    expect(jane.duplicateCandidates.map((x) => x.contactId)).toEqual([janeX.body.contact.id]);
    const bob = recs.find((r) => r.sourceRef === 'fub:people/5002')!;
    expect(bob).toMatchObject({ dryRunOutcome: 'needs_review', matchContactId: robX.body.contact.id });
    expect(bob.issues.map((i) => i.code)).toContain('MATCH_OWNED_CONTACT');
    const carla = recs.find((r) => r.sourceRef === 'fub:people/5003')!;
    // a merge is offered only for records that need review, and only into a candidate
    const badMerge = await call(w.admin, 'POST', `/imports/${b.id}/records/${carla.id}/review`, { decision: 'merge', mergeIntoContactId: janeX.body.contact.id });
    expect([badMerge.status, badMerge.code]).toEqual([422, 'IMPORT_REVIEW_INVALID']);
    const badTarget = await call(w.admin, 'POST', `/imports/${b.id}/records/${jane.id}/review`, { decision: 'merge', mergeIntoContactId: robX.body.contact.id });
    expect([badTarget.status, badTarget.code]).toEqual([422, 'IMPORT_REVIEW_INVALID']);
    // reject Carla (will_import), merge Jane into the existing Jane, leave Bob undecided
    expect((await call(w.admin, 'POST', `/imports/${b.id}/records/${carla.id}/review`, { decision: 'reject' })).status).toBe(200);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/records/${jane.id}/review`, { decision: 'merge', mergeIntoContactId: janeX.body.contact.id })).status).toBe(200);
    const a = await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    expect(a.body.expected).toEqual({ source: 7, imported: 3, needs_review: 1, rejected: 3, duplicate: 0 });
    await commitStage(ih, w.admin, b.id, 'contacts');
    const names = (await q<{ display_name: string }>('SELECT display_name FROM contacts WHERE tenant_id = $1 ORDER BY display_name', [w.tenantId])).map((r) => r.display_name);
    expect(names).toEqual(['Dan Nostage', 'Erin Unmapped', 'Jane Doe', 'Robert Smith']);
    const after = await records(w.admin, b.id, 'contacts');
    expect(after.find((r) => r.sourceRef === 'fub:people/5002')!.outcome).toBe('needs_review');
    expect(after.find((r) => r.sourceRef === 'fub:people/5003')!.outcome).toBe('rejected');
    expect(after.find((r) => r.sourceRef === 'fub:people/5001')!).toMatchObject({ outcome: 'imported', targetId: janeX.body.contact.id });
    // the merge only filled what was empty; the owner did not change (R-OWN-21); Bob's match was not touched
    const jx = (await q<{ owner_user_id: string; emails: string[] }>("SELECT owner_user_id, (SELECT array_agg(address) FROM contact_points p WHERE p.contact_id = c.id AND p.kind = 'email') AS emails FROM contacts c WHERE id = $1", [janeX.body.contact.id]))[0]!;
    expect(jx).toEqual({ owner_user_id: w.agents[0]!.userId, emails: ['jane.5000@example.com'] });
    expect(await q("SELECT 1 FROM contact_points WHERE contact_id = $1 AND kind = 'email'", [robX.body.contact.id])).toHaveLength(0);
    const v = await verify(w.admin, b.id, 'contacts');
    expect(v.view.db).toEqual({ source: 7, imported: 3, needs_review: 1, rejected: 3, duplicate: 0 });
    expect(v.res.status).toBe(200);
  });

  it('R-IMPORT-4 E42: FUB changes after the snapshot do not reach the commit; a delta needs a new snapshot and dry run', async () => {
    const key = 'key-e42-00001';
    const { w, b } = await world(key, 6000);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
    ih.fub.mutate(key, (ds) => {
      (ds.people as Record<string, unknown>[])[1]!.name = 'Robert Changed';
      (ds.people as Record<string, unknown>[]).push({ id: 6999, firstName: 'Late', lastName: 'Arrival', emails: [{ value: 'late@example.com' }] });
    });
    await commitStage(ih, w.admin, b.id, 'contacts');
    const names = (await q<{ display_name: string }>('SELECT display_name FROM contacts WHERE tenant_id = $1', [w.tenantId])).map((r) => r.display_name);
    expect(names).toContain('Bob Unsub');
    expect(names).not.toContain('Robert Changed');
    expect(names).not.toContain('Late Arrival');
    // a delta snapshot: uncommitted stages go back to pending; an approval with the old digest is refused
    const own = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect((await call(w.admin, 'POST', `/imports/${b.id}/snapshot`)).status).toBe(202);
    await ih.drain();
    const nb = await batchOf(w.admin, b.id);
    expect(nb.snapshotSha256).not.toBe(b.snapshotSha256);
    expect(stageOf(nb, 'ownership').status).toBe('pending');
    expect(stageOf(nb, 'contacts').status).toBe('committed');
    const fresh = await dryRunStage(ih, w.admin, b.id, 'ownership');
    expect(fresh.dryRunSha256).not.toBe(own.dryRunSha256);
    const old = await approve(w.admin, b.id, 'ownership', own.dryRunSha256 as string);
    expect([old.status, old.code]).toEqual([409, 'SNAPSHOT_CHANGED']);
  });
});

describe('R-IMPORT-5: verification is a recount plus 20 spot checks, recorded with the verifier', () => {
  it('R-IMPORT-5: incomplete or failed spot checks and a recount mismatch are refused; success records the verifier', async () => {
    const { w, b } = await world('key-r5-000001', 7000);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    await commitStage(ih, w.admin, b.id, 'contacts');
    const v = await call<{ sample: { sourceRef: string; same: boolean }[]; matches: boolean }>(w.admin, 'GET', `/imports/${b.id}/stages/contacts/verification`);
    expect(v.body.matches).toBe(true);
    expect(v.body.sample.length).toBe(Math.min(20, 4));
    // the sample is deterministic per stage
    const v2 = await call<{ sample: { sourceRef: string }[] }>(w.admin, 'GET', `/imports/${b.id}/stages/contacts/verification`);
    expect(v2.body.sample.map((s) => s.sourceRef)).toEqual(v.body.sample.map((s) => s.sourceRef));
    const incomplete = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/verify`, { spotChecks: v.body.sample.slice(1).map((s) => ({ sourceRef: s.sourceRef, matches: true })) });
    expect([incomplete.status, incomplete.code]).toEqual([422, 'SPOT_CHECKS_INCOMPLETE']);
    const failed = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/verify`, { spotChecks: v.body.sample.map((s, i) => ({ sourceRef: s.sourceRef, matches: i !== 0 })) });
    expect([failed.status, failed.code]).toEqual([409, 'SPOT_CHECK_FAILED']);
    const ok = await verify(w.admin, b.id, 'contacts');
    expect(ok.res.status).toBe(200);
    const row = (await q<{ status: string; verified_by_user_id: string; verification: { recount: unknown; spotChecks: unknown[] } }>('SELECT status, verified_by_user_id, verification FROM import_stages WHERE id = $1', [d.id]))[0]!;
    expect(row.status).toBe('verified');
    expect(row.verified_by_user_id).toBe(w.admin.userId);
    expect(row.verification.spotChecks).toHaveLength(4);
    expect(row.verification.recount).toBeDefined();
  });

  it('R-IMPORT-5: a recount that does not match the reviewed plan refuses verification (details.diffs)', async () => {
    const { w, b } = await world('key-r5-000002', 7500);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    await commitStage(ih, w.admin, b.id, 'contacts');
    const v = await call<{ sample: { sourceRef: string }[] }>(w.admin, 'GET', `/imports/${b.id}/stages/contacts/verification`);
    // a row the import wrote disappears behind the import's back (superuser fixture)
    const target = (await q<{ target_id: string }>("SELECT r.target_id FROM import_records r JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'contacts' AND r.outcome = 'imported' LIMIT 1", [b.id]))[0]!;
    await q('DELETE FROM contacts WHERE id = $1', [target.target_id]);
    const now = await call<{ matches: boolean; diffs: { key: string; source: number; db: number }[] }>(w.admin, 'GET', `/imports/${b.id}/stages/contacts/verification`);
    expect(now.body.matches).toBe(false);
    expect(now.body.diffs).toEqual([{ key: 'imported', source: 4, db: 3 }]);
    const mm = await call<{ error: { details: { diffs: unknown[] } } }>(w.admin, 'POST', `/imports/${b.id}/stages/contacts/verify`, { spotChecks: v.body.sample.map((s) => ({ sourceRef: s.sourceRef, matches: true })) });
    expect([mm.status, mm.code]).toEqual([409, 'RECOUNT_MISMATCH']);
    expect(mm.body.error.details.diffs).toHaveLength(1);
    expect(stageOf(await batchOf(w.admin, b.id), 'contacts').status).toBe('committed');
  });
});

describe('R-IMPORT-9 E44: re-running an import is idempotent', () => {
  it('R-IMPORT-9 E44 R-OWN-21: the same FUB data imported twice updates or skips, never duplicates, never changes an owner', async () => {
    const key = 'key-e44-00001';
    const { w, b } = await world(key, 8000);
    for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) await fullStage(ih, w.admin, b.id, c);
    const counts = async () =>
      (await q<Record<string, number>>(
        `SELECT (SELECT count(*)::int FROM contacts WHERE tenant_id = $1) AS contacts, (SELECT count(*)::int FROM notes WHERE tenant_id = $1) AS notes,
                (SELECT count(*)::int FROM messages WHERE tenant_id = $1) AS messages, (SELECT count(*)::int FROM calls WHERE tenant_id = $1) AS calls,
                (SELECT count(*)::int FROM consent_events WHERE tenant_id = $1) AS consent, (SELECT count(*)::int FROM suppressions WHERE tenant_id = $1) AS sup,
                (SELECT count(*)::int FROM contact_points WHERE tenant_id = $1) AS points`,
        [w.tenantId],
      ))[0]!;
    const first = await counts();
    const owners = async () => q<{ id: string; ownership_state: string; owner_user_id: string | null; ownership_seq: string }>('SELECT id, ownership_state, owner_user_id, ownership_seq FROM contacts WHERE tenant_id = $1 ORDER BY id', [w.tenantId]);
    const ownersBefore = await owners();
    // a re-run of the dry run in the same batch reuses (stage, source_ref)
    const r1 = await q<{ n: number }>("SELECT count(*)::int AS n FROM import_records r JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'contacts'", [b.id]);
    // a second batch from the same account
    const again = await startFub(ih, w.admin, key);
    await mapAgents(w.admin, again.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
    const c2 = await dryRunStage(ih, w.admin, again.id, 'contacts');
    expect(c2.counts!.willImport).toBe(0);
    const recs = await records(w.admin, again.id, 'contacts');
    expect(recs.filter((r) => r.dryRunOutcome === 'duplicate').every((r) => r.issues.some((i) => i.code === 'ALREADY_IMPORTED'))).toBe(true);
    for (const r of recs.filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${again.id}/records/${r.id}/review`, { decision: 'reject' });
    for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent'] as const) {
      const d = await dryRunStage(ih, w.admin, again.id, c);
      expect(d.counts!.willImport).toBe(0);
    }
    expect(await counts()).toEqual(first);
    // the second run's ownership stage plans nothing: an import re-run never changes owners
    const own2 = await records(w.admin, again.id, 'ownership');
    expect(own2.filter((r) => r.dryRunOutcome === 'will_import')).toEqual([]);
    expect(await owners()).toEqual(ownersBefore);
    const r2 = await q<{ n: number }>("SELECT count(*)::int AS n FROM import_records r JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'contacts'", [b.id]);
    expect(r2).toEqual(r1);
  });
});

describe('R-PERM-13 R-PERM-5: imports are Owner/Admin with a fresh re-authentication', () => {
  it('R-PERM-13: every import step needs re-authentication within 15 minutes; others get 404', async () => {
    const { w, b } = await world('key-perm-0001', 9000);
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    await staleReauth(ih.h, w.admin);
    for (const [m, url, body] of [
      ['POST', `/imports/${b.id}/stages/contacts/approve`, { snapshotSha256: d.dryRunSha256 }],
      ['POST', `/imports/${b.id}/stages/contacts/commit`, {}],
      ['POST', `/imports/${b.id}/stages/contacts/verify`, { spotChecks: [] }],
      ['POST', `/imports/${b.id}/revert`, {}],
      ['POST', '/imports', { source: 'fub_api', apiKey: 'key-perm-0001' }],
      ['GET', `/imports/${b.id}/report`, undefined],
    ] as const) {
      const r = await call(w.admin, m, url, body);
      expect([url, r.status, r.code]).toEqual([url, 401, 'REAUTH_REQUIRED']);
    }
    await freshReauth(ih.h, w.agents[0]!);
    for (const url of [`/imports/${b.id}`, `/imports/${b.id}/report`, `/imports/${b.id}/stages/contacts/records`]) {
      const r = await call(w.agents[0]!, 'GET', url);
      expect([url, r.status, r.code]).toEqual([url, 404, 'NOT_FOUND']);
    }
    const r = await call(w.agents[0]!, 'POST', `/imports/${b.id}/stages/contacts/approve`, { snapshotSha256: d.dryRunSha256 });
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    // the Owner may run imports too
    await freshReauth(ih.h, w.owner);
    expect((await call(w.owner, 'GET', `/imports/${b.id}`)).status).toBe(200);
  });

  it('R-AUDIT-5: import approve / commit / verify / revert are audited as the acting user', async () => {
    const { w, b } = await world('key-audit-001', 9500);
    await freshReauth(ih.h, w.admin);
    await fullStage(ih, w.admin, b.id, 'contacts');
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, {})).status).toBe(202);
    await ih.drain();
    const rows = await auditRows(ih.h, w.tenantId, 'import.');
    expect(rows.map((r) => r.action)).toEqual(['import.approved', 'import.committed', 'import.verified', 'import.reverted']);
    for (const r of rows) expect([r.actor_user_id, r.actor_role, r.entity_type]).toEqual([w.admin.userId, 'admin', 'import_stage']);
  });
});
