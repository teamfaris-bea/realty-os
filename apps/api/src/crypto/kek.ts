// The key-encryption key (ARCHITECTURE §8 key hierarchy). The KEK wraps the tenant keys
// (`field`, `object`, `hmac`) and derives the platform keys (MFA secrets, webhook payloads).
//
// Phase 1 ships the local KEK (32 bytes from KEK_BASE64). Production replaces it with a KMS-backed
// implementation of the same interface (wrap/unwrap become KMS Encrypt/Decrypt with the AAD as the
// encryption context); that adapter needs a cloud account and is not built here.
import { hkdf, openGcm, sealGcm } from './primitives.js';

export interface Kek {
  /** Stored in tenant_keys.kek_ref so a future KEK rotation knows which KEK wrapped a key. */
  readonly ref: string;
  wrap(aad: string, key: Uint8Array): Promise<Uint8Array>;
  unwrap(aad: string, wrapped: Uint8Array): Promise<Uint8Array>;
  /** A 32-byte platform key for `purpose` (users are global, so MFA secrets use a platform key). */
  platformKey(purpose: 'mfa' | 'webhook' | 'platform_field'): Uint8Array;
}

export function localKek(key: Uint8Array, ref: string): Kek {
  if (key.length !== 32) throw new RangeError('KEK must be 32 bytes');
  const k = new Uint8Array(key);
  const cache = new Map<string, Uint8Array>();
  return {
    ref,
    async wrap(aad, dek) {
      return sealGcm(k, 1, Buffer.from(`kek|${aad}`), dek);
    },
    async unwrap(aad, wrapped) {
      return openGcm(k, Buffer.from(`kek|${aad}`), wrapped);
    },
    platformKey(purpose) {
      let v = cache.get(purpose);
      if (!v) {
        v = hkdf(k, 'realty-platform-keys', `platform:${purpose}:v1`);
        cache.set(purpose, v);
      }
      return v;
    },
  };
}

/** AAD under which a tenant key is wrapped: binds tenant, purpose and version. */
export function tenantKeyAad(tenantId: string, purpose: 'field' | 'object' | 'hmac', version: number): string {
  return `tenant_keys|${tenantId.toLowerCase()}|${purpose}|${version}`;
}
