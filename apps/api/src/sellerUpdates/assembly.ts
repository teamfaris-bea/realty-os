// Seller-update assembly for one listing and one period (PHASE2_3_PLAN §5.4 #28; R-SELL-1, R-SELL-2,
// R-MLS-2, R-MLS-3; E85, E87, E89).
//
// Reads what is logged in Realty OS for the listing (showings, feedback, published pieces, invite sends,
// logged marketing, the MLS rows a client may see) under the caller's RLS, hands it to core
// `assembleSellerUpdate` (the only place sections and claims are worded), and adds three things core
// cannot know:
//   - MLS eligibility (R-MLS-2): competing MLS listings appear only from a connection whose data may reach a
//     client now (live, licence pack counsel-reviewed with attribution and disclaimer, fresh feed); a
//     connected feed whose pack is not reviewed says so instead of pretending there is nothing to show;
//   - the watermark (R-SELL-4): `assembledThrough` (the instant the data was read) and `dataSha256`, a hash of
//     every shown fact. The send re-assembles and compares the hash; any change to the showings, feedback,
//     marketing or competing data after the watermark is SELLER_UPDATE_STALE. The "MLS data as of …" sentence
//     is left out of the hash (it moves with every sync); the competing listings themselves are in it, and a
//     feed that went stale since changes the section, so it counts;
//   - the seller-facing text: the sections in order, each with where its data stands, minus the feedback the
//     agent removed, then the agent's own recommendation (never prefilled, R-SELL-3).
import { createHash } from 'node:crypto';
import { type ClaimSpec, type MlsInput, type Period, type Section, type SellerUpdateInputs, assembleSellerUpdate } from '@realty/core/marketing';
import { DEFAULT_COMPETING_RULE, STRICTEST_LICENSE_PACK } from '@realty/core/listings';
import { type IanaZone, type Instant, addLocalDays, localDateOf, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { LISTING_COLS, type ListingRow, connectionClientEligible, factsOfRow, mlsCitySpellings, mlsConnections } from '../mls/eligibility.js';

/** Statuses that get weekly updates (R-SELL-1: an active team listing with a seller contact). */
export const UPDATE_STATUSES = ['active'] as const;

export const MLS_PACK_NOT_REVIEWED = 'Competing listings unavailable: the MLS licence terms are not yet reviewed for showing to clients';

export interface TenantCadence {
  zone: IanaZone;
  /** 0 turns seller updates off for the tenant */
  cadenceDays: number;
}

export async function tenantCadence(tx: Tx): Promise<TenantCadence> {
  const r = await sql<{ z: string; c: number }>`
    SELECT default_timezone AS z, seller_update_cadence_days AS c FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return { zone: (r.rows[0]?.z ?? 'UTC') as IanaZone, cadenceDays: r.rows[0]?.c ?? 7 };
}

export interface PeriodSpec extends Period {
  /** the local date the period starts on (yyyy-mm-dd): the dedupe and feed key part */
  key: string;
  label: string;
}

/** The period that ends at `due`: [due − cadence days, due) in the tenant's zone (DST-safe calendar days). */
export function periodEndingAt(due: Instant, c: TenantCadence): PeriodSpec {
  const days = Math.max(1, c.cadenceDays);
  const start = addLocalDays(due, -days, c.zone);
  return { start, end: due, zone: c.zone, key: String(localDateOf(start, c.zone)), label: days === 7 ? 'this week' : `in the last ${days} days` };
}

/** The next due instant after `due` (cadence calendar days later in the tenant's zone). */
export function nextDueAfter(due: Instant, c: TenantCadence): Instant {
  return addLocalDays(due, Math.max(1, c.cadenceDays), c.zone);
}

export interface SellerRecipientRow {
  contactId: string;
  role: 'seller' | 'co_seller';
  displayName: string;
}

/** The listing's seller contacts the caller sees (live: not deleted, not merged away), sellers first. */
export async function sellerContacts(tx: Tx, listingId: string): Promise<SellerRecipientRow[]> {
  const r = await sql<{ contact_id: string; role: 'seller' | 'co_seller'; display_name: string }>`
    SELECT lc.contact_id, lc.role, c.display_name
      FROM listing_contacts lc
      JOIN contacts c ON c.tenant_id = lc.tenant_id AND c.id = lc.contact_id
     WHERE lc.tenant_id = app.tenant_id() AND lc.listing_id = ${listingId} AND lc.role IN ('seller','co_seller')
       AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
     ORDER BY lc.role = 'seller' DESC, lc.created_at, lc.contact_id`.execute(tx);
  return r.rows.map((x) => ({ contactId: x.contact_id, role: x.role, displayName: x.display_name }));
}

export interface ListingHead {
  id: string;
  source: 'team' | 'mls';
  status: string;
  addressLine1: string;
  city: string;
  listingAgentUserId: string | null;
}

export async function listingHead(tx: Tx, listingId: string, o: { lock?: boolean } = {}): Promise<ListingHead | null> {
  const r = await sql<{ id: string; source: 'team' | 'mls'; status: string; address_line1: string; city: string; listing_agent_user_id: string | null }>`
    SELECT id, source, status, address_line1, city, listing_agent_user_id FROM listings
     WHERE tenant_id = app.tenant_id() AND id = ${listingId} ${o.lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, source: x.source, status: x.status, addressLine1: x.address_line1, city: x.city, listingAgentUserId: x.listing_agent_user_id } : null;
}

const ms = (d: Date): Instant => d.getTime() as Instant;
const CANDIDATE_LIMIT = 1000;
const OPT_OUT_REASONS = ['CONSENT_REVOKED', 'RECIPIENT_OPTED_OUT', 'PERSON_DO_NOT_CONTACT'];

/** What the MLS part of the update may use now (R-MLS-2): the freshest client-eligible connection, or why none. */
async function mlsInput(tx: Tx, subject: ListingRow, now: Instant): Promise<{ input: MlsInput; packNotReviewed: boolean }> {
  const conns = (await mlsConnections(tx)).filter((c) => c.status === 'connected' || c.status === 'degraded');
  if (conns.length === 0) return { input: { connected: false }, packNotReviewed: false };
  const eligible = conns.filter((c) => connectionClientEligible(c, now)).sort((a, b) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0));
  const best = eligible[0];
  if (!best) {
    // live but not eligible: a stale feed is said by core ("MLS data as of …", paused); a pack that is not
    // reviewed for clients (or lacks attribution/disclaimer) is said here
    const freshest = [...conns].sort((a, b) => (b.lastSyncedAt ?? 0) - (a.lastSyncedAt ?? 0))[0]!;
    const staleOnly = connectionClientEligible({ ...freshest, lastSyncedAt: now }, now);
    if (staleOnly) return { input: { connected: true, lastSyncedAt: freshest.lastSyncedAt, pack: freshest.pack, candidates: [], rule: DEFAULT_COMPETING_RULE }, packNotReviewed: false };
    return { input: { connected: true, lastSyncedAt: freshest.lastSyncedAt, pack: STRICTEST_LICENSE_PACK, candidates: [], rule: DEFAULT_COMPETING_RULE }, packNotReviewed: true };
  }
  const zips = [subject.postal_code, subject.postal_code.trim().slice(0, 5)];
  const cities = [...new Set([subject.city, ...(await mlsCitySpellings(tx, [subject.city]))])];
  const rule = { ...DEFAULT_COMPETING_RULE, area: 'city_or_postal_code' as const };
  // only rows a client may see: this connection, display allowed, not a mirror of a team listing (E81, E86)
  const rows = await sql<ListingRow>`
    SELECT ${LISTING_COLS} FROM listings l
     WHERE l.tenant_id = app.tenant_id() AND l.source = 'mls' AND l.mls_connection_id = ${best.id} AND l.display_allowed AND l.team_listing_id IS NULL
       AND l.status = ANY (${[...rule.statuses]}::text[])
       AND (l.postal_code = ANY (${zips}::text[]) OR (l.city = ANY (${cities}::text[]) AND l.region = ${subject.region}))
     ORDER BY l.id LIMIT ${CANDIDATE_LIMIT}`.execute(tx);
  return { input: { connected: true, lastSyncedAt: best.lastSyncedAt, pack: best.pack, candidates: rows.rows.map(factsOfRow), rule }, packNotReviewed: false };
}

/** Everything core needs for one listing and period, read under the caller's RLS. */
export async function loadInputs(tx: Tx, listingId: string, period: Period, now: Instant): Promise<{ inputs: SellerUpdateInputs; packNotReviewed: boolean }> {
  const subj = (await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId}`.execute(tx)).rows[0];
  if (!subj) throw new AppError('NOT_FOUND');
  const start = toIso(period.start);
  const end = toIso(period.end);
  const showings = await sql<{ id: string; starts_at: Date; status: 'scheduled' | 'completed' | 'canceled' | 'no_show'; source: 'manual' | 'showing_service' | 'import'; buyer_agent_name: string | null; buyer_agent_brokerage: string | null }>`
    SELECT id, starts_at, status, source, buyer_agent_name, buyer_agent_brokerage FROM showings
     WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} AND starts_at >= ${start}::timestamptz AND starts_at < ${end}::timestamptz
     ORDER BY starts_at, id`.execute(tx);
  const feedback = await sql<{ id: string; showing_id: string; rating: number | null; comments: string | null; source: 'manual' | 'showing_service' | 'email'; received_at: Date }>`
    SELECT f.id, f.showing_id, f.rating, f.comments, f.source, f.received_at
      FROM showing_feedback f JOIN showings s ON s.tenant_id = f.tenant_id AND s.id = f.showing_id
     WHERE f.tenant_id = app.tenant_id() AND s.listing_id = ${listingId} AND f.received_at >= ${start}::timestamptz AND f.received_at < ${end}::timestamptz
     ORDER BY f.received_at, f.id`.execute(tx);
  // buyers named on this listing's showings: feedback that names one is flagged for the agent (E89)
  const buyers = await sql<{ first_name: string | null; last_name: string | null; display_name: string }>`
    SELECT DISTINCT c.first_name, c.last_name, c.display_name
      FROM showings s JOIN contacts c ON c.tenant_id = s.tenant_id AND c.id = s.buyer_contact_id
     WHERE s.tenant_id = app.tenant_id() AND s.listing_id = ${listingId}`.execute(tx);
  const pieces = await sql<{ id: string; kind: SellerUpdateInputs['pieces'][number]['kind']; status: SellerUpdateInputs['pieces'][number]['status']; published_at: Date | null; exported_at: Date | null }>`
    SELECT id, kind, status, published_at, exported_at FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} ORDER BY id`.execute(tx);
  // invite sends: one gated email per recipient, counted only once the gate decided (sent / blocked)
  const invites = await sql<{ id: string; marketing_piece_id: string; created_at: Date; status: string; status_reason: string | null }>`
    SELECT m.id, m.marketing_piece_id, m.created_at, m.status, m.status_reason
      FROM messages m JOIN marketing_pieces p ON p.tenant_id = m.tenant_id AND p.id = m.marketing_piece_id
     WHERE m.tenant_id = app.tenant_id() AND p.listing_id = ${listingId} AND m.direction = 'outbound'
       AND m.status IN ('sent','delivered','blocked') AND m.created_at >= ${start}::timestamptz AND m.created_at < ${end}::timestamptz
     ORDER BY m.created_at, m.id`.execute(tx);
  const activity = await sql<{ id: string; kind: SellerUpdateInputs['loggedActivity'][number]['kind']; channel: string | null; occurred_at: Date }>`
    SELECT id, kind, channel, occurred_at FROM marketing_activity
     WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} AND occurred_at >= ${start}::timestamptz AND occurred_at < ${end}::timestamptz
     ORDER BY occurred_at, id`.execute(tx);
  const showingService = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM integration_connections WHERE tenant_id = app.tenant_id() AND kind = 'showing_service' AND status IN ('connected','degraded')`.execute(tx);
  const mls = await mlsInput(tx, subj, now);

  const sends = new Map<string, { pieceId: string; sentAt: Instant; recipients: { messageId: string; outcome: 'sent' | 'opted_out' | 'blocked' }[] }>();
  for (const m of invites.rows) {
    const s = sends.get(m.marketing_piece_id) ?? { pieceId: m.marketing_piece_id, sentAt: ms(m.created_at), recipients: [] };
    s.recipients.push({ messageId: m.id, outcome: m.status === 'blocked' ? (OPT_OUT_REASONS.includes(m.status_reason ?? '') ? 'opted_out' : 'blocked') : 'sent' });
    sends.set(m.marketing_piece_id, s);
  }
  const names = buyers.rows.flatMap((b) => [b.display_name, [b.first_name, b.last_name].filter(Boolean).join(' '), b.first_name ?? '']).map((n) => n.trim()).filter((n) => n.length >= 2);
  const inputs: SellerUpdateInputs = {
    listing: factsOfRow(subj),
    now,
    showingServiceConnected: (showingService.rows[0]?.n ?? 0) > 0,
    showings: showings.rows.map((s) => ({ id: s.id as never, startsAt: ms(s.starts_at), status: s.status, source: s.source, buyerAgentName: s.buyer_agent_name, buyerAgentBrokerage: s.buyer_agent_brokerage })),
    feedback: feedback.rows.map((f) => ({ id: f.id, showingId: f.showing_id as never, rating: f.rating, comments: f.comments, source: f.source, receivedAt: ms(f.received_at) })),
    pieces: pieces.rows.map((p) => ({ pieceId: p.id, kind: p.kind, status: p.status, publishedAt: p.published_at ? ms(p.published_at) : null, exportedAt: p.exported_at ? ms(p.exported_at) : null })),
    inviteSends: [...sends.values()].map((s) => ({ ...s, recipients: s.recipients.map((r) => ({ messageId: r.messageId as never, outcome: r.outcome })) })),
    loggedActivity: activity.rows.map((a) => ({ id: a.id, kind: a.kind, channel: a.channel, occurredAt: ms(a.occurred_at) })),
    mls: mls.input,
    knownBuyerNames: [...new Set(names)],
  };
  return { inputs, packNotReviewed: mls.packNotReviewed };
}

export interface Assembled {
  sections: Section[];
  claims: ClaimSpec[];
  assembledThrough: Instant;
  dataSha256: string;
}

/** Hash of every fact shown: sections without the "MLS data as of …" sentence (see the header). */
export function dataSha256(sections: readonly Section[]): string {
  const stable = sections.map((s) => (s.kind === 'competing' ? { ...s, statement: s.state, lines: s.state === 'stale' ? [] : s.lines } : s));
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

/** Assemble one update now (caller's transaction and RLS). */
export async function assemble(tx: Tx, listingId: string, period: Period, now: Instant): Promise<Assembled> {
  const { inputs, packNotReviewed } = await loadInputs(tx, listingId, period, now);
  const out = assembleSellerUpdate(inputs, period);
  const sections = packNotReviewed
    ? out.sections.map((s): Section => (s.kind === 'competing' ? { kind: 'competing', title: s.title, state: 'unavailable', statement: MLS_PACK_NOT_REVIEWED, lines: [{ text: MLS_PACK_NOT_REVIEWED }], claimOrdinals: [] } : s))
    : out.sections;
  const claims = packNotReviewed ? out.claims.filter((c) => c.section !== 'competing') : out.claims;
  return { sections, claims, assembledThrough: now, dataSha256: dataSha256(sections) };
}

// ---- the seller-facing text --------------------------------------------------------------------------

const SELLER_STATEMENT: Partial<Record<Section['kind'], string>> = {
  feedback: 'Feedback exactly as buyers’ agents gave it.',
  marketing: 'From pieces we published, invites we sent and marketing we logged. Exports are not counted.',
};

export function fmtPeriod(p: Period): string {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: p.zone, month: 'short', day: 'numeric' });
  const long = new Intl.DateTimeFormat('en-US', { timeZone: p.zone, month: 'short', day: 'numeric', year: 'numeric' });
  return `${short.format(p.start)} – ${long.format(p.end - 1)}`;
}

/** The update as the seller reads it; `recommendation` is the agent's own words (null before they type it). */
export function sellerText(o: { address: string; period: Period; sections: readonly Section[]; excludedFeedbackIds: readonly string[]; recommendation: string | null; agentName: string | null }): { subject: string; body: string } {
  const out: string[] = [`Update on ${o.address}, ${fmtPeriod(o.period)}`];
  for (const s of o.sections) {
    const lines = s.lines.filter((l) => !(l.feedback && o.excludedFeedbackIds.includes(l.feedback.feedbackId)));
    const kept = s.kind === 'feedback' && s.state === 'has_data' && lines.length === 0 ? [{ text: 'No feedback to share this time.' }] : lines;
    const statement = SELLER_STATEMENT[s.kind] ?? s.statement;
    const body = kept.map((l) => (l.feedback ? `“${l.text}”` : l.text)).filter((t) => t !== statement);
    out.push(['', s.title, statement, ...body].join('\n'));
  }
  if (o.recommendation) out.push(['', 'My recommendation', o.recommendation.trim()].join('\n'));
  if (o.agentName) out.push(`\n${o.agentName}`);
  return { subject: `Weekly update: ${o.address}`, body: out.join('\n') };
}
