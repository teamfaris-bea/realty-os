// S3 adapter: SigV4 against AWS's published S3 examples, then the adapter against a real node:http
// mock S3 that independently re-derives every request's signature, then a round trip through the
// real envelope encryption (crypto/objects.ts) asserting the bucket only ever sees ciphertext.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { withTenantTx } from '@realty/db';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../../auth/testHarness.js';
import { getObject, putObject } from '../../crypto/objects.js';
import { StorageKeyError } from '../storage.js';
import { ProviderError } from '../types.js';
import { S3Storage, type S3StorageOptions } from './s3.js';
import { EMPTY_SHA256_HEX, signRequest } from './sigv4.js';

// ---- (a) AWS published vectors ------------------------------------------------------------------

const AWS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  region: 'us-east-1',
  service: 's3' as const,
  now: new Date('2013-05-24T00:00:00Z'),
};

describe('sigv4 (AWS S3 SigV4 header-auth examples)', () => {
  it('GET Object with Range bytes=0-9 on examplebucket/test.txt', () => {
    const h = signRequest({ ...AWS, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: { Range: 'bytes=0-9' }, payloadSha256Hex: EMPTY_SHA256_HEX });
    expect(h['x-amz-date']).toBe('20130524T000000Z');
    expect(h['x-amz-content-sha256']).toBe(EMPTY_SHA256_HEX);
    expect(h.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    );
    expect(h['x-amz-security-token']).toBeUndefined();
  });

  it('PUT Object test$file.text with x-amz-storage-class and a Date header ($ encoded once, either input form)', () => {
    const body = 'Welcome to Amazon S3.';
    const payload = createHash('sha256').update(body).digest('hex');
    expect(payload).toBe('44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
    const expected = 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd';
    for (const path of ['/test$file.text', '/test%24file.text']) {
      const h = signRequest({ ...AWS, method: 'PUT', url: new URL(`https://examplebucket.s3.amazonaws.com${path}`), headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' }, payloadSha256Hex: payload });
      expect(h.authorization).toBe(expected);
    }
  });

  it('a session token is returned and signed', () => {
    const h = signRequest({ ...AWS, sessionToken: 'tok', method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), headers: {}, payloadSha256Hex: EMPTY_SHA256_HEX });
    expect(h['x-amz-security-token']).toBe('tok');
    expect(h.authorization).toContain('SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token,');
  });
});

// ---- (b) mock S3 over real HTTP -----------------------------------------------------------------

const BUCKET = 'realty-test';
const REGION = 'us-east-1';
const CREDS = { accessKeyId: 'AKIDMOCK0000000000', secretAccessKey: 'mock/secret+KEY/0123456789abcdefghijklmn' };

interface SeenRequest {
  method: string;
  host: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Buffer;
}

type Scripted = number | 'hang';

interface MockS3 {
  url: string;
  objects: Map<string, { bytes: Buffer; contentType: string }>;
  requests: SeenRequest[];
  sigFailures: string[];
  script: Scripted[];
  close(): Promise<void>;
}

const xmlError = (code: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>mock</Message><RequestId>MOCKREQ</RequestId></Error>`;
const codeFor = (status: number) => ({ 400: 'InvalidRequest', 403: 'AccessDenied', 404: 'NoSuchKey', 429: 'SlowDown', 500: 'InternalError', 503: 'ServiceUnavailable' })[status] ?? 'Error';

const hmac = (k: Buffer | string, d: string) => createHmac('sha256', k).update(d).digest();

/** Independent SigV4 check, written from the spec against the raw request line (not sigv4.ts). */
function verifySignature(req: SeenRequest): string | null {
  const auth = req.headers.authorization ?? '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([0-9a-f]{64})$/.exec(auth);
  if (!m) return 'malformed authorization';
  const [, akid, day, region, signedList, signature] = m as unknown as [string, string, string, string, string, string];
  if (akid !== CREDS.accessKeyId) return 'unknown access key';
  if (region !== REGION) return 'wrong region';
  const amzDate = String(req.headers['x-amz-date'] ?? '');
  if (!amzDate.startsWith(day)) return 'date/scope mismatch';
  const signed = signedList.split(';');
  for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) if (!signed.includes(required)) return `unsigned ${required}`;
  for (const name of Object.keys(req.headers)) if (name.startsWith('x-amz-') && !signed.includes(name)) return `unsigned ${name}`;
  for (const name of ['content-type', 'content-md5']) if (req.headers[name] !== undefined && !signed.includes(name)) return `unsigned ${name}`;
  const contentSha = String(req.headers['x-amz-content-sha256'] ?? '');
  if (contentSha !== createHash('sha256').update(req.body).digest('hex')) return 'payload hash mismatch';
  if (req.headers['content-md5'] !== undefined && req.headers['content-md5'] !== createHash('md5').update(req.body).digest('base64')) return 'content-md5 mismatch';
  const [rawPath = '/', rawQuery = ''] = req.path.split('?');
  const query = rawQuery === '' ? '' : rawQuery.split('&').map((p) => (p.includes('=') ? p : `${p}=`)).sort().join('&');
  const headerLines = signed.map((n) => `${n}:${(n === 'host' ? req.host : String(req.headers[n] ?? '')).trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = [req.method, rawPath, query, headerLines, signedList, contentSha].join('\n');
  const sts = ['AWS4-HMAC-SHA256', amzDate, `${day}/${region}/s3/aws4_request`, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${CREDS.secretAccessKey}`, day), region), 's3'), 'aws4_request');
  return createHmac('sha256', key).update(sts).digest('hex') === signature ? null : 'signature mismatch';
}

async function startMockS3(): Promise<MockS3> {
  const objects = new Map<string, { bytes: Buffer; contentType: string }>();
  const requests: SeenRequest[] = [];
  const sigFailures: string[] = [];
  const script: Scripted[] = [];
  const send = (res: ServerResponse, status: number, method: string, body?: string | Buffer, headers: Record<string, string> = {}) => {
    res.writeHead(status, { ...(body !== undefined && typeof body === 'string' ? { 'content-type': 'application/xml' } : {}), ...headers });
    res.end(method === 'HEAD' ? undefined : body);
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const method = req.method ?? 'GET';
      // A virtual-host request reaches 127.0.0.1 through the test fetch, which forwards the
      // original Host (fetch itself does not let a caller override Host).
      const host = String(req.headers['x-test-original-host'] ?? req.headers.host ?? '');
      const seen: SeenRequest = { method, host, path: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks) };
      requests.push(seen);
      const step = script.shift();
      if (step === 'hang') return; // never answer: the client's timeout fires
      if (typeof step === 'number') return send(res, step, method, xmlError(codeFor(step)));
      const failure = verifySignature(seen);
      if (failure) {
        sigFailures.push(failure);
        return send(res, 403, method, xmlError('SignatureDoesNotMatch'));
      }
      const rawPath = seen.path.split('?')[0] ?? '/';
      const segments = rawPath.split('/').slice(1).map(decodeURIComponent);
      if (!host.startsWith(`${BUCKET}.`)) {
        if (segments.shift() !== BUCKET) return send(res, 404, method, xmlError('NoSuchBucket'));
      }
      const key = segments.join('/');
      switch (method) {
        case 'PUT':
          objects.set(key, { bytes: seen.body, contentType: String(req.headers['content-type'] ?? '') });
          return send(res, 200, method, undefined, { etag: '"mock"' });
        case 'GET':
        case 'HEAD': {
          const o = objects.get(key);
          if (!o) return send(res, 404, method, xmlError('NoSuchKey'));
          return send(res, 200, method, o.bytes, { 'content-type': o.contentType, 'content-length': String(o.bytes.length) });
        }
        case 'DELETE':
          objects.delete(key);
          return send(res, 204, method);
        default:
          return send(res, 405, method, xmlError('MethodNotAllowed'));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    objects,
    requests,
    sigFailures,
    script,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

let s3: MockS3;
beforeAll(async () => {
  s3 = await startMockS3();
});
afterAll(async () => {
  await s3?.close();
});
afterEach(() => {
  // every request the adapter made must have carried a valid signature (scripted faults aside)
  expect(s3.sigFailures).toEqual([]);
  s3.requests.length = 0;
  s3.script.length = 0;
  s3.objects.clear();
});

const TENANT = '0190c0de-0000-7000-8000-00000000a001';
const key = (name = 'blob-1') => `tenants/${TENANT}/recording/${name}`;
const binary = () => {
  const b = new Uint8Array(randomBytes(4096));
  b[0] = 0x00;
  b[1] = 0xff;
  return b;
};

const pathStyle = (o: Partial<S3StorageOptions> = {}) => new S3Storage({ endpoint: s3.url, region: REGION, bucket: BUCKET, ...CREDS, forcePathStyle: true, timeoutMs: 2000, ...o });

async function providerError(p: Promise<unknown>): Promise<ProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ProviderError);
    const msg = `${String(e)} ${(e as Error).stack ?? ''}`;
    expect(msg).not.toContain(CREDS.secretAccessKey);
    expect(msg).not.toContain(CREDS.accessKeyId);
    expect(msg).not.toContain(TENANT);
    return e as ProviderError;
  }
  throw new Error('expected a ProviderError');
}

describe('S3Storage against a mock S3 (path style)', () => {
  it('put/get/exists/delete round trip with binary bytes; 404 gives null/false; delete of a missing key is ok', async () => {
    const st = pathStyle();
    const bytes = binary();
    expect(await st.exists(key())).toBe(false);
    expect(await st.get(key())).toBeNull();
    await st.put(key(), bytes, { contentType: 'application/octet-stream' });
    expect(Buffer.from(s3.objects.get(key())!.bytes).equals(Buffer.from(bytes))).toBe(true);
    expect(s3.objects.get(key())!.contentType).toBe('application/octet-stream');
    expect(await st.exists(key())).toBe(true);
    const back = await st.get(key());
    expect(back).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(back!).equals(Buffer.from(bytes))).toBe(true);
    await st.delete(key());
    expect(await st.exists(key())).toBe(false);
    await st.delete(key()); // 404/204 on a missing key both count as deleted
    const put = s3.requests.find((r) => r.method === 'PUT')!;
    expect(put.path).toBe(`/${BUCKET}/${key()}`);
    expect(put.headers['x-amz-content-sha256']).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(put.headers['x-amz-server-side-encryption']).toBeUndefined(); // default null (R2-safe)
    expect(s3.requests.map((r) => r.method)).toEqual(['HEAD', 'GET', 'PUT', 'HEAD', 'GET', 'DELETE', 'HEAD', 'DELETE']);
  });

  it('empty object round trip', async () => {
    const st = pathStyle();
    await st.put(key('empty'), new Uint8Array(0), { contentType: 'text/plain' });
    expect((await st.get(key('empty')))!.length).toBe(0);
  });

  it('prefix is prepended to the object path', async () => {
    const st = pathStyle({ prefix: '/prod/blobs/' });
    await st.put(key(), binary(), { contentType: 'application/octet-stream' });
    expect(s3.requests[0]!.path).toBe(`/${BUCKET}/prod/blobs/${key()}`);
    expect(s3.objects.has(`prod/blobs/${key()}`)).toBe(true);
    expect(await st.exists(key())).toBe(true);
    expect(await pathStyle().exists(key())).toBe(false); // not visible without the prefix
  });

  it('SSE headers are sent only when configured (AES256, aws:kms + key id)', async () => {
    await pathStyle({ serverSideEncryption: 'AES256' }).put(key('a'), binary(), { contentType: 'x/y' });
    await pathStyle({ serverSideEncryption: 'aws:kms', kmsKeyId: 'arn:aws:kms:us-east-1:111122223333:key/mock' }).put(key('b'), binary(), { contentType: 'x/y' });
    await pathStyle({ serverSideEncryption: null }).put(key('c'), binary(), { contentType: 'x/y' });
    const [a, b, c] = s3.requests;
    expect(a!.headers['x-amz-server-side-encryption']).toBe('AES256');
    expect(a!.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBeUndefined();
    expect(b!.headers['x-amz-server-side-encryption']).toBe('aws:kms');
    expect(b!.headers['x-amz-server-side-encryption-aws-kms-key-id']).toBe('arn:aws:kms:us-east-1:111122223333:key/mock');
    expect(c!.headers['x-amz-server-side-encryption']).toBeUndefined();
    expect(() => pathStyle({ kmsKeyId: 'k' })).toThrow(ProviderError); // key id without aws:kms is a config error
  });

  it('a session token is sent and signed', async () => {
    await pathStyle({ sessionToken: 'session-token-mock' }).put(key(), binary(), { contentType: 'x/y' });
    expect(s3.requests[0]!.headers['x-amz-security-token']).toBe('session-token-mock');
  });

  it('R-TEN-9: keys outside tenants/{uuid}/ or with traversal are rejected before any request, in every method', async () => {
    const st = pathStyle();
    for (const bad of [`tenants/${TENANT}/../other/x`, `tenants/${TENANT}/./x`, 'recordings/x', `tenants/not-a-uuid/x`, `/tenants/${TENANT}/x`]) {
      await expect(st.put(bad, new Uint8Array(1), { contentType: 'x' })).rejects.toThrow(StorageKeyError);
      await expect(st.get(bad)).rejects.toThrow(StorageKeyError);
      await expect(st.exists(bad)).rejects.toThrow(StorageKeyError);
      await expect(st.delete(bad)).rejects.toThrow(StorageKeyError);
    }
    expect(() => pathStyle({ prefix: 'a/../b' })).toThrow(ProviderError);
    expect(s3.requests).toEqual([]);
  });

  it('403 (bad credentials) maps to not_configured S3_FORBIDDEN without leaking secrets or keys', async () => {
    const st = pathStyle({ secretAccessKey: 'wrong-secret-value' });
    const e = await providerError(st.get(key()));
    expect([e.kind, e.providerCode]).toEqual(['not_configured', 'S3_FORBIDDEN']);
    expect(String(e)).not.toContain('wrong-secret-value');
    expect(s3.requests.length).toBe(1); // 403 is not retried
    s3.sigFailures.length = 0; // this one was deliberate
  });

  it('other 4xx map to rejected S3_HTTP_<status> without retry; a missing bucket is not_configured', async () => {
    s3.script.push(400);
    const e = await providerError(pathStyle().put(key(), binary(), { contentType: 'x' }));
    expect([e.kind, e.providerCode]).toEqual(['rejected', 'S3_HTTP_400']);
    expect(s3.requests.length).toBe(1);
    const nb = await providerError(new S3Storage({ endpoint: s3.url, region: REGION, bucket: 'other-bucket', ...CREDS, forcePathStyle: true }).get(key()));
    expect([nb.kind, nb.providerCode]).toEqual(['not_configured', 'S3_NO_SUCH_BUCKET']);
  });

  it('500 then 200: the retry succeeds', async () => {
    const st = pathStyle();
    const bytes = binary();
    s3.script.push(500);
    await st.put(key(), bytes, { contentType: 'x' });
    expect(s3.requests.map((r) => r.method)).toEqual(['PUT', 'PUT']);
    s3.script.push(429, 503);
    expect(Buffer.from((await st.get(key()))!).equals(Buffer.from(bytes))).toBe(true);
  });

  it('persistent 503 gives unavailable S3_HTTP_503 after at most two retries', async () => {
    s3.script.push(503, 503, 503, 503);
    const e = await providerError(pathStyle().exists(key()));
    expect([e.kind, e.providerCode]).toEqual(['unavailable', 'S3_HTTP_503']);
    expect(s3.requests.length).toBe(3);
  });

  it('a hung response gives timeout (not retried)', async () => {
    s3.script.push('hang');
    const e = await providerError(pathStyle({ timeoutMs: 150 }).get(key()));
    expect([e.kind, e.providerCode]).toEqual(['timeout', 'S3_TIMEOUT']);
    expect(s3.requests.length).toBe(1);
  });

  it('a refused connection gives unavailable S3_NETWORK after retries', async () => {
    const dead = createServer();
    await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
    const { port } = dead.address() as AddressInfo;
    await new Promise<void>((r) => dead.close(() => r()));
    let calls = 0;
    const counting: typeof fetch = (input, init) => {
      calls++;
      return fetch(input, init);
    };
    const e = await providerError(new S3Storage({ endpoint: `http://127.0.0.1:${port}`, region: REGION, bucket: BUCKET, ...CREDS, forcePathStyle: true, fetch: counting }).get(key()));
    expect([e.kind, e.providerCode]).toEqual(['unavailable', 'S3_NETWORK']);
    expect(calls).toBe(3);
  });
});

describe('S3Storage virtual-hosted style (default AWS endpoint)', () => {
  it('addresses https://{bucket}.s3.{region}.amazonaws.com/{key} and signs that Host', async () => {
    const seenUrls: string[] = [];
    // Route the AWS URL to the mock: keep path and query, forward the original Host for the
    // server's signature check (fetch always sends the connection's Host itself).
    const rewrite: typeof fetch = (input, init) => {
      const u = new URL(input instanceof Request ? input.url : String(input));
      seenUrls.push(u.href);
      const headers = new Headers(init?.headers);
      headers.set('x-test-original-host', u.host);
      return fetch(`${s3.url}${u.pathname}${u.search}`, { ...init, headers });
    };
    const st = new S3Storage({ region: REGION, bucket: BUCKET, ...CREDS, fetch: rewrite, prefix: 'p' });
    const bytes = binary();
    await st.put(key(), bytes, { contentType: 'application/octet-stream' });
    expect(Buffer.from((await st.get(key()))!).equals(Buffer.from(bytes))).toBe(true);
    expect(seenUrls[0]).toBe(`https://${BUCKET}.s3.${REGION}.amazonaws.com/p/${key()}`);
    expect(s3.requests[0]!.host).toBe(`${BUCKET}.s3.${REGION}.amazonaws.com`);
    expect(s3.requests[0]!.headers.authorization).toContain('SignedHeaders=content-md5;content-type;host;x-amz-content-sha256;x-amz-date,');
    expect(s3.objects.has(`p/${key()}`)).toBe(true);
    expect(st.objectUrl(key()).href).toBe(seenUrls[0]);
    expect(pathStyle().objectUrl(key()).href).toBe(`${s3.url}/${BUCKET}/${key()}`);
  });
});

// ---- (c) real envelope encryption into S3Storage ------------------------------------------------

describe('envelope-encrypted objects through S3Storage', () => {
  let h: ApiHarness;
  let owner: TestClient;
  beforeAll(async () => {
    h = await createApiHarness();
    owner = await h.signup();
  });
  afterAll(async () => {
    await h?.close();
  });

  it('R-DATA-1: putObject/getObject round trip via S3; the bucket only ever sees ciphertext', async () => {
    const storage = pathStyle();
    const t = owner.tenantId!;
    const objectId = '01a1c4ba-0000-7000-8000-0000000005e1';
    const plaintext = new Uint8Array(Buffer.concat([Buffer.from('RIFF-plaintext-marker-'), randomBytes(2048)]));
    const sealed = await withTenantTx(owner.actor(), async (tx) => putObject(h.app.platform.envelope.inTx(tx, t), storage, t, objectId, 'recording', plaintext, 'audio/wav'), { db: h.database });
    const stored = s3.objects.get(sealed.storageKey)!.bytes;
    expect(stored.length).toBeGreaterThan(plaintext.length); // header + nonce + tag
    for (const r of s3.requests) {
      expect(r.body.includes(Buffer.from('plaintext-marker'))).toBe(false);
      expect(r.body.includes(Buffer.from(plaintext.slice(100, 164)))).toBe(false);
    }
    const back = await withTenantTx(owner.actor(), async (tx) => getObject(h.app.platform.envelope.inTx(tx, t), storage, t, objectId, sealed.storageKey, sealed.dekWrapped), { db: h.database });
    expect(Buffer.from(back!).equals(Buffer.from(plaintext))).toBe(true);
  });
});
