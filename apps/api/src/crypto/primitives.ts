// Small crypto primitives (node:crypto only). Envelope encryption builds on these; nothing outside
// apps/api/src/crypto and apps/api/src/auth should need them directly.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes as nodeRandomBytes, timingSafeEqual } from 'node:crypto';

export function randomBytes(n: number): Uint8Array {
  return new Uint8Array(nodeRandomBytes(n));
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256(key: Uint8Array, data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHmac('sha256', key).update(data).digest());
}

export function hmacSha256Hex(key: Uint8Array, data: Uint8Array | string): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

/** Constant-time equality for equal-length inputs; different lengths compare false. */
export function constantTimeEqual(a: Uint8Array | string, b: Uint8Array | string): boolean {
  const x = typeof a === 'string' ? Buffer.from(a) : Buffer.from(a);
  const y = typeof b === 'string' ? Buffer.from(b) : Buffer.from(b);
  if (x.length !== y.length) {
    // still spend the comparison so length mismatch does not short-circuit observably
    timingSafeEqual(x, x);
    return false;
  }
  return timingSafeEqual(x, y);
}

export function base64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

export function fromBase64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function hkdf(key: Uint8Array, salt: string, info: string, length = 32): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', key, salt, info, length));
}

// ---- AES-256-GCM with the Phase 1 ciphertext format -------------------------------------------
//   0x01 | key_version u32 (big-endian) | nonce 12 | ciphertext | tag 16      (ARCHITECTURE §8)

export const CIPHERTEXT_FORMAT = 0x01;
const HEADER = 1 + 4 + 12;
const TAG = 16;

export class DecryptError extends Error {
  override readonly name = 'DecryptError';
  constructor(readonly reason: 'format' | 'key_version' | 'auth') {
    super(`decrypt failed: ${reason}`);
  }
}

export function sealGcm(key: Uint8Array, keyVersion: number, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  if (key.length !== 32) throw new RangeError('AES-256-GCM key must be 32 bytes');
  if (!Number.isInteger(keyVersion) || keyVersion < 1 || keyVersion > 0xffff_ffff) throw new RangeError('key version must be a u32 >= 1');
  const nonce = nodeRandomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  const body = Buffer.concat([c.update(plaintext), c.final()]);
  const out = Buffer.alloc(HEADER + body.length + TAG);
  out[0] = CIPHERTEXT_FORMAT;
  out.writeUInt32BE(keyVersion, 1);
  nonce.copy(out, 5);
  body.copy(out, HEADER);
  c.getAuthTag().copy(out, HEADER + body.length);
  return new Uint8Array(out);
}

/** The key version stored in a ciphertext header (format check only, no authentication). */
export function ciphertextKeyVersion(ct: Uint8Array): number {
  if (ct.length < HEADER + TAG || ct[0] !== CIPHERTEXT_FORMAT) throw new DecryptError('format');
  return Buffer.from(ct.buffer, ct.byteOffset, ct.byteLength).readUInt32BE(1);
}

export function openGcm(key: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  if (ct.length < HEADER + TAG || ct[0] !== CIPHERTEXT_FORMAT) throw new DecryptError('format');
  const b = Buffer.from(ct.buffer, ct.byteOffset, ct.byteLength);
  const nonce = b.subarray(5, HEADER);
  const body = b.subarray(HEADER, b.length - TAG);
  const tag = b.subarray(b.length - TAG);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([d.update(body), d.final()]));
  } catch {
    throw new DecryptError('auth');
  }
}
