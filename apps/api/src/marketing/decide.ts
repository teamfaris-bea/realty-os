// Pure decisions of module 29 (no I/O, no clock): which way a piece can leave the product, what a provider's answer
// means for a publication, and the honest words the UI shows (R-MKT-6, R-MKT-12; E227). Property-tested in
// decide.property.test.ts. Everything that touches the database or a provider lives elsewhere (publish.ts is the
// only caller of the SocialPublisher).
import type { PieceKind, PieceStatus } from '@realty/core/marketing';
import { ProviderError } from '../providers/types.js';
import type { DeleteResult, LookupResult, PublishResult } from '../providers/integrations/types.js';

export type PublishTargetKind = 'facebook_page' | 'instagram_business' | 'gbp_location';
/** The Meta targets a social post goes to (a GBP post goes to a gbp_location only, module 53). */
export const PUBLISH_TARGET_KINDS: readonly PublishTargetKind[] = ['facebook_page', 'instagram_business'];

export type PublicationStatus = 'publishing' | 'published' | 'failed' | 'unknown' | 'retracted';

/** One connected (or not) account a social post could go to. */
export interface TargetFacts {
  connectionId: string;
  kind: string;
  status: string;
  displayName: string;
}

/**
 * VERIFY flags (PHASE2_3_PLAN §5.4 #29), configurable: what we do not yet know about the providers. Defaults are the
 * strictest reasonable: Instagram needs an image (no text-only posts) until Meta's API says otherwise.
 */
export interface ProviderAssumptions {
  /** VERIFY: Instagram publishes only posts with at least one image */
  instagramRequiresImage: boolean;
}
export const DEFAULT_ASSUMPTIONS: ProviderAssumptions = Object.freeze({ instagramRequiresImage: true });

export type PublishOption =
  | { kind: 'publish'; connectionId: string; target: PublishTargetKind; displayName: string }
  | { kind: 'export'; connectionId: string | null; reason: ExportReason; sentence: string };

export type ExportReason = 'NOT_SOCIAL' | 'NOT_APPROVED' | 'NOT_CONNECTED' | 'PLATFORM_NOT_CLEARED' | 'NEEDS_IMAGE' | 'ALREADY_LIVE';

const TARGET_WORD: Record<PublishTargetKind, string> = { facebook_page: 'Facebook Page', instagram_business: 'Instagram account', gbp_location: 'Google Business Profile' };

export function targetWord(kind: string): string {
  return (TARGET_WORD as Record<string, string>)[kind] ?? 'account';
}

/**
 * Per target account: publish through publishPost, or export (R-MKT-12: "whenever the target is not connected, needs
 * partner access, or the pack is not cleared, the piece is exported instead"). The DB guard decides again (it is the
 * authority); this decision only chooses what the UI offers and why.
 */
export function publishOptions(
  piece: { kind: PieceKind; status: PieceStatus; imageCount: number },
  targets: readonly TargetFacts[],
  live: ReadonlySet<string>,
  platformCleared: boolean,
  a: ProviderAssumptions = DEFAULT_ASSUMPTIONS,
  /** module 53: platform:gbp is cleared. Closed by default: a caller that does not say so never offers GBP publishing */
  gbp: { cleared: boolean } = { cleared: false },
): PublishOption[] {
  if (piece.kind === 'gbp_post') return gbpOptions(piece, targets, live, platformCleared && gbp.cleared);
  const social = targets.filter((t) => (PUBLISH_TARGET_KINDS as readonly string[]).includes(t.kind));
  if (piece.kind !== 'social_post') return [{ kind: 'export', connectionId: null, reason: 'NOT_SOCIAL', sentence: 'Only social posts publish to a Page or Instagram account.' }];
  if (social.length === 0) {
    return [{ kind: 'export', connectionId: null, reason: 'NOT_CONNECTED', sentence: 'No Facebook Page or Instagram account is connected. Export it and post it yourself.' }];
  }
  return social.map((t): PublishOption => {
    const word = targetWord(t.kind);
    const ex = (reason: ExportReason, sentence: string): PublishOption => ({ kind: 'export', connectionId: t.connectionId, reason, sentence });
    if (piece.status !== 'approved' && piece.status !== 'published') return ex('NOT_APPROVED', 'Approve this version first.');
    if (t.status !== 'connected' && t.status !== 'degraded') return ex('NOT_CONNECTED', `Your ${word} "${t.displayName}" is not connected. Export it and post it yourself.`);
    if (!platformCleared) return ex('PLATFORM_NOT_CLEARED', 'Publishing stays off until counsel reviews the fair-housing pack. Export it and post it yourself.');
    if (t.kind === 'instagram_business' && a.instagramRequiresImage && piece.imageCount === 0) return ex('NEEDS_IMAGE', 'Instagram needs at least one photo on the post. Add one in a new version, or export it.');
    if (live.has(t.connectionId)) return ex('ALREADY_LIVE', `This version is already on your ${word}, or we are still checking whether it went up.`);
    return { kind: 'publish', connectionId: t.connectionId, target: t.kind as PublishTargetKind, displayName: t.displayName };
  });
}

/** Module 53: a GBP post goes only to a connected GBP location, once platform:fair_housing and platform:gbp are cleared. */
function gbpOptions(piece: { status: PieceStatus }, targets: readonly TargetFacts[], live: ReadonlySet<string>, cleared: boolean): PublishOption[] {
  const yourself = 'Export it and copy it to your Business Profile yourself.';
  const locations = targets.filter((t) => t.kind === 'gbp_location');
  if (locations.length === 0) return [{ kind: 'export', connectionId: null, reason: 'NOT_CONNECTED', sentence: `No Google Business Profile location is connected. ${yourself}` }];
  return locations.map((t): PublishOption => {
    const ex = (reason: ExportReason, sentence: string): PublishOption => ({ kind: 'export', connectionId: t.connectionId, reason, sentence });
    if (piece.status !== 'approved' && piece.status !== 'published') return ex('NOT_APPROVED', 'Approve this version first.');
    if (t.status !== 'connected' && t.status !== 'degraded') return ex('NOT_CONNECTED', `Your Google Business Profile "${t.displayName}" is not connected. ${yourself}`);
    if (!cleared) return ex('PLATFORM_NOT_CLEARED', `Google Business Profile posts stay off until counsel reviews them. ${yourself}`);
    if (live.has(t.connectionId)) return ex('ALREADY_LIVE', 'This version is already on your Google Business Profile, or we are still checking whether it went up.');
    return { kind: 'publish', connectionId: t.connectionId, target: 'gbp_location', displayName: t.displayName };
  });
}

/** What TX2 records for the provider's answer to publishPost. A lost answer is never 'published' and never 'failed'. */
export type PublishOutcome = { status: 'published'; externalPostId: string } | { status: 'failed'; errorCode: string } | { status: 'unknown'; errorCode: string };

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;
export function errorCodeOf(raw: string | undefined, fallback: string): string {
  const c = (raw ?? '').toUpperCase().replace(/[^A-Z0-9_]/g, '_').replace(/^[^A-Z]+/, '').slice(0, 60);
  return CODE_RE.test(c) ? c : fallback;
}

/**
 * The provider's answer → the outcome. `published` only with a provider post id (R-MKT-12: "Posted" only for a
 * provider-confirmed row). An explicit rejection is `failed`. A timeout, a dropped connection or anything we cannot
 * read is `unknown` (E227): the post may exist, so it is looked up, never posted again.
 */
export function classifyPublish(r: { ok: true; result: PublishResult } | { ok: false; error: unknown }): PublishOutcome {
  if (r.ok) {
    if (r.result.kind === 'published' && typeof r.result.providerRef === 'string' && r.result.providerRef.length > 0 && r.result.providerRef.length <= 200) {
      return { status: 'published', externalPostId: r.result.providerRef };
    }
    if (r.result.kind === 'rejected') return { status: 'failed', errorCode: errorCodeOf(r.result.code, 'PROVIDER_REJECTED') };
    return { status: 'unknown', errorCode: 'PROVIDER_ANSWER_UNREADABLE' };
  }
  const e = r.error;
  if (e instanceof ProviderError && (e.kind === 'rejected' || e.kind === 'not_configured')) return { status: 'failed', errorCode: errorCodeOf(e.providerCode, 'PROVIDER_REJECTED') };
  if (e instanceof ProviderError && e.kind === 'timeout') return { status: 'unknown', errorCode: 'PUBLISH_TIMEOUT' };
  return { status: 'unknown', errorCode: 'PUBLISH_ANSWER_LOST' };
}

/** Reconciling an 'unknown' publication: only a lookup decides. There is no "post again" outcome (E227). */
export type ReconcileOutcome = { status: 'published'; externalPostId: string } | { status: 'failed'; errorCode: string } | { status: 'unknown' };

export function reconcileFromLookup(r: { ok: true; result: LookupResult } | { ok: false; error: unknown }, ageMs: number, giveUpAfterMs = 24 * 3_600_000): ReconcileOutcome {
  if (!r.ok) return { status: 'unknown' };
  if (r.result.kind === 'found' && r.result.providerRef.length > 0 && r.result.providerRef.length <= 200) return { status: 'published', externalPostId: r.result.providerRef };
  // A post not found after a day is recorded as failed (the provider never made it); before that it may still show up.
  if (r.result.kind === 'not_found') return ageMs >= giveUpAfterMs ? { status: 'failed', errorCode: 'NOT_FOUND_AT_PROVIDER' } : { status: 'unknown' };
  // VERIFY: the provider cannot look a post up without its id: 'unknown' stays unknown ("Check your Page/Instagram")
  return { status: 'unknown' };
}

/** A retraction is recorded only after the provider confirmed the deletion; otherwise the agent removes it themselves. */
export type RetractOutcome = { kind: 'retracted' } | { kind: 'remove_yourself'; reason: 'UNSUPPORTED' | 'FAILED' };

export function retractFromDelete(r: { ok: true; result: DeleteResult } | { ok: false; error: unknown }): RetractOutcome {
  if (r.ok && r.result.kind === 'deleted') return { kind: 'retracted' };
  if (r.ok && r.result.kind === 'unsupported') return { kind: 'remove_yourself', reason: 'UNSUPPORTED' };
  return { kind: 'remove_yourself', reason: 'FAILED' };
}

/**
 * The words for one publication (R-MKT-6, R-MKT-12). "Posted" appears only for a provider-confirmed row (published
 * with a post id). Fixed strings plus the account's own name; never caller text otherwise.
 */
export function publicationLabel(p: { status: PublicationStatus; externalPostId: string | null; targetKind: string; errorCode: string | null; removeYourself?: boolean }): string {
  const word = targetWord(p.targetKind);
  switch (p.status) {
    case 'published':
      return p.externalPostId ? (p.removeYourself ? `Posted to your ${word}. We couldn't take it down here: remove it on your ${word} yourself` : `Posted to your ${word}`) : `Check your ${word}`;
    case 'publishing':
      return `Sending to your ${word}…`;
    case 'unknown':
      return `Check your ${word}: we didn't hear back whether it went up. We won't post it again`;
    case 'failed':
      return `Didn't go up on your ${word}${p.errorCode ? ` (${p.errorCode.toLowerCase().replace(/_/g, ' ')})` : ''}. Export it and post it yourself`;
    case 'retracted':
      return `Taken down from your ${word}`;
  }
}

/** True when a label claims the post is live (used by tests and the copy lint). */
export function claimsPosted(label: string): boolean {
  return /\bposted\b/i.test(label);
}

/** The piece's words beside its publications (deliveryLabel's honest cousin for social posts): never "Posted". */
export const EXPORTED_POST_IT_YOURSELF = 'Exported: post it yourself';

/** A new version never touches the old version's external posts (R-MKT-12): what the UI says about them. */
export function earlierPostNotice(livePublicationsOfOlder: readonly { targetKind: string }[]): string | null {
  if (livePublicationsOfOlder.length === 0) return null;
  const kinds = [...new Set(livePublicationsOfOlder.map((p) => targetWord(p.targetKind)))];
  return `The earlier post stays on your ${kinds.join(' and ')}. Take it down there if you no longer want it.`;
}

/** A public page slug: address words plus a short id suffix; always matches marketing_pieces.public_slug's CHECK. */
export function pageSlug(addressLine1: string, city: string, suffix: string): string {
  const base = `${addressLine1} ${city}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const tail = suffix.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'page';
  const s = base.length >= 2 && /^[a-z0-9]/.test(base) ? `${base}-${tail}` : `home-${tail}`;
  return s;
}
export const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;
