// Upload hardening of POST /imports (application-security pass; input and file handling):
//   - size: the request body cap matches the file cap (25 MiB decoded), a declared Content-Length over
//     it is refused before the body is read, a Content-Length that lies is refused, and the row,
//     column and cell limits hold at the HTTP boundary;
//   - encoding: fileBase64 must be strict base64 (no silently dropped characters);
//   - compression: no Content-Encoding is ever inflated, and gzip / zip / xlsx / other archive files
//     are refused (nothing is decompressed anywhere, so there is no inflated size to cap);
//   - type: the file name's extension must fit the source (.csv/.tsv/.txt for CSV, .json for a FUB
//     export).
// Every refusal leaves nothing behind: no batch and no stored object.
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_ORIGIN } from '../auth/testHarness.js';
import { MAX_CSV_BYTES } from './csv.js';
import { type ImportWorld, type ImportsHarness, call, csvBase64, csvOf, importWorld, importsHarness } from './testing.js';

let ih: ImportsHarness;
let w: ImportWorld;
const q = async <T = Record<string, unknown>>(text: string, args: unknown[] = []) => (await ih.h.su.query(text, args)).rows as T[];

beforeAll(async () => {
  ih = await importsHarness();
  w = await importWorld(ih);
});
afterAll(async () => {
  await ih?.close();
});

const nothingStored = async () => {
  expect(await q('SELECT 1 FROM import_batches WHERE tenant_id = $1', [w.tenantId])).toHaveLength(0);
  expect(await q("SELECT 1 FROM stored_objects WHERE tenant_id = $1 AND purpose = 'import_file'", [w.tenantId])).toHaveLength(0);
};

/** A raw POST /api/imports as the admin (session cookie + CSRF + Origin), with full control of headers and payload. */
async function rawPost(payload: string | Buffer, headers: Record<string, string>) {
  const res = await ih.h.app.inject({
    method: 'POST',
    url: '/api/imports',
    headers: { 'user-agent': 'vitest', origin: TEST_ORIGIN, 'x-csrf-token': w.admin.csrf as string, cookie: `__Host-sid=${w.admin.cookie as string}`, ...headers },
    payload,
    remoteAddress: w.admin.ip,
  });
  const body = (() => {
    try {
      return JSON.parse(res.body) as { error?: { code: string; details?: Record<string, unknown> } };
    } catch {
      return {};
    }
  })();
  return { status: res.statusCode, code: body.error?.code, details: body.error?.details };
}

const csvBody = (fileName: string, b64: string) => JSON.stringify({ source: 'csv', fileName, fileBase64: b64 });

describe('upload size limits', () => {
  it('a body larger than the encoded file cap is refused 413 PAYLOAD_TOO_LARGE (the route cap matches the 25 MiB file cap)', async () => {
    const b64 = 'A'.repeat(Math.ceil((MAX_CSV_BYTES * 4) / 3) + 1_100_000); // > the base64 of 25 MiB + any envelope
    const r = await rawPost(csvBody('big.csv', b64), { 'content-type': 'application/json' });
    expect([r.status, r.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    await nothingStored();
  }, 60_000);

  it('a declared Content-Length over the cap is refused 413 before the body is read', async () => {
    const r = await rawPost(csvBody('x.csv', csvBase64(csvOf(1))), { 'content-type': 'application/json', 'content-length': String(40_000_000) });
    expect([r.status, r.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    await nothingStored();
  });

  it('a Content-Length that lies (shorter than the body) is refused and stores nothing', async () => {
    const payload = csvBody('x.csv', csvBase64(csvOf(20)));
    const r = await rawPost(payload, { 'content-type': 'application/json', 'content-length': String(Math.floor(payload.length / 2)) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
    await nothingStored();
  });

  it('a decoded file over 25 MiB is refused 413 even though its base64 fits the schema', async () => {
    const r = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'big.csv', fileBase64: Buffer.alloc(MAX_CSV_BYTES + 1, 0x41).toString('base64') });
    expect([r.status, r.code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    await nothingStored();
  }, 60_000);

  it('R-IMPORT-13: more than 500 columns, or a cell over 32,768 characters, is refused at upload with the limit', async () => {
    const wide = `${Array.from({ length: 501 }, (_, i) => `c${i}`).join(',')}\n${Array.from({ length: 501 }, () => 'x').join(',')}\n`;
    const r1 = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'wide.csv', fileBase64: csvBase64(wide) });
    expect([r1.status, r1.code, (r1.body as { error: { details: unknown } }).error.details]).toEqual([422, 'IMPORT_FILE_INVALID', { reason: 'CSV_TOO_MANY_COLUMNS', line: 1, limit: 500 }]);
    const long = `First Name,Notes\nPat,"${'n'.repeat(32_769)}"\n`;
    const r2 = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'long.csv', fileBase64: csvBase64(long) });
    expect([r2.status, r2.code]).toEqual([422, 'IMPORT_FILE_INVALID']);
    expect((r2.body as { error: { details: unknown } }).error.details).toMatchObject({ reason: 'CSV_FIELD_TOO_LARGE', limit: 32_768 });
    await nothingStored();
  });

  it('fileBase64 must be strict base64: characters a lenient decoder would silently drop are refused 422', async () => {
    for (const b64 of ['Rmly!!c3Qs\nTGFzdA==', 'Rmlyc3Qs TGFzdA==', 'Rmlyc3Qs-TGFzdA_=', 'Rmlyc3Qs=TGFzdA==']) {
      const r = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'x.csv', fileBase64: b64 });
      expect([b64, r.status, r.code]).toEqual([b64, 422, 'VALIDATION_FAILED']);
    }
    await nothingStored();
  });
});

describe('compressed input is never inflated', () => {
  it('a gzip, deflate or br Content-Encoding on the upload is refused 415 UNSUPPORTED_MEDIA_TYPE (never decompressed)', async () => {
    const json = csvBody('x.csv', csvBase64(csvOf(2)));
    const gz = await rawPost(gzipSync(Buffer.from(json)), { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    expect([gz.status, gz.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    // labelled compressed but actually plain: still refused, the label is never trusted either way
    for (const enc of ['gzip', 'deflate', 'br', 'x-gzip', 'identity, gzip']) {
      const r = await rawPost(json, { 'content-type': 'application/json', 'content-encoding': enc });
      expect([enc, r.status, r.code]).toEqual([enc, 415, 'UNSUPPORTED_MEDIA_TYPE']);
    }
    await nothingStored();
    const plain = await rawPost(json, { 'content-type': 'application/json', 'content-encoding': 'identity' });
    expect(plain.status).toBe(201);
    await q('DELETE FROM import_stages WHERE tenant_id = $1', [w.tenantId]);
    await q('DELETE FROM import_batches WHERE tenant_id = $1', [w.tenantId]);
    await q("DELETE FROM stored_objects WHERE tenant_id = $1 AND purpose = 'import_file'", [w.tenantId]);
  });

  it('a non-JSON content type is refused 415', async () => {
    const r = await rawPost(csvOf(2), { 'content-type': 'text/csv' });
    expect([r.status, r.code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    await nothingStored();
  });

  it('gzip, zip (incl. xlsx), bzip2, xz, zstd and 7z files are refused 415 for CSV and FUB export uploads, whatever their name', async () => {
    const gz = gzipSync(Buffer.from(csvOf(50)));
    const magic: Record<string, Buffer> = {
      gzip: gz,
      zip: Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(csvOf(5))]),
      zipEmpty: Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.from(csvOf(5))]),
      bzip2: Buffer.concat([Buffer.from('BZh91AY&SY', 'latin1'), Buffer.from(csvOf(5))]),
      xz: Buffer.concat([Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]), Buffer.from(csvOf(5))]),
      zstd: Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from(csvOf(5))]),
      sevenZip: Buffer.concat([Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]), Buffer.from(csvOf(5))]),
    };
    for (const [kind, bytes] of Object.entries(magic)) {
      const c = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: 'leads.csv', fileBase64: bytes.toString('base64') });
      expect([kind, 'csv', c.status, c.code]).toEqual([kind, 'csv', 415, 'UNSUPPORTED_MEDIA_TYPE']);
      const f = await call(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'export.json', fileBase64: bytes.toString('base64') });
      expect([kind, 'fub_export', f.status, f.code]).toEqual([kind, 'fub_export', 415, 'UNSUPPORTED_MEDIA_TYPE']);
    }
    await nothingStored();
  });
});

describe('file type by name', () => {
  it('the extension must fit the source: .csv/.tsv/.txt for CSV, .json for a FUB export (case-insensitive); anything else is 415', async () => {
    const csv = csvBase64(csvOf(2));
    for (const name of ['leads.xlsx', 'leads.xls', 'leads.csv.gz', 'leads.zip', 'leads.json', 'leads', 'leads.csv.exe', 'leads.html']) {
      const r = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: name, fileBase64: csv });
      expect([name, r.status, r.code]).toEqual([name, 415, 'UNSUPPORTED_MEDIA_TYPE']);
    }
    const fub = csvBase64(JSON.stringify({ people: [{ id: 1, firstName: 'Ann' }] }));
    for (const name of ['export.zip', 'export.json.gz', 'export.csv', 'export']) {
      const r = await call(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: name, fileBase64: fub });
      expect([name, r.status, r.code]).toEqual([name, 415, 'UNSUPPORTED_MEDIA_TYPE']);
    }
    await nothingStored();
    for (const name of ['LEADS.CSV', 'leads.tsv', 'C:\\Users\\me\\leads.txt']) {
      const r = await call(w.admin, 'POST', '/imports', { source: 'csv', fileName: name, fileBase64: csv });
      expect([name, r.status]).toEqual([name, 201]);
    }
    const ok = await call(w.admin, 'POST', '/imports', { source: 'fub_export', fileName: 'Export.JSON', fileBase64: fub });
    expect(ok.status).toBe(201);
  });
});
