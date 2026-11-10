// Evidence of the claims behind assistant-made tasks (promise tasks, A2/A5): source + locator + snippet +
// a short readable line. Transcript-sourced snippets are encrypted at rest and are decrypted only for a
// viewer who may read that call's transcript (core.can transcript.view on the recording, R-PERM-8);
// anyone else sees the source and where it is, with the quote withheld. No confidence anywhere (R-AST-13).
import { type EvidenceRef, formatEvidence } from '@realty/core/assistant';
import { type TenantId, type UserActor, can } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { snippetAad } from '../../assistant/repos/actions.js';
import { recordingFacts } from '../../comms/recordings.js';
import type { EnvelopeService } from '../../crypto/envelope.js';

export interface EvidenceView {
  sourceType: string;
  sourceId: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  verified: boolean;
  sourceAvailable: boolean;
  /** `“I'll send the comps by Friday” at 2:14 in the call`, or why the quote is not shown */
  label: string;
}

interface Row {
  id: string;
  claim_id: string;
  source_type: string;
  source_id: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  snippet_enc: Buffer | null;
  verbatim_verified: boolean;
  source_available: boolean;
}

/** Evidence per claim id, readable by the current viewer (RLS: evidence follows its claim's action). */
export async function evidenceForClaims(tx: Tx, actor: UserActor, envelope: EnvelopeService, claimIds: readonly string[]): Promise<Map<string, EvidenceView[]>> {
  const out = new Map<string, EvidenceView[]>();
  if (claimIds.length === 0) return out;
  const r = await sql<Row>`
    SELECT id, claim_id, source_type, source_id, locator, snippet, snippet_enc, verbatim_verified, source_available
      FROM evidence_refs WHERE tenant_id = app.tenant_id() AND claim_id = ANY (${[...claimIds]}::uuid[]) ORDER BY created_at, id`.execute(tx);
  const readable = new Map<string, boolean>();
  for (const e of r.rows) {
    let snippet = e.snippet;
    if (e.snippet_enc) {
      snippet = (await transcriptReadable(tx, actor, e.source_id, readable))
        ? Buffer.from(await envelope.inTx(tx, actor.tenantId as TenantId).decrypt(actor.tenantId as TenantId, snippetAad(e.id), new Uint8Array(e.snippet_enc))).toString('utf8')
        : null;
    }
    let label: string;
    if (!e.source_available) label = 'Source removed under retention policy';
    else if (snippet === null) label = e.snippet_enc ? 'Quoted from the call (open the call to hear it)' : 'Source';
    else label = formatEvidence({ sourceType: e.source_type, sourceId: e.source_id, locator: e.locator, snippet } as EvidenceRef);
    if (snippet !== null && !e.verbatim_verified) label = `Not found in the source: ${label}`;
    const list = out.get(e.claim_id) ?? [];
    list.push({ sourceType: e.source_type, sourceId: e.source_id, locator: e.locator, snippet, verified: e.verbatim_verified, sourceAvailable: e.source_available, label });
    out.set(e.claim_id, list);
  }
  return out;
}

async function transcriptReadable(tx: Tx, actor: UserActor, callId: string, cache: Map<string, boolean>): Promise<boolean> {
  const hit = cache.get(callId);
  if (hit !== undefined) return hit;
  const r = await sql<{ id: string }>`SELECT id FROM recordings WHERE tenant_id = app.tenant_id() AND call_id = ${callId} ORDER BY created_at LIMIT 1`.execute(tx);
  let ok = false;
  if (r.rows[0]) {
    const facts = await recordingFacts(tx, r.rows[0].id);
    ok = facts !== null && can(actor, 'transcript.view', facts).ok;
  }
  cache.set(callId, ok);
  return ok;
}
