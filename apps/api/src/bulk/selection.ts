// The bulk target's selection (PARITY_PLAN §4.2) is module 60's resolveSelection (apps/api/src/lists):
//
//   resolveSelection(tx, { contactIds } | { listId } | { definition }, opts?): ContactId[]
//
// called as it is, under the creator's own RLS in `tx`: only people whose DETAIL the caller sees (a pond or
// offer card is never returned), live only, in list order, at most `opts.cap`, never silently truncated; a
// saved list or definition that names a protected-proxy tag is refused as the audience of a send or an
// enrollment (AUDIENCE_PROTECTED_PROXY, R-PAR-8, E189). This adapter only maps lists' "more people than the
// cap" (SELECTION_TOO_LARGE) to the bulk cap code the bulk sheet and module 63 speak (BULK_TOO_LARGE,
// details.cap), and picks the cap and the audience rule from the bulk kind.
import { type BulkKind, BULK_CAPS, isSendKind } from '@realty/core/parity/bulk';
import type { ContactId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { type Selection, type SelectionOptions, resolveSelection as resolveListSelection } from '../lists/index.js';

export type SelectionDef = Selection;
export type { SelectionOptions };

/** PARITY_PLAN §4.2, as module 60 exports it; SELECTION_TOO_LARGE is BULK_TOO_LARGE here. */
export async function resolveSelection(tx: Tx, sel: SelectionDef, opts: SelectionOptions = {}): Promise<ContactId[]> {
  try {
    return await resolveListSelection(tx, sel, opts);
  } catch (e) {
    if (e instanceof AppError && e.code === 'SELECTION_TOO_LARGE') throw new AppError('BULK_TOO_LARGE', e.details);
    throw e;
  }
}

/** A bulk kind's selection options: its cap (Q-PAR-7, on the people selected), and the send-audience rule for email, text and enroll. */
export function selectionOptionsFor(kind: BulkKind): SelectionOptions {
  return { cap: BULK_CAPS[kind], audience: isSendKind(kind) || kind === 'enroll' ? 'send' : 'edit' };
}
