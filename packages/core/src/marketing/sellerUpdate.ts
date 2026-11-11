// Seller-update assembly (R-SELL-2, R-SELL-3, R-MKT-8, R-MKT-10, R-MLS-2, R-MLS-3; E85, E87, E89, E94).
//
//   assembleSellerUpdate(inputs, period) → { sections, claims }
//
// Every section says where its data stands, and every count is a ClaimSpec with evidence (source
// type + id + field locator + the field's value as snippet). No confidence fields (R-AST-13).
// - Showings: logged by hand in Realty OS unless a showing service is connected; zero is said
//   plainly: "No showings logged in Realty OS this week" (E87).
// - Feedback: shown verbatim to the agent, each item removable, never published by a rule (E89,
//   R-PORTAL-3); an item that names a known buyer is flagged.
// - Marketing: only pieces published (pages we control / connected accounts), invites sent ("Sent 41
//   of 45; 4 opted out", E94/R-MKT-8) and activity agents logged. Exports never count: we cannot see
//   what happens after a piece is handed over (R-MKT-6). Logged activity `metrics` are not read, and
//   nothing estimated, no page-view count and no email open ever appears (R-MKT-10, PHASE2_3_PLAN §3).
// - Competing listings: from the MLS feed with attribution, through the client display rules
//   (R-MLS-2); "Competing listings unavailable: no MLS feed connected"; a stale feed says "MLS data as
//   of …" and pauses the MLS part (R-MLS-3, E85).
// - The assistant never prefills a recommendation (R-SELL-3): the output has no recommendation; the
//   approver types one (`recommendationOk`, ≥ 20 characters as the DB CHECK counts them).
import { DateTime } from 'luxon';
import { formatPriceCents } from '../assistant/index.js';
import {
  applyDisplayRules,
  competingSet,
  feedStale,
  listingIdentity,
  staleNotice,
  type DisplayListing,
  type ListingFacts,
} from '../listings/index.js';
import { foldName } from './render.js';
import type { Instant } from '../foundation/index.js';
import type { ClaimSpec, EvidenceSpec, Period, PieceKind, Section, SectionLine, SellerUpdateInputs } from './types.js';

const SNIPPET_MAX = 500;
const CLAIM_TEXT_MAX = 300;

export const NO_SHOWINGS = (label: string): string => `No showings logged in Realty OS ${label}`;
export const NO_FEEDBACK = (label: string): string => `No showing feedback logged in Realty OS ${label}`;
export const NO_MARKETING = (label: string): string => `No marketing activity logged in Realty OS ${label}`;
export const NO_MLS_FEED = 'Competing listings unavailable: no MLS feed connected';

const KIND_NAME: Readonly<Record<PieceKind, string>> = {
  website_page: 'Listing page',
  social_post: 'Social post',
  open_house_invite: 'Open-house invite',
  flyer: 'Flyer',
  marketplace_export: 'Marketplace listing',
  gbp_post: 'Business Profile post',
};

const ACTIVITY_NAME: Readonly<Record<SellerUpdateInputs['loggedActivity'][number]['kind'], string>> = {
  social_post: 'Social post',
  email_blast: 'Email to contacts',
  open_house: 'Open house',
  flyer: 'Flyer',
  website: 'Website',
  portal: 'Listing portal',
  other: 'Other marketing',
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/** Recipients of one invite send, counted (R-MKT-8): "Sent 41 of 45; 4 opted out". Blocked recipients are counted here, not raised as failures. */
export function inviteSendSummary(recipients: readonly { outcome: 'sent' | 'opted_out' | 'blocked' }[]): { sent: number; total: number; optedOut: number; blocked: number; text: string } {
  const total = recipients.length;
  const sent = recipients.filter((r) => r.outcome === 'sent').length;
  const optedOut = recipients.filter((r) => r.outcome === 'opted_out').length;
  const blocked = total - sent - optedOut;
  const parts = [`Sent ${sent} of ${total}`];
  if (optedOut > 0) parts.push(`${optedOut} opted out`);
  if (blocked > 0) parts.push(`${blocked} not sent for other reasons`);
  return { sent, total, optedOut, blocked, text: parts.join('; ') };
}

/** R-SELL-3: the approver's own recommendation, ≥ 20 characters once trimmed (Unicode characters, as Postgres length counts). */
export function recommendationOk(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;
  return [...text.trim()].length >= 20;
}

// ---- marketing numbers (R-MKT-10) ------------------------------------------------------------------

/** Where a marketing number comes from: first-party facts, or a provider that reported it. */
export type MarketingNumberSource = { readonly kind: 'form_submissions' } | { readonly kind: 'sent_invites' } | { readonly kind: 'provider'; readonly provider: string };

/** Metrics never shown: page views (deferred), email opens (never), and anything estimated or modelled. */
export const NEVER_SHOWN_METRIC_RE = /view|open|estimat|predict|projected|modell?ed/i;

/**
 * A marketing number as shown (R-MKT-10): first-party counts as they are, provider numbers labelled
 * with their source; page views, email opens and estimates are refused.
 */
export function marketingNumber(metric: string, value: number, source: MarketingNumberSource): { ok: true; text: string } | { ok: false; code: 'MARKETING_METRIC_NOT_SHOWN' } {
  if (NEVER_SHOWN_METRIC_RE.test(metric) || !Number.isInteger(value) || value < 0) return { ok: false, code: 'MARKETING_METRIC_NOT_SHOWN' };
  const name = metric.replace(/_/g, ' ');
  switch (source.kind) {
    case 'form_submissions':
      return { ok: true, text: `${value} ${name} (form submissions in Realty OS)` };
    case 'sent_invites':
      return { ok: true, text: `${value} ${name} (invites sent from Realty OS)` };
    case 'provider':
      return { ok: true, text: `${value} ${name} (reported by ${source.provider})` };
  }
}

function fmtDay(t: Instant, zone: Period['zone']): string {
  return DateTime.fromMillis(t, { zone, locale: 'en-US' }).toFormat('ccc LLL d, h:mm a');
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

class Claims {
  readonly list: ClaimSpec[] = [];
  add(c: Omit<ClaimSpec, 'ordinal'>): number {
    const ordinal = this.list.length;
    this.list.push({ ...c, ordinal, text: clip(c.text, CLAIM_TEXT_MAX) });
    return ordinal;
  }
}

const field = (sourceType: EvidenceSpec['sourceType'], sourceId: string, name: string, snippet: string): EvidenceSpec => ({
  sourceType,
  sourceId,
  locator: { kind: 'field', name },
  snippet: clip(snippet, SNIPPET_MAX),
});

function wordIn(hay: string, name: string): boolean {
  const n = foldName(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return n !== '' && new RegExp(`(?<![\\p{L}\\p{N}])${n}(?![\\p{L}\\p{N}])`, 'u').test(foldName(hay));
}

// ---- sections ----------------------------------------------------------------------------------

function showingsSection(i: SellerUpdateInputs, p: Period, label: string, claims: Claims): Section {
  const within = i.showings.filter((s) => s.startsAt >= p.start && s.startsAt < p.end && s.status !== 'canceled').sort((a, b) => a.startsAt - b.startsAt);
  const statement = i.showingServiceConnected
    ? 'Showings from your showing service and those logged in Realty OS.'
    : 'Showings are logged by hand in Realty OS; no showing service is connected.';
  if (within.length === 0) {
    const o = claims.add({ kind: 'fact', section: 'showings', text: NO_SHOWINGS(label), count: 0, evidence: [] });
    return { kind: 'showings', title: 'Showings', state: 'none_logged', statement, lines: [{ text: NO_SHOWINGS(label) }], claimOrdinals: [o] };
  }
  const noShows = within.filter((s) => s.status === 'no_show').length;
  const head = `${within.length} ${plural(within.length, 'showing', 'showings')} logged in Realty OS ${label}${noShows > 0 ? ` (${noShows} of ${within.length} marked no-show)` : ''}`;
  const o = claims.add({
    kind: 'fact',
    section: 'showings',
    text: head,
    count: within.length,
    evidence: within.map((s) => field('showing', s.id, 'status', s.status)),
  });
  const lines: SectionLine[] = [{ text: head }, ...within.map((s) => ({ text: `${fmtDay(s.startsAt, p.zone)}${s.status === 'no_show' ? ' · no-show' : ''}` }))];
  return { kind: 'showings', title: 'Showings', state: 'has_data', statement, lines, claimOrdinals: [o] };
}

function feedbackSection(i: SellerUpdateInputs, p: Period, label: string, claims: Claims): Section {
  const within = i.feedback
    .filter((f) => f.receivedAt >= p.start && f.receivedAt < p.end && ((f.comments ?? '').trim() !== '' || f.rating !== null))
    .sort((a, b) => a.receivedAt - b.receivedAt);
  const statement = 'Feedback exactly as it was logged. Check each item: you can remove any of it before you send.';
  if (within.length === 0) {
    const o = claims.add({ kind: 'fact', section: 'feedback', text: NO_FEEDBACK(label), count: 0, evidence: [] });
    return { kind: 'feedback', title: 'Feedback', state: 'none_logged', statement, lines: [{ text: NO_FEEDBACK(label) }], claimOrdinals: [o] };
  }
  const names = i.knownBuyerNames ?? [];
  const lines: SectionLine[] = within.map((f) => {
    const verbatim = (f.comments ?? '').trim() !== '' ? (f.comments as string) : `Rating ${String(f.rating)} of 5`;
    return {
      text: verbatim,
      feedback: { feedbackId: f.id, verbatim, removable: true, publish: 'person_only', namesPerson: names.some((n) => wordIn(verbatim, n)) },
    };
  });
  const o = claims.add({
    kind: 'fact',
    section: 'feedback',
    text: `${within.length} feedback ${plural(within.length, 'item', 'items')} logged in Realty OS ${label}`,
    count: within.length,
    evidence: within.map((f) =>
      (f.comments ?? '').trim() !== '' ? field('showing_feedback', f.id, 'comments', f.comments as string) : field('showing_feedback', f.id, 'rating', String(f.rating)),
    ),
  });
  return { kind: 'feedback', title: 'Feedback', state: 'has_data', statement, lines, claimOrdinals: [o] };
}

function marketingSection(i: SellerUpdateInputs, p: Period, label: string, claims: Claims): Section {
  const inP = (t: Instant | null): boolean => t !== null && t >= p.start && t < p.end;
  // only publication counts; an export (exportedAt) is never activity (R-SELL-2, R-MKT-6)
  const published = i.pieces.filter((x) => inP(x.publishedAt)).sort((a, b) => (a.publishedAt as number) - (b.publishedAt as number));
  const invites = i.inviteSends.filter((s) => inP(s.sentAt) && s.recipients.length > 0).sort((a, b) => a.sentAt - b.sentAt);
  const logged = i.loggedActivity.filter((a) => inP(a.occurredAt)).sort((a, b) => a.occurredAt - b.occurredAt);
  const statement =
    'From pieces published to your listing page or connected accounts, invites sent from Realty OS, and marketing your team logged. Exports are not counted: we cannot see what happens after you copy them.';
  const lines: SectionLine[] = [];
  const ords: number[] = [];
  if (published.length === 0 && invites.length === 0 && logged.length === 0) {
    const o = claims.add({ kind: 'fact', section: 'marketing', text: NO_MARKETING(label), count: 0, evidence: [] });
    return { kind: 'marketing', title: 'Marketing', state: 'none_logged', statement, lines: [{ text: NO_MARKETING(label) }], claimOrdinals: [o] };
  }
  const listingId = i.listing.id ?? listingIdentity(i.listing);
  if (published.length > 0) {
    const text = `${published.length} marketing ${plural(published.length, 'piece', 'pieces')} published ${label}`;
    ords.push(
      claims.add({
        kind: 'fact',
        section: 'marketing',
        text,
        count: published.length,
        // evidence_refs has no marketing_piece source type: the listing, with the piece named in the locator
        evidence: published.map((x) => field('listing', listingId, `marketing_pieces.${x.pieceId}.published_at`, 'published')),
      }),
    );
    lines.push({ text }, ...published.map((x) => ({ text: `${KIND_NAME[x.kind]} · ${fmtDay(x.publishedAt as Instant, p.zone)}` })));
  }
  for (const s of invites) {
    const sum = inviteSendSummary(s.recipients);
    const text = `Open-house invite: ${sum.text}`;
    ords.push(
      claims.add({
        kind: 'fact',
        section: 'marketing',
        text,
        count: sum.sent,
        evidence: s.recipients.map((r) => field('message', r.messageId, 'status', r.outcome === 'sent' ? 'sent' : 'blocked')),
      }),
    );
    lines.push({ text: `${text} · ${fmtDay(s.sentAt, p.zone)}` });
  }
  if (logged.length > 0) {
    const text = `${logged.length} marketing ${plural(logged.length, 'activity', 'activities')} logged by your team ${label}`;
    ords.push(claims.add({ kind: 'fact', section: 'marketing', text, count: logged.length, evidence: logged.map((a) => field('marketing_activity', a.id, 'kind', a.kind)) }));
    lines.push({ text }, ...logged.map((a) => ({ text: `${ACTIVITY_NAME[a.kind]} · ${fmtDay(a.occurredAt, p.zone)}` })));
  }
  return { kind: 'marketing', title: 'Marketing', state: 'has_data', statement, lines, claimOrdinals: ords };
}

function competingLine(d: DisplayListing): string {
  const where = d.address ? d.address.line1 : d.locality ? `${d.locality.city}, ${d.locality.region}` : 'Address not shown';
  const parts = [where];
  if (d.listPriceCents !== undefined && d.listPriceCents !== null) parts.push(formatPriceCents(d.listPriceCents));
  if (d.beds !== undefined && d.beds !== null) parts.push(`${d.beds} bd`);
  if (d.status !== undefined) parts.push(d.status.replace('_', ' '));
  const brokerage = d.listingBrokerageName ?? '';
  if (brokerage !== '') parts.push(`Listed by ${brokerage}`);
  let line = parts.join(' · ');
  if (d.attribution !== null) line += `. ${d.attribution.replaceAll('{brokerage}', brokerage)}`;
  return line;
}

function competingSection(i: SellerUpdateInputs, p: Period, claims: Claims): Section {
  const title = 'Competing listings';
  if (!i.mls.connected) {
    return { kind: 'competing', title, state: 'unavailable', statement: NO_MLS_FEED, lines: [{ text: NO_MLS_FEED }], claimOrdinals: [] };
  }
  const mls = i.mls;
  const asOf = staleNotice(mls.lastSyncedAt, p.zone);
  const stale = feedStale(mls.lastSyncedAt, i.now, mls.pack);
  if (stale) {
    const statement = `${asOf}. Competing listings are paused until the MLS feed catches up.`;
    return { kind: 'competing', title, state: 'stale', statement, lines: [{ text: statement }], claimOrdinals: [] };
  }
  const set = competingSet(i.listing, mls.candidates, { ...mls.rule, mlsFeedStale: false, onlyDisplayAllowed: true });
  const shown: { l: ListingFacts; d: DisplayListing }[] = [];
  let hidden = 0;
  for (const l of set.listings) {
    if (l.source !== 'mls') continue; // the team's own listings are not "competing MLS listings"
    const d = applyDisplayRules(l, mls.pack, 'client');
    if (d === null) hidden++;
    else shown.push({ l, d });
  }
  const statement = `From the MLS feed, with each listing's attribution. ${asOf}.`;
  const lines: SectionLine[] = shown.map(({ d }) => ({ text: competingLine(d) }));
  if (hidden > 0) lines.push({ text: 'Some competing listings are not shown: the MLS licence does not allow showing them to clients.' });
  const disclaimer = shown.find((x) => x.d.disclaimer !== null)?.d.disclaimer;
  if (disclaimer) lines.push({ text: disclaimer });
  if (shown.length === 0) {
    const text = 'No competing listings to show from the MLS data';
    const o = claims.add({ kind: 'fact', section: 'competing', text, count: 0, evidence: [] });
    return { kind: 'competing', title, state: 'none_logged', statement, lines: [{ text }, ...lines], claimOrdinals: [o] };
  }
  const text = `${shown.length} competing ${plural(shown.length, 'listing', 'listings')} from the MLS feed`;
  const o = claims.add({
    kind: 'fact',
    section: 'competing',
    text,
    count: shown.length,
    evidence: shown.map(({ l }) => field('listing', listingIdentity(l), 'status', l.status)),
  });
  return { kind: 'competing', title, state: 'has_data', statement, lines: [{ text }, ...lines], claimOrdinals: [o] };
}

/**
 * Assemble one seller update for [period.start, period.end). Sections in a fixed order: showings,
 * feedback, marketing, competing. No recommendation: the approver writes it (R-SELL-3).
 */
export function assembleSellerUpdate(i: SellerUpdateInputs, period: Period): { sections: Section[]; claims: ClaimSpec[] } {
  const label = period.label ?? 'this week';
  const claims = new Claims();
  const sections = [
    showingsSection(i, period, label, claims),
    feedbackSection(i, period, label, claims),
    marketingSection(i, period, label, claims),
    competingSection(i, period, claims),
  ];
  return { sections, claims: claims.list };
}
