// The tool-call ledger of an AI call (R-VOICE-4, R-VOICE-14; E429). Module 48 writes exactly what core decided:
// core's seq, row (the allowlisted projection), decision, reason and instant, BEFORE the effect, append-only.
// A request is written only when its row is non-null (a tool in the closed set) and the call had disclosed itself
// and announced the recording by then (app.voice_tool_calls_guard); everything else goes to the session's
// `unlogged` list, which the handback carries (codes and instants only). At most VOICE_LEDGER_CAP rows per call:
// the next request is not written, the runner ends the session through a vendor_error (LEDGER_CAP).
import type { Instant } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { LedgerEntry } from '@realty/core/voice';
import type { IdGenerator } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export const VOICE_LEDGER_CAP = 200;

export interface Unlogged {
  seq: number;
  reason: string;
  at: string;
}

export type LedgerWrite = { kind: 'written' } | { kind: 'unlogged'; unlogged: Unlogged } | { kind: 'cap'; unlogged: Unlogged };

export function ledgerDisposition(entry: LedgerEntry, s: { disclosedAt: Instant | null; announcedAt: Instant | null; written: number }): 'write' | 'unlogged' | 'cap' {
  if (entry.row === null || s.disclosedAt === null || s.announcedAt === null || entry.at < s.disclosedAt || entry.at < s.announcedAt) return 'unlogged';
  return s.written >= VOICE_LEDGER_CAP ? 'cap' : 'write';
}

export async function writeLedger(tx: Tx, ids: IdGenerator, callId: string, entry: LedgerEntry, s: { disclosedAt: Instant | null; announcedAt: Instant | null; written: number }): Promise<LedgerWrite> {
  const d = ledgerDisposition(entry, s);
  if (d !== 'write') return { kind: d, unlogged: { seq: entry.seq, reason: d === 'cap' ? 'LEDGER_CAP' : entry.reason, at: toIso(entry.at) } };
  const row = entry.row!;
  await sql`
    INSERT INTO voice_tool_calls (tenant_id, id, call_id, seq, tool, args, decision, reason_code, occurred_at)
    VALUES (app.tenant_id(), ${ids.next()}::uuid, ${callId}::uuid, ${entry.seq}, ${row.tool}, ${JSON.stringify(row.args)}::jsonb, ${entry.decision}, ${entry.reason}, ${toIso(entry.at)}::timestamptz)
    ON CONFLICT (tenant_id, call_id, seq) DO NOTHING`.execute(tx);
  return { kind: 'written' };
}
