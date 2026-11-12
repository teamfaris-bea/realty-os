// publishable(kind, source): may this source be copied into this grant? It accepts no more than
// 0018's portal_items CHECKs and app.portal_items_guard() accept, and refuses more in the four ways
// listed in index.ts (2(a)-(d)), plus verbatim text it would otherwise have to cut.
//
// Order: shape → kind/source pair (CHECK) → person-only kinds (CHECK; 2(d)) → rule path publishes
// milestones only (2(a)) → the grant is live (2(c), R-PORTAL-6) → the guard's CASE → seller side (2(b))
// → verbatim text limits.
import type { SectionLine } from '../marketing/index.js';
import { BODY_MAX, codePointLength, isPlainVerbatim } from './text.js';
import { KIND_SOURCE_TYPE, PORTAL_KINDS, type GrantBinding, type PortalKind, type PortalSource, type PublishableResult, type SourceFacts } from './types.js';
import { isSourceFacts } from './validate.js';

/**
 * core/marketing marks every feedback line `publish: 'person_only'` (E89); the portal applies the same
 * policy. Typed from SectionLine, so a change there fails to compile here.
 */
export const FEEDBACK_PUBLISH_POLICY: NonNullable<SectionLine['feedback']>['publish'] = 'person_only';
/** Kinds only a person may publish: the CHECK's two (feedback, seller update) and next steps (2(d)). */
export const PERSON_ONLY_KINDS: ReadonlySet<PortalKind> = new Set<PortalKind>(['feedback', 'seller_update', 'next_step']);
/** The only kind the rule path (portal.sync, system) publishes (2(a), DATA_MODEL §8). */
export const RULE_PUBLISHED_KINDS: ReadonlySet<PortalKind> = new Set<PortalKind>(['milestone']);

/** How a showing, its feedback or a seller update reaches the grant (null: it does not). */
type Reach = 'own' | 'attended' | 'deal_listing' | null;

function listingReach(listingId: string, buyer: string | null, g: GrantBinding): Reach {
  if (g.listingId !== null && listingId === g.listingId) return 'own';
  if (buyer !== null && buyer === g.clientContactId) return 'attended';
  if (g.dealListingId !== null && listingId === g.dealListingId) return 'deal_listing';
  return null;
}

/** Mirrors the guard's CASE (with the CHECK on documents), then reports how the source reached the grant. */
function reach(s: PortalSource, g: GrantBinding): Reach {
  switch (s.type) {
    case 'deal_date':
      return g.dealId !== null && s.dealId === g.dealId && s.status === 'confirmed' ? 'own' : null;
    case 'document':
      return s.sharedToPortal && s.scanStatus === 'clean' && s.contactId === null
        && ((s.dealId !== null && s.dealId === g.dealId) || (s.listingId !== null && s.listingId === g.listingId)) ? 'own' : null;
    case 'showing':
      return listingReach(s.listingId, s.buyerContactId, g);
    case 'showing_feedback':
      return listingReach(s.listingId, s.buyerContactId, g);
    case 'assistant_action': {
      if (s.kind !== 'seller_update_draft' || (s.status !== 'approved' && s.status !== 'executed') || s.triggerListingId === null) return null;
      if (g.listingId !== null && s.triggerListingId === g.listingId) return 'own';
      if (g.dealListingId !== null && s.triggerListingId === g.dealListingId) return 'deal_listing';
      return null;
    }
    case 'task':
      return (s.dealId !== null && s.dealId === g.dealId) || (s.listingId !== null && s.listingId === g.listingId) ? 'own' : null;
  }
}

function verbatimOf(s: PortalSource): string | null {
  if (s.type === 'showing_feedback') return s.feedback.comments;
  if (s.type === 'assistant_action') return s.text;
  return null;
}

export function publishable(kind: PortalKind, source: SourceFacts): PublishableResult {
  if (!(PORTAL_KINDS as readonly unknown[]).includes(kind) || !isSourceFacts(source as unknown)) return { ok: false, reason: 'PORTAL_SOURCE_INVALID' };
  const { source: s, grant: g, publisher } = source;
  if (KIND_SOURCE_TYPE[kind] !== s.type) return { ok: false, reason: 'PORTAL_KIND_SOURCE_MISMATCH' };
  if (publisher === 'system' && PERSON_ONLY_KINDS.has(kind)) return { ok: false, reason: 'PORTAL_PERSON_ONLY' };
  if (publisher === 'system' && !RULE_PUBLISHED_KINDS.has(kind)) return { ok: false, reason: 'PORTAL_RULE_MILESTONES_ONLY' };
  // R-PORTAL-6 (publish-time half): no new item into a revoked or lapsed grant, or for a disabled account.
  if (g.revoked || g.lapsed || g.accountDisabled) return { ok: false, reason: 'PORTAL_GRANT_INACTIVE' };
  const r = reach(s, g);
  if (r === null) return { ok: false, reason: 'PORTAL_SOURCE_NOT_IN_GRANT' };
  // 2(b): through the deal's listing only a seller-side party is reached (conflict note 1).
  if (r === 'deal_listing' && !g.clientIsSellerSide) return { ok: false, reason: 'PORTAL_NOT_SELLER_SIDE' };
  const text = verbatimOf(s);
  if (text !== null) {
    if (!isPlainVerbatim(text)) return { ok: false, reason: 'PORTAL_TEXT_NOT_PLAIN' };
    if (codePointLength(text) > BODY_MAX) return { ok: false, reason: 'PORTAL_TEXT_TOO_LONG' };
  }
  return { ok: true };
}
