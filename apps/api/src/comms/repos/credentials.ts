// The tenant's telephony subaccount credential (ARCHITECTURE §7: one subaccount per tenant; the secret is
// field-encrypted with the tenant key, AAD bound to the row, and decrypted only as the system actor).
import type { IdGenerator, TenantId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../../crypto/envelope.js';
import { ciphertextKeyVersion } from '../../crypto/primitives.js';
import type { TelephonyAccount } from '../../providers/types.js';

const aad = (rowId: string) => ({ table: 'provider_credentials', column: 'secret_enc', rowId });

export async function telephonyAccount(tx: Tx, envelope: EnvelopeService, tenantId: string): Promise<TelephonyAccount | null> {
  const r = await sql<{ id: string; secret_enc: Buffer | null; external_account_ref: string | null }>`
    SELECT id, secret_enc, external_account_ref FROM provider_credentials
     WHERE tenant_id = app.tenant_id() AND provider = 'telephony' AND status = 'active' ORDER BY created_at DESC, id DESC LIMIT 1`.execute(tx);
  const c = r.rows[0];
  if (!c || !c.secret_enc || !c.external_account_ref) return null;
  const secret = await envelope.inTx(tx, tenantId as TenantId).decrypt(tenantId as TenantId, aad(c.id), new Uint8Array(c.secret_enc));
  return { accountRef: c.external_account_ref, secret: Buffer.from(secret).toString('utf8') };
}

export async function storeTelephonyAccount(tx: Tx, envelope: EnvelopeService, ids: IdGenerator, tenantId: string, account: TelephonyAccount, userId: string | null): Promise<void> {
  const id = ids.next<'ProviderCredentialId'>();
  const enc = await envelope.inTx(tx, tenantId as TenantId).encrypt(tenantId as TenantId, aad(id), Buffer.from(account.secret, 'utf8'));
  await sql`
    INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, 'telephony', ${Buffer.from(enc)}, ${ciphertextKeyVersion(enc)},
            ${account.accountRef}, ${userId})`.execute(tx);
}
