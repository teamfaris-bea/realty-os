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

function mac(secret: Uint8Array, payload: string): string {
  return createHmac('sha256', key(secret)).update(payload).digest('base64url');
}

export function assetLinkToken(secret: Uint8Array, a: { tenantId: string; objectId: string; expiresAt: number }): string {
  const payload = `${a.tenantId.toLowerCase()}.${a.objectId.toLowerCase()}.${Math.floor(a.expiresAt / 1000)}`;
  return `${Buffer.from(payload).toString('base64url')}.${mac(secret, payload)}`;
}

export function signedAssetUrl(c: { publicBaseUrl: string; secret: Uint8Array }, a: { tenantId: string; objectId: string; expiresAt: number }): string {
  return `${c.publicBaseUrl.replace(/\/+$/, '')}/api/public/marketing-assets/${assetLinkToken(c.secret, a)}`;
}

/** The link's tenant and object, or null for a bad MAC, a malformed token or an expired link. */
export function verifyAssetLink(secret: Uint8Array, token: string, nowMs: number): { tenantId: string; objectId: string } | null {
  if (token.length > 400) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  let payload: string;
  try {
    payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const want = Buffer.from(mac(secret, payload));
  const got = Buffer.from(token.slice(dot + 1));
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [tenantId, objectId, exp] = payload.split('.');
  if (!tenantId || !objectId || !exp || !UUID_RE.test(tenantId) || !UUID_RE.test(objectId) || !/^\d{1,12}$/.test(exp)) return null;
  if (Number(exp) * 1000 <= nowMs) return null;
  return { tenantId, objectId };
}
