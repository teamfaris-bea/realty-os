// Test helpers for the D5a photo-text tests (imported by *.test.ts only). Every fixture is synthetic bytes built here:
// no real photo, invented coordinates only.
import { randomUUID } from 'node:crypto';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { FAKE_PNG } from '../providers/fake/telephony.js';
import { call } from './testing.js';

export const cat = (...parts: (Uint8Array | number[] | string)[]): Uint8Array =>
  Uint8Array.from(parts.flatMap((p) => (typeof p === 'string' ? [...Buffer.from(p, 'latin1')] : [...p])));
const seg = (marker: number, payload: Uint8Array | number[] | string) => {
  const p = cat(payload);
  return cat([0xff, marker, (p.length + 2) >> 8, (p.length + 2) & 0xff], p);
};
const be32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];

/** A structurally valid baseline JPEG; `gps` adds an Exif APP1 naming an invented location. */
export function jpeg(o: { gps?: boolean; pad?: number } = {}): Uint8Array {
  const exif = o.gps ? [seg(0xe1, cat('Exif\0\0', 'MM', [0, 42], be32(8), [0, 0], be32(0), 'GPS 12.3456 -65.4321'))] : [];
  return cat(
    [0xff, 0xd8],
    seg(0xe0, cat('JFIF\0', [1, 2, 0, 0, 1, 0, 1, 0, 0])),
    ...exif,
    seg(0xdb, cat([0], new Uint8Array(64).fill(1))),
    seg(0xc0, [8, 0, 16, 0, 16, 1, 1, 0x11, 0]),
    seg(0xc4, cat([0], [0, 1, ...new Array<number>(14).fill(0)], [0])),
    seg(0xda, [1, 1, 0, 0, 63, 0]),
    new Uint8Array(o.pad ?? 16).fill(0x12),
    [0xff, 0xd9],
  );
}

export const png = (): Uint8Array => FAKE_PNG;

/** An MP4 (ftyp `brand`) of about `size` bytes: ftyp, an empty moov, then mdat. */
export function mp4(size = 2_000, brand = 'isom'): Uint8Array {
  const ftyp = cat(be32(24), 'ftyp', brand, be32(0), 'isom', 'mp42');
  const moov = cat(be32(8), 'moov');
  const mdatLen = Math.max(8, size - ftyp.length - moov.length);
  return cat(ftyp, moov, be32(mdatLen), 'mdat', new Uint8Array(mdatLen - 8).fill(7));
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

export async function upload(agent: TestClient, contactId: string, bytes: Uint8Array = jpeg(), contentType = 'image/jpeg') {
  return call<{ upload: { id: string; contentType: string; byteSize: number; expiresAt: string } }>(agent, 'POST', `/contacts/${contactId}/outbound-media`, { contentType, data: b64(bytes) });
}

export async function uploadId(agent: TestClient, contactId: string, bytes?: Uint8Array, contentType?: string): Promise<string> {
  const r = await upload(agent, contactId, bytes, contentType);
  if (r.status !== 201) throw new Error(`upload: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.upload.id;
}

export async function sendPhotoText(agent: TestClient, contactId: string, mediaIds: string[], body = '', extra: Record<string, unknown> = {}) {
  return call<{ message: { id: string; channel: string; status: string; statusReason: string | null; body: string } | null; decision: { id: string | null; outcome: string; reasons: string[] } | null; result: string }>(
    agent,
    'POST',
    `/contacts/${contactId}/messages`,
    { channel: 'sms', body, idempotencyKey: `k-${randomUUID()}`, mediaIds, ...extra },
  );
}

/** A provider fetch through the app (HEAD or GET), shaped for FakeTelephony.pullMedia. */
export function appFetch(h: ApiHarness) {
  return async (method: 'HEAD' | 'GET', url: string) => {
    const u = new URL(url);
    const r = await h.app.inject({ method, url: `${u.pathname}${u.search}` });
    return { status: r.statusCode, headers: r.headers as Record<string, string | undefined>, body: new Uint8Array(r.rawPayload) };
  };
}

export async function mediaRows(h: ApiHarness, messageId: string): Promise<{ position: number; object_id: string; content_type: string; byte_size: string; deleted_at: Date | null }[]> {
  return (await h.su.query('SELECT mm.position, mm.object_id, o.content_type, o.byte_size, o.deleted_at FROM message_media mm JOIN stored_objects o ON o.tenant_id = mm.tenant_id AND o.id = mm.object_id WHERE mm.message_id = $1 ORDER BY mm.position', [messageId])).rows;
}
