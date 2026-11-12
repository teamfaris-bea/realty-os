// Shared words and requests of the marketing tab and the marketing approval card (module 38).
//
// HONESTY RULE (R-MKT-6, R-MKT-12): the UI says "Posted" only for a publication whose `posted` flag the
// server set after the provider confirmed the post. Labels are the server's words, shown verbatim; the
// only change the web ever makes is to REMOVE a "Posted" claim the posted flag does not back up.
import { type MutateResult, useMutate } from '../feed/lib/hooks.js';
import type { ExportView, PieceKind, PieceView, PublicationView } from './types.js';

export const MARKETING_KEY = ['marketing'] as const;
export const marketingKey = (listingId: string) => ['marketing', 'listing', listingId] as const;
export const APPROVALS_KEY = ['marketing', 'approvals'] as const;
const INVALIDATE = [[...MARKETING_KEY], ['feed']];

export const KIND_LABEL: Record<PieceKind, string> = {
  website_page: 'Listing page',
  social_post: 'Social post',
  open_house_invite: 'Open house invite',
  flyer: 'Flyer',
  marketplace_export: 'Facebook Marketplace',
};

/** The order cards appear in (the server sorts by kind name). */
export const KIND_ORDER: readonly PieceKind[] = ['social_post', 'website_page', 'flyer', 'open_house_invite', 'marketplace_export'];

export function kindLabel(kind: string): string {
  return (KIND_LABEL as Record<string, string>)[kind] ?? 'Marketing piece';
}

/** The server's exact words for a piece leaving the product without us posting it (EXPORTED_POST_IT_YOURSELF). */
export const EXPORTED_POST_IT_YOURSELF = 'Exported: post it yourself';

export const MARKETING_ERROR_MESSAGES: Record<string, string> = {
  MARKETING_STALE: 'This piece changed since you opened it. What you see now is up to date: check it, then approve.',
  MARKETING_GUARD_FAILED: "This can't be approved yet: see what to fix on the card.",
  MARKETING_NOT_DRAFT: 'This version was already approved.',
  MARKETING_APPROVE_FIRST: 'Approve this version first.',
  MARKETING_NOT_LIVE: 'This version is no longer live. Use the newest version.',
  MARKETING_TERMINAL: 'This version is final and cannot change.',
  MARKETING_TEAM_LISTING_ONLY: 'Marketing is made only for listings your team has.',
  MARKETING_NOT_PUBLISHABLE: "This kind of piece isn't published here. Export it and post it yourself.",
  MARKETING_NOT_EXPORTABLE: 'An open house invite is sent, not exported.',
  MARKETING_DRAFT_EXISTS: 'A newer draft of this piece exists already.',
  MARKETING_HUMAN_APPROVAL: 'A person approves marketing, as themselves.',
  PLATFORM_NOT_CLEARED: 'Publishing stays off until counsel reviews the fair-housing pack. Export it and post it yourself.',
  PUBLISH_TARGET_INVALID: 'A social post goes to a Facebook Page or an Instagram business account only.',
  PUBLISH_NEEDS_IMAGE: 'Instagram needs at least one photo on the post.',
  PUBLICATION_ALREADY_LIVE: 'This version is already on that account, or we are still checking whether it went up. It will not be posted again.',
  PUBLICATION_NOT_LIVE: 'That post is not up, so there is nothing to take down.',
  PUBLICATION_RETRACTING: 'We are already taking that post down. Check back in a minute.',
  CHANNEL_NOT_CONNECTED: "That account isn't connected any more. Export it and post it yourself.",
  LISTING_OFF_MARKET: "The listing is no longer for sale, so its page can't go live.",
  FAIR_HOUSING_PACK_UNAVAILABLE: "The fair-housing check isn't available right now, so nothing can be approved. Try again later.",
};

export function errorText(r: Extract<MutateResult<unknown>, { ok: false }>): string {
  return MARKETING_ERROR_MESSAGES[r.code] ?? r.message;
}

const CLAIMS_POSTED = /\bposted\b/i;

/** A publication's words: the server's label, never a "Posted" the provider did not confirm. */
export function publicationWords(p: PublicationView): string {
  if (!p.posted && CLAIMS_POSTED.test(p.label)) return `Check your ${p.targetName}`;
  return p.label;
}

/** The piece's status words: the server's statusLabel, never a "Posted" no confirmed publication backs up. */
export function statusWords(piece: PieceView): string {
  if (CLAIMS_POSTED.test(piece.statusLabel) && !piece.publications.some((p) => p.posted)) return 'Check each account below';
  return piece.statusLabel;
}

/** The first prominent line of the rendered piece (headline, caption or subject) for a card title. */
export function headlineOf(piece: PieceView): string | null {
  const blocks = piece.preview?.blocks ?? [];
  for (const role of ['headline', 'subject', 'title', 'caption']) {
    const b = blocks.find((x) => x.role === role && x.text.trim());
    if (b) return b.text;
  }
  return null;
}

export function addressOf(piece: PieceView): string | null {
  return piece.preview?.blocks.find((b) => b.role === 'address')?.text ?? null;
}

/** ONE tap: approve exactly the content shown (its contentSha256). */
export function useApprovePiece() {
  const m = useMutate<{ contentSha256: string }, { piece: PieceView }>('POST', {
    invalidate: INVALIDATE,
  });
  return {
    ...m,
    approve: (p: Pick<PieceView, 'id' | 'contentSha256'>) =>
      m.run(`/marketing-pieces/${p.id}/approve`, {
        contentSha256: p.contentSha256,
      }),
  };
}

export function useExportPiece() {
  return useMutate<Record<string, never>, { piece: PieceView; export: ExportView }>('POST', { invalidate: INVALIDATE });
}

export function usePieceCommand<B = Record<string, unknown>, R = { piece: PieceView }>() {
  return useMutate<B, R>('POST', { invalidate: INVALIDATE });
}
