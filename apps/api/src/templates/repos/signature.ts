// The sender's own plain-text email signature (parity module 63; R-PAR-25). memberships.email_signature
// is self-editable like alert_phone; the renderer appends it as text above the brokerage footer.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The acting user's signature, or null (the caller's own membership row; RLS: self). */
export async function senderSignature(tx: Tx): Promise<string | null> {
  const r = await sql<{ s: string | null }>`
    SELECT email_signature AS s FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()`.execute(tx);
  return r.rows[0]?.s ?? null;
}

/** Sets (or clears, with null) the acting user's own signature; returns the previous value. */
export async function setSenderSignature(tx: Tx, signature: string | null): Promise<{ before: string | null } | null> {
  const before = await sql<{ s: string | null }>`
    SELECT email_signature AS s FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = app.user_id() FOR UPDATE`.execute(tx);
  if (!before.rows[0]) return null;
  await sql`UPDATE memberships SET email_signature = ${signature}, updated_at = now() WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()`.execute(tx);
  return { before: before.rows[0].s };
}
