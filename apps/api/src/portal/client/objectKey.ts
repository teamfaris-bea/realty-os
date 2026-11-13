// Decrypting a client download without any staff or system transaction (R-PORTAL-17; finding F1).
//
// portal.document_download returns the object row plus the ONE tenant `object` key its DEK is wrapped under, still
// wrapped under the platform KEK. This Envelope implements only unwrapObjectKey, for that one object: it refuses
// unless the wrapped DEK's key version is the returned key's version, unwraps the tenant key with the platform KEK
// (AAD tenant_keys|tenant|object|version), opens the DEK under the object's own AAD, and zeroes the tenant key.
// getObject zeroes the DEK. Every other method throws CryptoContextError.
import type { TenantId } from '@realty/core/foundation';
import { CryptoContextError, type Envelope, encodeAad } from '../../crypto/envelope.js';
import { type Kek, tenantKeyAad } from '../../crypto/kek.js';
import { DecryptError, ciphertextKeyVersion, openGcm } from '../../crypto/primitives.js';

export interface WrappedObjectKey {
  tenantId: TenantId;
  objectId: string;
  objectKeyWrapped: Uint8Array;
  objectKeyVersion: number;
}

export function portalObjectEnvelope(kek: Kek, k: WrappedObjectKey): Envelope {
  const tenant = k.tenantId.toLowerCase();
  const object = k.objectId.toLowerCase();
  const refuse = async (): Promise<never> => {
    throw new CryptoContextError('the portal download envelope only unwraps its one object key');
  };
  return {
    encrypt: refuse,
    decrypt: refuse,
    hmacAddress: refuse,
    wrapObjectKey: refuse,
    async unwrapObjectKey(tenantId, objectId, dekWrapped) {
      if (tenantId.toLowerCase() !== tenant || objectId.toLowerCase() !== object) throw new CryptoContextError('another tenant or object');
      if (ciphertextKeyVersion(dekWrapped) !== k.objectKeyVersion) throw new DecryptError('key_version');
      const key = await kek.unwrap(tenantKeyAad(tenant, 'object', k.objectKeyVersion), new Uint8Array(k.objectKeyWrapped));
      try {
        return openGcm(key, encodeAad(tenant, { table: 'stored_objects', column: 'dek_wrapped', rowId: object }), dekWrapped);
      } finally {
        key.fill(0);
      }
    },
  };
}
