// The seller-update draft row, its claims and its feed card (R-SELL-1, R-SELL-2, R-AST-17; PHASE2_3_PLAN
// §5.3 key families).
//
// One `assistant_actions` row per listing and period (kind seller_update_draft, category seller_update,
// requires_approval: the 0001 CHECK refuses anything else), dedupe `seller_update:{listing}:{period start}`.
// Claims are append-only: a re-assembly appends its claims and `payload.claimOrdinalFrom` marks the current set.
//   - contact_id is NULL: an update belongs to the listing, not to one person. The recipients are the
//     listing's seller contacts at send time; the draft is readable by its owner (the listing agent) and the
//     tenant-wide roles (RLS actions_select), whoever owns each seller contact.
//   - trigger_ref.listing_id is set on every draft (the portal binds to it), with the period key.
//   - payload: what was assembled (sections, period, the watermark) and the seller-facing text without a
//     recommendation (the assistant never prefills one, R-SELL-3). The agent's in-progress choices
//     (recommendation, removed feedback) are theirs and live in edited_payload while the draft is proposed.
//   - every count is a claim with evidence (assistant_claims + evidence_refs); a zero count cites the listing
//     whose log was read ("0"), so a statement like "No showings logged" is still sourced.
//   - the feed card: item_type seller_update, key seller_update:{listing}:{period}, one row for the owner.
import type { Claim } from '@realty/core/assistant';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import type { ClaimSpec, Section } from '@realty/core/marketing';
import { sellerUpdateFeedKey } from '@realty/core/priority';
import { toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import * as A from '../assistant/repos/actions.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { type Assembled, type PeriodSpec, sellerText } from './assembly.js';

export const sellerUpdateDedupeKey = (listingId: string, periodKey: string): string => `seller_update:${listingId}:${periodKey}`;

export interface StoredPeriod {
  start: string;
  end: string;
  key: string;
  label: string;
  zone: string;
}

export interface SellerUpdatePayload {
  channel: 'email' | 'sms';
  subject: string;
  body: string;
  listingId: string;
  period: StoredPeriod;
  sections: Section[];
  assembledThrough: string;
  dataSha256: string;
  /** claims are append-only: this assembly's claims are those from this ordinal on (earlier ones: past assemblies) */
  claimOrdinalFrom: number;
}

export interface AgentChoices {
  recommendation?: string;
  excludedFeedbackIds?: string[];
}

export function storedPeriod(p: PeriodSpec): StoredPeriod {
  return { start: toIso(p.start), end: toIso(p.end), key: p.key, label: p.label, zone: p.zone };
}

export function periodOf(s: StoredPeriod): PeriodSpec {
  return { start: Date.parse(s.start) as Instant, end: Date.parse(s.end) as Instant, key: s.key, label: s.label, zone: s.zone as PeriodSpec['zone'] };
}

/** core ClaimSpecs as stored claims; a zero count cites the listing whose log was read. */
export function claimsOf(specs: readonly ClaimSpec[], listingId: string, ids: IdGenerator): Claim[] {
  return specs.map((c) => ({
    id: ids.next<'AssistantClaimId'>(),
    ordinal: c.ordinal,
    kind: 'fact',
    text: c.text,
    structured: { section: c.section, count: c.count },
    evidence:
      c.evidence.length > 0
        ? c.evidence.map((e) => ({ sourceType: e.sourceType as never, sourceId: e.sourceId, locator: e.locator as never, snippet: e.snippet, verified: true }))
        : [{ sourceType: 'listing', sourceId: listingId, locator: { kind: 'field', name: `${c.section}.count` }, snippet: String(c.count ?? 0), verified: true }],
    needsReview: false,
    reviewReasons: [],
  }));
}

export function payloadOf(o: { listingId: string; address: string; period: PeriodSpec; a: Assembled; channel: 'email' | 'sms' }): SellerUpdatePayload {
  const t = sellerText({ address: o.address, period: o.period, sections: o.a.sections, excludedFeedbackIds: [], recommendation: null, agentName: null });
  return { channel: o.channel, subject: t.subject, body: t.body, listingId: o.listingId, period: storedPeriod(o.period), sections: o.a.sections, assembledThrough: toIso(o.a.assembledThrough), dataSha256: o.a.dataSha256, claimOrdinalFrom: 0 };
}

interface Env {
  envelope: EnvelopeService;
  tenantId: string;
  ids: IdGenerator;
}

/** Inserts the period's draft (false: one already exists for this listing and period, R-SELL-1). */
export async function insertDraft(tx: Tx, env: Env, o: { id: string; ownerUserId: string; listingId: string; address: string; period: PeriodSpec; a: Assembled; channel: 'email' | 'sms' }): Promise<boolean> {
  return A.insertAction(tx, env, {
    id: o.id,
    contactId: null,
    kind: 'seller_update_draft',
    category: 'seller_update',
    autonomy: 'requires_approval',
    playbookVersionId: null,
    status: 'proposed',
    ownerUserId: o.ownerUserId,
    explanation: `Update for ${o.address} ${o.period.label}, assembled from what is logged in Realty OS. Add your recommendation, then send.`,
    payload: payloadOf(o) as unknown as Record<string, unknown>,
    pinnedInboundSeq: null,
    boundOwnershipSeq: null,
    aiRunId: null,
    triggerRef: { kind: 'seller_update', listing_id: o.listingId, period_key: o.period.key },
    dedupeKey: sellerUpdateDedupeKey(o.listingId, o.period.key),
    claims: claimsOf(o.a.claims, o.listingId, env.ids),
  });
}

/**
 * Replaces what was assembled (re-assembly), keeping the agent's choices. Claims are append-only (no DELETE
 * grant): the new assembly's claims follow the old ones and the payload says where they start.
 */
export async function replaceAssembly(tx: Tx, env: Env, actionId: string, payload: SellerUpdatePayload, claims: readonly ClaimSpec[]): Promise<void> {
  const from = await A.claimCount(tx, actionId);
  const next = { ...payload, claimOrdinalFrom: from };
  await sql`UPDATE assistant_actions SET payload = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  await A.insertClaims(tx, env, actionId, claimsOf(claims, payload.listingId, env.ids), from);
}

/** The owner's feed card for the draft (one row under the module's key family). */
export async function upsertCard(tx: Tx, ids: IdGenerator, o: { userId: string; listingId: string; periodKey: string; actionId: string; address: string; label: string }): Promise<void> {
  const reasons = [{ code: 'SELLER_UPDATE_READY', label: `The update for ${o.address} ${o.label} is ready: add your recommendation and send` }];
  await sql`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, due_at, score, score_version, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${o.userId}, 'seller_update', 'scored', NULL, 'listing', ${o.listingId}, ${o.actionId}, NULL, 55, 1,
            ${JSON.stringify(reasons)}::jsonb, ${sellerUpdateFeedKey(o.listingId as never, o.periodKey)})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET
      reasons = EXCLUDED.reasons, assistant_action_id = EXCLUDED.assistant_action_id, updated_at = now()`.execute(tx);
}

/** Closes the open draft (superseded / invalidated) and its feed card. */
export async function closeDraft(tx: Tx, actionId: string, status: 'superseded' | 'invalidated', now: Instant): Promise<void> {
  await sql`UPDATE assistant_actions SET status = ${status}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${actionId} AND status = 'proposed'`.execute(tx);
  await A.resolveFeedFor(tx, actionId, now);
}
