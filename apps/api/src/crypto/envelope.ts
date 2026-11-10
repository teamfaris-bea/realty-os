// Envelope encryption (ARCHITECTURE §8; R-DATA-1, R-DATA-2, R-TEN-9).
//
// - Field encryption: AES-256-GCM with the tenant `field` key; AAD = tenant | table | column | row,
//   so ciphertext copied to another row, column or tenant fails to decrypt.
// - Address HMAC: HMAC-SHA256 with the tenant `hmac` key (version 1 forever; DB CHECK, R-DATA-2).
// - Object DEKs: a fresh 32-byte DEK per stored object, wrapped by the tenant `object` key with the
//   object id in the AAD (see objects.ts for the blob side).
// - Platform keys (MFA secrets, webhook payloads): derived from the KEK; AAD starts with `platform`.
//
// Keys are loaded through app.tenant_key_material() (migration 0003) INSIDE the caller's tenant
// transaction, so only an active member of that tenant (or the system actor) can load them. Unwrapped
// keys are cached in process memory for a short TTL; every Envelope still checks, once, that its
// transaction is an active-member context of its tenant, so a warm cache is not a bypass. An Envelope
// is bound to one tenant: asking it to encrypt for another tenant throws (mis-wired call site).
import type { TenantId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type Kek, tenantKeyAad } from './kek.js';
import { DecryptError, ciphertextKeyVersion, hmacSha256, openGcm, randomBytes, sealGcm } from './primitives.js';

export interface Aad {
  /** table name, e.g. 'push_subscriptions' */
  table: string;
  /** column name, e.g. 'endpoint_enc' */
  column: string;
  /** the row's id (uuid) or another stable row key */
  rowId: string;
}

/** The module-8 interface (BUILD_PLAN): one envelope, bound to the caller's tenant. */
export interface Envelope {
  encrypt(tenantId: TenantId, aad: Aad, plaintext: Uint8Array): Promise<Uint8Array>;
  decrypt(tenantId: TenantId, aad: Aad, ciphertext: Uint8Array): Promise<Uint8Array>;
  /** HMAC-SHA256 of a NORMALIZED address (E.164 / lower-case email) with the tenant hmac key. */
  hmacAddress(tenantId: TenantId, normalized: string): Promise<Uint8Array>;
  /** Wraps a per-object DEK with the tenant object key (AAD binds the object id). */
  wrapObjectKey(tenantId: TenantId, objectId: string, dek: Uint8Array): Promise<{ dekWrapped: Uint8Array; keyVersion: number }>;
  unwrapObjectKey(tenantId: TenantId, objectId: string, dekWrapped: Uint8Array): Promise<Uint8Array>;
}

export class CryptoContextError extends Error {
  override readonly name = 'CryptoContextError';
}

const PART = /^[A-Za-z0-9_.:-]+$/;

export function encodeAad(scope: string, a: Aad): Uint8Array {
  for (const [k, v] of [
    ['scope', scope],
    ['table', a.table],
    ['column', a.column],
    ['rowId', a.rowId],
  ] as const) {
    if (!PART.test(v)) throw new CryptoContextError(`AAD ${k} has unsupported characters`);
  }
  return Buffer.from(`realty-aad-v1|${scope.toLowerCase()}|${a.table}|${a.column}|${a.rowId.toLowerCase()}`);
}

interface Keyring {
  field: Map<number, Uint8Array>;
  currentField: number;
  object: Map<number, Uint8Array>;
  currentObject: number;
  hmac: Uint8Array;
  loadedAt: number;
}

export interface KeyMaterialRow {
  purpose: 'field' | 'object' | 'hmac';
  key_version: number;
  wrapped_key: Uint8Array;
  kek_ref: string;
  retired: boolean;
}

/** Raw tenant keys, generated at signup (never stored unwrapped). */
export interface TenantKeySet {
  field: Uint8Array;
  object: Uint8Array;
  hmac: Uint8Array;
}

export function generateTenantKeys(): TenantKeySet {
  return { field: randomBytes(32), object: randomBytes(32), hmac: randomBytes(32) };
}

export async function wrapTenantKeys(kek: Kek, tenantId: string, keys: TenantKeySet): Promise<{ field: Uint8Array; object: Uint8Array; hmac: Uint8Array }> {
  return {
    field: await kek.wrap(tenantKeyAad(tenantId, 'field', 1), keys.field),
    object: await kek.wrap(tenantKeyAad(tenantId, 'object', 1), keys.object),
    hmac: await kek.wrap(tenantKeyAad(tenantId, 'hmac', 1), keys.hmac),
  };
}

const CACHE_TTL_MS = 5 * 60_000;

/** Process-wide envelope service: owns the KEK and the unwrapped-key cache. */
export class EnvelopeService {
  private readonly cache = new Map<string, Keyring>();
  constructor(
    readonly kek: Kek,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Forgets cached keys (after a rotation, or for tests). */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) this.cache.clear();
    else this.cache.delete(tenantId.toLowerCase());
  }

  /** An envelope bound to `tenantId`, loading keys (on a cache miss) through `tx`. */
  inTx(tx: Tx, tenantId: TenantId): Envelope {
    const bound = tenantId.toLowerCase();
    // The transaction must be in the bound tenant with an active member (or the system/support
    // actor) behind it. Checked once per envelope, on cache hits too: the process-wide key cache
    // must not let a pre-tenant transaction, another tenant's, or a removed member's use the keys.
    let context: Promise<void> | null = null;
    const verifyContext = () =>
      (context ??= (async () => {
        const r = await sql<{ t: string | null; m: boolean | null }>`SELECT app.tenant_id()::text AS t, app.is_member() AS m`.execute(tx);
        const c = r.rows[0];
        if (c?.t?.toLowerCase() !== bound || c.m !== true) throw new CryptoContextError('transaction is not an active member context of the envelope tenant');
      })());
    const ring = async (t: TenantId): Promise<Keyring> => {
      if (t.toLowerCase() !== bound) throw new CryptoContextError('envelope is bound to another tenant');
      await verifyContext();
      return this.keyring(tx, bound);
    };
    return {
      encrypt: async (t, aad, pt) => {
        const r = await ring(t);
        return sealGcm(r.field.get(r.currentField)!, r.currentField, encodeAad(bound, aad), pt);
      },
      decrypt: async (t, aad, ct) => {
        const r = await ring(t);
        const v = ciphertextKeyVersion(ct);
        const key = r.field.get(v);
        if (!key) throw new DecryptError('key_version');
        return openGcm(key, encodeAad(bound, aad), ct);
      },
      hmacAddress: async (t, normalized) => {
        const r = await ring(t);
        return hmacSha256(r.hmac, normalized);
      },
      wrapObjectKey: async (t, objectId, dek) => {
        const r = await ring(t);
        const aad = encodeAad(bound, { table: 'stored_objects', column: 'dek_wrapped', rowId: objectId });
        return { dekWrapped: sealGcm(r.object.get(r.currentObject)!, r.currentObject, aad, dek), keyVersion: r.currentObject };
      },
      unwrapObjectKey: async (t, objectId, wrapped) => {
        const r = await ring(t);
        const key = r.object.get(ciphertextKeyVersion(wrapped));
        if (!key) throw new DecryptError('key_version');
        return openGcm(key, encodeAad(bound, { table: 'stored_objects', column: 'dek_wrapped', rowId: objectId }), wrapped);
      },
    };
  }

  /** Platform-key encryption (MFA secrets: users are global; webhook payloads: pre-tenant). */
  encryptPlatform(purpose: 'mfa' | 'webhook', aad: Aad, plaintext: Uint8Array): Uint8Array {
    return sealGcm(this.kek.platformKey(purpose), 1, encodeAad('platform', aad), plaintext);
  }

  decryptPlatform(purpose: 'mfa' | 'webhook', aad: Aad, ciphertext: Uint8Array): Uint8Array {
    if (ciphertextKeyVersion(ciphertext) !== 1) throw new DecryptError('key_version');
    return openGcm(this.kek.platformKey(purpose), encodeAad('platform', aad), ciphertext);
  }

  /** Seeds the cache with freshly generated keys (signup) so the first request needs no unwrap. */
  prime(tenantId: string, keys: TenantKeySet): void {
    this.cache.set(tenantId.toLowerCase(), {
      field: new Map([[1, keys.field]]),
      currentField: 1,
      object: new Map([[1, keys.object]]),
      currentObject: 1,
      hmac: keys.hmac,
      loadedAt: this.now(),
    });
  }

  private async keyring(tx: Tx, tenantId: string): Promise<Keyring> {
    const hit = this.cache.get(tenantId);
    if (hit && this.now() - hit.loadedAt < CACHE_TTL_MS) return hit;
    const ctx = await sql<{ t: string | null }>`SELECT app.tenant_id()::text AS t`.execute(tx);
    if (ctx.rows[0]?.t?.toLowerCase() !== tenantId) throw new CryptoContextError('transaction is not in the envelope tenant');
    const rows = (await sql<KeyMaterialRow>`SELECT * FROM app.tenant_key_material()`.execute(tx)).rows;
    const ring: Keyring = { field: new Map(), currentField: 0, object: new Map(), currentObject: 0, hmac: new Uint8Array(), loadedAt: this.now() };
    let hmacFound = false;
    for (const r of rows) {
      const key = await this.kek.unwrap(tenantKeyAad(tenantId, r.purpose, r.key_version), new Uint8Array(r.wrapped_key));
      if (r.purpose === 'hmac') {
        if (r.key_version !== 1) continue; // R-DATA-2: the HMAC key never rotates (DB CHECK)
        ring.hmac = key;
        hmacFound = true;
      } else {
        const m = r.purpose === 'field' ? ring.field : ring.object;
        m.set(r.key_version, key);
        if (!r.retired) {
          if (r.purpose === 'field') ring.currentField = Math.max(ring.currentField, r.key_version);
          else ring.currentObject = Math.max(ring.currentObject, r.key_version);
        }
      }
    }
    if (!hmacFound || ring.currentField === 0 || ring.currentObject === 0) {
      throw new CryptoContextError('tenant keys unavailable (not a member, or keys destroyed)');
    }
    this.cache.set(tenantId, ring);
    return ring;
  }
}

/**
 * Adds a new version of the tenant `field` or `object` key and retires the previous ones (rotation,
 * ARCHITECTURE §8). Old ciphertext stays decryptable; re-encryption is optional. Needs a tenant-wide
 * actor (tenant_keys RLS). The HMAC key can never rotate (R-DATA-2): refused here and by DB CHECK.
 */
export async function rotateTenantKey(tx: Tx, svc: EnvelopeService, tenantId: TenantId, purpose: 'field' | 'object' | 'hmac'): Promise<number> {
  if (purpose === 'hmac') throw new CryptoContextError('the tenant HMAC key never rotates (R-DATA-2)');
  const cur = await sql<{ v: number | null }>`
    SELECT max(key_version)::int AS v FROM tenant_keys WHERE tenant_id = app.tenant_id() AND purpose = ${purpose}`.execute(tx);
  const next = (cur.rows[0]?.v ?? 0) + 1;
  if (next === 1) throw new CryptoContextError('tenant keys not visible to this actor');
  const wrapped = await svc.kek.wrap(tenantKeyAad(tenantId, purpose, next), randomBytes(32));
  await sql`UPDATE tenant_keys SET retired_at = now() WHERE tenant_id = app.tenant_id() AND purpose = ${purpose} AND retired_at IS NULL`.execute(tx);
  await sql`INSERT INTO tenant_keys (tenant_id, purpose, key_version, wrapped_key, kek_ref)
            VALUES (app.tenant_id(), ${purpose}, ${next}, ${Buffer.from(wrapped)}, ${svc.kek.ref})`.execute(tx);
  svc.invalidate(tenantId);
  return next;
}
