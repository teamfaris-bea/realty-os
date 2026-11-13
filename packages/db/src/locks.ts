// The global lock order (ARCHITECTURE §10, Design Review F4):
//   1. app.lock_address (sorted by HMAC)
//   2. app.lock_contact (sorted by contact id)
//   3. contacts … FOR UPDATE (ownership commands only, sorted)
//   4. routing_rotation_state, then candidate memberships (sorted), system actor only
// Every writer that touches one contact (ownership engine, inbound ingestion, dispatch, the
// ownership follow-up, enrollment changes) takes app.lock_contact, so they exclude each other.
// Advisory transaction locks are keyed by tenant (the functions read app.tenant_id()), released at
// commit/rollback, and need no row visibility.
import type { ContactId } from '@realty/core/foundation';
import { sql } from 'kysely';
import type { Tx } from './tenantTx.js';

const HEX32 = /^[0-9a-f]{64}$/;

export function hmacBytes(hex: string): Buffer {
  const h = hex.toLowerCase();
  if (!HEX32.test(h)) throw new TypeError('address HMAC must be 32 bytes as 64 hex characters');
  return Buffer.from(h, 'hex');
}

/** app.lock_contact (per-contact advisory transaction lock). */
export async function lockContact(tx: Tx, id: ContactId): Promise<void> {
  await sql`SELECT app.lock_contact(${id}::uuid)`.execute(tx);
}

/** Locks several contacts in ascending id order (merges, multi-contact inbound). */
export async function lockContacts(tx: Tx, ids: readonly ContactId[]): Promise<void> {
  for (const id of [...new Set(ids.map((i) => i.toLowerCase() as ContactId))].sort()) await lockContact(tx, id);
}

/**
 * Locks a contact and the record its merge chain ends at (0075's app.contact_merge_root), and reads the root again
 * under the locks until it holds still (b12 recheck R3): a merge that held the record's lock may commit while this
 * waits and move the record onto a survivor, which is then locked too. Returns the root (the record itself when it was
 * never merged away). A root found after the first read is locked out of id order; the merge that moved the record
 * has committed by then, and a held root cannot move again.
 */
export async function lockContactRoot(tx: Tx, id: ContactId): Promise<ContactId> {
  const rootOf = async () =>
    ((await sql<{ id: string | null }>`SELECT app.contact_merge_root(app.tenant_id(), ${id}::uuid) AS id`.execute(tx)).rows[0]?.id ?? id).toLowerCase() as ContactId;
  let root = await rootOf();
  await lockContacts(tx, [id, root]);
  const held = new Set<string>([id.toLowerCase(), root]);
  for (let i = 0; i < 64; i++) {
    const again = await rootOf();
    if (again === root) return root;
    root = again;
    if (!held.has(root)) {
      await lockContact(tx, root);
      held.add(root);
    }
  }
  throw new Error('CONTACT_MERGE_ROOT_UNSTABLE');
}

/** app.lock_address (per-address advisory transaction lock: dedup on intake, consent projection). */
export async function lockAddress(tx: Tx, addressHmacHex: string): Promise<void> {
  await sql`SELECT app.lock_address(${hmacBytes(addressHmacHex)}::bytea)`.execute(tx);
}

/** Locks several addresses in ascending HMAC order. */
export async function lockAddresses(tx: Tx, hmacs: readonly string[]): Promise<void> {
  for (const h of [...new Set(hmacs.map((x) => x.toLowerCase()))].sort()) await lockAddress(tx, h);
}
