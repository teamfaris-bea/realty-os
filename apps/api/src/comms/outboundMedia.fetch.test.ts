// D5a provider fetch route GET /api/mms/media?token= (R-MMS-6, E296): MAC first, then 12 fetches per item per hour,
// then the message state and the object; every refusal is the same 404 (status, code, headers; the body differs only
// in its request id), for GET and HEAD; the token is in no log line, error report, audit row, job payload or response.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import type { MemoryErrorReporter } from '../observability/errors.js';
import { mediaToken } from './outboundMedia.js';
import { jpeg, png, sendPhotoText, uploadId } from './outboundMedia.testing.js';
import { type CommsWorld, call, commsWorld, ownedContact } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness({ logLevel: 'info' });
  w = await commsWorld(h, { agents: 1 });
  agent = w.agents[0]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const fetchAs = (method: 'GET' | 'HEAD', path: string) => h.app.inject({ method, url: path });
const pathOf = (url: string) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

/** A sent photo text with `n` items; its media URLs as the fake recorded them. */
async function sentPhotoText(n = 1): Promise<{ messageId: string; contactId: string; urls: string[] }> {
  const c = await ownedContact(agent);
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await uploadId(agent, c.id, i % 2 ? jpeg() : png(), i % 2 ? 'image/jpeg' : 'image/png'));
  const r = await sendPhotoText(agent, c.id, ids, 'Photos');
  expect(r.body.result).toBe('sent');
  const urls = h.providers.telephony.sms.find((m) => m.idempotencyKey === r.body.message!.id)!.mediaUrls;
  return { messageId: r.body.message!.id, contactId: c.id, urls };
}

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;
const expiryOf = (token: string) => Number(Buffer.from(token.slice(0, 55), 'base64url').readBigUInt64BE(33));
const mint = (o: { tenantId?: string; messageId: string; position: number; expiry: number }) =>
  `/api/mms/media?token=${mediaToken(h.config.sessionSecret, { tenantId: o.tenantId ?? w.tenantId, ...o })}`;

/** The shape every refusal must share: status, code, headers (minus the per-request ones), body without the request id. */
async function refusalShape(method: 'GET' | 'HEAD', path: string) {
  const r = await fetchAs(method, path);
  const headers = { ...r.headers } as Record<string, unknown>;
  delete headers.date;
  const body = r.body === '' ? '' : JSON.stringify({ ...(JSON.parse(r.body) as { error: object }), error: { ...(JSON.parse(r.body) as { error: object }).error, requestId: 'X' } });
  return { status: r.statusCode, headers, body };
}

describe('E296: every refusal of the media URL is the same 404, for GET and HEAD', () => {
  it('E296: malformed, repeated, extra-parameter, tampered, other tenant\'s, wrong-position and expired tokens', async () => {
    const s = await sentPhotoText(1);
    const t = tokenOf(s.urls[0]!);
    const exp = expiryOf(t);
    const other = await commsWorld(h, { agents: 1 });
    const tampered = t.slice(0, -1) + (t.endsWith('A') ? 'B' : 'A');
    const paths = [
      '/api/mms/media',
      '/api/mms/media?token=abc',
      `/api/mms/media?token=${t}&token=${t}`,
      `/api/mms/media?token=${t}&x=1`,
      `/api/mms/media?token=${tampered}`,
      mint({ tenantId: other.tenantId, messageId: s.messageId, position: 0, expiry: exp }),
      mint({ messageId: s.messageId, position: 5, expiry: exp }),
      mint({ messageId: s.messageId, position: 0, expiry: Math.floor(Date.now() / 1000) - 1 }),
    ];
    for (const method of ['GET', 'HEAD'] as const) {
      const shapes = [];
      for (const p of paths) shapes.push(await refusalShape(method, p));
      for (const [i, x] of shapes.entries()) {
        expect(x.status, `${method} ${i}`).toBe(404);
        expect(x, `${method} ${i}`).toEqual(shapes[0]);
      }
      if (method === 'GET') expect(JSON.parse(shapes[0]!.body).error.code).toBe('NOT_FOUND');
    }
    // the real token still works
    expect((await fetchAs('GET', pathOf(s.urls[0]!))).statusCode).toBe(200);
  });

  it('E296: an expired token by the DB clock (dispatched_at aged, the URL re-minted from it) is refused', async () => {
    const s = await sentPhotoText(1);
    await h.su.query("UPDATE messages SET dispatched_at = now() - interval '11 hours' WHERE id = $1", [s.messageId]);
    const row = (await h.su.query('SELECT dispatched_at FROM messages WHERE id = $1', [s.messageId])).rows[0].dispatched_at as Date;
    const expiry = Math.floor(row.getTime() / 1000) + 36_000 + 1200;
    expect((await fetchAs('GET', mint({ messageId: s.messageId, position: 0, expiry }))).statusCode).toBe(404);
  });

  it('E296: a message that failed, was canceled or delivered, and a shredded object, are refused', async () => {
    const base = (await refusalShape('GET', '/api/mms/media?token=abc'));
    for (const status of ['failed', 'canceled', 'delivered']) {
      const s = await sentPhotoText(1);
      await h.su.query('UPDATE messages SET status = $2 WHERE id = $1', [s.messageId, status]);
      for (const method of ['GET', 'HEAD'] as const) {
        const x = await refusalShape(method, pathOf(s.urls[0]!));
        expect(x.status, status).toBe(404);
        if (method === 'GET') expect(x).toEqual(base);
      }
    }
    const s = await sentPhotoText(1);
    await h.su.query('UPDATE stored_objects o SET dek_wrapped = NULL, deleted_at = now() FROM message_media mm WHERE mm.object_id = o.id AND mm.message_id = $1', [s.messageId]);
    expect(await refusalShape('GET', pathOf(s.urls[0]!))).toEqual(base);
  });

  it('E296: the 13th fetch of an item in an hour (HEAD and GET both count) is the same 404', async () => {
    const s = await sentPhotoText(1);
    const p = pathOf(s.urls[0]!);
    for (let i = 0; i < 6; i++) {
      expect((await fetchAs('HEAD', p)).statusCode).toBe(200);
      expect((await fetchAs('GET', p)).statusCode).toBe(200);
    }
    const base = await refusalShape('GET', '/api/mms/media?token=abc');
    expect(await refusalShape('GET', p)).toEqual(base);
  });

  it('R-MMS-6: a 10-item text whose items are each fetched HEAD+GET twice is served in full', async () => {
    const s = await sentPhotoText(10);
    expect(s.urls).toHaveLength(10);
    for (let round = 0; round < 2; round++) {
      const pulled = await h.providers.telephony.pullMedia(s.messageId, async (method, url) => {
        const r = await fetchAs(method, pathOf(url));
        return { status: r.statusCode, headers: r.headers as Record<string, string | undefined>, body: new Uint8Array(r.rawPayload) };
      });
      expect(pulled).toHaveLength(10);
    }
  });
});

describe('R-MMS-6: the token appears nowhere but the provider request', () => {
  it('R-MMS-6: no log line, error report, audit row, job payload, or compose / preview / timeline / attachments response holds a token or "/api/mms/media"', async () => {
    const c = await ownedContact(agent);
    const ids = [await uploadId(agent, c.id)];
    const compose = await sendPhotoText(agent, c.id, ids, 'The porch');
    const messageId = compose.body.message!.id;
    const urls = h.providers.telephony.sms.find((m) => m.idempotencyKey === messageId)!.mediaUrls;
    // fetch it (and refuse a bad one) so the route itself has logged
    await fetchAs('GET', pathOf(urls[0]!));
    await fetchAs('GET', `${pathOf(urls[0]!)}x`);
    const tokens = urls.map(tokenOf);
    const responses = [
      JSON.stringify(compose.body),
      JSON.stringify((await call(agent, 'POST', `/contacts/${c.id}/messages/preview`, { channel: 'sms', body: 'x', withMedia: true })).body),
      JSON.stringify((await call(agent, 'GET', `/contacts/${c.id}/timeline`)).body),
      JSON.stringify((await call(agent, 'GET', `/contacts/${c.id}/attachments`)).body),
    ];
    const audit = JSON.stringify((await h.su.query('SELECT * FROM audit_log WHERE tenant_id = $1', [w.tenantId])).rows);
    const jobs = JSON.stringify((await h.su.query('SELECT kind, payload FROM jobs WHERE tenant_id = $1', [w.tenantId])).rows);
    const reports = JSON.stringify((h.app.platform.errorReporter as MemoryErrorReporter).events ?? []);
    const haystacks = { logs: h.logs.join('\n'), reports, audit, jobs, ...Object.fromEntries(responses.map((r, i) => [`response${i}`, r])) };
    expect(h.logs.length).toBeGreaterThan(0);
    for (const [name, hay] of Object.entries(haystacks)) {
      // the API logs the route template ("/api/mms/media", no query) by design; a URL with its query never appears
      expect(hay.includes(name === 'logs' ? '/api/mms/media?' : '/api/mms/media'), name).toBe(false);
      expect(hay.includes('mms/media?token'), name).toBe(false);
      for (const t of tokens) {
        expect(hay.includes(t), name).toBe(false);
        expect(hay.includes(t.slice(0, 55)), name).toBe(false);
      }
    }
    // the cleanup job carries ids only
    expect(jobs).toContain('comms.mms_provider_cleanup');
    void randomUUID;
  });
});
