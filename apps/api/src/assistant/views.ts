// Agent-facing views of assistant actions (A2; R-AST-5, R-AST-13). Every card carries its one-line
// explanation and its claims with evidence (source + locator + snippet + a readable line); claims the
// assistant could not verify are flagged "Check this" (needsReview). There is no confidence anywhere.
//
// Transcript-sourced snippets are encrypted at rest: they are decrypted only for a viewer who may read
// that call's transcript (core.can transcript.view on the recording's scope, R-PERM-8); anyone else
// sees the source and locator with the snippet withheld.
import { type EvidenceRef, formatEvidence } from '@realty/core/assistant';
import type { TenantId, UserActor } from '@realty/core/foundation';
import { can, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { recordingFacts } from '../comms/recordings.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { type ActionRow, type ClaimRow, type EvidenceRow, claimsOf, snippetAad } from './repos/actions.js';

export interface EvidenceView {
  sourceType: string;
  sourceId: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  verified: boolean;
  sourceAvailable: boolean;
  /** `“call me Thursday around four” at 2:14 in the call` (or why the quote is not shown) */
  label: string;
}

export interface ClaimView {
  id: string;
  kind: string;
  text: string;
  needsReview: boolean;
  reviewStatus: string;
  due: { at: string; display: string; allDay: boolean } | null;
  evidence: EvidenceView[];
}

export interface ActionView {
  id: string;
  kind: string;
  category: string;
  status: string;
  contactId: string | null;
  contactName: string | null;
  explanation: string;
  /** what one tap does: send a reply, or just mark it reviewed */
  primaryAction: 'send' | 'acknowledge';
  draft: { channel: 'sms' | 'email' | 'web_chat'; subject: string | null; body: string } | null;
  claims: ClaimView[];
  createdAt: string;
}

function draftOf(a: ActionRow): ActionView['draft'] {
  const p = { ...a.payload, ...(a.editedPayload ?? {}) } as { channel?: string; body?: string; subject?: string; draft?: { channel?: string; body?: string; subject?: string } };
  const d = a.kind === 'handback' ? p.draft : p;
  if (!d || typeof d.body !== 'string' || d.body.trim() === '') return null;
  return { channel: d.channel === 'email' ? 'email' : d.channel === 'web_chat' || d.channel === 'inbound_channel' ? 'web_chat' : 'sms', subject: typeof d.subject === 'string' ? d.subject : null, body: d.body };
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

async function evidenceView(tx: Tx, actor: UserActor, envelope: EnvelopeService, e: EvidenceRow, cache: Map<string, boolean>): Promise<EvidenceView> {
  let snippet = e.snippet;
  if (e.encrypted && e.snippetEnc) {
    snippet = (await transcriptReadable(tx, actor, e.sourceId, cache))
      ? Buffer.from(await envelope.inTx(tx, actor.tenantId as TenantId).decrypt(actor.tenantId as TenantId, snippetAad(e.id), e.snippetEnc)).toString('utf8')
      : null;
  }
  let label: string;
  if (!e.sourceAvailable) label = 'Source removed under retention policy';
  else if (snippet === null) label = e.encrypted ? 'Quoted from the call (open the call to hear it)' : 'Source';
  else label = formatEvidence({ sourceType: e.sourceType, sourceId: e.sourceId, locator: e.locator, snippet } as EvidenceRef);
  if (snippet !== null && !e.verified) label = `Not found in the source: ${label}`;
  return { sourceType: e.sourceType, sourceId: e.sourceId, locator: e.locator, snippet, verified: e.verified, sourceAvailable: e.sourceAvailable, label };
}

function dueOf(c: ClaimRow): ClaimView['due'] {
  const d = (c.structured?.due ?? null) as { at?: number; display?: string; allDay?: boolean } | null;
  if (!d || typeof d.at !== 'number') return null;
  return { at: toIso(d.at as never), display: typeof d.display === 'string' ? d.display : toIso(d.at as never), allDay: d.allDay === true };
}

export async function actionViews(tx: Tx, actor: UserActor, envelope: EnvelopeService, actions: readonly ActionRow[]): Promise<ActionView[]> {
  const claims = await claimsOf(tx, actions.map((a) => a.id));
  const names = new Map<string, string>();
  const contactIds = [...new Set(actions.map((a) => a.contactId).filter((x): x is string => x !== null))];
  if (contactIds.length > 0) {
    const r = await sql<{ id: string; display_name: string }>`SELECT id, display_name FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${contactIds}::uuid[])`.execute(tx);
    for (const x of r.rows) names.set(x.id, x.display_name);
  }
  const cache = new Map<string, boolean>();
  const out: ActionView[] = [];
  for (const a of actions) {
    const cs: ClaimView[] = [];
    for (const c of claims.filter((x) => x.actionId === a.id)) {
      const ev: EvidenceView[] = [];
      for (const e of c.evidence) ev.push(await evidenceView(tx, actor, envelope, e, cache));
      cs.push({ id: c.id, kind: c.kind, text: c.text, needsReview: c.needsReview && c.reviewStatus === 'unreviewed', reviewStatus: c.reviewStatus, due: dueOf(c), evidence: ev });
    }
    const draft = draftOf(a);
    out.push({
      id: a.id,
      kind: a.kind,
      category: a.category,
      status: a.status,
      contactId: a.contactId,
      contactName: a.contactId ? (names.get(a.contactId) ?? null) : null,
      explanation: a.explanation,
      primaryAction: draft !== null && (a.kind === 'message_draft' || a.kind === 'handback' || a.kind === 'seller_update_draft') ? 'send' : 'acknowledge',
      draft,
      claims: cs,
      createdAt: toIso(a.createdAt),
    });
  }
  return out;
}
