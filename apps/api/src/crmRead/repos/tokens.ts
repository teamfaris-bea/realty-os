// Owner-facing rows of crm_read_tokens. The hash is written and never read back through this module.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

const STAMP = (expr: string) => `to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
}

const columns = `
  id::text AS id, name, token_prefix AS prefix,
  ${STAMP('created_at')} AS created_at,
  ${STAMP('revoked_at')} AS revoked_at`;

export async function insertToken(tx: Tx, row: { id: string; name: string; hash: Buffer; prefix: string }): Promise<TokenRow> {
  const r = await sql<TokenRow>`
    INSERT INTO crm_read_tokens (tenant_id, id, name, token_hash, token_prefix, created_by_user_id)
    VALUES (app.tenant_id(), ${row.id}::uuid, ${row.name}, ${row.hash}, ${row.prefix}, app.user_id())
    RETURNING ${sql.raw(columns)}`.execute(tx);
  return r.rows[0]!;
}

export async function listTokens(tx: Tx): Promise<TokenRow[]> {
  const r = await sql<TokenRow>`
    SELECT ${sql.raw(columns)}
      FROM crm_read_tokens
     WHERE tenant_id = app.tenant_id()
     ORDER BY created_at, id`.execute(tx);
  return r.rows;
}

export async function revokeToken(tx: Tx, id: string): Promise<{ row: TokenRow | null; changed: boolean }> {
  const updated = await sql<TokenRow>`
    UPDATE crm_read_tokens
       SET revoked_at = clock_timestamp(), revoked_by_user_id = app.user_id()
     WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid AND revoked_at IS NULL
    RETURNING ${sql.raw(columns)}`.execute(tx);
  if (updated.rows[0]) return { row: updated.rows[0], changed: true };
  const existing = await sql<TokenRow>`
    SELECT ${sql.raw(columns)} FROM crm_read_tokens WHERE tenant_id = app.tenant_id() AND id = ${id}::uuid`.execute(tx);
  return { row: existing.rows[0] ?? null, changed: false };
}
