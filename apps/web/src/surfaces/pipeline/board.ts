// Pure pieces of the pipeline board: the definition a column runs, and how a count is said.
import type { Definition } from '../people/api.js';

/** The board's filter: a saved list's clauses, plus one owner when an agent is picked. */
export function boardDefinition(base: Definition | null, ownerId: string | null): Definition {
  const all = [...(base?.all ?? [])];
  if (ownerId) all.push({ kind: 'owner', in: [ownerId] });
  return { v: 1, all, ...(base?.any && base.any.length > 0 ? { any: base.any } : {}) };
}

/** One column: the board's filter AND this stage. */
export function stageDefinition(board: Definition, stage: string): Definition {
  return { v: 1, all: [...(board.all ?? []), { kind: 'stage', in: [stage] }], ...(board.any && board.any.length > 0 ? { any: board.any } : {}) };
}

/** "4" or "10,000+" — the count the stage-counts route already capped. */
export function countLabel(count: number, capped: boolean): string {
  return capped ? `${count.toLocaleString('en-US')}+` : count.toLocaleString('en-US');
}
