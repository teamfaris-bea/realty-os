// The AI-origin saved searches at the AI ISA handoff (ISA-2b item 12, cut 3 kept; R-ISA-17, R-AST-10; docs/AI_ISA.md
// §6.2). Split from savedSearch.ts (batch 13 audit ISA2B-03): isa/effects.ts writes the handoff and is reachable from
// mailSync/** (mailSync/sync → comms/inbound → isa/ingest → isa/effects), so this file imports nothing from
// apps/api/src/assistant/** (R-GMAIL-14); the proposal, which needs assistant/searches.ts, stays in savedSearch.ts.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/**
 * At the handoff (cut 3 kept): the person's active AI-origin searches pause for review, and their matches of homes
 * the AI already sent are marked alerted with that message, so the alerts that follow re-approval never repeat them.
 */
export async function pauseAiSearchesAtHandoffInTx(tx: Tx, contactId: string): Promise<{ id: string; status: string } | null> {
  await sql`UPDATE saved_search_matches sm SET alerted_message_id = f.message_id FROM saved_searches s, ai_isa_shared_facts f
    WHERE sm.tenant_id = app.tenant_id() AND s.tenant_id = sm.tenant_id AND s.id = sm.search_id AND s.origin = 'ai_isa' AND sm.alerted_message_id IS NULL
      AND s.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
      AND f.tenant_id = sm.tenant_id AND f.listing_id = sm.listing_id AND f.status = 'sent'
      AND f.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))`.execute(tx);
  await sql`UPDATE saved_searches SET status = 'paused' WHERE tenant_id = app.tenant_id() AND origin = 'ai_isa' AND status = 'active'
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))`.execute(tx);
  const r = await sql<{ id: string; status: string }>`SELECT id, status FROM saved_searches WHERE tenant_id = app.tenant_id() AND origin = 'ai_isa'
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)) AND status IN ('proposed','approved','paused','active')
    ORDER BY created_at DESC LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}
