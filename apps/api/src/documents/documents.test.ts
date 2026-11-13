// api/documents through the real server on real Postgres, fakes only (PHASE2_3_PLAN §5.4 #42; DATA_MODEL Part 2
// R-DOC-1..10, E130, E400-E411, E419). Every write goes through the routes as app_user; the superuser pool reads back.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { withTenantTx } from '@realty/db';
import { freshReauth } from '../admin/testing.js';
import { blobDeleteHandler } from '../worker/handlers/blobDelete.js';
import { systemActor } from '../worker/systemActor.js';
import { ProviderError } from '../providers/types.js';
import { COPY, previousVersionSharedText } from './copy.js';
import { EXTRACTOR_NOT_SET_UP, FAKE_UNSCANNABLE_MARKER, SCANNER_NOT_SET_UP, SCANNER_TEST_TEXT, UnconfiguredScanner, UnconfiguredTextExtractor } from './provider.js';
import { setUploadLimitClockForTests } from './upload.js';
import { DOCUMENT_JOBS, DOCUMENT_MAX_BYTES } from './types.js';
import { type DocBody, type DocWorld, call, docDeps, docWorld, eicarBytes, jobsOf, jpegBytes, makeDeal, makeListing, multipart, pdfBytes, pngBytes, rawPost, runReconcile, runScan, upload } from './testing.js';

let h: ApiHarness;
let w: DocWorld;
let deal: { dealId: string; contactId: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await docWorld(h);
  deal = await makeDeal(w, w.agents[0]!);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const docs = (id: string) => `/deals/${id}/documents`;
async function uploadClean(c = w.agents[0]!, url = docs(deal.dealId), o: Parameters<typeof upload>[2] = {}): Promise<string> {
  const r = await upload(c, url, o);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await runScan(h, w.tenantId, r.body.document.id);
  return r.body.document.id;
}
const rowsOf = async (sqlText: string, v: unknown[] = []) => (await h.su.query(sqlText, v)).rows;
const docCount = async () => Number((await rowsOf('SELECT count(*)::int AS n FROM documents WHERE tenant_id = $1', [w.tenantId]))[0]!.n);
const objCount = async () => Number((await rowsOf("SELECT count(*)::int AS n FROM stored_objects WHERE tenant_id = $1 AND purpose = 'document'", [w.tenantId]))[0]!.n);

describe('upload (R-DOC-3, R-DOC-5)', () => {
  it('R-DOC-5: a PDF, a JPEG and a PNG are accepted by their bytes; every upload starts pending and unshared; a scan job is enqueued (ids only)', async () => {
    for (const [bytes, type] of [[pdfBytes(), 'application/pdf'], [jpegBytes(), 'image/jpeg'], [pngBytes(), 'image/png']] as const) {
      const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes, type, filename: `file.${type.split('/')[1]}`, kind: 'disclosure' });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.document).toMatchObject({ scan: 'checking', scanText: COPY.checking, versionNo: 1, kind: 'disclosure', portal: { shared: false } });
      const jobs = await jobsOf(h, w.tenantId, DOCUMENT_JOBS.scan);
      expect(jobs.at(-1)).toMatchObject({ payload: { documentId: r.body.document.id }, dedupe_key: `${DOCUMENT_JOBS.scan}:${r.body.document.id}` });
    }
  });

  it('E400 R-DOC-5: SVG, HTML, DOCX, ZIP, a PDF declared as a JPEG and an empty file are DOCUMENT_TYPE_NOT_ALLOWED; nothing is stored', async () => {
    const before = [await docCount(), await objCount()];
    const enc = (s: string) => new TextEncoder().encode(s);
    const cases: [Uint8Array, string, string][] = [
      [enc('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'image/svg+xml', 'a.svg'],
      [enc('<!doctype html><p>hi</p>'), 'text/html', 'a.html'],
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'a.docx'],
      [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 9, 9]), 'application/zip', 'a.zip'],
      [pdfBytes(), 'image/jpeg', 'a.jpg'],
      [new Uint8Array(), 'application/pdf', 'empty.pdf'],
    ];
    for (const [bytes, type, filename] of cases) {
      const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes, type, filename });
      expect([r.status, r.code], filename).toEqual([422, 'DOCUMENT_TYPE_NOT_ALLOWED']);
    }
    expect([await docCount(), await objCount()]).toEqual(before);
  });

  it('E401 R-DOC-5: a body over the cap is 413 before it is read, and an oversized part is DOCUMENT_TOO_LARGE; neither leaves a row', async () => {
    const before = [await docCount(), await objCount()];
    const big = await rawPost(w.agents[0]!, docs(deal.dealId), Buffer.alloc(10), 'multipart/form-data; boundary=x', { 'content-length': String(DOCUMENT_MAX_BYTES + 70_000) });
    expect(big.statusCode).toBe(413);
    const part = new Uint8Array(DOCUMENT_MAX_BYTES + 1);
    part.set(new TextEncoder().encode('%PDF-1.4\n'));
    const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes: part });
    expect([r.status, r.code]).toEqual([413, 'DOCUMENT_TOO_LARGE']);
    expect([await docCount(), await objCount()]).toEqual(before);
  });

  it('R-DOC-5: a gzip-encoded body is refused before it is read; an anonymous caller gets 401 first', async () => {
    const m = await multipart([{ name: 'file', value: { bytes: pdfBytes(), type: 'application/pdf', filename: 'a.pdf' } }, { name: 'kind', value: 'other' }]);
    const gz = await rawPost(w.agents[0]!, docs(deal.dealId), m.body, m.contentType, { 'content-encoding': 'gzip' });
    expect(gz.statusCode).toBe(415);
    const anon = await h.app.inject({ method: 'POST', url: `/api${docs(deal.dealId)}`, headers: { 'content-type': m.contentType, origin: 'http://localhost:5173' }, payload: m.body });
    expect(anon.statusCode).toBe(401);
  });

  it('R-DOC-5: names with CR/LF, bidi characters, paths or 300 characters are cleaned; no name reaches an audit row, a job payload or a log', async () => {
    const marker = `Secret${Date.now()}`;
    const cases: [string, string | undefined, string][] = [
      [`C:\\Users\\x\\${marker}\r\nInjected.pdf`, undefined, `${marker} Injected.pdf`],
      [`${marker}\u202Efdp.exe`, undefined, `${marker}fdp.exe`],
      ['a.pdf', `${'n'.repeat(300)}`, 'n'.repeat(200)],
      ['../../etc/x.pdf', `  ${marker}\u0007\u200F typed  `, `${marker} typed`],
    ];
    for (const [filename, displayName, expected] of cases) {
      const r = await upload(w.agents[0]!, docs(deal.dealId), { filename, ...(displayName !== undefined ? { displayName } : {}) });
      expect(r.status).toBe(201);
      expect(r.body.document.displayName).toBe(expected.replace(/\s+/g, ' ').trim());
    }
    const audits = await rowsOf("SELECT changes::text AS c, coalesce(reason, '') AS r FROM audit_log WHERE tenant_id = $1 AND action LIKE 'document.%'", [w.tenantId]);
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(`${a.c} ${a.r}`).not.toContain(marker);
    const jobs = await rowsOf('SELECT payload::text AS p FROM jobs WHERE tenant_id = $1', [w.tenantId]);
    for (const j of jobs) expect(j.p).not.toContain(marker);
    expect(h.logs.join('\n')).not.toContain(marker);
    const changes = (await rowsOf("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'document.uploaded' ORDER BY occurred_at DESC LIMIT 1", [w.tenantId]))[0]!.changes;
    expect(Object.keys(changes).sort()).toEqual(['byte_count', 'content_type', 'document_kind', 'document_version_no']);
  });

  it('R-DOC-5: a form with two files, an unknown field, a missing kind, a duplicated field or an oversized name field is refused', async () => {
    const before = await docCount();
    const f = { bytes: pdfBytes(), type: 'application/pdf', filename: 'a.pdf' };
    const forms = [
      [{ name: 'file', value: f }, { name: 'file', value: f }, { name: 'kind', value: 'other' }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'other' }, { name: 'dealId', value: deal.dealId }],
      [{ name: 'file', value: f }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'other' }, { name: 'kind', value: 'addendum' }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'other' }, { name: 'displayName', value: 'x'.repeat(1025) }],
      [{ name: 'file', value: f }, { name: 'kind', value: 'secret_kind' }],
      [{ name: 'file', value: 'not a file' }, { name: 'kind', value: 'other' }],
    ];
    for (const parts of forms) {
      const m = await multipart(parts);
      const r = await rawPost(w.agents[0]!, docs(deal.dealId), m.body, m.contentType);
      expect(r.statusCode, JSON.stringify(parts.map((p) => p.name))).toBe(422);
    }
    const garbage = await rawPost(w.agents[0]!, docs(deal.dealId), Buffer.from('--x\r\nnot really'), 'multipart/form-data; boundary=zzz');
    expect(garbage.statusCode).toBe(422);
    const json = await call(w.agents[0]!, 'POST', docs(deal.dealId), { file: 'x' });
    expect(json.status).toBe(422);
    expect(await docCount()).toBe(before);
  });

  it('R-DOC-5: the 61st upload attempt in an hour is RATE_LIMITED', async () => {
    const other = w.agents[1]!;
    const d = await makeDeal(w, other, { members: false });
    const t0 = Date.UTC(2031, 0, 1, 10, 0, 0);
    setUploadLimitClockForTests({ now: () => t0 as never });
    try {
      for (let i = 0; i < 60; i++) {
        const r = await upload(other, docs(d.dealId), { bytes: new Uint8Array([1, 2, 3]), type: 'application/pdf' });
        expect(r.code).toBe('DOCUMENT_TYPE_NOT_ALLOWED');
      }
      const r = await upload(other, docs(d.dealId));
      expect([r.status, r.code]).toEqual([429, 'RATE_LIMITED']);
    } finally {
      setUploadLimitClockForTests(undefined);
    }
  });

  it('R-DOC-5: a merged-away contact gets CONTACT_MERGED; a contact document is uploaded by its owner', async () => {
    const a = w.agents[0]!;
    const c1 = await (await import('../comms/testing.js')).ownedContact(a, { consent: false, firstName: 'Mia' });
    const c2 = await (await import('../comms/testing.js')).ownedContact(a, { consent: false, firstName: 'Mia' });
    const ok = await upload(a, `/contacts/${c1.id}/documents`, { kind: 'other' });
    expect(ok.status).toBe(201);
    const merge = await call(a, 'POST', `/contacts/${c2.id}/merge`, { loserId: c1.id, commandId: crypto.randomUUID() });
    if (merge.status !== 200) {
      await h.su.query('UPDATE contacts SET merged_into_contact_id = $2 WHERE id = $1', [c1.id, c2.id]);
    }
    const r = await upload(a, `/contacts/${c1.id}/documents`, { kind: 'other' });
    expect([r.status, r.code]).toEqual([409, 'CONTACT_MERGED']);
  });

  it('R-DOC-1 R-DATA-7 (b11 ownership-data/F1): after a merge the survivor\'s agent and Team Lead still list and download the merged-away record\'s contact document (never moved); a stranger does not', async () => {
    const { command } = await import('../leads/testing.js');
    const { ownedContact } = await import('../comms/testing.js');
    const a = w.agents[0]!;
    const survivor = await ownedContact(a, { consent: false, firstName: 'Noor' });
    const loser = await ownedContact(a, { consent: false, firstName: 'Noor' });
    const bytes = pdfBytes('pre-approval letter');
    const id = await uploadClean(a, `/contacts/${loser.id}/documents`, { kind: 'other', bytes });
    const m = await command(a, survivor.id, 'merge', { loserId: loser.id });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    expect((await rowsOf('SELECT contact_id FROM documents WHERE id = $1', [id]))[0]!.contact_id).toBe(loser.id); // never moved
    for (const c of [a, w.teamLead, w.owner, w.admin]) {
      const l = await call<{ documents: { id: string; scope: { kind: string; id: string } }[] }>(c, 'GET', `/contacts/${survivor.id}/documents`);
      expect(l.status, c.role ?? '').toBe(200);
      expect(l.body.documents.find((d) => d.id === id), c.role ?? '').toMatchObject({ scope: { kind: 'contact', id: loser.id } });
      expect((await call(c, 'GET', `/documents/${id}`)).status, c.role ?? '').toBe(200);
      const f = await c.get(`/api/documents/${id}/file`);
      expect(f.statusCode, c.role ?? '').toBe(200);
      expect(Buffer.from(f.rawPayload).equals(Buffer.from(bytes))).toBe(true);
    }
    // the other agent (no relation to the person) still sees nothing; a new version on the merged-away record is refused
    expect((await call(w.agents[1]!, 'GET', `/documents/${id}`)).status).toBe(404);
    expect((await w.agents[1]!.get(`/api/documents/${id}/file`)).statusCode).toBe(404);
    const v = await upload(a, `/documents/${id}/versions`);
    expect([v.status, v.code]).toEqual([409, 'CONTACT_MERGED']);
  });
});

describe('scan gating (R-DOC-3, R-DOC-7)', () => {
  it('R-DOC-3: a pending document is listed for its uploader and the Owner and is 404 for a peer and a Team Lead; /file is DOCUMENT_QUARANTINED even for those who read its object row', async () => {
    const a = w.agents[0]!;
    const r = await upload(a, docs(deal.dealId));
    const id = r.body.document.id;
    for (const c of [a, w.owner]) {
      const l = await call<{ documents: { id: string }[] }>(c, 'GET', docs(deal.dealId));
      expect(l.body.documents.map((d) => d.id)).toContain(id);
      expect((await call(c, 'GET', `/documents/${id}`)).status).toBe(200);
      const f = await call(c, 'GET', `/documents/${id}/file`);
      expect([f.status, f.code]).toEqual([409, 'DOCUMENT_QUARANTINED']);
    }
    const objRead = await rowsOf('SELECT o.id FROM stored_objects o JOIN documents d ON d.object_id = o.id WHERE d.id = $1', [id]);
    expect(objRead).toHaveLength(1);
    for (const c of [w.tc, w.teamLead]) {
      expect((await call(c, 'GET', `/documents/${id}`)).status).toBe(404);
      expect((await call(c, 'GET', `/documents/${id}/file`)).status).toBe(404);
      const l = await call<{ documents: { id: string }[] }>(c, 'GET', docs(deal.dealId));
      expect(l.body.documents.map((d) => d.id)).not.toContain(id);
    }
  });

  it('R-DOC-7: after a clean scan every viewer downloads the exact bytes with the exact headers, audited by ids', async () => {
    const bytes = pdfBytes('clean body');
    const id = await uploadClean(w.agents[0]!, docs(deal.dealId), { bytes, filename: 'Kontrakt é.pdf' });
    for (const c of [w.agents[0]!, w.owner, w.tc, w.isa, w.teamLead]) {
      const f = await c.get(`/api/documents/${id}/file`);
      expect(f.statusCode, c.role ?? '').toBe(200);
      expect(Buffer.from(f.rawPayload).equals(Buffer.from(bytes))).toBe(true);
      expect(f.headers).toMatchObject({
        'content-type': 'application/pdf',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cross-origin-resource-policy': 'same-origin',
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="Kontrakt e.pdf"; filename*=UTF-8''${encodeURIComponent('Kontrakt é.pdf')}`,
      });
    }
    const a = await rowsOf("SELECT changes::text AS c FROM audit_log WHERE tenant_id = $1 AND action = 'document.downloaded' AND entity_id = $2", [w.tenantId, id]);
    expect(a.length).toBe(5);
    expect(a.every((x) => x.c === '{}')).toBe(true);
  });

  it('R-DOC-3: a peer sees v1 while v2 is pending; the uploader sees v1 with newerVersion; after v2 is clean everyone sees v2', async () => {
    const v1 = await uploadClean();
    const v2 = await upload(w.agents[0]!, `/documents/${v1}/versions`);
    expect(v2.status, JSON.stringify(v2.body)).toBe(201);
    expect(v2.body.document).toMatchObject({ versionNo: 2, kind: 'purchase_contract' });
    const tc = await call<{ documents: { id: string; newerVersion: unknown }[] }>(w.tc, 'GET', docs(deal.dealId));
    expect(tc.body.documents.find((d) => d.id === v1)).toMatchObject({ newerVersion: null });
    expect(tc.body.documents.some((d) => d.id === v2.body.document.id)).toBe(false);
    const own = await call<{ documents: { id: string; newerVersion: unknown }[] }>(w.agents[0]!, 'GET', docs(deal.dealId));
    expect(own.body.documents.find((d) => d.id === v1)).toMatchObject({ newerVersion: { id: v2.body.document.id, versionNo: 2, scan: 'checking' } });
    await runScan(h, w.tenantId, v2.body.document.id);
    const after = await call<{ documents: { id: string; versionNo: number }[] }>(w.tc, 'GET', docs(deal.dealId));
    expect(after.body.documents.find((d) => d.id === v2.body.document.id)).toMatchObject({ versionNo: 2 });
    expect(after.body.documents.some((d) => d.id === v1)).toBe(false);
    const chain = await call<DocBody>(w.tc, 'GET', `/documents/${v2.body.document.id}`);
    expect(chain.body.versions.map((v) => v.versionNo)).toEqual([1, 2]);
  });

  it('E406 R-DOC-6: a second new version of the same document is DOCUMENT_VERSION_CONFLICT', async () => {
    const v1 = await uploadClean();
    expect((await upload(w.agents[0]!, `/documents/${v1}/versions`)).status).toBe(201);
    const r = await upload(w.agents[0]!, `/documents/${v1}/versions`);
    expect([r.status, r.code]).toEqual([409, 'DOCUMENT_VERSION_CONFLICT']);
  });

  it('R-DOC-1: the TC uploads deal documents but never contact documents; the ISA cannot upload to a deal; a listing document is for the listing\'s writers', async () => {
    expect((await upload(w.tc, docs(deal.dealId))).status).toBe(201);
    expect((await upload(w.isa, docs(deal.dealId))).status).toBe(404);
    expect((await upload(w.tc, `/contacts/${deal.contactId}/documents`, { kind: 'other' })).status).toBe(404);
    const listing = await makeListing(w.agents[0]!);
    const l = await uploadClean(w.agents[0]!, `/listings/${listing}/documents`, { kind: 'listing_agreement' });
    expect((await upload(w.agents[1]!, `/listings/${listing}/documents`, { kind: 'other' })).status).toBe(404);
    expect((await call(w.agents[1]!, 'GET', `/documents/${l}`)).status).toBe(404);
    expect((await call(w.teamLead, 'GET', `/documents/${l}`)).status).toBe(200);
  });
});

describe('the scanner (R-DOC-7)', () => {
  it('E130 R-DOC-7: an EICAR upload is blocked and shredded; it is never streamed, shared or listed as clean; blob_delete removes it later', async () => {
    const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes: eicarBytes(), filename: 'eicar.pdf' });
    const id = r.body.document.id;
    const s = await runScan(h, w.tenantId, id);
    expect(s).toMatchObject({ result: 'scanned', verdict: { verdict: 'blocked', reason: 'malware' } });
    const row = (await rowsOf('SELECT d.scan_status, o.dek_wrapped IS NULL AS shredded, o.deleted_at IS NOT NULL AS deleted FROM documents d JOIN stored_objects o ON o.id = d.object_id WHERE d.id = $1', [id]))[0]!;
    expect(row).toEqual({ scan_status: 'infected', shredded: true, deleted: true });
    expect((await call(w.agents[0]!, 'GET', `/documents/${id}/file`)).code).toBe('DOCUMENT_BLOCKED');
    expect((await call(w.agents[0]!, 'POST', `/documents/${id}/share`, { shared: true })).code).toBe('DOCUMENT_NOT_SHAREABLE');
    const v = await call<DocBody>(w.owner, 'GET', `/documents/${id}`);
    expect(v.body.document).toMatchObject({ scan: 'blocked', blockedReason: 'malware', scanText: COPY.blockedMalware, extraction: { status: 'waiting_for_scan' } });
    expect((await call(w.tc, 'GET', `/documents/${id}`)).status).toBe(404);
    // the scan is once: a second run changes nothing
    expect(await runScan(h, w.tenantId, id)).toEqual({ result: 'not_pending' });
    // storage.blob_delete then removes the ciphertext (it skips held objects)
    const key = (await rowsOf('SELECT o.storage_key FROM documents d JOIN stored_objects o ON o.id = d.object_id WHERE d.id = $1', [id]))[0]!.storage_key;
    expect(await h.providers.storage.get(key)).not.toBeNull();
    const sys = systemActor(w.tenantId, 'worker');
    await withTenantTx(sys, (tx, now) => blobDeleteHandler().run({ tx, now, actor: sys, providers: h.providers, job: { id: 1n, kind: 'storage.blob_delete', queue: 'maintenance', attempts: 1 }, log: { info() {}, warn() {}, error() {} } as never, alerts: { raise() {} } as never }, {}), { db: h.database });
    expect(await h.providers.storage.get(key)).toBeNull();
  });

  it('E404 R-DOC-7: a password-protected or unscannable file is blocked for good with the "could not read" sentence and shredded; a second scan changes nothing', async () => {
    const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes: pdfBytes(FAKE_UNSCANNABLE_MARKER) });
    const id = r.body.document.id;
    expect(await runScan(h, w.tenantId, id)).toMatchObject({ result: 'scanned', verdict: { verdict: 'blocked', reason: 'unscannable' } });
    const row = (await rowsOf('SELECT d.scan_status, o.dek_wrapped IS NULL AS shredded, o.deleted_at IS NOT NULL AS deleted FROM documents d JOIN stored_objects o ON o.id = d.object_id WHERE d.id = $1', [id]))[0]!;
    expect(row).toEqual({ scan_status: 'infected', shredded: true, deleted: true });
    expect(await runScan(h, w.tenantId, id)).toEqual({ result: 'not_pending' });
    const v = await call<DocBody>(w.owner, 'GET', `/documents/${id}`);
    expect(v.body.document).toMatchObject({ scan: 'blocked', blockedReason: 'unscannable', scanText: COPY.blockedUnscannable });
    expect(COPY.blockedUnscannable).toContain('could not read this file');
    expect((await call(w.agents[0]!, 'GET', `/documents/${id}/file`)).code).toBe('DOCUMENT_BLOCKED');
  });

  it('E404 R-DOC-7 (Q5, b11 reconciliation documents-6): an uploader who cannot read the verdict (neither Owner nor Admin) is still asked for a copy without a password, in a sentence true for malware and unscannable files alike', async () => {
    for (const bytes of [pdfBytes(FAKE_UNSCANNABLE_MARKER), eicarBytes()]) {
      const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes });
      await runScan(h, w.tenantId, r.body.document.id);
      const v = await call<DocBody>(w.agents[0]!, 'GET', `/documents/${r.body.document.id}`);
      expect(v.body.document).toMatchObject({ scan: 'blocked', blockedReason: null, scanText: COPY.blockedReasonUnknown });
    }
    expect(COPY.blockedReasonUnknown).toBe(
      "Blocked by the virus check: it found a threat, or it could not read the file (a password-protected file can't be checked). The file was deleted; nobody can open it. If the file has a password, upload a copy without one.",
    );
  });

  it('E403 R-DOC-7: a scanner failure throws (the job retries) and never marks clean; the reconcile re-enqueues a scan pending over 2 minutes', async () => {
    const r = await upload(w.agents[0]!, docs(deal.dealId));
    const id = r.body.document.id;
    h.providers.scanner.failNext = { times: 1, error: new ProviderError('unavailable', 'FAKE_DOWN') };
    await expect(runScan(h, w.tenantId, id)).rejects.toThrow(ProviderError);
    expect((await rowsOf('SELECT scan_status FROM documents WHERE id = $1', [id]))[0]!.scan_status).toBe('pending');
    await h.su.query("UPDATE documents SET created_at = now() - interval '3 minutes' WHERE id = $1", [id]);
    // the job is lost (a crash after its attempts ran out, say)
    await h.su.query('DELETE FROM jobs WHERE tenant_id = $1 AND dedupe_key = $2', [w.tenantId, `${DOCUMENT_JOBS.scan}:${id}`]);
    const rep = await runReconcile(h, w.tenantId);
    expect(rep.requeued).toBeGreaterThanOrEqual(1);
    expect((await jobsOf(h, w.tenantId, DOCUMENT_JOBS.scan)).filter((j) => j.payload.documentId === id && j.status === 'pending')).toHaveLength(1);
    expect(await runScan(h, w.tenantId, id)).toMatchObject({ result: 'scanned', verdict: { verdict: 'clean' } });
  });

  it('E405 R-DOC-7: a held document that scans infected keeps its object locked until the hold is lifted; then the reconcile shreds it', async () => {
    await freshReauth(h, w.owner);
    const r = await upload(w.agents[0]!, docs(deal.dealId), { bytes: eicarBytes() });
    const id = r.body.document.id;
    expect((await call(w.owner, 'POST', `/documents/${id}/hold`, { hold: true, reason: 'Litigation notice' })).status).toBe(200);
    await runScan(h, w.tenantId, id);
    const shredded = async () => (await rowsOf('SELECT o.dek_wrapped IS NULL AS s FROM documents d JOIN stored_objects o ON o.id = d.object_id WHERE d.id = $1', [id]))[0]!.s;
    expect(await shredded()).toBe(false);
    const v = await call<DocBody>(w.owner, 'GET', `/documents/${id}`);
    expect(v.body.document.scanText).toBe(COPY.blockedHeld);
    expect((await call(w.owner, 'GET', `/documents/${id}/file`)).code).toBe('DOCUMENT_BLOCKED');
    await runReconcile(h, w.tenantId);
    expect(await shredded()).toBe(false);
    expect((await call(w.owner, 'POST', `/documents/${id}/hold`, { hold: false, reason: 'Matter closed' })).status).toBe(200);
    await runReconcile(h, w.tenantId);
    expect(await shredded()).toBe(true);
  });

  it('E402 R-DOC-3 R-DOC-7: with the production bag (no scanner) every upload stays pending, nobody downloads it, the Owner included, nothing is enqueued, and the response says why', async () => {
    const p = h.app.platform.providers as unknown as { scanner: unknown; textExtractor: unknown };
    const [scanner, extractor] = [p.scanner, p.textExtractor];
    p.scanner = new UnconfiguredScanner();
    p.textExtractor = new UnconfiguredTextExtractor();
    try {
      const d = await makeDeal(w, w.agents[0]!);
      const r = await upload(w.agents[0]!, docs(d.dealId));
      expect(r.body.document).toMatchObject({ scan: 'waiting_for_scanner', scanText: COPY.noScanner, extraction: { status: 'not_set_up', text: EXTRACTOR_NOT_SET_UP } });
      expect((await jobsOf(h, w.tenantId, DOCUMENT_JOBS.scan)).some((j) => j.payload.documentId === r.body.document.id)).toBe(false);
      const deps = { ...docDeps(h), providers: p as never };
      expect(await runScan(h, w.tenantId, r.body.document.id, deps)).toEqual({ result: 'not_configured' });
      await h.su.query("UPDATE documents SET created_at = now() - interval '1 hour' WHERE id = $1", [r.body.document.id]);
      expect((await runReconcile(h, w.tenantId, deps)).requeued).toBe(0);
      for (const c of [w.agents[0]!, w.owner]) expect((await call(c, 'GET', `/documents/${r.body.document.id}/file`)).code).toBe('DOCUMENT_QUARANTINED');
      const l = await call<{ platform: { scanner: { configured: boolean; statusText: string }; extractor: { configured: boolean } } }>(w.owner, 'GET', docs(d.dealId));
      expect(l.body.platform).toMatchObject({ scanner: { configured: false, statusText: SCANNER_NOT_SET_UP }, extractor: { configured: false } });
    } finally {
      p.scanner = scanner;
      p.textExtractor = extractor;
    }
  });

  it(`R-DOC-7: the fake scanner says so ("${SCANNER_TEST_TEXT}")`, async () => {
    const l = await call<{ platform: { scanner: { configured: boolean; test: boolean; statusText: string } } }>(w.agents[0]!, 'GET', docs(deal.dealId));
    expect(l.body.platform.scanner).toEqual({ configured: true, test: true, statusText: SCANNER_TEST_TEXT });
  });
});

describe('share, hold and retention (R-DOC-4, R-DOC-9, R-DOC-10)', () => {
  it('E409 R-DOC-9: a new version of a shared document says the previous one is still shared; sharing it when the portal is not cleared says so', async () => {
    const v1 = await uploadClean();
    const s = await call<DocBody>(w.agents[0]!, 'POST', `/documents/${v1}/share`, { shared: true });
    expect(s.status).toBe(200);
    expect(s.body.text).toBe(COPY.sharedNotCleared);
    expect(s.body.document.portal).toEqual({ shared: true, portalCleared: false, text: COPY.sharedNotCleared });
    const v2 = await upload(w.agents[0]!, `/documents/${v1}/versions`);
    expect(v2.body).toMatchObject({ previousVersionShared: true, previousVersionSharedText: previousVersionSharedText(2) });
    expect(previousVersionSharedText(2)).toBe('Version 1 is still shared to the client portal. When this version passes the virus check, share it and stop sharing version 1.');
    expect((await call(w.agents[0]!, 'POST', `/documents/${v2.body.document.id}/share`, { shared: true })).code).toBe('DOCUMENT_NOT_SHAREABLE');
    const un = await call<DocBody>(w.agents[0]!, 'POST', `/documents/${v1}/share`, { shared: false });
    expect(un.body.text).toBe(COPY.unshared);
    const audits = await rowsOf("SELECT action FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action IN ('document.shared','document.unshared') ORDER BY occurred_at", [w.tenantId, v1]);
    expect(audits.map((a) => a.action)).toEqual(['document.shared', 'document.unshared']);
  });

  it('E411 R-DOC-9: the TC and the ISA cannot share (404); a contact document and a pending document are DOCUMENT_NOT_SHAREABLE; canShare says who may', async () => {
    const id = await uploadClean();
    for (const c of [w.tc, w.isa]) {
      expect((await call(c, 'POST', `/documents/${id}/share`, { shared: true })).status).toBe(404);
      expect((await call<DocBody>(c, 'GET', `/documents/${id}`)).body.document.canShare).toBe(false);
    }
    expect((await call<DocBody>(w.agents[0]!, 'GET', `/documents/${id}`)).body.document.canShare).toBe(true);
    const cd = await uploadClean(w.agents[0]!, `/contacts/${deal.contactId}/documents`, { kind: 'other' });
    expect((await call(w.owner, 'POST', `/documents/${cd}/share`, { shared: true })).code).toBe('DOCUMENT_NOT_SHAREABLE');
    const pending = await upload(w.agents[0]!, docs(deal.dealId));
    expect((await call(w.agents[0]!, 'POST', `/documents/${pending.body.document.id}/share`, { shared: true })).code).toBe('DOCUMENT_NOT_SHAREABLE');
    const listing = await makeListing(w.agents[0]!);
    const l = await uploadClean(w.agents[0]!, `/listings/${listing}/documents`, { kind: 'disclosure' });
    expect((await call(w.teamLead, 'POST', `/documents/${l}/share`, { shared: true })).status).toBe(200);
  });

  it('E419 R-DOC-4 R-DOC-10: an agent\'s hold or retention change is DOCUMENT_HOLD_OWNER_ADMIN; the Owner\'s and the Admin\'s are audited with before and after; a value outside 3-10 years is DOCUMENT_RETENTION_OUT_OF_RANGE', async () => {
    const id = await uploadClean();
    expect((await call(w.agents[0]!, 'POST', `/documents/${id}/hold`, { hold: true, reason: 'x' })).code).toBe('DOCUMENT_HOLD_OWNER_ADMIN');
    expect((await call(w.agents[0]!, 'PUT', `/documents/${id}/retention`, { retentionUntil: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString() })).code).toBe('DOCUMENT_HOLD_OWNER_ADMIN');
    expect((await call<DocBody>(w.agents[0]!, 'GET', `/documents/${id}`)).body.document.canHold).toBe(false);
    await freshReauth(h, w.admin);
    const hold = await call<DocBody>(w.admin, 'POST', `/documents/${id}/hold`, { hold: true, reason: 'Records request' });
    expect(hold.body.document).toMatchObject({ legalHold: true, canHold: true });
    const until = new Date(Date.now() + 5 * 365 * 86_400_000).toISOString();
    expect((await call<DocBody>(w.owner, 'PUT', `/documents/${id}/retention`, { retentionUntil: until })).body.document.retentionUntil).toBe(until);
    const out = await call(w.owner, 'PUT', `/documents/${id}/retention`, { retentionUntil: new Date(Date.now() + 365 * 86_400_000).toISOString() });
    expect([out.status, out.code]).toEqual([422, 'DOCUMENT_RETENTION_OUT_OF_RANGE']);
    const a = await rowsOf("SELECT action, changes FROM audit_log WHERE tenant_id = $1 AND entity_id = $2 AND action IN ('document.hold_placed','document.retention_changed')", [w.tenantId, id]);
    expect(a.map((x) => x.action).sort()).toEqual(['document.hold_placed', 'document.retention_changed']);
    expect(a.find((x) => x.action === 'document.retention_changed')!.changes).toEqual({ retention_until: { from: null, to: until } });
  });

  it('E419 R-DOC-10: the system stamps closed_at + 7 years only where retention is empty, never shortens or overwrites an Owner\'s value, and never stamps a contact document', async () => {
    const d = await makeDeal(w, w.agents[0]!);
    const a = await uploadClean(w.agents[0]!, docs(d.dealId));
    const b = await uploadClean(w.agents[0]!, docs(d.dealId));
    const c = await uploadClean(w.agents[0]!, `/contacts/${d.contactId}/documents`, { kind: 'other' });
    const shortUntil = new Date(Date.now() + 3.5 * 365 * 86_400_000).toISOString();
    expect((await call(w.owner, 'PUT', `/documents/${b}/retention`, { retentionUntil: shortUntil })).status).toBe(200);
    await h.su.query("UPDATE deals SET stage = 'closed', closed_at = now() - interval '1 day' WHERE id = $1", [d.dealId]);
    await runReconcile(h, w.tenantId);
    const rows = await rowsOf("SELECT id, retention_until, (SELECT closed_at FROM deals WHERE id = $4) AS closed FROM documents WHERE id = ANY($1::uuid[]) OR id = $2 OR id = $3", [[a], b, c, d.dealId]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ra = byId.get(a)!;
    const expected = new Date(ra.closed);
    expected.setUTCFullYear(expected.getUTCFullYear() + 7);
    expect(new Date(ra.retention_until).toISOString()).toBe(expected.toISOString());
    expect(new Date(byId.get(b)!.retention_until).toISOString()).toBe(shortUntil);
    expect(byId.get(c)!.retention_until).toBeNull();
  });

  it('R-DOC-4: erasing a contact with a held document is 409 DOCUMENT_RETAINED and nothing is erased', async () => {
    const c = await (await import('../comms/testing.js')).ownedContact(w.agents[0]!, { consent: false, firstName: 'Hal' });
    const id = await uploadClean(w.agents[0]!, `/contacts/${c.id}/documents`, { kind: 'other' });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/documents/${id}/hold`, { hold: true, reason: 'Hold' })).status).toBe(200);
    const r = await call(w.owner, 'POST', `/contacts/${c.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([r.status, r.code]).toEqual([409, 'DOCUMENT_RETAINED']);
    expect(await rowsOf('SELECT 1 FROM contacts WHERE id = $1', [c.id])).toHaveLength(1);
    expect(await rowsOf('SELECT 1 FROM documents WHERE id = $1', [id])).toHaveLength(1);
  });
});

describe('the erasure preview says what documents do to an erasure (b11 db-public/F2, ownership-data/F4, api-ui/F3, ownership-data/F2, ownership-data/F5)', () => {
  type Preview = {
    erasable: boolean;
    deals: unknown[];
    mergedRecords: number;
    retainedDocuments: { id: string; contactId: string; legalHold: boolean; retentionUntil: string | null; kind: string; displayName: string; versionNo: number; uploadedAt: string }[];
    mergedInto: string | null;
    erasedWith: { callRecordings: number; documents: number; cmaReports: number };
    listingDocuments: { listingId: string; address: string; documents: number }[];
  };
  /** what the page tells two documents apart by (b11 ownership-data/F4), read back from the table */
  const identity = async (id: string) => {
    const r = (await rowsOf('SELECT kind, display_name, version_no, created_at FROM documents WHERE id = $1', [id]))[0]!;
    return { kind: r.kind as string, displayName: r.display_name as string, versionNo: r.version_no as number, uploadedAt: (r.created_at as Date).toISOString() };
  };
  const preview = async (contactId: string) => {
    await freshReauth(h, w.owner);
    const r = await call<Preview>(w.owner, 'GET', `/contacts/${contactId}/erasure`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };

  it('R-DOC-4 R-DATA-4: a held or retained document of any record of the person makes the preview not erasable and names it (ids, dates, kind, name, version); the erase refusal names the same documents (ids and dates only); lifting the hold alone leaves the retained one blocking', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { command } = await import('../leads/testing.js');
    const a = w.agents[0]!;
    const survivor = await ownedContact(a, { consent: false, firstName: 'Ira' });
    const loser = await ownedContact(a, { consent: false, firstName: 'Ira' });
    const held = await uploadClean(a, `/contacts/${survivor.id}/documents`, { kind: 'other' });
    const kept = await uploadClean(a, `/contacts/${loser.id}/documents`, { kind: 'other' });
    const free = await uploadClean(a, `/contacts/${survivor.id}/documents`, { kind: 'other' });
    expect((await command(a, survivor.id, 'merge', { loserId: loser.id })).status).toBe(200);
    expect((await preview(survivor.id))).toMatchObject({ erasable: true, retainedDocuments: [], mergedInto: null, listingDocuments: [] });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/documents/${held}/hold`, { hold: true, reason: 'Hold' })).status).toBe(200);
    const until = new Date(Date.now() + 4 * 365 * 86_400_000).toISOString();
    expect((await call(w.owner, 'PUT', `/documents/${kept}/retention`, { retentionUntil: until })).status).toBe(200);
    const p = await preview(survivor.id);
    expect(p.erasable).toBe(false);
    expect(p.mergedRecords).toBe(1);
    expect(p.retainedDocuments).toEqual(
      [
        { id: held, contactId: survivor.id, legalHold: true, retentionUntil: null, ...(await identity(held)) },
        { id: kept, contactId: loser.id, legalHold: false, retentionUntil: until, ...(await identity(kept)) },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    expect(p.retainedDocuments.some((d) => d.id === free)).toBe(false);
    await freshReauth(h, w.owner);
    const r = await call<{ error: { code: string; details: unknown } }>(w.owner, 'POST', `/contacts/${survivor.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([r.status, r.body.error.code]).toEqual([409, 'DOCUMENT_RETAINED']);
    expect(r.body.error.details).toEqual({ documents: p.retainedDocuments.map((d) => ({ id: d.id, legalHold: d.legalHold, retentionUntil: d.retentionUntil })) });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/documents/${held}/hold`, { hold: false, reason: 'Released' })).status).toBe(200);
    expect((await preview(survivor.id))).toMatchObject({ erasable: false, retainedDocuments: [{ id: kept, legalHold: false, retentionUntil: until }] });
    expect(await rowsOf('SELECT 1 FROM contacts WHERE id = ANY($1::uuid[])', [[survivor.id, loser.id]])).toHaveLength(2);
  });

  // b11 ownership-data/F4 (the part left open): the page said only "A document on legal hold" for each, so an Owner
  // with two held documents could not tell which one to release
  it('R-DOC-4 R-DATA-4 (b11 ownership-data/F4): two held documents are told apart: each names its kind, its name, its version, when it was uploaded and the record it is on', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { command } = await import('../leads/testing.js');
    const a = w.agents[0]!;
    const survivor = await ownedContact(a, { consent: false, firstName: 'Ada' });
    const loser = await ownedContact(a, { consent: false, firstName: 'Ada' });
    const first = await uploadClean(a, `/contacts/${survivor.id}/documents`, { kind: 'disclosure', displayName: 'Seller disclosure' });
    const second = await uploadClean(a, `/documents/${first}/versions`, { displayName: 'Seller disclosure, signed' });
    const other = await uploadClean(a, `/contacts/${loser.id}/documents`, { kind: 'inspection', displayName: 'Home inspection' });
    expect((await command(a, survivor.id, 'merge', { loserId: loser.id })).status).toBe(200);
    await freshReauth(h, w.owner);
    for (const id of [second, other]) expect((await call(w.owner, 'POST', `/documents/${id}/hold`, { hold: true, reason: 'Hold' })).status).toBe(200);
    const p = await preview(survivor.id);
    expect(p.erasable).toBe(false);
    const byId = new Map(p.retainedDocuments.map((d) => [d.id, d]));
    expect(p.retainedDocuments).toHaveLength(2);
    expect(byId.get(second)).toEqual({ id: second, contactId: survivor.id, legalHold: true, retentionUntil: null, kind: 'disclosure', displayName: 'Seller disclosure, signed', versionNo: 2, uploadedAt: (await identity(second)).uploadedAt });
    expect(byId.get(other)).toEqual({ id: other, contactId: loser.id, legalHold: true, retentionUntil: null, kind: 'inspection', displayName: 'Home inspection', versionNo: 1, uploadedAt: (await identity(other)).uploadedAt });
    // the refusal's details stay ids, holds and dates (no name in an error)
    await freshReauth(h, w.owner);
    const r = await call<{ error: { code: string; details: { documents: Record<string, unknown>[] } } }>(w.owner, 'POST', `/contacts/${survivor.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(r.body.error.code).toBe('DOCUMENT_RETAINED');
    expect(r.body.error.details.documents.map((d) => Object.keys(d).sort())).toEqual([['id', 'legalHold', 'retentionUntil'], ['id', 'legalHold', 'retentionUntil']]);
  });

  // b11 ownership-data/F2 (the part left open): a merge moves a record's calls to the survivor, but their recordings
  // keep the merged-away record's id, so erasing that record deletes them while the calls stay on the survivor
  it('R-DATA-4 R-DATA-7 R-OWN-24 (b11 ownership-data/F2): a merged-away record\'s preview counts what its erasure deletes that the merge left on it (a moved call\'s recording, its documents); erasing it deletes the recording and its transcript, and the call stays on the survivor', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { command } = await import('../leads/testing.js');
    const a = w.agents[0]!;
    const survivor = await ownedContact(a, { consent: false, firstName: 'Cy' });
    const loser = await ownedContact(a, { consent: false, firstName: 'Cy' });
    const conv = randomUUID();
    const callId = randomUUID();
    const rec = randomUUID();
    const shreddedRec = randomUUID();
    const tr = randomUUID();
    await h.su.query('INSERT INTO conversations (tenant_id, id, contact_id) VALUES ($1,$2,$3)', [w.tenantId, conv, loser.id]);
    await h.su.query(
      `INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, agent_user_id, client_address, initiator, status, started_at, answered_at, ended_at,
         duration_s, recording_mode, recording_announced_at, recording_decision)
       VALUES ($1,$2,$3,$4,'inbound',$5,'+14155550123','client','completed',now() - interval '1 hour',now() - interval '1 hour',now() - interval '50 minutes',600,'announced_all_parties',now() - interval '1 hour','{}')`,
      [w.tenantId, callId, conv, loser.id, a.userId],
    );
    await h.su.query(
      `INSERT INTO recordings (tenant_id, id, call_id, contact_id, agent_user_id, source, consent_basis, status, retain_until, shredded_at)
       VALUES ($1,$2,$4,$5,$6,'provider','announced_all_parties','pending_copy', now() + interval '700 days', NULL),
              ($1,$3,$4,$5,$6,'provider','announced_all_parties','shredded', now() - interval '1 day', now())`,
      [w.tenantId, rec, shreddedRec, callId, loser.id, a.userId],
    );
    await h.su.query(`INSERT INTO transcripts (tenant_id, id, recording_id, contact_id, status, provider) VALUES ($1,$2,$3,$4,'pending','fake')`, [w.tenantId, tr, rec, loser.id]);
    const doc = await uploadClean(a, `/contacts/${loser.id}/documents`, { kind: 'other' });
    expect((await preview(loser.id)).erasedWith).toEqual({ callRecordings: 1, documents: 1, cmaReports: 0 });
    // an Owner's merge moves the calls in the merge transaction itself (an agent's waits for ownership.followup)
    expect((await command(w.owner, survivor.id, 'merge', { loserId: loser.id, ownerChoice: a.userId })).status).toBe(200);
    // the call moved to the survivor; its recordings did not
    expect((await rowsOf('SELECT contact_id FROM calls WHERE id = $1', [callId]))[0]!.contact_id).toBe(survivor.id);
    expect((await rowsOf('SELECT DISTINCT contact_id FROM recordings WHERE call_id = $1', [callId])).map((x) => x.contact_id)).toEqual([loser.id]);
    const p = await preview(loser.id);
    expect(p).toMatchObject({ erasable: true, mergedInto: survivor.id, mergedRecords: 0, erasedWith: { callRecordings: 1, documents: 1, cmaReports: 0 } });
    // the survivor's own erasure takes the merged record with it: the same items are counted there
    expect((await preview(survivor.id)).erasedWith).toEqual({ callRecordings: 1, documents: 1, cmaReports: 0 });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/contacts/${loser.id}/erase`, { reason: 'DUPLICATE_RECORD' })).status).toBe(200);
    expect(await rowsOf('SELECT 1 FROM recordings WHERE call_id = $1', [callId])).toEqual([]);
    expect(await rowsOf('SELECT 1 FROM transcripts WHERE id = $1', [tr])).toEqual([]);
    expect(await rowsOf('SELECT 1 FROM documents WHERE id = $1', [doc])).toEqual([]);
    expect((await rowsOf('SELECT contact_id FROM calls WHERE id = $1', [callId]))[0]!.contact_id).toBe(survivor.id);
    expect((await preview(survivor.id)).erasedWith).toEqual({ callRecordings: 0, documents: 0, cmaReports: 0 });
  });

  it('R-DATA-4 R-DATA-7: a merged-away record\'s preview names the record the person lives on now (erasing it alone stays possible); a seller\'s preview lists the listing documents that stay after the erasure', async () => {
    const { ownedContact } = await import('../comms/testing.js');
    const { command } = await import('../leads/testing.js');
    const a = w.agents[0]!;
    const root = await ownedContact(a, { consent: false, firstName: 'Lou' });
    const mid = await ownedContact(a, { consent: false, firstName: 'Lou' });
    const leaf = await ownedContact(a, { consent: false, firstName: 'Lou' });
    expect((await command(a, mid.id, 'merge', { loserId: leaf.id })).status).toBe(200);
    expect((await command(a, root.id, 'merge', { loserId: mid.id })).status).toBe(200);
    expect((await preview(leaf.id))).toMatchObject({ erasable: true, mergedInto: root.id, mergedRecords: 0 });
    expect((await preview(root.id)).mergedInto).toBeNull();
    // a seller on a listing with documents: those documents are the listing's and stay; the preview says so
    const seller = await ownedContact(a, { consent: false, firstName: 'Sol' });
    const listing = await makeListing(a);
    expect((await call(a, 'POST', `/listings/${listing}/contacts`, { contactId: seller.id, role: 'seller' })).status).toBe(200);
    expect((await preview(seller.id)).listingDocuments).toEqual([]);
    await uploadClean(a, `/listings/${listing}/documents`, { kind: 'listing_agreement' });
    await uploadClean(a, `/listings/${listing}/documents`, { kind: 'disclosure' });
    const address = (await rowsOf('SELECT address_line1 FROM listings WHERE id = $1', [listing]))[0]!.address_line1 as string;
    const p = await preview(seller.id);
    expect(p).toMatchObject({ erasable: true, listingDocuments: [{ listingId: listing, address, documents: 2 }] });
  });
});
