// The AI ISA saved-search proposal (ISA-2b item 12, D7c; R-ISA-17, R-AST-10; E520; docs/AI_ISA.md §6.2). The AI only
// PROPOSES: the search is stored `proposed` with origin ai_isa and stays so until a human approves it (0001's
// SAVED_SEARCH_APPROVAL_REQUIRES_HUMAN); nothing goes to the client. While care is live an ai_isa search never
// alerts (searches.ts due query); at the handoff it is paused for review and the homes the AI already sent are marked
// alerted, so a later alert never repeats them (handoffSearches.ts).
//
// R-GMAIL-14 (batch 13 audit ISA2B-03): this file imports assistant/** and is reached only from isa/turn.ts and
// isa/handlers.ts, which no path from mailSync/** reaches. What the handoff needs (effects.ts, which mailSync reaches
// through comms/inbound → isa/ingest) lives in handoffSearches.ts with no assistant import. No dynamic import(): the
// architecture test's scan sees those too.
import type { AssistantClaimId, Instant } from '@realty/core/foundation';
import type { Claim } from '@realty/core/assistant';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { contactCore } from '../../assistant/repos/context.js';
import { proposeSavedSearchInTx } from '../../assistant/searches.js';
import type { IsaContext, IsaDeps } from '../effects.js';
import { initiatedTierPassesInTx } from '../send.js';
import { criteriaFromClaims } from './criteria.js';

export const AI_SEARCH_NAME = 'Search from the AI assistant';

/** Q4: alerts of an AI-proposed search go by email when bound, else SMS. VERIFY. */
export const alertChannelFor = (ctx: Pick<IsaContext, 'channels'>): 'email' | 'sms' | null => (ctx.channels.includes('email') ? 'email' : ctx.channels.includes('sms') ? 'sms' : null);

/** savedSearchAllowed (decideAction): the capability, the buyer side, criteria with a location, no open AI-origin search, the initiated tier on the alert channel. */
export async function savedSearchAllowedInTx(tx: Tx, ctx: IsaContext, i: { capability: boolean }): Promise<boolean> {
  const a = ctx.a;
  if (!i.capability || (a.side !== 'buyer' && a.side !== 'both')) return false;
  if (criteriaFromClaims(a.machine.claims) === null) return false;
  const open = await sql<{ n: number }>`SELECT count(*)::int AS n FROM saved_searches WHERE tenant_id = app.tenant_id() AND origin = 'ai_isa'
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid)) AND status IN ('proposed','approved','active','paused')`.execute(tx);
  if (open.rows[0]!.n > 0) return false;
  const ch = alertChannelFor(ctx);
  return ch !== null && (await initiatedTierPassesInTx(tx, a, ch));
}

/** The job body (system, under the turn locks): re-check, then the proposal. Returns an outcome code. */
export async function proposeAiSavedSearchInTx(tx: Tx, deps: IsaDeps, ctx: IsaContext, now: Instant): Promise<string> {
  const a = ctx.a;
  if (a.endedAt !== null || a.pausedAt !== null) return 'CARE_NOT_LIVE';
  if (!(await savedSearchAllowedInTx(tx, ctx, { capability: true }))) return 'SAVED_SEARCH_NOT_ALLOWED';
  const c = criteriaFromClaims(a.machine.claims)!;
  const contact = await contactCore(tx, a.contactId);
  if (contact === null) return 'NO_CONTACT';
  // one qualification Claim per usable claim, in parseCriterion's input form, with its verified own-text quote
  const claims: Claim[] = c.evidence.map((e, k) => ({
    id: deps.ids.next<'AssistantClaimId'>() as AssistantClaimId, ordinal: k, kind: 'qualification', text: `${e.claim.field}: ${e.claim.quote}`.slice(0, 300),
    structured: { criterion: { key: e.modelKey, value: e.value } },
    evidence: [{ sourceType: 'message', sourceId: e.claim.messageId, locator: { kind: 'message' }, snippet: e.claim.quote, verified: true }],
    needsReview: false, reviewReasons: [],
  }) as Claim);
  const last = c.evidence.map((e) => e.claim).sort((x, y) => y.saidAt - x.saidAt)[0]!;
  const r = await proposeSavedSearchInTx(tx, deps as never, await tenantOf(tx), {
    contact, claims, aiRunId: null, callId: null, inboundSeq: a.lastInboundSeq, now,
    origin: 'ai_isa', dedupeKey: `search_proposal:ai_isa:${a.id}`, triggerRef: { kind: 'inbound', messageId: last.messageId }, name: AI_SEARCH_NAME,
    explanation: 'A saved search from what they told the AI assistant. Review and approve it before any alert goes out.', alertChannel: alertChannelFor(ctx) ?? 'email',
  });
  return r === null ? 'NOTHING_TO_PROPOSE' : 'PROPOSED';
}

async function tenantOf(tx: Tx): Promise<string> {
  return (await sql<{ t: string }>`SELECT app.tenant_id()::text AS t`.execute(tx)).rows[0]!.t;
}
