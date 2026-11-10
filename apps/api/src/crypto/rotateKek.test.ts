// Master KEK rotation: tenant keys re-wrapped, platform-key data re-encrypted, tenant data untouched and
// readable with the new KEK only; idempotent and all-or-nothing.
import { randomBytes } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, inboundSms, randomPhone } from '../comms/testing.js';
import { telephonyAccount } from '../comms/repos/credentials.js';
import { systemActor } from '../worker/systemActor.js';
import { EnvelopeService } from './envelope.js';
import { localKek } from './kek.js';
import { rotateKek } from './rotateKek.js';

let h: ApiHarness;
let w: CommsWorld;
beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1 });
  await h.enrollMfa(w.agents[0]!);
  await inboundSms(h, randomPhone(), w.mainNumber, 'hello'); // a platform-encrypted webhook payload
});
afterAll(async () => {
  await h?.close();
});

const subaccountSecret = (env: EnvelopeService) =>
  withTenantTx(systemActor(w.tenantId, 'provider'), (tx) => telephonyAccount(tx, env, w.tenantId), { db: h.database }).then((a) => a?.secret ?? null);

describe('KEK rotation', () => {
  it('re-wraps every tenant key and re-encrypts MFA secrets and webhook payloads; afterwards only the new KEK opens them', async () => {
    const oldKek = localKek(h.config.kek, h.config.kekRef);
    const newKek = localKek(new Uint8Array(randomBytes(32)), 'kek:v2');
    const before = await subaccountSecret(new EnvelopeService(oldKek));
    expect(before).toBeTruthy();
    const agentId = w.agents[0]!.userId!;
    const mfaAad = { table: 'users', column: 'mfa_totp_secret_enc', rowId: agentId };
    const mfaCt = (await h.su.query<{ s: Buffer }>('SELECT mfa_totp_secret_enc AS s FROM users WHERE id = $1', [agentId])).rows[0]!.s;
    const mfaPlain = Buffer.from(new EnvelopeService(oldKek).decryptPlatform('mfa', mfaAad, new Uint8Array(mfaCt))).toString('utf8');
    expect(mfaPlain).toBe(w.agents[0]!.totpSecret);

    const live = (await h.su.query('SELECT count(*)::int AS n FROM tenant_keys WHERE wrapped_key IS NOT NULL')).rows[0].n as number;
    const r = await rotateKek(h.su, oldKek, newKek);
    expect(r.tenantKeys).toBe(live); // field, object and hmac of every tenant
    expect(r.mfaSecrets).toBeGreaterThanOrEqual(1);
    expect(r.webhookPayloads).toBeGreaterThanOrEqual(1);
    expect((await h.su.query("SELECT DISTINCT kek_ref FROM tenant_keys WHERE wrapped_key IS NOT NULL")).rows).toEqual([{ kek_ref: 'kek:v2' }]);

    // tenant data (under the unchanged tenant key) reads the same with the new KEK; the old KEK no longer opens it
    expect(await subaccountSecret(new EnvelopeService(newKek))).toBe(before);
    await expect(subaccountSecret(new EnvelopeService(oldKek))).rejects.toThrow();
    const mfaNew = (await h.su.query<{ s: Buffer }>('SELECT mfa_totp_secret_enc AS s FROM users WHERE id = $1', [agentId])).rows[0]!.s;
    expect(Buffer.from(new EnvelopeService(newKek).decryptPlatform('mfa', mfaAad, new Uint8Array(mfaNew))).toString('utf8')).toBe(mfaPlain);

    // idempotent: a repeated run changes nothing
    const again = await rotateKek(h.su, oldKek, newKek);
    expect([again.tenantKeys, again.mfaSecrets, again.webhookPayloads]).toEqual([0, 0, 0]);
    expect(again.alreadyRotated).toBeGreaterThan(0);

    // all-or-nothing: a wrong "previous" KEK aborts without changing any row
    const snapshot = (await h.su.query('SELECT tenant_id, purpose, key_version, wrapped_key FROM tenant_keys ORDER BY 1, 2, 3')).rows;
    await expect(rotateKek(h.su, localKek(new Uint8Array(randomBytes(32)), 'kek:wrong'), localKek(new Uint8Array(randomBytes(32)), 'kek:v3'))).rejects.toThrow(/neither KEK/);
    expect((await h.su.query('SELECT tenant_id, purpose, key_version, wrapped_key FROM tenant_keys ORDER BY 1, 2, 3')).rows).toEqual(snapshot);
  });
});
