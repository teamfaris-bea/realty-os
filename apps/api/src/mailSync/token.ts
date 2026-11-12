// The ONLY code that reads or writes user_mail_links.refresh_enc (R-GMAIL-4, S-D2-7; architecture test).
//
// The refresh token is envelope-encrypted under the tenant field key with AAD bound to table, column and row id,
// decrypted only by the system actor inside a sync pass (or the system's revoke), and never returned by a route or
// written to a log. Access tokens are never stored: callers keep them in a local variable for one pass.
import type { SystemActor, TenantId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { ciphertextKeyVersion } from '../crypto/primitives.js';

const aad = (linkId: string) => ({ table: 'user_mail_links', column: 'refresh_enc', rowId: linkId });

/** Encrypts a refresh token for a new link row (the callback, the system actor). */
export async function sealRefreshToken(tx: Tx, envelope: EnvelopeService, tenantId: TenantId, linkId: string, refreshToken: string): Promise<{ enc: Buffer; keyVersion: number }> {
  const enc = await envelope.inTx(tx, tenantId).encrypt(tenantId, aad(linkId), new TextEncoder().encode(refreshToken));
  return { enc: Buffer.from(enc), keyVersion: ciphertextKeyVersion(enc) };
}

/** The live link's refresh token, decrypted, for the system actor only; null when the link holds none. */
export async function openRefreshToken(tx: Tx, envelope: EnvelopeService, actor: SystemActor, linkId: string): Promise<string | null> {
  if (actor.kind !== 'system') throw new Error('only the system actor decrypts a Gmail refresh token');
  const r = await sql<{ refresh_enc: Buffer | null }>`
    SELECT refresh_enc FROM user_mail_links WHERE tenant_id = app.tenant_id() AND id = ${linkId}::uuid AND status <> 'revoked'`.execute(tx);
  const enc = r.rows[0]?.refresh_enc;
  if (!enc) return null;
  const pt = await envelope.inTx(tx, actor.tenantId as TenantId).decrypt(actor.tenantId as TenantId, aad(linkId), new Uint8Array(enc));
  return new TextDecoder().decode(pt);
}

/** Inserts the link row (system: the OAuth callback after reading the profile). */
export async function insertLink(
  tx: Tx,
  l: { id: string; userId: string; mailboxAddress: string; mailboxHmac: Buffer; scopes: readonly string[]; disclosureSha256: string; enc: Buffer; keyVersion: number; historyId: string },
): Promise<void> {
  await sql`
    INSERT INTO user_mail_links (tenant_id, id, user_id, provider, mailbox_address, mailbox_address_hmac, scopes, disclosure_sha256, status,
                                 refresh_enc, key_version, history_id, connected_at, next_sync_at, backfill_requested_at)
    VALUES (app.tenant_id(), ${l.id}::uuid, ${l.userId}::uuid, 'gmail', ${l.mailboxAddress}, ${l.mailboxHmac}, ${[...l.scopes]}::text[], ${l.disclosureSha256},
            'connected', ${l.enc}, ${l.keyVersion}, ${l.historyId}, now(), now(), now())`.execute(tx);
}

/**
 * Revokes a link: the token is deleted in the same statement (CHECK), copies hidden at once (RESTRICTIVE policy).
 * Returns the refresh token that was stored (system only: for the best-effort revoke at Google), or null.
 * A person's own disconnect (USER_DISCONNECTED) reads nothing: the DB lets them delete the token, never read it here.
 */
export async function revokeLink(tx: Tx, envelope: EnvelopeService | null, actor: { kind: string; tenantId: string }, linkId: string, reason: string): Promise<{ revoked: boolean; refreshToken: string | null }> {
  let token: string | null = null;
  if (actor.kind === 'system' && envelope) token = await openRefreshToken(tx, envelope, actor as SystemActor, linkId).catch(() => null);
  const r = await sql`
    UPDATE user_mail_links SET status = 'revoked', revoke_reason = ${reason}, revoked_at = now(), refresh_enc = NULL, backfill_page_token = NULL,
           purge_after = now() + interval '30 days'
     WHERE tenant_id = app.tenant_id() AND id = ${linkId}::uuid AND status <> 'revoked'`.execute(tx);
  return { revoked: Number(r.numAffectedRows ?? 0n) === 1, refreshToken: token };
}
