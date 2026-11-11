// Short-lived signed image URLs (module 29). Instagram fetches a post's images from a publicly reachable URL
// (VERIFY with Meta's content publishing API), so a published piece's assets are exposed ONLY through these links:
// HMAC-SHA256 (key derived per purpose from the server secret) over tenant, object and expiry. The link names nothing
// else; GET /api/public/marketing-assets/:token checks the MAC and the expiry, then serves the object only while it is
// still a live marketing asset of a piece (as that tenant's system actor).
import { createHmac, timingSafeEqual } from 'node:crypto';

const PURPOSE = 'marketing-asset-link/v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(secret: Uint8Array): Buffer {
  return createHmac('sha256', Buffer.from(secret)).update(PURPOSE).digest();
}

function mac(secret: Uint8Array, payload: Buffer): Buffer {
  return createHmac('sha256', key(secret)).update(payload).digest().subarray(0, 16);
}

const hexToBytes = (u: string): Buffer => Buffer.from(u.replace(/-/g, ''), 'hex');
const bytesToUuid = (b: Buffer): string => {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

/** A compact token (Fastify keeps URL parameters short): 16-byte tenant, 16-byte object, 4-byte expiry, 16-byte MAC. */
export function assetLinkToken(secret: Uint8Array, a: { tenantId: string; objectId: string; expiresAt: number }): string {
  const exp = Buffer.alloc(4);
  exp.writeUInt32BE(Math.floor(a.expiresAt / 1000) >>> 0);
  const payload = Buffer.concat([hexToBytes(a.tenantId), hexToBytes(a.objectId), exp]);
  return Buffer.concat([payload, mac(secret, payload)]).toString('base64url');
}

export function signedAssetUrl(c: { publicBaseUrl: string; secret: Uint8Array }, a: { tenantId: string; objectId: string; expiresAt: number }): string {
  return `${c.publicBaseUrl.replace(/\/+$/, '')}/api/public/marketing-assets/${assetLinkToken(c.secret, a)}`;
}

/** The link's tenant and object, or null for a bad MAC, a malformed token or an expired link. */
export function verifyAssetLink(secret: Uint8Array, token: string, nowMs: number): { tenantId: string; objectId: string } | null {
  if (!/^[A-Za-z0-9_-]{60,80}$/.test(token)) return null;
  const raw = Buffer.from(token, 'base64url');
  if (raw.length !== 52) return null;
  const payload = raw.subarray(0, 36);
  const got = raw.subarray(36);
  const want = mac(secret, payload);
  if (!timingSafeEqual(want, got)) return null;
  if (payload.readUInt32BE(32) * 1000 <= nowMs) return null;
  const tenantId = bytesToUuid(payload.subarray(0, 16));
  const objectId = bytesToUuid(payload.subarray(16, 32));
  if (!UUID_RE.test(tenantId) || !UUID_RE.test(objectId)) return null;
  return { tenantId, objectId };
}
