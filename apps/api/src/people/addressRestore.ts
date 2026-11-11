// Undo of an address delete (module 57; PARITY_PLAN §5: a reversible one-person edit gets an Undo toast, never a
// confirm modal) as a server-side restore of the deleted row.
//
// DELETE /contacts/:id/addresses/:addressId answers a restore token: the deleted row verbatim (its id, jurisdiction,
// import batch and created_at included), with the person, the user who deleted it and the database time, sealed with
// the tenant's field key (AES-256-GCM, crypto/envelope.ts) under an AAD bound to that address id. POST
// /contacts/:id/addresses/:addressId/restore puts exactly that row back, for that user, on that person, within
// RESTORE_WINDOW_MS. The client never sends the address's fields back, so an Undo cannot set a jurisdiction (it
// decides call-recording announcements, R-CONSENT-16) or an import batch the address never had, and no input bound
// (AddressBody) refuses an address an import stored with longer lines. The token holds the address only while the
// toast is open, in that user's page, and only that tenant's keys open it.
import type { Instant, UserActor } from '@realty/core/foundation';
import { MINUTE_MS } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { z } from 'zod';
import type { EnvelopeService } from '../crypto/envelope.js';
import { DecryptError, fromBase64url } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import type { AddressFullRow } from './repos/people.js';

/** How long the Undo of an address delete is honored (the toast shows for 8 s; this allows a slow network). */
export const RESTORE_WINDOW_MS = 10 * MINUTE_MS;

const aad = (addressId: string) => ({ table: 'contact_addresses', column: 'restore_token', rowId: addressId });

const Text = z.string().nullable();
const Sealed = z.strictObject({
  v: z.literal(1),
  contactId: z.uuid(),
  userId: z.uuid(),
  deletedAt: z.number().int(),
  row: z.strictObject({
    id: z.uuid(),
    kind: z.string(),
    line1: Text,
    line2: Text,
    city: Text,
    region: Text,
    postal_code: Text,
    country: z.string(),
    jurisdiction: Text,
    import_batch_id: z.uuid().nullable(),
    created_at: z.iso.datetime({ offset: true }),
  }),
});

/** The restore token for an address `actor` just deleted from `contactId` (in the delete's own transaction). */
export async function sealAddressRestore(envelope: EnvelopeService, tx: Tx, actor: UserActor, contactId: string, row: AddressFullRow, now: Instant): Promise<string> {
  const sealed: z.infer<typeof Sealed> = { v: 1, contactId, userId: actor.userId, deletedAt: now, row: { ...row, created_at: row.created_at.toISOString() } };
  const env = envelope.inTx(tx, actor.tenantId);
  return Buffer.from(await env.encrypt(actor.tenantId, aad(row.id), Buffer.from(JSON.stringify(sealed), 'utf8'))).toString('base64url');
}

/**
 * The deleted row a restore token carries, if `actor` may put it back on `contactId` now: NOT_FOUND for a token that is
 * forged, altered, or for another address, person or user (R-PERM-5: nothing about it is revealed), and
 * ADDRESS_RESTORE_EXPIRED once the window has passed.
 */
export async function openAddressRestore(envelope: EnvelopeService, tx: Tx, actor: UserActor, contactId: string, addressId: string, token: string, now: Instant): Promise<AddressFullRow> {
  const bytes = fromBase64url(token);
  if (bytes === null) throw new AppError('NOT_FOUND');
  let sealed: z.infer<typeof Sealed>;
  try {
    const plain = await envelope.inTx(tx, actor.tenantId).decrypt(actor.tenantId, aad(addressId), bytes);
    sealed = Sealed.parse(JSON.parse(Buffer.from(plain).toString('utf8')));
  } catch (e) {
    if (e instanceof DecryptError || e instanceof SyntaxError || e instanceof z.ZodError) throw new AppError('NOT_FOUND');
    throw e;
  }
  if (sealed.row.id !== addressId || sealed.contactId !== contactId || sealed.userId !== actor.userId) throw new AppError('NOT_FOUND');
  if (now - sealed.deletedAt > RESTORE_WINDOW_MS) throw new AppError('ADDRESS_RESTORE_EXPIRED');
  return { ...sealed.row, created_at: new Date(sealed.row.created_at) };
}
