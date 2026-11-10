// FUB key purge, field encryption of raw rows, transcription setting (R-IMPORT-11, R-DATA-1,
// R-IMPORT-12; BUILD_PLAN module 16 "FUB key purge").
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DecryptError } from '../crypto/primitives.js';
import { systemActor } from '../worker/systemActor.js';
import { type BatchView, type ImportWorld, type ImportsHarness, approve, call, commitStage, dryRunStage, fubFixture, fullStage, importWorld, importsHarness, mapAgents, records, startFub, verify } from './testing.js';

let ih: ImportsHarness;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
});
afterAll(async () => {
  await ih?.close();
});

async function fub(key: string, prefix: number): Promise<{ w: ImportWorld; b: BatchView }> {
  const w = await importWorld(ih);
  ih.fub.add(key, fubFixture({ prefix }));
  const b = await startFub(ih, w.admin, key);
  await mapAgents(w.admin, b.id, w, [{ sourceRef: '99', target: { kind: 'unassigned' } }, { sourceRef: '3', kind: 'pond', target: { kind: 'pond', pondId: w.defaultPondId } }]);
  return { w, b };
}

const cred = async (tenantId: string) =>
  (await q<{ status: string; secret_enc: Buffer | null; purge_after: Date | null; purged_at: Date | null }>("SELECT status, secret_enc, purge_after, purged_at FROM provider_credentials WHERE tenant_id = $1 AND provider = 'fub'", [tenantId]))[0]!;

describe('R-IMPORT-11: the FUB credential is purged', () => {
  it('R-IMPORT-11: at most 30 days after the last stage is verified (the retention sweep nulls it)', async () => {
    const { w, b } = await fub('key-purge-0001', 1100);
    await fullStage(ih, w.admin, b.id, 'contacts');
    expect((await cred(w.tenantId)).purge_after).toBeNull();
    await fullStage(ih, w.admin, b.id, 'ownership');
    for (const c of ['notes', 'messages', 'call_recordings'] as const) expect((await call(w.admin, 'POST', `/imports/${b.id}/stages/${c}/skip`)).status).toBe(200);
    expect((await cred(w.tenantId)).purge_after).toBeNull();
    await fullStage(ih, w.admin, b.id, 'consent');
    const c = await cred(w.tenantId);
    expect(c.status).toBe('active');
    const days = (c.purge_after!.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
    await q("SELECT app.retention_sweep(now() + interval '30 days 1 minute')");
    const after = await cred(w.tenantId);
    expect([after.status, after.secret_enc, after.purged_at !== null]).toEqual(['purged', null, true]);
  });

  it('R-IMPORT-11: abandoning an import purges the key at once; an import with committed rows must be reverted first', async () => {
    const { w, b } = await fub('key-purge-0002', 1200);
    await fullStage(ih, w.admin, b.id, 'contacts');
    const refused = await call(w.admin, 'POST', `/imports/${b.id}/abandon`);
    expect([refused.status, refused.code]).toEqual([409, 'IMPORT_STATE_CONFLICT']);
    expect((await call(w.admin, 'POST', `/imports/${b.id}/revert`, {})).status).toBe(202);
    await ih.drain();
    const r = await call<{ batch: BatchView }>(w.admin, 'POST', `/imports/${b.id}/abandon`);
    expect([r.status, r.body]).toMatchObject([200, { batch: { status: 'abandoned' } }]);
    const c = await cred(w.tenantId);
    expect([c.status, c.secret_enc]).toEqual(['purged', null]);
    // the snapshot and the unused recording copies go to the blob-delete job
    const objs = await q<{ purpose: string; deleted: boolean }>('SELECT purpose, deleted_at IS NOT NULL AS deleted FROM stored_objects WHERE tenant_id = $1 ORDER BY purpose', [w.tenantId]);
    expect(objs.length).toBeGreaterThan(0);
    for (const o of objs) expect(o.deleted).toBe(true);
    // nothing can be snapshotted any more
    const s = await call(w.admin, 'POST', `/imports/${b.id}/snapshot`);
    expect([s.status, s.code]).toEqual([409, 'IMPORT_STATE_CONFLICT']);
  });

  it('R-IMPORT-11: a wrong key is refused at the connection test and never stored', async () => {
    const w = await importWorld(ih);
    const r = await call(w.admin, 'POST', '/imports', { source: 'fub_api', apiKey: 'not-a-known-key' });
    expect([r.status, r.code]).toEqual([422, 'FUB_KEY_INVALID']);
    expect(await q("SELECT 1 FROM provider_credentials WHERE tenant_id = $1 AND provider = 'fub'", [w.tenantId])).toHaveLength(0);
  });
});

describe('R-DATA-1: import raw rows are field-encrypted, bound to their row', () => {
  it('R-DATA-1: raw_enc holds no plaintext and decrypts only with its own row AAD', async () => {
    const { w, b } = await fub('key-raw-00001', 1300);
    const r = await call(w.admin, 'POST', `/imports/${b.id}/stages/contacts/dry-run`);
    expect(r.status).toBe(202);
    await ih.drain();
    const rows = await q<{ id: string; raw_enc: Buffer }>("SELECT r.id, r.raw_enc FROM import_records r JOIN import_stages s ON s.id = r.stage_id WHERE s.batch_id = $1 AND s.category = 'contacts' ORDER BY r.id", [b.id]);
    expect(rows.length).toBe(7);
    for (const x of rows) expect(x.raw_enc.toString('latin1')).not.toMatch(/Jane|Unsub|example\.com/);
    const [a, z] = [rows[0]!, rows[1]!];
    const tid = w.tenantId as TenantId;
    await withTenantTx(
      systemActor(w.tenantId, 'import'),
      async (tx) => {
        const env = ih.deps.envelope.inTx(tx, tid);
        const pt = await env.decrypt(tid, { table: 'import_records', column: 'raw_enc', rowId: a.id }, new Uint8Array(a.raw_enc));
        expect(JSON.parse(new TextDecoder().decode(pt))).toMatchObject({ id: 1301 });
        await expect(env.decrypt(tid, { table: 'import_records', column: 'raw_enc', rowId: z.id }, new Uint8Array(a.raw_enc))).rejects.toBeInstanceOf(DecryptError);
      },
      { db: ih.h.database },
    );
  });
});

describe('R-IMPORT-12: imported recordings', () => {
  it('R-IMPORT-12: with transcribe_imported_recordings on, an imported recording is queued for transcription (still labelled)', async () => {
    const { w, b } = await fub('key-trans-0001', 1400);
    await q('UPDATE tenant_settings SET transcribe_imported_recordings = true WHERE tenant_id = $1', [w.tenantId]);
    // Jane (the caller with a recording) needs review in contacts: the reviewer imports her
    const d = await dryRunStage(ih, w.admin, b.id, 'contacts');
    for (const r of (await records(w.admin, b.id, 'contacts')).filter((x) => x.dryRunOutcome === 'needs_review')) await call(w.admin, 'POST', `/imports/${b.id}/records/${r.id}/review`, { decision: 'import' });
    await approve(w.admin, b.id, 'contacts', d.dryRunSha256 as string);
    await commitStage(ih, w.admin, b.id, 'contacts');
    expect((await verify(w.admin, b.id, 'contacts')).res.status).toBe(200);
    await fullStage(ih, w.admin, b.id, 'ownership');
    for (const c of ['notes', 'messages'] as const) await call(w.admin, 'POST', `/imports/${b.id}/stages/${c}/skip`);
    await fullStage(ih, w.admin, b.id, 'call_recordings');
    const recs = await q<{ id: string; consent_basis: string }>('SELECT id, consent_basis FROM recordings WHERE tenant_id = $1', [w.tenantId]);
    expect(recs).toHaveLength(1);
    const jobs = await q<{ payload: { recordingId: string } }>("SELECT payload FROM jobs WHERE tenant_id = $1 AND kind = 'comms.transcribe'", [w.tenantId]);
    expect(jobs.map((j) => j.payload.recordingId).sort()).toEqual(recs.map((r) => r.id).sort());
    for (const r of recs) expect(r.consent_basis).toBe('unknown_imported');
  });
});
