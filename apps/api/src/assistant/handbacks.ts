// Handback enrichment (ARCHITECTURE §10 step 9; R-AST-9, R-AST-3; E35). The handback itself — with its
// deterministic "what the client said / what was sent" claims — is written by api/comms in the inbound
// transaction and is useful on its own. This job adds, later and optionally:
//   - the assistant's suggested next step as evidence-backed `suggestion` claims (needs_review when the
//     quote cannot be verified), appended to the handback;
//   - a suggested reply the agent sends with ONE tap (POST /assistant/actions/:id/approve). A reply that
//     touches money or contracts is labelled so and is still only ever sent by the agent's tap (E35).
// R-AST-18: AI off ⇒ nothing is added and no provider call is made.
import { draftCategory } from '@realty/core/assistant';
import type { SystemActor } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import * as A from './repos/actions.js';
import { runModel } from './runs.js';
import type { AssistantDeps } from './types.js';

export type EnrichResult = { kind: 'enriched'; claims: number; draft: boolean; category: string | null } | { kind: 'skipped'; reason: string };

/** BUILD_PLAN interface. */
export async function enrichHandback(actor: SystemActor, actionId: string, deps: AssistantDeps): Promise<EnrichResult> {
  const h = await withTenantTx(actor, (tx) => A.actionById(tx, actionId), { db: deps.db });
  if (!h || h.kind !== 'handback' || !h.contactId) return { kind: 'skipped', reason: 'NOT_A_HANDBACK' };
  if (h.status !== 'proposed') return { kind: 'skipped', reason: 'HANDLED' };
  if (h.payload.enriched === true) return { kind: 'skipped', reason: 'ALREADY_ENRICHED' };
  const trigger = { kind: 'handback' as const, actionId };
  const inboundId = typeof h.payload.inboundMessageId === 'string' ? h.payload.inboundMessageId : null;

  // Each half is applied at most once (a reaped job can re-run while the first run is still in flight):
  // the persist step re-reads the handback under its row lock and marks what it added.
  let next: number | null | { skipped: string } = null;
  if (h.payload.suggested !== true) {
    next = await runModel(actor, deps, { purpose: 'handback_enrichment', contactId: h.contactId, forUserId: h.ownerUserId, trigger }, async (tx, run) => {
      const cur = await A.actionById(tx, actionId, { lock: true });
      if (!cur || cur.status !== 'proposed' || cur.payload.enriched === true || cur.payload.suggested === true) return null;
      const claims = run.claims;
      await A.insertClaims(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, actionId, claims, await A.claimCount(tx, actionId));
      await A.mergePayload(tx, actionId, { suggested: true });
      return claims.length;
    });
    if (next !== null && typeof next === 'object' && 'skipped' in next) return { kind: 'skipped', reason: next.skipped };
  }

  const draft = await runModel(actor, deps, { purpose: 'draft', contactId: h.contactId, forUserId: h.ownerUserId, trigger }, async (tx, run) => {
    const cur = await A.actionById(tx, actionId, { lock: true });
    if (!cur || cur.status !== 'proposed' || cur.payload.enriched === true) return null;
    let category: string | null = null;
    if (run.draft) {
      const inbound = inboundId ? (await sql<{ body: string }>`SELECT body FROM messages WHERE tenant_id = app.tenant_id() AND id = ${inboundId}`.execute(tx)).rows[0]?.body ?? null : null;
      category = draftCategory({ inboundText: inbound, draftText: run.draft.body });
      await A.mergePayload(tx, actionId, { draft: { channel: run.draft.channel, body: run.draft.body, ...(run.draft.subject ? { subject: run.draft.subject } : {}) }, draftCategory: category, draftAiRunId: run.aiRunId });
      if (category === 'money' || category === 'contract') {
        await sql`UPDATE assistant_actions SET explanation = left(explanation || ${category === 'money' ? ' Their message touches price or money: the reply waits for your tap.' : ' Their message touches a contract: the reply waits for your tap.'}, 300)
                   WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
      }
    }
    await A.mergePayload(tx, actionId, { enriched: true });
    return { draft: run.draft !== null, category };
  });
  if (draft !== null && typeof draft === 'object' && 'skipped' in draft) return { kind: 'skipped', reason: draft.skipped };
  return { kind: 'enriched', claims: typeof next === 'number' ? next : 0, draft: draft?.draft === true, category: draft?.category ?? null };
}
