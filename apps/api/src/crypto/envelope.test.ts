// Envelope encryption against real Postgres (keys loaded through app.tenant_key_material as the
// RLS-bound app_user). R-TEN-9, R-DATA-1, R-DATA-2.
import { randomBytes } from 'node:crypto';
import type { TenantId } from '@realty/core/foundation';
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { MemoryStorage } from '../providers/storage.js';
import { CryptoContextError, EnvelopeService, encodeAad, rotateTenantKey } from './envelope.js';
import { localKek, tenantKeyAad } from './kek.js';
import { getObject, putObject, storageKeyFor } from './objects.js';
import { DecryptError, ciphertextKeyVersion, openGcm, sealGcm } from './primitives.js';

let h: ApiHarness;
let a: TestClient; // Owner of tenant A
let b: TestClient; // Owner of tenant B
let agentA: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  a = await h.signup();
  b = await h.signup();
  agentA = await h.invite(a, 'agent');
});
afterAll(async () => {
  await h?.close();
});

const svc = () => h.app.platform.envelope;
const row = (id = '01a1c4ba-0000-7000-8000-000000000001') => ({ table: 'transcripts', column: 'segments_enc', rowId: id });

describe('ciphertext format and primitives', () => {
  it('0x01 | key_version u32 | nonce 12 | ciphertext | tag 16; tampering any byte fails', () => {
    const key = new Uint8Array(randomBytes(32));
    const ct = sealGcm(key, 7, Buffer.from('aad'), Buffer.from('hello'));
    expect(ct[0]).toBe(0x01);
    expect(ciphertextKeyVersion(ct)).toBe(7);
    expect(ct.length).toBe(1 + 4 + 12 + 5 + 16);
    expect(Buffer.from(openGcm(key, Buffer.from('aad'), ct)).toString()).toBe('hello');
    for (const i of [0, 5, 17, ct.length - 1]) {
      const bad = new Uint8Array(ct);
      bad[i] = bad[i]! ^ 0xff;
      expect(() => openGcm(key, Buffer.from('aad'), bad)).toThrow(DecryptError);
    }
  });

  it('two encryptions of the same plaintext differ (random nonce)', () => {
    const key = new Uint8Array(randomBytes(32));
    expect(Buffer.from(sealGcm(key, 1, Buffer.from(''), Buffer.from('x'))).equals(Buffer.from(sealGcm(key, 1, Buffer.from(''), Buffer.from('x'))))).toBe(false);
  });

  it('AAD encoding rejects separator injection', () => {
    expect(() => encodeAad('t', { table: 'a|b', column: 'c', rowId: 'r' })).toThrow(CryptoContextError);
    expect(() => encodeAad('t', { table: 'a', column: 'c', rowId: 'r/../x' })).toThrow(CryptoContextError);
  });
});

describe('tenant envelope (keys from the DB)', () => {
  it('R-TEN-9 R-DATA-1: field ciphertext is bound to tenant, table, column and row — an AAD mismatch fails', async () => {
    const t = a.tenantId!;
    await withTenantTx(
      a.actor(),
      async (tx) => {
        const env = svc().inTx(tx, t);
        const ct = await env.encrypt(t, row(), Buffer.from('call transcript text'));
        expect(Buffer.from(ct).includes(Buffer.from('transcript'))).toBe(false);
        expect(Buffer.from(await env.decrypt(t, row(), ct)).toString()).toBe('call transcript text');
        await expect(env.decrypt(t, row('01a1c4ba-0000-7000-8000-000000000002'), ct)).rejects.toThrow(DecryptError); // another row
        await expect(env.decrypt(t, { ...row(), column: 'other_enc' }, ct)).rejects.toThrow(DecryptError); // another column
        await expect(env.decrypt(t, { ...row(), table: 'ai_runs' }, ct)).rejects.toThrow(DecryptError); // another table
      },
      { db: h.database },
    );
  });

  it('R-TEN-9: ciphertext copied into another tenant does not decrypt there, and an envelope bound to A refuses tenant B', async () => {
    const ct = await withTenantTx(a.actor(), async (tx) => svc().inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('secret of A')), { db: h.database });
    await withTenantTx(
      b.actor(),
      async (tx) => {
        const envB = svc().inTx(tx, b.tenantId!);
        await expect(envB.decrypt(b.tenantId!, row(), ct)).rejects.toThrow(DecryptError);
        await expect(envB.encrypt(a.tenantId!, row(), Buffer.from('x'))).rejects.toThrow(CryptoContextError);
      },
      { db: h.database },
    );
    // a transaction in tenant B cannot load tenant A's keys even with a cold cache
    const cold = new EnvelopeService(svc().kek);
    await withTenantTx(
      b.actor(),
      async (tx) => {
        await expect(cold.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('x'))).rejects.toThrow(CryptoContextError);
      },
      { db: h.database },
    );
  });

  it('keys are loadable by any active member (agent) and by nobody without tenant context', async () => {
    const cold = new EnvelopeService(svc().kek);
    await withTenantTx(
      agentA.actor(),
      async (tx) => {
        const ct = await cold.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('agent can'));
        expect(ct.length).toBeGreaterThan(0);
      },
      { db: h.database },
    );
    const none = await withPreTenant(async (tx) => (await sql`SELECT * FROM app.tenant_key_material()`.execute(tx)).rows.length, { db: h.database });
    expect(none).toBe(0);
    const own = await withTenantTx(agentA.actor(), async (tx) => (await sql<{ purpose: string }>`SELECT * FROM app.tenant_key_material()`.execute(tx)).rows, { db: h.database });
    expect(own.map((r) => r.purpose).sort()).toEqual(['field', 'hmac', 'object']);
  });

  it('R-TEN-9: a warm key cache is no bypass — an envelope refuses a transaction outside its tenant, or of a non-member, even with the keys cached', async () => {
    const warm = new EnvelopeService(svc().kek);
    await withTenantTx(agentA.actor(), async (tx) => void (await warm.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('warm'))), { db: h.database });
    // no tenant context at all
    await expect(
      withPreTenant(async (tx) => warm.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('x')), { db: h.database }),
    ).rejects.toBeInstanceOf(CryptoContextError);
    // a transaction in tenant B using an envelope bound to A
    await expect(
      withTenantTx(b.actor(), async (tx) => warm.inTx(tx, a.tenantId!).hmacAddress(a.tenantId!, '+18435550100'), { db: h.database }),
    ).rejects.toBeInstanceOf(CryptoContextError);
    // a suspended member of A (GUCs say tenant A, the membership says no)
    // (the Owner suspends through RLS: memberships_guard needs an Owner/Admin actor)
    const setStatus = (st: string) =>
      withTenantTx(a.actor(), async (tx) => void (await sql`UPDATE memberships SET status = ${st} WHERE tenant_id = app.tenant_id() AND user_id = ${agentA.userId}::uuid`.execute(tx)), { db: h.database });
    await setStatus('suspended');
    try {
      await expect(
        withTenantTx(agentA.actor(), async (tx) => warm.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('x')), { db: h.database }),
      ).rejects.toBeInstanceOf(CryptoContextError);
    } finally {
      await setStatus('active');
    }
    // and the active member still works from the warm cache
    await withTenantTx(agentA.actor(), async (tx) => void (await warm.inTx(tx, a.tenantId!).encrypt(a.tenantId!, row(), Buffer.from('ok'))), { db: h.database });
  });

  it('wrapped keys in tenant_keys are KEK ciphertext bound to tenant+purpose+version, never raw keys', async () => {
    const rows = (await h.su.query<{ purpose: 'field' | 'object' | 'hmac'; key_version: number; wrapped_key: Buffer; kek_ref: string }>('SELECT purpose, key_version, wrapped_key, kek_ref FROM tenant_keys WHERE tenant_id = $1', [a.tenantId])).rows;
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.kek_ref).toBe(h.config.kekRef);
      expect(r.wrapped_key.length).toBe(1 + 4 + 12 + 32 + 16);
      await expect(svc().kek.unwrap(tenantKeyAad(a.tenantId!, r.purpose, r.key_version), new Uint8Array(r.wrapped_key))).resolves.toHaveLength(32);
      await expect(svc().kek.unwrap(tenantKeyAad(b.tenantId!, r.purpose, r.key_version), new Uint8Array(r.wrapped_key))).rejects.toThrow(DecryptError);
    }
    // another KEK cannot unwrap them
    const other = localKek(new Uint8Array(randomBytes(32)), 'other');
    await expect(other.unwrap(tenantKeyAad(a.tenantId!, rows[0]!.purpose, 1), new Uint8Array(rows[0]!.wrapped_key))).rejects.toThrow(DecryptError);
  });

  it('address HMAC is deterministic per tenant and differs between tenants', async () => {
    const ha = await withTenantTx(a.actor(), async (tx) => svc().inTx(tx, a.tenantId!).hmacAddress(a.tenantId!, '+18435550100'), { db: h.database });
    const ha2 = await withTenantTx(agentA.actor(), async (tx) => new EnvelopeService(svc().kek).inTx(tx, a.tenantId!).hmacAddress(a.tenantId!, '+18435550100'), { db: h.database });
    const hb = await withTenantTx(b.actor(), async (tx) => svc().inTx(tx, b.tenantId!).hmacAddress(b.tenantId!, '+18435550100'), { db: h.database });
    expect(Buffer.from(ha).equals(Buffer.from(ha2))).toBe(true);
    expect(Buffer.from(ha).equals(Buffer.from(hb))).toBe(false);
    expect(ha).toHaveLength(32);
  });

  it('R-DATA-2: the tenant HMAC key never rotates (refused by the API and by the DB CHECK); field rotation keeps old ciphertext readable', async () => {
    const t = a.tenantId!;
    const old = await withTenantTx(a.actor(), async (tx) => svc().inTx(tx, t).encrypt(t, row(), Buffer.from('v1 data')), { db: h.database });
    const hmacBefore = await withTenantTx(a.actor(), async (tx) => svc().inTx(tx, t).hmacAddress(t, 'jane@example.test'), { db: h.database });
    await withTenantTx(
      a.actor(),
      async (tx) => {
        await expect(rotateTenantKey(tx, svc(), t, 'hmac')).rejects.toThrow(/never rotates/);
      },
      { db: h.database },
    );
    await expect(
      withTenantTx(
        a.actor(),
        async (tx) => {
          await sql`INSERT INTO tenant_keys (tenant_id, purpose, key_version, wrapped_key, kek_ref) VALUES (app.tenant_id(), 'hmac', 2, '\\x00'::bytea, 'x')`.execute(tx);
        },
        { db: h.database },
      ),
    ).rejects.toThrow(/check constraint/);
    const v = await withTenantTx(a.actor(), async (tx) => rotateTenantKey(tx, svc(), t, 'field'), { db: h.database });
    expect(v).toBe(2);
    await withTenantTx(
      a.actor(),
      async (tx) => {
        const env = svc().inTx(tx, t);
        expect(Buffer.from(await env.decrypt(t, row(), old)).toString()).toBe('v1 data');
        const fresh = await env.encrypt(t, row(), Buffer.from('v2 data'));
        expect(ciphertextKeyVersion(fresh)).toBe(2);
        expect(Buffer.from(await env.hmacAddress(t, 'jane@example.test')).equals(Buffer.from(hmacBefore))).toBe(true);
      },
      { db: h.database },
    );
  });

  it('R-DATA-1: each listed field kind round-trips under its own (table, column, row) binding', async () => {
    const t = b.tenantId!;
    const fields: [string, string][] = [
      ['transcripts', 'segments_enc'],
      ['evidence_refs', 'snippet_enc'],
      ['provider_credentials', 'secret_enc'],
      ['import_records', 'raw_enc'],
      ['lead_inquiries', 'raw_payload_enc'],
      ['ai_runs', 'output_enc'],
      ['push_subscriptions', 'endpoint_enc'],
      ['push_subscriptions', 'keys_enc'],
    ];
    await withTenantTx(
      b.actor(),
      async (tx) => {
        const env = svc().inTx(tx, t);
        const cts = [];
        for (const [table, column] of fields) {
          const ct = await env.encrypt(t, { table, column, rowId: '01a1c4ba-0000-7000-8000-0000000000aa' }, Buffer.from(`${table}.${column}`));
          expect(Buffer.from(await env.decrypt(t, { table, column, rowId: '01a1c4ba-0000-7000-8000-0000000000aa' }, ct)).toString()).toBe(`${table}.${column}`);
          cts.push(ct);
        }
        // a ciphertext of one field never opens as another field
        await expect(env.decrypt(t, { table: fields[1]![0], column: fields[1]![1], rowId: '01a1c4ba-0000-7000-8000-0000000000aa' }, cts[0]!)).rejects.toThrow(DecryptError);
      },
      { db: h.database },
    );
    // platform-key fields: MFA secrets and webhook payloads
    const mfa = svc().encryptPlatform('mfa', { table: 'users', column: 'mfa_totp_secret_enc', rowId: a.userId! }, Buffer.from('JBSWY3DPEHPK3PXP'));
    expect(Buffer.from(svc().decryptPlatform('mfa', { table: 'users', column: 'mfa_totp_secret_enc', rowId: a.userId! }, mfa)).toString()).toBe('JBSWY3DPEHPK3PXP');
    expect(() => svc().decryptPlatform('mfa', { table: 'users', column: 'mfa_totp_secret_enc', rowId: b.userId! }, mfa)).toThrow(DecryptError);
    expect(() => svc().decryptPlatform('webhook', { table: 'users', column: 'mfa_totp_secret_enc', rowId: a.userId! }, mfa)).toThrow(DecryptError);
  });

  it('R-DATA-1: the stored MFA secret is ciphertext bound to its user row', async () => {
    const r = await h.su.query<{ mfa_totp_secret_enc: Buffer }>('SELECT mfa_totp_secret_enc FROM users WHERE id = $1', [a.userId]);
    const enc = r.rows[0]!.mfa_totp_secret_enc;
    expect(enc.includes(Buffer.from(a.totpSecret!))).toBe(false);
    expect(Buffer.from(svc().decryptPlatform('mfa', { table: 'users', column: 'mfa_totp_secret_enc', rowId: a.userId! }, new Uint8Array(enc))).toString()).toBe(a.totpSecret);
    expect(() => svc().decryptPlatform('mfa', { table: 'users', column: 'mfa_totp_secret_enc', rowId: b.userId! }, new Uint8Array(enc))).toThrow(DecryptError);
  });
});

describe('per-object DEKs (recordings, MMS, import files, consent evidence)', () => {
  it('R-TEN-9 R-DATA-1: blobs are stored as ciphertext under tenants/{tenant_id}/…; a fetch with another object id or tenant fails to decrypt', async () => {
    const storage = new MemoryStorage();
    const t = a.tenantId!;
    const objectId = '01a1c4ba-0000-7000-8000-0000000000b1';
    const audio = new Uint8Array(randomBytes(2048));
    const sealed = await withTenantTx(a.actor(), async (tx) => putObject(svc().inTx(tx, t), storage, t, objectId, 'recording', audio, 'audio/wav'), { db: h.database });
    expect(sealed.storageKey).toBe(storageKeyFor(t, 'recording', objectId));
    expect(sealed.storageKey.startsWith(`tenants/${t}/`)).toBe(true);
    expect(sealed.byteSize).toBe(2048);
    const stored = (await storage.get(sealed.storageKey))!;
    expect(Buffer.from(stored).includes(Buffer.from(audio.slice(0, 64)))).toBe(false);
    await withTenantTx(
      a.actor(),
      async (tx) => {
        const env = svc().inTx(tx, t);
        expect(Buffer.from((await getObject(env, storage, t, objectId, sealed.storageKey, sealed.dekWrapped))!).equals(Buffer.from(audio))).toBe(true);
        await expect(getObject(env, storage, t, '01a1c4ba-0000-7000-8000-0000000000b2', sealed.storageKey, sealed.dekWrapped)).rejects.toThrow(DecryptError);
      },
      { db: h.database },
    );
    await withTenantTx(
      b.actor(),
      async (tx) => {
        const env = svc().inTx(tx, b.tenantId!);
        await expect(getObject(env, storage, b.tenantId! as TenantId, objectId, sealed.storageKey, sealed.dekWrapped)).rejects.toThrow(DecryptError);
      },
      { db: h.database },
    );
  });

  it('R-TEN-9: storage keys outside tenants/{tenant_id}/ are refused by the adapter and by the stored_objects CHECK', async () => {
    const storage = new MemoryStorage();
    await expect(storage.put('recordings/x', new Uint8Array(1), { contentType: 'x' })).rejects.toThrow(/tenants/);
    await expect(storage.put(`tenants/${a.tenantId}/../${b.tenantId}/x`, new Uint8Array(1), { contentType: 'x' })).rejects.toThrow();
    await expect(
      withTenantTx(
        a.actor(),
        async (tx) => {
          await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version)
                    VALUES (app.tenant_id(), '01a1c4ba-0000-7000-8000-0000000000c1', 'recording', ${`tenants/${b.tenantId}/recording/x`}, 'audio/wav', 1,
                            ${Buffer.alloc(32)}, '\\x01'::bytea, 1)`.execute(tx);
        },
        { db: h.database },
      ),
    ).rejects.toThrow();
  });
});
