// Exports, delivery labels and listing-status effects (R-MKT-6, R-MKT-9, R-GBP-2; E91).
//
// - R-MKT-6: `exported` means handed to the agent. The product never says a post went live where it
//   cannot verify it: export labels are fixed strings (no caller text is ever spliced into them) and
//   none of them says posted, published or live. Facebook Marketplace is export-only (no general
//   listing API we know of, ARCHITECTURE §21.5).
// - `exportBundle` renders the version against the live listing (bound facts current, R-MKT-3) and
//   hands back the copy and the version's own images in order. It takes the identity and packs as
//   well as the piece and facts, because R-MKT-1 forbids exporting a piece without the brokerage name.
// - R-MKT-9 / E91: when the listing goes sold, withdrawn or expired, unsent invites are canceled, the
//   page answers 410 and says so, and exports are flagged "may be out of date".
import type { ListingFacts } from '../listings/index.js';
import { OFF_MARKET_STATUSES, renderPiece } from './render.js';
import type { BrokerageIdentity, ExportBundle, ExportFlag, Packs, PieceKind, PieceStatus, PieceVersion } from './types.js';

/** How each kind can leave the product. Only `ourPage` is something we can verify is up. */
export interface Delivery {
  /** A page we serve (app.public_listing_page). */
  readonly ourPage: boolean;
  /** Publishable through a connected, approved integration (publishPost, behind platform:fair_housing). */
  readonly integration: boolean;
  /** Sent as gated per-recipient emails (R-MKT-8). */
  readonly send: boolean;
  /** Can be exported (handed to the agent). */
  readonly export: boolean;
}

export const DELIVERY: Readonly<Record<PieceKind, Delivery>> = Object.freeze({
  website_page: { ourPage: true, integration: false, send: false, export: true },
  social_post: { ourPage: false, integration: true, send: false, export: true },
  open_house_invite: { ourPage: false, integration: false, send: true, export: false },
  flyer: { ourPage: false, integration: false, send: false, export: true },
  marketplace_export: { ourPage: false, integration: false, send: false, export: true },
  gbp_post: { ourPage: false, integration: true, send: false, export: true },
});

/** True for a kind that can only ever be exported (Facebook Marketplace). */
export function exportOnly(kind: PieceKind): boolean {
  const d = DELIVERY[kind];
  return d.export && !d.ourPage && !d.integration && !d.send;
}

/** Whether a kind may be published: to our own page, or through a connected integration (R-GBP-2). */
export function canPublish(kind: PieceKind, integrationConnected: boolean): boolean {
  const d = DELIVERY[kind];
  return d.ourPage || (d.integration && integrationConnected);
}

const EXPORT_LABEL: Readonly<Record<PieceKind, string>> = Object.freeze({
  website_page: 'Exported: the page copy was handed to you',
  social_post: 'Exported: copy it to your social account yourself',
  open_house_invite: 'Exported: the invite copy was handed to you',
  flyer: 'Exported: the flyer was handed to you to print or share',
  marketplace_export: 'Exported for Facebook Marketplace: copy it there yourself',
  gbp_post: 'Exported: copy it to your Business Profile yourself',
});

/** Fixed, honest words for a piece's state (R-MKT-6). No caller text is ever part of a label. */
export function deliveryLabel(kind: PieceKind, status: PieceStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft: not approved yet';
    case 'approved':
      return 'Approved: not shared anywhere yet';
    case 'published':
      return kind === 'website_page' ? 'On your listing page' : 'Handed to your connected account';
    case 'exported':
      return EXPORT_LABEL[kind];
    case 'retracted':
      return DELIVERY[kind].ourPage ? 'Taken down from your listing page' : 'Retracted here; copies you exported stay where you put them';
    case 'superseded':
      return 'Replaced by a newer version';
  }
}

/** Words that would claim a post went live where we cannot verify it (copy lint for labels, R-MKT-6). */
export const POSTING_CLAIM_RE = /\b(?:posted|post(?:ed)? live|publish(?:ed|ing)?|live|went up|is up|now on|shared (?:on|to))\b/i;

export function claimsPosting(label: string): boolean {
  return POSTING_CLAIM_RE.test(label.normalize('NFKC'));
}

export const OUT_OF_DATE_NOTICE = 'May be out of date: the listing is no longer for sale.';

/**
 * The export of one version: rendered against the live listing, with the version's images in order.
 * Refused like `renderPiece` (an MLS listing is never exported, R-MKT-5).
 */
export function exportBundle(p: PieceVersion, facts: ListingFacts, identity: BrokerageIdentity, packs: Packs): ExportBundle {
  const r = renderPiece(p, facts, identity, packs);
  if (!r.ok) return r;
  const flags: ExportFlag[] = OFF_MARKET_STATUSES.includes(facts.status) ? ['may_be_out_of_date'] : [];
  const label = flags.length > 0 ? `${EXPORT_LABEL[p.kind]}. ${OUT_OF_DATE_NOTICE}` : EXPORT_LABEL[p.kind];
  return { ok: true, kind: p.kind, text: r.text, images: [...r.images], label, flags };
}

// ---- listing status effects (R-MKT-9, E91) ----------------------------------------------------------

export interface ListingStatusEffect {
  readonly offMarket: boolean;
  /** Unsent open-house invites are canceled. */
  readonly cancelUnsentInvites: boolean;
  /** The public page: served, or 410 Gone with the notice (R-MKT-7). */
  readonly page: 'serve' | 'gone';
  /** Flag on every export of the listing's pieces. */
  readonly exportFlag: ExportFlag | null;
  readonly notice: string | null;
}

const OFF_MARKET_NOTICE: Readonly<Record<'sold' | 'withdrawn' | 'expired', string>> = {
  sold: 'This home has sold.',
  withdrawn: 'This home is no longer for sale.',
  expired: 'This home is no longer for sale.',
};

/** What a listing status means for its marketing (pure decision; the API applies it). */
export function listingStatusEffect(status: ListingFacts['status']): ListingStatusEffect {
  if (status === 'sold' || status === 'withdrawn' || status === 'expired') {
    return { offMarket: true, cancelUnsentInvites: true, page: 'gone', exportFlag: 'may_be_out_of_date', notice: OFF_MARKET_NOTICE[status] };
  }
  return { offMarket: false, cancelUnsentInvites: false, page: 'serve', exportFlag: null, notice: null };
}
