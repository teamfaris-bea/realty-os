// R-ISA-2 (D12 proposed; b12 review B12X-4): whether a person is under live AI care, for the modules that must step
// aside while it lasts (stage automation, module 26 trigger firings). Read in the caller's transaction: the system
// actor sees every record of the person; a user actor sees what RLS shows.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export async function aiIsaLive(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ live: boolean }>`SELECT EXISTS (SELECT 1 FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL
      AND a.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))) AS live`.execute(tx);
  return r.rows[0]?.live === true;
}
