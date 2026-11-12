// D5a uploads (POST/DELETE /contacts/:id/outbound-media; R-MMS-3, R-MMS-4, E293, E294, E295): authenticated before the
// body is read, identity encoding only, 413 over the cap, the declared type checked against the bytes and the outbound
// allowlist, location removed before storage, 20 live uploads and 60 per hour per user, removal shreds.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, TEST_ORIGIN, createApiHarness } from '../auth/testHarness.js';
import { command, freshReauth } from '../leads/testing.js';
import { b64, cat, jpeg, mp4, png, upload, uploadId } from './outboundMedia.testing.js';
import { MAX_UPLOAD_BASE64_CHARS } from './schemas.js';
import { type CommsWorld, call, commsWorld, ownedContact } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2 });
  agent = w.agents[0]!;
  agent2 = w.agents[1]!;
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const raw = (c: TestClient | null, contactId: string, payload: string, headers: Record<string, string> = {}) =>
  h.app.inject({
    method: 'POST',
    url: `/api/contacts/${contactId}/outbound-media`,
    headers: { 'content-type': 'application/json', origin: TEST_ORIGIN, ...(c?.cookie ? { cookie: `__Host-sid=${c.cookie}`, 'x-csrf-token': c.csrf ?? '' } : {}), ...headers },
    payload,
  });

describe('E293 / E294 / E295: the upload pipeline', () => {
  it('E293: a body over the cap is 413 before it is read; Content-Encoding is refused; an anonymous caller gets 401 first', async () => {
    const c = await ownedContact(agent);
    const big = JSON.stringify({ contentType: 'image/jpeg', data: 'A'.repeat(MAX_UPLOAD_BASE64_CHARS + 8192) });
    expect((await raw(agent, c.id, big)).statusCode).toBe(413);
    expect((await raw(null, c.id, big)).statusCode).toBe(401);
    const small = JSON.stringify({ contentType: 'image/jpeg', data: b64(jpeg()) });
    const enc = await raw(agent, c.id, small, { 'content-encoding': 'gzip' });
    expect(enc.statusCode).toBe(415);
  });

  it('E293: another tenant\'s caller gets 404 and a merged-away record gets 409 CONTACT_MERGED', async () => {
    const c = await ownedContact(agent);
    const other = await commsWorld(h, { agents: 1 });
    expect((await upload(other.agents[0]!, c.id)).status).toBe(404);
    const s = await ownedContact(agent, { consent: false });
    const l = await ownedContact(agent, { consent: false, confirmDistinct: true, firstName: 'Jean' });
    await freshReauth(h, w.owner);
    expect((await command(w.owner, s.id, 'merge', { loserId: l.id })).status).toBe(200);
    const r = await upload(w.owner, l.id);
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe('CONTACT_MERGED');
  });

  it('E294: a declared type that is not the bytes, a disguised brand, SVG, HTML and a structure the strip cannot walk are MEDIA_NOT_ALLOWED; nothing is stored', async () => {
    const c = await ownedContact(agent);
    const before = Number((await h.su.query('SELECT count(*) AS n FROM stored_objects WHERE tenant_id = $1', [w.tenantId])).rows[0].n);
    const cases: [string, Uint8Array][] = [
      ['image/jpeg', png()],
      ['video/mp4', mp4(2000, 'heic')],
      ['video/mp4', mp4(2000, 'M4A ')],
      ['image/jpeg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
      ['image/png', new TextEncoder().encode('<html><script>alert(1)</script></html>')],
      ['image/jpeg', jpeg().subarray(0, 40)], // no EOI: MALFORMED
    ];
    for (const [type, bytes] of cases) {
      const r = await upload(agent, c.id, bytes, type);
      expect(r.status, type).toBe(422);
      expect((r.body as unknown as { error: { code: string } }).error.code).toBe('MEDIA_NOT_ALLOWED');
    }
    const svg = await call(agent, 'POST', `/contacts/${c.id}/outbound-media`, { contentType: 'image/svg+xml', data: b64(png()) });
    expect(svg.status).toBe(422);
    const after = Number((await h.su.query('SELECT count(*) AS n FROM stored_objects WHERE tenant_id = $1', [w.tenantId])).rows[0].n);
    expect(after).toBe(before);
  });

  it('E293: a video over 500,000 bytes is MEDIA_TOO_LARGE {limitBytes 500000, scope item}', async () => {
    const c = await ownedContact(agent);
    const r = await upload(agent, c.id, mp4(500_001), 'video/mp4');
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: { code: 'MEDIA_TOO_LARGE', details: { limitBytes: 500_000, scope: 'item' } } });
    expect((await upload(agent, c.id, mp4(400_000), 'video/mp4')).status).toBe(201);
  });

  it('E295: a photo\'s Exif location is removed before storage, and a video naming a location is MEDIA_LOCATION_NOT_REMOVED', async () => {
    const c = await ownedContact(agent);
    const id = await uploadId(agent, c.id, jpeg({ gps: true }));
    const row = (await h.su.query('SELECT o.byte_size FROM outbound_media_uploads u JOIN stored_objects o ON o.tenant_id = u.tenant_id AND o.id = u.object_id WHERE u.id = $1', [id])).rows[0];
    expect(Number(row.byte_size)).toBe(jpeg().length); // the GPS APP1 is gone: the clean file's size
    // a location box deep in the mdat-free part of a video (outside the blanked boxes)
    const v = mp4(3000);
    // ftyp, then moov/trak holding a ©xyz box (not one of the blanked udta/meta/uuid), then the rest
    const located = cat(v.subarray(0, 24), [0, 0, 0, 24], 'moov', [0, 0, 0, 16], 'trak', [0, 0, 0, 8], [0xa9, 0x78, 0x79, 0x7a], v.subarray(32));
    const r = await upload(agent, c.id, located, 'video/mp4');
    expect(r.status).toBe(422);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe('MEDIA_LOCATION_NOT_REMOVED');
  });

  it('R-MMS-3: the 21st live upload is MEDIA_UPLOAD_LIMIT; removal answers 204 and shreds; another user\'s upload is 404', async () => {
    const c = await ownedContact(agent2);
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await uploadId(agent2, c.id, png(), 'image/png'));
    const r = await upload(agent2, c.id, png(), 'image/png');
    expect(r.status).toBe(409);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe('MEDIA_UPLOAD_LIMIT');
    expect((await call(agent, 'DELETE', `/contacts/${c.id}/outbound-media/${ids[0]}`)).status).toBe(404);
    const del = await call(agent2, 'DELETE', `/contacts/${c.id}/outbound-media/${ids[0]}`);
    expect(del.status).toBe(204);
    const o = (await h.su.query('SELECT o.deleted_at, o.dek_wrapped FROM stored_objects o WHERE o.created_by_user_id = $1 ORDER BY o.created_at LIMIT 1', [agent2.userId])).rows[0];
    expect(o.deleted_at).not.toBeNull();
    expect(o.dek_wrapped).toBeNull();
    expect((await call(agent2, 'DELETE', `/contacts/${c.id}/outbound-media/${ids[0]}`)).status).toBe(404);
  });

  it('R-MMS-3: the 61st upload in an hour is RATE_LIMITED; the file name is never stored', async () => {
    const fresh = (await commsWorld(h, { agents: 1 })).agents[0]!;
    const c = await ownedContact(fresh);
    for (let i = 0; i < 60; i++) {
      const r = await upload(fresh, c.id, png(), 'image/png');
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      await call(fresh, 'DELETE', `/contacts/${c.id}/outbound-media/${r.body.upload.id}`);
    }
    const r = await upload(fresh, c.id, png(), 'image/png');
    expect(r.status).toBe(429);
    expect((r.body as unknown as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
    const cols = (await h.su.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'outbound_media_uploads'")).rows.map((x) => x.column_name);
    expect(cols.some((x: string) => /name/.test(x))).toBe(false);
  });

  it('R-MMS-3: the answer is {upload: {id, contentType, byteSize, expiresAt}} and expires 24 h later by the DB clock', async () => {
    const c = await ownedContact(agent);
    const r = await upload(agent, c.id, png(), 'image/png');
    expect(r.status).toBe(201);
    expect(Object.keys(r.body.upload).sort()).toEqual(['byteSize', 'contentType', 'expiresAt', 'id']);
    const hours = (Date.parse(r.body.upload.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
  });
});
