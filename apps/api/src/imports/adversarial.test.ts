// Adversarial verification of api/imports (BUILD_PLAN module 16): each test pins a defect found by
// trying to break the module, and the behaviour the rules require instead.
//   - R-IMPORT-10 / E43: a revert never auto-deletes a contact a human worked on after the import
//     (a task, a deal, a saved search, a phone number an agent added), not only edits/messages/reassigns.
//   - The revert definer (app.import_revert_delete) never touches a recording it does not delete.
//   - R-CONSENT-3 / E40: skipping the consent stage can never drop imported opt-outs or DNC flags.
//   - R-IMPORT-11: the FUB key purge is scheduled however the last stage is settled (verify or skip),
//     and when a batch is fully reverted (it can never be used again).
//   - R-PERM-5 / R-TEN: another tenant's Owner/Admin gets 404 for every import step, and changes nothing.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FubDataset } from './fub.js';
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

async function fubWorld(key: string, prefix: number, data?: FubDataset): Promise<{ w: ImportWorld; b: BatchView }> {
  const w = await importWorld(ih);
  ih.fub.add(key, data ?? fubFixture({ prefix }));
  const b = await startFub(ih, w.admin, key);
  await mapAgents(w.admin, b.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
  const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
  for (const r of (await records(w.admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
  expect((await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string)).status).toBe(200);
  await commitStage(ih, w.admin, b.id, 'contacts');
  expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
  return { w, b };
}

const contactByName = async (tenantId: string, name: string) =>
  (await q<{ id: string; deleted_at: Date | null }>('SELECT id, deleted_at FROM contacts WHERE tenant_id = $1 AND display_name = $2', [tenantId, name]))[0]!;

const cred = async (tenantId: string) =>
  (await q<{ status: string; purge_after: Date | null }>("SELECT status, purge_after FROM provider_credentials WHERE tenant_id = $1 AND provider = 'fub'", [tenantId]))[0]!;

const skip = (w: ImportWorld, batchId: string, cat: string) => call(w.admin, 'POST', `/imports/${batchId}/stages/${cat}/skip`);

describe('R-IMPORT-10 E43: work done on an imported contact makes it touched', () => {
  it('R-IMPORT-10 E43: a revert lists, never deletes, contacts that got a task, a deal, a saved search or an agent-added phone after the import', async () => {
    const { w, b } = await fubWorld('key-adv-touch1', 5100);
    const agent = w.agents[0]!.userId;
    const bob = await contactByName(w.tenantId, 'Bob Unsub');
    const carla = await contactByName(w.tenantId, 'Carla Dnc');
    const dan = await contactByName(w.tenantId, 'Dan Nostage');
    const erin = await contactByName(w.tenantId, 'Erin Unmapped');
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    // fixtures: this build has no task / deal / saved-search-create / add-phone routes yet; each row is what those paths write
    await q("INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, created_by_kind, created_by_user_id) VALUES ($1, $2, $3, $4, 'callback', 'Call Bob back', 'user', $3)", [w.tenantId, randomUUID(), agent, bob.id]);
    await q("INSERT INTO deals (tenant_id, id, name, side, stage_entered_at, primary_contact_id, owner_user_id, created_by_user_id) VALUES ($1, $2, 'Carla buy', 'buy', now(), $3, $4, $4)", [w.tenantId, randomUUID(), carla.id, agent]);
    await q("INSERT INTO saved_searches (tenant_id, id, contact_id, name, criteria) VALUES ($1, $2, $3, '3 beds', '{}')", [w.tenantId, randomUUID(), dan.id]);
    const manualPoint = randomUUID();
    await q("INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label) VALUES ($1, $2::uuid, $3::uuid, 'phone', '+14155559876', decode(md5($2::text) || md5($3::text), 'hex'), 'mobile')", [w.tenantId, manualPoint, erin.id]);

    const r = await call(w.admin, 'POST', `/imports/${b.id}/revert`, {});
    expect(r.status).toBe(202);
    await ih.drain();
    const nb = await batchOf(w.admin, b.id);
    for (const c of [bob, carla, dan, erin]) expect((await q<{ deleted_at: Date | null }>('SELECT deleted_at FROM contacts WHERE id = $1', [c.id]))[0]!.deleted_at).toBeNull();
    expect((await q<{ deleted_at: Date | null }>('SELECT deleted_at FROM contacts WHERE id = $1', [jane.id]))[0]!.deleted_at).not.toBeNull();
    expect(await q('SELECT 1 FROM contact_points WHERE id = $1', [manualPoint])).toHaveLength(1);
    const rep = stageOf(nb, 'contacts').revert as { manual: { sourceRef: string; reason: string }[] };
    const touched = rep.manual.filter((m) => m.reason === 'TOUCHED').map((m) => m.sourceRef).sort();
    expect(touched).toEqual(['fub:people/5102', 'fub:people/5103', 'fub:people/5104', 'fub:people/5105']);
  });
});

describe('revert definer (SECURITY DEFINER app.import_revert_delete)', () => {
  it('R-IMPORT-10: a call that is not the reverting stage’s keeps its recording (nothing is marked deleted)', async () => {
    const { w, b } = await fubWorld('key-adv-defrec', 5200);
    for (const c of ['ownership', 'notes', 'messages', 'call_recordings'] as const) await fullStage(ih, w.admin, b.id, c);
    const jane = await contactByName(w.tenantId, 'Jane Doe');
    const rec = (await q<{ call_id: string; object_id: string }>('SELECT call_id, object_id FROM recordings WHERE contact_id = $1', [jane.id]))[0]!;
    const notesStage = stageOf(await batchOf(w.admin, b.id), 'notes');
    await q("UPDATE import_stages SET status = 'reverting' WHERE id = $1", [notesStage.id]);
    const out = await withTenantTx(
      w.admin.actor(),
      async (tx) => (await sql<{ id: string }>`SELECT x::text AS id FROM app.import_revert_delete(${notesStage.id}::uuid, 'calls', ${[rec.call_id]}::uuid[]) x`.execute(tx)).rows,
      { db: ih.h.database },
    );
    expect(out).toEqual([]);
    expect(await q('SELECT 1 FROM calls WHERE id = $1', [rec.call_id])).toHaveLength(1);
    expect((await q<{ deleted_at: Date | null }>('SELECT deleted_at FROM stored_objects WHERE id = $1', [rec.object_id]))[0]!.deleted_at).toBeNull();
  });
});

describe('R-CONSENT-3 E40: imported opt-outs cannot be skipped away', () => {
  it('R-CONSENT-3: the consent stage cannot be skipped while its source carries opt-outs or DNC flags; committing it applies them', async () => {
    const { w, b } = await fubWorld('key-adv-cskip1', 5300);
    for (const c of ['ownership', 'notes', 'messages', 'call_recordings']) expect((await skip(w, b.id, c)).status).toBe(200);
    const early = await skip(w, b.id, 'consent');
    expect([early.status, early.code]).toEqual([409, 'IMPORT_STATE_CONFLICT']);
    await dryRunStage(ih, w.admin, b.id, 'consent');
    const after = await skip(w, b.id, 'consent');
    expect([after.status, after.code, (after.body as { error: { details?: { status?: string } } }).error.details?.status]).toEqual([409, 'IMPORT_STATE_CONFLICT', 'consent_opt_outs_pending']);
    expect(stageOf(await batchOf(w.admin, b.id), 'consent').status).toBe('dry_run_ready');
    await fullStage(ih, w.admin, b.id, 'consent');
    expect(await q("SELECT 1 FROM consent_events WHERE tenant_id = $1 AND event_type = 'revoke' AND imported", [w.tenantId])).not.toHaveLength(0);
  });

  it('R-CONSENT-3: a CSV without consent columns, or a batch whose contacts stage was skipped, may skip consent', async () => {
    const w = await importWorld(ih);
    const cr = await call<{ batch: BatchView }>(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'plain.csv', fileBase64: csvBase64(csvOf(3, 900)) });
    const bid = cr.body.batch.id;
    await call(w.admin, 'POST', `/imports/${bid}/snapshot`);
    await ih.drain();
    await fullStage(ih, w.admin, bid, 'contacts');
    expect((await skip(w, bid, 'consent')).status).toBe(200);
    expect((await batchOf(w.admin, bid)).status).toBe('committed');

    ih.fub.add('key-adv-cskip2', fubFixture({ prefix: 5400 }));
    const fb = await startFub(ih, w.admin, 'key-adv-cskip2');
    for (const c of ['contacts', 'ownership', 'notes', 'messages', 'call_recordings', 'consent']) expect((await skip(w, fb.id, c)).status).toBe(200);
  });
});

describe('R-IMPORT-11: the FUB key purge follows the batch however it ends', () => {
  it('R-IMPORT-11: when the last stage is settled by a skip, the batch is committed and the key purge is scheduled (≤ 30 days)', async () => {
    const clean: FubDataset = {
      users: [{ id: 11, name: 'Alex Agent' }],
      people: [{ id: 1, created: '2024-01-01T00:00:00Z', firstName: 'Ann', lastName: 'Clean', assignedUserId: 11, phones: [{ value: '(415) 555-4411', type: 'mobile', status: 'Valid' }] }],
      notes: [],
      textMessages: [],
      emails: [],
      calls: [],
    };
    const w = await importWorld(ih);
    ih.fub.add('key-adv-purge1', clean);
    const b = await startFub(ih, w.admin, 'key-adv-purge1');
    await call(w.admin, 'PUT', `/imports/${b.id}/user-mappings`, { mappings: [{ sourceRef: '11', target: { kind: 'user', userId: w.agents[0]!.userId } }] });
    await fullStage(ih, w.admin, b.id, 'contacts');
    for (const c of ['ownership', 'notes', 'messages', 'call_recordings']) expect((await skip(w, b.id, c)).status).toBe(200);
    await dryRunStage(ih, w.admin, b.id, 'consent');
    expect((await cred(w.tenantId)).purge_after).toBeNull();
    expect((await skip(w, b.id, 'consent')).status).toBe(200);
    expect((await batchOf(w.admin, b.id)).status).toBe('committed');
    const c = await cred(w.tenantId);
    const days = (c.purge_after!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it('R-IMPORT-11: a fully reverted batch (which can never snapshot or commit again) schedules the key purge', async () => {
    const { w, b } = await fubWorld('key-adv-purge2', 5500);
    expect((await cred(w.tenantId)).purge_after).toBeNull();
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, {})).status).toBe(202);
    await ih.drain();
    expect((await batchOf(w.admin, b.id)).status).toBe('reverted');
    const c = await cred(w.tenantId);
    expect(c.purge_after).not.toBeNull();
    expect((c.purge_after!.getTime() - Date.now()) / 86_400_000).toBeLessThanOrEqual(30);
  });
});

describe('R-PERM-5 R-TEN: tenant isolation of imports', () => {
  it('R-PERM-5: another tenant’s Owner/Admin gets 404 on every step of a batch, and nothing changes', async () => {
    const { w, b } = await fubWorld('key-adv-tenant', 5600);
    const other = await importWorld(ih);
    const mine = await call<{ batch: BatchView }>(other.admin, 'POST', '/imports', { source: 'csv', fileName: 'x.csv', fileBase64: csvBase64(csvOf(2, 700)) });
    const rec = (await records(w.admin, b.id, 'contacts'))[0]!;
    const steps: [string, string, unknown?][] = [
      ['GET', `/imports/${b.id}`],
      ['GET', `/imports/${b.id}/report`],
      ['GET', `/imports/${b.id}/user-mappings`],
      ['GET', `/imports/${b.id}/stages/contacts/records`],
      ['GET', `/imports/${b.id}/stages/contacts/verification`],
      ['POST', `/imports/${b.id}/snapshot`],
      ['POST', `/imports/${b.id}/stages/ownership/dry-run`],
      ['POST', `/imports/${b.id}/stages/ownership/skip`],
      ['POST', `/imports/${b.id}/records/${rec.id}/review`, { decision: 'reject' }],
      ['POST', `/imports/${mine.body.batch.id}/records/${rec.id}/review`, { decision: 'reject' }],
      ['POST', `/imports/${b.id}/revert`, {}],
      ['POST', `/imports/${b.id}/abandon`],
    ];
    for (const [m, path, body] of steps) {
      const r = await call(other.admin, m as 'GET', path, body);
      expect([path, r.status]).toEqual([path, 404]);
    }
    const listed = await call<{ batches: { id: string }[] }>(other.admin, 'GET', '/imports');
    expect(listed.body.batches.map((x) => x.id)).toEqual([mine.body.batch.id]);
    const nb = await batchOf(w.admin, b.id);
    expect(nb.status).not.toBe('reverting');
    expect(stageOf(nb, 'ownership').status).toBe('pending');
    expect((await cred(w.tenantId)).status).toBe('active');
  });
});
