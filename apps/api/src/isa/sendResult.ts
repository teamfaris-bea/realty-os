// The send_result emitter (R-ISA-4, R-ISA-11, R-ISA-14, R-ISA-21; docs/AI_ISA.md §9.2): every terminal status of an AI
// ISA message enqueues one `ai_isa.send_result` job (idempotent on message and status). Dependency-free on purpose:
// the flagged one-line emits in comms (inbound cancel, status callbacks, reconcile) and the stale reaper import it.
// It never decides a send; it only reports what already happened.
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';

export const AI_ISA_MESSAGE_CATEGORIES = ['ai_isa_message', 'ai_isa_confirmation', 'ai_isa_holding_line'] as const;

/** Emits send_result `status` for each id in `messageIds` that is an AI ISA message (others are ignored). */
export async function emitIsaSendResultsInTx(tx: Tx, messageIds: readonly string[], status: string): Promise<number> {
  if (messageIds.length === 0) return 0;
  const r = await sql<{ id: string }>`SELECT id FROM messages WHERE tenant_id = app.tenant_id() AND id = ANY (${[...messageIds]}::uuid[])
    AND initiator = 'assistant' AND action_category = ANY (${[...AI_ISA_MESSAGE_CATEGORIES]}::text[])`.execute(tx);
  for (const m of r.rows) {
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.send_result', payload: { messageId: m.id, status }, dedupeKey: `ai_isa.send_result:${m.id}:${status}` });
  }
  return r.rows.length;
}
