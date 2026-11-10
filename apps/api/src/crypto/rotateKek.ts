// Master KEK rotation (docs/DEPLOY.md "KEK rotation"). An operator action run with the OWNER database role,
// with the old and the new KEK both available, while the api and worker are stopped (or before they start
// with the new key):
//   1 every live tenant key (tenant_keys.wrapped_key) is unwrapped with the old KEK and re-wrapped with the
//     new one, under the same AAD (tenant | purpose | version); kek_ref records the new KEK
//   2 data under the PLATFORM keys, which are derived from the KEK, is re-encrypted: users' MFA secrets and
//     stored webhook payloads (same AAD as when written)
// Tenant data itself (field/object ciphertext) is untouched: it is under the tenant keys, which do not change.
// One transaction; idempotent: rows already under the new KEK are skipped, so an interrupted run can be
// repeated. Prints counts only. The HMAC key is re-wrapped like the others (its value never changes, R-DATA-2).
import type pg from 'pg';
import { EnvelopeService } from './envelope.js';
import { type Kek, tenantKeyAad } from './kek.js';

export interface KekRotationResult {
  tenantKeys: number;
  mfaSecrets: number;
  webhookPayloads: number;
  alreadyRotated: number;
}

async function tryUnwrap(kek: Kek, aad: string, wrapped: Uint8Array): Promise<Uint8Array | null> {
  try {
    return await kek.unwrap(aad, wrapped);
  } catch {
    return null;
  }
}

function tryOpen(env: EnvelopeService, purpose: 'mfa' | 'webhook', aad: { table: string; column: string; rowId: string }, ct: Uint8Array): Uint8Array | null {
  try {
    return env.decryptPlatform(purpose, aad, ct);
  } catch {
    return null;
  }
}

export async function rotateKek(owner: pg.Pool, from: Kek, to: Kek): Promise<KekRotationResult> {
  if (from.ref === to.ref) throw new Error('the new KEK needs a new KEK_REF');
  const oldEnv = new EnvelopeService(from);
  const newEnv = new EnvelopeService(to);
  const out: KekRotationResult = { tenantKeys: 0, mfaSecrets: 0, webhookPayloads: 0, alreadyRotated: 0 };
  const c = await owner.connect();
  try {
    await c.query('BEGIN');
    await c.query('LOCK TABLE tenant_keys IN EXCLUSIVE MODE');
    const keys = await c.query<{ tenant_id: string; purpose: 'field' | 'object' | 'hmac'; key_version: number; wrapped_key: Buffer }>(
      'SELECT tenant_id, purpose, key_version, wrapped_key FROM tenant_keys WHERE wrapped_key IS NOT NULL ORDER BY tenant_id, purpose, key_version',
    );
    for (const k of keys.rows) {
      const aad = tenantKeyAad(k.tenant_id, k.purpose, k.key_version);
      const wrapped = new Uint8Array(k.wrapped_key);
      if (await tryUnwrap(to, aad, wrapped)) {
        out.alreadyRotated++;
        continue;
      }
      const raw = await tryUnwrap(from, aad, wrapped);
      if (!raw) throw new Error(`a tenant key opens with neither KEK (tenant key ${k.purpose} v${k.key_version}); nothing was changed`);
      const rewrapped = await to.wrap(aad, raw);
      await c.query('UPDATE tenant_keys SET wrapped_key = $4, kek_ref = $5 WHERE tenant_id = $1 AND purpose = $2 AND key_version = $3', [k.tenant_id, k.purpose, k.key_version, Buffer.from(rewrapped), to.ref]);
      out.tenantKeys++;
    }
    const users = await c.query<{ id: string; s: Buffer }>('SELECT id, mfa_totp_secret_enc AS s FROM users WHERE mfa_totp_secret_enc IS NOT NULL FOR UPDATE');
    for (const u of users.rows) {
      const aad = { table: 'users', column: 'mfa_totp_secret_enc', rowId: u.id };
      const ct = new Uint8Array(u.s);
      if (tryOpen(newEnv, 'mfa', aad, ct)) {
        out.alreadyRotated++;
        continue;
      }
      const pt = tryOpen(oldEnv, 'mfa', aad, ct);
      if (!pt) throw new Error('an MFA secret opens with neither KEK; nothing was changed');
      await c.query('UPDATE users SET mfa_totp_secret_enc = $2 WHERE id = $1', [u.id, Buffer.from(newEnv.encryptPlatform('mfa', aad, pt))]);
      out.mfaSecrets++;
    }
    const hooks = await c.query<{ id: string; p: Buffer }>('SELECT id, payload_enc AS p FROM webhook_events WHERE payload_enc IS NOT NULL FOR UPDATE');
    for (const h of hooks.rows) {
      const aad = { table: 'webhook_events', column: 'payload_enc', rowId: h.id };
      const ct = new Uint8Array(h.p);
      if (tryOpen(newEnv, 'webhook', aad, ct)) {
        out.alreadyRotated++;
        continue;
      }
      const pt = tryOpen(oldEnv, 'webhook', aad, ct);
      // a payload that opens with neither key is unreadable already: it is dropped (payloads are purged on schedule anyway)
      await c.query('UPDATE webhook_events SET payload_enc = $2 WHERE id = $1', [h.id, pt ? Buffer.from(newEnv.encryptPlatform('webhook', aad, pt)) : null]);
      out.webhookPayloads++;
    }
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}
