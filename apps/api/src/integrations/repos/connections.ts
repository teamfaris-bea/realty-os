// integration_connections / provider_credentials / jurisdiction_packs queries of module 21. Every query
// runs inside the caller's tenant transaction under RLS; the 0018 guard decides which columns a person
// may write (only the system actor links accounts, moves external kinds live or writes capabilities).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { Capabilities, ConnectionKind, ConnectionStatus } from '../../providers/integrations/types.js';

export interface ConnectionDbRow {
  id: string;
  kind: ConnectionKind;
  status: ConnectionStatus;
  status_reason: string | null;
  display_name: string;
  external_account_id: string | null;
  credential_id: string | null;
  lead_source_id: string | null;
  capabilities: Capabilities;
  last_error_code: string | null;
  connected_at: Date | null;
  disconnected_at: Date | null;
  created_at: Date;
  /** updated_at in microseconds: the OAuth state fence */
  fence: string;
}

const COLS = sql`id, kind, status, status_reason, display_name, external_account_id, credential_id, lead_source_id, capabilities,
  last_error_code, connected_at, disconnected_at, created_at, (extract(epoch FROM updated_at) * 1000000)::bigint::text AS fence`;

export async function listConnections(tx: Tx): Promise<ConnectionDbRow[]> {
  return (await sql<ConnectionDbRow>`SELECT ${COLS} FROM integration_connections WHERE tenant_id = app.tenant_id() ORDER BY created_at, id`.execute(tx)).rows;
}

export async function getConnection(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<ConnectionDbRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  return (await sql<ConnectionDbRow>`SELECT ${COLS} FROM integration_connections WHERE tenant_id = app.tenant_id() AND id = ${id} ${lock}`.execute(tx)).rows[0] ?? null;
}

export async function insertConnection(tx: Tx, c: { id: string; kind: ConnectionKind; displayName: string; leadSourceId: string | null }): Promise<void> {
  await sql`INSERT INTO integration_connections (tenant_id, id, kind, display_name, lead_source_id)
            VALUES (app.tenant_id(), ${c.id}, ${c.kind}, ${c.displayName}, ${c.leadSourceId})`.execute(tx);
}

export async function updateLabels(tx: Tx, id: string, p: { displayName?: string; leadSourceId?: string | null }): Promise<void> {
  await sql`UPDATE integration_connections SET
              display_name = COALESCE(${p.displayName ?? null}, display_name),
              lead_source_id = CASE WHEN ${p.leadSourceId !== undefined} THEN ${p.leadSourceId ?? null}::uuid ELSE lead_source_id END
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function leadSourceExists(tx: Tx, id: string): Promise<boolean> {
  return (await sql<{ ok: number }>`SELECT 1 AS ok FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${id} AND active`.execute(tx)).rows.length > 0;
}

export async function activeRole(tx: Tx, userId: string): Promise<string | null> {
  return (await sql<{ role: string }>`SELECT role FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND status = 'active'`.execute(tx)).rows[0]?.role ?? null;
}

export async function listPlatformPacks(tx: Tx): Promise<{ key: string; version: string; reviewed_by_counsel_at: Date | null }[]> {
  return (
    await sql<{ key: string; version: string; reviewed_by_counsel_at: Date | null }>`
      SELECT key, version, reviewed_by_counsel_at FROM jurisdiction_packs WHERE key LIKE 'platform:%' AND status = 'published' ORDER BY key`.execute(tx)
  ).rows;
}

// ---- provider callback (system actor only; the 0018 guard refuses anyone else) -----------------------

export async function insertCredential(
  tx: Tx,
  c: { id: string; provider: 'meta' | 'google'; secretEnc: Uint8Array; keyVersion: number; externalAccountRef: string; createdByUserId: string },
): Promise<void> {
  await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref, created_by_user_id)
            VALUES (app.tenant_id(), ${c.id}, ${c.provider}, ${Buffer.from(c.secretEnc)}, ${c.keyVersion}, ${c.externalAccountRef}, ${c.createdByUserId})`.execute(tx);
}

export async function applyProof(
  tx: Tx,
  id: string,
  p: { status: ConnectionStatus; statusReason: string | null; externalAccountId: string; credentialId: string; capabilities: Capabilities; connectedByUserId: string; connected: boolean },
): Promise<void> {
  await sql`UPDATE integration_connections SET
              status = ${p.status}, status_reason = ${p.statusReason}, external_account_id = ${p.externalAccountId},
              credential_id = ${p.credentialId}, capabilities = ${JSON.stringify(p.capabilities)}::jsonb,
              connected_by_user_id = ${p.connectedByUserId},
              connected_at = CASE WHEN ${p.connected} THEN now() ELSE connected_at END,
              last_error_code = NULL
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function recordProofFailure(tx: Tx, id: string, code: string): Promise<void> {
  await sql`UPDATE integration_connections SET last_error_code = ${code} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

// ---- API-key connections (Spark MLS; system actor only, called only by mls/spark/service.ts) -------------

/** The newest Spark MLS connection of the tenant that is not disconnected, or null. */
export async function getSparkConnection(tx: Tx, o: { forUpdate?: boolean } = {}): Promise<ConnectionDbRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  return (
    await sql<ConnectionDbRow>`SELECT ${COLS} FROM integration_connections
      WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed' AND status <> 'disconnected'
        AND (external_account_id IS NULL OR external_account_id LIKE 'spark:%')
      ORDER BY created_at DESC, id DESC LIMIT 1 ${lock}`.execute(tx)
  ).rows[0] ?? null;
}

/** Serializes Spark key writes of one tenant (two concurrent saves must not create two connections). */
export async function sparkLock(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(app.tenant_id()::text || ':integrations:spark', 0))`.execute(tx);
}

export async function insertMlsCredential(tx: Tx, c: { id: string; secretEnc: Uint8Array; keyVersion: number; keyLabel: string; createdByUserId: string }): Promise<void> {
  await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, external_account_ref, created_by_user_id)
            VALUES (app.tenant_id(), ${c.id}, 'mls', ${Buffer.from(c.secretEnc)}, ${c.keyVersion}, ${c.keyLabel}, ${c.createdByUserId})`.execute(tx);
}

/** The nonsecret facts of a credential (never secret_enc). */
export async function credentialFacts(tx: Tx, credentialId: string): Promise<{ provider: string; status: string; key_label: string | null } | null> {
  return (
    await sql<{ provider: string; status: string; key_label: string | null }>`
      SELECT provider, status, external_account_ref AS key_label FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId}`.execute(tx)
  ).rows[0] ?? null;
}

/** Links a newly saved key (status back to not_configured until validated). */
export async function linkKeyCredential(tx: Tx, id: string, p: { externalAccountId: string; credentialId: string; statusReason: string; connectedByUserId: string }): Promise<void> {
  await sql`UPDATE integration_connections SET
              status = 'not_configured', status_reason = ${p.statusReason}, external_account_id = ${p.externalAccountId},
              credential_id = ${p.credentialId}, capabilities = '{}'::jsonb, connected_by_user_id = ${p.connectedByUserId},
              last_error_code = NULL
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** Records a validation outcome (codes only, never a response body). */
export async function applyKeyValidation(
  tx: Tx,
  id: string,
  p: { status: ConnectionStatus; statusReason: string | null; capabilities: Capabilities; lastErrorCode: string | null; connected: boolean },
): Promise<void> {
  await sql`UPDATE integration_connections SET
              status = ${p.status}, status_reason = ${p.statusReason}, capabilities = ${JSON.stringify(p.capabilities)}::jsonb,
              last_error_code = ${p.lastErrorCode},
              connected_at = CASE WHEN ${p.connected} THEN COALESCE(connected_at, now()) ELSE connected_at END
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

// ---- disconnect (Owner/Admin, R-INT-5: credential revoked in the same transaction) --------------------

export async function markDisconnected(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE integration_connections SET status = 'disconnected', status_reason = 'DISCONNECTED_BY_USER', disconnected_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** Local revocation now; the secret is purged by the revoke job right after the provider call, and in any case by the retention sweep within 30 days. */
export async function revokeCredential(tx: Tx, credentialId: string): Promise<void> {
  await sql`UPDATE provider_credentials SET status = 'revoked',
              purge_after = LEAST(COALESCE(purge_after, 'infinity'::timestamptz), now() + interval '30 days')
             WHERE tenant_id = app.tenant_id() AND id = ${credentialId} AND status = 'active'`.execute(tx);
}

export async function loadCredential(tx: Tx, credentialId: string): Promise<{ provider: string; secret_enc: Buffer | null; status: string } | null> {
  return (
    await sql<{ provider: string; secret_enc: Buffer | null; status: string }>`
      SELECT provider, secret_enc, status FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId} FOR UPDATE`.execute(tx)
  ).rows[0] ?? null;
}

export async function purgeCredential(tx: Tx, credentialId: string): Promise<void> {
  await sql`UPDATE provider_credentials SET secret_enc = NULL, status = 'purged', purged_at = now(), purge_after = COALESCE(purge_after, now())
             WHERE tenant_id = app.tenant_id() AND id = ${credentialId} AND status <> 'purged'`.execute(tx);
}
