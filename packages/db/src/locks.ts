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

/** app.lock_address (per-address advisory transaction lock: dedup on intake, consent projection). */
export async function lockAddress(tx: Tx, addressHmacHex: string): Promise<void> {
  await sql`SELECT app.lock_address(${hmacBytes(addressHmacHex)}::bytea)`.execute(tx);
}

/** Locks several addresses in ascending HMAC order. */
export async function lockAddresses(tx: Tx, hmacs: readonly string[]): Promise<void> {
  for (const h of [...new Set(hmacs.map((x) => x.toLowerCase()))].sort()) await lockAddress(tx, h);
}
