// resolveSelection (PARITY_PLAN §4.2, consumed by module 63 api/templates-bulk):
//
//   resolveSelection(tx, { contactIds } | { listId } | { definition }): ContactId[]
//
// Returns the people the CALLER (the transaction's actor, under their own RLS) can see the detail of,
// live only, at most `cap` (default 10,000, the largest bulk cap), in list order. Nothing the caller
// cannot see is ever returned (R-PAR-28, R-PAR-34: the bulk target is built from people whose detail
// the creator sees). More people than the cap is SELECTION_TOO_LARGE (never a silent truncation).
// With `audience: 'send'` (bulk email, text, enroll), a definition that references a protected-proxy
// tag is refused with AUDIENCE_PROTECTED_PROXY, no override (R-PAR-8, E189).
import type { ContactId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { limitListStatement } from './common.js';
import * as people from './repos/people.js';
import { planFor, resolveSource } from './run.js';

export type Selection = { contactIds: readonly string[] } | { listId: string } | { definition: unknown };

export interface SelectionOptions {
  /** the action's cap (default 10,000) */
  cap?: number;
  /** 'send' for bulk email, text and enroll (the protected-proxy audience rule); default 'edit' */
  audience?: 'edit' | 'send';
}

export const DEFAULT_SELECTION_CAP = 10_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function resolveSelection(tx: Tx, sel: Selection, opts: SelectionOptions = {}): Promise<ContactId[]> {
  const cap = opts.cap ?? DEFAULT_SELECTION_CAP;
  if (!Number.isInteger(cap) || cap < 1 || cap > DEFAULT_SELECTION_CAP) throw new RangeError('cap must be 1..10000');
  if ('contactIds' in sel) {
    const ids = [...new Set(sel.contactIds.map((x) => String(x).toLowerCase()))];
    if (ids.some((x) => !UUID_RE.test(x))) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/contactIds', code: 'uuid' }] });
    if (ids.length > cap) throw new AppError('SELECTION_TOO_LARGE', { cap });
    await limitListStatement(tx);
    return (await people.visibleOf(tx, ids)) as ContactId[];
  }
  const src = await resolveSource(tx, 'listId' in sel ? { listId: sel.listId } : { definition: sel.definition });
  const plan = await planFor(tx, src.definition, { sort: src.sort });
  if (opts.audience === 'send' && plan.audienceProtected) throw new AppError('AUDIENCE_PROTECTED_PROXY', { tagIds: plan.references.protectedTagIds });
  await limitListStatement(tx);
  const ids = await people.allIds(tx, plan, cap + 1);
  if (ids.length > cap) throw new AppError('SELECTION_TOO_LARGE', { cap });
  return ids as ContactId[];
}
