// The bulk target's selection (PARITY_PLAN §4.2) is module 60's resolveSelection (apps/api/src/lists):
//
//   resolveSelection(tx, { contactIds } | { listId } | { definition }, opts?): ContactId[]
//
// called as it is, under the creator's own RLS in `tx`: only people whose DETAIL the caller sees (a pond or
// offer card is never returned), live only, in list order, at most `opts.cap`, never silently truncated; a
// saved list or definition that names a protected-proxy tag is refused as the audience of a send or an
// enrollment (AUDIENCE_PROTECTED_PROXY, R-PAR-8, E189). This adapter only:
//   - maps lists' "more people than the cap" (SELECTION_TOO_LARGE) to the bulk cap code the bulk sheet and
//     module 63 speak (BULK_TOO_LARGE, details.cap), and a list run past its 3 s statement timeout (57014)
//     to LIST_TOO_SLOW, as module 60's own routes answer it (R-PAR-29);
//   - gives the rest of the draft its own statement timeout back: module 60 bounds the list query to 3 s
//     with a transaction-local setting, which would otherwise also bound every later statement of the draft;
//   - applies the same audience rule to people picked one by one from a list (`audienceSource`): the server
//     reads that list's plan itself (module 60's selectionAudience), so the refusal never rests on tag ids
//     the browser worked out (R-PAR-8);
//   - picks the cap and the audience rule from the bulk kind.
import { type BulkKind, BULK_CAPS, isSendKind } from '@realty/core/parity/bulk';
import type { ContactId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { type Selection, type SelectionOptions, resolveSelection as resolveListSelection, selectionAudience } from '../lists/index.js';

export type SelectionDef = Selection;
export type { SelectionOptions };

/** The list people were picked from one by one: a saved smart list, or an unsaved definition (a tag chip view). */
export type AudienceSource = { listId: string } | { definition: unknown };

export interface BulkSelectionOptions extends SelectionOptions {
  /** with `audience: 'send'`: the list hand-picked people came from; one built on a protected tag is refused */
  audienceSource?: AudienceSource | undefined;
}

const isStatementTimeout = (e: unknown): boolean => (e as { code?: unknown } | null)?.code === '57014';

/** PARITY_PLAN §4.2, as module 60 exports it; SELECTION_TOO_LARGE is BULK_TOO_LARGE and a statement timeout LIST_TOO_SLOW here. */
export async function resolveSelection(tx: Tx, sel: SelectionDef, opts: BulkSelectionOptions = {}): Promise<ContactId[]> {
  const { audienceSource, ...listOpts } = opts;
  if (audienceSource && listOpts.audience === 'send') {
    const source = await selectionAudience(tx, audienceSource);
    if (source.audienceProtected) throw new AppError('AUDIENCE_PROTECTED_PROXY', { tagIds: source.protectedTagIds });
  }
  const own = (await sql<{ t: string }>`SELECT current_setting('statement_timeout') AS t`.execute(tx)).rows[0]!.t;
  let ids: ContactId[];
  try {
    ids = await resolveListSelection(tx, sel, listOpts);
  } catch (e) {
    if (e instanceof AppError && e.code === 'SELECTION_TOO_LARGE') throw new AppError('BULK_TOO_LARGE', e.details);
    if (isStatementTimeout(e)) throw new AppError('LIST_TOO_SLOW');
    throw e;
  }
  // the list's 3 s budget ends with the list query (SET LOCAL semantics, like module 60's limitListStatement)
  await sql`SELECT set_config('statement_timeout', ${own}, true)`.execute(tx);
  return ids;
}

/** A bulk kind's selection options: its cap (Q-PAR-7, on the people selected), and the send-audience rule for email, text and enroll. */
export function selectionOptionsFor(kind: BulkKind): SelectionOptions {
  return { cap: BULK_CAPS[kind], audience: isSendKind(kind) || kind === 'enroll' ? 'send' : 'edit' };
}
