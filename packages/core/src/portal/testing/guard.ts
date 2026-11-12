// A line-by-line transcription of what 0018 §18 accepts for a new portal_items row: the table's
// CHECKs and app.portal_items_guard()'s CASE (the grant join supplies g.deal_id, g.listing_id,
// g.contact_id, g.deal_listing_id). SQL NULL semantics are kept: `x = NULL` is not true, and
// `a IN (NULL, NULL)` is not true. Tests use it as the oracle publishable() must never exceed.
import type { PortalKind, SourceFacts } from '../types.js';

const eq = (a: string | null, b: string | null): boolean => a !== null && b !== null && a === b;

/** CHECK ((kind, source_type) IN (...)) AND CHECK (kind NOT IN ('feedback','seller_update') OR published_by_kind = 'user'). */
export function checksAccept(kind: PortalKind, f: SourceFacts): boolean {
  const pairs: [string, string][] = [['milestone', 'deal_date'], ['document', 'document'], ['showing', 'showing'], ['feedback', 'showing_feedback'], ['seller_update', 'assistant_action'], ['next_step', 'task']];
  if (!pairs.some(([k, t]) => k === kind && t === f.source.type)) return false;
  if ((kind === 'feedback' || kind === 'seller_update') && f.publisher !== 'user') return false;
  return true;
}

/** ok := CASE NEW.source_type ... END (the guard ignores revocation, the seller side and the publisher). */
export function guardCaseAccepts(f: SourceFacts): boolean {
  const g = { deal_id: f.grant.dealId, listing_id: f.grant.listingId, contact_id: f.grant.clientContactId, deal_listing_id: f.grant.dealListingId };
  const s = f.source;
  switch (s.type) {
    case 'deal_date': // dd.deal_id = g.deal_id AND dd.status = 'confirmed'
      return eq(s.dealId, g.deal_id) && s.status === 'confirmed';
    case 'document': // doc.shared_to_portal AND doc.scan_status = 'clean' AND (doc.deal_id = g.deal_id OR doc.listing_id = g.listing_id)
      return s.sharedToPortal && s.scanStatus === 'clean' && (eq(s.dealId, g.deal_id) || eq(s.listingId, g.listing_id));
    case 'showing': // s.listing_id = g.listing_id OR s.listing_id = g.deal_listing_id OR s.buyer_contact_id = g.contact_id
      return eq(s.listingId, g.listing_id) || eq(s.listingId, g.deal_listing_id) || eq(s.buyerContactId, g.contact_id);
    case 'showing_feedback':
      return eq(s.listingId, g.listing_id) || eq(s.listingId, g.deal_listing_id) || eq(s.buyerContactId, g.contact_id);
    case 'assistant_action': // aa.kind = 'seller_update_draft' AND aa.status IN ('approved','executed') AND trigger_ref->>'listing_id' IN (g.listing_id::text, g.deal_listing_id::text)
      return s.kind === 'seller_update_draft' && (s.status === 'approved' || s.status === 'executed')
        && (eq(s.triggerListingId, g.listing_id) || eq(s.triggerListingId, g.deal_listing_id));
    case 'task': // t.deal_id = g.deal_id OR t.listing_id = g.listing_id
      return eq(s.dealId, g.deal_id) || eq(s.listingId, g.listing_id);
  }
}

/** The DB would insert the row (CHECKs and the guard's CASE). */
export function dbAccepts(kind: PortalKind, f: SourceFacts): boolean {
  return checksAccept(kind, f) && guardCaseAccepts(f);
}

/** Postgres length(btrim(title)) with one argument: btrim strips only U+0020; length counts code points. */
export function pgBtrimLength(title: string): number {
  return Array.from(title.replace(/^ +| +$/g, '')).length;
}

/** The row-level CHECKs on title, body and document_id. */
export function rowChecksAccept(spec: { kind: string; title: string; body: string | null; documentId: string | null; sourceId: string }): boolean {
  const titleLen = pgBtrimLength(spec.title);
  return titleLen >= 1 && titleLen <= 120 && (spec.body === null || Array.from(spec.body).length <= 4000)
    && (spec.kind === 'document') === (spec.documentId !== null) && (spec.documentId === null || spec.documentId === spec.sourceId);
}
