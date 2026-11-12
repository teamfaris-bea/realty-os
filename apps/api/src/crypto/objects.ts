// Per-object envelope encryption for blobs (recordings, MMS, import files, consent evidence;
// R-DATA-1, R-TEN-9). Each object gets a fresh DEK; the DEK is wrapped by the tenant `object` key
// and stored in stored_objects.dek_wrapped. The blob is AES-256-GCM under the DEK with AAD binding
// tenant + object id, and stored under `tenants/{tenant_id}/{purpose}/{object_id}`.
//
// Crypto-shred: nulling dek_wrapped (retention/erasure) makes the blob unreadable even before the
// media job deletes it.
import type { TenantId } from '@realty/core/foundation';
import type { ObjectStorage } from '../providers/types.js';
import { type Envelope, encodeAad } from './envelope.js';
import { openGcm, randomBytes, sealGcm, sha256 } from './primitives.js';

// module 29 (additive): 'marketing_asset', a listing photo used by marketing pieces (0018 purpose)
// module 42 (additive): 'document', a deal, listing or contact document (0018 purpose)
export type ObjectPurpose = 'recording' | 'mms' | 'import_file' | 'consent_evidence' | 'marketing_asset' | 'document';

export function storageKeyFor(tenantId: TenantId, purpose: ObjectPurpose, objectId: string): string {
  return `tenants/${tenantId.toLowerCase()}/${purpose}/${objectId.toLowerCase()}`;
}

export interface SealedObject {
  storageKey: string;
  dekWrapped: Uint8Array;
  keyVersion: number;
  /** sha256 of the PLAINTEXT (stored_objects.sha256) */
  sha256: Uint8Array;
  byteSize: number;
}

const blobAad = (tenantId: TenantId, objectId: string) => encodeAad(tenantId, { table: 'stored_objects', column: 'blob', rowId: objectId });

/** Encrypts and stores a blob. The caller inserts the stored_objects row in its transaction. */
export async function putObject(env: Envelope, storage: ObjectStorage, tenantId: TenantId, objectId: string, purpose: ObjectPurpose, plaintext: Uint8Array, contentType: string): Promise<SealedObject> {
  const dek = randomBytes(32);
  const { dekWrapped, keyVersion } = await env.wrapObjectKey(tenantId, objectId, dek);
  const storageKey = storageKeyFor(tenantId, purpose, objectId);
  await storage.put(storageKey, sealGcm(dek, 1, blobAad(tenantId, objectId), plaintext), { contentType });
  dek.fill(0);
  return { storageKey, dekWrapped, keyVersion, sha256: sha256(plaintext), byteSize: plaintext.length };
}

/** Reads and decrypts a blob; null when the blob is gone. Throws DecryptError on a mis-keyed fetch. */
export async function getObject(env: Envelope, storage: ObjectStorage, tenantId: TenantId, objectId: string, storageKey: string, dekWrapped: Uint8Array): Promise<Uint8Array | null> {
  const ct = await storage.get(storageKey);
  if (ct === null) return null;
  const dek = await env.unwrapObjectKey(tenantId, objectId, dekWrapped);
  try {
    return openGcm(dek, blobAad(tenantId, objectId), ct);
  } finally {
    dek.fill(0);
  }
}
