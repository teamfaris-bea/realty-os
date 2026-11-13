// b13 review B13-MRG-4 (R-ISA-21: every control and system action audited): a seller's confirmed home is cleared in
// the database (0084: the address edit's trigger and the address delete's foreign key, both as the editor), where no
// audit row can be written by the application. The people routes that make those writes read, before the write, the
// seller watches confirmed at that address and, after it, audit each one the write cleared as `ai_isa.subject_cleared`
// with the guard's reason code, as the editor, in the same transaction. Ids and codes only.
import type { Actor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../../audit.js';

/** Before an address write: the assignments whose seller watch has a confirmed home at this address (the editor's RLS). */
export async function confirmedWatchesAtAddressInTx(tx: Tx, addressId: string): Promise<string[]> {
  const r = await sql<{ assignment_id: string }>`SELECT assignment_id FROM ai_isa_seller_watch WHERE tenant_id = app.tenant_id()
    AND contact_address_id = ${addressId}::uuid AND subject_confirmed_at IS NOT NULL`.execute(tx);
  return r.rows.map((x) => x.assignment_id);
}

/** After it: one `ai_isa.subject_cleared` per watch the write cleared, with the reason the guard stored. */
export async function auditSubjectClearsInTx(tx: Tx, actor: Actor, assignmentIds: readonly string[]): Promise<void> {
  if (assignmentIds.length === 0) return;
  const r = await sql<{ assignment_id: string; reason: string | null }>`SELECT assignment_id, subject_cleared_reason AS reason FROM ai_isa_seller_watch
    WHERE tenant_id = app.tenant_id() AND assignment_id = ANY (${[...assignmentIds]}::uuid[]) AND subject_confirmed_at IS NULL ORDER BY assignment_id`.execute(tx);
  for (const w of r.rows) await audit(tx, actor, { action: 'ai_isa.subject_cleared', entity: { type: 'ai_isa_assignment', id: w.assignment_id }, reason: w.reason ?? 'address_changed' });
}
